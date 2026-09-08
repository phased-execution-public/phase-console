/**
 * Issues, fetched through `gh` and cached with an age on them.
 *
 * The shape is `accounts/usage.ts`'s, because the problem is the same one: a
 * remote meter that must never become the thing the console blocks on, and
 * never become the thing that hammers a rate limit either. What is borrowed is
 * its three habits — single-flight per key, an idle cadence rather than a
 * poll-on-read, and a harder backoff for 429 than for a plain failure — and its
 * one principle: **the poller is telemetry, never the detector.** Nothing in
 * this console decides anything from an issue. An operator reads them and
 * chooses; that is the whole use.
 *
 * ## Three states, and the honesty they buy
 *
 * A repository's issues are `fresh` (fetched within `FRESH_MS`), `stale` (older
 * than that, and the age is SHOWN — a stale list is still the truth about some
 * moment), or `unknown` with a reason:
 *
 *   `no-gh`         `gh` is not installed on this machine
 *   `no-auth`       it is installed and not signed in to this repository
 *   `rate-limited`  GitHub said 429/rate limit
 *   `no-remote`     the repository has no GitHub remote at all (inventory.ts)
 *   `failed`        anything else, with what `gh` printed
 *
 * 🔴 **A probe that cannot answer NEVER empties the cache.** The failure mode
 * this exists to prevent is the one every cache-with-a-refresh eventually has:
 * `gh` times out, the refresh writes `[]`, and a board that showed nine open
 * issues a minute ago now shows a clean estate — which is a lie in the one
 * direction that matters. So a failed fetch keeps the last good rows, marks
 * them with their real age, and reports the reason beside them. `unknown` and
 * "no issues" are two different sentences and this module never conflates them.
 *
 * ## Read-only, and pinned as such
 *
 * Every `gh` invocation here is a fixed argv whose head is `issue` and whose
 * verb is `list` or `view` — asserted by `test/issues-readonly.test.ts`, which
 * scans this directory the way `never-push.test.ts` scans the server for git
 * argv. `gh` holds its own credentials in its own config; no token is read
 * here, and none can therefore reach a payload.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GitHubRemote } from './inventory.ts';

/* ------------------------------------------------------------------ *
 * Caps and cadences. Every one of them is reported when it bites.
 * ------------------------------------------------------------------ */

/** Issues fetched per repository. Beyond this the list is marked `truncated`. */
export const ISSUE_PAGE_MAX = 100;

/** Bodies are fetched one call each, so this bound is the one that costs money. */
export const BODY_FETCH_MAX = 20;

/**
 * The whole body-fetching pass's wall clock, and how many run at once.
 *
 * Both exist because this pass happens INSIDE the ticket request. Twenty
 * sequential calls at the `gh` timeout is five minutes of a held connection;
 * four lanes under a 20 s budget is a worst case an operator will sit through,
 * and every body that misses it is absent rather than late.
 */
export const BODY_FETCH_BUDGET_MS = 20_000;
export const BODY_FETCH_LANES = 4;

/** Longest an issue body may be carried. Truncation is marked, never silent. */
export const BODY_BYTES_MAX = 8 * 1024;

/** Younger than this is `fresh`; older is `stale`, with its age shown. */
export const FRESH_MS = 10 * 60_000;

/** The idle cadence — a courtesy budget, not a detector. */
export const IDLE_POLL_MS = 15 * 60_000;

/** After a plain failure, and after a 429. The second is deliberately far longer. */
export const FAIL_BACKOFF_MS = 5 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;

/** One `gh` call's budget. A slow network must not hold a request open. */
export const GH_TIMEOUT_MS = 15_000;

/** The fields asked for. Bounded on purpose: a body is a separate, on-demand call. */
export const ISSUE_LIST_FIELDS = 'number,title,state,labels,assignees,updatedAt,url';

/**
 * Why a repository's issues are not known.
 *
 * `never-fetched` is the one that is not a fault: nothing has asked yet. It is
 * separate from `failed` because a board that paints "failed" over a repository
 * where nothing has gone wrong sends an operator looking for a problem whose
 * fix is a button. (QA round 1.)
 */
export type IssueReason =
  'no-gh' | 'no-auth' | 'rate-limited' | 'no-remote' | 'never-fetched' | 'failed';

export type Issue = {
  number: number;
  title: string;
  /** `OPEN` | `CLOSED`, as `gh` spells it. */
  state: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  url: string;
  /** Present only once a body has been asked for. Plain text, never rendered. */
  body?: string;
  /** True when `body` was cut at `BODY_BYTES_MAX`. */
  bodyTruncated?: boolean;
};

export type IssueCache = {
  /** `owner/repo`. */
  nameWithOwner: string;
  /** Epoch ms of the last SUCCESSFUL fetch. Absent when there has never been one. */
  fetchedAt?: number;
  issues: Issue[];
  /** True when the repository has more issues than `ISSUE_PAGE_MAX`. */
  truncated?: boolean;
};

export type FetchOutcome =
  | { ok: true; issues: Issue[]; truncated: boolean }
  | { ok: false; reason: IssueReason; detail?: string };

export type GhRunner = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/* ------------------------------------------------------------------ *
 * The `gh` calls — two verbs, fixed argv, never a shell
 * ------------------------------------------------------------------ */

/**
 * `gh` with a bounded argv and a built environment.
 *
 * The environment is built rather than inherited for the reason `git-browse`'s
 * is: a `GH_REPO` or `GH_HOST` in the console's own environment would make
 * these reads answer about a different repository, and this surface is
 * reachable from a browser. `GH_PROMPT_DISABLED` and `NO_COLOR` keep a
 * half-configured `gh` from blocking on a prompt or answering in escape codes.
 */
export function ghRunner(env: NodeJS.ProcessEnv = process.env, timeoutMs = GH_TIMEOUT_MS): GhRunner {
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
    HOME: env.HOME ?? '',
    LC_ALL: 'C',
    NO_COLOR: '1',
    TERM: 'dumb',
    GH_PROMPT_DISABLED: '1',
    ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}),
    ...(env.GITHUB_TOKEN ? { GITHUB_TOKEN: env.GITHUB_TOKEN } : {}),
    ...(env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: env.GH_CONFIG_DIR } : {}),
  };
  return (args: string[]) => new Promise((done) => {
    execFile('gh', args, { timeout: timeoutMs, env: child, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `||` and not `??`, which is the difference between a reason and a
        // shrug: a binary that is not on PATH fails with an EMPTY stderr and
        // `spawn gh ENOENT` in the error, and `?? ` keeps the empty string —
        // so every missing `gh` read as `failed` instead of `no-gh`, and the
        // one failure an operator can actually fix was the one not named.
        done({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr || error?.message || '') });
      });
  });
}

/**
 * Read a failure back as one of the reasons a person can act on.
 *
 * Ordered most specific first, and `no-gh` is checked on the spawn error rather
 * than the output because an ENOENT has no stderr worth reading.
 */
export function reasonFor(stderr: string): IssueReason {
  const text = String(stderr ?? '');
  if (/ENOENT|command not found|not found in \$?PATH|spawn gh/i.test(text)) return 'no-gh';
  if (/rate limit|secondary rate|API rate limit exceeded|\b429\b/i.test(text)) return 'rate-limited';
  if (/gh auth login|not logged|authentication|credentials|\b401\b|Bad credentials/i.test(text)) return 'no-auth';
  // A private repository the signed-in account cannot see answers 404, and the
  // useful thing to tell an operator is that their `gh` cannot reach it — which
  // is what `no-auth` says. A genuinely deleted repository reads the same way,
  // and pointing at the sign-in is the cheaper wrong guess of the two.
  if (/\b404\b|Could not resolve to a Repository|HTTP 403/i.test(text)) return 'no-auth';
  return 'failed';
}

/** One repository's issue list. Every failure is a reason, never a throw. */
export async function fetchIssues(
  remote: GitHubRemote, run: GhRunner, limit = ISSUE_PAGE_MAX,
): Promise<FetchOutcome> {
  const capped = Math.max(1, Math.min(Math.floor(limit) || ISSUE_PAGE_MAX, ISSUE_PAGE_MAX));
  // One over the cap, so "there are more" is measured rather than assumed: a
  // repository with exactly `capped` issues would otherwise always read as
  // truncated. The extra row is dropped before it is returned.
  const args = [
    'issue', 'list',
    '--repo', remote.nameWithOwner,
    '--state', 'all',
    '--limit', String(Math.min(capped + 1, ISSUE_PAGE_MAX + 1)),
    '--json', ISSUE_LIST_FIELDS,
  ];
  const answer = await run(args);
  if (!answer.ok) return { ok: false, reason: reasonFor(answer.stderr), detail: trim(answer.stderr) };
  // 🔴 Empty stdout is a FAILURE, not an empty repository (QA round 2). `gh
  // issue list --json` always prints at least `[]`; nothing at all means the
  // process exited 0 without answering — killed, or a `gh` that is really a
  // wrapper script. `|| '[]'` turned that silence into a confident empty list
  // written over the cache stamped fresh, which is the lie this module exists
  // to refuse.
  if (!answer.stdout.trim()) {
    return { ok: false, reason: 'failed', detail: 'gh exited 0 and said nothing' };
  }
  let rows: unknown;
  try { rows = JSON.parse(answer.stdout); } catch {
    return { ok: false, reason: 'failed', detail: 'unparseable gh output' };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: 'failed', detail: 'gh did not answer a list' };
  const issues = rows.map(normalizeIssue).filter((issue): issue is Issue => issue !== null);
  // 🔴 A non-empty answer that yields NO usable issue is a failure, not an empty
  // repository — and the difference is the whole promise of this file. It used
  // to return `ok: true, issues: []`, which `fetchNow` then wrote over the cache
  // stamped FRESH: `gh` changing a field name, or answering an error object
  // inside an array, would have replaced nine real issues with a confident
  // empty list. An actually-empty repository answers `[]` and still reads as
  // `ok` with no issues, which is the one case that is true. (QA round 1.)
  if (rows.length && !issues.length) {
    return { ok: false, reason: 'failed', detail: `gh answered ${rows.length} rows, none of them an issue` };
  }
  return { ok: true, issues: issues.slice(0, capped), truncated: issues.length > capped };
}

/**
 * Bodies for issues already in the list, fetched one call each and capped.
 *
 * Mutates the rows it is given rather than returning new ones: a body belongs
 * to the issue and carrying two copies of a list around is how one of them ends
 * up stale. A body that cannot be fetched is left ABSENT, which reads as "not
 * asked for yet" — the same state it was in, and never an empty string
 * pretending to be an empty issue.
 */
export async function fetchBodies(
  remote: GitHubRemote,
  issues: Issue[],
  numbers: readonly number[],
  run: GhRunner,
  opts: { deadline?: number; concurrency?: number; now?: () => number } = {},
): Promise<number> {
  // The caller's clock, not this module's. `resolve` computes its deadline from
  // the store's injected `now`, and comparing that against a real `Date.now()`
  // made a test clock of 1_000_000 an instantly-expired budget — zero bodies
  // fetched, silently (QA round 2). One clock decides both ends of a deadline.
  const now = opts.now ?? Date.now;
  const wanted = numbers.slice(0, BODY_FETCH_MAX)
    .map((number) => issues.find((row) => row.number === number))
    .filter((issue): issue is Issue => Boolean(issue) && issue!.body === undefined);
  // 🔴 A wall clock and a small fan-out, because this runs INSIDE the ticket
  // request. Twenty bodies fetched one after another at the 15 s `gh` timeout
  // is a five-minute hang on `POST /api/terminal` — measured in QA round 1. A
  // body that does not arrive in time is simply absent, and the composed
  // prompt already says so and sends the session to the URL: late is worse
  // than missing here, because missing is honest and late is a dead browser.
  const deadline = opts.deadline ?? now() + BODY_FETCH_BUDGET_MS;
  const lanes = Math.max(1, Math.min(opts.concurrency ?? BODY_FETCH_LANES, wanted.length || 1));
  let next = 0;
  let filled = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (now() >= deadline) return;
      const issue = wanted[next++];
      if (!issue) return;
      const answer = await run(
        ['issue', 'view', String(issue.number), '--repo', remote.nameWithOwner, '--json', 'body'],
      );
      if (!answer.ok) continue;
      let body = '';
      try { body = String((JSON.parse(answer.stdout || '{}') as { body?: unknown }).body ?? ''); } catch { continue; }
      const clamped = clampBytes(body, BODY_BYTES_MAX);
      issue.body = clamped.text;
      if (clamped.cut) issue.bodyTruncated = true;
      filled += 1;
    }
  };

  await Promise.all(Array.from({ length: lanes }, worker));
  return filled;
}

/**
 * A string cut to `max` BYTES, and whether it was cut.
 *
 * The one definition of "how long may a body be", because there were two: the
 * fetch clamped bytes and the cache read clamped UTF-16 code units, so a body
 * of astral characters grew on the way back off disk. `toString` on a sliced
 * Buffer replaces a split multi-byte character with U+FFFD — a visible, honest
 * cut rather than a silently invalid one.
 */
export function clampBytes(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, cut: false };
  return { text: Buffer.from(text).subarray(0, max).toString('utf8'), cut: true };
}

/** One `gh` row, read defensively — a field that is not what it claims is dropped. */
function normalizeIssue(row: unknown): Issue | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const number = Number(r.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    number,
    title: text(r.title, 400),
    state: text(r.state, 24) || 'OPEN',
    labels: names(r.labels, 'name'),
    assignees: names(r.assignees, 'login'),
    updatedAt: text(r.updatedAt, 40),
    url: text(r.url, 400),
  };
}

function text(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.length > max ? s.slice(0, max) : s;
}

function names(value: unknown, field: 'name' | 'login'): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value.slice(0, 40)) {
    const name = entry && typeof entry === 'object'
      ? text((entry as Record<string, unknown>)[field], 80)
      : text(entry, 80);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function trim(detail: string): string {
  return String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * The cache — one file per repository, under the instance's state dir
 * ------------------------------------------------------------------ */

/** A cache filename that cannot escape its directory, whatever the remote said. */
export function cacheFileName(nameWithOwner: string): string {
  return `${nameWithOwner.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`;
}

export function cacheDir(stateDir: string): string {
  return join(stateDir, 'issues');
}

export function readCache(stateDir: string, nameWithOwner: string): IssueCache | null {
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir(stateDir), cacheFileName(nameWithOwner)), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.issues)) return null;
    const issues = raw.issues.map(normalizeIssue).filter((i: Issue | null): i is Issue => i !== null);
    // A body survives the round trip; `normalizeIssue` deliberately does not
    // carry one, because a `gh issue list` row never has it.
    //
    // Matched by NUMBER, not by position. `filter` above drops any row that is
    // not an issue, so the two arrays stop being parallel the moment one is
    // dropped — and a positional read then hands every later issue the previous
    // one's body, which is the worst possible way to be wrong here: a plan
    // session briefed on issue 7 under the title of issue 8.
    const bodies = new Map<number, Record<string, unknown>>();
    for (const source of raw.issues as Record<string, unknown>[]) {
      const number = Number(source?.number);
      if (Number.isSafeInteger(number) && typeof source?.body === 'string') bodies.set(number, source);
    }
    for (const issue of issues) {
      const source = bodies.get(issue.number);
      if (!source) continue;
      // Clamped in BYTES, like the write path. `.slice(n)` counts UTF-16 code
      // units, so a body of astral characters read back at up to twice the cap
      // the fetch enforced — the mismatch QA round 1 measured. `clampBytes`
      // is the one definition of "how long may a body be".
      const { text, cut } = clampBytes(String(source.body), BODY_BYTES_MAX);
      issue.body = text;
      if (cut || source.bodyTruncated === true) issue.bodyTruncated = true;
    }
    return {
      nameWithOwner,
      ...(Number.isFinite(raw.fetchedAt) ? { fetchedAt: Number(raw.fetchedAt) } : {}),
      issues,
      ...(raw.truncated === true ? { truncated: true } : {}),
    };
  } catch { return null; }
}

/**
 * Write a repository's cache atomically.
 *
 * Rename-over-temp rather than a plain write: this file is read by the same
 * process on the next request and by a restarted console after that, and a
 * half-written JSON that parses as nothing would drop the last good data —
 * which is the one thing this module promises never to do.
 */
/**
 * Fold bodies from `carrying` into whatever is on disk NOW, by issue number.
 *
 * The safe half of a read-modify-write: a caller that read the cache, spent
 * twenty seconds fetching bodies, and then wrote its stale copy back would undo
 * a refresh that landed meanwhile — losing rows and rolling `fetchedAt`
 * backwards (QA round 1). This re-reads, contributes only the text it has, and
 * keeps the disk copy's issues and stamp. A no-op when there is nothing to add,
 * so it does not rewrite a file for nothing.
 */
export function mergeBodies(stateDir: string, nameWithOwner: string, carrying: readonly Issue[]): void {
  const bodies = new Map(
    carrying.filter((issue) => issue.body !== undefined).map((issue) => [issue.number, issue] as const),
  );
  if (!bodies.size) return;
  const current = readCache(stateDir, nameWithOwner);
  if (!current) return;
  let changed = false;
  for (const issue of current.issues) {
    const from = bodies.get(issue.number);
    if (!from || issue.body !== undefined) continue;
    issue.body = from.body;
    if (from.bodyTruncated) issue.bodyTruncated = true;
    changed = true;
  }
  if (changed) writeCache(stateDir, current);
}

export function writeCache(stateDir: string, cache: IssueCache): boolean {
  // 🔴 Never throws. A cache is an optimisation: a full disk or a read-only
  // state directory must degrade to "not cached", not to a 500 whose body
  // carries a filesystem path back to a browser (QA round 2). The caller that
  // cares gets `false`; the ones that do not are correct to ignore it, because
  // the data they hold is still the data they hold.
  try {
    const dir = cacheDir(stateDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, cacheFileName(cache.nameWithOwner));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}
