/**
 * A lost mirror is rebuilt before the next boarding, and a session's own
 * checkout on the run branch never holds it (control-tower phase 90, #123).
 *
 * Measured on hub 4123 (observability-plane run 86103bfe79aa, P27): the run's
 * mirror was pruned while P27 was parked; the resumed session found no mirror,
 * made its own hand checkouts — one standing on `pe/observability-plane` — and
 * the next drive's rebuild was refused `branch-in-use` for that very tree, so
 * the run fell back to the shared checkout. The checkout was decided once per
 * drive, and every boarding after it trusted that answer.
 *
 *  - RB-1 a mirror lost while the run drives is rebuilt at the next boundary,
 *    BEFORE the next session boards — not only when a whole drive restarts;
 *  - RB-2 a hand checkout of THIS plan standing on the run branch is detached
 *    (its files and commits untouched) rather than refusing the run its
 *    isolation; somebody else's checkout is still never moved.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drive, git, harness, journal, superRoot } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

const SERVER = fileURLToPath(new URL('../server/', import.meta.url));

/* ------------------------------------------------------------------ RB-1 */

test('RB-1 — a mirror lost mid-run is rebuilt before the next phase boards', async () => {
  const { root } = superRoot();
  const seen: { phase: number; cwd: string; web: boolean; api: boolean }[] = [];
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    const cwd = String(request.cwd);
    seen.push({ phase, cwd, web: existsSync(join(cwd, 'web', 'index.html')), api: existsSync(join(cwd, 'api', 'api.txt')) });
    if (phase === 1) {
      // Something takes the whole mirror while phase 1 works — an older
      // console's sweep, or a person tidying `.worktrees`.
      for (const rel of ['web', 'api']) git(join(root, rel), 'worktree', 'remove', '--force', join(cwd, rel));
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  const state = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(seen.length, 2, `both phases boarded: ${JSON.stringify(seen)}`);
  assert.equal(seen[0]!.web, true);
  const second = seen[1]!;
  assert.equal(second.phase, 2);
  assert.equal(second.cwd, String(state.workRoot), 'phase 2 boarded in the run\'s own checkout');
  assert.equal(second.web && second.api, true, 'phase 2 boarded into a mirror that was not there');
  assert.equal(state.checkout, 'worktree');
  const rebuilt = journal(root, 'run.checkout-rebuilt');
  assert.equal(rebuilt.length, 1);
});

test('RB-1 — a recovery asks the checkout before it boards, exactly as a fill does', () => {
  const control = readFileSync(join(SERVER, 'runner/runner-control.ts'), 'utf8');
  const at = control.indexOf('private async runRecovery(');
  assert.ok(at > 0);
  const head = control.slice(at, control.indexOf('let grant', at));
  assert.match(head, /if \(!\(await this\.checkoutBeforeBoarding\(\)\)\) return;/,
    'runRecovery boards a session without asking whether its checkout stands');
  const loop = readFileSync(join(SERVER, 'runner/runner-loop.ts'), 'utf8');
  assert.match(loop, /protected override async checkoutBeforeBoarding\(\): Promise<boolean>/);
});

/* ------------------------------------------------------------------ RB-2 */

test('RB-2 — a hand checkout of this plan on the run branch is detached, never left holding it', async () => {
  const { root } = superRoot();
  // The session's own checkout of `web`, on the run branch, with work in it.
  const hand = join(root, '.worktrees', 'hand', 'demo', 'p27', 'web');
  mkdirSync(dirname(hand), { recursive: true });
  git(join(root, 'web'), 'worktree', 'add', '-q', '-b', 'pe/demo', hand);
  writeFileSync(join(hand, 'notes.txt'), 'the session\'s own notes\n');
  const head = git(hand, 'rev-parse', 'HEAD');

  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] });
  const state = await drive(h, { onlyPhases: [1] });
  assert.equal(state.checkout, 'worktree', `isolation refused: ${String(state.isolationRefusal)} ${String((state.halt as { reason?: string } | null)?.reason ?? '')}`);
  assert.equal(h.requests[0]?.cwd, String(state.workRoot));
  assert.equal(git(join(String(state.workRoot), 'web'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo');

  // The hand tree still stands, detached at the same commit, its work intact.
  assert.equal(git(hand, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'the hand tree still holds the branch');
  assert.equal(git(hand, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(hand, 'notes.txt'), 'utf8'), 'the session\'s own notes\n');
  const reclaimed = journal(root, 'run.isolation-reclaimed').map((line) => line.data as Record<string, unknown>);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.detached, true);
  assert.equal(reclaimed[0]!.tree, git(hand, 'rev-parse', '--show-toplevel'));
});

test('RB-2 — another plan\'s hand checkout on that branch name is still never touched', async () => {
  const { root } = superRoot();
  const hand = join(root, '.worktrees', 'hand', 'other-plan', 'p3', 'web');
  mkdirSync(dirname(hand), { recursive: true });
  git(join(root, 'web'), 'worktree', 'add', '-q', '-b', 'pe/demo', hand);
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] });
  const state = await drive(h, { onlyPhases: [1] });
  assert.equal(state.status, 'parked', 'a foreign tree on the branch parks the run with the refusal');
  assert.equal(state.isolationRefusal, 'branch-in-use');
  assert.equal(git(hand, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/demo', 'somebody else\'s tree was moved');
  assert.equal(h.requests.length, 0);
});
