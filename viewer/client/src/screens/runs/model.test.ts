/**
 * The Runs home's fold and the run row's model (7.0, quiet-console phase 7).
 *
 * Two 6.2 tests ported into one: the Tower's fold (`tower-model.test.ts` —
 * every run in exactly one bay, no settled or superseded run summoning, the
 * annunciator's lamps, the filters, the Ready and Settled bays, a person's
 * turn as a summons, the supervisor's cards) re-spelled over `groupRuns` /
 * `filterGroups`, and the strip's model (`strip-model.test.ts` — one action by
 * bay, the observed pulse, every figure labelled) over `rowModel` / `rowAction`
 * / `rowClock` / `compactTrack` / `waitLines`.
 *
 * What changed in 7.0, and what the cases below say instead: a run never sits
 * in Your turn or Ready — a summoned run reads `bay === 'needs-you'` but sits
 * in `group = homeOf(view)`, and the Needs-you bay's loose rows are the
 * home's `items`; `bays` became `groups`, `annunciator` became `lamps`; and
 * the halt view decides a stopped run's one action BEFORE a person's turn
 * (#278). The plan's four exit criteria each have a `describe` of their own.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { STALL_DEFAULTS } from '@shared/attention-model.js';
import { HALT_CATEGORIES, type HaltCategory } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { humanStepView } from '@shared/human-step-model.js';
import { SHUTDOWN_CONTINUES } from '@shared/orchestration-model.js';
import type { InboxItem, QueueEntry, RunState } from '@/data/api';
import { asRunLike, lanesOf, type Departure, type NowLane, type RunLike } from '@/data/lanes';
import {
  filterGroups,
  groupRuns,
  homeOf,
  type PlacedRun,
  type RunGroups,
  type RunHome,
} from '@/data/run-groups';
import { isClosedStatus } from '@/lib/closure';
import { rowPrimaryOf } from '@/cards/item-row';
import { situationParts } from '@/shell/situation-line';
import { turnHref } from '@/shell/routes';
import {
  bindingHoldOf,
  compactTrack,
  fullTrack,
  observedLive,
  rowAction,
  rowModel,
  stopReason,
  waitLines,
} from './model';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CORPUS = JSON.parse(readFileSync(join(VIEWER, 'test/fixtures/live-status-corpus.json'), 'utf8')) as {
  runs: { status: string }[];
  audit: {
    capturedAt: string;
    cases: { group: string; planStatus: string | null; run: Record<string, unknown>; overtaken?: boolean }[];
  };
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const MIN = 60_000;
const ago = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

/** The four groups a run can sit in — `RUN_HOMES`, as the fold spells them. */
const HOMES: readonly RunHome[] = ['live', 'waiting', 'queued', 'settled'];

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A whole record with the fields the fold reads; `phases` is a table of records, never words. */
function run(over: Partial<RunState> & { id: string; slug?: string }): RunState {
  return {
    slug: over.id,
    root: '/repo',
    status: 'running',
    model: 'opus',
    spentUsd: 0,
    runBudgetUsd: null,
    phaseBudgetUsd: null,
    createdAt: ago(3_600_000),
    updatedAt: ago(60_000),
    phases: {},
    halt: null,
    ...over,
  } as unknown as RunState;
}

const item = (over: Partial<InboxItem>): InboxItem =>
  ({
    id: over.id ?? 'i1',
    kind: 'errand',
    severity: 'needs-you',
    title: 'an ask',
    need: 'a person',
    how: 'press',
    since: ago(600_000),
    actions: [],
    href: '#/runs',
    ...over,
  }) as InboxItem;

/** An inbox row's turn view — what the server folds every person-facing row into. */
const turnOf = (id: string, group: 'now' | 'decide', over: Record<string, unknown> = {}) =>
  ({
    item: id,
    record: 'projected',
    source: 'errand',
    kind: 'operator-act',
    why: 'decision',
    proofType: 'attest',
    group,
    ...over,
  }) as never;

/** The fold over whole records, with the lanes the home would compute for them. */
function fold(
  runs: readonly RunState[],
  over: Partial<Parameters<typeof groupRuns>[0]> = {},
  now = NOW,
): RunGroups {
  return groupRuns({ runs, lanes: lanesOf(runs, new Map(), now), now, ...over });
}

const ids = (placed: readonly PlacedRun[]) => placed.map((t) => t.run.id);

/** Every run of the model, once — the groups are a PARTITION of the runs. */
function expectPartition(model: RunGroups, runs: readonly RunLike[]) {
  const seen = HOMES.flatMap((group) => ids(model.groups[group]));
  expect(seen.sort()).toEqual(runs.map((r) => r.id).sort());
  expect(new Set(seen).size).toBe(seen.length);
  for (const t of model.runs) {
    expect(model.groups[t.group]).toContain(t);
    expect(t.group).toBe(homeOf(t.view));
  }
}

/* ------------------------------------------------------------------ *
 * The strip's fixtures — one run per group the home draws
 * ------------------------------------------------------------------ */

type Phase = { phase: number; status: string } & Record<string, unknown>;

function record(over: Partial<RunState> & { id: string; slug: string }, phases: Phase[]): RunState {
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

const live = () =>
  record({ id: 'r-live', slug: 'console-speed', children: { 6: child(6) } } as never, [
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
  record(
    {
      id: 'r-halt',
      slug: 'checkout',
      status: 'halted',
      halt: { at: iso(NOW - 12 * MIN - 3_000), kind: 'verify-failed', reason: 'red', phase: 5 },
    } as never,
    [
      { phase: 4, status: 'done' },
      { phase: 5, status: 'failed', sessionId: 's5' },
    ],
  );

const queued = (over: Partial<RunState> = {}) =>
  record({ id: 'r-q', slug: 'gamma', status: 'queued', ...over } as never, [
    { phase: 1, status: 'queued', queuedAt: iso(NOW - 3 * MIN) },
  ]);

const frozen = () =>
  record(
    {
      id: 'r-frz',
      slug: 'delta',
      status: 'frozen',
      freeze: { at: iso(NOW - 2 * MIN), by: 'me', phase: null, pid: 102 },
      children: { 2: child(2, { frozen: { at: iso(NOW - 2 * MIN), by: 'me' } }) },
    } as never,
    [{ phase: 2, status: 'running' }],
  );

const ENTRY = {
  id: 'e1',
  slug: 'gamma',
  phase: 1,
  since: NOW - 3 * MIN,
  waitingOn: [],
} as unknown as QueueEntry;

/** The row's model for one run, placed by the home's own fold. */
function model(
  r: RunState,
  over: { allowRun?: boolean; entry?: QueueEntry; inbox?: InboxItem[]; lanes?: NowLane[] } = {},
) {
  const groups = groupRuns({
    runs: [r],
    lanes: over.lanes ?? lanesOf([r], new Map(), NOW),
    ...(over.entry ? { entries: [over.entry] } : {}),
    ...(over.inbox ? { inbox: over.inbox } : {}),
    now: NOW,
  });
  return rowModel({ placed: groups.runs[0]!, now: NOW, allowRun: over.allowRun ?? true });
}

/* ================================================================== *
 * Criterion 1 — every run in exactly one group, over the corpus
 * ================================================================== */

describe('criterion 1 — one run, one group, over the phase-16 corpus', () => {
  const AT = Date.parse(CORPUS.audit.capturedAt);

  it('places every run-status shape the console has had on disk, with an inbox item open on each', () => {
    const runs = CORPUS.runs.map((shape, i) =>
      run({ ...(shape as Partial<RunState>), id: `shape-${i}`, halt: null }),
    );
    const inbox = runs.map((r, i) => item({ id: `ask-${i}`, runId: r.id, slug: r.slug }));
    const model = fold(runs, { inbox });

    expectPartition(model, runs);
    for (const t of model.groups.live)
      expect(t.view.tense, `${t.run.id} is settled yet Running`).not.toBe('settled');
    for (const t of model.runs) {
      if (t.view.tense === 'settled' || t.ctx.newerRunId) {
        expect(t.bay, `${t.run.id} is settled or overtaken yet summons`).not.toBe('needs-you');
      }
    }
    // A stop with an open item summons — and still sits in the group of what it is.
    const stopped = model.runs.find((t) => t.run.status === 'halted')!;
    expect(stopped.bay).toBe('needs-you');
    expect(stopped.group).toBe('waiting');
    // A finished run with an item open does not: settled things go quiet.
    const finished = model.runs.find((t) => t.run.status === 'finished')!;
    expect(finished.bay).toBe('settled');
    expect(finished.group).toBe('settled');
  });

  it('places every audited run in exactly one group, and never a settled or overtaken one in Needs you', () => {
    const runs: RunState[] = [];
    const closed = new Set<string>();
    CORPUS.audit.cases.forEach((c, i) => {
      const id = `case-${i}`;
      const slug = `${String(c.run.slug ?? 'plan')}-${i}`;
      runs.push({ ...(c.run as object), id, slug } as unknown as RunState);
      if (isClosedStatus(c.planStatus ?? undefined)) closed.add(slug);
      // An overtaken case is overtaken BY something: a newer run of its slug.
      if (c.overtaken) {
        runs.push(
          run({ id: `${id}-newer`, slug, status: 'finished', createdAt: new Date(AT).toISOString() }),
        );
      }
    });
    // An item open on every one of them: the summons must still never reach a settled run.
    const inbox = runs.map((r, i) => item({ id: `ask-${i}`, runId: r.id, slug: r.slug }));
    const model = fold(runs, { closedSlugs: closed, inbox }, AT);

    expectPartition(model, runs);
    expect(model.runs.length).toBeGreaterThanOrEqual(35);
    for (const t of model.groups.live)
      expect(t.view.tense, `${t.run.slug} is settled yet Running`).not.toBe('settled');
    for (const t of model.runs) {
      if (t.view.tense === 'settled' || t.ctx.newerRunId) {
        expect(t.bay, `${t.run.slug} is settled or overtaken yet summons`).not.toBe('needs-you');
        expect(t.view.outcome === 'superseded' || t.view.tense === 'settled').toBe(true);
      }
    }
    // The audit's three groups are all history: none of them is live work.
    const overtaken = model.runs.filter((t) => t.ctx.newerRunId);
    expect(overtaken.length).toBeGreaterThan(0);
    for (const t of overtaken) {
      expect(t.group).toBe('settled');
      // Settled — superseded when it was still open, else by its own outcome:
      // a partial run that a newer run followed keeps its own word.
      expect(t.view.tense).toBe('settled');
    }
    expect(model.counts['needs-you']).toBe(model.items.length);
  });

  it('puts each run in the group its own row computes', () => {
    const runs = [
      run({
        id: 'live',
        status: 'running',
        phases: { 3: { phase: 3, status: 'running', attempts: 1, costUsd: 0 } } as never,
      }),
      run({
        id: 'stopped',
        status: 'halted',
        halt: { kind: 'verify-failed', phase: 2, at: ago(900_000), reason: 'red' } as never,
      }),
      run({ id: 'done', status: 'finished' }),
      run({ id: 'paused', status: 'paused', stoppedBy: 'operator' } as never),
    ];
    const inbox = [item({ runId: 'stopped', slug: 'stopped' })];
    const model = fold(runs, { inbox });
    for (const t of model.runs) {
      const row = rowModel({ placed: t, now: NOW, allowRun: true });
      expect(row.bay, t.run.id).toBe(t.bay);
      expect(row.summons, t.run.id).toBe(t.bay === 'needs-you');
    }
    // The summoned run keeps the group of what it IS: a halted run waits.
    expect(model.runs.filter((t) => t.bay === 'needs-you').map((t) => t.run.id)).toEqual(['stopped']);
    expect(ids(model.groups.waiting)).toEqual(['stopped']);
    expect(ids(model.groups.live)).toEqual(['live']);
    expect(ids(model.groups.settled)).toEqual(['done']);
    // Paused by you is a standing queue, not a wait.
    expect(ids(model.groups.queued)).toEqual(['paused']);
  });

  it('settles every unfinished run of a closed plan, and an older run a newer one overtook', () => {
    const runs = [
      run({
        id: 'old',
        slug: 'alpha',
        status: 'halted',
        createdAt: ago(9e6),
        halt: { kind: 'verify-failed', phase: 1 } as never,
      }),
      run({ id: 'new', slug: 'alpha', status: 'running', createdAt: ago(1e6) }),
      run({ id: 'closed', slug: 'beta', status: 'paused', stoppedBy: 'operator' } as never),
    ];
    const inbox = [item({ runId: 'old', slug: 'alpha' }), item({ id: 'i2', runId: 'closed', slug: 'beta' })];
    const model = groupRuns({ runs, lanes: [], inbox, closedSlugs: new Set(['beta']), now: NOW });
    expect(ids(model.groups.settled).sort()).toEqual(['closed', 'old']);
    expect(model.runs.some((t) => t.bay === 'needs-you')).toBe(false);
    // Their old halts light nothing.
    expect(Object.values(model.lamps).every((n) => n === 0)).toBe(true);
  });
});

/* ================================================================== *
 * Criterion 2 — the one action, the halt view first (#278)
 * ================================================================== */

describe('criterion 2 — the one action, chosen by group through the lifecycle or the recovery model', () => {
  it('a stopped run offers the halt view’s recommended verb — before an older plan-wide item (#278)', () => {
    const r = halted();
    // A plan-wide ask (no run id), older than the stop, that a person owes now.
    const older = item({
      id: 'plan-wide',
      kind: 'gate',
      slug: 'checkout',
      since: iso(NOW - 60 * MIN),
      turn: turnOf('plan-wide', 'decide', { source: 'gate', kind: 'decision' }),
    });
    const groups = groupRuns({ runs: [r], lanes: lanesOf([r], new Map(), NOW), inbox: [older], now: NOW });
    const placed = groups.runs[0]!;
    // The item summons the run, which stays in the group of what it is.
    expect(placed.bay).toBe('needs-you');
    expect(placed.group).toBe('waiting');

    const recommended = haltView(r, {})?.recommended;
    expect(recommended, 'the fixture must have a recommendation to compare').toBeTruthy();
    const action = rowAction({ placed, now: NOW, allowRun: true }, { frozen: false, held: false });
    expect(action).toMatchObject({ kind: 'recovery', id: recommended!.id });
    expect(action.kind === 'recovery' && action.target).toEqual({
      slug: 'checkout',
      phase: 5,
      runId: 'r-halt',
    });
    expect(action.kind).not.toBe('step');
  });

  it('a read-only console offers Open run on a stopped run — the one move no flag guards', () => {
    const r = halted();
    expect(model(r, { allowRun: false }).action).toMatchObject({ kind: 'open', label: 'Open run' });
    // A plan-wide note nobody is asked to press (an `fyi` row) changes nothing.
    const note = item({ id: 'clash', kind: 'conflict', slug: 'checkout', severity: 'fyi' });
    const withNote = model(r, { allowRun: false, inbox: [note] });
    expect(withNote.bay).toBe('waiting');
    expect(withNote.action.kind).toBe('open');
    // …while a person's turn on the run is still theirs to do, driving flag or not.
    const ask = item({ id: 'ask', kind: 'gate', slug: 'checkout', turn: turnOf('ask', 'decide') });
    expect(model(r, { allowRun: false, inbox: [ask] }).action.kind).toBe('step');
  });

  it('a live run pauses at its next boundary', () => {
    const m = model(live());
    expect(m.bay).toBe('live');
    expect(m.action).toMatchObject({ kind: 'lifecycle', verb: 'pause', label: 'Pause' });
  });

  it('a run already pausing offers to cancel the pause, not a second one', () => {
    const m = model({ ...live(), status: 'pausing' } as RunState);
    expect(m.action).toMatchObject({ kind: 'lifecycle', verb: 'resume', label: 'Cancel pause' });
  });

  it('a queued run is held — and a held one released', () => {
    const q = model(queued(), { entry: ENTRY });
    expect(q.bay).toBe('queued');
    expect(q.action).toMatchObject({ kind: 'lifecycle', verb: 'hold' });
    const held = model(queued({ hold: { at: iso(NOW - MIN), by: 'me' } } as never), { entry: ENTRY });
    expect(held.held).toBe(true);
    expect(held.action).toMatchObject({ kind: 'lifecycle', verb: 'release', label: 'Release' });
  });

  it('a frozen run thaws — whatever its lanes say', () => {
    const m = model(frozen());
    expect(m.frozen).toBe(true);
    expect(m.action).toMatchObject({ kind: 'lifecycle', verb: 'thaw', label: 'Thaw' });
  });

  it('a run paused by you resumes', () => {
    const r = record({ id: 'r-p', slug: 'eps', status: 'paused', stoppedBy: 'operator' } as never, [
      { phase: 3, status: 'pending' },
    ]);
    expect(model(r).action).toMatchObject({ kind: 'lifecycle', verb: 'resume', label: 'Resume' });
  });

  it('a settled run opens — there is nothing left to press', () => {
    const r = record({ id: 'r-f', slug: 'done-plan', status: 'finished' }, [{ phase: 1, status: 'done' }]);
    const m = model(r, { lanes: [] });
    expect(m.bay).toBe('settled');
    expect(m.action).toMatchObject({ kind: 'open', label: 'Open run' });
  });

  it('a read-only console offers Open run on every row — never a button that answers 403', () => {
    for (const r of [live(), halted(), queued(), frozen()]) {
      expect(model(r, { allowRun: false }).action.kind, r.id).toBe('open');
    }
  });

  it('always exactly one: every fixture yields one action object', () => {
    for (const r of [live(), halted(), queued(), frozen()]) {
      expect(['lifecycle', 'recovery', 'open']).toContain(model(r).action.kind);
    }
  });
});

/* ================================================================== *
 * Criterion 3 — the lamps are the halt card's own families
 * ================================================================== */

describe('criterion 3 — the lamps count the halt view’s families', () => {
  /** The lamps as the halt view folds them: one per unsettled halted run's family. */
  function lampsOf(model: RunGroups): Record<HaltCategory, number> {
    const expected = Object.fromEntries(HALT_CATEGORIES.map((c) => [c, 0])) as Record<HaltCategory, number>;
    for (const t of model.runs) {
      if (t.group === 'settled' || !t.run.halt) continue;
      const view = haltView(asRunLike(t.run) as Parameters<typeof haltView>[0]);
      if (view) expected[view.category] += 1;
    }
    return expected;
  }

  const runs = [
    run({ id: 'a', status: 'halted', halt: { kind: 'credential-refused', phase: 1 } as never }),
    run({ id: 'b', status: 'halted', halt: { kind: 'verify-failed', phase: 2 } as never }),
    run({ id: 'c', status: 'halted', halt: { kind: 'verify-failed', phase: 4 } as never }),
    run({ id: 'd', status: 'running' }),
  ];
  const inbox = [item({ runId: 'a', slug: 'a' })];
  const model = groupRuns({ runs, lanes: [], inbox, now: NOW });

  it('counts exactly the halt card’s families, one lamp per family, over several halts', () => {
    expect(model.lamps).toEqual(lampsOf(model));
    expect(Object.keys(model.lamps)).toEqual([...HALT_CATEGORIES]);
    expect(model.lamps.credentials).toBe(1);
    expect(model.lamps.verification).toBe(2);
    // The summoned stop lights its halt's family, not its item's.
    expect(model.runs.find((t) => t.run.id === 'a')?.bay).toBe('needs-you');
  });

  it('lights nothing for the corpus’s halts, every one of them settled — and the fold agrees', () => {
    const AT = Date.parse(CORPUS.audit.capturedAt);
    const runs: RunState[] = [];
    const closed = new Set<string>();
    CORPUS.audit.cases.forEach((c, i) => {
      const slug = `${String(c.run.slug ?? 'plan')}-${i}`;
      runs.push({ ...(c.run as object), id: `case-${i}`, slug } as unknown as RunState);
      if (isClosedStatus(c.planStatus ?? undefined)) closed.add(slug);
    });
    expect(runs.filter((r) => r.halt).length).toBeGreaterThan(1);
    const settled = fold(runs, { closedSlugs: closed }, AT);
    expect(settled.lamps).toEqual(lampsOf(settled));
    expect(Object.values(settled.lamps).every((n) => n === 0)).toBe(true);
    // The same cases with their plans open: whatever still stands lights its family, as the fold says.
    const open = fold(runs, {}, AT);
    expect(open.lamps).toEqual(lampsOf(open));
  });

  it('narrows the groups to the lamp pressed, and leaves the lamps lit', () => {
    const only = filterGroups(model, { category: 'verification' });
    expect(ids(only.runs).sort()).toEqual(['b', 'c']);
    expect(only.groups.live).toEqual([]);
    expect(only.lamps).toEqual(model.lamps);
    expect(only.ready).toEqual([]);
  });

  it('narrows everything, the lamps included, by a plan name', () => {
    const only = filterGroups(model, { query: 'A' });
    expect(ids(only.runs)).toEqual(['a']);
    expect(only.lamps.credentials).toBe(1);
    expect(only.lamps.verification).toBe(0);
  });
});

/* ================================================================== *
 * The groups the Tower's bays became
 * ================================================================== */

describe('a summoned run keeps its group; the asks are items (control-tower phase 139)', () => {
  it('counts items in Your turn, hands every ask to the page, and keeps the run where it is', () => {
    const runs = [
      run({
        id: 'r1',
        slug: 'alpha',
        status: 'halted',
        halt: { kind: 'credential-refused', phase: 1 } as never,
      }),
    ];
    const inbox = [
      item({ id: 'mine', runId: 'r1', slug: 'alpha', turn: turnOf('mine', 'now') }),
      item({
        id: 'plan-level',
        slug: 'gamma',
        kind: 'gate',
        category: { word: 'decision', label: 'Needs your decision' },
        turn: turnOf('plan-level', 'decide', { source: 'gate', kind: 'decision' }),
      }),
      item({ id: 'card', kind: 'approval', slug: 'alpha', turn: turnOf('card', 'now') }),
      item({ id: 'relayed', kind: 'question', slug: 'alpha', turn: turnOf('relayed', 'decide') }),
      item({ id: 'fyi', kind: 'ruling', severity: 'fyi', slug: 'delta' }),
    ];
    const model = groupRuns({ runs, lanes: [], inbox, now: NOW });
    const placed = model.runs[0]!;
    expect(placed.bay).toBe('needs-you');
    expect(placed.group).toBe('waiting');
    expect(ids(model.groups.waiting)).toEqual(['r1']);
    // Your turn counts the items — fyi wants nobody — and no group holds a loose row.
    expect(model.counts['needs-you']).toBe(4);
    expect(model.items.map((i) => i.id)).toEqual(['mine', 'plan-level', 'card', 'relayed']);
    // A plan-level gate no row draws lights no lamp: the lamps are the runs'.
    expect(model.lamps.decision).toBe(0);
    expect(model.lamps.credentials).toBe(1);
  });

  it('a summoned row’s ONE action is its OLDEST item’s primary — a broker card before a later step', () => {
    const busy = run({ id: 'r1', slug: 'alpha', status: 'running', activePhase: 1 });
    const inbox = [
      item({
        id: 'later',
        kind: 'human-step',
        runId: 'r1',
        slug: 'alpha',
        since: ago(60_000),
        turn: turnOf('s9', 'now'),
      }),
      item({
        id: 'card',
        kind: 'approval',
        runId: 'r1',
        slug: 'alpha',
        since: ago(600_000),
        turn: turnOf('card', 'now'),
      }),
    ];
    const m = model(busy, { inbox });
    expect(m.bay).toBe('needs-you');
    expect(m.summons).toBe(true);
    expect(m.action.kind === 'step' && m.action.item.id).toBe('card');
  });

  it('a plan-wide row takes no row’s action outside a summons — a Running row keeps Pause', () => {
    const r = run({ id: 'r1', slug: 'alpha', status: 'running', activePhase: 1 });
    const plain = model(r, { inbox: [] });
    const withPlanRow = model(r, {
      inbox: [
        item({
          id: 'clash',
          kind: 'conflict',
          slug: 'alpha',
          severity: 'fyi',
          turn: turnOf('clash', 'decide'),
        }),
      ],
    });
    expect(withPlanRow.bay).toBe(plain.bay);
    expect(withPlanRow.action).toEqual(plain.action);
    expect(plain.action).toMatchObject({ kind: 'lifecycle', verb: 'pause' });
  });
});

describe('the Ready and Settled groups', () => {
  it('Ready is the departures, as given — plans’ phases, never runs', () => {
    const departures = [
      { key: 'p#2', slug: 'p', phase: 2 },
      { key: 'q#5', slug: 'q', phase: 5 },
    ] as Departure[];
    const model = groupRuns({ runs: [], lanes: [], departures, now: NOW });
    expect(model.ready.map((d) => d.key)).toEqual(['p#2', 'q#5']);
    expect(model.counts.ready).toBe(2);
    expect(model.runs).toEqual([]);
  });

  it('counts what settled today apart from what went dormant', () => {
    const runs = [
      run({ id: 'today', status: 'finished', updatedAt: new Date(NOW - 60_000).toISOString() }),
      run({
        id: 'dormant',
        status: 'halted',
        updatedAt: ago(30 * 864e5),
        halt: { kind: 'verify-failed', phase: 1 } as never,
      }),
    ];
    const model = groupRuns({ runs, lanes: [], now: NOW });
    expect(ids(model.groups.settled)).toEqual(['today', 'dormant']);
    expect(model.settled.today).toBe(1);
    expect(model.settled.dormant).toBe(1);
    expect(model.runs.find((t) => t.run.id === 'dormant')?.dormant).toBe(true);
    // A dormant stop lights no lamp either.
    expect(model.lamps.verification).toBe(0);
  });
});

describe('a person’s turn is a summons (control-tower phase 42)', () => {
  const step = (over: Partial<InboxItem> = {}) =>
    item({
      id: 'human-step:busy:2:s1',
      kind: 'human-step',
      runId: 'busy',
      slug: 'busy',
      phase: 2,
      title: 'Sign the gh CLI in',
      // The server's word for its kind's family (`HUMAN_STEP_CATEGORY`).
      category: { word: 'credentials', label: 'Credentials and accounts' },
      humanStep: humanStepView({
        kind: 'browser-login',
        title: 'Sign the gh CLI in',
        stepId: 's1',
        openUrl: 'https://github.com/login/device',
        check: true,
      }),
      turn: turnOf('s1', 'now', {
        record: 'ledger',
        source: 'declared',
        kind: 'browser-login',
        why: 'identity',
        proofType: 'probe',
      }),
      ...over,
    });
  // A run with another lane still working: a step summons it all the same.
  const busy = run({ id: 'busy', status: 'running', activePhase: 1 });

  it('summons its run, which keeps Running, with the step’s act as the row’s ONE action', () => {
    const inbox = [step()];
    const groups = fold([busy], { inbox });
    const placed = groups.runs[0]!;
    expect(placed.bay).toBe('needs-you');
    expect(placed.group).toBe('live');
    expect(ids(groups.groups.live)).toEqual(['busy']);
    const row = rowModel({ placed, now: NOW, allowRun: true });
    expect(row.summons).toBe(true);
    expect(row.action.kind).toBe('step');
    expect(row.action.kind === 'step' && row.action.item.humanStep?.stepId).toBe('s1');
    // Even a console that cannot drive runs can do a person's turn.
    expect(rowModel({ placed, now: NOW, allowRun: false }).action.kind).toBe('step');
  });

  it('lights its run’s lamp, and Your turn (n) counts ITEMS and opens the page', () => {
    const onRow = groupRuns({ runs: [busy], lanes: [], inbox: [step()], now: NOW });
    expect(onRow.lamps.credentials).toBe(1);
    expect(onRow.items).toHaveLength(1);
    expect(onRow.counts['needs-you']).toBe(1);
    const parts = situationParts({ model: onRow, needsYou: 0, turns: onRow.counts['needs-you'], queued: 0 });
    const turn = parts.find((part) => part.key === 'your-turn');
    expect(turn?.text).toBe('Your turn (1)');
    expect(turn?.href).toBe(turnHref());

    // An errand row and the step it describes are ONE item.
    const both = groupRuns({
      runs: [busy],
      lanes: [],
      inbox: [step(), item({ id: 'errand', runId: 'busy', slug: 'busy', turn: turnOf('s1', 'now') })],
      now: NOW,
    });
    expect(both.items.map((i) => i.id)).toEqual(['human-step:busy:2:s1']);

    // A step whose run is not on the home is an item of the page — and lights no lamp.
    const away = groupRuns({ runs: [], lanes: [], inbox: [step({ runId: 'gone', slug: 'gone' })], now: NOW });
    expect(away.items).toHaveLength(1);
    expect(away.lamps.credentials).toBe(0);
    // An acknowledged one is seen, never done: the page counts it, so the line does.
    const acked = groupRuns({ runs: [], lanes: [], inbox: [step({ ack: { at: ago(1) } })], now: NOW });
    expect(acked.items).toHaveLength(1);
  });

  it('on proven the item leaves, and the row reads plain Running with no reload', () => {
    const lanes = lanesOf([busy], new Map(), NOW);
    const before = groupRuns({ runs: [busy], lanes, inbox: [step()], now: NOW });
    expect(before.runs[0]!.bay).toBe('needs-you');
    // What the `human-step` event's refetch hands the same fold: the row gone.
    const after = groupRuns({ runs: [busy], lanes, inbox: [], now: NOW });
    expect(ids(after.groups.live)).toEqual(['busy']);
    expect(after.runs[0]!.bay).toBe('live');
    expect(after.lamps.credentials).toBe(0);
    expect(after.counts['needs-you']).toBe(0);
    expect(
      situationParts({ model: after, needsYou: 0, turns: 0, queued: 0 }).some((p) => p.key === 'your-turn'),
    ).toBe(false);
  });
});

describe('the supervisor on the home (control-tower phase 102)', () => {
  const runs = [
    run({
      id: 'h',
      slug: 'halted-plan',
      status: 'halted',
      halt: { kind: 'verify-failed', phase: 2 } as never,
    }),
    run({ id: 'l', slug: 'live-plan', status: 'running' }),
  ];
  const card = (over: Partial<InboxItem>) =>
    item({ kind: 'supervisor', title: 'Supervisor suggests', ...over });

  it('a supervisor card is an item of the page, never a loose row of a group', () => {
    const inbox = [
      item({ id: 'errand', runId: 'h', slug: 'halted-plan' }),
      card({
        id: 'sv-h',
        runId: 'h',
        slug: 'halted-plan',
        turn: turnOf('sv-h', 'now', { source: 'supervisor' }),
      }),
      card({
        id: 'sv-l',
        runId: 'l',
        slug: 'live-plan',
        turn: turnOf('sv-l', 'now', { source: 'supervisor' }),
      }),
    ];
    const model = groupRuns({ runs, lanes: [], inbox, now: NOW });
    expect(model.runs.filter((t) => t.bay === 'needs-you').map((t) => t.run.id)).toEqual(['h']);
    expect(ids(model.groups.waiting)).toEqual(['h']);
    expect(ids(model.groups.live)).toEqual(['l']);
    expect(model.items.map((i) => i.id)).toEqual(['sv-h', 'sv-l']);
    // Your turn counts the items the cards are; the groups count their runs.
    expect(model.counts['needs-you']).toBe(2);
    expect(model.counts.waiting).toBe(1);
    // A supervisor card lights no halt lamp: detections count on their own lamps.
    expect(model.lamps.verification).toBe(1);
  });

  it('narrows to exactly the runs and cards a pressed supervisor lamp keeps', () => {
    const inbox = [
      card({
        id: 'sv-l',
        runId: 'l',
        slug: 'live-plan',
        turn: turnOf('sv-l', 'now', { source: 'supervisor' }),
      }),
      item({ id: 'gate', kind: 'gate', slug: 'x', turn: turnOf('gate', 'decide') }),
    ];
    const model = groupRuns({ runs, lanes: [], inbox, now: NOW });
    const only = filterGroups(model, { keep: { runIds: new Set(['l']), itemIds: new Set(['sv-l']) } });
    expect(ids(only.runs)).toEqual(['l']);
    expect(ids(only.groups.live)).toEqual(['l']);
    expect(only.groups.waiting).toEqual([]);
    expect(only.items.map((i) => i.id)).toEqual(['sv-l']);
    expect(only.counts['needs-you']).toBe(1);
    expect(only.ready).toEqual([]);
  });
});

/* ================================================================== *
 * The pulse is observed, never assumed
 * ================================================================== */

describe('observedLive — the pulse needs a lane that is heard from now', () => {
  const lane = (over: Partial<NowLane>): NowLane => ({ ...lanesOf([live()], new Map(), NOW)[0]!, ...over });

  it('breathes for a running lane with a process that spoke recently', () => {
    expect(observedLive(lane({}), NOW)).toBe(true);
    const m = model(live());
    expect(m.pulse).toBe(true);
    expect(m.observed).toEqual([6]);
    expect(m.livePhases).toEqual([6]);
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
    const { child: _none, ...orphan } = lane({});
    expect(observedLive(orphan as NowLane, NOW)).toBe(false);
  });

  it('a run with no observed lane does not pulse, however its status reads', () => {
    const r = live();
    const quiet = { ...r, phases: { ...r.phases, 6: { ...r.phases['6']!, liveness: heard(60 * MIN) } } };
    expect(model(quiet as RunState).pulse).toBe(false);
    expect(model(frozen()).pulse).toBe(false);
  });
});

/* ================================================================== *
 * Every figure labelled
 * ================================================================== */

describe('the glance figures', () => {
  it('a live run reads its attempt clock with the verb "running"', () => {
    const { clock } = model(live());
    expect(clock).toMatchObject({ verb: 'running', tense: 'for', label: 'this attempt' });
    expect(clock.ms).toBe(14 * MIN);
  });

  it('a stopped run reads how long ago it halted', () => {
    expect(model(halted()).clock).toMatchObject({ verb: 'halted', tense: 'ago', ms: 12 * MIN + 3_000 });
  });

  it('a frozen run reads how long ago it was frozen, a queued one how long it has queued', () => {
    expect(model(frozen()).clock).toMatchObject({ verb: 'frozen', tense: 'ago', ms: 2 * MIN });
    expect(model(queued(), { entry: ENTRY }).clock).toMatchObject({
      verb: 'queued',
      tense: 'for',
      ms: 3 * MIN,
    });
    // With no admission entry, the lane's own queue stamp.
    expect(model(queued()).clock).toMatchObject({ verb: 'queued', ms: 3 * MIN });
  });

  it('a settled run reads what it worked for — "ran"', () => {
    const r = record({ id: 'r-f', slug: 'done-plan', status: 'finished' }, [
      { phase: 1, status: 'done', durationMs: 64 * MIN },
    ]);
    expect(model(r, { lanes: [] }).clock).toMatchObject({ verb: 'ran', tense: 'for', ms: 64 * MIN });
  });

  it('the cost counts the session in flight, which the run books only when it ends', () => {
    const { cost } = model(live());
    expect(cost.spentUsd).toBeCloseTo(4.2 + 1.3);
    expect(cost.liveUsd).toBeCloseTo(1.3);
    expect(cost.budgetUsd).toBe(25);
    expect(cost.over).toBe(false);
  });

  it('the track folds to labelled stations, with done counted; the full track is every phase', () => {
    const m = model(live());
    expect(m.track.map((s) => s.label)).toEqual(['1 done', 'P6 running', '1 left']);
    expect(m.track.map((s) => s.key)).toEqual(['done', 'p6', 'left']);
    expect(m.track[1]).toMatchObject({ phase: 6, live: true, settled: false, paint: 'running' });
    expect([m.done, m.total]).toEqual([1, 3]);
    const phases = [
      { phase: 5, status: 'done' },
      { phase: 6, status: 'running' },
      { phase: 7, status: 'pending' },
    ];
    expect(fullTrack(phases, [6]).map((s) => s.phase)).toEqual([5, 6, 7]);
    expect(fullTrack(phases, [6]).map((s) => s.live)).toEqual([false, true, false]);
  });

  it('a 35-phase run folds to three stations, and a settled one to one', () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      phase: i + 1,
      status: i < 6 ? 'done' : i === 6 ? 'running' : 'pending',
    }));
    expect(compactTrack(many, [7]).map((s) => s.label)).toEqual(['6 done', 'P7 running', '28 left']);
    expect(compactTrack(many).map((s) => s.count)).toEqual([6, undefined, 28]);
    expect(compactTrack([{ phase: 1, status: 'done' }]).map((s) => s.label)).toEqual(['1 done']);
    // A stop stands on its own, with its state in the word.
    expect(compactTrack([{ phase: 2, status: 'failed' }])[0]).toMatchObject({
      label: 'P2 failed',
      paint: 'failed',
    });
  });
});

/* ================================================================== *
 * What holds it up
 * ================================================================== */

describe('waitLines — what holds a run up, in the record’s own words', () => {
  it('says a hold, and who holds it', () => {
    const r = queued({ hold: { at: iso(NOW - MIN), by: 'me' } } as never);
    const lines = waitLines(r, lanesOf([r], new Map(), NOW), undefined, NOW);
    expect(lines.map((l) => l.kind)).toEqual(['hold']);
    expect(lines[0]!.text).toBe('Held by me: nothing new boards until it is released');
    expect(model(r).waits).toEqual(lines);
  });

  it('names the queue’s holder only when the admission entry names one', () => {
    const r = queued();
    const lanes = lanesOf([r], new Map(), NOW);
    // "queued" under a row already reading Queued says nothing.
    expect(waitLines(r, lanes, ENTRY, NOW)).toEqual([]);
    const held = {
      ...ENTRY,
      waitingOn: [
        { kind: 'grant', slug: 'alpha', phase: 3, owner: 'console', scope: ['app'], overlaps: ['app'] },
      ],
    } as unknown as QueueEntry;
    expect(waitLines(r, lanes, held, NOW)).toEqual([
      { key: 'queue:1', kind: 'queue', text: 'P1 queued — waiting on alpha P3' },
    ]);
  });

  it('reads a scope fence and a folded errand off the whole record, in phase order', () => {
    const r = record(
      {
        id: 'r-w',
        slug: 'omega',
        status: 'waiting',
        recoveries: { 7: { errand: { alsoPhases: [9, 7, 8] } } },
      } as never,
      [
        {
          phase: 8,
          status: 'parked',
          waitingOn: [{ kind: 'fence', phase: 7, refs: ['gh:acme/web#run/1'], until: NOW + 5 * MIN }],
        },
        { phase: 7, status: 'parked', waitingOn: [{ kind: 'fence', phase: 7 }] },
      ],
    );
    const lines = waitLines(r, [], undefined, NOW);
    expect(lines.map((l) => l.key)).toEqual(['fence:7', 'fence:8', 'fold:7']);
    expect(lines[0]!.text).toBe("P7 is fenced by P7's external wall, waiting on the errand it filed");
    expect(lines[1]!.text).toBe(
      `P8 is fenced by P7's external wall, waiting on gh:acme/web#run/1; the fence lifts by itself at ${new Date(
        NOW + 5 * MIN,
      )
        .toISOString()
        .slice(11, 16)}Z`,
    );
    expect(lines[2]!.text).toBe("P7's errand also stands for P8 and P9: one wall, one ask");
  });
});

/**
 * A stop the console's shutdown wrote promises the run continues by itself —
 * true only while nothing that outlives the process holds it (#93). The Why
 * column reads the stored sentence through the hold binding this console, as
 * the run view's note does, so the two cannot say different things.
 */
describe('the hold binding this console’s runs', () => {
  const FROZE_AT = '2026-09-24T09:57:43.000Z';
  const STOPPED = {
    status: 'paused',
    stoppedBy: 'system',
    halt: null,
    finishedReason: `the console shut down while this run was working — ${SHUTDOWN_CONTINUES}`,
  } as unknown as RunLike;

  it('every reader of the stop reads the stored sentence through the same hold', () => {
    const frozen = bindingHoldOf({ fleet: { frozen: true, at: FROZE_AT, by: 'operator' } });
    expect(stopReason(STOPPED, frozen)).toMatch(/frozen console-wide by operator at .* — thaw to continue/);
    const thawed = bindingHoldOf({ fleet: { frozen: false, at: null, by: null } });
    expect(stopReason(STOPPED, thawed)).toMatch(/continues by itself/);
  });

  it('reads the console’s own freeze first, then a machine hold, and nothing for no fleet', () => {
    const machine = { at: FROZE_AT, by: 'the supervisor' };
    expect(bindingHoldOf({ fleet: { frozen: false, at: null, by: null, hold: machine } })).toEqual({
      at: FROZE_AT,
      by: 'the supervisor',
      scope: 'machine',
    });
    expect(bindingHoldOf({ fleet: { frozen: true, at: FROZE_AT, by: 'operator', hold: machine } })).toEqual({
      at: FROZE_AT,
      by: 'operator',
    });
    expect(bindingHoldOf(undefined)).toBeNull();
  });
});

describe('the rows say the card’s words (turn-by-turn phase 10)', () => {
  const words = (
    id: string,
    type: string,
    readiness: string,
    group: string,
    over: Record<string, unknown> = {},
  ) => turnOf(id, 'now', { type, readiness, group, ...over });

  it('the Your turn rows carry the type, NOW or NOT YET and the composer’s title through the fold', () => {
    const inbox = [
      item({
        id: 'task',
        kind: 'human-step',
        title: 'Sign gh in to the acme org',
        turn: words('task', 'do', 'now', 'now'),
      }),
      item({
        id: 'gate',
        kind: 'gate',
        title: 'Approve the gate of phase 4',
        turn: words('gate', 'approve', 'now', 'approve', { source: 'gate' }),
      }),
      item({
        id: 'later',
        kind: 'human-step',
        severity: 'fyi',
        title: 'Tap the key',
        turn: words('later', 'do', 'not-yet', 'upcoming', { startWhen: 'when phase 3 of alpha is done' }),
      }),
    ];
    const model = groupRuns({ runs: [], lanes: [], inbox, now: NOW });
    expect(model.items.map((one) => [one.title, one.turn?.type, one.turn?.readiness])).toEqual([
      ['Sign gh in to the acme org', 'do', 'now'],
      ['Approve the gate of phase 4', 'approve', 'now'],
    ]);
    // NOT YET is coming up — counted in no group, its *when* on its row.
    expect(model.upcoming.map((one) => [one.id, one.turn?.readiness, one.turn?.startWhen])).toEqual([
      ['later', 'not-yet', 'when phase 3 of alpha is done'],
    ]);
    expect(model.counts['needs-you']).toBe(2);
  });

  it('a decision with options opens its card; an approval that asks for words opens it too', () => {
    const option = (id: string) => ({
      id,
      label: id,
      verb: { method: 'POST' as const, endpoint: `/api/x/${id}` },
    });
    const press = (verb: string, says = false) => ({
      verb,
      label: verb,
      endpoint: `/api/x/${verb}`,
      method: 'POST' as const,
      ...(says ? { says: { field: 'evidence', label: 'Evidence' } } : {}),
    });
    // Two options, side by side on the card: the row offers the card.
    expect(
      rowPrimaryOf({
        turn: words('d', 'decide', 'now', 'decide'),
        actions: [press('a'), press('b')],
        options: [option('a'), option('b')],
      }),
    ).toEqual({ move: 'page' });
    // Options ride even where the row has one button: still the card.
    expect(
      rowPrimaryOf({
        turn: words('d', 'decide', 'now', 'decide'),
        actions: [press('a')],
        options: [option('a'), option('b')],
      }),
    ).toEqual({ move: 'page' });
    // A gate's Approve asks for its evidence — the card's.
    expect(
      rowPrimaryOf({
        turn: words('g', 'approve', 'now', 'approve', { source: 'gate' }),
        actions: [press('approve', true)],
      }),
    ).toEqual({ move: 'page' });
    // One answer that asks for no words is pressed on the row.
    const one = press('ack');
    expect(rowPrimaryOf({ turn: words('q', 'decide', 'now', 'decide'), actions: [one] })).toEqual({
      move: 'row',
      action: one,
    });
    // A Task leads with its step's own primary; NOT YET offers nothing but the link.
    expect(
      rowPrimaryOf({ turn: words('t', 'do', 'now', 'now'), humanStep: {} as never, actions: [] }),
    ).toEqual({ move: 'step' });
    expect(rowPrimaryOf({ turn: words('u', 'do', 'not-yet', 'upcoming'), actions: [] })).toEqual({
      move: 'none',
      why: 'upcoming',
    });
  });
});
