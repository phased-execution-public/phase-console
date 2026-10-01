/**
 * A loaded machine admits nothing new (control-tower phase 100, #135 G.27).
 *
 * On 2026-09-25 the load average reached 81 on a 14-core machine: four plans'
 * verifications stacked on each other, timing tests flaked, and every flake
 * was a red someone had to re-run. Nothing on the server read the load.
 *
 *   LP-6  the guard is ON by default at 1.5 × the machine's cores over the
 *         5-minute average (`loadGuardFactor: 0` switches it off); above it
 *         every NEW admission waits on the `machine load` holder, which names
 *         the load, the threshold and the cores — a clock holder, never capped
 *         — while every live lane carries on; below it the next scan admits;
 *         the queue view shows the reading, and `POST /api/queue/policy`
 *         moves the factor.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler } = await import('../server/runner/scheduler.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { DEFAULT_LOAD_FACTOR, LOAD_HOLDER, loadGuardFactor, loadReading } = await import('../shared/orchestration-model.js');

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('LP-6: the guard is on by default at 1.5 × cores; 0 switches it off; anything unreadable is the default', () => {
  assert.equal(DEFAULT_LOAD_FACTOR, 1.5);
  assert.equal(loadGuardFactor({}), 1.5);
  assert.equal(loadGuardFactor(undefined), 1.5);
  assert.equal(loadGuardFactor({ loadGuardFactor: 2 }), 2);
  assert.equal(loadGuardFactor({ loadGuardFactor: 0 }), null, 'zero is off, like the start ceiling\'s limits');
  assert.equal(loadGuardFactor({ loadGuardFactor: 'lots' }), 1.5);
  assert.deepEqual(loadReading({ avg5: 22.4, cores: 14, factor: 1.5 }), { avg5: 22.4, cores: 14, factor: 1.5, threshold: 21, holding: true });
  assert.equal(loadReading({ avg5: 21, cores: 14, factor: 1.5 }).holding, false, 'AT the threshold is not over it');
  assert.equal(loadReading({ avg5: 99, cores: 14, factor: null }).holding, false, 'off holds nothing');
});

test('LP-6: above the threshold every NEW admission waits on the machine load, named; live lanes carry on; below it the next scan admits', async () => {
  let sample = { avg5: 3, cores: 14, factor: 1.5 as number | null };
  const scheduler = new Scheduler({ max: 4, load: () => sample });
  const live = await scheduler.admit({ slug: 'alpha', phase: 1, runId: 'aaaa', scope: ['app'] });

  sample = { avg5: 30.2, cores: 14, factor: 1.5 };
  const fresh = scheduler.admit({ slug: 'beta', phase: 2, runId: 'bbbb', scope: ['docs'] });
  for (let i = 0; i < 5; i++) await tick();
  const [entry] = scheduler.snapshot().entries;
  assert.ok(entry, 'the new admission waits');
  assert.equal(entry!.waitingOn[0]?.slug, LOAD_HOLDER);
  assert.match(entry!.waitingOn[0]!.owner, /5-min load 30\.2 over 21 \(1\.5 × 14 cores\)/);
  assert.equal(entry!.waitingOn[0]!.clock, true, 'a clock holder: the two-hour cap never parks a phase for the machine\'s load');
  assert.deepEqual(scheduler.snapshot().grants.map((g) => g.slug), ['alpha'], 'the live lane is untouched');
  assert.equal(scheduler.snapshot().load?.holding, true, 'the snapshot carries the reading');
  assert.equal(scheduler.wouldBlock({ slug: 'gamma', phase: 3, runId: 'cccc', scope: ['site'] })[0]?.slug, LOAD_HOLDER, 'asked before joining, the answer is the same');

  sample = { avg5: 12, cores: 14, factor: 1.5 };
  scheduler.poll();
  const grant = await fresh;
  assert.equal(grant.slug, 'beta', 'the load fell: the next scan admits');

  sample = { avg5: 99, cores: 14, factor: null };
  const off = await scheduler.admit({ slug: 'gamma', phase: 3, runId: 'cccc', scope: ['site'] });
  assert.equal(off.slug, 'gamma', 'switched off, the guard holds nothing');
  for (const g of [live, grant, off]) scheduler.release(g);
  scheduler.close();
});

test('LP-6: the console reads this machine\'s load against its cores, shows it on the queue, and the factor moves through the policy route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-load-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  try {
    const reading = svc.loadGuard();
    assert.equal(reading.factor, 1.5, 'on by default');
    assert.equal(reading.cores, availableParallelism());
    assert.equal(reading.threshold, Math.round(1.5 * availableParallelism() * 100) / 100);

    const { handleApi } = await import('../server/api/routes.ts');
    const call = async (method: 'GET' | 'POST', path: string, body: unknown = {}) => {
      const out = { status: 0, body: {} as Record<string, unknown> };
      const payload = JSON.stringify(body);
      const req = {
        method, headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
        socket: { remoteAddress: '127.0.0.1' }, on() { return this; },
        [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
      };
      const res = {
        req, writeHead(status: number) { out.status = status; return this; },
        end(chunk: unknown) { try { out.body = JSON.parse(String(chunk ?? '')); } catch { out.body = {}; } },
        setHeader() { return this; }, on() { return this; },
      };
      await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
      return out;
    };
    const queue = await call('GET', '/api/queue');
    const load = queue.body.load as { factor: number; cores: number; threshold: number; holding: boolean };
    assert.equal(load.factor, 1.5, 'the queue page shows the guard and this machine\'s reading');
    assert.equal(load.cores, availableParallelism());

    assert.equal((await call('POST', '/api/queue/policy', { loadFactor: 2, reason: 'a 14-core box takes more' })).status, 200);
    assert.equal(svc.loadGuard().factor, 2);
    assert.equal((await call('POST', '/api/queue/policy', { loadFactor: 0 })).status, 200);
    assert.equal(svc.loadGuard().factor, null, 'off');
    assert.equal(svc.loadGuard().holding, false);
    assert.equal((await call('POST', '/api/queue/policy', { loadFactor: -1 })).status, 400);
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
