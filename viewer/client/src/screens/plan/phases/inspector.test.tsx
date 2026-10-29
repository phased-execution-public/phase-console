/**
 * A phase in the panel — Inspect, the second door to depth (7.0, quiet-console
 * phase 10; the prose cases ported from `features/plans/phase-inspector.test.tsx`).
 *
 * The properties this file exists to hold, in the order they would bite:
 *
 *   - **it shows the record, not a skeleton, before its own fetch lands.** The
 *     board's `PhaseView` already carries identity, state, lock and analysis;
 *     blanking a panel that can answer most of the question, to wait for the
 *     rest, is a worse answer than showing what is known.
 *   - **the prose comes from the FETCH.** This is the whole reason the panel
 *     asks for anything: the Phases view deliberately fetches the board
 *     projection, which has no prose at all, so a panel reading its host's
 *     record would render every prose row empty and say nothing about it. The
 *     failure is silent, which is why it is asserted from both sides.
 *   - **the run's record is said in eight sections, each one press away**, all
 *     of them open with the page's Everything on, and a section with nothing to
 *     say says so instead of offering a fold that opens onto nothing.
 *   - **Raw is the record whole, and History its events newest first.**
 *
 * The panel is the shell's own (`InspectorHost`), handed the phase by
 * `inspectPhase` exactly as the grid's Inspect hands it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_PROSE_FIELDS } from '@shared/projection.js';
import type { LaneLiveness, PhaseRecord, PhaseView, PlanDetail } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import {
  InspectorHost,
  __resetInspectorForTests,
  useInspected,
  type Inspected,
} from '@/shell/panel/inspector-host';
import { TooltipProvider } from '@/ui/tooltip';
import { PROSE_INCLUDES } from '../tabs';
import type { PhaseTableRow } from './model';

const { plan } = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, plan } };
});
// The notes earlier phases left have their own suite (`notes.test.tsx`).
vi.mock('./notes', () => ({ NotesSection: () => null }));

import { PHASE_RECORD_SECTIONS, PhaseRecordSections, inspectPhase, phaseInspectKey } from './inspector';

/** What the BOARD projection carries: no prose, and that is the point. */
const BOARD_PHASE = {
  phase: 4,
  title: 'Shell and navigation',
  state: 'done',
  size: 'L',
  weight: 90_000,
  gated: false,
  row: { repos: 'phased-execution', exitCriteria: 'eight destinations' },
} as unknown as PhaseView;

/** The same phase with `?include=prose` — the fields only the fetch returns. */
const FULL_PHASE = {
  ...BOARD_PHASE,
  goal: 'Put the nav on the 4.0 system.',
  readFirst: 'The phase 3 handoff.',
  steps: 'Register the two destinations, then band the rail.',
  verification: 'npm run test:client',
} as unknown as PhaseView;

const rowOf = (
  p: PhaseView,
  over: { record?: PhaseRecord; liveness?: LaneLiveness; onRunAlone?: (phase: number) => void } = {},
): PhaseTableRow => ({
  p: { ...p, elsewhere: false, ...(over.record ? { record: over.record } : {}) },
  scope: { slug: 'demo', run: null, live: false, allowRun: true, onRunAlone: over.onRunAlone ?? (() => {}) },
  rulings: 0,
  holds: [],
  ...(over.liveness ? { liveness: over.liveness } : {}),
});

function mountPanel() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Mount the panel, then Inspect: the grid's press, without the grid. */
function inspectIn(row: PhaseTableRow) {
  const out = mountPanel();
  act(() => inspectPhase(row));
  return out;
}

const panel = () => screen.getByRole('region', { name: 'Shell and navigation' });
const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrefs({ everything: {}, tables: {} });
  plan.mockResolvedValue({ summary: { slug: 'demo' }, phases: [FULL_PHASE] } as unknown as PlanDetail);
});

afterEach(() => {
  act(() => __resetInspectorForTests());
});

describe('a phase in the panel — what it says about the phase as written', () => {
  it('names the record it is about — the number is part of the name', () => {
    inspectIn(rowOf(BOARD_PHASE));
    // Two plans open in two tabs, and a panel titled with a phase title alone
    // is unattributed in both.
    expect(screen.getByRole('heading', { name: 'Shell and navigation' })).toBeInTheDocument();
    expect(within(panel()).getByText('Phase 04 of demo')).toBeInTheDocument();
    // …and its board word is the panel's identity row, as a dot and a word.
    expect(panel().querySelector('[data-status="done"]')).toHaveTextContent('Done');
  });

  it('asks the panel for a reading measure — facts, folds and prose, never a table’s width', () => {
    let seen: Inspected | null = null;
    function Probe() {
      seen = useInspected();
      return null;
    }
    render(<Probe />);
    act(() => inspectPhase(rowOf(BOARD_PHASE)));
    expect((seen as Inspected | null)?.measure).toBe('reading');
  });

  it('is keyed by plan and phase, so a grid can tell its own row is the one on show', () => {
    expect(phaseInspectKey('demo', 4)).toBe('phase:demo:4');
    expect(phaseInspectKey('demo', 4)).not.toBe(phaseInspectKey('other', 4));
  });

  it('reads the prose out of its own fetch, which the host page never asked for', async () => {
    inspectIn(rowOf(BOARD_PHASE));
    // `BOARD_PHASE` has none of these. If the panel read its row, every prose
    // row would be dropped by `KeyValue` and the panel would say nothing.
    expect(await screen.findByText('Put the nav on the 4.0 system.')).toBeInTheDocument();
    expect(screen.getByText('Register the two destinations, then band the rail.')).toBeInTheDocument();
    expect(screen.getByText('npm run test:client')).toBeInTheDocument();
  });

  it('asks for exactly the groups those fields live in', async () => {
    inspectIn(rowOf(BOARD_PHASE));
    await screen.findByText('Put the nav on the 4.0 system.');
    expect(plan).toHaveBeenCalledWith('demo', { include: PROSE_INCLUDES });
    expect([...PROSE_INCLUDES].sort()).toEqual(['handoffs', 'prose']);
  });

  it('shows what it already knows while the fetch is in flight', () => {
    // A promise that never settles: the panel must still be about a phase,
    // not an empty frame with a spinner in it.
    plan.mockReturnValue(new Promise(() => {}));
    inspectIn(rowOf(BOARD_PHASE));
    expect(screen.getByRole('heading', { name: 'Shell and navigation' })).toBeInTheDocument();
    // The board's own facts are on screen with no request answered at all.
    // Exactly one: 7.0's identity row is the board word, so the scope is the
    // Repos fact alone (6.2's sheet drew it twice, as a chip and as the fact).
    expect(screen.getAllByText('phased-execution')).toHaveLength(1);
    expect(screen.getByText('eight destinations')).toBeInTheDocument();
  });

  it('lets the LIVE record win every field it has, and the fetch fill the rest', async () => {
    // The fetched payload is a different query key with its own lifetime, and
    // under `staleTime: Infinity` it is fetched once and never again. So the
    // row — which the page's own streaming query feeds — must win on state,
    // and the fetch must still supply the prose the board never carries.
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [{ ...FULL_PHASE, state: 'waiting', size: 'S' }],
    } as unknown as PlanDetail);
    inspectIn(rowOf({ ...BOARD_PHASE, state: 'in-progress' } as PhaseView));

    expect(await screen.findByText('Put the nav on the 4.0 system.')).toBeInTheDocument();
    // The live word, not the one the panel's own fetch happened to return.
    expect(panel().querySelector('[data-status="in-progress"]')).toHaveTextContent('In progress');
    expect(panel().querySelector('[data-status="waiting"]')).toBeNull();
    expect(screen.getByText(/^L, weight/)).toBeInTheDocument();
    expect(screen.queryByText(/^S, weight/)).toBeNull();
  });

  it('restores every sub-field the BOARD projection strips out of an object it keeps', async () => {
    // The defect this pins: `handoff` is present on the board record and lossy
    // (`HANDOFF_PROSE_FIELDS` — the board keeps the reference so the grid can
    // draw its status, and strips only the paragraph). A flat spread with the
    // live record last threw away the very thing the panel paid a request
    // for, and rendered Outstanding permanently blank.
    //
    // Derived from the constant, not hard-coded: adding a second sub-field to
    // that list turns this red until the merge handles it too.
    expect(HANDOFF_PROSE_FIELDS.length).toBeGreaterThan(0);
    const fullHandoff = Object.fromEntries(
      HANDOFF_PROSE_FIELDS.map((f: string) => [f, `the ${f} paragraph`]),
    );
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [
        { ...FULL_PHASE, handoff: { file: 'h.md', status: 'complete', skillsUsed: [], ...fullHandoff } },
      ],
    } as unknown as PlanDetail);
    // What the board carries: the SAME reference, with those fields omitted.
    inspectIn(
      rowOf({
        ...BOARD_PHASE,
        handoff: { file: 'h.md', status: 'complete', skillsUsed: [] },
      } as unknown as PhaseView),
    );

    await screen.findByText('Put the nav on the 4.0 system.');
    for (const f of HANDOFF_PROSE_FIELDS) {
      expect(screen.getByText(`the ${f} paragraph`)).toBeInTheDocument();
    }
  });

  it('lets the live handoff win every key it carries, not just the object', async () => {
    // The other half of the sub-field merge: `handoff.status` moves on the
    // stream while the fetched copy is frozen by `staleTime: Infinity`, so a
    // panel preferring the fetched one reports a stale status for as long as
    // it is open.
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [
        {
          ...FULL_PHASE,
          handoff: {
            file: 'h.md',
            status: 'in-progress',
            skillsUsed: [],
            outstanding: 'the outstanding paragraph',
          },
        },
      ],
    } as unknown as PlanDetail);
    inspectIn(
      rowOf({
        ...BOARD_PHASE,
        handoff: { file: 'h.md', status: 'complete', skillsUsed: [] },
      } as unknown as PhaseView),
    );

    // The paragraph comes from the fetch…
    expect(await screen.findByText('the outstanding paragraph')).toBeInTheDocument();
    // …and the status from the live record, in the same object.
    const status = panel().querySelector('[data-vocab="handoff"]');
    expect(status).toHaveAttribute('data-status', 'complete');
    expect(panel().querySelector('[data-vocab="handoff"][data-status="in-progress"]')).toBeNull();
  });

  it('keeps the raw record one rung down, and names it — the record the prose came from', async () => {
    inspectIn(rowOf(BOARD_PHASE));
    await screen.findByText('Put the nav on the 4.0 system.');
    // A rung, not a wall of JSON on top of the facts.
    expect(screen.queryByText(/"phase": 4/)).toBeNull();
    openTab('Raw');
    const raw = await screen.findByText(/"phase": 4/);
    // The FETCHED record merged under the live one, not the row alone — the
    // raw view of a panel showing prose must be the thing the prose came from.
    expect(raw.textContent).toContain('"steps": "Register the two destinations, then band the rail."');
    expect(raw.textContent).toContain('"state": "done"');
  });
});

/* ------------------------------------------------------------------------- *
 * The run's record, in eight sections
 * ------------------------------------------------------------------------- */

const AT = (hour: number) => `2026-10-09T${String(hour).padStart(2, '0')}:00:00.000Z`;

/** A record holding a field for each of the eight sections — and the text each opens onto. */
const FULL_RECORD = {
  phase: 4,
  status: 'parked',
  attempts: 2,
  costUsd: 2.5,
  turns: 14,
  // Boarding
  sessionId: 'sess-boarding-1',
  // Context
  tokens: [
    {
      calls: 300,
      lastContext: 400_000,
      peakContext: 455_000,
      input: 900,
      cacheWrite: 700_000,
      cacheRead: 60_000_000,
      output: 90_000,
      rebuilds: 2,
      mode: 'phase',
      sessionId: 'sess-boarding-1',
      resumed: false,
      model: 'claude-opus-5-5',
      window: 1_000_000,
      endedAt: AT(10),
    },
  ],
  // Verification
  verification: {
    ok: false,
    reason: 'npm test exited 1',
    ran: [{ command: 'npm test', ok: false, code: 1, ms: 1_200, output: '' }],
    notRun: [],
  },
  // Waits and watches
  parkReason: 'waiting for the deploy of 0588175c',
  waitHistory: [{ parkedFrom: AT(11), parkedUntil: AT(13), by: 'session' }],
  // Queue
  queuedMs: 120_000,
  // Walls and permissions
  toolDenied: { tool: 'Bash', rule: 'Bash(git push:*)', at: AT(9) },
  // Isolation and trees
  keepsLane: { at: AT(9), reason: 'uncommitted work', sessionId: null, paths: 3 },
  // History only
  qa: [{ round: 1, verdict: 'fail', at: AT(12) }],
  halt: { at: AT(8), kind: 'failure-streak', reason: 'verification failed twice' },
} as unknown as PhaseRecord;

/** What each section opens onto for `FULL_RECORD`. */
const OPENS_ONTO: Record<string, string> = {
  boarding: 'sess-boarding-1',
  context: 'phase, claude-opus-5-5: peak 455k of 1000k, 300 calls, 2 rebuilds',
  verification: 'red: npm test exited 1',
  waits: 'waiting for the deploy of 0588175c',
  queue: 'Queued for',
  walls: 'Bash(git push:*)',
  isolation: 'uncommitted work, 3 uncommitted paths',
  cost: '$2.50',
};

function mountSections(record: PhaseRecord | undefined) {
  return render(
    <TooltipProvider>
      <PhaseRecordSections record={record} />
    </TooltipProvider>,
  );
}

const sectionIds = (root: ParentNode = document) =>
  [...root.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));

describe('the run’s record, in eight sections (exit criterion 2)', () => {
  it('draws all eight in the order a person asks "what happened?", each folded behind its name and its count', () => {
    expect(PHASE_RECORD_SECTIONS.map((s) => s.label)).toEqual([
      'Boarding',
      'Context',
      'Verification',
      'Waits and watches',
      'Queue',
      'Walls and permissions',
      'Isolation and trees',
      'Cost',
    ]);
    mountSections(FULL_RECORD);
    expect(sectionIds()).toEqual(PHASE_RECORD_SECTIONS.map((s) => s.id));
    for (const section of PHASE_RECORD_SECTIONS) {
      const toggle = screen.getByTestId(`phase-section-${section.id}`);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // A fold strip: the name, and its count in a pill — heard as "Boarding (4)".
      expect(toggle.textContent).toMatch(new RegExp(`^${section.label} \\(\\d+\\)$`));
      // A fold is not a cache: what it folds is not in the page until it opens.
      expect(screen.queryByText(OPENS_ONTO[section.id]!, { exact: false })).toBeNull();
    }
  });

  it('opens each section in place onto the fields the record holds — one press each', () => {
    mountSections(FULL_RECORD);
    for (const section of PHASE_RECORD_SECTIONS) {
      const toggle = screen.getByTestId(`phase-section-${section.id}`);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(body.textContent, `${section.label} opens onto its fields`).toContain(OPENS_ONTO[section.id]);
    }
  });

  it('says "nothing recorded" for a section with nothing to say, and offers no fold that opens onto nothing', () => {
    mountSections({ phase: 4, status: 'pending', attempts: 1, costUsd: 0 } as PhaseRecord);
    // Boarding has the attempt; every other section has nothing.
    expect(screen.getByTestId('phase-section-boarding')).toBeInTheDocument();
    for (const section of PHASE_RECORD_SECTIONS.filter((s) => s.id !== 'boarding')) {
      expect(screen.queryByTestId(`phase-section-${section.id}`)).toBeNull();
      expect(screen.getByText(`${section.label}: nothing recorded.`)).toBeInTheDocument();
    }
  });

  it('is ONE accordion of fold strips: the sections are its folds, the arrow keys move between them', () => {
    mountSections(FULL_RECORD);
    const boarding = screen.getByTestId('phase-section-boarding');
    // The trigger is the fold's head inside a heading, and several folds may be open at once.
    expect(boarding.closest('h3')).not.toBeNull();
    fireEvent.click(boarding);
    fireEvent.click(screen.getByTestId('phase-section-cost'));
    expect(boarding).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('phase-section-cost')).toHaveAttribute('aria-expanded', 'true');
    // The sections stay addressable by id, folds and "nothing recorded" lines alike.
    expect(boarding.closest('[data-section]')).toHaveAttribute('data-section', 'boarding');
  });

  it('with Everything on, every section is open — no press at all', () => {
    setPrefs({ everything: { plan: true } });
    mountSections(FULL_RECORD);
    for (const section of PHASE_RECORD_SECTIONS) {
      expect(screen.getByTestId(`phase-section-${section.id}`)).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText(OPENS_ONTO[section.id]!, { exact: false })).toBeInTheDocument();
    }
  });

  it('says a phase that has not boarded has no record yet, rather than eight empty sections', () => {
    mountSections(undefined);
    expect(screen.getByText(/has no record of the phase yet/)).toBeInTheDocument();
    expect(sectionIds()).toEqual([]);
  });
});

describe('the panel’s other tabs', () => {
  const liveness: LaneLiveness = {
    phase: 4,
    lastOutputAt: AT(12),
    turnsSinceLastTool: 0,
    commitsSinceStart: 1,
    treeDirty: false,
  };

  it('Raw carries the whole record: the phase, this run’s record of it and its lane', async () => {
    inspectIn(rowOf(BOARD_PHASE, { record: FULL_RECORD, liveness }));
    openTab('Raw');
    const raw = (await screen.findByText(/"record": \{/)).textContent ?? '';
    const parsed = JSON.parse(raw) as {
      phase: Record<string, unknown>;
      record: Record<string, unknown>;
      liveness: unknown;
    };
    expect(parsed.phase).toMatchObject({ phase: 4, title: 'Shell and navigation', state: 'done' });
    // The record whole — every section's fields, not the ones a section chose to say.
    expect(parsed.record).toEqual(JSON.parse(JSON.stringify(FULL_RECORD)));
    expect(parsed.liveness).toEqual(liveness);
  });

  it('History lists the sessions, the waits, the QA rounds and the halt on one axis, newest first', () => {
    inspectIn(rowOf(BOARD_PHASE, { record: FULL_RECORD }));
    openTab('History');
    const events = within(screen.getByTestId('phase-history'))
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(events).toHaveLength(4);
    expect(events[0]).toContain('QA round 1: fail');
    expect(events[1]).toContain('Parked by session');
    expect(events[2]).toContain('A phase session ended on claude-opus-5-5, peak context 455k');
    // The halt by its kind: its sentence is the halt card's to say (the Run view).
    expect(events[3]).toContain('Halted, failure-streak');
    expect(events[3]).not.toContain('verification failed twice');
  });

  it('History says so when nothing has happened to the phase in this run', () => {
    inspectIn(rowOf(BOARD_PHASE));
    openTab('History');
    expect(screen.getByText('Nothing has happened to this phase in this run yet.')).toBeInTheDocument();
  });

  it('Actions is the row’s own verb set — the panel and the row cannot disagree', () => {
    const onRunAlone = vi.fn();
    inspectIn(rowOf({ ...BOARD_PHASE, state: 'ready' } as PhaseView, { onRunAlone }));
    openTab('Actions');
    fireEvent.click(screen.getByRole('button', { name: 'Run only this' }));
    expect(onRunAlone).toHaveBeenCalledWith(4);
    expect(screen.getByRole('link', { name: 'open phase 4' })).toHaveAttribute('href', '#/plan/demo/phase/4');
  });
});
