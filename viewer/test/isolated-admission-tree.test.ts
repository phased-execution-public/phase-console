/**
 * An isolated run presents its OWN tree on every admission path
 * (control-tower phase 90, #149).
 *
 * Measured on hub 4123 (observability-plane run 86103bfe79aa, P28): the same
 * phase, same scope, was admitted past shop-frontend's `trade/shop-backend`
 * grant three times by the S12 carve-out (both branch and tree differ). The
 * fourth admission — the automatic resume after its watch landed — queued
 * behind that grant: with no lane yet and no `workRoot`, `treeFor` answered
 * the SHARED root, which is the tree every shared-checkout run presents.
 *
 *  - IA-1 `treeFor` never falls back to the shared root for an isolated run:
 *    with a lane, without one, and with `workRoot` lost, the claim is the same;
 *  - IA-2 `phase.queued` and `phase.admitted` journal the tree and branch the
 *    admission used, so a missing carve-out is diagnosable from the journal;
 *  - IA-3 the carve-out decides the same way for the same phase whatever path
 *    asked — a foreign grant on another branch in another tree is carved past
 *    whether or not `workRoot` is on the record.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Scheduler } from '../server/runner/scheduler.ts';
import type { AdmitRequest } from '../server/runner/scheduler.ts';
import { SHARED_CHECKOUT_TOKEN } from '../shared/scope.js';
import { drive, git, harness, journal, superRoot, until } from './lane-harness.ts';

for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_LOCK_MIRROR']) delete process.env[key];

type Claim = { scope: string[]; admitScope: string[]; branch?: string; tree?: string };
type Internals = { admissionClaim(phase: number): Promise<Claim>; state: Record<string, unknown> };

async function pausedIsolated(deps: Record<string, unknown> = {}) {
  const { root } = superRoot();
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'], ...deps }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  const first = await drive(h, { onlyPhases: [1, 2] });
  assert.equal(first.status, 'paused');
  assert.equal(first.checkout, 'worktree');
  await until(() => journal(root, 'run.worktrees-kept').length > 0, 'the loop end');
  return { root, h, first, own: realpathSync(String(first.workRoot)) };
}

/* ------------------------------------------------------------------ IA-1 */

test('IA-1 — an isolated run claims its own tree with no lane, and with workRoot lost', async () => {
  const { root, h, own } = await pausedIsolated();
  const internals = h.runner as unknown as Internals;

  const recorded = await internals.admissionClaim(2);
  assert.equal(recorded.tree, own);
  assert.equal(recorded.branch, 'pe/demo');

  // The #149 shape: an admission path reached with no lane and no `workRoot`.
  delete internals.state.workRoot;
  const lost = await internals.admissionClaim(2);
  assert.equal(lost.tree, own, `the claim fell back to the shared root (${String(lost.tree)} vs ${realpathSync(root)})`);
  assert.notEqual(lost.tree, realpathSync(root));
  assert.equal(lost.branch, 'pe/demo');
  assert.ok(!lost.admitScope.includes(SHARED_CHECKOUT_TOKEN), 'an isolated run took the shared checkout\'s token');
  assert.deepEqual(lost.admitScope, recorded.admitScope);
});

/* ------------------------------------------------------------------ IA-2 */

test('IA-2 — phase.queued and phase.admitted journal the tree and branch the admission used', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const { root } = superRoot();
  let foreign: ReturnType<Scheduler['admit']> | null = null;
  const h = harness(root, { 1: 'web', 2: 'web' }, { planScope: () => ['web', 'api'], scheduler });
  // Another run holds `web` in THIS run's own tree on this run's branch — the
  // one shape no carve-out may walk past — so phase 1 queues, then boards.
  const own = (): string => realpathSync(String((h.runner.current() as { workRoot?: string } | null)?.workRoot ?? root));
  // The claim is taken at the admission's own first question. Taken on a 50 ms
  // poll of `workRoot` instead, it lost the race whenever the run went from its
  // checkout to its admission inside one tick — and phase 1 never queued.
  const wouldBlock = scheduler.wouldBlock.bind(scheduler);
  scheduler.wouldBlock = (request: AdmitRequest) => {
    if (!foreign && request.slug === 'demo' && request.phase === 1) {
      assert.ok(h.runner.current()?.workRoot, 'the run asks for admission before it took its checkout');
      foreign = scheduler.admit({
        slug: 'other', phase: 9, runId: 'r-other', scope: ['web'], branch: 'pe/demo', tree: own(), kind: 'phase',
      } as AdmitRequest);
    }
    return wouldBlock(request);
  };
  const holding = (async () => {
    try {
      await until(() => journal(root, 'phase.queued').length > 0, 'phase 1 to queue');
    } finally {
      // Released whatever happened, so a red here fails the test, never hangs it.
      if (foreign) scheduler.release(await foreign);
    }
  })();
  await drive(h, { onlyPhases: [1] });
  await holding;
  const queued = journal(root, 'phase.queued').map((line) => line.data as Record<string, unknown>);
  const admitted = journal(root, 'phase.admitted').map((line) => line.data as Record<string, unknown>);
  assert.ok(queued.length >= 1, 'phase 1 never queued');
  assert.equal(queued[0]!.tree, own());
  assert.equal(queued[0]!.branch, 'pe/demo');
  assert.ok(admitted.length >= 1);
  assert.equal(admitted.at(-1)!.tree, own());
  assert.equal(admitted.at(-1)!.branch, 'pe/demo');
});

/* ------------------------------------------------------------------ IA-3 */

test('IA-3 — the carve-out decides the same way for the same phase whatever path asked', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const { root, h, own } = await pausedIsolated({ scheduler });
  // shop-frontend's shape: a SHARED-checkout run's grant on the same scope,
  // on its own branch, in the shared root.
  const foreign = await scheduler.admit({
    slug: 'other', phase: 66, runId: 'r-other', scope: ['web'], branch: 'pe/other', tree: realpathSync(root), kind: 'phase',
  } as AdmitRequest);
  assert.ok(foreign);
  const internals = h.runner as unknown as Internals;
  const asked = async (): Promise<string[]> => {
    const claim = await internals.admissionClaim(2);
    const request = {
      slug: 'demo', phase: 2, runId: String(internals.state.id), scope: claim.admitScope, kind: 'phase',
      ...(claim.branch ? { branch: claim.branch } : {}), ...(claim.tree ? { tree: claim.tree } : {}),
    } as AdmitRequest;
    return scheduler.carvedFor(request).map((holder) => `${holder.slug}/${holder.phase}`);
  };
  // Boarding: the record names its checkout.
  const boarding = await asked();
  assert.deepEqual(boarding, ['other/66'], 'the boarding admission is not carved past the foreign grant');
  // The automatic resume after a watch lands, a recovery, a retry: no lane
  // yet, and — the #149 shape — no `workRoot` on the record.
  delete internals.state.workRoot;
  assert.deepEqual(await asked(), boarding, 'the resume path decided differently from the boarding');
  assert.equal(realpathSync(own), own);
  scheduler.release(foreign);
});

/* ------------------------------------------------------------------ IA-4 */

/**
 * #149's comment of 2026-09-26T19:13Z, the other way round: a RESUMED
 * shared-checkout run (tamagui-upgrade, a default-branch run) queued with
 * `branch: null` behind observability-plane P25's `all` grant in P25's own
 * worktree, while its sibling shared run — which states `pe/<slug>` — was
 * carved past the same grant. A default-branch run commits on whatever its
 * checkout stands on, so its claim now says that branch.
 */
async function pausedShared(standOn: Record<string, string>, scopes: Record<number, string[]>) {
  const { root } = superRoot();
  for (const [rel, branch] of Object.entries(standOn)) git(join(root, rel), 'switch', '-q', '-c', branch);
  const repos = Object.fromEntries(Object.entries(scopes).map(([phase, scope]) => [phase, scope.join(',')]));
  const phaseScope = (_slug: string, phase: number) => scopes[phase] ?? ['web'];
  const h = harness(root, repos, { phaseScope }, (request, runner) => {
    if (/BOOT phase 1\b/.test(request.prompt)) runner.pause();
  });
  await h.runner.start({ slug: 'demo', root: h.root, onlyPhases: [1, 2] } as never);
  await h.runner.wait();
  const state = h.runner.current() as unknown as Record<string, unknown>;
  assert.equal(state.status, 'paused');
  assert.equal(state.gitMode, undefined, 'the fixture must be a default-branch run');
  return { root, internals: h.runner as unknown as Internals };
}

test('IA-4 — a default-branch shared run claims the branch its checkout stands on, and is carved like its sibling', async () => {
  const { root, internals } = await pausedShared({ web: 'feature/tamagui' }, { 1: ['web'], 2: ['web'] });
  const claim = await internals.admissionClaim(2);
  assert.equal(claim.tree, realpathSync(root), 'a shared run\'s tree is the shared root');
  assert.equal(claim.branch, 'feature/tamagui', 'the claim does not name the branch its checkout stands on');

  // observability-plane P25's shape: an `all` grant in a worktree of its own.
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'p90-ia4-')));
  const foreign = await scheduler.admit({
    slug: 'observability', phase: 25, runId: 'r-obs', scope: ['all'], branch: 'pe/observability', tree: elsewhere, kind: 'phase',
  } as AdmitRequest);
  assert.ok(foreign);
  const request = {
    slug: 'demo', phase: 2, runId: String(internals.state.id), scope: claim.admitScope, kind: 'phase',
    ...(claim.branch ? { branch: claim.branch } : {}), ...(claim.tree ? { tree: claim.tree } : {}),
  } as AdmitRequest;
  assert.deepEqual(scheduler.wouldBlock(request), [], 'the standing branch did not carve the claim past a grant in another tree');
  assert.deepEqual(scheduler.carvedFor(request).map((holder) => `${holder.slug}/${holder.phase}`), ['observability/25']);
  scheduler.release(foreign!);
  scheduler.close();
});

test('IA-4 — no single standing branch, no branch: repositories that disagree, a detached one, or `all`', async () => {
  const split = await pausedShared({ web: 'feature/tamagui' }, { 1: ['web'], 2: ['web', 'api'] });
  const internals = split.internals;
  // `api` still stands on `main`: one branch name cannot describe both.
  assert.equal((await internals.admissionClaim(2)).branch, undefined);
  git(join(split.root, 'api'), 'switch', '-q', '-c', 'feature/tamagui');
  assert.equal((await internals.admissionClaim(2)).branch, 'feature/tamagui', 'read at each ask, not once');
  git(join(split.root, 'api'), 'switch', '-q', '--detach');
  assert.equal((await internals.admissionClaim(2)).branch, undefined, 'a detached repository names no branch');

  const every = await pausedShared({ web: 'feature/tamagui' }, { 1: ['all'], 2: ['all'] });
  assert.equal((await every.internals.admissionClaim(2)).branch, undefined, '`all` reaches every repository');
});

/* ------------------------------------------------------------------ IA-5 */

test('IA-5 — the queue names the undeclared dimension when it is the whole reason a claim collides', () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const request = (over: Partial<AdmitRequest>): AdmitRequest =>
    ({ slug: 'tamagui', phase: 4, runId: 'r-tam', scope: ['web'], kind: 'phase', ...over }) as AdmitRequest;
  const grant = (over: Partial<AdmitRequest>) => scheduler.admit(
    { slug: 'observability', phase: 25, runId: 'r-obs', scope: ['all'], kind: 'phase', ...over } as AdmitRequest,
  );
  return (async () => {
    const isolated = await grant({ branch: 'pe/observability', tree: '/w/state/86103bfe79aa/integration' });

    // This claim declares no branch: the comment's own words.
    const [held] = scheduler.wouldBlock(request({ tree: '/w/hub' }));
    assert.ok(held);
    assert.deepEqual(held!.unqualified, {
      claim: 'this', missing: ['branch'],
      reason: 'blocked: this claim declares no branch, so the carve-out cannot apply',
    });
    // Declared and different in both dimensions: carved, nothing to explain.
    assert.deepEqual(scheduler.wouldBlock(request({ branch: 'main', tree: '/w/hub' })), []);
    // The same branch, or the same ground: no declaration changes that.
    const [sameBranch] = scheduler.wouldBlock(request({ branch: 'pe/observability', tree: '/w/hub' }));
    assert.equal(sameBranch!.unqualified, undefined);
    const [sameTree] = scheduler.wouldBlock(request({ tree: '/w/state/86103bfe79aa/integration/web' }));
    assert.equal(sameTree!.unqualified, undefined, 'a tree on the holder\'s ground collides whatever branch it names');

    // …and the queue itself carries it while the entry waits.
    const waiting = scheduler.admit(request({ tree: '/w/hub' }));
    await new Promise((resolve) => { setImmediate(resolve); }); // `admit` scans a microtask later
    const entry = scheduler.snapshot().entries.find((e) => e.slug === 'tamagui');
    assert.ok(entry);
    assert.equal(entry!.waitingOn[0]?.unqualified?.reason, 'blocked: this claim declares no branch, so the carve-out cannot apply');
    scheduler.release(isolated!);
    const first = await waiting;
    if (first) scheduler.release(first);

    // The HOLDER's missing dimension is named as the holder's — a claim of
    // its own, both dimensions stated, waiting on one that said less.
    const bare = await grant({ branch: 'pe/observability' });
    const [theirs] = scheduler.wouldBlock(request({ branch: 'main', tree: '/w/hub' }));
    assert.deepEqual(theirs!.unqualified, {
      claim: 'holder', missing: ['tree'],
      reason: 'blocked: observability phase 25\'s claim declares no tree, so the carve-out cannot apply',
    });
    // Neither claim a checkout of its own (the shared-checkout world): the
    // carve-out was never in play, and no sentence claims it was.
    const [neither] = scheduler.wouldBlock(request({ tree: '/w/hub' }));
    assert.equal(neither!.unqualified, undefined);
    const [legacy] = scheduler.wouldBlock(request({}));
    assert.equal(legacy!.unqualified, undefined);
    scheduler.release(bare!);
    scheduler.close();
  })();
});
