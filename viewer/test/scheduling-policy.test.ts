/**
 * The scheduling policy is a choice, not an accident; plans share the console
 * fairly (control-tower phase 100, #135 C.11–13 and F.24–25; #128 asks 2–3).
 *
 * The scan was reserved → class → bump → arrival and nothing else. A phase two
 * siblings had declared themselves blocked on sat behind both of them, and a
 * phase whose red WIP was every sibling's base waited 4 h 44 min while four
 * siblings boarded onto its red (#128). One run with many ready phases filled
 * every slot it could reach (#135 C.13).
 *
 *   LP-3  three policies — `seniority` (the default), `blocker-first` and
 *         `critical-path` — chosen per console and per plan (the plan's word
 *         over the console's), set through `POST /api/queue/policy`, shown on
 *         `GET /api/queue`;
 *   LP-4  a policy promotes WITHIN a class, behind a pin and a bump:
 *         `blocker-first` puts a phase a sibling declared itself `blocked` on
 *         and a phase whose committed WIP is red ahead, and a red WIP's owner
 *         holds its siblings while it waits for a lane (their gate is its red);
 *         `critical-path` puts the plan's longest remaining chain first;
 *         `seniority` promotes nothing;
 *   LP-5  fair share: strict classes, and inside a class the plans take turns
 *         — a plan's next entry waits behind every other plan's that has had
 *         fewer turns, its live lanes counted as turns taken.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler } = await import('../server/runner/scheduler.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const {
  SCHEDULING_POLICIES, DEFAULT_SCHEDULING_POLICY, schedulingPolicy, QUEUE_ORDER_KEYS,
} = await import('../shared/orchestration-model.js');
const { queueOrderReason } = await import('../shared/queue-model.js');
import type { EngineResult } from '../server/engine.ts';
import type { LockView, Promotion } from '../server/runner/scheduler.ts';
import type { RunState } from '../server/runner/state.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const MIN = 60_000;

const lockOn = (scope: string): LockView => ({
  slug: 'other', phase: 9, owner: 'someone@laptop', expired: false, scope: [scope], leaseUntil: Date.now() + 60 * MIN,
});

async function settle(scheduler: InstanceType<typeof Scheduler>, n: number): Promise<void> {
  for (let i = 0; i < 40 && scheduler.snapshot().entries.length < n; i++) await tick();
  await tick();
}

const order = (scheduler: InstanceType<typeof Scheduler>): string[] =>
  [...scheduler.snapshot().entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => `${e.slug}:${e.phase}`);

const promo = (policy: string, rank: number, text: string, holdsSiblings = false): (() => Promotion) =>
  () => ({ policy, rank, text, ...(holdsSiblings ? { holdsSiblings: true } : {}) }) as Promotion;

/* ================================================================== *
 * LP-3 — three policies, per console and per plan
 * ================================================================== */

test('LP-3: the policies are seniority (the default), blocker-first and critical-path — anything else reads as the default', () => {
  assert.deepEqual([...SCHEDULING_POLICIES], ['seniority', 'blocker-first', 'critical-path']);
  assert.equal(DEFAULT_SCHEDULING_POLICY, 'seniority');
  assert.equal(schedulingPolicy('fifo'), 'seniority');
  assert.equal(schedulingPolicy('critical-path'), 'critical-path');
  assert.deepEqual([...QUEUE_ORDER_KEYS], ['dependency', 'reserved', 'class', 'pinned', 'bumped', 'policy', 'share', 'seniority'],
    'the policy and the fair-share turn are scan keys the queue page names — behind an operator\'s pin and bump');
});

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

type Captured = { status: number; body: Record<string, unknown> };

async function call(svc: unknown, method: 'GET' | 'POST', path: string, body: unknown = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

test('LP-3: a console chooses its policy and a plan may choose its own — the plan\'s word over the console\'s, on GET /api/queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-policy-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), '---\nslug: alpha\nstatus: active\n---\n\n# alpha\n\n## Phase graph\n\n| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |\n|---|---|---|---|---|---|\n| 1 | one | — | — | app | ok |\n', 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  try {
    assert.equal(svc.schedulingPolicyFor('alpha'), 'seniority', 'the default, until somebody chooses');
    const console = await call(svc, 'POST', '/api/queue/policy', { policy: 'blocker-first', reason: 'trade P43 waited 4 h on its own red' });
    assert.equal(console.status, 200, JSON.stringify(console.body));
    assert.equal(svc.schedulingPolicyFor('alpha'), 'blocker-first');
    assert.equal(svc.schedulingPolicyFor('beta'), 'blocker-first', 'the console\'s word is every plan\'s');

    assert.equal((await call(svc, 'POST', '/api/queue/policy', { policy: 'critical-path', slug: 'alpha' })).status, 200);
    assert.equal(svc.schedulingPolicyFor('alpha'), 'critical-path', 'a plan\'s own word wins for that plan');
    assert.equal(svc.schedulingPolicyFor('beta'), 'blocker-first');

    const read = await call(svc, 'GET', '/api/queue');
    assert.deepEqual(read.body.policy, { console: 'blocker-first', plans: { alpha: 'critical-path' }, default: 'seniority' });

    assert.equal((await call(svc, 'POST', '/api/queue/policy', { policy: null, slug: 'alpha' })).status, 200, 'a plan goes back to the console\'s');
    assert.equal(svc.schedulingPolicyFor('alpha'), 'blocker-first');
    assert.equal((await call(svc, 'POST', '/api/queue/policy', { policy: 'fifo' })).status, 400, 'an unknown policy is named, not stored');
  } finally {
    svc.close();
  }
});

/* ================================================================== *
 * LP-4 — a policy promotes within a class
 * ================================================================== */

test('LP-4: a promoted entry goes ahead of older ones in its class — never past a bump or a higher class', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [lockOn('app')] });
  const plain = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'aaaa', scope: ['app'] }); plain.catch(() => {});
  const blocker = scheduler.admit({ slug: 'beta', phase: 2, runId: 'bbbb', scope: ['app'], promotion: promo('blocker-first', 1, 'blocker-first — P7 declared itself blocked on it') }); blocker.catch(() => {});
  const red = scheduler.admit({ slug: 'gamma', phase: 3, runId: 'cccc', scope: ['app'], promotion: promo('blocker-first', 2, 'blocker-first — its committed WIP is red') }); red.catch(() => {});
  await settle(scheduler, 3);
  assert.deepEqual(order(scheduler), ['gamma:3', 'beta:2', 'alpha:1'], 'promoted first, the higher rank first');
  const top = scheduler.snapshot().entries.find((e) => e.slug === 'gamma')!;
  assert.equal(top.promotion?.policy, 'blocker-first', 'the entry carries the policy that moved it');
  assert.equal(queueOrderReason(top, { nowMs: Date.now() }).key, 'policy', 'and the view says it is the policy');

  const id = scheduler.snapshot().entries.find((e) => e.slug === 'alpha')!.id;
  scheduler.bump(id);
  assert.deepEqual(order(scheduler), ['alpha:1', 'gamma:3', 'beta:2'], 'an operator\'s bump outranks a policy');
  const urgent = scheduler.admit({ slug: 'delta', phase: 4, runId: 'dddd', scope: ['app'], priority: 'high' }); urgent.catch(() => {});
  await settle(scheduler, 4);
  assert.equal(order(scheduler)[0], 'delta:4', 'and the class outranks both: strict classes');
  scheduler.close();
});

test('LP-4: a red WIP\'s owner holds its siblings while it waits for a lane — another plan is not held', async () => {
  const scheduler = new Scheduler({ max: 4, locks: () => [lockOn('app')] });
  const owner = scheduler.admit({ slug: 'trade', phase: 43, runId: 'tttt', scope: ['app'], promotion: promo('blocker-first', 2, 'blocker-first — its committed WIP is red', true) }); owner.catch(() => {});
  const sibling = scheduler.admit({ slug: 'trade', phase: 50, runId: 'tttt', scope: ['docs'] }); sibling.catch(() => {});
  const foreign = scheduler.admit({ slug: 'vca', phase: 19, runId: 'vvvv', scope: ['docs'] });
  await settle(scheduler, 2);
  const held = scheduler.snapshot().entries.find((e) => e.phase === 50)!;
  assert.match(held.waitingOn[0]?.owner ?? '', /trade P43/, 'the sibling waits on its WIP owner, named');
  assert.equal(held.waitingOn[0]?.clock, true);
  const other = await foreign;
  assert.equal(other.slug, 'vca', 'another plan boards on the free scope');
  scheduler.release(other);
  scheduler.close();
});

class Probe extends Runner {
  installed(state: RunState): void {
    (this as unknown as { state: RunState }).state = state;
    (this as unknown as { driving: Promise<void> }).driving = Promise.resolve();
  }
  protected override async scopeFor(): Promise<string[]> { return ['app']; }
  protected override async script(): Promise<EngineResult> {
    return { stdout: 'free', stderr: '', code: 0 } as unknown as EngineResult;
  }
  promotion(phase: number): Promotion | null { return this.promotionOf(phase); }
}

function probe(policy: string, critical: number[] = []) {
  const state = newRun({ slug: 'demo', root: '/tmp/demo' });
  const runner = new Probe({
    scriptsDir: '/nonexistent', scheduler: new Scheduler({ max: 4 }),
    schedulingPolicy: () => policy as never,
    criticalPath: () => critical,
  } as never);
  runner.installed(state);
  return { state, runner };
}

test('LP-4: blocker-first promotes the phase a sibling declared itself blocked on, and the owner of a red WIP — seniority promotes nothing', () => {
  const { state, runner } = probe('blocker-first');
  phaseRecord(state, 5).wipRed = { sha: 'abc1234', files: ['src/cart.ts'], at: new Date().toISOString() };
  phaseRecord(state, 7).declared = { status: 'blocked', watch: ['phase:demo/6'], reason: 'P6 owns the schema', at: new Date().toISOString() } as never;
  phaseRecord(state, 8).declared = { status: 'blocked', watch: ['lock:demo/6'], at: new Date().toISOString() } as never;

  const red = runner.promotion(5)!;
  assert.equal(red.policy, 'blocker-first');
  assert.equal(red.holdsSiblings, true, 'a red WIP holds its siblings: their gate is its red');
  assert.match(red.text, /committed WIP is red on the shared branch/);
  const named = runner.promotion(6)!;
  assert.match(named.text, /P7, P8 declared themselves blocked on it/);
  assert.equal(named.holdsSiblings ?? false, false);
  assert.equal(runner.promotion(9), null, 'nothing names P9');

  const quiet = probe('seniority');
  phaseRecord(quiet.state, 5).wipRed = { sha: 'abc1234', at: new Date().toISOString() };
  assert.equal(quiet.runner.promotion(5), null, 'the default policy promotes nothing in the cross-plan scan');
});

test('LP-4: critical-path promotes the plan\'s longest remaining chain, the phase furthest from its end first', () => {
  const { runner } = probe('critical-path', [6, 8, 9]);
  const head = runner.promotion(6)!;
  const next = runner.promotion(8)!;
  assert.equal(head.policy, 'critical-path');
  assert.ok(head.rank > next.rank, 'the phase furthest from the end ranks highest');
  assert.match(head.text, /critical path — 3 phases to the plan's end/);
  assert.equal(runner.promotion(5), null, 'off the path: no promotion');
});

/* ================================================================== *
 * LP-5 — fair share: strict classes, plans take turns inside one
 * ================================================================== */

test('LP-5: inside a class the plans take turns — one run with many ready phases cannot fill every slot', async () => {
  const scheduler = new Scheduler({ max: 8, locks: () => [lockOn('app')] });
  for (const phase of [1, 2, 3]) { const p = scheduler.admit({ slug: 'alpha', phase, runId: 'aaaa', scope: ['app'] }); p.catch(() => {}); }
  const b = scheduler.admit({ slug: 'beta', phase: 1, runId: 'bbbb', scope: ['app'] }); b.catch(() => {});
  await settle(scheduler, 4);
  assert.deepEqual(order(scheduler), ['alpha:1', 'beta:1', 'alpha:2', 'alpha:3'], 'beta\'s first entry takes the second turn, not the fourth');
  const second = scheduler.snapshot().entries.find((e) => e.slug === 'alpha' && e.phase === 2)!;
  assert.deepEqual(second.share, { round: 1, lanes: 0 });
  const why = queueOrderReason(second, { nowMs: Date.now() });
  assert.equal(why.key, 'share');
  assert.match(why.text, /fair share — 1 of its plan's entry is ahead of it|fair share — 1 of its plan's entries? (is|are) ahead of it/);
  scheduler.close();
});

test('LP-5: a plan holding lanes has taken its turns — a plan holding none goes first; classes stay strict', async () => {
  const scheduler = new Scheduler({ max: 8, locks: () => [lockOn('app')] });
  const live = await scheduler.admit({ slug: 'alpha', phase: 9, runId: 'aaaa', scope: ['docs'] });
  const a = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'aaaa', scope: ['app'] }); a.catch(() => {});
  const b = scheduler.admit({ slug: 'beta', phase: 1, runId: 'bbbb', scope: ['app'] }); b.catch(() => {});
  await settle(scheduler, 2);
  assert.deepEqual(order(scheduler), ['beta:1', 'alpha:1'], 'alpha already holds a lane');
  const high = scheduler.admit({ slug: 'gamma', phase: 1, runId: 'cccc', scope: ['app'], priority: 'low' }); high.catch(() => {});
  const urgent = scheduler.admit({ slug: 'alpha', phase: 2, runId: 'aaaa', scope: ['app'], priority: 'high' }); urgent.catch(() => {});
  await settle(scheduler, 4);
  assert.deepEqual(order(scheduler), ['alpha:2', 'beta:1', 'alpha:1', 'gamma:1'], 'a high entry goes first whatever its plan holds; a low one last');
  scheduler.release(live);
  scheduler.close();
});
