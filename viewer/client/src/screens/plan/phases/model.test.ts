/**
 * The phases grid's model (7.0, quiet-console phase 10; the grouping cases
 * ported from `features/runs/phase-groups.test.tsx`).
 *
 * The grouping must be EXHAUSTIVE over the board vocabulary. It was not:
 * `PHASE_GROUPS` named five of the seven board words, and the grouper falls an
 * unrecognised state through to `waiting` on purpose — so `gated` and
 * `blocked`, the two states the shared table calls `needs-you`, filed
 * themselves under Waiting: the one group a reader scrolls past. Nothing
 * failed, because nothing compared the two lists.
 *
 * That fallback is still right (a row that vanishes because the server learned
 * a new word is the worst outcome), which is exactly why it needs a test above
 * it: a default that silently absorbs a missing word cannot also be the thing
 * that tells you a word is missing.
 *
 * Below the grouping, the few rules every row is read through: the board
 * decides the word and a run only overlays `in-progress` on it, a lane is
 * "running" only while this run's session is open on it, the spend counts the
 * session in flight, and the readings say what each one leads with.
 */

import { describe, expect, it } from 'vitest';
import type { PhaseRecord, PhaseView, RunState } from '@/data/api';
import { BOARD_STATES, boardUiState } from '@/lib/status-vocab';
import {
  DONE_FOLDED,
  NEED_LABEL,
  NEED_RANK,
  PHASE_GROUPS,
  PHASE_TABLE_CONTEXTS,
  PHASE_VIRTUAL_FROM,
  displayState,
  groupPhases,
  mcpCallWords,
  modelMismatch,
  needOf,
  phaseGroupOf,
  qaWordOf,
  runningOf,
  spendOf,
  type PhaseTableRow,
} from './model';

const covered = new Set(PHASE_GROUPS.flatMap((g) => g.states as readonly string[]));

describe('the phase grouping covers the board vocabulary', () => {
  it('names every board state, so none can fall through the default', () => {
    const missing = BOARD_STATES.filter((s) => !covered.has(s));
    expect(missing, `board states no group claims: ${missing.join(', ')}`).toEqual([]);
  });

  it('files every needs-you board state under Needs you', () => {
    const needsYou = BOARD_STATES.filter((s) => boardUiState(s) === 'needs-you');
    // `gated` and `blocked` are the two this test exists for; assert the set
    // rather than the pair, so a new needs-you word is caught the same way.
    expect(needsYou.length).toBeGreaterThanOrEqual(3);
    for (const state of needsYou) {
      expect(phaseGroupOf({ phase: 1, state }), `${state} must group under needs-you`).toBe('needs-you');
    }
  });

  it('groups nothing it has not been told about — the fallback still holds', () => {
    expect(phaseGroupOf({ phase: 1, state: 'a-word-the-server-just-learned' })).toBe('waiting');
  });
});

describe('the five needs', () => {
  it('a phase this run is working on reads in progress whatever the board still says — never over done', () => {
    expect(displayState('ready', { running: true })).toBe('in-progress');
    expect(displayState('ready', { running: false })).toBe('ready');
    // The board saying done is the work finished; a run record never overrules it.
    expect(displayState('done', { running: true })).toBe('done');
    expect(phaseGroupOf({ phase: 2, state: 'ready', record: { status: 'running' } })).toBe('running');
    expect(phaseGroupOf({ phase: 2, state: 'done', record: { status: 'running' } })).toBe('done');
  });

  it('groups by need in need order, needs-you first, and drops the empty groups', () => {
    const rows = [
      { phase: 1, state: 'done' },
      { phase: 2, state: 'waiting' },
      { phase: 3, state: 'gated' },
      { phase: 4, state: 'ready' },
      { phase: 5, state: 'ready' },
    ];
    const groups = groupPhases(rows);
    expect(groups.map((g) => g.id)).toEqual(['needs-you', 'ready', 'waiting', 'done']);
    expect(groups.find((g) => g.id === 'ready')!.rows.map((r) => r.phase)).toEqual([4, 5]);
    // The heading words and the order the Need column groups by are the groups' own.
    expect(PHASE_GROUPS.map((g) => NEED_LABEL[g.id])).toEqual([
      'Needs you',
      'Running',
      'Ready',
      'Waiting',
      'Done',
    ]);
    expect(PHASE_GROUPS.map((g) => NEED_RANK[g.id])).toEqual([0, 1, 2, 3, 4]);
  });
});

const view = (over: Partial<PhaseView> = {}): PhaseView =>
  ({ phase: 4, title: 'A phase', state: 'ready', size: 'M', weight: 1, gated: false, ...over }) as PhaseView;

const record = (over: Partial<PhaseRecord> = {}): PhaseRecord =>
  ({ phase: 4, status: 'running', attempts: 1, costUsd: 0, ...over }) as PhaseRecord;

const row = (over: { record?: PhaseRecord; live?: boolean; state?: string } = {}): PhaseTableRow => ({
  p: {
    ...view(over.state ? { state: over.state } : {}),
    elsewhere: false,
    ...(over.record ? { record: over.record } : {}),
  },
  scope: {
    slug: 'demo',
    run: null as RunState | null,
    live: over.live ?? true,
    allowRun: true,
    onRunAlone: () => {},
  },
  rulings: 0,
  holds: [],
});

describe('a row', () => {
  it('is running only while THIS run has a session open on it, on a live run', () => {
    const open = record({ startedAt: '2026-10-10T01:00:00Z' });
    expect(runningOf(row({ record: open }))).toBe(true);
    expect(runningOf(row({ record: { ...open, status: 'verifying' } }))).toBe(true);
    // A run that is not live drives nothing, whatever its record still says.
    expect(runningOf(row({ record: open, live: false }))).toBe(false);
    // An ended session, an unstarted one, a parked one: not running.
    expect(runningOf(row({ record: { ...open, endedAt: '2026-10-10T01:30:00Z' } }))).toBe(false);
    expect(runningOf(row({ record: record({}) }))).toBe(false);
    expect(runningOf(row({ record: { ...open, status: 'parked' } }))).toBe(false);
    expect(runningOf(row())).toBe(false);
  });

  it('files under its need through the same rule the groups use', () => {
    expect(needOf(row({ state: 'stuck' }))).toBe('needs-you');
    expect(needOf(row({ state: 'ready', record: record({}) }))).toBe('running');
    expect(needOf(row({ state: 'done' }))).toBe('done');
  });

  it('spends the booked sessions plus the one in flight — and nothing is not a figure', () => {
    expect(spendOf(undefined)).toBeUndefined();
    expect(spendOf(record({ costUsd: 0 }))).toBeUndefined();
    expect(spendOf(record({ costUsd: 1, live: { spentUsd: 0.75 } as PhaseRecord['live'] }))).toBe(1.75);
    // In flight only while running: a parked record's last frame is not spend.
    expect(
      spendOf(record({ status: 'parked', costUsd: 1, live: { spentUsd: 0.75 } as PhaseRecord['live'] })),
    ).toBe(1);
  });

  it('a #91 model mismatch is a PARKED record that carries one — a record that boarded again is not', () => {
    const mismatch = {
      requested: 'claude-fable-5-1',
      resolved: 'claude-opus-5-5',
      at: '2026-09-24T10:00:00Z',
    };
    expect(modelMismatch(record({ status: 'parked', modelMismatch: mismatch }))).toBe(true);
    expect(modelMismatch(record({ status: 'done', modelMismatch: mismatch }))).toBe(false);
    expect(modelMismatch(record({ status: 'parked' }))).toBe(false);
    expect(modelMismatch(undefined)).toBe(false);
  });

  it('reads its QA word as a verdict, pending, or none — never a blank', () => {
    expect(qaWordOf(view({ qa: { result: 'fail' } }))).toBe('fail');
    expect(qaWordOf(view({ qa: { result: 'pending' } }))).toBe('pending');
    expect(qaWordOf(view())).toBe('none');
  });

  it('says which attached servers a phase reached for, in words', () => {
    expect(mcpCallWords({ github: 3, linear: 1 })).toBe('github 3 times, linear 1 time');
  });
});

describe('the readings', () => {
  it('the run and the plan group by need; Handoffs & QA opens in plan order', () => {
    expect(PHASE_TABLE_CONTEXTS.run.groupBy).toBe('need');
    expect(PHASE_TABLE_CONTEXTS.plan.groupBy).toBe('need');
    // Its subject is mostly finished phases, which grouping by need would fold under Done.
    expect(PHASE_TABLE_CONTEXTS['plan-record'].groupBy).toBeUndefined();
    // Each reading keeps its own view, so a column hidden on one is not hidden on another.
    const ids = Object.values(PHASE_TABLE_CONTEXTS).map((c) => c.tableId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Handoffs & QA is ONE reading of the record: both halves lead, and an opened row leads with them', () => {
    // 2026-10-20 (Tower strips): the QA reading and the Handoffs reading were
    // two halves of one record. The merged one shows both, in plan order…
    expect(Object.keys(PHASE_TABLE_CONTEXTS).sort()).toEqual(['plan', 'plan-record', 'run']);
    const record = PHASE_TABLE_CONTEXTS['plan-record'];
    for (const id of ['phase', 'state', 'blockedBy', 'handoff', 'qa', 'lane', 'actions']) {
      expect(record.hidden, `${id} leads`).not.toContain(id);
    }
    expect(record.lead).toBe('record');
    expect(record.label).toBe('Handoffs and QA by phase');
    // …under a table id of its own, so a column choice saved under the old
    // QA-only or handoff-only reading cannot hide the other half here.
    expect(record.tableId).toBe('phases.plan-record');
    expect(PHASE_TABLE_CONTEXTS.plan.lead).toBeUndefined();
    expect(PHASE_TABLE_CONTEXTS.run.lead).toBeUndefined();
  });

  it('folds Done until someone opens it, and windows a plan past forty phases', () => {
    expect(DONE_FOLDED).toEqual(['need:done']);
    expect(PHASE_VIRTUAL_FROM).toBe(40);
  });
});
