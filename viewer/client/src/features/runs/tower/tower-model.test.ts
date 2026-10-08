/**
 * The Tower's fold (control-tower phase 20, exit criteria 1 and 2): every run
 * in exactly one bay, the bay the strip itself computes, no settled or
 * superseded run in Needs you — over the phase-16 corpus, the live cases the
 * status audit measured on the operator's two consoles — and an annunciator
 * whose lamps are the halt card's own families.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BAYS, describeRun } from '@shared/status-model.js';
import { HALT_CATEGORIES } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { isClosedStatus } from '@/lib/closure';
import type { InboxItem, RunState } from '@/lib/api';
import { nowLanes, type Departure } from '@/features/runs/lanes-model';
import { stripModel } from './strip-model';
import { filterTower, towerModel, type TowerModel } from './tower-model';
import { situationParts } from './situation-line';
import { humanStepView } from '@shared/human-step-model.js';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CORPUS = JSON.parse(readFileSync(join(VIEWER, 'test/fixtures/live-status-corpus.json'), 'utf8')) as {
  runs: { status: string }[];
  audit: {
    capturedAt: string;
    cases: { group: string; planStatus: string | null; run: Record<string, unknown>; overtaken?: boolean }[];
  };
};

const NOW = Date.parse('2026-09-29T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function run(over: Partial<RunState> & { id: string; slug?: string }): RunState {
  return {
    slug: over.id,
    root: '/repo',
    status: 'running',
    model: 'opus',
    spentUsd: 0,
    runBudgetUsd: null,
    phaseBudgetUsd: null,
    createdAt: iso(3_600_000),
    updatedAt: iso(60_000),
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
    since: iso(600_000),
    actions: [],
    href: '#/runs',
    ...over,
  }) as InboxItem;

/** Every run of the model, once — the bays are a PARTITION of the runs. */
function expectPartition(model: TowerModel, runs: readonly RunState[]) {
  const seen = BAYS.flatMap((bay) => model.bays[bay].map((t) => t.run.id));
  expect(seen.sort()).toEqual(runs.map((r) => r.id).sort());
  for (const t of model.runs) expect(model.bays[t.bay]).toContain(t);
}

describe('one run, one bay — over the phase-16 corpus', () => {
  const AT = Date.parse(CORPUS.audit.capturedAt);

  it('places every audited run in exactly one bay, and never a settled or overtaken one in Needs you', () => {
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
    const model = towerModel({ runs, lanes: nowLanes(runs, new Map(), AT), closedSlugs: closed, now: AT });

    expectPartition(model, runs);
    expect(model.runs.length).toBeGreaterThanOrEqual(35);
    for (const t of model.bays['needs-you']) {
      const view = describeRun(t.run as never, t.ctx);
      expect(view.tense, `${t.run.slug} is settled yet summons`).not.toBe('settled');
      expect(view.outcome, `${t.run.slug} is superseded yet summons`).not.toBe('superseded');
    }
    // The audit's three groups are all history: none of them is live work.
    const overtaken = model.runs.filter((t) => t.ctx.newerRunId);
    expect(overtaken.length).toBeGreaterThan(0);
    for (const t of overtaken) expect(t.bay).toBe('settled');
  });

  it('places every run-status shape the console has had on disk, with an inbox item open on each', () => {
    const runs = CORPUS.runs.map((shape, i) =>
      run({ ...(shape as Partial<RunState>), id: `shape-${i}`, halt: null }),
    );
    const inbox = runs.map((r, i) => item({ id: `ask-${i}`, runId: r.id, slug: r.slug }));
    const model = towerModel({ runs, lanes: nowLanes(runs, new Map(), NOW), inbox, now: NOW });
    expectPartition(model, runs);
  });

  it('puts each run in the bay its own strip computes', () => {
    const runs = [
      run({
        id: 'live',
        status: 'running',
        phases: { 3: { phase: 3, status: 'running', attempts: 1, costUsd: 0 } } as never,
      }),
      run({
        id: 'stopped',
        status: 'halted',
        halt: { kind: 'verify-failed', phase: 2, at: iso(900_000), reason: 'red' } as never,
      }),
      run({ id: 'done', status: 'finished' }),
      run({ id: 'paused', status: 'paused', stoppedBy: 'operator' } as never),
    ];
    const inbox = [item({ runId: 'stopped', slug: 'stopped' })];
    const lanes = nowLanes(runs, new Map(), NOW);
    const model = towerModel({ runs, lanes, inbox, now: NOW });
    for (const t of model.runs) {
      const strip = stripModel({ run: t.run, lanes: t.lanes, now: NOW, allowRun: true, ctx: t.ctx });
      expect(strip.bay, t.run.id).toBe(t.bay);
    }
    expect(model.bays['needs-you'].map((t) => t.run.id)).toEqual(['stopped']);
    expect(model.bays.live.map((t) => t.run.id)).toEqual(['live']);
    expect(model.bays.settled.map((t) => t.run.id)).toEqual(['done']);
  });

  it('settles every unfinished run of a closed plan, and an older run a newer one overtook', () => {
    const runs = [
      run({
        id: 'old',
        slug: 'alpha',
        status: 'halted',
        createdAt: iso(9e6),
        halt: { kind: 'verify-failed', phase: 1 } as never,
      }),
      run({ id: 'new', slug: 'alpha', status: 'running', createdAt: iso(1e6) }),
      run({ id: 'closed', slug: 'beta', status: 'paused', stoppedBy: 'operator' } as never),
    ];
    const inbox = [item({ runId: 'old', slug: 'alpha' }), item({ id: 'i2', runId: 'closed', slug: 'beta' })];
    const model = towerModel({ runs, lanes: [], inbox, closedSlugs: new Set(['beta']), now: NOW });
    expect(model.bays.settled.map((t) => t.run.id).sort()).toEqual(['closed', 'old']);
    expect(model.bays['needs-you']).toEqual([]);
    // Their old halts light nothing.
    expect(Object.values(model.annunciator).every((n) => n === 0)).toBe(true);
  });
});

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

describe('the Needs-you bay is runs (control-tower phase 139, exit criterion 2)', () => {
  it('keeps strips, counts runs, and hands every ask to Your turn — no loose rows', () => {
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
    const model = towerModel({ runs, lanes: [], inbox, now: NOW });
    expect(model.bays['needs-you'].map((t) => t.run.id)).toEqual(['r1']);
    // The bay counts runs; the asks are items of Your turn — fyi wants nobody.
    expect('loose' in model).toBe(false);
    expect(model.counts['needs-you']).toBe(1);
    expect(model.items.map((i) => i.id)).toEqual(['mine', 'plan-level', 'card', 'relayed']);
    // A plan-level gate no strip draws lights no lamp: the Tower is runs.
    expect(model.annunciator.decision).toBe(0);
  });

  it('each strip’s ONE action is its OLDEST item’s primary — a broker card before a later step', () => {
    const busy = run({ id: 'r1', slug: 'alpha', status: 'running', activePhase: 1 });
    const inbox = [
      item({
        id: 'later',
        kind: 'human-step',
        runId: 'r1',
        slug: 'alpha',
        since: iso(60_000),
        turn: turnOf('s9', 'now'),
      }),
      item({
        id: 'card',
        kind: 'approval',
        runId: 'r1',
        slug: 'alpha',
        since: iso(600_000),
        turn: turnOf('card', 'now'),
      }),
    ];
    const model = towerModel({ runs: [busy], lanes: [], inbox, now: NOW });
    const placed = model.runs[0]!;
    const strip = stripModel({ run: busy, lanes: [], now: NOW, allowRun: true, ctx: placed.ctx });
    expect(strip.action.kind === 'step' && strip.action.item.id).toBe('card');
  });

  it('a plan-wide row takes no strip’s action outside Needs you — a Live strip keeps Pause', () => {
    const live = run({ id: 'r1', slug: 'alpha', status: 'running', activePhase: 1 });
    const strip = stripModel({
      run: live,
      lanes: [],
      now: NOW,
      allowRun: true,
      ctx: { inbox: [], now: NOW } as never,
    });
    const withPlanRow = stripModel({
      run: live,
      lanes: [],
      now: NOW,
      allowRun: true,
      ctx: {
        inbox: [
          item({
            id: 'clash',
            kind: 'conflict',
            slug: 'alpha',
            severity: 'fyi',
            turn: turnOf('clash', 'decide'),
          }),
        ],
        now: NOW,
      } as never,
    });
    expect(withPlanRow.bay).toBe(strip.bay);
    expect(withPlanRow.action).toEqual(strip.action);
  });
});

describe('the annunciator (exit criterion 2)', () => {
  const runs = [
    run({ id: 'a', status: 'halted', halt: { kind: 'credential-refused', phase: 1 } as never }),
    run({ id: 'b', status: 'halted', halt: { kind: 'verify-failed', phase: 2 } as never }),
    run({ id: 'c', status: 'halted', halt: { kind: 'verify-failed', phase: 4 } as never }),
    run({ id: 'd', status: 'running' }),
  ];
  const inbox = [item({ runId: 'a', slug: 'a' })];
  const model = towerModel({ runs, lanes: [], inbox, now: NOW });

  it('counts exactly the halt card’s families, one lamp per family', () => {
    const expected = Object.fromEntries(HALT_CATEGORIES.map((c) => [c, 0]));
    for (const r of runs) {
      const view = haltView(r as never);
      if (view) expected[view.category] += 1;
    }
    expect(model.annunciator).toEqual(expected);
    expect(Object.keys(model.annunciator)).toEqual([...HALT_CATEGORIES]);
    expect(model.annunciator.credentials).toBe(1);
    expect(model.annunciator.verification).toBe(2);
  });

  it('narrows the bays to the lamp pressed, and leaves the lamps lit', () => {
    const only = filterTower(model, { category: 'verification' });
    expect(only.runs.map((t) => t.run.id).sort()).toEqual(['b', 'c']);
    expect(only.bays.live).toEqual([]);
    expect(only.annunciator).toEqual(model.annunciator);
    expect(only.ready).toEqual([]);
  });

  it('narrows everything, the lamps included, by a plan name', () => {
    const only = filterTower(model, { query: 'A' });
    expect(only.runs.map((t) => t.run.id)).toEqual(['a']);
    expect(only.annunciator.credentials).toBe(1);
    expect(only.annunciator.verification).toBe(0);
  });
});

describe('the Ready and Settled bays', () => {
  it('is Now’s Next-up set, as given', () => {
    const departures = [
      { key: 'p#2', slug: 'p', phase: 2 },
      { key: 'q#5', slug: 'q', phase: 5 },
    ] as Departure[];
    const model = towerModel({ runs: [], lanes: [], departures, now: NOW });
    expect(model.ready.map((d) => d.key)).toEqual(['p#2', 'q#5']);
    expect(model.counts.ready).toBe(2);
  });

  it('counts what settled today apart from what went dormant', () => {
    const runs = [
      run({ id: 'today', status: 'finished', updatedAt: new Date(NOW - 60_000).toISOString() }),
      run({
        id: 'dormant',
        status: 'halted',
        updatedAt: iso(30 * 864e5),
        halt: { kind: 'verify-failed', phase: 1 } as never,
      }),
    ];
    const model = towerModel({ runs, lanes: [], now: NOW });
    expect(model.bays.settled.map((t) => t.run.id)).toEqual(['today', 'dormant']);
    expect(model.settled.today).toBe(1);
    expect(model.settled.dormant).toBe(1);
  });
});

describe('a person’s turn is a summons (control-tower phase 42, criterion 3)', () => {
  const step = (over: Partial<InboxItem> = {}) =>
    item({
      id: 'human-step:busy:2:s1',
      kind: 'human-step',
      runId: 'busy',
      slug: 'busy',
      phase: 2,
      title: 'Your turn — sign in in a browser for busy phase 2',
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

  it('puts its run in Needs you, with the step’s act as the strip’s ONE action', () => {
    const inbox = [step()];
    const model = towerModel({ runs: [busy], lanes: nowLanes([busy], new Map(), NOW), inbox, now: NOW });
    expect(model.bays['needs-you'].map((t) => t.run.id)).toEqual(['busy']);
    // The row is drawn by the strip; the bay has no loose rows at all.
    expect('loose' in model).toBe(false);
    const placed = model.bays['needs-you'][0]!;
    const strip = stripModel({ run: busy, lanes: placed.lanes, now: NOW, allowRun: true, ctx: placed.ctx });
    expect(strip.bay).toBe('needs-you');
    expect(strip.action.kind).toBe('step');
    expect(strip.action.kind === 'step' && strip.action.item.humanStep?.stepId).toBe('s1');
    // Even a console that cannot drive runs can do a person's turn.
    const readOnly = stripModel({
      run: busy,
      lanes: placed.lanes,
      now: NOW,
      allowRun: false,
      ctx: placed.ctx,
    });
    expect(readOnly.action.kind).toBe('step');
  });

  it('lights its run’s lamp, and Your turn (n) counts ITEMS and opens the page', () => {
    const onStrip = towerModel({ runs: [busy], lanes: [], inbox: [step()], now: NOW });
    expect(onStrip.annunciator.credentials).toBe(1);
    expect(onStrip.items).toHaveLength(1);
    const parts = situationParts({ tower: onStrip, approvals: 0 });
    const turn = parts.find((part) => part.key === 'your-turn');
    expect(turn?.text).toBe('Your turn (1)');
    expect(turn?.href).toBe('#/turn');

    // An errand row and the step it describes are ONE item.
    const both = towerModel({
      runs: [busy],
      lanes: [],
      inbox: [step(), item({ id: 'errand', runId: 'busy', slug: 'busy', turn: turnOf('s1', 'now') })],
      now: NOW,
    });
    expect(both.items.map((i) => i.id)).toEqual(['human-step:busy:2:s1']);

    // A step whose run is not on the Tower is an item of the page — and lights no lamp.
    const away = towerModel({
      runs: [],
      lanes: [],
      inbox: [step({ runId: 'gone', slug: 'gone' })],
      now: NOW,
    });
    expect(away.items).toHaveLength(1);
    expect(away.annunciator.credentials).toBe(0);
    // An acknowledged one is seen, never done: the page counts it, so the line does.
    const acked = towerModel({ runs: [], lanes: [], inbox: [step({ ack: { at: iso(1) } })], now: NOW });
    expect(acked.items).toHaveLength(1);
  });

  it('on proven the row leaves, and the strip moves back to Live with no reload', () => {
    const lanes = nowLanes([busy], new Map(), NOW);
    const before = towerModel({ runs: [busy], lanes, inbox: [step()], now: NOW });
    expect(before.bays['needs-you'].map((t) => t.run.id)).toEqual(['busy']);
    // What the `human-step` event's refetch hands the same fold: the row gone.
    const after = towerModel({ runs: [busy], lanes, inbox: [], now: NOW });
    expect(after.bays.live.map((t) => t.run.id)).toEqual(['busy']);
    expect(after.bays['needs-you']).toEqual([]);
    expect(after.annunciator.credentials).toBe(0);
    expect(situationParts({ tower: after, approvals: 0 }).some((part) => part.key === 'your-turn')).toBe(
      false,
    );
  });
});

describe('the supervisor on the Tower (control-tower phase 102, SF-1..2)', () => {
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

  it('a supervisor card is an item of the page, never a loose row of the bay (phase 139)', () => {
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
    const model = towerModel({ runs, lanes: [], inbox, now: NOW });
    expect(model.bays['needs-you'].map((t) => t.run.id)).toEqual(['h']);
    expect(model.items.map((i) => i.id)).toEqual(['sv-h', 'sv-l']);
    expect(model.counts['needs-you']).toBe(1);
    // A supervisor card lights no halt lamp: detections count on their own lamps.
    expect(model.annunciator.verification).toBe(1);
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
    const model = towerModel({ runs, lanes: [], inbox, now: NOW });
    const only = filterTower(model, { keep: { runIds: new Set(['l']), itemIds: new Set(['sv-l']) } });
    expect(only.runs.map((t) => t.run.id)).toEqual(['l']);
    expect(only.bays.live.map((t) => t.run.id)).toEqual(['l']);
    expect(only.bays['needs-you']).toEqual([]);
    expect(only.items.map((i) => i.id)).toEqual(['sv-l']);
    expect(only.counts['needs-you']).toBe(0);
    expect(only.ready).toEqual([]);
  });
});
