/**
 * The strip's model — which ONE action a strip offers, and what it says.
 *
 * Pure, so every rule is an exact assertion with no DOM in it. The properties
 * worth pinning, in the order they would break:
 *
 *  1. **One action, chosen by bay.** A stopped run offers the halt card's own
 *     recommended verb (`recoveryActionsFor`'s first the strip can press); a
 *     live one offers the lifecycle verb that fits its state; a read-only
 *     console offers the one move that needs no flag — Open run.
 *  2. **The pulse is observed, never assumed.** A lane whose status says
 *     `running` but whose session has gone quiet — or was never heard from, or
 *     is frozen — does not breathe.
 *  3. **Every figure is labelled.** The clock carries its verb; the cost counts
 *     the session in flight, which the run's own total books only at its end.
 */

import { describe, expect, it } from 'vitest';

import { haltView } from '@shared/halt-view.js';
import { STALL_DEFAULTS } from '@shared/attention-model.js';
import type { NowLane } from '@/features/runs/lanes-model';
import { nowLanes } from '@/features/runs/lanes-model';
import type { QueueEntry, RunState } from '@/lib/api';
import { observedLive, stripModel, type StripInput } from './strip-model';

const NOW = Date.parse('2026-09-29T10:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Phase = { phase: number; status: string } & Record<string, unknown>;

function run(over: Partial<RunState> & { id: string; slug: string }, phases: Phase[]): RunState {
  const table: Record<string, unknown> = {};
  for (const p of phases) table[String(p.phase)] = { attempts: 1, costUsd: 0, ...p };
  return {
    root: '/repo',
    status: 'running',
    model: 'opus',
    autonomy: 'keep-going',
    spentUsd: 4.2,
    runBudgetUsd: 25,
    createdAt: iso(NOW - 3 * 60 * MIN),
    updatedAt: iso(NOW - MIN),
    activePhase: phases[0]?.phase ?? null,
    phases: table,
    ...over,
  } as unknown as RunState;
}

const child = (phase: number, over: Record<string, unknown> = {}) => ({
  pid: 100 + phase,
  phase,
  sessionId: `s${phase}`,
  startedAt: iso(NOW - 12 * MIN),
  ...over,
});

/** A lane that spoke `agoMs` ago, with no stall on record. */
const heard = (agoMs: number) => ({
  phase: 6,
  lastOutputAt: iso(NOW - agoMs),
  turnsSinceLastTool: 0,
  commitsSinceStart: 0,
  treeDirty: false,
});

function input(r: RunState, over: Partial<StripInput> = {}): StripInput {
  return { run: r, lanes: nowLanes([r]), now: NOW, allowRun: true, ...over };
}

/* ------------------------------------------------------------------ *
 * Fixtures — one run per bay the board draws today
 * ------------------------------------------------------------------ */

const live = () =>
  run({ id: 'r-live', slug: 'console-speed', children: { 6: child(6) } }, [
    { phase: 5, status: 'done' },
    {
      phase: 6,
      status: 'running',
      attemptStartedAt: iso(NOW - 14 * MIN),
      startedAt: iso(NOW - 14 * MIN),
      liveness: heard(20_000),
      live: { spentUsd: 1.3 },
    },
    { phase: 7, status: 'pending' },
  ]);

const halted = () =>
  run(
    {
      id: 'r-halt',
      slug: 'checkout',
      status: 'halted',
      halt: { at: iso(NOW - 12 * MIN - 3_000), kind: 'verify-failed', reason: 'red', phase: 5 },
    },
    [
      { phase: 4, status: 'done' },
      { phase: 5, status: 'failed', sessionId: 's5' },
    ],
  );

const queued = (over: Partial<RunState> = {}) =>
  run({ id: 'r-q', slug: 'gamma', status: 'queued', ...over }, [
    { phase: 1, status: 'queued', queuedAt: iso(NOW - 3 * MIN) },
  ]);

const frozen = () =>
  run(
    {
      id: 'r-frz',
      slug: 'delta',
      status: 'frozen',
      freeze: { at: iso(NOW - 2 * MIN), by: 'me', phase: null, pid: 102 },
      children: { 2: child(2, { frozen: { at: iso(NOW - 2 * MIN), by: 'me' } }) },
    } as Partial<RunState> & { id: string; slug: string },
    [{ phase: 2, status: 'running' }],
  );

/* ------------------------------------------------------------------ *
 * 1. One action, chosen by bay
 * ------------------------------------------------------------------ */

describe('the one action — chosen by bay, through the lifecycle or the recovery model', () => {
  it('a live run pauses at its next boundary', () => {
    const model = stripModel(input(live()));
    expect(model.bay).toBe('live');
    expect(model.action).toMatchObject({ kind: 'lifecycle', verb: 'pause', label: 'Pause' });
  });

  it('a run already pausing offers to cancel the pause, not a second one', () => {
    const model = stripModel(input({ ...live(), status: 'pausing' } as RunState));
    expect(model.action).toMatchObject({ kind: 'lifecycle', verb: 'resume', label: 'Cancel pause' });
  });

  it('a stopped run offers the halt card’s own recommended verb', () => {
    const r = halted();
    const model = stripModel(input(r));
    const recommended = haltView(r, {})?.recommended;
    expect(recommended, 'the fixture must have a recommendation to compare').toBeTruthy();
    expect(model.action).toMatchObject({ kind: 'recovery', id: recommended!.id });
    expect(model.action.kind === 'recovery' && model.action.target).toEqual({
      slug: 'checkout',
      phase: 5,
      runId: 'r-halt',
    });
  });

  it('a frozen run thaws — whatever its lanes say', () => {
    const model = stripModel(input(frozen()));
    expect(model.action).toMatchObject({ kind: 'lifecycle', verb: 'thaw', label: 'Thaw' });
  });

  it('a queued run is held — and a held one released', () => {
    const entry = { id: 'e1', slug: 'gamma', phase: 1, since: NOW - 3 * MIN } as QueueEntry;
    expect(stripModel(input(queued(), { entry })).action).toMatchObject({ kind: 'lifecycle', verb: 'hold' });
    const held = queued({ hold: { at: iso(NOW - MIN), by: 'me' } });
    expect(stripModel(input(held, { entry })).action).toMatchObject({
      kind: 'lifecycle',
      verb: 'release',
      label: 'Release',
    });
  });

  it('a run paused by you resumes', () => {
    const r = run(
      { id: 'r-p', slug: 'eps', status: 'paused', stoppedBy: 'operator' } as Partial<RunState> & {
        id: string;
        slug: string;
      },
      [{ phase: 3, status: 'pending' }],
    );
    expect(stripModel(input(r)).action).toMatchObject({ kind: 'lifecycle', verb: 'resume', label: 'Resume' });
  });

  it('a settled run opens — there is nothing left to press', () => {
    const r = run({ id: 'r-f', slug: 'done-plan', status: 'finished' }, [{ phase: 1, status: 'done' }]);
    const model = stripModel(input(r, { lanes: [] }));
    expect(model.bay).toBe('settled');
    expect(model.action).toMatchObject({ kind: 'open', label: 'Open run' });
  });

  it('a read-only console offers Open run on every strip — never a button that answers 403', () => {
    for (const r of [live(), halted(), queued(), frozen()]) {
      expect(stripModel(input(r, { allowRun: false })).action.kind).toBe('open');
    }
  });

  it('always exactly one: every fixture yields one action object', () => {
    for (const r of [live(), halted(), queued(), frozen()]) {
      const action = stripModel(input(r)).action;
      expect(['lifecycle', 'recovery', 'open']).toContain(action.kind);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. The pulse is observed, never assumed
 * ------------------------------------------------------------------ */

describe('observedLive — the pulse needs a lane that is heard from now', () => {
  const lane = (over: Partial<NowLane>): NowLane => ({ ...nowLanes([live()])[0]!, ...over });

  it('breathes for a running lane with a process that spoke recently', () => {
    expect(observedLive(lane({}), NOW)).toBe(true);
    expect(stripModel(input(live())).pulse).toBe(true);
  });

  it('does not breathe once the lane has been silent past the stall floor', () => {
    const quiet = lane({ liveness: heard(STALL_DEFAULTS.stallSilentMs + 1_000) });
    expect(observedLive(quiet, NOW)).toBe(false);
  });

  it('does not breathe on a stall the runner recorded, a frozen lane, or one never heard from', () => {
    const stalled = lane({
      liveness: { ...heard(1_000), stall: { signal: 'silent', since: iso(NOW - MIN), detail: 'x' } },
    });
    expect(observedLive(stalled, NOW)).toBe(false);
    expect(observedLive(lane({ frozen: true }), NOW)).toBe(false);
    const { liveness: _gone, ...unheard } = lane({});
    expect(observedLive(unheard as NowLane, NOW)).toBe(false);
    expect(observedLive(lane({ child: undefined }), NOW)).toBe(false);
  });

  it('a run with no observed lane does not pulse, however its status reads', () => {
    const r = live();
    const quiet = { ...r, phases: { ...r.phases, 6: { ...r.phases['6']!, liveness: heard(60 * MIN) } } };
    expect(stripModel(input(quiet as RunState)).pulse).toBe(false);
    expect(stripModel(input(frozen())).pulse).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Every figure labelled
 * ------------------------------------------------------------------ */

describe('the glance figures', () => {
  it('a live run reads its attempt clock with the verb "running"', () => {
    const { clock } = stripModel(input(live()));
    expect(clock).toMatchObject({ verb: 'running', tense: 'for', label: 'this attempt' });
    expect(clock.ms).toBe(14 * MIN);
  });

  it('a stopped run reads how long ago it halted', () => {
    expect(stripModel(input(halted())).clock).toMatchObject({
      verb: 'halted',
      tense: 'ago',
      ms: 12 * MIN + 3_000,
    });
  });

  it('a frozen run reads how long ago it was frozen, a queued one how long it has queued', () => {
    expect(stripModel(input(frozen())).clock).toMatchObject({ verb: 'frozen', tense: 'ago', ms: 2 * MIN });
    const entry = { id: 'e1', slug: 'gamma', phase: 1, since: NOW - 3 * MIN } as QueueEntry;
    expect(stripModel(input(queued(), { entry })).clock).toMatchObject({ verb: 'queued', ms: 3 * MIN });
  });

  it('a settled run reads what it worked for — "ran"', () => {
    const r = run({ id: 'r-f', slug: 'done-plan', status: 'finished' }, [
      { phase: 1, status: 'done', durationMs: 64 * MIN },
    ]);
    expect(stripModel(input(r, { lanes: [] })).clock).toMatchObject({
      verb: 'ran',
      tense: 'for',
      ms: 64 * MIN,
    });
  });

  it('the cost counts the session in flight, which the run books only when it ends', () => {
    const { cost } = stripModel(input(live()));
    expect(cost.spentUsd).toBeCloseTo(4.2 + 1.3);
    expect(cost.budgetUsd).toBe(25);
    expect(cost.fraction).toBeCloseTo(5.5 / 25);
  });

  it('the track is every phase touched, in order, with done counted', () => {
    const model = stripModel(input(live()));
    expect(model.track.map((p) => p.phase)).toEqual([5, 6, 7]);
    expect([model.done, model.total]).toEqual([1, 3]);
  });
});
