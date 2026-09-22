/**
 * The issues facade: the estate, its cache, and the refs a ticket may carry.
 *
 * One object per console. It owns the inventory (cheap, re-read each time — a
 * submodule can be initialised while the console runs), the per-repository
 * cache, and the single-flight that keeps two browsers pressing Refresh from
 * becoming two `gh` calls.
 *
 * ## What this module will not do
 *
 * It never writes to GitHub. `gh`'s issue verbs include `create`, `edit`,
 * `close` and `comment`; none of them appears in this directory and
 * `test/issues-readonly.test.ts` pins that by scanning the argv literals here
 * the way `never-push.test.ts` scans the server for git. A "new issue" action
 * belongs on the client as a LINK to GitHub's own page.
 *
 * It also never reads a token. `gh` authenticates itself out of its own config;
 * this console neither loads nor forwards a credential, so no payload it
 * composes can leak one.
 *
 * ## Why refresh is a verb and reading is not
 *
 * `GET /api/issues` answers from cache and never blocks on the network, so the
 * board renders instantly and honestly at whatever age the data has. Fetching
 * is `POST /api/issues/refresh` — a visible act with a visible outcome — plus a
 * gentle idle cadence for repositories nobody has asked about in a while. That
 * split is `accounts/usage.ts`'s and it is the reason a rate-limited GitHub
 * degrades the age of a number rather than the responsiveness of a page.
 */

import {
  askableRepos, repoByNameWithOwner, repoInventory,
  type InventoryRepo,
} from './inventory.ts';
import {
  BODY_FETCH_BUDGET_MS, FAIL_BACKOFF_MS, FRESH_MS, IDLE_POLL_MS, RATE_LIMIT_BACKOFF_MS,
  fetchBodies, fetchIssues, ghRunner, mergeBodies, readCache, writeCache,
  type GhRunner, type Issue, type IssueCache, type IssueProvenance, type IssueReason,
} from './fetch.ts';

export type { Issue, IssueProvenance, IssueReason } from './fetch.ts';
export type { GitHubRemote, InventoryRepo } from './inventory.ts';
export {
  INVENTORY_CAP, askableRepos, parseGitHubRemote, parseOriginUrl, readOriginUrl, repoInventory,
} from './inventory.ts';

/** How many issue refs one ticket may carry. A plan brief is not a backlog. */
export const TICKET_ISSUES_MAX = 20;

/** `owner/repo#123` — the only spelling a ticket may use. */
export const ISSUE_REF_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#(\d{1,12})$/;

export type RepoIssues = {
  key: string;
  label: string;
  scopeToken: string;
  kind: InventoryRepo['kind'];
  remote?: string;
  nameWithOwner?: string;
  /** `fresh` · `stale` (age shown) · `unknown` (reason shown). */
  state: 'fresh' | 'stale' | 'unknown';
  reason?: IssueReason;
  detail?: string;
  /** Epoch ms of the last SUCCESSFUL fetch, whatever happened since. */
  fetchedAt?: number;
  /**
   * Epoch ms before which a refresh will not happen however often it is asked.
   *
   * Present ONLY with `rate-limited`, which is the only failure whose backoff a
   * forced refresh honours. It is the honest half of that refusal: without it a
   * board shows `rate-limited` beside a button that silently does nothing. A
   * plain failure has no `retryAt` because pressing Refresh really does retry.
   */
  retryAt?: number;
  /** How old that data is, in ms. Absent when there has never been any. */
  ageMs?: number;
  truncated?: boolean;
  issues: Issue[];
};

export type IssuesPayload = {
  /** When this payload was assembled — not when its data was fetched. */
  at: number;
  /** True while any repository is being fetched right now. */
  refreshing: boolean;
  repos: RepoIssues[];
};

export type IssueBrief = {
  ref: string;
  nameWithOwner: string;
  scopeToken: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
  body?: string;
  bodyTruncated?: boolean;
};

/** What the ticket door gets back: what resolved, and what did not. */
export type ResolvedIssues = { issues: IssueBrief[]; unknown: string[] };

export type IssuesStoreOptions = {
  /** The console's source directory, or nothing when none is open. */
  root: () => string | undefined;
  /** Where this instance keeps its state. One cache per instance, never shared. */
  stateDir: string;
  /** Injected by tests; production takes `ghRunner()`. */
  run?: GhRunner;
  now?: () => number;
  /**
   * Which plan, phase and run filed a number, when a session of this console
   * did (phase 12). Answered from the plans' issue ledgers by the Pro half;
   * absent — the free console, or a test — means no issue carries a chip.
   * Joined on every `list()`, never written into the cache.
   */
  provenance?: (nameWithOwner: string, number: number) => IssueProvenance | undefined;
};

export class IssuesStore {
  private readonly inFlight = new Map<string, Promise<void>>();

  /** Per-repository: the reason its last attempt failed, and when to try again. */
  private readonly failures = new Map<string, { reason: IssueReason; detail?: string; nextAt: number }>();

  private readonly opts: IssuesStoreOptions;

  constructor(opts: IssuesStoreOptions) {
    this.opts = opts;
  }

  private get now(): number { return (this.opts.now ?? Date.now)(); }

  private get run(): GhRunner { return this.opts.run ?? ghRunner(); }

  /** The estate as it stands. Cheap, and re-read every time — see the header. */
  inventory(): InventoryRepo[] {
    const root = this.opts.root();
    return root ? repoInventory(root) : [];
  }

  /**
   * The whole estate with whatever issues are cached for it. Never fetches.
   *
   * A repository with no GitHub remote is a ROW, carrying `no-remote`. A
   * repository whose last fetch failed keeps its rows and shows both their age
   * and the failure — the two facts a person needs to decide whether to trust
   * what they are looking at.
   */
  list(): IssuesPayload {
    const at = this.now;
    const repos = this.inventory().map((repo) => this.rowFor(repo, at));
    return { at, refreshing: this.inFlight.size > 0, repos };
  }

  private rowFor(repo: InventoryRepo, at: number): RepoIssues {
    const base = {
      key: repo.key,
      label: repo.label,
      scopeToken: repo.scopeToken,
      kind: repo.kind,
      ...(repo.remote ? { remote: repo.remote } : {}),
    };
    if (!repo.github) {
      return { ...base, state: 'unknown', reason: repo.reason ?? 'no-remote', issues: [] };
    }
    const name = repo.github.nameWithOwner;
    const cache = readCache(this.opts.stateDir, name);
    const failure = this.failures.get(name);
    const fetchedAt = cache?.fetchedAt;
    const ageMs = fetchedAt != null ? Math.max(0, at - fetchedAt) : undefined;
    // A failure outranks freshness, and it does NOT hide the rows. That is the
    // whole three-state promise: a caller sees the last good list, how old it
    // is, and why it is not newer.
    const state: RepoIssues['state'] = failure
      ? 'unknown'
      : fetchedAt == null ? 'unknown' : ageMs! <= FRESH_MS ? 'fresh' : 'stale';
    return {
      ...base,
      nameWithOwner: name,
      state,
      ...(failure
        ? {
            reason: failure.reason,
            ...(failure.detail ? { detail: failure.detail } : {}),
            // 🔴 Only where the clock is actually ENFORCED against a press. A
            // plain failure backs off the idle sweep but a person pressing
            // Refresh still retries at once, so publishing a `retryAt` for one
            // would have a board grey out a button that works (QA round 3).
            ...(failure.reason === 'rate-limited' ? { retryAt: failure.nextAt } : {}),
          }
        : {}),
      // 🔴 Never fetched and never failed is its OWN reason, not `failed`.
      // It read as `failed` at first, which would have had Phase 16 paint a
      // failure over a repository where nothing has gone wrong — nobody has
      // asked yet, and the fix is a button, not an investigation. (QA round 1.)
      ...(!failure && fetchedAt == null
        ? { reason: 'never-fetched' as const, detail: 'not fetched yet — press Refresh' }
        : {}),
      ...(fetchedAt != null ? { fetchedAt, ageMs } : {}),
      ...(cache?.truncated ? { truncated: true } : {}),
      issues: this.withProvenance(name, cache?.issues ?? []),
    };
  }

  /** The rows with their provenance joined on — a copy, so the cache is never written with one. */
  private withProvenance(nameWithOwner: string, issues: readonly Issue[]): Issue[] {
    const lookup = this.opts.provenance;
    if (!lookup) return [...issues];
    return issues.map((issue) => {
      const provenance = lookup(nameWithOwner, issue.number);
      return provenance ? { ...issue, provenance } : issue;
    });
  }

  /**
   * Fetch one repository, or every askable one. Single-flighted per repository.
   *
   * `key` is an inventory key — the caller never names a directory or a remote,
   * so an unknown key is a refusal rather than a repository nobody vetted.
   * Returns the payload as it stands afterwards.
   */
  async refresh(key?: string | null): Promise<IssuesPayload | 'unknown-repo'> {
    const inventory = this.inventory();
    let targets: InventoryRepo[];
    if (key) {
      const repo = inventory.find((entry) => entry.key === key);
      if (!repo) return 'unknown-repo';
      // A repository with no GitHub remote is a legitimate key and an
      // impossible fetch. Answering the payload (which says `no-remote` on that
      // row) is more use than a 404 that says the repository is unknown.
      targets = repo.github ? [repo] : [];
    } else {
      targets = askableRepos(inventory);
    }
    await Promise.all(targets.map((repo) => this.fetchOne(repo, true)));
    return this.list();
  }

  /**
   * The idle sweep: keep warm what somebody has already asked for.
   *
   * 🔴 It KEEPS WARM; it does not DISCOVER. A repository that has never been
   * fetched is not fetched here, only by an explicit refresh — which is what
   * makes this safe to hang on a clock at all. The alternative (sweep
   * everything askable) means a console that is merely OPEN reaches GitHub once
   * per repository per quarter hour for repositories nobody has looked at, and
   * a test that constructs a Service against a real root does it for real.
   * "Gentle" has to mean the console spends nothing until asked once.
   */
  async sweep(): Promise<void> {
    const due = askableRepos(this.inventory()).filter((repo) => this.isDue(repo, false));
    await Promise.all(due.map((repo) => this.fetchOne(repo, false)));
  }

  /**
   * Is this repository worth asking about now?
   *
   * `discover` is what separates a refresh from a sweep: a repository with no
   * cached data at all is due for the first, never for the second.
   */
  private isDue(repo: InventoryRepo, discover: boolean): boolean {
    const name = repo.github!.nameWithOwner;
    const at = this.now;
    const failure = this.failures.get(name);
    if (failure) return at >= failure.nextAt;
    const cache = readCache(this.opts.stateDir, name);
    if (cache?.fetchedAt == null) return discover;
    return at - cache.fetchedAt >= IDLE_POLL_MS;
  }

  /**
   * One repository's fetch, deduped.
   *
   * `force` — an operator pressing Refresh — skips the ordinary freshness and
   * failure backoff, because a person asking again is a reason to ask again.
   * 🔴 It does NOT skip a RATE-LIMIT backoff. GitHub has said stop; five
   * presses used to be five more calls at it (QA round 1), which is how a
   * console earns a longer ban rather than a shorter one. The row keeps saying
   * `rate-limited`, so the refusal is visible rather than silent.
   */
  private fetchOne(repo: InventoryRepo, force: boolean): Promise<void> {
    const name = repo.github!.nameWithOwner;
    const running = this.inFlight.get(name);
    if (running) return running;
    const failure = this.failures.get(name);
    if (failure?.reason === 'rate-limited' && this.now < failure.nextAt) return Promise.resolve();
    if (!force && !this.isDue(repo, false)) return Promise.resolve();
    const work = this.fetchNow(repo).finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, work);
    return work;
  }

  private async fetchNow(repo: InventoryRepo): Promise<void> {
    const remote = repo.github!;
    const name = remote.nameWithOwner;
    const outcome = await fetchIssues(remote, this.run);
    if (!outcome.ok) {
      // 🔴 The cache is NOT touched. See the fetch.ts header: an unanswerable
      // probe that empties a list turns "we could not ask" into "there is
      // nothing", which is the one lie this surface must not tell.
      const backoff = outcome.reason === 'rate-limited' ? RATE_LIMIT_BACKOFF_MS : FAIL_BACKOFF_MS;
      this.failures.set(name, {
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
        nextAt: this.now + backoff,
      });
      return;
    }
    this.failures.delete(name);
    // Bodies already fetched survive the refresh: they cost a call each, and the
    // list call never returns one, so dropping them would re-spend that budget
    // on every poll.
    const previous = readCache(this.opts.stateDir, name);
    const bodies = new Map(
      (previous?.issues ?? []).filter((issue) => issue.body !== undefined)
        .map((issue) => [issue.number, issue] as const),
    );
    for (const issue of outcome.issues) {
      const old = bodies.get(issue.number);
      if (!old) continue;
      issue.body = old.body;
      if (old.bodyTruncated) issue.bodyTruncated = true;
    }
    const cache: IssueCache = {
      nameWithOwner: name,
      fetchedAt: this.now,
      issues: outcome.issues,
      ...(outcome.truncated ? { truncated: true } : {}),
    };
    // 🔴 A fetch that SUCCEEDED and could not be stored is its own state, and
    // it is not `never-fetched`. `writeCache` stopped throwing in round 2 (a
    // 500 carrying a filesystem path), which left the row reading "not fetched
    // yet — press Refresh" after a fetch that worked: pressing it would fetch
    // again, succeed again, and fail to store again, for ever (QA round 3).
    // Recorded as a failure so the row says what is wrong, and with the plain
    // backoff so a person can still retry once they have freed some disk.
    if (!writeCache(this.opts.stateDir, cache)) {
      this.failures.set(name, {
        reason: 'failed',
        detail: 'fetched, but the cache could not be written — is the state directory writable?',
        nextAt: this.now + FAIL_BACKOFF_MS,
      });
    }
  }

  /**
   * Resolve a ticket's issue refs against the estate.
   *
   * The inventory is the allowlist in both directions: a ref naming a
   * repository this console does not stand on is `unknown`, and so is one
   * naming an issue that is not in that repository's cache. A caller therefore
   * cannot use this to make the console fetch an arbitrary `owner/repo` —
   * which is the point, and why the route need not sanitise anything itself.
   *
   * Bodies are fetched here, once, for exactly the issues the ticket names: a
   * plan session needs the text of the issues it is planning, and nothing else.
   * A body that cannot be fetched is absent, and the composed prompt says so.
   */
  async resolve(refs: readonly string[]): Promise<ResolvedIssues> {
    const inventory = this.inventory();
    /** Per repository, the numbers this ticket wants — so bodies are one pass. */
    const wanted = new Map<string, { repo: InventoryRepo; numbers: number[] }>();

    // One slot per ref, IN THE ORDER THE OPERATOR CHOSE, resolved in place. The
    // order is not cosmetic: `unknown` becomes a refusal message a person reads
    // against the list they just ticked, and a jumbled list is one they have to
    // re-derive. Two passes over one array rather than two arrays, so an
    // unknown found in the second pass cannot land after one found in the first.
    //
    // Bounded HERE and not only in the ticket validator. The route resolves
    // before it validates — it has to, because the validator's refusal is
    // written from what resolution found — so this is the function a caller's
    // array reaches first, and it must not agree to look up ten thousand refs
    // on the way to being told there were too many.
    type Slot = { ref: string; name?: string; number?: number; repo?: InventoryRepo };
    const slots: Slot[] = [];
    const seen = new Set<string>();
    for (const raw of refs.slice(0, TICKET_ISSUES_MAX)) {
      const trimmed = String(raw ?? '').trim();
      const match = ISSUE_REF_RE.exec(trimmed);
      // Sliced only when it is NOT a ref. A valid one runs to 153 characters
      // (39 owner + 100 repo + 12 digits), and a blanket `.slice(0, 120)` cut a
      // long-but-legal ref's issue NUMBER off and then reported the shortened
      // string as unknown — quietly rewriting what the operator asked for.
      // (QA round 1.) An unmatched ref is still bounded, because it is echoed
      // back in a refusal message.
      const ref = match ? trimmed : trimmed.slice(0, 120);
      const name = match ? `${match[1]}/${match[2]}` : undefined;
      const repo = name ? repoByNameWithOwner(inventory, name) : null;
      // Deduped like `issueRefs` in the ticket validator, and for the same
      // reason: the same issue twice is one issue, and quoting it twice would
      // spend the section's budget on a copy.
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (!match || !name || !repo) { slots.push({ ref }); continue; }
      const number = Number(match[3]);
      slots.push({ ref, name, number, repo });
      const slot = wanted.get(name) ?? { repo, numbers: [] };
      if (!slot.numbers.includes(number)) slot.numbers.push(number);
      wanted.set(name, slot);
    }

    // 🔴 One shared wall clock across every repository, not one each: the caller
    // is a request, and three repositories × 20 s is a minute of held browser.
    const deadline = this.now + BODY_FETCH_BUDGET_MS;
    for (const [name, { repo, numbers }] of wanted) {
      // Wait out any refresh already in flight for this repository, so the read
      // below sees its result rather than racing it.
      await this.inFlight.get(name)?.catch(() => {});
      const cache = readCache(this.opts.stateDir, name);
      if (!cache) continue;
      await fetchBodies(repo.github!, cache.issues, numbers, this.run,
        { deadline, now: () => this.now });
      // 🔴 MERGE, never write back what we read. `resolve` reads the cache,
      // then awaits up to twenty `gh` calls; a refresh landing inside that
      // window used to be undone wholesale when the stale copy was written over
      // it — issues that had arrived vanished and `fetchedAt` rolled BACKWARDS
      // (QA round 1). Re-reading here and applying only the bodies narrows the
      // window to the two statements below and can never lose a row or a stamp:
      // the merge takes the fresh cache's issues and fetchedAt, and contributes
      // only text it fetched.
      mergeBodies(this.opts.stateDir, name, cache.issues);
    }

    const issues: IssueBrief[] = [];
    const unknown: string[] = [];
    // One read per REPOSITORY, not one per slot: twenty refs against one
    // repository parsed and validated the same file twenty times, which for a
    // hundred cached issues is real work inside a request (QA round 2, Low).
    const caches = new Map<string, ReturnType<typeof readCache>>();
    for (const slot of slots) {
      if (!slot.name) { unknown.push(slot.ref); continue; }
      if (!caches.has(slot.name)) caches.set(slot.name, readCache(this.opts.stateDir, slot.name));
      const cache = caches.get(slot.name) ?? null;
      const issue = cache?.issues.find((row) => row.number === slot.number);
      if (!issue || !slot.repo) { unknown.push(slot.ref); continue; }
      issues.push({
        ref: slot.ref,
        nameWithOwner: slot.name,
        scopeToken: slot.repo.scopeToken,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels,
        url: issue.url,
        ...(issue.body !== undefined ? { body: issue.body } : {}),
        ...(issue.bodyTruncated ? { bodyTruncated: true } : {}),
      });
    }
    return { issues, unknown };
  }
}
