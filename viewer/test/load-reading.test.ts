/**
 * The machine read as it is (one-pool phase 26, #243 #223 #327).
 *
 *   LR-1  CPU busy is the share of every core's ticks spent busy between two
 *         samples, over the newest 30 s of them (`cpuBusyOver`).
 *   LR-2  the guard holds on CPU busy (85 % at the default factor, scaled by
 *         it) and on the 5-minute average only as a ceiling
 *         (`factor × cores × 2`) — the readings recorded in #243, #223 and
 *         #327, each with the verdict it should have had; off holds nothing,
 *         and the held sentence names the real CPU beside the load.
 *   LR-3  the sampler keeps its window fed and reads now on every ask.
 *   LR-4  a heavy job is a suite or a build; a grep is not.
 *   LR-5  every console on the machine shares ONE heavy-job budget through
 *         `<stateHome>/fleet/jobs/`; a dead console's token lapses.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CPU_BUSY_LIMIT, DEFAULT_LOAD_FACTOR, LOAD_CEILING_RATIO, busyLimitOf, heavyJobBudget, loadReading, loadReason,
} from '../shared/orchestration-model.js';
import { CpuSampler, MachineJobs, cpuBusyOver, cpuTicks, heavyCommand, heavyJobsDir } from '../server/load-reading.ts';

test('LR-1: CPU busy is the busy share of every core\'s ticks between the newest sample and the one 30 s before it', () => {
  const ticks = cpuTicks([
    { times: { user: 100, nice: 0, sys: 50, irq: 0, idle: 850 } },
    { times: { user: 300, nice: 0, sys: 100, irq: 0, idle: 600 } },
  ]);
  assert.deepEqual(ticks, { busy: 550, total: 2000 });
  assert.equal(cpuBusyOver([]), null, 'no samples: no reading');
  assert.equal(cpuBusyOver([{ at: 0, busy: 0, total: 0 }]), null, 'one sample: no reading');
  // 14 cores, 5 s apart: the first 30 s idle, the last 10 s 95 % busy.
  const samples = [
    { at: 0, busy: 0, total: 0 },
    { at: 30_000, busy: 21_000, total: 420_000 },     // 5 % busy over the first 30 s
    { at: 40_000, busy: 21_000 + 133_000, total: 560_000 }, // 95 % over the last 10 s
  ];
  const share = cpuBusyOver(samples, 30_000)!;
  // The base is the newest sample at least 30 s older than the newest: at 0 — less is too young.
  assert.ok(Math.abs(share - 154_000 / 560_000) < 1e-9, `over the window from the base at 0 s: ${share}`);
  assert.ok(Math.abs(cpuBusyOver(samples, 10_000)! - 0.95) < 1e-9, 'a 10 s window reads only the burst');
  assert.equal(cpuBusyOver([{ at: 0, busy: 5, total: 10 }, { at: 1, busy: 5, total: 10 }]), null, 'ticks that did not move read nothing');
});

test('LR-2: the guard holds on CPU busy and on the 5-minute average only as a ceiling — the recorded readings, each with its verdict', () => {
  assert.equal(DEFAULT_LOAD_FACTOR, 1.5);
  assert.equal(CPU_BUSY_LIMIT, 0.85);
  assert.equal(LOAD_CEILING_RATIO, 2);
  assert.equal(busyLimitOf(1.5), 0.85, 'the default factor is the default limit');
  assert.equal(busyLimitOf(2), 0.98, '2.0 lets the machine run busier, held to 98 %');
  assert.equal(busyLimitOf(1), 0.57, '1.0 holds new work sooner');
  assert.equal(busyLimitOf(null), null, 'off');

  const cores = 14;
  const cases: { what: string; avg5: number; busy: number | null; factor: number | null; holding: boolean; cause?: string }[] = [
    // #243, the hub at loadFactor 2.0 — every one an admission that should have boarded.
    { what: '#243 18:38 — load 52.3, ~40 % CPU', avg5: 52.3, busy: 0.40, factor: 2, holding: false },
    { what: '#243 19:48 — load 36.3, 29 % CPU', avg5: 36.3, busy: 0.29, factor: 2, holding: false },
    { what: '#243 19:51 — load 36.1, 32 % CPU', avg5: 36.1, busy: 0.32, factor: 2, holding: false },
    // #243's own two test cases, at the shipped factor.
    { what: '#243 — load 36, CPU 30 %: admit', avg5: 36, busy: 0.30, factor: 1.5, holding: false },
    { what: '#243 — load 10, CPU 95 % over the window: hold', avg5: 10, busy: 0.95, factor: 1.5, holding: true, cause: 'cpu' },
    // #223: three suites in six minutes — the average lagged; the CPU did not.
    { what: '#223 17:08 — the burst, 1-min climbing, 5-min still 20', avg5: 20, busy: 0.97, factor: 1.5, holding: true, cause: 'cpu' },
    { what: '#223 17:12 — 146.9 / 79.4 / 42.7', avg5: 79.4, busy: 0.7, factor: 1.5, holding: true, cause: 'ceiling' },
    // #327: 85/90/79 at ~60 % CPU — saturated by the average's own ceiling.
    { what: '#327 — load 90 at 60 % CPU', avg5: 90, busy: 0.60, factor: 1.5, holding: true, cause: 'ceiling' },
    // No CPU reading yet (the sampler's first beat): the ceiling alone decides.
    { what: 'no CPU reading, load 22.4 — the old guard held here', avg5: 22.4, busy: null, factor: 1.5, holding: false },
    { what: 'off holds nothing', avg5: 146, busy: 1, factor: null, holding: false },
  ];
  for (const c of cases) {
    const reading = loadReading({ avg5: c.avg5, cores, factor: c.factor, busy: c.busy });
    assert.equal(reading.holding, c.holding, `${c.what}: ${JSON.stringify(reading)}`);
    if (c.cause) assert.equal(reading.cause, c.cause, c.what);
  }
  assert.deepEqual(loadReading({ avg5: 22.4, cores: 14, factor: 1.5, busy: 0.9 }), {
    avg5: 22.4, cores: 14, factor: 1.5, threshold: 42, busy: 0.9, busyLimit: 0.85, holding: true, cause: 'cpu',
  });
  assert.equal(loadReading({ avg5: 42, cores: 14, factor: 1.5, busy: 0.1 }).holding, false, 'AT the ceiling is not over it');
  assert.equal(loadReading({ avg5: 1, cores: 14, factor: 1.5, busy: 0.85 }).holding, true, 'AT the busy limit holds');

  const cpu = loadReason(loadReading({ avg5: 12.4, cores: 14, factor: 1.5, busy: 0.93 }));
  assert.match(cpu, /CPU 93 % over the last 30 s, over 85 % \(5-min load 12\.4 on 14 cores\)/, 'the real CPU beside the load (#243 ask 3)');
  const ceiling = loadReason(loadReading({ avg5: 90, cores: 14, factor: 1.5, busy: 0.6 }));
  assert.match(ceiling, /5-min load 90 over its ceiling 42 \(1\.5 × 14 cores × 2; CPU 60 %\)/);
  assert.match(ceiling, /live lanes carry on$/);
});

test('LR-3: the sampler reads now on every ask and keeps its window fed', () => {
  let clock = 0;
  let busy = 0;
  let total = 0;
  const sampler = new CpuSampler({ read: () => ({ busy, total }), now: () => clock, intervalMs: 60_000 });
  try {
    assert.equal(sampler.busy(), null, 'the first ask has nothing to compare');
    for (let i = 0; i < 8; i++) {
      clock += 5_000;
      busy += 4_000;
      total += 5_000;
      sampler.sample();
    }
    clock += 500;
    assert.equal(sampler.busy(), 0.8, 'an ask within a second of the last sample reads the window as it stands');
    clock += 5_000;
    busy += 5_000;
    total += 5_000;
    const now = sampler.busy()!;
    assert.ok(now > 0.8 && now < 0.9, `a fully busy last beat moves the 30 s share: ${now}`);
  } finally {
    sampler.stop();
  }
});

test('LR-4: a heavy job is a suite, a build or a gate — read from the line\'s leads', () => {
  for (const heavy of [
    'node --test --test-timeout=600000 --test-force-exit viewer/test/a.test.ts',
    'npm --prefix viewer run typecheck:server',
    'npm --prefix viewer test',
    'pnpm verify:local',
    'task verify:local',
    'bash tests/run-tests.sh',
    'bash scripts/gates.sh --quick',
    'npx vitest run',
    'cd app && npm run build',
    'PHASE_CONSOLE_TEST_ROOT=x npm test',
    'pytest -q',
    'bats tests/unit',
  ]) assert.equal(heavyCommand(heavy), true, heavy);
  for (const light of [
    'bash .github/scripts/scrub.sh',
    'test "$(gh issue list -R o/r --json number --jq length)" = "0"',
    'grep -q "status: complete" docs/handoffs/x.md',
    'git diff --quiet',
    'node -e "process.exit(0)"',
    'curl -sf http://127.0.0.1:4130/api/state',
  ]) assert.equal(heavyCommand(light), false, light);
});

test('LR-5: every console on the machine shares one heavy-job budget; a dead console\'s token lapses', () => {
  const home = mkdtempSync(join(tmpdir(), 'pc-jobs-'));
  try {
    const env = { ...process.env, XDG_STATE_HOME: home };
    assert.equal(heavyJobBudget(14), 2, 'two on a 14-core laptop (#327)');
    assert.equal(heavyJobBudget(4), 1, 'at least one');
    assert.equal(heavyJobBudget(32), 4);
    const hub = new MachineJobs(env);
    const peHub = new MachineJobs(env);
    const job = (instance: string, id: string) => ({ id, instance, slug: 's', phase: 1, purpose: 'baseline', command: 'npm test' });
    assert.equal(hub.acquire(job('hub', 'a'), 2).ok, true);
    assert.equal(peHub.acquire(job('pe-hub', 'b'), 2).ok, true);
    const third = peHub.acquire(job('pe-hub', 'c'), 2);
    assert.equal(third.ok, false, 'the second console sees the first one\'s job: the machine is full');
    assert.deepEqual(third.holders.map((held) => held.instance).sort(), ['hub', 'pe-hub']);
    hub.release('a');
    assert.equal(peHub.acquire(job('pe-hub', 'c'), 2).ok, true, 'a release frees the seat for any console');
    assert.equal(hub.running().length, 2);

    // A console that died holding a seat: its token names a pid that is gone.
    peHub.release('b');
    peHub.release('c');
    mkdirSync(heavyJobsDir(env), { recursive: true });
    writeFileSync(join(heavyJobsDir(env), 'dead-x.json'), JSON.stringify({ ...job('dead', 'x'), pid: 2 ** 22 + 7, at: new Date().toISOString() }));
    assert.equal(hub.running().length, 0, 'a dead console\'s token is not a job');
    assert.equal(hub.acquire(job('hub', 'd'), 1).ok, true, 'and holds no seat');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
