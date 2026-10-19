/**
 * Where a phase's work HAPPENS and where it LANDS — the words for both, in one
 * place, before either behaviour exists.
 *
 * Two questions that look separate and are not. A phase runs somewhere (the
 * run's own checkout, or a worktree of its own) and its commits end up
 * somewhere (nowhere, an integration branch, a pull request, the trunk). Today
 * the console answers the first and nothing answers the second: a phase
 * commits to `pe/<slug>` and a person merges it later, which is fine for one
 * plan on one repository and is exactly what this plan exists to stop being
 * true. Both answers are read off the plan, by the bash engine and by the
 * console, so both vocabularies live here with one bash twin.
 *
 * `scripts/landing.env` is that twin (the F5 pattern, like `gates.env`);
 * `viewer/test/gates-vocab.test.ts` asks bash for every list below and holds it
 * to these word for word, so the two can never disagree.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly, so it must stay free of anything either cannot resolve.
 * `test/vocab-owners.test.ts` registers every list: a second spelling of any of
 * them under `shared/`, `server/` or `client/src/` fails that scan.
 *
 * FREE, not Pro (decision 19). The landing ENGINE is Pro and arrives in phase
 * 8; the words are read by `phase-graph.sh`, which the free tree ships.
 */

/* ------------------------------------------------------------------ *
 * Landing
 * ------------------------------------------------------------------ */

/**
 * What happens to a phase's commits when the phase settles.
 *
 * `hold` — nothing. The branch stays where it is and a person merges it. This
 * is what the console does today, so it is the default: a plan that says
 * nothing must keep behaving the way its author watched it behave.
 * `integrate` — merged into the run's integration branch, locally, no remote.
 * `pr` — pushed and a pull request opened; the phase lands when it merges.
 * `trunk` — merged straight onto the base branch.
 * @typedef {(typeof LAND_POLICIES)[number]} LandPolicy
 */
export const LAND_POLICIES = Object.freeze(/** @type {const} */ (['hold', 'integrate', 'pr', 'trunk']));

/** What a plan that names no policy gets — today's behaviour, spelled out. */
export const DEFAULT_LAND = 'hold';

/**
 * What each landing policy is CALLED, decided once — the launch form's
 * picker, its review row and the run page's landing card (phase 15).
 * @type {Readonly<Record<LandPolicy, string>>}
 */
export const LAND_LABELS = Object.freeze({
  hold: 'Hold — leave the commits on the branch for a person to merge',
  integrate: 'Integrate — merge into the run’s staging checkout, locally',
  pr: 'Pull request — push the branch and open one; the phase lands when it merges',
  trunk: 'Trunk — merge straight onto the base branch',
});

/**
 * Coerce anything to a landing policy. Case and surrounding space are not a
 * different policy; everything else is the default rather than a guess — the
 * fail-safe direction, since `hold` is the one policy that writes nothing.
 * Mirrors `land_word` in `phase-graph.sh`.
 */
export function landPolicyOf(value) {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LAND_POLICIES.includes(/** @type {never} */ (word)) ? word : DEFAULT_LAND;
}

/**
 * Whether a superproject phase that lands also moves the gitlink. `bump` is
 * the default because a submodule commit nobody points at is a commit the
 * superproject cannot see — the failure this plan's own root has had to repair
 * by hand after every phase.
 * @typedef {(typeof GITLINK_POLICIES)[number]} GitlinkPolicy
 */
export const GITLINK_POLICIES = Object.freeze(/** @type {const} */ (['bump', 'leave']));

/** What a plan that says nothing gets. */
export const DEFAULT_GITLINK = 'bump';

/**
 * What to do when a landing cannot merge cleanly.
 *
 * `halt` — stop the run and tell a person, which is what happens today.
 * `park` — park this phase, keep driving the others; a person settles it later.
 * `rebase-session` — board a session whose whole job is the rebase.
 * @typedef {(typeof CONFLICT_POLICIES)[number]} ConflictPolicy
 */
export const CONFLICT_POLICIES = Object.freeze(/** @type {const} */ (['halt', 'park', 'rebase-session']));

/** Today's behaviour. */
export const DEFAULT_CONFLICT = 'halt';

/**
 * What each conflict policy is CALLED, decided once (phase 15).
 * @type {Readonly<Record<ConflictPolicy, string>>}
 */
export const CONFLICT_LABELS = Object.freeze({
  halt: 'Halt — stop the run and tell a person',
  park: 'Park — set this phase aside, keep driving the others',
  'rebase-session': 'Rebase session — the phase’s own session merges the run branch in, once',
});

/**
 * The two base-branch values that are WORDS rather than refs.
 *
 * Everything else in a `**Base branch:**` line is a git ref and is passed
 * through untouched — `main`, `release/5.1`, a sha. These two are named
 * because they are questions rather than answers: `origin/HEAD` is "whatever
 * the remote calls its default today" (the fresh cut, and the default), `head`
 * is "wherever this checkout is standing right now".
 */
export const BASE_BRANCH_WORDS = Object.freeze(/** @type {const} */ (['origin/HEAD', 'head']));

/** The fresh cut — a run branch taken from the remote's default. */
export const DEFAULT_BASE_BRANCH = 'origin/HEAD';

/* ------------------------------------------------------------------ *
 * The landing ledger
 * ------------------------------------------------------------------ */

/**
 * Where a phase's landing has got to, as `docs/handoffs/<slug>/landing.md`
 * records it and `scripts/phase-landing.sh` writes it.
 *
 * The states are a PATH, not a set of flags: `pushed → pr-open → pr-merged` is
 * the `pr` policy's whole journey, and a `landed N` gate asks whether the row
 * has reached the state its policy ends at. `conflict` and `failed` are
 * separate because they need different answers — a conflict is the
 * `CONFLICT_POLICIES` question, a failure is a retry.
 * @typedef {(typeof LANDING_STATES)[number]} LandingState
 */
export const LANDING_STATES = Object.freeze(
  /** @type {const} */ ([
    'held',
    'integrated',
    'pushed',
    'pr-open',
    'pr-merged',
    'landed',
    'conflict',
    'failed',
  ]),
);

/**
 * The state each policy ENDS at — what a `landed N` gate is asking about.
 *
 * `hold` ends at `held`, which is not a nothing: it is the ledger saying "this
 * phase was never going to land, and that is settled". Without it a `landed N`
 * gate on a held phase would wait for ever on a thing nobody intends to do.
 * @type {Readonly<Record<LandPolicy, LandingState>>}
 */
export const LANDED_BY_POLICY = Object.freeze({
  hold: 'held',
  integrate: 'integrated',
  pr: 'pr-merged',
  trunk: 'landed',
});

/**
 * The order a ledger row MOVES in (one-pool phase 21, #249 #240): a row only
 * moves forward along this path. The console's `hold` settle once wrote `held`
 * over a session's `pr-merged` and `landed` rows — seven true rows on hub then
 * read "held on the run branch", their SHA and PR gone — because the upsert
 * replaced whatever stood. `pr-merged` and `landed` rank alike — the `pr` and
 * `trunk` policies' end states — so either replaces the other. `conflict` and `failed` are off the path: either
 * may replace a row that has not merged, and neither replaces one in
 * `LANDING_SETTLED`, whose work is on its target whatever happens next.
 * `scripts/phase-landing.sh` and the engine's `landLocal` both refuse a move
 * back, through `landingMovesBack`; a deliberate one is `--allow-backward`.
 */
export const LANDING_ORDER = Object.freeze(
  /** @type {const} */ (['held', 'integrated', 'pushed', 'pr-open', 'pr-merged', 'landed']),
);

/** The states whose work is on its target: nothing but a deliberate move takes a row out of one. */
export const LANDING_SETTLED = Object.freeze(/** @type {const} */ (['pr-merged', 'landed']));

/**
 * Would writing `to` over a row that reads `from` move it BACK? Unknown words
 * never block (a row the ledger cannot read is not a position to defend).
 * @param {string | null | undefined} from
 * @param {string} to
 * @returns {boolean}
 */
export function landingMovesBack(from, to) {
  if (!from || from === to) return false;
  const order = /** @type {readonly string[]} */ (LANDING_ORDER);
  const settled = /** @type {readonly string[]} */ (LANDING_SETTLED);
  const at = order.indexOf(from);
  if (at < 0) return false;
  const next = order.indexOf(to);
  if (next < 0) return settled.includes(from);
  // `pr-merged` and `landed` end different policies' paths; neither is a
  // step on the other's, so either may replace the other.
  if (settled.includes(from) && settled.includes(to)) return false;
  return next < at;
}

/** The states a `pr-merged N` gate accepts — the question `gh pr view` answers. */
export const PR_MERGED_STATES = Object.freeze(/** @type {const} */ (['pr-merged']));

/* ------------------------------------------------------------------ *
 * The one argv that may ever reach a remote
 * ------------------------------------------------------------------ */

/**
 * The frozen literal every push this console will ever make begins with.
 *
 * `--porcelain` because the reply has to be PARSED and not read: phase 1's arm
 * G-4 measured it, and a fast-forward's flag is a SPACE, so the output is split
 * on tabs and never trimmed. `--no-follow-tags` because a push that carries
 * tags nobody asked for is a release nobody cut.
 *
 * It lives HERE and not beside the code that will run it (phase 8,
 * `runner/worktree.ts`), for a reason worth stating: `test/never-push.test.ts`
 * scans `viewer/server/` for argument-list literals, and an array beginning
 * `'push'` anywhere under that tree is an offence to five of its assertions —
 * including in the very declaration meant to constrain pushes. Under `shared/`
 * it is a vocabulary rather than a command, which is what it actually is, and
 * the scan stays a scan for the thing it is looking for.
 */
export const PUSH_ARGV = Object.freeze(/** @type {const} */ (['push', '--porcelain', '--no-follow-tags']));

/**
 * The head of the ONE fetch the console runs (one-pool phase 21, #370): the
 * landing proof refreshes `origin/<trunk>` before it compares a run branch
 * with it, because a mirror nobody fetched called a merged branch unlanded.
 * One remote (`origin`), one refspec (`+refs/heads/<trunk>:refs/remotes/origin/<trunk>`
 * — only the remote-tracking ref of the trunk moves), no tags, no FETCH_HEAD,
 * no submodules. Here and not beside its caller for `PUSH_ARGV`'s reason: the
 * scanner in `test/never-push.test.ts` holds the one argv to this head.
 */
export const PROOF_FETCH_ARGV = Object.freeze(
  /** @type {const} */ ([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--no-recurse-submodules',
  ]),
);

/** The columns of `landing.md`, in order — the ledger's shape, stated once. */
export const LANDING_COLUMNS = Object.freeze(
  /** @type {const} */ (['phase', 'repo', 'state', 'policy', 'ref', 'sha', 'pr', 'by', 'recorded', 'note']),
);
