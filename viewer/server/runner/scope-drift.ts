/**
 * Which commits a `phase.scope-drift` line may credit to its phase
 * (control-tower phase 63, #88).
 *
 * 🔴 The probe compared each unscoped repository's HEAD before and after a
 * phase and credited EVERY new commit to it. It could not tell the phase's own
 * handoff from a lock commit, another plan's commits, or a person's: 79 drift
 * lines over one week on two consoles, ~29 of them nothing but other writers'
 * commits, and this plan's own journal carried one per phase — 54 lines, every
 * one a `phase-lock:` or a handoff commit. A detector that always fires is a
 * detector nobody reads, so the one line that would have meant something read
 * like the other fifty-three.
 *
 * A commit is credited only when all of these hold:
 *   1. it is not a `phase-lock:` commit — a lock's mirror, whoever made it;
 *   2. it is not another plan's — every path under another plan's
 *      `docs/handoffs/<slug>/` or its plan file;
 *   3. it left the DECLARED scope — the phase's Repos tokens plus its plan's
 *      part of the docs root: the per-slug token (`rootScopeToken`,
 *      `docs/handoffs/<slug>/` — handoffs, INDEX, locks, ledgers) and the
 *      plan's own documents (`docs/plans/<slug>.md` and its `<slug>-…`
 *      companions), which #88 names beside them as what every phase writes
 *      there. So the phase's own root writes are declared writes, not drift;
 *   4. it is OURS — on the lane's branch (the repository stands on it), or
 *      printed by the lane's own session (`[branch sha] subject`, which git
 *      prints for every commit it makes and the stream reader collects).
 * Rule 4 is the one that turns "somebody committed here while this phase ran"
 * into "this phase committed here". A commit neither signal can place is
 * nobody's the probe can name, and it says nothing — detection, not
 * containment, and a false line costs the reader more than a missed one.
 */
import { rootScopeToken, tokensIntersect } from '../../shared/scope.js';

/** Why a commit was, or was not, credited. `credited` is the only drift. */
export type DriftVerdict = 'credited' | 'phase-lock' | 'other-plan' | 'declared' | 'not-ours';

export interface DriftCommit {
  sha: string;
  subject: string;
  /** Repository-relative paths; absent or empty means unknown (a merge, a failed read). */
  paths?: readonly string[];
}

export interface DriftContext {
  /** The plan the lane runs. */
  slug: string;
  /** The phase's own Repos tokens — the root token is added here, never by the caller. */
  scope: readonly string[];
  /** Where the repository sits under the run root: `''` for the root itself. */
  rel: string;
  /** The repository stands on the lane's branch, so every new commit in it is on that branch. */
  onLaneBranch: boolean;
  /** The commits the lane's session printed, abbreviated or full. */
  sessionCommits: Iterable<string>;
}

/** The subject every lock commit carries — `phase-lock.sh`'s `_commit_lock`. */
export const PHASE_LOCK_SUBJECT = /^phase-lock: /;

/** The scope a phase DECLARES: its Repos tokens and its plan's root token. */
export function declaredScope(scope: readonly string[], slug: string): string[] {
  const token = rootScopeToken(slug);
  return token && !scope.includes(token) ? [...scope, token] : [...scope];
}

/**
 * The plan a root-relative docs path belongs to, or `''` — only the two shapes
 * that name a plan unambiguously: its handoff folder and its plan file.
 */
function planOfPath(path: string): string {
  const handoff = /^docs\/handoffs\/([^/]+)\//.exec(path);
  if (handoff) return handoff[1]!.toLowerCase();
  const plan = /^docs\/plans\/([^/]+)\.md$/.exec(path);
  return plan ? plan[1]!.toLowerCase() : '';
}

/**
 * Is a root-relative path one of THIS plan's documents? Its handoff folder, its
 * plan file, and the plan's companions (`<slug>-issues/`, `<slug>-ui-register.md`
 * …). A plan whose own slug begins `<slug>-` would read as a companion — the
 * safe direction, since it only ever withholds a line.
 */
function ownDoc(path: string, slug: string): boolean {
  if (!slug) return false;
  return path.startsWith(`docs/handoffs/${slug}/`) || path === `docs/plans/${slug}.md`
    || path.startsWith(`docs/plans/${slug}-`) || path.startsWith(`docs/plans/${slug}/`);
}

/** Two abbreviations of one commit agree on their common prefix (git's floor is 7). */
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function creditCommit(commit: DriftCommit, ctx: DriftContext): DriftVerdict {
  if (PHASE_LOCK_SUBJECT.test(commit.subject)) return 'phase-lock';
  const own = rootScopeToken(ctx.slug).slice('docs/handoffs/'.length);
  // Root-relative and folded, because the scope's tokens are: a submodule's
  // `x` path is `<rel>/x` to them.
  const paths = (commit.paths ?? []).map((path) => (ctx.rel ? `${ctx.rel}/${path}` : path).toLowerCase());
  if (paths.length) {
    if (paths.every((path) => planOfPath(path) !== '' && !ownDoc(path, own))) return 'other-plan';
    const declared = declaredScope(ctx.scope, ctx.slug);
    if (paths.every((path) => ownDoc(path, own) || declared.some((token) => tokensIntersect(token, path)))) {
      return 'declared';
    }
  }
  if (ctx.onLaneBranch) return 'credited';
  for (const sha of ctx.sessionCommits) if (sameCommit(sha, commit.sha)) return 'credited';
  return 'not-ours';
}

/** Every commit's verdict, the credited ones kept in order, the rest counted. */
export function creditDrift<T extends DriftCommit>(
  commits: readonly T[], ctx: DriftContext,
): { credited: T[]; excluded: Partial<Record<Exclude<DriftVerdict, 'credited'>, number>> } {
  const credited: T[] = [];
  const excluded: Partial<Record<Exclude<DriftVerdict, 'credited'>, number>> = {};
  for (const commit of commits) {
    const verdict = creditCommit(commit, ctx);
    if (verdict === 'credited') credited.push(commit);
    else excluded[verdict] = (excluded[verdict] ?? 0) + 1;
  }
  return { credited, excluded };
}

/**
 * The commits a session's own git printed — `[<branch> <sha>] <subject>` on a
 * commit, a cherry-pick, an amend; `[detached HEAD <sha>]` off a branch;
 * ` (root-commit)` on a repository's first. Read from the tool result's FULL
 * text, before the stream reader clips it for display: behind a hook's output
 * the line can sit well past the clip.
 */
const COMMIT_LINE = /^\[(?:detached HEAD|[^\s[\]]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] /gm;

export function printedCommits(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(COMMIT_LINE)) {
    const sha = match[1]!;
    if (!out.includes(sha)) out.push(sha);
  }
  return out;
}
