/**
 * A refused isolation PARKS; it never becomes a silent shared claimant
 * (control-tower phase 90, #123 #139).
 *
 * Measured on hub 4123 (observability-plane run 86103bfe79aa, P27 then P28):
 * the mirror's rebuild was refused (`branch-in-use`, then `worktree-failed`),
 * `refuse()` set `checkout: 'refused'`, and `admissionClaim` then gave the
 * phase the shared checkout's token — so a release phase that never needed the
 * shared tree queued behind another plan's run-long branch hold for hours,
 * and the only action the inbox offered was "Drop isolation".
 *
 *  - RI-1 a run that asked for its own checkout and is refused PARKS with a
 *    halt naming the refusal and its fix; nothing boards in the shared tree;
 *    a person's Repair checkout press moves the content aside and the run
 *    continues in its own checkout;
 *  - RI-2 the inbox row and the run card name the refusal and its fix, and
 *    the row's first action is the repair — never only "Drop isolation".
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInbox } from '../server/inbox.ts';
import { ISOLATION_PARKS, REFUSAL_FIX, REFUSAL_REASON } from '../server/runner/worktree.ts';
import { HALT_KINDS, RUN_HALT_KINDS } from '../shared/recovery-model.js';
import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

const CLIENT = fileURLToPath(new URL('../client/src/', import.meta.url));

/** Drive phase 1 into a mirror and pause there, as `sweep-keeps-resumable` does. */
async function pausedInMirror() {
  const { base, root } = superRoot();
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(first.status, 'paused');
  await until(() => journal(root, 'run.worktrees-kept').length > 0, 'the loop end to keep the trees');
  return { base, root, h, first, workRoot: String(first.workRoot) };
}

/* ------------------------------------------------------------------ RI-1 */

test('RI-1 — a refused isolation parks with its refusal and fix, and nothing boards in the shared tree', async () => {
  const { base, root, h, first, workRoot } = await pausedInMirror();
  // A session's clone at the `web` mount, holding work it never committed.
  git(join(root, 'web'), 'worktree', 'remove', '--force', join(workRoot, 'web'));
  git(base, 'clone', '-q', join(base, 'web-src'), join(workRoot, 'web'));
  writeFileSync(join(workRoot, 'web', 'wip.txt'), 'half done\n');
  const before = h.requests.length;

  const second = await drive(h, { resumeRunId: String(first.id), onlyPhases: [2] });
  assert.equal(second.status, 'parked', 'the refused run must park, not degrade');
  assert.equal(h.requests.length, before, 'a phase boarded in the shared checkout');
  const halt = second.halt as { kind?: string; reason?: string } | null;
  assert.equal(halt?.kind, 'isolation-refused');
  assert.match(String(halt?.reason), /mount-occupied/);
  assert.match(String(halt?.reason), /web holds a standalone clone/);
  assert.match(String(halt?.reason), /wip\.txt/);
  assert.match(String(halt?.reason), /Repair checkout/);
  assert.equal(second.checkout, 'refused');
  assert.equal(readFileSync(join(workRoot, 'web', 'wip.txt'), 'utf8'), 'half done\n', 'nothing was moved without a word');
  assert.equal(journal(root, 'run.parked').length, 1);

  // The Repair checkout press: a person's word rides the resume.
  const third = await drive(h, { resumeRunId: String(first.id), onlyPhases: [2], repairCheckout: { by: 'sam' } });
  assert.equal(third.checkout, 'worktree', `repair refused: ${String((third.halt as { reason?: string } | null)?.reason)}`);
  const phase2 = h.requests.find((q) => /BOOT phase 2\b/.test(q.prompt));
  assert.equal(phase2?.cwd, workRoot, 'phase 2 boarded in its own, rebuilt, checkout');
  const moved = journal(root, 'run.mount-quarantined').map((line) => line.data as Record<string, unknown>);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.confirmed, true);
  assert.equal(moved[0]!.by, 'sam');
  assert.equal(readFileSync(join(String(moved[0]!.to), 'wip.txt'), 'utf8'), 'half done\n', 'the work survives in stale-mounts/');
  assert.equal(third.repairCheckout, undefined, 'the press is spent by the decision it was pressed for');
});

test('RI-1 — a refusal at the first drive parks too (the cap), before any phase boards', async () => {
  const { root } = superRoot();
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'], isolatedCheckouts: () => 99 });
  const state = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(state.status, 'parked');
  assert.equal(h.requests.length, 0, 'the capped run boarded into the shared checkout');
  const halt = state.halt as { kind?: string; reason?: string } | null;
  assert.equal(halt?.kind, 'isolation-refused');
  assert.match(String(halt?.reason), /cap-reached/);
  assert.ok(String(halt?.reason).includes(REFUSAL_FIX['cap-reached']), 'the fix rides the halt');
});

test('RI-1 — the halt kind is a RUN-level word, and every refusal has a fix', () => {
  assert.ok((HALT_KINDS as readonly string[]).includes('isolation-refused'));
  assert.ok((RUN_HALT_KINDS as readonly string[]).includes('isolation-refused'));
  for (const refusal of Object.keys(REFUSAL_REASON)) {
    assert.ok((REFUSAL_FIX as Record<string, string>)[refusal], `${refusal} has no fix sentence`);
  }
});

/* ------------------------------------------------------------------ RI-2 */

test('RI-2 — the inbox row names the refusal and the fix, and offers the repair first', () => {
  const view = buildInbox({
    git: [{
      slug: 'demo', isolation: 'worktree', checkout: 'refused', isolationRefusal: 'mount-occupied',
      refusalReason: REFUSAL_REASON['mount-occupied'], refusalFix: REFUSAL_FIX['mount-occupied'],
      refusalDetail: 'web holds a standalone clone (on main; uncommitted: wip.txt)', parked: true,
    }],
    flags: { allowRun: true },
  } as never);
  const row = view.items.find((item) => item.kind === 'conflict' && item.slug === 'demo' && /own checkout/.test(item.title));
  assert.ok(row, 'no isolation row');
  assert.match(row!.title, /mount-occupied/);
  assert.match(row!.title, /parked/);
  assert.match(row!.need, /web holds a standalone clone/);
  assert.ok(row!.how.includes(REFUSAL_FIX['mount-occupied']));
  const verbs = (row!.actions ?? []).map((action) => action.verb);
  assert.deepEqual(verbs, ['repair-checkout', 'serialize'], 'Repair checkout first, Drop isolation second');
  const repair = row!.actions![0]!;
  assert.equal(repair.label, 'Repair checkout');
  assert.equal(repair.endpoint, '/api/run/demo/repair-checkout');
  assert.equal(repair.method, 'POST');

  // A STRUCTURAL refusal runs shared (the ruling beside ISOLATION_PARKS): the
  // row still names it — never silent — and offers no repair, because none exists.
  const shared = buildInbox({
    git: [{ slug: 'hub', isolation: 'worktree', checkout: 'refused', isolationRefusal: 'scope-outside-root',
      refusalReason: REFUSAL_REASON['scope-outside-root'], refusalFix: REFUSAL_FIX['scope-outside-root'] }],
    flags: { allowRun: true },
  } as never).items.find((item) => item.kind === 'conflict' && item.slug === 'hub');
  assert.ok(shared);
  assert.doesNotMatch(shared!.title, /parked/);
  assert.match(shared!.need, /shares the console's checkout/);
  assert.deepEqual((shared!.actions ?? []).map((action) => action.verb), ['serialize']);
});

test('RI-1 — only the refusals a person can fix park; the structural ones keep the visible shared fallback', () => {
  assert.deepEqual([...ISOLATION_PARKS].sort(), ['branch-in-use', 'cap-reached', 'mount-occupied', 'setup-failed', 'worktree-failed']);
});

test('RI-2 — the run card says the run is parked, with the refusal and its fix', () => {
  const card = readFileSync(join(CLIENT, 'features/runs/git-card.tsx'), 'utf8');
  assert.match(card, /run\?\.halt\?\.kind === 'isolation-refused'/, 'the card tells a parked refusal from a shared one');
  assert.match(card, /refusalFixes/);
  assert.match(card, /parked/);
  const state = readFileSync(join(CLIENT, 'lib/api/state.ts'), 'utf8');
  assert.match(state, /refusalFixes\?: Record<string, string>/);
  assert.equal(existsSync(join(CLIENT, 'features/runs/git-card.test.tsx')), true);
});
