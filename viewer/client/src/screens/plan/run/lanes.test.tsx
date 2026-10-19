/**
 * The run's lanes with their clocks — the glance's working part (7.0,
 * quiet-console phase 11).
 *
 * The properties, in the order they would bite:
 *
 *   - **one line per lane, worst first, with the console's checks placed
 *     against them** — a silent lane leads however long a healthy one has run,
 *     and a check stands in for a lane with no session;
 *   - **every duration is a labelled clock** — the lane's attempt with its
 *     verb, the heartbeat as "heard … ago", the estimate beside it or "over
 *     estimate" past it — and the branch is a machine value;
 *   - **a silent lane reads silent**, in the failed hue, by the same clock the
 *     order reads;
 *   - **a moving lane says what it is doing now**: the report's slowness first,
 *     else its task;
 *   - **the asked lane** (`?lane=pN`) is marked current and brought into view
 *     once, by moving the one scroller;
 *   - **the rest of the run's future**: the phases nothing drives and the ones
 *     waiting on their dependencies, each in exactly one place;
 *   - **nothing at all** for a run with no lane and nothing to wait on.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => request(path),
    post: async () => ({ run: null }),
  };
});
// A lane's newest event is `./activity`'s, which reads it itself and has a suite of its own.
vi.mock('./activity', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<typeof import('./activity')>()),
    LastActivity: ({ phase }: { phase: number }) =>
      createElement('span', { 'data-testid': 'last-activity', 'data-phase': phase }),
  };
});

import type { PhaseEta, PhaseReport, PlanDetail, RunState } from '@/data/api';
import { RunLanes, laneReportLine, runLaneRows } from './lanes';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const NOW = Date.now();
const SEC = 1000;
const MIN = 60 * SEC;
const iso = (ms: number) => new Date(ms).toISOString();

const beat = (phase: number, agoMs: number) => ({
  phase,
  lastOutputAt: iso(NOW - agoMs),
  turnsSinceLastTool: 0,
  commitsSinceStart: 0,
  treeDirty: false,
});

/**
 * A live run: P6 healthy on its own branch, P7 silent for eleven minutes, and
 * the console's own baseline on P8, which no session holds yet.
 */
function liveRun(over: Partial<RunState> = {}): RunState {
  return {
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'running',
    model: 'opus',
    effort: 'max',
    autonomy: 'keep-going',
    spentUsd: 1,
    runBudgetUsd: 10,
    createdAt: iso(NOW - 60 * MIN),
    updatedAt: iso(NOW - MIN),
    activePhase: 6,
    child: null,
    children: {
      6: { pid: 106, phase: 6, sessionId: 's6', startedAt: iso(NOW - 14 * MIN), branch: 'pe/demo-p6' },
      7: { pid: 107, phase: 7, sessionId: 's7', startedAt: iso(NOW - 30 * MIN) },
    },
    verifying: {
      8: {
        phase: 8,
        purpose: 'baseline',
        command: 'npm test',
        index: 1,
        total: 2,
        startedAt: iso(NOW - 3 * MIN),
        commandStartedAt: iso(NOW - MIN),
        pid: 900,
      },
    },
    phases: {
      6: {
        phase: 6,
        status: 'running',
        attempts: 1,
        costUsd: 1.1,
        model: 'opus',
        effort: 'max',
        attemptWindows: [{ attempt: 1, startedAt: iso(NOW - 14 * MIN) }],
        liveness: beat(6, 5 * SEC),
      },
      7: {
        phase: 7,
        status: 'running',
        attempts: 1,
        costUsd: 0,
        attemptWindows: [{ attempt: 1, startedAt: iso(NOW - 30 * MIN) }],
        liveness: beat(7, 11 * MIN),
      },
      8: { phase: 8, status: 'pending', attempts: 0, costUsd: 0 },
    },
    ...over,
  } as unknown as RunState;
}

const view = (phase: number, title: string, state: string, more: Record<string, unknown> = {}) => ({
  phase,
  title,
  state,
  gated: false,
  bullets: [],
  ...more,
});

const DETAIL = {
  summary: { slug: 'demo', title: 'Demo' },
  phases: [
    view(6, 'the tests', 'in-progress'),
    view(7, 'the api', 'in-progress'),
    view(8, 'the docs', 'in-progress'),
  ],
} as unknown as PlanDetail;

const eta = (phase: number, minutes: number): PhaseEta => ({
  phase,
  weight: 1,
  estMs: minutes * MIN,
  basis: 'plan',
  clock: 'working',
  label: `~${minutes} min`,
});

/** The report the server composes, live. */
function report(phase: number, over: Partial<PhaseReport> = {}): PhaseReport {
  return {
    slug: 'demo',
    runId: 'r1',
    phase,
    at: iso(NOW),
    status: 'running',
    live: true,
    doing: {},
    done: { count: 0, total: 0, items: [] },
    left: { count: 0, items: [] },
    waitingOn: [],
    whySlow: [],
    eta: { minutes: null, confidence: 'none', basis: 'nothing measured yet', source: [] },
    timeline: [],
    summary: `Phase ${phase} is running.`,
    ...over,
  } as PhaseReport;
}

const REPORTS: Record<string, PhaseReport> = {
  6: report(6, {
    whySlow: [
      { rule: 'machine-load', text: 'The machine is loaded.', source: [] },
      { rule: 'long-tool', text: 'A tool has run for six minutes.', source: [] },
    ] as PhaseReport['whySlow'],
  }),
  7: report(7, {
    doing: {
      task: { id: 't2', text: 'Wiring the runner', source: [] },
      operation: { label: 'tests', done: 3, of: 7, pct: 43, at: iso(NOW), source: [] },
    },
    eta: { minutes: { low: 5, high: 10 }, confidence: 'medium', basis: 'its own rate', source: [] },
  }),
};

/** Mounted under one query client, which a rerender keeps. */
function mount(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(node, { wrapper });
}

/** Every line of the lane list, in order, as `<kind> <phase>`. */
const lines = (): string[] =>
  [...screen.getByTestId('run-lanes').querySelectorAll<HTMLElement>('ul > li')].map(
    (li) => `${li.dataset.testid === 'verifying-lane' ? 'check' : 'lane'} ${li.dataset.phase}`,
  );

const lane = (phase: number): HTMLElement =>
  screen.getAllByTestId('run-lane').find((li) => li.dataset.phase === String(phase))!;

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    const phase = /^\/api\/run\/demo\/phase\/(\d+)\/report$/.exec(path)?.[1];
    if (phase && REPORTS[phase]) return REPORTS[phase];
    if (phase) return { live: false };
    throw new Error(`unmocked ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * The lanes
 * ------------------------------------------------------------------ */

describe('the run’s lanes', () => {
  it('draws one line per lane and the console’s check, worst first, with labelled clocks and branches', () => {
    mount(
      <RunLanes
        slug="demo"
        run={liveRun()}
        detail={DETAIL}
        live
        allowRun
        phaseEta={[eta(6, 40), eta(7, 20)]}
      />,
    );
    const section = screen.getByRole('region', { name: 'Lanes' });
    // Each lane names its phase's status as a badge, not only a leading edge (#361).
    for (const li of screen.getAllByTestId('run-lane')) {
      if (li.querySelector('[data-testid="lane-frozen"]')) continue;
      expect(
        li.querySelector('[data-vocab="phase"][data-chrome="badge"]'),
        `lane ${li.dataset.phase}`,
      ).not.toBeNull();
    }
    expect(within(section).getByRole('heading', { name: /^Lanes/ }).textContent).toBe('Lanes3');
    // The silent lane leads; the healthy one and the check follow, oldest first.
    expect(lines()).toEqual(['lane 7', 'lane 6', 'check 8']);

    const p6 = lane(6);
    expect(p6.textContent).toContain('P6');
    expect(p6.textContent).toContain('the tests');
    expect(within(p6).getByText('pe/demo-p6').className).toContain('font-mono');
    expect(within(p6).getByTestId('lane-clock').textContent).toMatch(
      /^running 14m \d{2}s, expected ~40 min of work$/,
    );
    expect(within(p6).getByTestId('lane-beat').textContent).toMatch(/^heard \d+s ago$/);
    expect(p6.textContent).toContain('$1.10');
    expect(p6.textContent).toContain('opus at max effort');
    // Worked past its estimate: said so, never a bare figure.
    expect(within(lane(7)).getByTestId('lane-clock').textContent).toMatch(
      /^running 30m \d{2}s, over estimate$/,
    );
    // No session holds P8: the console's check stands in for the lane.
    expect(screen.getByTestId('verifying-lane').textContent).toContain('baseline, command 1 of 2');
    // Each session's own controls; the check is the console's, and has none.
    expect(within(p6).getByRole('group', { name: 'Phase 6 session controls' })).toBeInTheDocument();
    expect(within(screen.getByTestId('verifying-lane')).queryByRole('group')).toBeNull();
  });

  it('reads a silent lane as silent, by the clock the order reads', () => {
    mount(<RunLanes slug="demo" run={liveRun()} detail={DETAIL} live allowRun={false} />);
    const silent = within(lane(7)).getByTestId('lane-beat');
    expect(silent).toHaveAttribute('data-silent');
    expect(silent.className).toContain('state-failed');
    expect(silent.textContent).toMatch(/^heard 11m( \d+s)? ago$/);
    expect(within(lane(6)).getByTestId('lane-beat')).not.toHaveAttribute('data-silent');
    // Without --allow-run the lanes carry no controls.
    expect(screen.queryByRole('group', { name: /session controls/ })).toBeNull();
  });

  it('says what a moving lane is doing now: slow first, else its task', async () => {
    mount(<RunLanes slug="demo" run={liveRun()} detail={DETAIL} live allowRun={false} />);
    expect((await within(lane(6)).findByTestId('lane-report')).textContent).toBe(
      'Slow: The machine is loaded (and 1 more).',
    );
    const doing = await within(lane(7)).findByTestId('lane-report');
    expect(doing.textContent).toBe('On Wiring the runner, tests 3 of 7, about 5–10 min left.');
    expect(doing).toHaveAttribute('data-why', 'doing');
    // …and the newest thing each session did, under it.
    expect(within(lane(6)).getByTestId('last-activity')).toHaveAttribute('data-phase', '6');
    expect(within(screen.getByTestId('verifying-lane')).queryByTestId('last-activity')).toBeNull();
    expect(request).toHaveBeenCalledWith('/api/run/demo/phase/6/report');
  });

  it('gives a frozen lane Continue, a queued one only its Stop, and a parked one its reason', () => {
    const r = liveRun({
      children: {
        6: {
          pid: 106,
          phase: 6,
          sessionId: 's6',
          startedAt: iso(NOW - 14 * MIN),
          frozen: { at: iso(NOW - 2 * MIN), by: 'me', escalateAt: iso(NOW + 13 * MIN) },
        },
      },
      verifying: {},
      phases: {
        6: { phase: 6, status: 'running', attempts: 1, costUsd: 0 },
        9: { phase: 9, status: 'queued', attempts: 0, costUsd: 0, lockWaitSince: iso(NOW - 4 * MIN) },
        10: {
          phase: 10,
          status: 'parked',
          attempts: 1,
          costUsd: 0,
          note: 'phase 10 is locked by another session and has waited 120 minutes for it',
        },
      },
    } as Partial<RunState>);
    mount(<RunLanes slug="demo" run={r} detail={DETAIL} live allowRun />);

    const frozen = lane(6);
    // A freeze is a standing wait, never a summons: the model's paint, not amber.
    expect(frozen.className).toContain('state-waiting');
    expect(within(frozen).getByTestId('lane-frozen').textContent).toBe('frozen by me');
    expect(within(frozen).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    // Stopped where it stood, it is doing nothing now: no report, no newest event.
    expect(within(frozen).queryByTestId('lane-report')).toBeNull();
    expect(within(frozen).queryByTestId('last-activity')).toBeNull();

    const queued = lane(9);
    expect(within(queued).getByTestId('lane-clock').textContent).toMatch(/^queued 4m \d{2}s$/);
    expect(within(queued).queryByRole('button', { name: 'Freeze' })).toBeNull();
    expect(within(queued).getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    const parked = lane(10);
    expect(parked.textContent).toContain('has waited 120 minutes for it');
    expect(within(parked).queryByRole('group')).toBeNull();
  });

  it('marks the asked lane current and brings it into view once', async () => {
    const scrollTo = vi.fn();
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(scrollTo);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = (top: number, bottom: number) =>
        ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
      if (this.tagName === 'MAIN') return box(0, 600);
      if ((this as HTMLElement).dataset?.phase === '6' && this.tagName === 'LI') return box(900, 940);
      return box(0, 0);
    });
    const { rerender } = mount(
      <main>
        <RunLanes slug="demo" run={liveRun()} detail={DETAIL} live allowRun={false} laneAsked={6} />
      </main>,
    );
    expect(lane(6)).toHaveAttribute('data-current');
    expect(lane(6)).toHaveAttribute('aria-current', 'true');
    expect(lane(7)).not.toHaveAttribute('data-current');
    // Below the fold: the one scroller moves it in, a little under its top edge.
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 876, behavior: 'smooth' }));

    // A fresh record — the view is re-read on every event — moves nothing.
    rerender(
      <main>
        <RunLanes slug="demo" run={liveRun()} detail={DETAIL} live allowRun={false} laneAsked={6} />
      </main>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('leaves the page where it is when the asked lane is already in view', async () => {
    const scrollTo = vi.fn();
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(scrollTo);
    mount(
      <main>
        <RunLanes slug="demo" run={liveRun()} detail={DETAIL} live allowRun={false} laneAsked={8} />
      </main>,
    );
    // A check can be asked for too: it is the lane.
    expect(screen.getByTestId('verifying-lane')).toHaveAttribute('data-current');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * The rest of the run's future
 * ------------------------------------------------------------------ */

describe('what the run does next', () => {
  /** P10 waits on P6 and P9; P7 reads waiting on the board but already holds a lane; P11 nothing drives. */
  const PLAN = {
    summary: { slug: 'demo', title: 'Demo' },
    phases: [
      view(6, 'the tests', 'in-progress'),
      view(7, 'the api', 'waiting', { analysis: { dependsOn: [6] } }),
      view(8, 'the docs', 'in-progress'),
      view(9, 'the site', 'ready'),
      view(10, 'the release', 'waiting', { analysis: { dependsOn: [6, 9] } }),
      view(11, 'the notes', 'stuck', { analysis: { dependsOn: [] } }),
    ],
  } as unknown as PlanDetail;

  const withUndriven = () => {
    const r = liveRun();
    r.phases['11'] = {
      phase: 11,
      status: 'pending',
      attempts: 0,
      costUsd: 0,
      undriven: { since: iso(NOW - 40 * MIN), board: 'stuck', situation: null, why: 'Nothing boarded it.' },
    } as unknown as RunState['phases'][string];
    return r;
  };

  it('draws the dependency-waiting phases after the lanes, each in one place', () => {
    mount(<RunLanes slug="demo" run={withUndriven()} detail={PLAN} live allowRun />);
    expect(screen.getByRole('heading', { name: /^Waiting on other phases/ })).toBeInTheDocument();
    const waiting = screen.getAllByTestId('waiting-phase').map((li) => li.dataset.phase);
    // P7 has a lane and P11 is nothing's: neither is listed as waiting its turn.
    expect(waiting).toEqual(['10']);
    expect(screen.getAllByText(/Starts by itself the moment these finish/)).toHaveLength(1);
    const undriven = screen.getByTestId('undriven');
    expect(
      within(undriven)
        .getAllByTestId('undriven-phase')
        .map((li) => li.dataset.phase),
    ).toEqual(['11']);
    expect(within(undriven).getByText('Nothing boarded it.')).toBeInTheDocument();
  });

  it('draws neither once the run is not live', () => {
    mount(<RunLanes slug="demo" run={withUndriven()} detail={PLAN} live={false} allowRun />);
    expect(screen.queryByTestId('run-waiting')).toBeNull();
    expect(screen.queryByTestId('undriven')).toBeNull();
  });

  it('says so in one line when the only thing left is waiting', () => {
    const idle = liveRun({ children: {}, verifying: {}, phases: {} });
    mount(<RunLanes slug="demo" run={idle} detail={PLAN} live allowRun />);
    expect(screen.getByText('No phase holds a lane right now.')).toBeInTheDocument();
    expect(screen.getAllByTestId('waiting-phase').map((li) => li.dataset.phase)).toEqual(['7', '10', '11']);
  });

  it('draws nothing for a run with no lane and nothing to wait on', () => {
    // A finished run still carrying a `verifying` entry: no loop is behind it,
    // so no check is running — the record is what a dead console left.
    const { container, unmount } = mount(
      <RunLanes slug="demo" run={liveRun({ status: 'finished' })} detail={PLAN} live={false} allowRun />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();

    const quiet = liveRun({ children: {}, verifying: {}, phases: {} });
    const done = mount(<RunLanes slug="demo" run={quiet} detail={DETAIL} live allowRun />);
    expect(done.container).toBeEmptyDOMElement();
  });
});

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

describe('runLaneRows', () => {
  it('is the lane fold, worst first, with each check placed against its lane', () => {
    const rows = runLaneRows(liveRun(), DETAIL, NOW);
    expect(
      rows.map((row) => (row.kind === 'lane' ? `lane ${row.lane.phase}` : `check ${row.check.phase}`)),
    ).toEqual(['lane 7', 'lane 6', 'check 8']);
    const first = rows[0]!;
    expect(first.kind === 'lane' && first.lane.title).toBe('the api');
  });
});

describe('laneReportLine', () => {
  it('says why it is slow before anything else', () => {
    expect(laneReportLine(REPORTS[6]!)).toEqual({
      kind: 'slow',
      text: 'Slow: The machine is loaded (and 1 more).',
    });
  });

  it('else its task, its operation and the minutes left', () => {
    expect(laneReportLine(REPORTS[7]!)?.text).toBe(
      'On Wiring the runner, tests 3 of 7, about 5–10 min left.',
    );
    expect(
      laneReportLine(
        report(7, { eta: { minutes: { low: 0, high: 0 }, confidence: 'low', basis: 'x', source: [] } }),
      )?.text,
    ).toBe('Phase 7 is running, about to finish.');
    expect(laneReportLine(report(7))?.text).toBe('Phase 7 is running.');
  });

  it('says nothing for a phase no session is working', () => {
    expect(laneReportLine(report(7, { live: false }))).toBeNull();
  });
});
