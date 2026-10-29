/**
 * Why a plan's status says what it says (the Plans page's status button and
 * its drawer): every status a row can lead with is answered by the concrete
 * things behind it, in words a person can act on — never the bare word again.
 *
 *   - Needs you: the items of Your turn the plan holds, a gate only a person
 *     opens, and what more is coming up;
 *   - Waiting: what the run waits on and until when, the queue's line,
 *     another session's claim, the dependency at the front of the chain, a
 *     gate that clears itself;
 *   - Running: which phases a session is on, and since when;
 *   - Halted, parked, stuck: the run's stop (for the halt card), the board's
 *     stuck phases and QA's verdicts;
 *   - Complete, abandoned, closed: how it ended;
 *   - a document: what it is.
 */

import { describe, expect, it } from 'vitest';
import { CAUSE_SENTENCE } from '@shared/halt-categories.js';
import { CLOSED_HELP } from '@/lib/closure';
import type { InboxItem, PhaseView, PlanSummaryFull, QueueViewEntry } from '@/data/api';
import { toRows, type PlanRow } from './model';
import { liveNowOf, waitsOnOf, whyOf, type PlanWhy, type WhyInput } from './why';

const NOW = Date.parse('2026-10-20T06:00:00Z');

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull =>
  ({
    slug: 'alpha',
    title: 'Alpha plan',
    kind: 'plan',
    status: 'active',
    activity: NOW - 3_600_000,
    phases: 6,
    done: 2,
    ready: [],
    waiting: 2,
    inProgress: [],
    stuck: [],
    percent: 33,
    remainingWeight: 0,
    remainingSessions: 2,
    criticalPath: [],
    criticalWeight: 0,
    minimumSessions: 0,
    budget: 0,
    skills: [],
    mcpServers: [],
    qaMode: 'off',
    qaFailures: [],
    locks: [],
    repos: ['hub'],
    handoffCount: 2,
    issues: [],
    issueCounts: { error: 0, warning: 0, info: 0 },
    hasHandoffs: true,
    ...over,
  }) as PlanSummaryFull;

const slimRun = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  slug: 'alpha',
  status: 'running',
  lifecycle: { state: 'running' },
  activePhase: null,
  halt: null,
  children: {},
  verifying: {},
  liveness: [],
  phases: {},
  records: {},
  waitUntil: null,
  accountId: null,
  consecutiveFailures: 0,
  createdAt: new Date(NOW - 7_200_000).toISOString(),
  updatedAt: new Date(NOW - 60_000).toISOString(),
  finishedReason: null,
  resolved: false,
  stoppedBy: 'system',
  onLimit: 'switch',
  waitReason: null,
  hold: null,
  freeze: null,
  pause: null,
  spentUsd: 12.5,
  liveUsd: 0,
  runBudgetUsd: null,
  workedMs: 1000,
  model: 'opus',
  effort: 'high',
  maxConsecutiveFailures: 2,
  undriven: [],
  ...over,
});

const errand = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: 'errand:alpha:3:r1:blocked-declared%3Ahuman-acts',
    kind: 'errand',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: 'Decide whether the fix release goes first',
    need: 'Make a decision: add a fix release before Release B?',
    how: 'Choose one of the options and send your decision.',
    since: new Date(NOW - 600_000).toISOString(),
    actions: [],
    href: '',
    turn: {
      item: 'errand:alpha:3:r1:blocked-declared%3Ahuman-acts',
      record: 'projected',
      source: 'errand',
      kind: 'operator-act',
      group: 'decide',
      type: 'decide',
      readiness: 'now',
    },
    ...over,
  }) as InboxItem;

const upcoming = (id: string): InboxItem =>
  ({
    id,
    kind: 'human-step',
    severity: 'fyi',
    slug: 'alpha',
    title: 'Pick the clock for saved strategies',
    need: 'It is your decision to make.',
    how: '',
    since: new Date(NOW - 60_000).toISOString(),
    actions: [],
    href: '',
    turn: { item: id, record: 'ledger', group: 'upcoming', type: 'decide', readiness: 'not-yet' },
  }) as unknown as InboxItem;

const phaseView = (over: Partial<PhaseView> & Pick<PhaseView, 'phase' | 'state'>): PhaseView =>
  ({ title: `Phase ${over.phase} work`, size: 'M', weight: 1, gated: false, ...over }) as PhaseView;

function read(
  summary: PlanSummaryFull,
  runs: unknown[] = [],
  inbox: InboxItem[] = [],
  extra: Omit<WhyInput, 'row' | 'now'> = {},
): { row: PlanRow; why: PlanWhy } {
  const row = toRows([summary], runs as Parameters<typeof toRows>[1], NOW, inbox)[0]!;
  return { row, why: whyOf({ row, now: NOW, ...extra }) };
}

const section = (why: PlanWhy, key: string) => why.sections.find((s) => s.key === key);
const texts = (why: PlanWhy, key: string) => section(why, key)?.reasons.map((r) => r.text) ?? [];

/** Every reason is a sentence a person can act on: never a bare status word. */
function expectConcrete(why: PlanWhy) {
  expect(why.headline.split(/\s+/).length, `headline: ${why.headline}`).toBeGreaterThan(3);
  for (const s of why.sections) {
    expect(s.reasons.length, s.key).toBeGreaterThan(0);
    for (const reason of s.reasons) {
      expect(reason.text.split(/\s+/).length, `${s.key}: ${reason.text}`).toBeGreaterThanOrEqual(2);
      expect(reason.text).not.toMatch(/^(Running|Waiting|Parked|Halted|Needs you|Active|Complete)\.?$/);
      expect(reason.text).not.toMatch(/cmd:|\/api\/|phase 0\b/);
      if (reason.href) expect(reason.act, `${s.key}: ${reason.text} says where it goes`).toBeTruthy();
    }
  }
}

describe('Needs you — what exactly needs you', () => {
  it('names each item of Your turn the plan asks now, with the way to it, and counts what is coming up', () => {
    const { row, why } = read(plan(), [], [errand(), upcoming('step:a'), upcoming('step:b')]);
    expect(row.turn).toEqual({ open: 3, now: 1 });
    expect(why.word).toBe('Needs you');
    expect(why.headline).toBe('It needs you: Decide whether the fix release goes first.');
    const you = section(why, 'you')!;
    expect(you.title).toBe('What needs you');
    expect(you.reasons[0]).toMatchObject({
      text: 'Decide whether the fix release goes first',
      detail: 'Make a decision: add a fix release before Release B?',
      phase: 3,
      href: '#/turn/errand%3Aalpha%3A3%3Ar1%3Ablocked-declared%253Ahuman-acts',
      act: 'Open it on Your turn',
      clock: 'since',
    });
    expect(you.reasons[0]!.item?.id).toBe(errand().id);
    expect(you.reasons.at(-1)).toMatchObject({
      text: '2 more items of this plan are coming up or being checked on Your turn.',
      href: '#/plan/alpha/turn',
    });
    expectConcrete(why);
  });

  it('says how many things wait on you, and quotes the oldest', () => {
    const second = errand({
      id: 'errand:alpha:4:r1:x',
      phase: 4,
      title: 'Approve the release',
      since: new Date(NOW - 60_000).toISOString(),
      turn: { ...errand().turn!, item: 'errand:alpha:4:r1:x' },
    });
    const { why } = read(plan(), [], [errand(), second]);
    expect(why.headline).toBe(
      '2 things wait on you. The oldest is “Decide whether the fix release goes first”.',
    );
    expect(section(why, 'you')!.reasons.map((r) => r.text)).toEqual([
      'Decide whether the fix release goes first',
      'Approve the release',
    ]);
  });

  it('names a gate only a person opens on a phase that is ready, from the plan’s detail', () => {
    const { why } = read(plan({ ready: [4], waiting: 1 }), [], [], {
      detail: {
        phases: [
          phaseView({
            phase: 4,
            state: 'ready',
            gated: true,
            gateKind: 'human',
            gates: 'The owner signs off the release.\nThen it ships.',
          }),
        ],
        locks: [],
      },
    });
    expect(section(why, 'you')!.reasons[0]).toMatchObject({
      text: 'Phase 4 is ready, and its gate waits for your approval.',
      detail: 'The owner signs off the release.',
      href: '#/plan/alpha/phase/4',
      act: 'Open phase 4',
    });
    expectConcrete(why);
  });
});

describe('Waiting — waiting on what, and until when', () => {
  it('says what the run waits on and when it resumes, with the clock', () => {
    const until = '2026-10-20T08:57:00.000Z';
    const { row, why } = read(plan(), [
      // No stored lifecycle: the wait is read off the run's own words, as an older record is.
      slimRun({ status: 'waiting', lifecycle: undefined, waitReason: 'external', waitUntil: until }),
    ]);
    expect(why.word).toBe('Waiting');
    expect(why.headline).toMatch(/^Its run is waiting on .+ resumes 08:57Z\.$/);
    const wait = section(why, 'waits')!.reasons.find((r) => r.key === 'run-wait')!;
    expect(wait).toMatchObject({ at: until, clock: 'until', href: '#/plan/alpha/run' });
    expect(wait.text).toMatch(/^Its run is waiting on .+resumes 08:57Z\.$/);
    expect(waitsOnOf(row, NOW)?.lead).toMatch(/resumes 08:57Z$/);
    expectConcrete(why);
  });

  it('says a usage wall and when it resets', () => {
    const until = '2026-10-20T07:30:00.000Z';
    const { why } = read(plan(), [
      slimRun({
        status: 'waiting',
        lifecycle: { state: 'waiting', wait: { kind: 'usage-limit', until } },
        waitReason: 'usage-limit',
        waitUntil: until,
      }),
    ]);
    expect(why.headline).toMatch(/resets 07:30Z\.$/);
  });

  it('names the dependency at the front of the chain, counts the rest, and a gate that clears itself', () => {
    const { why } = read(plan({ ready: [5], inProgress: [2], waiting: 2 }), [], [], {
      detail: {
        phases: [
          phaseView({ phase: 1, state: 'done' }),
          phaseView({ phase: 2, state: 'in-progress', title: 'Wire the feed' }),
          phaseView({ phase: 3, state: 'waiting', blockedBy: [{ phase: 2, why: 'not-done' }] }),
          phaseView({ phase: 4, state: 'waiting', blockedBy: [{ phase: 3, why: 'not-done' }] }),
          phaseView({
            phase: 5,
            state: 'ready',
            gated: true,
            gateKind: 'ai',
            gateCheck: 'ai verify both conditions',
          }),
        ],
        locks: [],
      },
    });
    const waits = texts(why, 'waits');
    expect(waits).toContain('Phase 3, Phase 3 work waits on phase 2 (in progress).');
    expect(waits).toContain('1 more phase waits further down the chain.');
    expect(waits).toContain('Phase 5, Phase 5 work has a gate, which a session checks before it starts.');
    expect(waits).toContain(
      'Phase 2, Wire the feed reads in progress on the board, and no session of this console is on it.',
    );
    expectConcrete(why);
  });

  it('names its place in the queue and what holds it, and a claim another session holds', () => {
    const entry = {
      id: 'q1',
      slug: 'alpha',
      phase: 4,
      runId: 'r1',
      scope: [],
      since: NOW - 120_000,
      waitingOn: [],
      bypassed: 0,
      reserving: false,
      position: 2,
      class: 'normal',
      account: 'default',
      clocks: { since: new Date(NOW - 120_000).toISOString(), waitedMs: 120_000 },
      reason: { key: 'fifo', text: 'first come', all: [] },
      waits: 'hub P3 (lock)',
    } as unknown as QueueViewEntry;
    const leaseUntil = NOW + 30 * 60_000;
    const { why } = read(plan(), [slimRun({ status: 'queued', lifecycle: { state: 'queued' } })], [], {
      queue: [entry],
      detail: { phases: [], locks: [{ owner: 'alice@laptop', phase: 2, expired: false, leaseUntil }] },
    });
    expect(section(why, 'waits')!.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Phase 4 is queued, number 2 in line.',
          detail: 'hub P3 (lock)',
          clock: 'since',
        }),
        expect.objectContaining({
          text: 'Phase 2 is claimed by alice@laptop.',
          at: new Date(leaseUntil).toISOString(),
          clock: 'until',
          href: '#/plan/alpha/phase/2',
        }),
      ]),
    );
    expectConcrete(why);
  });

  it('never names its own run’s claim as something it waits on', () => {
    const { why } = read(plan(), [slimRun()], [], {
      detail: { phases: [], locks: [{ owner: 'autopilot/r1', phase: 2, expired: false }] },
    });
    expect(texts(why, 'waits').some((text) => text.includes('claimed'))).toBe(false);
  });
});

describe('Running — which phases are live now', () => {
  it('names each phase a session is on, since when, and never a parked lane', () => {
    const startedAt = new Date(NOW - 20 * 60_000).toISOString();
    const { row, why } = read(
      plan({ inProgress: [3, 4] }),
      [
        slimRun({
          activePhase: 4,
          children: { '4': { pid: 1, phase: 4, startedAt } },
          phases: { '3': 'parked', '4': 'running' },
          records: { '3': { resumable: true, situation: { key: 'blocked-declared:human-acts' } } },
        }),
      ],
      [],
      {
        detail: { phases: [phaseView({ phase: 4, state: 'in-progress', title: 'Release A.1' })], locks: [] },
      },
    );
    expect(liveNowOf(row)).toEqual([{ phase: 4, status: 'running', startedAt }]);
    expect(why.word).toBe('Running');
    expect(why.headline).toBe('Its run is working: phase 4 is running.');
    expect(section(why, 'live')!.reasons).toEqual([
      expect.objectContaining({
        text: 'Phase 4, Release A.1',
        lane: 'running',
        at: startedAt,
        clock: 'since',
      }),
    ]);
    // The parked lane is a wait, said with its family's words.
    expect(section(why, 'waits')!.reasons.find((r) => r.key === 'lane:3')).toMatchObject({
      text: 'Phase 3 is parked in its run.',
      detail: 'Needs your decision',
    });
    expectConcrete(why);
  });
});

describe('Stuck, halted, parked — what stopped it and the one recovery', () => {
  const holder = {
    phase: 9,
    kind: 'gate',
    verb: 'approve-gate',
    why: 'gate not clear: blocked — beta phase(s) 14 not verified',
    gate: 'beta phase(s) 14 not verified',
    gateKind: 'blocked',
  };

  it('hands the run’s stop to the halt card, says its sentence, and names what holds it', () => {
    const halt = {
      at: new Date(NOW - 60_000).toISOString(),
      reason: 'nothing left',
      kind: 'nothing-ready',
      holders: [holder],
    };
    const { row, why } = read(plan({ ready: [9], gated: [9] }), [
      slimRun({ status: 'parked', lifecycle: { state: 'parked' }, halt, phases: { '9': 'gated' } }),
    ]);
    expect(why.word).toBe('Parked');
    expect(why.headline).toBe(CAUSE_SENTENCE['nothing-ready']);
    expect(why.stop?.run.halt).toMatchObject({ kind: 'nothing-ready' });
    expect(waitsOnOf(row, NOW)).toEqual({ lead: 'Phase 9’s gate', detail: holder.why, phase: 9 });
    // The halt card lists the holders; nothing here says them twice.
    expect(texts(why, 'waits').some((text) => text.includes('Phase 9'))).toBe(false);
  });

  it('says a halted run’s stop in the card’s own sentence', () => {
    const halt = { at: new Date(NOW).toISOString(), reason: 'refused', kind: 'credential-refused', phase: 3 };
    const { row, why } = read(plan(), [slimRun({ status: 'halted', lifecycle: { state: 'halted' }, halt })]);
    expect(why.word).toBe('Halted');
    expect(why.headline).toBe(CAUSE_SENTENCE['credential-refused']);
    expect(why.stop).not.toBeNull();
    // The row: the plan waits on its stopped run, in the card's own sentence.
    expect(waitsOnOf(row, NOW)).toEqual({
      lead: 'Its stopped run',
      detail: CAUSE_SENTENCE['credential-refused'],
      phase: 3,
    });
  });

  it('names a stuck phase and a QA verdict, each with the way to it', () => {
    const { row, why } = read(plan({ stuck: [4], qaFailures: [2] }));
    expect(why.headline).toBe('Nothing is running it, and phase 4 is stuck.');
    expect(section(why, 'stop')!.reasons).toEqual([
      expect.objectContaining({
        text: 'Phase 4 is stuck: its handoff reads blocked or in progress, and nobody is working on it.',
        href: '#/plan/alpha/phase/4',
        act: 'Open phase 4',
      }),
      expect.objectContaining({
        text: 'QA failed at phase 2, and what depends on it waits until it passes.',
        href: '#/plan/alpha/phases?view=handoffs',
      }),
    ]);
    expect(waitsOnOf(row, NOW)).toEqual({ lead: 'Phase 4 is stuck', phase: 4 });
    expectConcrete(why);
  });

  it('says whose a holder is in the row’s few words — an errand is yours, an initialism keeps its case', () => {
    const at = new Date(NOW).toISOString();
    const lead = (kind: string, label?: string) =>
      waitsOnOf(
        read(plan(), [
          slimRun({
            status: 'parked',
            lifecycle: { state: 'parked' },
            halt: {
              at,
              reason: 'x',
              kind: 'nothing-ready',
              holders: [{ ...holder, kind, verb: label ?? 'retry' }],
            },
          }),
        ]).row,
        NOW,
      )?.lead;
    expect(lead('errand', 'errand-answered')).toBe('You, on phase 9');
    expect(lead('qa', 'qa-recover')).toBe('Phase 9’s QA verdict');
    expect(lead('lock')).toBe('Phase 9’s lock');
    expect(lead('retry')).toBe('Phase 9, stopped');
  });

  it('a live run’s old stop is history: no card', () => {
    const halt = { at: new Date(NOW).toISOString(), reason: 'x', kind: 'phase-crashed', phase: 2 };
    const { why } = read(plan(), [
      slimRun({ halt, children: { '2': { pid: 1, phase: 2 } }, phases: { '2': 'running' } }),
    ]);
    expect(why.stop).toBeNull();
  });
});

describe('Done and closed — how it ended', () => {
  it('says how a closed plan ended: its word, its reason, the date, the count and the spend', () => {
    const { why } = read(
      plan({
        status: 'complete',
        closed: true,
        closedOn: '2026-10-19',
        closedReason: 'Shipped in 8.0.0.',
        phases: 4,
        done: 4,
        lastCompleted: '2026-10-18',
      }),
      [slimRun({ status: 'finished', lifecycle: { state: 'finished' }, spentUsd: 40 })],
    );
    expect(why.word).toBe('Complete');
    expect(why.headline).toBe(CLOSED_HELP.complete);
    expect(texts(why, 'ended')).toEqual([
      'Shipped in 8.0.0.',
      'Closed on 2026-10-19.',
      'All 4 phases done.',
      'Its last phase was finished on 2026-10-18.',
      'Its last run finished.',
      'Its run spent $40.00.',
    ]);
    expect(why.stop).toBeNull();
    expectConcrete(why);
  });

  it('says what an abandoned plan never ran', () => {
    const { why } = read(plan({ status: 'abandoned', closed: true, phases: 4, done: 1 }));
    expect(why.headline).toBe(CLOSED_HELP.abandoned);
    expect(texts(why, 'ended')).toContain('1 of 4 phases done; 3 phases never ran.');
  });

  it('says a finished plan nobody closed, and where to close it', () => {
    const { why } = read(plan({ phases: 3, done: 3, waiting: 0 }));
    expect(why.headline).toBe('Every phase is done, and the plan is still open.');
    expect(section(why, 'ended')!.reasons.at(-1)).toMatchObject({
      text: 'Every phase is done, and nobody has closed the plan yet.',
      href: '#/plan/alpha/phases',
    });
  });
});

describe('the rest of the words a row can say', () => {
  it('a plan nobody runs says what can start, and where to start it', () => {
    const { why } = read(plan({ ready: [3, 4], gated: [4] }));
    expect(why.word).toBe('Active');
    expect(why.headline).toBe('Nothing is running it, and 2 phases can start: 3 and 4.');
    expect(texts(why, 'next')).toEqual([
      'Phase 3 can start now.',
      'Phase 4 can start now, once its gate clears.',
      'No run is driving this plan, so nothing starts these by itself.',
    ]);
    expect(section(why, 'next')!.reasons.at(-1)!.href).toBe('#/plan/alpha/run');
    expectConcrete(why);
  });

  it('a document says what it is', () => {
    const { why } = read(plan({ kind: 'document', phases: 0, done: 0 }));
    expect(why.word).toBe('Document');
    expect(why.headline).toBe(
      'This is a document, not a plan: it has no phase table, so nothing runs from it.',
    );
    expect(section(why, 'about')).toBeDefined();
  });

  it('a status line the console does not know says so, in its own words', () => {
    const { why } = read(plan({ status: '✅' }));
    expect(why.headline).toContain('“✅”');
  });
});
