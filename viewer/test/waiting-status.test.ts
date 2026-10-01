/**
 * A waiting run has its own status, never "Paused" (control-tower phase 88, #148).
 *
 * Observed on hub 4123, 2026-09-26: two runs were each asleep on something
 * specific — observability-plane P28 on its own deploy's CD run, vca-refactor
 * P10 on the watchdog's park of its own iOS sweep — and both read **Paused**,
 * with no word of what they waited on or when they would resume. Nobody had
 * paused either: `pause: null`, `stoppedBy: 'system'`. The facts were all on
 * the run (`waitReason`, `waitUntil`, the phase's `declared.watch`); they were
 * lost between the writer and the badge, in three places:
 *
 *   1. reconcile wrote the dead-console wait as `paused`, and
 *   2. `setRunState` kept `lifecycle.wait` only for a state that folded to
 *      `waiting`, so the stored lifecycle said `{state: 'paused'}` alone, and
 *   3. `describeRun`'s wait rule only fires on a `waiting` lifecycle.
 *
 * The stored WORD stays `paused` — the resume machinery keys on it
 * (`resumeLimitPaused`, the converge relaunch, the owed-clock inventory) and a
 * dead run left `waiting` is `IN_FLIGHT`, re-reconciled on every read; #148's
 * fourth ask allows exactly this ("either stays `waiting` or carries
 * `lifecycle.wait`"), and the ruling is in the phase 88 handoff. What changes is
 * the LIFECYCLE: a clocked `paused` run that nobody paused folds to `waiting`,
 * with its kind, its `on` and its `until`, and every reader paints from that.
 *
 *   WT-1  reconcile: every wait kind that can die with its console comes back a
 *         wait — the lifecycle, the kind, the clock and what it is on.
 *   WT-2  `setRunState` keeps kind, `on` and `until` for every wait kind, and
 *         derives them when the caller passed none.
 *   WT-3  `describeRun` says WHAT (the watch ref or the park's reason) and WHEN.
 *   WT-4  "Paused by …" only for a person or a named console rule.
 *   WT-5  the surfaces that print the bare word read `runStatusWord`, which
 *         agrees with the fold; and the fold agrees with `waitHoldWhy`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadRun, newRun, phaseRecord, reconcileRun, runFile, saveRun, setRunState, type RunState,
} from '../server/runner/state.ts';
import { waitHoldWhy } from '../server/converge.ts';
import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { pausedWaitOf, runLifecycle, waitOnOf } from '../shared/run-lifecycle.js';
import { bayOf, describeRun, waitSentence } from '../shared/status-model.js';
import { runStatusWord, WAIT_REASONS } from '../shared/status-vocab.js';

/** P28's own clock, from the issue. */
const UNTIL = '2026-09-26T08:57:36.000Z';
/** Seventeen minutes before it — the moment the operator looked. */
const NOW = Date.parse('2026-09-26T08:40:00.000Z');
const CD_REF = 'gh:acme/web#run/17843290511';

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-waiting-status-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A run a live loop left `waiting` on `kind`, the way each writer leaves it. */
function waitingRun(root: string, kind: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  Object.assign(state, over);
  state.stoppedBy = 'system';
  state.waitUntil = UNTIL;
  if (kind === 'external') {
    const record = phaseRecord(state, 28);
    record.status = 'waiting';
    record.parkedUntil = UNTIL;
    record.sessionId = 'sess-28';
    record.watch = [CD_REF];
    record.parkReason = 'waiting for the deploy of 0588175c';
    record.declared = { status: 'waiting-external', by: 'session', reason: 'waiting for the deploy of 0588175c' } as never;
  }
  setRunState(state, 'waiting', {
    kind: kind as never, until: UNTIL,
    ...(kind === 'person' ? { on: 'phase 5 verification card' } : {}),
  });
  return state;
}

/* ------------------------------------------------------------------ *
 * WT-1 — reconcile keeps a wait a wait
 * ------------------------------------------------------------------ */

test('WT-1: every wait kind a console can die in comes back from reconcile a WAIT — lifecycle, kind, clock, on', () => {
  const dir = scratch();
  try {
    // `scope` and `schedule` are spelled `queued`, which is not in flight, so
    // reconcile never sees them (WT-2 covers their writer).
    for (const kind of ['external', 'usage-limit', 'person', 'connectivity', 'engine-busy']) {
      const state = waitingRun(dir.root, kind, kind === 'usage-limit' ? { accountId: 'max-2' } : {});
      assert.equal(reconcileRun(state, null), true, `${kind}: a dead loop's wait is reconciled`);
      // The WORD the resume machinery keys on (the ruling above) …
      assert.equal(state.status, 'paused', `${kind}: the stored word stays the resume machinery's`);
      assert.equal(state.waitUntil, UNTIL, `${kind}: the clock survives`);
      // … and the lifecycle every reader paints from.
      assert.equal(runLifecycle(state).state, 'waiting', `${kind}: the lifecycle is a wait, never a pause`);
      assert.equal(state.lifecycle?.state, 'waiting', `${kind}: the WRITER stored it — no reader re-derives it`);
      assert.equal(state.lifecycle?.wait?.kind, kind, `${kind}: the kind is kept`);
      assert.equal(state.lifecycle?.wait?.until, UNTIL, `${kind}: the until is kept`);
    }
  } finally { dir.cleanup(); }
});

test('WT-1: what the wait is ON survives the reconcile — the watch ref of a declared park, the card of a person wait', () => {
  const dir = scratch();
  try {
    const external = waitingRun(dir.root, 'external');
    reconcileRun(external, null);
    assert.match(external.lifecycle?.wait?.on ?? '', /phase 28/);
    assert.match(external.lifecycle?.wait?.on ?? '', new RegExp(CD_REF.replace(/[#/]/g, '\\$&')));

    const person = waitingRun(dir.root, 'person');
    reconcileRun(person, null);
    assert.equal(person.lifecycle?.wait?.on, 'phase 5 verification card', 'the card the writer named is not re-derived away');

    const window = waitingRun(dir.root, 'usage-limit', { accountId: 'max-2' });
    reconcileRun(window, null);
    assert.match(window.lifecycle?.wait?.on ?? '', /max-2/, 'a usage window names its account');
  } finally { dir.cleanup(); }
});

test('WT-1: the read path agrees — a crashed wait loaded from disk is a wait, and a file the #148 writer left reads as one too', () => {
  const dir = scratch();
  try {
    const state = waitingRun(dir.root, 'external');
    saveRun(state);
    const loaded = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(loaded?.status, 'paused');
    assert.equal(loaded?.lifecycle?.state, 'waiting');
    assert.equal(describeRun(loaded, { now: NOW }).label, 'Waiting');

    // The shape both runs of #148 were on disk in: written before this phase,
    // lifecycle stored `{state: 'paused'}` with no wait. Nothing will rewrite it
    // until its next status write, so the READ must not believe the stale axis.
    const raw = JSON.parse(readFileSync(runFile(dir.root, 'demo', state.id), 'utf8'));
    Object.assign(raw, { status: 'paused', stoppedBy: 'system', pause: null, lifecycle: { state: 'paused' } });
    writeFileSync(runFile(dir.root, 'demo', state.id), JSON.stringify(raw));
    assert.equal(runLifecycle(raw).state, 'waiting', 'a stored pause beside a clock nobody paused is the #148 defect');
    const reread = loadRun(dir.root, 'demo', state.id, null);
    assert.equal(reread?.lifecycle?.state, 'waiting', 'and the next settle writes the wait back');
  } finally { dir.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * WT-2 — the writer keeps the wait
 * ------------------------------------------------------------------ */

test('WT-2: setRunState keeps kind, on and until in lifecycle.wait for EVERY wait kind', () => {
  for (const kind of WAIT_REASONS) {
    const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
    state.waitUntil = UNTIL;
    const word = kind === 'scope' || kind === 'schedule' ? 'queued' : 'waiting';
    setRunState(state, word, { kind, until: UNTIL, on: `the ${kind} thing` });
    assert.deepEqual(state.lifecycle?.wait, { kind, until: UNTIL, on: `the ${kind} thing` }, `${kind} via ${word}`);
  }
});

test('WT-2: with no wait passed, the writer derives it — kind from the reason, until from the clock, on from the waiting phase', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  const record = phaseRecord(state, 3);
  record.status = 'waiting';
  record.parkedUntil = UNTIL;
  record.watch = [CD_REF];
  state.waitReason = 'external';
  state.waitUntil = UNTIL;
  state.stoppedBy = 'system';
  setRunState(state, 'waiting');
  assert.equal(state.lifecycle?.wait?.kind, 'external');
  assert.equal(state.lifecycle?.wait?.until, UNTIL);
  assert.match(state.lifecycle?.wait?.on ?? '', /phase 3 · gh:acme/);

  // The unsupervised-outcome path writes `paused` WITH a wait: that is a wait.
  const inbox = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  inbox.stoppedBy = 'system';
  inbox.waitUntil = UNTIL;
  setRunState(inbox, 'paused', { kind: 'external', until: UNTIL });
  assert.equal(inbox.lifecycle?.state, 'waiting');
  assert.equal(inbox.lifecycle?.wait?.kind, 'external');
});

test('WT-2: a pause a rule took with its clock CARRIES the wait — `onLimit: pause` stays a pause, and says on what', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever', model: 'opus' });
  state.onLimit = 'pause';
  state.stoppedBy = 'system';
  state.waitUntil = UNTIL;
  setRunState(state, 'paused', { kind: 'usage-limit', until: UNTIL });
  assert.equal(state.lifecycle?.state, 'paused', 'the operator chose to stay down on a wall');
  assert.equal(state.lifecycle?.wait?.kind, 'usage-limit', '… and the lifecycle still carries which wall');
  assert.equal(state.lifecycle?.wait?.until, UNTIL);
});

/* ------------------------------------------------------------------ *
 * WT-3 — describeRun says what and when
 * ------------------------------------------------------------------ */

/** observability-plane `86103bfe79aa` as the API served it on 2026-09-26. */
function p28(): RunState {
  return {
    id: '86103bfe79aa', slug: 'observability-plane', status: 'paused', waitReason: 'external',
    waitUntil: UNTIL, pause: null, stoppedBy: 'system', lifecycle: { state: 'paused' },
    phases: {
      '28': {
        phase: 28, status: 'waiting', parkedUntil: UNTIL, watch: [CD_REF],
        parkReason: 'waiting for the deploy of 0588175c',
        declared: { status: 'waiting-external', by: 'session' },
      },
    },
  } as unknown as RunState;
}

/** vca-refactor `4338565619a8`: the watchdog parked P10 on its own sweep. */
function p10(): RunState {
  return {
    id: '4338565619a8', slug: 'vca-refactor', status: 'paused', waitReason: 'external',
    waitUntil: '2026-09-26T08:56:35.000Z', pause: null, stoppedBy: 'system', lifecycle: { state: 'paused' },
    phases: {
      '10': {
        phase: 10, status: 'waiting', parkedUntil: '2026-09-26T08:56:35.000Z', watch: [],
        parkReason: 'waiting inside its turn on its own job (xcodebuild test)',
        declared: { status: 'waiting-external', by: 'watchdog' },
      },
    },
  } as unknown as RunState;
}

test('WT-3: a declared park reads Waiting, on its watch ref, resuming at its clock — never Paused', () => {
  const view = describeRun(p28(), { now: NOW });
  assert.equal(view.label, 'Waiting');
  assert.equal(view.icon, 'hourglass');
  assert.equal(view.paint, 'waiting');
  assert.equal(view.attention, 'none', 'a self-resuming wait asks nothing of anybody');
  assert.equal(view.note?.kind, 'waiting-on');
  assert.match(view.note?.text ?? '', /phase 28/);
  assert.match(view.note?.text ?? '', /acme\/web#run\/17843290511/);
  assert.match(view.note?.text ?? '', /resumes 08:57Z/);
});

test("WT-3: the watchdog's park of a session's own job reads as that phase's own job, with its clock", () => {
  const view = describeRun(p10(), { now: NOW });
  assert.equal(view.label, 'Waiting');
  assert.match(view.note?.text ?? '', /phase 10/);
  assert.match(view.note?.text ?? '', /its own job/);
  assert.match(view.note?.text ?? '', /resumes 08:56Z/);
});

test('WT-3: the other kinds say what they wait on — a window resets, a card needs you, the network, the schedule, scope queues', () => {
  const base = { id: 'r', slug: 's', stoppedBy: 'system', pause: null } as const;
  const window = describeRun({ ...base, status: 'waiting', waitReason: 'usage-limit', waitUntil: '2026-09-26T12:00:00.000Z', accountId: 'max-2' } as never, { now: NOW });
  assert.equal(window.label, 'Waiting');
  assert.match(window.note?.text ?? '', /max-2/);
  assert.match(window.note?.text ?? '', /resets 12:00Z/);

  const card = describeRun({ ...base, status: 'waiting', waitReason: 'person', waitUntil: UNTIL, lifecycle: { state: 'waiting', wait: { kind: 'person', until: UNTIL, on: 'phase 5 verification card' } } } as never, { now: NOW });
  assert.equal(card.attention, 'needs-you');
  assert.match(card.note?.text ?? '', /phase 5 verification card/);

  const net = describeRun({ ...base, status: 'waiting', waitReason: 'connectivity', waitUntil: UNTIL } as never, { now: NOW });
  assert.match(net.note?.text ?? '', /the network/);

  const next = describeRun({ ...base, status: 'queued', waitReason: 'schedule', waitUntil: '2026-09-27T06:00:00.000Z' } as never, { now: NOW });
  assert.match(next.note?.text ?? '', /the schedule/);
  assert.match(next.note?.text ?? '', /Sep 27 06:00Z/, 'a clock on another day says the day');

  const scope = describeRun({ ...base, status: 'queued', waitReason: 'scope' } as never, { now: NOW });
  assert.equal(scope.paint, 'queued');
});

/* ------------------------------------------------------------------ *
 * WT-4 — "Paused by" only when somebody did
 * ------------------------------------------------------------------ */

test('WT-4: "Paused by you" only for a person, and a console rule names itself', () => {
  const operator = describeRun({ ...p28(), stoppedBy: 'operator' } as never, { now: NOW });
  assert.equal(operator.label, 'Paused by you', 'an operator who stopped a waiting run pinned its clock');

  const rule = describeRun({
    id: 'r', slug: 's', status: 'paused', stoppedBy: 'system', pause: null, onLimit: 'pause',
    waitReason: 'usage-limit', waitUntil: '2026-09-26T12:00:00.000Z',
  } as never, { now: NOW });
  assert.equal(rule.label, 'Paused by its limit rule', 'onLimit: pause is a rule, and the label says which');
  assert.match(rule.note?.text ?? '', /resets 12:00Z/);

  const minted = describeRun({ id: 'r', slug: 's', status: 'paused', stoppedBy: 'system', pause: null } as never, { now: NOW });
  assert.equal(minted.label, 'Paused by the console', 'a system pause with no clock names who paused it');

  for (const view of [describeRun(p28(), { now: NOW }), describeRun(p10(), { now: NOW })]) {
    assert.doesNotMatch(view.label, /Paused/, 'nobody paused either run of #148');
  }
});

/* ------------------------------------------------------------------ *
 * WT-5 — one rule, every reader
 * ------------------------------------------------------------------ */

test('WT-5: runStatusWord — the word the Runs list, the tiles, the board and the header print — agrees with the fold', () => {
  assert.equal(runStatusWord(p28()), 'waiting');
  assert.equal(runStatusWord(p10()), 'waiting');
  assert.equal(runStatusWord({ ...p28(), stoppedBy: 'operator' } as never), 'paused');
  assert.equal(runStatusWord({ ...p28(), onLimit: 'pause', waitReason: 'usage-limit' } as never), 'paused');
  assert.equal(runStatusWord({ status: 'running' }), 'running');
  assert.equal(runStatusWord({ status: 'paused' }), 'paused');
});

test('WT-5: the Tower bays and the pushes read the same wait — the waiting bay, and one sentence saying what and when', () => {
  // The bays sort a run by its view, so a reconciled park stands in the WAITING
  // bay beside the live waits, never among the stopped runs a person owes.
  for (const run of [p28(), p10()]) {
    const view = describeRun(run, { now: NOW });
    assert.equal(bayOf(view), 'waiting', `${run.slug}: the waiting bay`);
    assert.equal(view.attention, 'none', `${run.slug}: nobody is summoned for a wait that resumes by itself`);
  }
  // The push a waiting run sends says what the Runs list says: the ref or the
  // park's reason, and the clock.
  assert.equal(waitSentence(p28(), NOW), `Waiting on phase 28 · ${CD_REF} · resumes 08:57Z`);
  assert.match(waitSentence(p10(), NOW) ?? '', /^Waiting on phase 10 · its own job · resumes 08:56Z$/);
  const live = { id: 'r', slug: 's', status: 'waiting', waitReason: 'usage-limit', waitUntil: '2026-09-26T12:00:00.000Z', accountId: 'max-2' };
  assert.equal(waitSentence(live as never, NOW), "Waiting on max-2's usage window · resets 12:00Z");
  // A pause somebody took, and a run that is not waiting, have no wait to say.
  assert.equal(waitSentence({ ...p28(), stoppedBy: 'operator' } as never, NOW), null);
  assert.equal(waitSentence({ ...p28(), onLimit: 'pause', waitReason: 'usage-limit' } as never, NOW), null);
  assert.equal(waitSentence({ id: 'r', slug: 's', status: 'running' } as never, NOW), null);
});

test('WT-5: the push a waiting run sends is that sentence — the ref, the phase and the clock', () => {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Array<{ category: string; message: { title: string; body: string } }> = [];
  sv.push.announce = ((category: string, message: { title: string; body: string }) => {
    pushed.push({ category, message });
  }) as typeof sv.push.announce;
  sv.webhooks.announce = (() => undefined) as typeof sv.webhooks.announce;
  const inner = sv as unknown as {
    notifications: { clear(what: 'all'): number };
    onRunnerEvent: (event: string, data: unknown) => void;
  };
  inner.notifications.clear('all');
  try {
    // A live park an hour out: the clock is the real one here, because the
    // service arms its resume from it.
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const run = p28();
    const state = {
      ...run, status: 'waiting', waitUntil: until, lifecycle: undefined, spentUsd: 0, halt: null,
      phases: { '28': { ...run.phases['28'], parkedUntil: until } },
    };
    inner.onRunnerEvent('run:run', { state });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]!.category, 'parked');
    assert.equal(pushed[0]!.message.title, 'observability-plane is waiting');
    assert.match(pushed[0]!.message.body, /^Waiting on phase 28 · gh:acme\/web#run\/17843290511 · resumes \d\d:\d\dZ$/);
  } finally {
    sv.close();
  }
});

test('WT-5: a paused run is a wait exactly when its clock resumes it by itself — the fold and waitHoldWhy agree', () => {
  const shapes: Array<Partial<RunState>> = [
    { stoppedBy: 'system' },
    { stoppedBy: 'operator' },
    { stoppedBy: 'system', resolved: { at: UNTIL, by: 'x', reason: 'y' } as never },
    { stoppedBy: 'system', onLimit: 'pause', waitReason: 'usage-limit' },
    { stoppedBy: 'system', onLimit: 'wait', waitReason: 'usage-limit' },
    { stoppedBy: 'system', waitReason: 'person' },
  ];
  for (const shape of shapes) {
    const run = { ...p28(), ...shape } as RunState;
    const held = waitHoldWhy(run);
    assert.equal(pausedWaitOf(run) === null, held !== null, `${JSON.stringify(shape)}: held=${held}`);
  }
  // No clock, no wait — whoever stopped it.
  assert.equal(pausedWaitOf({ ...p28(), waitUntil: null } as never), null);
  // `waitOnOf` names nothing for a run no phase waits in, and the first waiting phase otherwise.
  assert.equal(waitOnOf({ phases: {} } as never, 'external'), null);
  assert.match(waitOnOf(p28(), 'external') ?? '', /^phase 28 · gh:acme/);
});
