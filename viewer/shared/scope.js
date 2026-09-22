/**
 * What a phase touches, and whether two phases can run at the same time.
 *
 * The old rule was "one session at a time, always". It is a safe rule and a
 * wasteful one: two phases that touch different repositories have no way to
 * collide, and serialising them buys nothing. The rule that replaces it needs
 * to know what each phase touches — and the plan already says so, in the
 * **Repos** column of the Phase-graph table. That column is the SSOT; this
 * module is the one reading of it.
 *
 * Both sides of the system have to agree on that reading, or the doctrine is
 * decoration: `phase-lock.sh` decides in bash whether a claim collides, and the
 * console decides in JavaScript what to draw and what to admit. So the rules
 * here are deliberately small enough to reimplement in awk without drifting —
 * lowercase, a fixed character set, split on the separators plans actually use
 * — and `engine-parity.test.ts` holds the two readings against every real plan.
 *
 * Plain ESM with JSDoc rather than TypeScript because it is imported three
 * ways: by the server, by the Vite client, and directly by node's test runner.
 *
 * The intersection rule:
 *   - `all` (and `*`) touches everything — the conservative default for a
 *     phase that never said.
 *   - equal tokens intersect.
 *   - a token that is a *path prefix* of another intersects it, segment-wise:
 *     `packages` ∩ `packages/cart-api`. Segment-wise is the whole point —
 *     `api` ∩ `api-gateway` is disjoint, and a naive `startsWith` would have
 *     said otherwise and serialised two unrelated repos forever.
 *
 * Every ambiguity resolves toward *intersecting*. A false conflict costs
 * parallelism; a missed one lets two sessions write the same working tree.
 */

/** Characters a scope token may contain. Everything else is dropped. */
const ALLOWED = /[^a-z0-9._/-]+/g;

/**
 * Separators between tokens in a Repos cell.
 *
 * Whitespace is one of them, which is what lets `and` be handled as a *token*
 * below rather than as a `\band\b` alternation here. That is not a style
 * choice: awk has no `\b`, and the bash half has to split identically or the
 * two readings disagree the first time someone writes "api and web".
 */
const SEPARATORS = /[,+]|\s+/;

/** Shortest and longest a token may be. Below: noise like `1`. Above: prose. */
const MIN_LEN = 2;
const MAX_LEN = 64;

/**
 * One already-split token, normalised — or `''` if nothing usable is left.
 *
 * `parseScope` is the entry point for a whole cell; this handles a single token
 * and does not split, so callers must not hand it `"hub docs"`.
 */
/**
 * Fold `.` and `..` segments out of a token, segment-wise.
 *
 * A Repos cell is written by a person, and `packages/../docs` is a path a
 * person writes. Nothing folded it, so it stayed a token in its own right and
 * read as DISJOINT from `docs` — two sessions cleared into one working tree by
 * a spelling. Segment-wise on purpose: `..b` and `b..` are names, not climbs.
 * A `..` with nothing left to pop is dropped rather than kept, because a token
 * that climbs out of its own name says nothing about a repository.
 *
 * Mirrored by `fold_relative` in `scripts/scope.sh`.
 * @param {string} t
 * @returns {string}
 */
function foldRelative(t) {
  if (!t.includes('.')) return t; // the overwhelmingly common case, untouched
  const out = [];
  for (const seg of t.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

export function normalizeToken(raw) {
  let t = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (t === '*') return 'all'; // the wildcard survives as `all`
  if (t === 'and') return ''; // a conjunction between repos
  t = t.replace(ALLOWED, ''); // markdown, `#`, `~`, `×`, …
  t = t.replace(/\/{2,}/g, '/'); // `a//b` is `a/b`
  t = foldRelative(t); // `docs/../hub` is `hub`
  t = t.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  if (t.length < MIN_LEN || t.length > MAX_LEN) return '';
  return t;
}

/**
 * A Repos cell as scope tokens, in the order they appear, deduped.
 *
 * Parentheticals come off first: `api-server (+web snapshot)` is one repo, and
 * splitting on the `+` inside it would invent a second. Whitespace separates
 * too, so `docs-repo docs` reads as `docs-repo` and `docs` — that keeps it
 * intersecting with a plain `docs-repo`, which is the truth (same working tree)
 * and the safe direction. `/` never separates, so `packages/cart-api` survives
 * as the one path it is.
 */
export function parseScope(cell) {
  const stripped = String(cell ?? '').replace(/\([^)]*\)?/g, ' ');
  const out = [];
  for (const part of stripped.split(SEPARATORS)) {
    const token = normalizeToken(part);
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The scope of a Phase-graph row — `parseScope`, but never empty.
 *
 * A phase that declares no repos gets `['all']`: it might touch anything, so it
 * runs alone. Saying nothing must not read as "collides with nothing".
 */
export function scopeOfRow(cell) {
  const tokens = parseScope(cell);
  return tokens.length ? tokens : ['all'];
}

/** Do two single tokens overlap? See the intersection rule at the top. */
export function tokensIntersect(a, b) {
  if (!a || !b) return false;
  if (a === 'all' || b === 'all' || a === '*' || b === '*') return true;
  // Segment-wise prefix in both directions. The trailing `/` on both sides is
  // what makes it segment-wise: `aws-cdk/` does not start with `aws/`.
  return `${b}/`.startsWith(`${a}/`) || `${a}/`.startsWith(`${b}/`);
}

/** Do two scopes overlap — i.e. must these two phases be serialised? */
export function scopesIntersect(a, b) {
  const left = Array.isArray(a) ? a : parseScope(a);
  const right = Array.isArray(b) ? b : parseScope(b);
  if (!left.length || !right.length) return true; // unknown ⇒ assume collision
  return left.some((x) => right.some((y) => tokensIntersect(x, y)));
}

/**
 * Are two claims made disjoint by the BRANCH and the TREE each rides, despite
 * intersecting scopes?
 *
 * The rule, stated once here and once as `claim_disjoint` in
 * `scripts/scope.sh`: *both claims declare a branch AND the branches differ,
 * AND both declare a working tree AND the trees differ ⇒ disjoint; anything
 * else ⇒ collide* — with ONE reading of "the branches differ": two claims
 * spelled `detached@<sha12>` name no ref at all, so two of them at one commit
 * are decided by the tree dimension alone (see below). An unqualified claim —
 * either dimension missing on either side — collides with everything, exactly
 * like an unstated scope and for the same reason: a claim that never said
 * where its work rides may be riding yours.
 *
 * TWO dimensions, because either alone is a false witness:
 *
 *  - Branches alone carved out two sessions editing ONE shared checkout on
 *    different branches — same directory, same files, a working-tree race the
 *    ref names say nothing about. Live proof: a shared-checkout lane that
 *    self-declared `--branch` minted a lock a third run would have carved
 *    around, into the very tree it was editing.
 *  - Trees alone would carve out two checkouts of one repository on ONE
 *    branch, whose commits land on top of each other at the ref.
 *
 * Both differing is the case worktree isolation exists for: two trees, two
 * branches, commits that cannot meet. This NARROWS `scopesIntersect`; it never
 * replaces it, and the same slug+phase never carves whatever it declares.
 *
 * The tree is a PATH compared as a string — writers normalise (the console
 * records resolved paths; `--here` derives `pwd -P`) so a symlinked spelling
 * cannot fake a difference that is not there.
 *
 * Deliberately lock FIELDS rather than scope-token suffixes — `@` does not
 * survive `normalizeToken`, and bending the token grammar to carry a branch
 * would churn the whole engine-parity surface to express something orthogonal
 * to what a token means.
 *
 * 🔑 **A DETACHED checkout gets exactly one rule here, and it is a narrowing
 * of "the same branch is the same work".** A tree with no branch has no branch
 * NAME, and an unqualified claim collides with everything — so the detached
 * shape would have been useless if it left the field empty. It states
 * `detached@<sha12>` instead (`worktree-model.js` §`detachedRef`), which
 * contends with nobody holding a real ref because the strings never match.
 * Two detached claims at DIFFERENT commits differ as strings and carve as any
 * two branches do. Two at the SAME commit used to collide — "the same work,
 * however many trees" — and that sentence is true of a ref and false of a
 * detached HEAD: a ref is where two trees' commits would land on top of each
 * other, and a detached tree has none, so two of them at one commit in two
 * directories have nothing left to collide on but the directories. The rule
 * therefore lets an equal `detached@` pair fall through to the TREE test, which
 * still refuses the same tree and a nested one (console-parallel-repaint P1,
 * W3 — the serialisation P6 had accepted as a tradeoff). `sameUnitOfWork`
 * outranks all of this in the scheduler, so two runs of ONE plan never carve.
 * The CLAIM_TABLE rows in `test/scope.test.ts` and `tests/unit/lock-scope.bats`
 * pin every case.
 * @param {{ branch?: unknown, tree?: unknown } | null | undefined} a
 * @param {{ branch?: unknown, tree?: unknown } | null | undefined} b
 * @returns {boolean}
 */
export function claimsDisjoint(a, b) {
  const leftBranch = String(a?.branch ?? '').trim();
  const rightBranch = String(b?.branch ?? '').trim();
  const leftTree = String(a?.tree ?? '')
    .trim()
    .replace(/\/+$/, '');
  const rightTree = String(b?.tree ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!leftBranch || !rightBranch) return false; // unqualified ⇒ collides with everything
  if (!leftTree || !rightTree) return false; // …in either dimension
  // The same REF is the same work, however many trees. An equal `detached@`
  // pair is not a ref (see above): it goes on to the tree test below.
  if (leftBranch === rightBranch && !isDetachedSpelling(leftBranch)) return false;
  // A tree INSIDE another tree is the same ground: a claim naming a
  // subdirectory (a mirror's mount, a cwd-derived toplevel under a run's
  // workspace) must not read as a different place than the workspace itself.
  // Segment-wise, like the token rule: `/w/a-b` is not inside `/w/a`.
  if (sameGround(leftTree, rightTree)) return false;
  if (sameGround(rightTree, leftTree)) return false;
  return true;
}

/**
 * The console's own worktree home, as a path SEGMENT.
 *
 * `WORKTREES_DIR` in `server/runner/worktree.ts` is the definition; this is a
 * mirror, spelled out because this module imports nothing by design (it is
 * bundled, imported by node's test runner, and mirrored line-for-line in
 * `scripts/scope.sh`). Change one, change all three.
 */
const WORKTREE_HOME_SEGMENT = '.worktrees';

/**
 * Which REPOSITORY a working tree belongs to, as a key.
 *
 * Every tree the console makes lives under `<root>/.worktrees/`, so the root
 * is the prefix before that segment — the same boundary `sameGround` reads,
 * for the same reason, and spelled once here so the two cannot disagree. A
 * path with no such segment IS a repository checkout and keys to itself.
 *
 * 🔴 A MIRROR's mounts all key to the SUPERPROJECT, deliberately. The key
 * exists for the per-repository capacity cap, and the thing being counted is
 * runs: a mirror run is ONE run holding one set of trees, and counting its
 * mounts separately would let three mirror runs of a three-repository
 * superproject read as nine and cap a repository that holds three.
 *
 * @param {string | undefined} tree Absolute path of a working tree.
 * @returns {string} The repository key, or `''` for no tree at all.
 */
export function repoKeyOf(tree) {
  const path = String(tree ?? '').trim();
  if (!path) return '';
  const cut = Math.max(
    path.lastIndexOf(`/${WORKTREE_HOME_SEGMENT}/`),
    path.lastIndexOf(`\\${WORKTREE_HOME_SEGMENT}\\`),
  );
  return cut > 0 ? path.slice(0, cut) : path.replace(/[/\\]+$/, '');
}

/**
 * Is `inner` the same ground as `outer` — i.e. inside it, in the sense that
 * makes two claims contend?
 *
 * Plain containment was the whole test, and under `worktreeRoot: 'project'`
 * that is wrong in the one configuration that ships by default: the home is
 * `<root>/.worktrees/`, so EVERY tree the console makes is literally inside the
 * shared root, and a cap-refused shared run collided with all three isolated
 * runs beside it — while the same three runs under `worktreeRoot: 'state'`
 * carved cleanly. The same runs, a different answer, decided by a setting whose
 * entire job is to choose a location.
 *
 * So the home is a BOUNDARY, not a step down: crossing it, at any depth, means
 * the two paths are not the same ground. What is beyond the boundary still
 * nests normally — a mirror's submodule mount inside a run's tree is the same
 * ground and still collides — and the branch dimension still has to differ
 * before `claimsDisjoint` clears anything at all, so two claims on one ref are
 * unaffected.
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
function sameGround(outer, inner) {
  if (!`${inner}/`.startsWith(`${outer}/`)) return false;
  const rest = inner.slice(outer.length);
  return !`${rest}/`.includes(`/${WORKTREE_HOME_SEGMENT}/`);
}

/**
 * Is this branch spelling a detached checkout's qualification rather than a
 * ref? Spelled here as a plain prefix test — NOT imported from
 * `worktree-model.js` — because this module has no imports by design (it is
 * bundled, imported by node's test runner, and mirrored line-for-line in
 * `scripts/scope.sh`, whose `case "$b" in detached@*)` is this same test).
 * @param {string} branch
 * @returns {boolean}
 */
function isDetachedSpelling(branch) {
  return branch.startsWith('detached@');
}

/**
 * The token a SHARED-ROOT new-branch run adds to its own admission (S11-c).
 *
 * Not a repository, and never written to a lock file or shown to anybody — see
 * `formatScope`, which drops it. It exists because two such runs must
 * serialise and no dimension the vocabulary already has can say so: their
 * scopes may be disjoint (so they are never compared at all), their trees are
 * EQUAL (so the branch/tree pair carves nothing either way), and what actually
 * collides is the requirement that the one shared checkout stand on `pe/<slug>`
 * — two different branches in one directory. Every run that makes that demand
 * claims this token, so they meet; a run with a checkout of its own never asks
 * for it, and neither does one that commits on the branch it found.
 *
 * The name is chosen to survive `normalizeToken` UNCHANGED — a leading `.` is
 * folded out as a path segment, which would have made the constant and its own
 * normalised form two different strings — and to be one no repository would
 * carry. A directory that did carry it would merely serialise with these runs,
 * which is the safe direction.
 */
export const SHARED_CHECKOUT_TOKEN = 'pe--shared-checkout';

/**
 * The csv form written to a lock file and passed to `--scope`.
 *
 * Internal tokens are dropped: a lock file is read by people and by the bash
 * half, and neither has any use for a word that names no repository.
 */
export function formatScope(tokens) {
  const list = Array.isArray(tokens) ? tokens : parseScope(tokens);
  return list.filter((token) => token !== SHARED_CHECKOUT_TOKEN).join(',');
}

/** Which tokens of `a` and `b` actually collided — for saying *why* in a message. */
export function intersectingTokens(a, b) {
  const left = Array.isArray(a) ? a : parseScope(a);
  const right = Array.isArray(b) ? b : parseScope(b);
  const hits = [];
  for (const x of left) {
    for (const y of right) {
      if (!tokensIntersect(x, y)) continue;
      const label = x === y ? x : `${x}~${y}`;
      if (!hits.includes(label)) hits.push(label);
    }
  }
  return hits;
}
