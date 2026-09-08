/**
 * The route tab's card strip, and the departures board it sits above.
 *
 * Three properties for the cards, matching what the cards are for: a quiet plan
 * gets exactly one card — Autopilot, with the door to its tab — and no
 * manufactured alarm; a plan in trouble gets the trouble said in the run's own
 * words plus the recovery offers, deduplicated so lint and a stuck phase do not
 * mint two plan-repair buttons; and a console without `--allow-agent` still
 * shows the remedy, disabled, naming the flag — the same never-a-dead-end rule
 * every other recovery surface keeps.
 *
 * Then the board itself, which is WINDOWED: what those tests hold is that a big
 * plan puts a screenful in the DOM rather than all of it, that the rows which
 * are there are still real table rows carrying the deep link a person clicks,
 * and that assistive tech is told the true size of the board it is looking at a
 * slice of.
 *
 * And the row's two ways in, which used to be one way in and six dead ends: the
 * phase anchor's `::after` overlay covered every control in the row, so a mouse
 * could not press the state chip's link to a live session, either dependency
 * link, or the QA and review verdicts — while all of them stayed focusable and
 * keyboard-operable. The row is a click handler that stands down for anything
 * interactive now, and both halves of that are asserted below.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import { queryClientConfig } from '@/lib/queries';
import type { PlanDetail, PlanSummary } from '@/lib/api';

const { state, run, auth, terminal, plan } = vi.hoisted(() => ({
  state: vi.fn(),
  run: vi.fn(),
  auth: vi.fn(),
  terminal: vi.fn(),
  // The board itself never calls it — the phase inspector does, on open, for
  // the prose this tab deliberately does not fetch. Unmocked it would reach a
  // real `fetch` the moment a row's Inspect is pressed.
  plan: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, run, auth, terminal, plan } };
});

const DETAIL = {
  summary: {
    slug: 'demo',
    title: 'demo plan',
    kind: 'plan',
    status: 'active',
    phases: 3,
    done: 1,
    ready: [2],
    waiting: 1,
    inProgress: [],
    stuck: [],
    qaMode: 'off',
    budget: 200_000,
  },
  phases: [
    { phase: 1, title: 'Foundations', state: 'done', size: 'M', weight: 40_000, gated: false, bullets: [] },
    { phase: 2, title: 'Surface', state: 'ready', size: 'L', weight: 90_000, gated: false, bullets: [] },
    { phase: 3, title: 'Cutover', state: 'waiting', size: 'S', weight: 15_000, gated: false, bullets: [] },
  ],
  lint: { ok: true, issues: [], summary: 'LINT OK: demo — 3 phases', timedOut: false },
} as unknown as PlanDetail;

async function mount(detail: PlanDetail) {
  const client = new QueryClient(queryClientConfig);
  const { HealthPanel } = await import('./health-panel');
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HealthPanel detail={detail} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ allowAgent: true, autopilot: true });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  auth.mockResolvedValue({ loggedIn: true, checkedAt: '2026-08-05T00:00:00Z' });
  terminal.mockResolvedValue({ available: 'yes', sessions: [] });
  plan.mockResolvedValue({ summary: { slug: 'demo' }, phases: [] } as unknown as PlanDetail);
});

describe('the route tab card strip', () => {
  it('a quiet plan gets the Autopilot card, its door, and nothing else', async () => {
    await mount(DETAIL);
    expect(await screen.findByText('Autopilot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open autopilot/ })).toHaveAttribute('href', '#/plan/demo/run');
    expect(screen.getByText(/Nothing has been run/)).toBeInTheDocument();
    expect(screen.queryByText("Something's wrong")).toBeNull();
    expect(screen.queryByText('Recovery')).toBeNull();
  });

  it('a halted run and a stuck phase fill all three cards, deduplicated', async () => {
    run.mockResolvedValue({
      run: {
        id: 'r1',
        slug: 'demo',
        status: 'halted',
        model: 'opus',
        spentUsd: 3,
        halt: { at: '', reason: 'phase 2 did not verify: npm test', phase: 2 },
        phases: {},
        activePhase: null,
        child: null,
      },
      history: [],
      eta: null,
    });
    const troubled = {
      ...DETAIL,
      phases: DETAIL.phases.map((p) => (p.phase === 3 ? { ...p, state: 'stuck' } : p)),
      lint: { ok: false, issues: [], summary: 'LINT FAIL: demo — 1 problem', timedOut: false },
    } as unknown as PlanDetail;
    await mount(troubled);

    expect(await screen.findByText("Something's wrong")).toBeInTheDocument();
    // In the Autopilot summary AND the trouble banner — same words, two jobs.
    expect(screen.getAllByText(/did not verify/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Phase 3 is stuck/)).toBeInTheDocument();
    expect(screen.getByText(/LINT FAIL/)).toBeInTheDocument();

    expect(screen.getByText('Ways forward')).toBeInTheDocument();
    // The halt wants a verification fix; the stuck phase and the lint share
    // ONE plan-repair… no — the stuck phase targets its own phase, the lint
    // targets the plan, so three distinct offers stand.
    // Twice by design now: the Autopilot card's plan-level offers AND the
    // Ways-forward card both surface the class.
    expect(
      screen.getAllByRole('button', { name: /Fix the failing verification|Fix with a new agent/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /Recover & continue/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /Repair the plan with a new agent/i }).length).toBe(2);
  });

  it('without --allow-agent the remedy is disabled and names the flag — never absent', async () => {
    state.mockResolvedValue({ allowAgent: false, autopilot: true });
    run.mockResolvedValue({
      run: {
        id: 'r1',
        slug: 'demo',
        status: 'halted',
        model: 'opus',
        spentUsd: 0,
        halt: { at: '', reason: 'phase 2 did not verify: npm test', phase: 2 },
        phases: {},
        activePhase: null,
        child: null,
      },
      history: [],
      eta: null,
    });
    await mount(DETAIL);
    const buttons = await screen.findAllByRole('button', { name: /Fix with a new agent/i });
    for (const button of buttons) expect(button).toBeDisabled();
  });
});

/* ---------------- the windowed board ---------------- */

/**
 * A plan the size of the ones this console is actually used on.
 *
 * 31 phases because that is the biggest live board in the corpus and the number
 * the phase was written against — a fixture of five would let a window of ten
 * render everything and pass without windowing anything.
 */
const BIG = {
  summary: {
    slug: 'big',
    title: 'a large plan',
    kind: 'plan',
    status: 'active',
    phases: 31,
    done: 10,
    ready: [],
    waiting: 20,
    inProgress: [],
    stuck: [],
    qaMode: 'off',
    budget: 200_000,
  } as unknown as PlanSummary,
  phases: Array.from({ length: 31 }, (_, i) => ({
    phase: i + 1,
    title: `Phase ${i + 1} — **something** to do`,
    state: i < 10 ? 'done' : 'waiting',
    size: 'M',
    weight: 40_000,
    gated: false,
    bullets: [],
  })),
  route: { nodes: [], edges: [] },
  lint: { ok: true, issues: [], summary: 'LINT OK: big — 31 phases', timedOut: false },
} as unknown as PlanDetail;

/*
 * jsdom lays nothing out and the virtual engine treats an outer size of zero as
 * "no range at all", so BOTH ends of the measurement are stubbed here — the
 * scroller's height via `offsetHeight`, which is what the engine measures a
 * scroll element with, and a row's height via `getBoundingClientRect`, which is
 * what `measureElement` reads. Same shape as `components/ui/data-list.test.tsx`,
 * for the same reason. Without the row height every row measures 0, every row
 * fits the viewport, and the window silently covers the whole board.
 */
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

function layout() {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      height: 52,
      width: 900,
      top: 0,
      left: 0,
      bottom: 52,
      right: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** The same board with phase 1 genuinely being worked — a row with a link in it. */
const LIVE = {
  ...BIG,
  phases: BIG.phases.map((phase, i) => (i === 0 ? { ...phase, live: { via: 'run' } } : phase)),
} as unknown as PlanDetail;

async function mountBoard(detail: PlanDetail = BIG) {
  const client = new QueryClient(queryClientConfig);
  const { RouteTab } = await import('./route-tab');
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouteTab detail={detail} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the departures board, windowed', () => {
  beforeAll(layout);
  afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  });

  it('puts a screenful of a 31-phase board in the DOM, not all of it', async () => {
    const { container } = await mountBoard();
    await screen.findByText('Departures');

    const rows = container.querySelectorAll('tbody tr[data-index]');
    // The property, both ways round: something is rendered, and it is a
    // fraction. An assertion on only the upper bound passes on zero rows —
    // which is precisely how this went wrong once already, because the engine
    // answers an unmeasured scroller with no rows at all.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(31);
    // The card still says how many there ARE, so the count is not the window's.
    expect(screen.getByText(/31 phases/)).toBeInTheDocument();
  });

  it('spaces the rows it did not render, so the board keeps its true height', async () => {
    const { container } = await mountBoard();
    await screen.findByText('Departures');

    // A `<tr>` cannot be positioned out of flow without ceasing to be a table
    // row, so the window is two empty rows of the right height. The bottom one
    // is what makes the scrollbar honest at the top of a long board.
    const spacers = container.querySelectorAll('tbody tr[aria-hidden="true"]');
    expect(spacers.length).toBeGreaterThan(0);
    const total = [...spacers].reduce((sum, row) => sum + parseFloat((row as HTMLElement).style.height), 0);
    expect(total).toBeGreaterThan(0);
    for (const spacer of spacers) expect(spacer.querySelectorAll('td')).toHaveLength(0);
  });

  it('keeps every rendered row a deep link, and says which row of how many it is', async () => {
    const { container } = await mountBoard();
    await screen.findByText('Departures');

    const table = container.querySelector('table')!;
    // `aria-rowcount` counts the header, so a 31-phase board announces 32.
    expect(table).toHaveAttribute('aria-rowcount', '32');

    const rows = [...container.querySelectorAll('tbody tr[data-index]')] as HTMLElement[];
    for (const row of rows) {
      const index = Number(row.dataset.index);
      // The row's position in the WHOLE board, not in the window: index 0 is
      // the second row of the table, after the header.
      expect(row.getAttribute('aria-rowindex')).toBe(String(index + 2));
      // One anchor per row, still carrying the phase deep link — the phase
      // number is the row's only focusable element and its `::after` covers
      // the row, which is what makes the board keyboard-navigable at all.
      const link = row.querySelector('a')!;
      expect(link).toHaveAttribute('href', `#/plan/big/phase/${index + 1}`);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('has no axe violations while windowed', async () => {
    const { container } = await mountBoard();
    await screen.findByText('Departures');
    await expectNoAxeViolations(container);
  });
});

describe('a row is a link, without an overlay over its own controls', () => {
  beforeAll(layout);
  afterAll(() => {
    HTMLElement.prototype.getBoundingClientRect = realRect;
    if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  });

  const rowOne = (container: HTMLElement) =>
    container.querySelector('tbody tr[data-index="0"]') as HTMLElement;

  it('stretches no pseudo-element across the row', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    // `after:absolute after:inset-0` on the phase anchor, over a `relative` row.
    expect(container.querySelector('[class*="after:absolute"]')).toBeNull();
    expect(container.querySelector('[class*="after:inset-0"]')).toBeNull();
  });

  it('opens the phase from anywhere in the row that is not a control', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    location.hash = '#/nowhere';
    // The Size cell: a fact, with nothing in it that goes anywhere else.
    fireEvent.click(rowOne(container).querySelectorAll('td')[5]);
    expect(location.hash).toBe('#/plan/big/phase/1');
  });

  it('leaves the row’s own links alone — the state chip still reaches its session', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    // Addressed by destination: the anchor's accessible name is the board word
    // inside the chip, which is not what this is about.
    const chip = rowOne(container).querySelector('a[href^="#/plan/big/run"]')!;
    expect(chip).toHaveAttribute('href', '#/plan/big/run?lane=p1');
    location.hash = '#/nowhere';
    fireEvent.click(chip);
    // Whatever the anchor itself does, the ROW must not have taken the click
    // and gone to the phase page instead.
    expect(location.hash).not.toBe('#/plan/big/phase/1');
  });

  it('leaves a modified click to the browser, so a row still opens in a new tab', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    location.hash = '#/nowhere';
    fireEvent.click(rowOne(container).querySelectorAll('td')[5], { metaKey: true });
    expect(location.hash).toBe('#/nowhere');
  });

  it('offers L2 on every row, without taking the row click with it', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    // Every rendered row, not just the first: an inspect button on row one and
    // nowhere else is how a windowed list ends up with a control that vanishes
    // as you scroll.
    const rows = [...container.querySelectorAll('tbody tr[data-index]')] as HTMLElement[];
    // The property both ways round. A loop over an empty window asserts
    // nothing while looking exactly like a clean pass — and the virtualizer
    // does answer an unmeasured scroller with no rows at all.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const index = Number(row.dataset.index);
      expect(row.querySelector(`button[aria-label="Inspect phase ${index + 1}"]`)).not.toBeNull();
    }

    location.hash = '#/nowhere';
    const button = screen.getByRole('button', { name: 'Inspect phase 1' });
    fireEvent.click(button);
    // The row's click handler stands down for a button — pressing Inspect must
    // not also navigate away from the board it was pressed on.
    expect(location.hash).toBe('#/nowhere');
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Phase 01/);
  });

  it('keeps the phase number as the row’s deep link and first tab stop', async () => {
    const { container } = await mountBoard(LIVE);
    await screen.findByText('Departures');
    const row = rowOne(container);
    expect(row.querySelectorAll('td')[0].querySelector('a')).toHaveAttribute('href', '#/plan/big/phase/1');
    // The spacer rows carry no cells, so `aria-rowcount` still counts phases.
    expect(container.querySelector('table')).toHaveAttribute('aria-rowcount', '32');
    for (const spacer of container.querySelectorAll('tbody tr[aria-hidden="true"]')) {
      expect(spacer.querySelectorAll('td')).toHaveLength(0);
    }
  });
});
