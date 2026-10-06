/**
 * A parked run whose plan gains ready work comes back (control-tower phase 110,
 * #176).
 *
 * Measured on the hub console, run `6043ba472ccf`, 2026-09-29 → 09-30: the run
 * parked `nothing-ready`; a watchdog agent dismissed it through the API, and the
 * record said "dismissed by the operator" with `by: script`; the supervisor's
 * `resume` was refused on every parked run ("No pause … Continue brings it
 * back"); its detection was keyed on the halt, so the phase that became ready a
 * day later raised nothing; and converge pinned the run as a person's
 * dismissal. It sat parked with ready work for 6.6 hours.
 *
 *   PW-1  a dismissal says who made it: a script's is not worded as the
 *         operator's, it records what the board read ready, and it does not
 *         pin the run against ready work that appears after it — a person's
 *         still pins, naming the new work.
 *   PW-3  the `resume` verb works on a parked run: Continue, through the one
 *         start door, with the run's OWN settings — never on a halt only a
 *         person may lift when the press is automatic.
 *   (PW-2, the supervisor's detection and remedy, is in `supervisor-detect`
 *   and `supervisor-remedy`.)
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { planConvergence } = await import('../server/converge.ts');
const { newRun, phaseRecord, saveRun, loadRun } = await import('../server/runner/state.ts');
const { pressVerb } = await import('../server/verb-press.ts');
const { doorActor } = await import('../server/actor.ts');
type RunState = import('../server/runner/state.ts').RunState;
type ConvergeFacts = import('../server/converge.ts').ConvergeFacts;

const NOW = Date.parse('2026-09-30T15:45:00Z');

function run(over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'delta', root: '/tmp/delta' });
  Object.assign(state, {
    status: 'parked', stoppedBy: 'system',
    halt: { at: '2026-09-29T09:19:29.000Z', reason: 'nothing is ready — every remaining phase waits on another', kind: 'nothing-ready' },
  }, over);
  Object.assign(phaseRecord(state, 1), { status: 'done' });
  Object.assign(phaseRecord(state, 2), { status: 'done' });
  return state;
}

function facts(state: RunState, board: Record<number, string>): ConvergeFacts {
  return {
    slug: 'delta', now: NOW, trigger: 'timer', board, runs: [state], live: new Set(), locks: [],
    prefs: { resumeAtBoot: 'auto' }, pidAlive: () => false,
  };
}

const DISMISSED_AT = '2026-09-29T11:12:49.000Z';

test('PW-1: a script\'s dismissal does not pin the run against ready work that appeared after it; a person\'s still does, naming it', () => {
  const board = { 1: 'done', 2: 'done', 3: 'ready', 4: 'waiting' };
  // The watchdog's dismissal: nothing was ready when it dismissed the run.
  const scripted = run({ resolved: { at: DISMISSED_AT, auto: false, reason: 'dismissed by a script', by: 'script', ready: [] } as never });
  const back = planConvergence(facts(scripted, board));
  const relaunch = back.actions.find((a) => a.kind === 'relaunch') as { why: string[] } | undefined;
  assert.ok(relaunch, `phase 3 became ready after a script's dismissal — the run comes back (${JSON.stringify(back.actions)})`);
  assert.match(relaunch.why.join(' '), /new ready work since the dismissal/);
  assert.match(relaunch.why.join(' '), /phase 3/);

  // Ready work the dismissal already saw is not new: the dismissal stands.
  const saw = run({ resolved: { at: DISMISSED_AT, auto: false, reason: 'dismissed by a script', by: 'script', ready: [3] } as never });
  const held = planConvergence(facts(saw, board));
  assert.deepEqual(held.actions.map((a) => a.kind), ['skip']);
  assert.match((held.actions[0] as { why: string }).why, /a script dismissed it/);

  // A person's dismissal pins — and says what is waiting.
  const person = run({ resolved: { at: DISMISSED_AT, auto: false, reason: 'dismissed by the operator', by: 'ana', ready: [] } as never });
  const pinned = planConvergence(facts(person, board));
  assert.deepEqual(pinned.actions.map((a) => a.kind), ['skip']);
  const why = (pinned.actions[0] as { why: string }).why;
  assert.match(why, /a person dismissed it/);
  assert.match(why, /phase 3/, 'the pin names the ready work it is holding back');

  // A dismissal written before this rule recorded no ready set: a script's
  // over a `nothing-ready` park lets every ready phase it never boarded back.
  const legacy = run({ resolved: { at: DISMISSED_AT, auto: false, reason: 'dismissed by the operator', by: 'script' } });
  assert.ok(planConvergence(facts(legacy, board)).actions.some((a) => a.kind === 'relaunch'), 'the legacy script dismissal does not pin either');

  // A press-only halt stays a person's, whoever dismissed it.
  const streak = run({
    halt: { at: '2026-09-29T09:19:29.000Z', reason: 'two failures in a row', kind: 'failure-streak' }, status: 'halted',
    resolved: { at: DISMISSED_AT, auto: false, reason: 'dismissed by a script', by: 'script', ready: [] } as never,
  });
  assert.ok(!planConvergence(facts(streak, board)).actions.some((a) => a.kind === 'relaunch'), 'a failure streak is never relaunched by a clock');
});

/* ---- the service: the dismissal's words and the resume verb ---- */

const PLAN = `---
slug: delta
created: 2026-10-04
status: active
phases: 3
---

# delta

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |
| 2 | two | — | — | app | it works |
| 3 | three | — | — | app | it works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S

### Phase 3 — three
- **Size:** S
`;

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pc-parked-ready-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'delta.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const starts: Record<string, unknown>[] = [];
  (svc as never as Record<string, unknown>).startRun = async (slug: string, options: Record<string, unknown>) => {
    starts.push({ slug, ...options });
    return loadRun(root, 'delta', String(options.resumeRunId), null);
  };
  const stored = (over: Partial<RunState> = {}): RunState => {
    const state = newRun({ slug: 'delta', root, onlyPhases: [1, 3], skills: ['tdd'], model: 'claude-opus-5-5' });
    Object.assign(state, {
      status: 'parked', stoppedBy: 'system',
      halt: { at: new Date().toISOString(), reason: 'nothing is ready', kind: 'nothing-ready' },
    }, over);
    saveRun(state);
    return state;
  };
  return { root, svc, starts, stored, cleanup: async () => { await svc.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('PW-1: the dismissal says who made it and what the board read ready then', async () => {
  const { root, svc, stored, cleanup } = harness();
  try {
    const state = stored();
    const byScript = await svc.resolveRun('delta', state.id, {
      by: 'script', actor: { by: 'script', via: 'api', origin: 'local', remoteUser: null },
    });
    assert.ok(byScript?.resolved);
    assert.doesNotMatch(byScript.resolved.reason, /operator/, 'a script is never worded as the operator');
    assert.match(byScript.resolved.reason, /script/);
    const ready = (byScript.resolved as { ready?: number[] }).ready;
    assert.deepEqual(ready, [1, 2, 3], 'the board\'s ready set when it was dismissed, so later work reads as new');

    const second = stored();
    const byPerson = await svc.resolveRun('delta', second.id, {
      by: 'ana', actor: { by: 'ana', via: 'api', origin: 'local', remoteUser: null },
    });
    assert.equal(byPerson?.resolved?.reason, 'dismissed by the operator');
    assert.equal(loadRun(root, 'delta', second.id, null)?.resolved?.by, 'ana');
  } finally {
    await cleanup();
  }
});

test('PW-3: `resume` continues a parked run through the one door with its OWN settings — and an automatic press never lifts a press-only halt', async () => {
  const { svc, starts, stored, cleanup } = harness();
  try {
    const state = stored();
    const supervisor = doorActor('supervisor', { by: 'supervisor', via: 'supervisor', origin: 'test' });
    const answer = await pressVerb(svc, 'delta', 'resume', { reason: 'supervisor: halted-with-ready-work' }, supervisor);
    assert.equal(answer.ok, true, `a parked run is continued, not refused (${answer.error ?? ''})`);
    assert.equal(starts.length, 1);
    const start = starts[0]!;
    assert.equal(start.resumeRunId, state.id);
    for (const field of ['onlyPhases', 'skills', 'model', 'accountId', 'onLimit']) {
      assert.equal(field in start, false, `${field} is not re-sent: the stored run's own settings stand`);
    }
    assert.equal((start.actor as { door?: string }).door, 'supervisor', 'the press is recorded under its own door');

    // A failure streak is a person's to lift: the supervisor's press is refused, a person's is not.
    starts.length = 0;
    stored({ status: 'halted', halt: { at: new Date().toISOString(), reason: 'two failures in a row', kind: 'failure-streak' } });
    const refused = await pressVerb(svc, 'delta', 'resume', {}, supervisor);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.match(refused.error ?? '', /person/);
    assert.equal(starts.length, 0);
    const person = await svc.resumeRun('delta', { by: 'ana', via: 'api', origin: 'local', remoteUser: null, door: 'operator' } as never);
    assert.equal(person.ok, true, 'a person\'s Continue lifts it');
    assert.equal(starts.length, 1);
  } finally {
    await cleanup();
  }
});
