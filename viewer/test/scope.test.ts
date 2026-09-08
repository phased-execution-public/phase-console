/**
 * What a phase touches — the reading that decides whether two sessions may run.
 *
 * Two things are being pinned down here. The first is that a Repos cell written
 * by a human parses into the tokens a human meant: backticks, bold, parenthetical
 * asides and `+` separators all appear in real plans, and none of them are part
 * of a repository's name.
 *
 * The second is the shape of the intersection rule, and it matters more. Every
 * ambiguous case has to resolve toward *collides*: a false conflict costs one
 * session's parallelism, a missed one lets two sessions write the same tree.
 * The one place that is deliberately NOT conservative is the segment boundary —
 * `api` and `api-gateway` are different repositories, and a rule that called
 * them the same would serialise unrelated work forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseScope, normalizeToken, tokensIntersect, scopesIntersect, scopeOfRow, formatScope,
  intersectingTokens, claimsDisjoint,
} = await import('../shared/scope.js');

test('a plain cell reads as its repos', () => {
  assert.deepEqual(parseScope('api-server, web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server'), ['api-server']);
});

test('the separators plans actually use all separate', () => {
  assert.deepEqual(parseScope('api-server + web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server+web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server and web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server, web-app + docs'), ['api-server', 'web-app', 'docs']);
});

test('markdown around a name is not part of the name', () => {
  assert.deepEqual(parseScope('`api-server`'), ['api-server']);
  assert.deepEqual(parseScope('**web-app**'), ['web-app']);
  assert.deepEqual(parseScope('`api-server`, **web-app**'), ['api-server', 'web-app']);
});

test('a parenthetical aside is an aside, not a second repo', () => {
  // The `+` inside the parentheses would otherwise invent a repo called "web".
  assert.deepEqual(parseScope('api-server (+web snapshot)'), ['api-server']);
  assert.deepEqual(parseScope('api-server (Lambda), web-app (Vercel)'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api(-contracts), web-app'), ['api', 'web-app']);
  // An unclosed parenthetical still comes off — plans do write them.
  assert.deepEqual(parseScope('api-server (deploy only'), ['api-server']);
});

test('a cell that is nothing but an aside declares nothing', () => {
  assert.deepEqual(parseScope('(verification)'), []);
  assert.deepEqual(parseScope('—'), []);
  assert.deepEqual(parseScope(''), []);
});

test('a slash is a path, not a separator', () => {
  // The whole reason paths survive: `packages/cart-api` is one thing to lock.
  assert.deepEqual(parseScope('packages/cart-api'), ['packages/cart-api']);
  assert.deepEqual(parseScope('packages/cart-api, packages/web-app'),
    ['packages/cart-api', 'packages/web-app']);
});

test('whitespace inside a cell separates, so a two-word repo stays reachable', () => {
  // `docs-repo docs` must keep intersecting a plain `docs-repo` — same tree.
  assert.deepEqual(parseScope('docs-repo docs'), ['docs-repo', 'docs']);
  assert.equal(scopesIntersect(parseScope('docs-repo docs'), ['docs-repo']), true);
});

test('repeats collapse and order is kept', () => {
  assert.deepEqual(parseScope('api-server, api-server, web-app'), ['api-server', 'web-app']);
});

test('noise never becomes a token', () => {
  assert.equal(normalizeToken('#'), '');
  assert.equal(normalizeToken('×3'), '');      // one usable character is not a repo
  assert.equal(normalizeToken('a'), '');
  assert.equal(normalizeToken('-'), '');
  assert.equal(normalizeToken('x'.repeat(65)), '');
  assert.equal(normalizeToken('~/.config/skills'), 'config/skills');
  assert.equal(normalizeToken('  API-Server  '), 'api-server');
  assert.equal(normalizeToken('a//b'), 'a/b');
});

test('the wildcard survives as `all`', () => {
  assert.equal(normalizeToken('*'), 'all');
  assert.deepEqual(parseScope('*'), ['all']);
});

test('saying nothing means it might touch anything', () => {
  // The conservative default. "Declared no repos" must never read as
  // "collides with nothing" — that is the one mistake that corrupts a tree.
  assert.deepEqual(scopeOfRow(''), ['all']);
  assert.deepEqual(scopeOfRow('   '), ['all']);
  assert.deepEqual(scopeOfRow('(verification)'), ['all']);
  assert.deepEqual(scopeOfRow('api-server'), ['api-server']);
});

test('`all` touches everything', () => {
  assert.equal(tokensIntersect('all', 'api-server'), true);
  assert.equal(tokensIntersect('api-server', 'all'), true);
  assert.equal(tokensIntersect('all', 'all'), true);
  assert.equal(scopesIntersect(['all'], ['web-app']), true);
  assert.equal(scopesIntersect(scopeOfRow(''), ['web-app']), true);
});

test('equal tokens collide, different ones do not', () => {
  assert.equal(tokensIntersect('api-server', 'api-server'), true);
  assert.equal(tokensIntersect('api-server', 'web-app'), false);
});

test('a path prefix collides with what is under it', () => {
  assert.equal(tokensIntersect('packages', 'packages/cart-api'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages/cart-api/src'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages/web-app'), false);
});

test('the prefix is segment-wise — neighbouring names are not nested', () => {
  // The case a naive startsWith gets wrong, and the reason this is a rule and
  // not a one-liner: these are two separate repositories.
  assert.equal(tokensIntersect('api', 'api-gateway'), false);
  assert.equal(tokensIntersect('api-gateway', 'api'), false);
  assert.equal(tokensIntersect('web', 'web-app'), false);
});

test('two scopes collide when any pair of their tokens does', () => {
  assert.equal(scopesIntersect(['api-server', 'docs'], ['web-app', 'docs']), true);
  assert.equal(scopesIntersect(['api-server'], ['web-app']), false);
  assert.equal(scopesIntersect(['packages'], ['packages/cart-api']), true);
});

test('an unknown scope is treated as a collision', () => {
  assert.equal(scopesIntersect([], ['web-app']), true);
  assert.equal(scopesIntersect(['api-server'], []), true);
});

test('scopesIntersect accepts raw cells as well as token lists', () => {
  assert.equal(scopesIntersect('api-server, docs', 'docs'), true);
  assert.equal(scopesIntersect('api-server', '`web-app`'), false);
});

test('formatScope round-trips through parseScope', () => {
  const csv = formatScope(parseScope('`api-server` (Lambda), web-app + docs'));
  assert.equal(csv, 'api-server,web-app,docs');
  assert.deepEqual(parseScope(csv), ['api-server', 'web-app', 'docs']);
  assert.equal(formatScope('api-server, web-app'), 'api-server,web-app');
});

test('a conflict can name the tokens that caused it', () => {
  // A message that says "held by X" and not which repo collided sends the
  // reader back to the plan to work it out. Say it in the message.
  assert.deepEqual(intersectingTokens(['api-server', 'docs'], ['docs', 'web-app']), ['docs']);
  assert.deepEqual(intersectingTokens(['packages'], ['packages/cart-api']),
    ['packages~packages/cart-api']);
  assert.deepEqual(intersectingTokens(['api-server'], ['web-app']), []);
});

/* ------------------------------------------------------------------ *
 * Claim qualification — the one narrowing allowed on top of scope,
 * decided on TWO dimensions: the branch and the working tree.
 *
 * THE TABLE below is the contract, and it is deliberately duplicated
 * case-for-case in `tests/unit/lock-scope.bats` (§claim qualification).
 * Two languages decide this — `claimsDisjoint` here, `claim_disjoint`
 * in scripts/scope.sh — and a rule that lives in two places is a rule
 * that drifts unless the same cases are green in both. If you add a
 * row here, add it there in the same commit.
 * ------------------------------------------------------------------ */

/** [branch A, tree A, branch B, tree B, disjoint?, why] — mirrored in lock-scope.bats. */
const CLAIM_TABLE: [unknown, unknown, unknown, unknown, boolean, string][] = [
  ['pe/a', '/w/a', 'pe/b', '/w/b', true,
    'both dimensions qualified and different — the carve worktree isolation exists for'],
  ['pe/a', '/w/a', 'pe/a', '/w/b', false,
    'the same branch is the same work, however many trees'],
  ['pe/a', '/w/a', 'pe/b', '/w/a', false,
    'one directory is one directory, whatever its refs are called'],
  ['pe/a', '/w/a', 'pe/b', '', false, 'the lock never said which tree — it may be editing ours'],
  ['pe/a', '', 'pe/b', '/w/b', false, 'we never said which tree — we may be editing theirs'],
  ['pe/a', '/w/a', '', '/w/b', false, 'the lock never said which branch — it may be riding ours'],
  ['', '/w/a', 'pe/b', '/w/b', false, 'we never said which branch — we may be riding theirs'],
  ['', '', '', '', false, 'neither said anything: unqualified collides with everything'],
  ['pe/a', '/w/a', '  pe/a  ', '/w/b', false, 'whitespace is not a different branch'],
  ['pe/a', '/w/a', 'pe/b', '  /w/a  ', false, 'whitespace is not a different tree either'],
  ['pe/a', '/w/a', 'pe/b', '/w/a/', false, 'a trailing slash is spelling, not geography'],
  ['pe/a', '/w/a', 'pe/b', '/w/a//', false, '…and so are two of them, in both languages (P1 QA F4)'],
  ['pe/a', '/w/a', 'pe/b', '/w/a/nested', false, 'a tree inside another tree is the same ground'],
  ['pe/a', '/w/a-b', 'pe/b', '/w/a', true, 'tree nesting is segment-wise: /w/a-b is not inside /w/a'],
  ['main', '/w/a', 'pe/main', '/w/b', true, 'branches do NOT nest segment-wise the way trees do'],
  ['pe/a', '/w/a', 'PE/A', '/w/b', true, 'refs are case-sensitive; two spellings are two branches'],
  // The DETACHED spelling (`shared/worktree-model.js` §`detachedRef`). A
  // detached checkout has no branch NAME, and an unqualified claim collides
  // with everything, so the shape would have been useless with the field
  // empty; `detached@<sha12>` contends with nobody holding a real ref. It
  // gets ONE rule of its own: an EQUAL pair is not "the same work" the way an
  // equal ref is — a ref is where two trees' commits would land on top of
  // each other, and a detached HEAD has none — so it falls through to the
  // tree test (console-parallel-repaint P1, W3; P6 serialised it).
  ['detached@abc123def456', '/w/t1', 'pe/x', '/w/t2', true,
    'a detached checkout owns no ref, so it contends with nobody holding one'],
  ['detached@abc123def456', '/w/t1', 'detached@abc123def456', '/w/t2', true,
    'two trees detached at the SAME commit share no ref — the tree dimension alone decides them'],
  ['detached@abc123def456', '/w/t1', 'detached@abc123def456', '/w/t1', false,
    '…and one tree detached at one commit is one tree'],
  ['detached@abc123def456', '/w/t1', 'detached@abc123def456', '/w/t1/nested', false,
    '…nested is the same ground for a detached pair too'],
  ['detached@abc123def456', '', 'detached@abc123def456', '/w/t2', false,
    'an equal detached pair with a tree unstated is unqualified, like any other'],
  ['detached@abc123def456', '/w/t1', 'detached@999999999999', '/w/t2', true,
    '…and at different commits they are not'],
];

test('claim qualification: the table both languages must agree on', () => {
  for (const [ab, at, bb, bt, expected, why] of CLAIM_TABLE) {
    const a = { branch: ab, tree: at };
    const b = { branch: bb, tree: bt };
    assert.equal(claimsDisjoint(a, b), expected, `${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${why}`);
    // Symmetric by construction — a rule that answered differently depending on
    // which side asked would let one of two sessions through and not the other.
    assert.equal(claimsDisjoint(b, a), expected, `symmetry: ${why}`);
  }
});

test('claim qualification: an absent dimension is unqualified, never disjoint', () => {
  // `undefined`/`null` reach this from a lock that has no `branch=` or
  // `worktree=` line at all (every lock written before the fields existed).
  // Absent must read as "collides", the same fail-safe direction as an absent
  // scope — in EITHER dimension, on EITHER side.
  assert.equal(claimsDisjoint(undefined, { branch: 'pe/b', tree: '/w/b' }), false);
  assert.equal(claimsDisjoint({ branch: 'pe/a', tree: '/w/a' }, undefined), false);
  assert.equal(claimsDisjoint({ branch: 'pe/a' }, { branch: 'pe/b', tree: '/w/b' }), false);
  assert.equal(claimsDisjoint({ tree: '/w/a' }, { branch: 'pe/b', tree: '/w/b' }), false);
  assert.equal(claimsDisjoint(null, null), false);
  assert.equal(claimsDisjoint({}, {}), false);
});

test('claim qualification narrows scope, it does not replace it', () => {
  // The two questions are asked in order and both must pass for two sessions to
  // run: scopes that do NOT intersect were already clear, and no qualification
  // makes an intersecting scope safe on its own. This test exists so a later
  // refactor that "simplifies" the pair into one call has something to fail
  // against.
  assert.equal(scopesIntersect(['app'], ['app']), true, 'same repo still intersects');
  assert.equal(
    claimsDisjoint({ branch: 'pe/a', tree: '/w/a' }, { branch: 'pe/b', tree: '/w/b' }), true,
    'and the qualified pair is what clears it');
  assert.equal(scopesIntersect(['app'], ['docs']), false, 'disjoint scopes never needed a branch');
});
