/**
 * A shared-checkout run's branch hold is narrowed to what it protects, and a
 * waiter behind one has a way out (control-tower phase 90, #150).
 *
 * Measured on hub 4123: shop-frontend (a shared-checkout
 * `new-branch` run) held `trade` on its branch for its whole life, and any
 * other plan's phase whose scope reached `trade` waited — the hub ROOT's name
 * reaches every submodule. observability-plane P28 waited 10 h 51 min;
 * vca-refactor's closeout P11 (`vendor-commissioner-app, hub`) waited
 * open-ended behind 13 remaining phases; tamagui-upgrade was gated behind it.
 * Pausing the holder changed nothing, a resume could not mint isolation, and
 * no verb offered a way out.
 *
 *  - BH-1 the root's own name reaches only the root repository for a branch
 *    hold; a token naming the held repository (or `all`) still reaches it;
 *  - BH-2 the runner's admission probe (`treeWatch`) answers the same way, so a
 *    hub-root phase is disjoint from a submodule on another run's branch;
 *  - BH-3 the two escapes: `isolate-phase` releases a waiter at the next scan,
 *    and `isolateAtBoundary` switches a shared run to its own checkout at its
 *    next boundary;
 *  - BH-4 the queue names the holder RUN, its phases left and its plan's ETA,
 *    beside those escape actions.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Scheduler } from '../server/runner/scheduler.ts';
import type { AdmitRequest } from '../server/runner/scheduler.ts';
import { branchHoldNow, type TreeHold } from '../server/runner/tree-state.ts';
import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

/** `web` standing on another run's branch, and that run's hold record. */
function heldWeb(root: string): TreeHold[] {
  git(join(root, 'web'), 'switch', '-q', '-c', 'pe/shop-frontend');
  return [{
    run: 'r-trade', slug: 'shop-frontend', owner: 'autopilot/r-trade',
    repo: realpathSync(join(root, 'web')), rel: 'web', root: realpathSync(root),
    branch: 'pe/shop-frontend', at: new Date().toISOString(),
  }];
}

/* ------------------------------------------------------------------ BH-1 */

test('BH-1 — the root\'s own name no longer reaches a submodule held on another run\'s branch', () => {
  const { root } = superRoot();
  const holds = heldWeb(root);
  const me = { run: 'r-vca', slug: 'vca' };
  const claim = { branch: 'pe/vca', tree: realpathSync(root) };
  const hub = basename(root);
  assert.equal(branchHoldNow(root, [hub], holds, me, claim), null,
    'a hub-root phase waits on a submodule it never stages');
  assert.equal(branchHoldNow(root, [hub, 'api'], holds, me, claim), null, 'nor with an unheld submodule beside it');
  // Phase 40's admission stands for everything that names the held repository.
  assert.equal(branchHoldNow(root, ['web'], holds, me, claim)?.run, 'r-trade');
  assert.equal(branchHoldNow(root, [hub, 'web'], holds, me, claim)?.run, 'r-trade');
  assert.equal(branchHoldNow(root, ['all'], holds, me, claim)?.run, 'r-trade', '`all` still reaches everything');
});

/* ------------------------------------------------------------------ BH-2 */

type Probe = { hold: () => unknown; arm: (poke: () => void) => void; stop: () => void } | null;
type Internals = {
  treeWatch(phase: number, scope: string[], claim: { branch?: string; tree?: string }): Probe;
  state: Record<string, unknown>;
};

test('BH-2 — the admission probe of a shared run holds a hub-root phase for nothing, a submodule phase as before', async () => {
  const { root } = superRoot();
  const holds = heldWeb(root);
  const h = harness(root, { 1: 'api', 2: 'api' }, { planScope: () => ['api'], treeHolds: () => holds }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2], isolation: 'queue' });
  assert.equal(first.checkout, 'shared');
  const internals = h.runner as unknown as Internals;
  const claim = { branch: 'pe/demo', tree: realpathSync(root) };
  assert.equal(internals.treeWatch(2, [basename(root)], claim)?.hold(), null, 'the hub-root phase is held');
  const web = internals.treeWatch(2, ['web'], claim);
  assert.equal((web?.hold() as { run?: string } | null)?.run, 'r-trade');
  web?.stop();
});

/* ------------------------------------------------------------------ BH-3 */

test('BH-3 — isolate-phase releases a waiter held by a run-long hold, at the next scan', async () => {
  const { root } = superRoot();
  const holds = heldWeb(root);
  const h = harness(root, { 1: 'api', 2: 'web' }, { planScope: () => ['api', 'web'], treeHolds: () => holds }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  await drive(h, { onlyPhases: [1, 2], isolation: 'queue' });
  const internals = h.runner as unknown as Internals & { isolatePhase(phase: number, by?: string): boolean };
  const probe = internals.treeWatch(2, ['web'], { branch: 'pe/demo', tree: realpathSync(root) });
  assert.equal((probe?.hold() as { run?: string } | null)?.run, 'r-trade', 'phase 2 waits on the run-long hold');
  assert.equal(internals.isolatePhase(2, 'sam'), true);
  assert.equal(probe?.hold(), null, 'the waiting entry\'s probe still holds after isolate-phase');
  assert.equal(internals.treeWatch(2, ['web'], { branch: 'pe/demo', tree: realpathSync(root) }), null,
    'a fresh admission of an isolated phase is not held either');
  assert.deepEqual(internals.state.isolatePhases, [2]);
  assert.equal(journal(root, 'phase.isolate-requested').length, 1);
  probe?.stop();
});

test('BH-3 — a shared run switched to isolation boards its next phase in its own checkout', async () => {
  const { root } = superRoot();
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'] }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2], isolation: 'queue' });
  assert.equal(first.checkout, 'shared');
  assert.equal(h.requests[0]!.cwd, root);
  const runner = h.runner as unknown as { isolateAtBoundary(by?: string): boolean };
  assert.equal(runner.isolateAtBoundary('sam'), true);

  const second = await drive(h, { resumeRunId: String(first.id), onlyPhases: [2] });
  assert.equal(second.checkout, 'worktree', 'the switch at the boundary did not take');
  assert.equal(second.isolateAtBoundary, undefined, 'the ask is spent by the boundary that applied it');
  const phase2 = h.requests.find((q) => /BOOT phase 2\b/.test(q.prompt));
  assert.equal(phase2?.cwd, second.workRoot, 'phase 2 boarded in its own checkout');
  const switched = journal(root, 'run.isolation-switched');
  assert.equal(switched.length, 1);
  assert.equal((switched[0]!.data as Record<string, unknown>).by, 'sam');
});

/* ------------------------------------------------------------------ BH-4 */

test('BH-4 — the queue names the holder run, its phases left and ETA, beside the two escapes', async () => {
  const scheduler = new Scheduler({
    max: 4, locks: () => [],
    etaFor: (_slug: string, phase: number | null) => (phase == null
      ? { of: 'plan', label: 'plan remaining ~20 h–1.8 d of work', remainingWeight: 780, remainingPhases: 13 }
      : undefined),
  });
  const controller = new AbortController();
  const waiting = scheduler.admit({
    slug: 'vca', phase: 11, runId: 'r-vca', scope: ['vendor-commissioner-app', 'trade'], kind: 'phase',
    branch: 'pe/vca', tree: '/hub',
    branchHold: () => ({ repo: 'trade', dir: '/hub/trade', branch: 'pe/shop-frontend', run: 'r-trade', slug: 'shop-frontend' }),
    signal: controller.signal,
  } as AdmitRequest).catch(() => null);
  await until(() => scheduler.snapshot().entries.length > 0, 'the entry to queue');
  const entry = scheduler.snapshot().entries[0] as unknown as { waitingOn: Record<string, unknown>[] };
  const holder = entry.waitingOn.find((h) => h.kind === 'branch')!;
  assert.ok(holder, 'no branch holder on the queue');
  assert.deepEqual(holder.holderRun, { run: 'r-trade', slug: 'shop-frontend', remainingPhases: 13 });
  assert.match(String((holder.eta as { label?: string }).label), /plan remaining/);
  const escapes = holder.escapes as { verb: string; endpoint: string; body?: Record<string, unknown> }[];
  assert.deepEqual(escapes.map((e) => e.verb), ['isolate-phase', 'isolate']);
  assert.equal(escapes[0]!.endpoint, '/api/run/vca/isolate-phase');
  assert.deepEqual(escapes[0]!.body, { phase: 11 });
  assert.equal(escapes[1]!.endpoint, '/api/run/vca/isolate');
  controller.abort();
  await waiting;
});
