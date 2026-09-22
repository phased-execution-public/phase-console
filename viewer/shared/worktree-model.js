/**
 * The words run isolation is described in, owned once.
 *
 * Before this file the console had exactly one worktree concept — the
 * per-PHASE lanes a plan opts into with `**Worktrees:** on`, built by
 * `server/runner/worktree.ts`. This plan adds a second, orthogonal one: a
 * per-RUN checkout, so two runs whose repository scopes overlap can be
 * admitted at the same time instead of queueing behind each other.
 *
 * Four vocabularies come with it, and they answer four different questions:
 *
 *   ISOLATION_MODES    what the operator ASKED for  (a setting)
 *   CHECKOUT_STATES    what the run actually GOT    (an outcome)
 *   RADAR_STATES       how two live branches RELATE (a measurement)
 *   SETTLE_STRATEGIES  what happens when a run ENDS (a policy)
 *
 * Keeping `isolation` and `checkout` apart is the load-bearing distinction and
 * the reason there are two lists rather than one. A run can ask for `worktree`
 * and be refused — the repository is a superproject, the disk is full, the cap
 * is reached — and when that happens the run does not fail: it degrades to the
 * shared checkout and says why. A single merged word-set would make "asked for
 * isolation" and "is isolated" the same fact, and the refusal would have
 * nowhere to live but a log line nobody reads.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly, so it must stay free of anything either cannot resolve.
 * `test/vocab-owners.test.ts` registers all four: a second spelling of any of
 * them anywhere under `shared/`, `server/` or `client/src/` fails that scan.
 */

/**
 * What a run may ask for.
 *
 * `queue` is today's behaviour and the default everywhere — sessions work in
 * the checkout the console was pointed at, and the scheduler serializes runs
 * whose scopes overlap. `worktree` asks for a console-managed linked checkout
 * of the run's own branch, which is what lets the scheduler admit two
 * overlapping runs at once (phase 8).
 *
 * Absent means `queue`, in run state and in every reader. That is deliberate:
 * every run file written before this feature existed must keep meaning exactly
 * what it meant, and the safe answer must be the one you get by saying nothing.
 * @typedef {'queue'|'worktree'} IsolationMode
 * @type {readonly IsolationMode[]}
 */
export const ISOLATION_MODES = Object.freeze(/** @type {const} */ (['queue', 'worktree']));

/** The one mode that isolates. Named, so no reader re-types the literal. */
export const ISOLATED = /** @type {const} */ ('worktree');

/** What the operator reads next to each choice. */
export const ISOLATION_LABELS = Object.freeze({
  queue: 'Queue — overlapping runs wait their turn in the shared checkout',
  worktree: 'Worktree — this run gets its own checkout and runs alongside',
});

/**
 * Coerce anything at all to a mode, by EXACT literal.
 *
 * The same rule `gitMode` and `mcpPolicy` follow, for the same reason: a typo
 * in `config.json`, a stale client, or a hand-edited run file must never be
 * what mints a worktree. Only the word `worktree`, spelled exactly, isolates;
 * everything else — including `'Worktree'`, `'true'`, `1` and `undefined` —
 * reads as `queue`.
 * @param {unknown} value
 * @returns {IsolationMode}
 */
export function isolationMode(value) {
  return value === ISOLATED ? ISOLATED : 'queue';
}

/**
 * What a run's checkout actually IS, once the runner has tried.
 *
 * - `shared`   — the console's own checkout; what a `queue` run always gets.
 * - `worktree` — a managed linked checkout under the instance state dir.
 * - `refused`  — isolation was asked for and could not be given. The run is
 *                working in the shared checkout with queue semantics, and
 *                `RunState.isolationRefusal` names which impossibility it hit.
 *
 * `refused` is a state and not an error on purpose. The feature's whole safety
 * story is that every impossibility degrades to the behaviour that existed
 * before the feature, visibly.
 * @typedef {'shared'|'worktree'|'refused'} CheckoutState
 * @type {readonly CheckoutState[]}
 */
export const CHECKOUT_STATES = Object.freeze(/** @type {const} */ (['shared', 'worktree', 'refused']));

/**
 * How two live branches relate — the conflict radar's verdict, measured with
 * `git merge-tree` rather than guessed from file lists.
 *
 * - `clean`      — the branches touch no common file.
 * - `overlap`    — they touch common files but still merge cleanly.
 * - `conflicted` — a real merge conflict is already sitting there.
 * - `unknown`    — the probe could not answer (no common ancestor, a git that
 *                  is too old, a timeout). Distinct from `clean`, and that
 *                  distinction is the point: an unmeasured pair must never
 *                  paint as a safe one.
 * @typedef {'clean'|'overlap'|'conflicted'|'unknown'} RadarState
 * @type {readonly RadarState[]}
 */
export const RADAR_STATES = Object.freeze(
  /** @type {const} */ (['clean', 'overlap', 'conflicted', 'unknown']),
);

/**
 * A radar pair's identity, order-independent — `a×b` and `b×a` are one
 * question, so they must be one string.
 *
 * Lives beside the verdict it identifies rather than in
 * `server/runner/worktree.ts`, where it was born: the probe mints these keys
 * and `server/inbox.ts` has to recognise them, and the inbox is a pure module
 * with no business importing the git layer to learn how a pair is spelled.
 * Two spellings of one pair would mean an operator acknowledging a conflict
 * and being asked the same question again from the other side.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function pairKey(a, b) {
  return [a, b].sort().join(' × ');
}

/**
 * What a WORK-BRANCH run does with its branch when it finishes.
 *
 * Any `gitMode: 'new-branch'` run, not only an isolated one — isolation is
 * about where the run WORKS and this is about where its branch ENDS UP, and a
 * run sharing the console's checkout still has a `pe/<slug>` to settle. (This
 * line read "an isolated run" while the words were only a vocabulary; P12 wired
 * them, and the gate is the branch.)
 *
 * - `pr`          — push the branch and open a PR (today's `openPr`, and the
 *                   default: it is the only one that ends with a person
 *                   looking at the diff).
 * - `merge-queue` — one more session rebases the branch on what landed while
 *                   the run drove, re-runs the plan's end-to-end verification,
 *                   and pushes only if that passes. The console never rebases
 *                   anything itself.
 * - `integration` — the console merges the branch into its own staging
 *                   checkout (`pe/integration`, one per console — see
 *                   `server/runner/worktree.ts` §`stagingNames`) and stops.
 *                   No remote is touched and no session is spent.
 * - `keep`        — do nothing; the branch and its worktree stay for a person.
 * @typedef {'pr'|'merge-queue'|'integration'|'keep'} SettleStrategy
 * @type {readonly SettleStrategy[]}
 */
export const SETTLE_STRATEGIES = Object.freeze(
  /** @type {const} */ (['pr', 'merge-queue', 'integration', 'keep']),
);

/**
 * The strategy a run gets by saying nothing — and the only one that existed
 * before this vocabulary was wired.
 *
 * Named rather than typed inline at each reader for the reason every default in
 * this codebase is: the fallback is the sentence "a finished branch ends up in
 * front of a person", and a second copy of it could be changed in one place.
 */
export const DEFAULT_SETTLE = /** @type {const} */ ('pr');

/** What the operator reads next to each choice. */
export const SETTLE_LABELS = Object.freeze({
  pr: 'Pull request — push the branch and open a PR for a person to read',
  'merge-queue': 'Merge queue — a session rebases on what landed, re-verifies, then pushes',
  integration: "Integration — merge the branch into the console's staging checkout, and stop",
  keep: 'Keep — leave the branch and its checkout exactly where they are',
});

/**
 * The two strategies that end at a remote — and therefore the two that may open
 * the push carve-out.
 *
 * This set is the whole reason `settle` is not four independent booleans. The
 * console's deny wall refuses `git push` in every profile; the ONE hole in it is
 * the openPr carve-out, and which strategies deserve that hole is a single fact
 * that must be stated once. `integration` merges locally and `keep` does
 * nothing, so neither may have it — and a strategy added later gets no push
 * unless somebody puts it here on purpose.
 * @type {ReadonlySet<SettleStrategy>}
 */
export const SETTLE_PUSHES = Object.freeze(new Set(/** @type {const} */ (['pr', 'merge-queue'])));

/**
 * Coerce anything at all to a strategy, by EXACT literal.
 *
 * The same rule `isolationMode` follows, one rung stricter about what "nothing"
 * means: a hand-edited run file, a stale client or a typo in `config.json` must
 * fall back to `pr` — the behaviour every run had before this existed — rather
 * than to the quietest option. Getting this backwards would mean a misspelled
 * setting silently stopped opening pull requests, which is a feature going
 * missing with no error anywhere.
 * @param {unknown} value
 * @returns {SettleStrategy}
 */
export function settleStrategy(value) {
  return SETTLE_STRATEGIES.includes(/** @type {never} */ (value))
    ? /** @type {SettleStrategy} */ (value)
    : DEFAULT_SETTLE;
}

/**
 * What a run's END means, resolved from what is actually on the run file.
 *
 * The back-compatibility rule, in one place. `settle` is new; `openPr` is not,
 * and thousands of run files carry it. A run that said `openPr: false` asked for
 * exactly what `keep` means, and it must keep meaning that — so an ABSENT
 * `settle` reads the older field rather than defaulting past it.
 *
 * The other direction never needs asking: when `settle` is present it is the
 * answer, and the writers below keep `openPr` in step so no reader that still
 * consults it can disagree.
 * @param {{ settle?: unknown, openPr?: unknown }} state
 * @returns {SettleStrategy}
 */
export function settleOf(state) {
  if (SETTLE_STRATEGIES.includes(/** @type {never} */ (state?.settle))) {
    return /** @type {SettleStrategy} */ (state.settle);
  }
  return state?.openPr === false ? 'keep' : DEFAULT_SETTLE;
}

/**
 * Defaults for the three lifecycle knobs that ride alongside the mode.
 *
 * They live here rather than in `server/config.ts` so the client's launch
 * dialog can seed its control from the same numbers the server coerces to,
 * without importing anything server-side.
 *
 * - `worktreeMaxConcurrent` — how many managed worktrees may exist across all
 *   live runs. A positive integer; three is a laptop-shaped answer (each is a
 *   full checkout on disk), and the cap is what stops a busy console filling
 *   the disk one run at a time.
 * - `worktreeSetup` — a shell command run once in a freshly created tree
 *   (`npm ci`, a symlink, nothing). Empty string means none.
 * - `worktreeCopyEnv` — copy the source checkout's ignored `.env` files into
 *   the new tree. OFF by default: copying secrets into a second directory is a
 *   decision an operator makes, never a default they discover.
 * - `worktreeRoot` — where every tree the console makes for this instance
 *   lives: `project` (inside the instance root, `.worktrees/`) or `state`
 *   (the console's state directory). See `WORKTREE_ROOTS`.
 */
export const WORKTREE_DEFAULTS = Object.freeze({
  worktreeMaxConcurrent: 3,
  worktreeSetup: '',
  worktreeCopyEnv: false,
  worktreeRoot: 'project',
});

/**
 * Where the console puts every tree it makes for an instance.
 *
 * `project` — the default — is `<root>/.worktrees/` INSIDE the instance root:
 * console lanes and mirrors under `runs/<slug>/<runId>/`, the `pe/integration`
 * staging tree at `staging/`, and a hand session's own lanes under `hand/`
 * (`scripts/phase-lane.sh`). One folder, beside the work it belongs to, that a
 * person can find, that `git status` at the root never shows (the console
 * writes it into `.git/info/exclude`), and that the docs-root walk of every
 * skill script resolves from. `state` is the older placement under the
 * console's XDG state directory (`runs/<instance>/<slug>/worktrees/`). The
 * sweeper reads BOTH homes whatever this says, so a tree made under the other
 * one is never orphaned by flipping the setting, and a run resumed after a
 * flip keeps the home its tree already stands in.
 * @type {readonly ['project', 'state']}
 */
export const WORKTREE_ROOTS = Object.freeze(/** @type {const} */ (['project', 'state']));

/** @typedef {(typeof WORKTREE_ROOTS)[number]} WorktreeRoot */

/** Coerce anything to a worktree root; only the exact word `state` leaves the project. */
export function worktreeRootOf(value) {
  return value === 'state' ? 'state' : 'project';
}

/**
 * When the console may take the run branch back from a checkout sitting on it.
 *
 * `clean-only` — the default and the only mode that does anything: a checkout
 * standing on `pe/<slug>` with nothing uncommitted in it is switched to the
 * default branch, so the run can have its own tree. Nothing is deleted and no
 * ref moves; the branch is exactly where it was, with one fewer working tree
 * on it. `never` turns it off for operators who would rather be asked.
 *
 * There is deliberately no `always`. A dirty checkout holds work that exists
 * nowhere else, and no setting should be able to authorise throwing it away.
 * @type {readonly ['clean-only', 'never']}
 */
export const ISOLATION_RECLAIM = Object.freeze(/** @type {const} */ (['clean-only', 'never']));

/** @typedef {(typeof ISOLATION_RECLAIM)[number]} IsolationReclaim */

/** Coerce anything to a reclaim mode; only the exact word turns it off. */
export function reclaimModeOf(value) {
  return value === 'never' ? 'never' : 'clean-only';
}

/**
 * The branch spelling of a DETACHED checkout, for the lock's `branch=` line.
 *
 * A detached tree owns no ref, so it has no branch NAME — and an unqualified
 * lock collides with everything, which would make the whole detached shape
 * pointless. `detached@<sha12>` is the honest qualification: it names the
 * commit the tree stands at, and it contends with nobody holding a real ref
 * because the strings never match. Two detached claims at different commits
 * differ as strings and carve like any two branches. Two at the SAME commit —
 * the common case, since both resolve the same trunk — are decided by the
 * TREE dimension alone: `claimsDisjoint` lets an equal `detached@` pair fall
 * through to its tree test, because "the same branch is the same work" is
 * true of a ref (where two trees' commits would land on top of each other)
 * and false of a detached HEAD, which has none. So two runs detached at one
 * trunk head in two console-managed trees run side by side; the same tree, or
 * one inside the other, still collides; and two runs of ONE plan never carve
 * (`sameUnitOfWork`). Until console-parallel-repaint P1 they were serialised
 * — P6's accepted tradeoff, re-priced once the tree dimension existed.
 *
 * Twelve hex, the same width git itself prints for an unambiguous short sha in
 * a repository of any size this console meets, and short enough to read on a
 * queue page.
 * @param {string} sha
 * @returns {string}
 */
export function detachedRef(sha) {
  return `detached@${String(sha ?? '')
    .trim()
    .slice(0, 12)}`;
}

/** Is this branch spelling a detached checkout rather than a real ref? */
export function isDetachedRef(branch) {
  return typeof branch === 'string' && branch.startsWith('detached@');
}

/**
 * Does a plan's `- **Checkout:** <branch>` bullet mean *detach at the trunk*?
 *
 * Three spellings, and only three: `main`, `master`, and the word `default`.
 * The bullet is free text a person writes, so it is trimmed, unbackticked and
 * lower-cased first — but it is NOT pattern-matched further. A plan naming any
 * other branch is documenting which branch it means, and the console acts on
 * nothing it was not clearly told.
 *
 * 🔴 The repository's ACTUAL default branch is asked of git (`defaultBranchOf`),
 * never of this function. This one answers "did the plan ask to leave the run
 * branch", which is a different question from "what is the trunk called here" —
 * a fork whose trunk is `develop` still writes `default` in its plan.
 * @param {unknown} value
 * @returns {boolean}
 */
export function wantsDefaultCheckout(value) {
  const word = String(value ?? '')
    .trim()
    .replace(/[`*]/g, '')
    .toLowerCase();
  return word === 'main' || word === 'master' || word === 'default';
}

/**
 * The settle strategies a MULTI-REPOSITORY (mirror) run cannot take.
 *
 * `merge-queue` ends at ONE tree — a rebase against one upstream — and a
 * mirror run's work lives in N repositories. Rather than rebase some of the
 * work and strand the rest, the run refuses the strategy BY NAME at settle
 * time and the client disables the choice up front; one spelling here keeps
 * the two in agreement. `integration` left this set in 5.1 (many-plans-one-repo
 * phase 8): the staging tree exists once PER REPOSITORY (`stagingNames(home,
 * repoKey)`), so a mirror settles every mount into its own, deepest first.
 * @type {ReadonlySet<SettleStrategy>}
 */
export const SETTLE_UNSUPPORTED_MULTI = Object.freeze(new Set(/** @type {const} */ (['merge-queue'])));

/**
 * The repo-qualified spelling of a branch — `web-admin · pe/demo`.
 *
 * A mirror run's branch name exists once PER MOUNTED REPOSITORY, in unrelated
 * object databases that happen to share a ref name, so anything keyed by bare
 * branch names (the radar's pair keys, a claim's identity) would fold N facts
 * into one. One spelling, owned here, so the server's probe and any client
 * rendering agree byte-for-byte.
 * @param {string} repo Root-relative repository path, empty for the root itself.
 * @param {string} branch
 * @returns {string}
 */
export function qualifiedRef(repo, branch) {
  return repo ? `${repo} · ${branch}` : branch;
}

/* ------------------------------------------------------------------ *
 * Many plans in one repository (phase 2 — the words; phase 7 — the behaviour)
 * ------------------------------------------------------------------ */

/**
 * The per-phase `- **Isolation:**` words, which are NOT `ISOLATION_MODES`.
 *
 * A run is `queue` or `worktree`; a PHASE says `shared` or `worktree`, because
 * from a phase's side the question is "do I get a tree of my own or do I use
 * the run's", and `queue` is a statement about the run's scheduler that a
 * phase cannot make. `shared` maps to the run's own checkout. Keeping the two
 * lists apart is what stops a phase bullet reading as a scheduler setting.
 * @typedef {(typeof ISOLATION_DIRECTIVES)[number]} IsolationDirective
 */
export const ISOLATION_DIRECTIVES = Object.freeze(/** @type {const} */ (['shared', 'worktree']));

/**
 * Does a phase's directive ask for a checkout of its own?
 *
 * The question rather than the word, so no reader outside this file re-types
 * either member — `vocab-owners.test.ts` scans for exactly that, and it is
 * right to: a second spelling of this list is how a phase comes to be given a
 * lane by one reader and denied one by another.
 * @param {unknown} value
 * @returns {boolean}
 */
export function directiveIsolates(value) {
  return value === ISOLATION_DIRECTIVES[1];
}

/**
 * Decision 13: a run the console cuts a NEW branch for is isolated by default.
 *
 * It was `false`, which is why two plans on one repository could be admitted
 * into one checkout: a new branch is the console's own, nobody else is
 * standing on it, and a tree of its own costs a checkout and buys the whole
 * concurrency this plan is about. A run that ADOPTS an existing branch is not
 * covered by this — the operator may well be sitting in that tree.
 */
export const DEFAULT_ISOLATION_FOR_NEW_BRANCH = true;

/**
 * What becomes of a run's worktree when the run settles.
 *
 * `keep-on-failure` is the default and the only one that needs explaining: a
 * green run's tree holds nothing the branch does not, and a red one holds the
 * only copy of what went wrong. `prune` always removes, `keep` never does, and
 * `ttl:<h>` removes after that many hours — the one parameterised member,
 * which is why `retentionOf` exists rather than an `includes` test.
 * @typedef {(typeof WORKTREE_RETENTION)[number] | `ttl:${number}`} WorktreeRetention
 */
export const WORKTREE_RETENTION = Object.freeze(/** @type {const} */ (['prune', 'keep-on-failure', 'keep']));

/** The option table's default. */
export const DEFAULT_RETENTION = 'keep-on-failure';

/**
 * What each retention word is CALLED, decided once (phase 15) — the three
 * closed members; a `ttl:<h>` is read out as its hours by whoever renders it.
 * @type {Readonly<Record<(typeof WORKTREE_RETENTION)[number], string>>}
 */
export const RETENTION_LABELS = Object.freeze({
  prune: 'are removed',
  'keep-on-failure': 'are kept only if the run ended badly',
  keep: 'are kept',
});

/**
 * The hours in a `ttl:<h>`, or undefined for anything that is not one.
 *
 * Zero and negative are `undefined` rather than 0: `ttl:0` reads as "remove it
 * immediately", which is `prune` said obscurely, and a policy that deletes a
 * failed run's tree the instant it is written should have to say `prune`.
 */
export function retentionTtlHours(value) {
  const m = /^ttl:(\d+)$/.exec(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
  if (!m) return undefined;
  const hours = Number(m[1]);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/**
 * Coerce anything to a retention policy — a word, a readable `ttl:<h>`, else
 * the default. An unreadable ttl falls back rather than throwing, and falls
 * back to the DEFAULT rather than to `prune`: a typo must never be the reason
 * a tree was deleted.
 */
export function retentionOf(value) {
  const word = String(value ?? '')
    .trim()
    .toLowerCase();
  if (WORKTREE_RETENTION.includes(/** @type {never} */ (word))) return word;
  return retentionTtlHours(word) === undefined ? DEFAULT_RETENTION : word;
}

/**
 * How many ISOLATED runs the console may hold in ONE repository at once.
 *
 * Three, like the machine-wide worktree cap, and for a different reason: that
 * one bounds disk, this one bounds how much is happening in a repository a
 * person may have to read. Both apply; the narrower answers first.
 */
export const DEFAULT_MAX_PER_REPO = 3;

/**
 * The first token of a `git worktree lock --reason` this console wrote.
 *
 * A sweep must never take a tree somebody else locked — an operator's own
 * `git worktree lock`, another tool's — so "is this lock mine?" is asked of
 * the reason's first word and of nothing else. One token, because a reason
 * reads `phase-console <runId> p<N>` and the run id is not knowable to a
 * sweep scanning another console's trees.
 */
export const WORKTREE_LOCK_PREFIXES = Object.freeze(/** @type {const} */ (['phase-console']));

/**
 * Which of the console's three tree shapes a lock belongs to.
 *
 * The SECOND token of the reason, and it is there because the three are swept
 * by different rules: a lane is removed once it has landed, a run's own
 * checkout only after every lane of it has gone, and the staging tree is
 * console-wide and belongs to whichever settle is holding it this second.
 * A sweep that could not tell them apart would have to treat all three as the
 * most dangerous one.
 * @typedef {(typeof WORKTREE_LOCK_KINDS)[number]} WorktreeLockKind
 */
export const WORKTREE_LOCK_KINDS = Object.freeze(/** @type {const} */ (['run', 'lane', 'staging']));

/**
 * The `git worktree lock --reason` this console writes.
 *
 * `phase-console <kind> <slug>[ p<N>] <runId> <ISO>` — five or six tokens, the
 * first of which is `WORKTREE_LOCK_PREFIXES`'s only member. Every field earns
 * its place by being a question a sweep asks: the KIND decides which rule
 * applies, the RUN ID decides whether the holder is still alive (a sweep knows
 * the live run ids and nothing else about another console's trees), and the
 * TIMESTAMP is what makes a lock left by a machine that lost power readable as
 * old rather than merely mysterious. The slug and phase are for the person who
 * runs `git worktree list` and wants to know what took their tree.
 *
 * 🔴 It is a SENTENCE, not a data structure, because git stores it as one and
 * a person reads it in `git worktree list --porcelain`. Anything that has to
 * survive a round trip through git's own storage has to survive being read by
 * a human being too.
 * @param {{kind: WorktreeLockKind, slug: string, phase?: number, runId: string, at?: string}} opts
 * @returns {string}
 */
export function worktreeLockReason(opts) {
  const at = opts.at ?? new Date().toISOString();
  const phase = typeof opts.phase === 'number' ? ` p${opts.phase}` : '';
  return `${WORKTREE_LOCK_PREFIXES[0]} ${opts.kind} ${opts.slug}${phase} ${opts.runId} ${at}`;
}

/**
 * Did THIS console's software write that lock reason?
 *
 * Asked of the first token and of nothing else — the run id in the rest of it
 * is not knowable to a sweep scanning another console's trees, and a sweep
 * that demanded the whole grammar would refuse to clean up after a version of
 * itself that spelled the reason differently. Anything else is somebody's:
 * an operator's own `git worktree lock`, another tool's, a future spelling.
 * @param {string | undefined} reason
 * @returns {boolean}
 */
export function ourWorktreeLock(reason) {
  const first = String(reason ?? '')
    .trim()
    .split(/\s+/)[0];
  return WORKTREE_LOCK_PREFIXES.includes(/** @type {never} */ (first));
}

/**
 * Read a reason this console wrote back into its fields, or `null`.
 *
 * `null` for anything that is not ours AND for one of ours this version cannot
 * parse — the caller's two answers are "apply my rule" and "leave it alone",
 * and a half-read lock belongs in the second.
 * @param {string | undefined} reason
 * @returns {{kind: WorktreeLockKind, slug: string, phase?: number, runId: string, at: string} | null}
 */
export function parseWorktreeLockReason(reason) {
  if (!ourWorktreeLock(reason)) return null;
  const parts = String(reason).trim().split(/\s+/);
  const [, kind, slug, ...rest] = parts;
  if (!WORKTREE_LOCK_KINDS.includes(/** @type {never} */ (kind)) || !slug || rest.length < 2) return null;
  const phaseToken = /^p(\d+)$/.exec(rest[0] ?? '');
  const tail = phaseToken ? rest.slice(1) : rest;
  if (tail.length !== 2) return null;
  const [runId, at] = tail;
  return {
    kind: /** @type {WorktreeLockKind} */ (kind),
    slug,
    ...(phaseToken ? { phase: Number(phaseToken[1]) } : {}),
    runId,
    at,
  };
}
