/**
 * The two correctives and the escalation memory, on a real Service
 * (parallel-repaint P2, register N1).
 *
 * `retractHalt` and `retractStall` are the only two direct `push.announce()`
 * callers outside the choke point (`announce-choke-point.test.ts` pins the
 * inventory). This file pins what they DO: annotate the records that exist
 * and add none, push ONE quiet corrective on the alarm's own tag with
 * `replace` set, and push nothing when nothing was ever recorded.
 *
 * And one fix found by the audit: `escalateStall` remembered every episode in
 * `escalatedStalls` even when the prefs gate had suppressed the urgent
 * re-say — so the later all-clear pushed "the stall cleared" for a buzz that
 * never happened. Only an escalation that was actually announced is owed an
 * all-clear.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { tagFor } from '../server/push/index.ts';

type Pushed = { category: string; message: { title: string; tag: string }; opts: unknown };

/** A service whose push and webhook legs record rather than send. */
function harness() {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Pushed[] = [];
  sv.push.announce = ((category: string, message: Pushed['message'], _now: number, _cb: unknown, opts: unknown) => {
    pushed.push({ category, message, opts });
  }) as typeof sv.push.announce;
  const hooked: string[] = [];
  sv.webhooks.announce = ((category: string) => { hooked.push(category); }) as typeof sv.webhooks.announce;
  // Everything a corrective touches is protected on the class; the test reaches
  // in deliberately, because the contract is about internals that must hold.
  const inner = sv as unknown as {
    notifications: {
      list(): { items: { category: string; title: string; resolved?: unknown; read: boolean }[] };
      clear(what: 'all'): number;
    };
    prefs: { notify: Record<string, boolean> };
    runners: Map<string, unknown>;
    stallEscalations: Map<string, unknown>;
    escalatedStalls: Map<string, unknown>;
    announce: (...args: unknown[]) => unknown;
    retractHalt: (state: unknown, reason: string, opts: { push: boolean }) => void;
    retractStall: (scope: unknown, reason: string) => void;
    escalateStall: (key: string) => void;
  };
  // The state directory is sandboxed per PROCESS, not per test, so every
  // `new Service()` in this file loads the same inbox file — a record left by
  // an earlier case would otherwise be counted by the next one.
  inner.notifications.clear('all');
  return { sv, inner, pushed, hooked };
}

/** The inbox oldest-first — `list()` reads newest-first, as an inbox is read. */
function records(inner: { notifications: { list(): { items: { category: string; title: string; resolved?: unknown; read: boolean }[] } } }) {
  return inner.notifications.list().items.slice().reverse();
}

test('retractHalt annotates the halt it finds, pushes one quiet replace, records nothing new', () => {
  const { sv, inner, pushed, hooked } = harness();
  try {
    inner.announce('halted', { title: 'demo halted', body: 'verification red', tag: tagFor('run', 'run-1', 'halted') },
      { slug: 'demo', runId: 'run-1' });
    assert.equal(records(inner).length, 1);
    assert.equal(pushed.length, 1, 'the alarm went out through the choke point');
    assert.deepEqual(hooked, ['halted']);

    inner.retractHalt({ id: 'run-1', slug: 'demo' }, 'the board reconciled past it', { push: true });

    const items = records(inner);
    assert.equal(items.length, 1, 'a correction annotates; it does not add');
    assert.ok(items[0].resolved && items[0].read, 'the alarm is resolved and read');
    assert.equal(pushed.length, 2, 'one corrective push');
    assert.equal(pushed[1].message.tag, pushed[0].message.tag, 'the corrective rides the alarm\'s own tag');
    assert.deepEqual(pushed[1].opts, { urgent: false, replace: true });
    assert.deepEqual(hooked, ['halted'], 'no webhook for an all-clear');
  } finally {
    sv.close();
  }
});

test('retractHalt with nothing recorded pushes nothing — the record is the proof a buzz happened', () => {
  const { sv, inner, pushed } = harness();
  try {
    inner.retractHalt({ id: 'run-none', slug: 'demo' }, 'nothing to retract', { push: true });
    assert.equal(pushed.length, 0);
  } finally {
    sv.close();
  }
});

test('retractStall sends an all-clear only for an episode that escalated, on that episode\'s tag', () => {
  const { sv, inner, pushed } = harness();
  try {
    inner.announce('stalled', { title: 'Nothing is happening — demo P2', body: 'silent', tag: tagFor('stalled', 'demo', 2, 'silent') },
      { slug: 'demo', phase: 2, runId: 'run-2' });
    // A quiet stall that never escalated: standing it down is inbox-only.
    inner.retractStall({ runId: 'run-2', phase: 2 }, 'the lane produced work');
    assert.equal(pushed.length, 1, 'no corrective for a card that never buzzed');
    assert.ok(records(inner)[0].resolved);

    // The same stall, escalated: remembered, so its all-clear replaces the urgent card.
    inner.announce('stalled', { title: 'Still stalled', body: 'b', tag: tagFor('stalled', 'demo', 2, 'silent', 'escalated') },
      { slug: 'demo', phase: 2, runId: 'run-2' }, { urgent: true });
    inner.escalatedStalls.set('run-2:2', { slug: 'demo', phase: 2, runId: 'run-2', signal: 'silent' });
    inner.retractStall({ runId: 'run-2', phase: 2 }, 'the phase ended');
    assert.equal(pushed.length, 3);
    assert.equal(pushed[2].message.tag, tagFor('stalled', 'demo', 2, 'silent', 'escalated'));
    assert.deepEqual(pushed[2].opts, { urgent: false, replace: true });
    assert.equal(inner.escalatedStalls.size, 0, 'the episode is forgotten once stood down');
  } finally {
    sv.close();
  }
});

test('escalateStall remembers an episode only when the urgent re-say was actually announced', () => {
  const { sv, inner, pushed } = harness();
  try {
    const live = { id: 'run-3', status: 'running', phases: { 2: { stall: { signal: 'silent' } } } };
    inner.runners.set('demo', { current: () => live });
    const arm = (key: string) => inner.stallEscalations.set(key, {
      timer: setTimeout(() => {}, 0), slug: 'demo', phase: 2, runId: 'run-3', signal: 'silent',
      title: 'Nothing is happening — demo P2', body: 'silent.', at: Date.now() - 45 * 60_000,
    });

    // Suppressed by the prefs gate: no push, and — the fix — no memory of a buzz.
    inner.prefs.notify.stalled = false;
    arm('run-3:2:silent');
    inner.escalateStall('run-3:2:silent');
    assert.equal(pushed.length, 0);
    assert.equal(inner.escalatedStalls.size, 0, 'a suppressed escalation is owed no all-clear');

    // Allowed: pushed urgent, and remembered.
    inner.prefs.notify.stalled = true;
    arm('run-3:2:silent');
    inner.escalateStall('run-3:2:silent');
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0].opts, { urgent: true });
    assert.equal(inner.escalatedStalls.size, 1);
    // …and the record carries the override, so the inbox agrees with the wire.
    const items = records(inner);
    assert.equal(items[0].category, 'stalled');
    assert.equal((items[0] as { urgent?: boolean }).urgent, true);
  } finally {
    sv.close();
  }
});

/* ------------------------------------------------------------------ *
 * The content audit's fixes (register N5–N11)
 * ------------------------------------------------------------------ */

type Live = ReturnType<typeof harness>['inner'] & {
  onRunnerEvent: (event: string, data: unknown) => void;
  announcePhase: (data: unknown) => void;
  announceErrand: (data: unknown) => void;
  announceQaHold: (data: unknown) => void;
  announceStall: (data: unknown) => void;
  notifiedStall: Set<string>;
  notifiedRun: Map<string, string>;
};

test('an interrupted run rides the halted tag, so its retraction replaces the right card', () => {
  const { sv, inner, pushed } = harness();
  const live = inner as Live;
  try {
    const state = { id: 'run-7', slug: 'demo', status: 'interrupted', phases: {}, spentUsd: 0, halt: null };
    live.onRunnerEvent('run:run', { state });
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].category, 'halted');
    assert.equal(pushed[0].message.tag, tagFor('run', 'run-7', 'halted'), 'tagged by category, not status');
    assert.equal(live.notifiedRun.get('run-7'), 'interrupted');

    // The run moved on: the retraction gate must recognise the interrupted memory.
    live.onRunnerEvent('run:run', { state: { ...state, status: 'running' } });
    const items = records(inner);
    assert.equal(items.length, 1);
    assert.ok(items[0].resolved, 'the interrupted card stood down when the run resumed');
  } finally {
    sv.close();
  }
});

test('a gated phase announces on `gate`, with the Approve button only for a person\'s gate', () => {
  // The engine spells a person's gate `manual` (and `OVERDUE` past its
  // deadline; `human` is `--gate-kind`'s word) — the fixtures use the words
  // production emits, because a pin on a word it never emits proved nothing.
  const { sv, inner, pushed } = harness();
  const live = inner as Live;
  try {
    live.announcePhase({ slug: 'demo', phase: 2, status: 'gated', gate: { clear: false, kind: 'manual', detail: 'sign the form' } });
    live.announcePhase({ slug: 'demo', phase: 3, status: 'gated', gate: { clear: false, kind: 'OVERDUE', detail: 'was due yesterday' } });
    live.announcePhase({ slug: 'demo', phase: 4, status: 'gated', gate: { clear: false, kind: 'auto' } });
    live.announcePhase({ slug: 'demo', phase: 5, status: 'gated', gate: { clear: false, kind: 'ai', detail: 'a session clears it' } });
    live.announcePhase({ slug: 'demo', phase: 6, status: 'gated', gate: { clear: false, kind: 'manual', detail: 'cmd gate not executed (read-only caller)' } });
    const items = records(inner);
    assert.deepEqual(items.map((i) => i.category), ['gate', 'gate', 'gate', 'gate', 'gate']);
    assert.equal(pushed.length, 5);
    const byPhase = (phase: number) => pushed.find((p) => p.message.tag === tagFor('gate', 'demo', phase));
    assert.ok('actions' in byPhase(2)!.message, 'a manual gate carries the Approve button');
    assert.ok('actions' in byPhase(3)!.message, 'an overdue gate is still a person\'s to clear');
    assert.ok(!('actions' in byPhase(4)!.message), 'an auto gate has nothing a person may press');
    assert.ok(!('actions' in byPhase(5)!.message), 'an ai gate is the session\'s first task, not a button');
    assert.ok(!('actions' in byPhase(6)!.message), 'an unevaluated cmd gate is a read that declined, not a decision');
  } finally {
    sv.close();
  }
});

test('the healer\'s gate errand is the same card as the live gate — same tag, same button', () => {
  const { sv, inner, pushed } = harness();
  const live = inner as Live;
  try {
    live.announcePhase({ slug: 'demo', phase: 2, status: 'gated', gate: { clear: false, kind: 'manual' } });
    live.announceErrand({ slug: 'demo', runId: 'run-8', phase: 2, errand: { at: 't1', need: 'approve the gate', how: 'press Approve', situation: 'gated-manual' } });
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1].category, 'gate');
    assert.equal(pushed[1].message.tag, pushed[0].message.tag, 'the errand replaces the live card');
    assert.ok('actions' in pushed[1].message, 'and keeps the button the inbox offers for it');
  } finally {
    sv.close();
  }
});

test('an errand announces on the fact map\'s category, and two asks about one phase are two tags', () => {
  const { sv, inner, pushed } = harness();
  const live = inner as Live;
  try {
    live.announceErrand({ slug: 'demo', runId: 'run-9', phase: 4, errand: { at: 't1', need: 'verification is red', situation: 'verify-red' } });
    live.announceErrand({ slug: 'demo', runId: 'run-9', phase: 4, errand: { at: 't2', need: 'QA failed', situation: 'qa-failed' } });
    const items = records(inner);
    assert.deepEqual(items.map((i) => i.category), ['halted', 'qa'], 'verify-red → halted, qa-failed → qa, as fact-map.js says');
    assert.notEqual(pushed[0].message.tag, pushed[1].message.tag, 'different situations, different cards');
  } finally {
    sv.close();
  }
});

test('a recorded QA fail is announced on `qa`, replacing the "verdict owed" card', () => {
  const { sv, inner, pushed } = harness();
  const live = inner as Live;
  try {
    live.announceQaHold({ slug: 'demo', runId: 'run-10', phase: 5, qaVerdict: 'pending' });
    live.announceQaHold({ slug: 'demo', runId: 'run-10', phase: 5, qaVerdict: 'fail' });
    const items = records(inner);
    assert.equal(items.length, 2);
    assert.match(items[1].title, /QA failed/);
    assert.equal(pushed[1].message.tag, pushed[0].message.tag, 'one tag per phase: the fail replaces the owed card');
    assert.ok((items[1] as { urgent?: boolean }).urgent, 'qa is urgent by catalogue');
  } finally {
    sv.close();
  }
});

test('a stall that clears and returns on the same signal is announced again', () => {
  const { sv, inner } = harness();
  const live = inner as Live;
  try {
    const stall = { slug: 'demo', runId: 'run-11', phase: 1, attempt: 1, stall: { signal: 'silent', detail: 'silent for ten minutes' } };
    live.announceStall(stall);
    assert.equal(records(inner).length, 1);
    live.announceStall(stall);
    assert.equal(records(inner).length, 1, 'the same open episode is one card');
    live.announceStall({ ...stall, stall: null });
    assert.ok(records(inner)[0].resolved, 'the clear stood the card down');
    live.announceStall(stall);
    assert.equal(records(inner).length, 2, 'a new episode is a new card, not silence');
  } finally {
    sv.close();
  }
});

test('Service.announce threads `replace` to the push leg', () => {
  const { sv, inner, pushed } = harness();
  try {
    inner.announce('phase', { title: 'a', body: 'b', tag: 't' }, { slug: 'demo', phase: 1 }, { replace: true });
    inner.announce('phase', { title: 'a', body: 'b', tag: 't' }, { slug: 'demo', phase: 1 });
    assert.deepEqual(pushed[0].opts, { replace: true });
    assert.equal(pushed[1].opts, undefined, 'nothing is passed when nothing was asked');
  } finally {
    sv.close();
  }
});
