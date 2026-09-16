/**
 * The per-instance start ceiling (zero-touch-console phase 7, chapter 02
 * SLF-1 requirement ii): fourteen automatic doors, one bound over their sum.
 *
 * The pure class first — the sliding hour, the two limits, the press that is
 * never counted — then the service: the N+1th automatic `startRun` inside the
 * window is refused with `run.start-refused` on the run it would have
 * started, announced on `health` once per window, and a person's Start goes
 * through regardless.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { doorActor, pressActor, unattributedActor } from '../server/actor.ts';
import {
  CEILING_WINDOW_MS, DEFAULT_STARTS_PER_HOUR, DEFAULT_USD_PER_HOUR, StartCeiling, ceilingSentence,
} from '../server/start-ceiling.ts';
import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { newRun, runDir, saveRun } from '../server/runner/state.ts';

const T0 = Date.parse('2026-09-14T12:00:00.000Z');
const press = pressActor({ by: 'operator', via: 'api', origin: 'local', remoteUser: null });
const clock = () => doorActor('wait-clock', { by: 'console', via: 'timer', origin: 'armLimitResume' });

test('the ceiling counts automatic doors over a sliding hour and never a press', () => {
  let now = T0;
  const ceiling = new StartCeiling(() => ({ startsPerHour: 3, usdPerHour: 0 }), () => now);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(ceiling.admit(clock()).ok, true, `start ${i + 1} of 3 admitted`);
    ceiling.charge(clock(), 'alpha');
    now += 60_000;
  }
  const fourth = ceiling.admit(clock());
  assert.equal(fourth.ok, false);
  if (fourth.ok) return;
  assert.equal(fourth.ceiling, 'startsPerHour');
  assert.equal(fourth.limit, 3);
  assert.equal(fourth.count, 3);
  assert.equal(fourth.door, 'wait-clock');
  assert.equal(fourth.until, new Date(T0 + CEILING_WINDOW_MS).toISOString(), 'admitted again when the oldest start leaves the hour');
  assert.match(ceilingSentence(fourth), /refused the wait-clock door: 3 automatic starts in the last hour \(the ceiling is 3\)/);
  // A press is admitted at the ceiling and counts for nothing.
  assert.equal(ceiling.admit(press).ok, true);
  ceiling.charge(press, 'alpha');
  assert.equal(ceiling.snapshot().starts, 3, 'the press left no entry');
  assert.deepEqual(ceiling.snapshot().doors, { 'wait-clock': 3 });
  // A door-less actor (a harness's) is not automatic either.
  assert.equal(ceiling.admit(unattributedActor('test')).ok, true);
  // The window slides: an hour after the first start, one slot is free again.
  now = T0 + CEILING_WINDOW_MS + 1;
  assert.equal(ceiling.admit(clock()).ok, true);
  assert.equal(ceiling.snapshot().starts, 2);
  // 0 switches the limit off.
  const off = new StartCeiling(() => ({ startsPerHour: 0, usdPerHour: 0 }), () => now);
  for (let i = 0; i < 100; i += 1) { assert.equal(off.admit(clock()).ok, true); off.charge(clock()); }
});

test('the dollar half reads the last hour\'s reported session spend', () => {
  let now = T0;
  const ceiling = new StartCeiling(() => ({ startsPerHour: 0, usdPerHour: 10 }), () => now);
  ceiling.spendUsd(4.5);
  now += 60_000;
  ceiling.spendUsd(5.49);
  assert.equal(ceiling.admit(clock()).ok, true, '$9.99 is under $10');
  ceiling.spendUsd(0.02);
  const refused = ceiling.admit(clock());
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.ceiling, 'usdPerHour');
  assert.equal(refused.count, 10.01);
  assert.match(ceilingSentence(refused), /\$10\.01 of session spend in the last hour \(the ceiling is \$10\)/);
  // A cost that never arrived, or a nonsense one, charges nothing.
  ceiling.spendUsd(0); ceiling.spendUsd(Number.NaN); ceiling.spendUsd(-3);
  assert.equal(ceiling.snapshot().usd, 10.01);
  // The first spend leaves the window an hour after it landed.
  now = T0 + CEILING_WINDOW_MS + 1;
  assert.equal(ceiling.admit(clock()).ok, true);
  assert.equal(ceiling.snapshot().usd, 5.51);
});

test('a refusal is announced once per window', () => {
  const ceiling = new StartCeiling(() => ({ startsPerHour: 1, usdPerHour: 0 }), () => T0);
  ceiling.charge(clock());
  const first = ceiling.admit(clock());
  const second = ceiling.admit(clock());
  assert.ok(!first.ok && !second.ok);
  if (first.ok || second.ok) return;
  assert.equal(ceiling.shouldAnnounce(first), true);
  assert.equal(ceiling.shouldAnnounce(second), false, 'the same window is the same fact');
  assert.equal(ceiling.shouldAnnounce({ ...second, until: new Date(T0 + 2 * CEILING_WINDOW_MS).toISOString() }), true, 'a later window is news again');
});

test('the shipped defaults are what the docs say', () => {
  assert.equal(DEFAULT_STARTS_PER_HOUR, 40);
  assert.equal(DEFAULT_USD_PER_HOUR, 250);
});

/* ------------------------------------------------------------------ *
 * Through the service
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-09-14
status: active
phases: 1
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |

## Phases

### Phase 1 — one
- **Size:** S
`;

test('the N+1th automatic start inside the window is refused by name, journalled on the run, announced once — and a press still goes through', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-ceiling-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const announced: { category: string; title: string }[] = [];
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  const realAnnounce = (svc as never as { announce: (category: string, n: { title: string }) => void }).announce.bind(svc);
  (svc as never as Record<string, unknown>).announce = (category: string, n: { title: string }, ...rest: unknown[]) => {
    announced.push({ category, title: n.title });
    return (realAnnounce as (...a: unknown[]) => unknown)(category, n, ...rest);
  };
  try {
    assert.equal(svc.open(root).ok, true);
    // The runner is stubbed: every start "starts" and returns at once, so the
    // service's door is the only thing under test.
    const started: string[] = [];
    (svc as never as Record<string, unknown>).runnerFor = () => ({
      start: async (options: { actor?: { door?: string } }) => { started.push(String(options.actor?.door)); return newRun({ slug: 'alpha', root }); },
    });
    svc.prefs.ceilingStartsPerHour = 2;
    const run = newRun({ slug: 'alpha', root });
    run.status = 'paused';
    saveRun(run);

    await svc.startRun('alpha', { actor: clock(), resumeRunId: run.id });
    await svc.startRun('alpha', { actor: clock(), resumeRunId: run.id });
    await assert.rejects(
      () => svc.startRun('alpha', { actor: clock(), resumeRunId: run.id }),
      /the start ceiling refused the wait-clock door: 2 automatic starts in the last hour \(the ceiling is 2\)/,
    );
    await assert.rejects(() => svc.startRun('alpha', { actor: clock(), resumeRunId: run.id }), /start ceiling/);
    assert.deepEqual(started, ['wait-clock', 'wait-clock'], 'two started, the third and fourth did not');

    // Journalled on the run it would have started, with the actor and the arithmetic.
    const journal = readFileSync(join(runDir(root, 'alpha'), `run-${run.id}.jsonl`), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
    const refused = journal.filter((l) => l.event === 'run.start-refused');
    assert.equal(refused.length, 2);
    assert.equal(refused[0].data.door, 'wait-clock');
    assert.equal(refused[0].data.ceiling, 'startsPerHour');
    assert.equal(refused[0].data.limit, 2);
    assert.equal(refused[0].data.count, 2);
    assert.equal(typeof refused[0].data.until, 'string');
    assert.equal(refused[0].data.by, 'console');
    assert.equal(refused[0].data.via, 'timer');

    // Announced ONCE for the window, on health.
    const health = announced.filter((a) => a.category === 'health' && /Start ceiling reached/.test(a.title));
    assert.equal(health.length, 1, JSON.stringify(announced));

    // A person's press is never refused, and counts for nothing.
    await svc.startRun('alpha', { actor: press, resumeRunId: run.id });
    assert.deepEqual(started, ['wait-clock', 'wait-clock', 'operator']);
    assert.equal(svc.startCeiling.snapshot().starts, 2);
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
