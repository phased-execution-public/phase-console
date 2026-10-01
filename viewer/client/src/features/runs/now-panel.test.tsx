import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseActivity, PhaseReport } from '@/lib/api';
import { applyEffect, keys, queryClientConfig } from '@/lib/queries';
import { LastActivity, LastActivityLine, NowPanel, NowReport, activityLine } from './now-panel';

const at = (min: number) => new Date(Date.parse('2026-09-26T10:00:00Z') + min * 60_000).toISOString();

const REPORT: PhaseReport = {
  slug: 'demo',
  runId: 'r1',
  phase: 11,
  at: at(56),
  status: 'running',
  live: true,
  doing: {
    task: {
      id: 'p11.task3',
      text: 'p11.task3 — design review',
      since: at(22),
      source: [{ kind: 'task', id: 'p11.task3' }],
    },
    operation: {
      label: 'iOS sweep vendor',
      done: 45,
      of: 68,
      pct: 66,
      at: at(50),
      source: [{ kind: 'journal', seq: 106, event: 'phase.progress' }],
    },
    last: { text: 'Vendor is at 45 of 68.', at: at(55), source: [{ kind: 'session-line', line: 'line-77' }] },
  },
  done: { count: 2, total: 3, items: [] },
  left: { count: 1, items: [] },
  waitingOn: [
    {
      kind: 'tool',
      text: 'Bash `npm run e2e:ios`, open 12 min',
      since: at(44),
      source: [{ kind: 'lane', field: 'openTool' }],
    },
  ],
  whySlow: [
    {
      rule: 'machine-load',
      text: 'machine load 46 on 12 CPUs is above the guard (18)',
      source: [{ kind: 'machine', sample: 'loadavg' }],
    },
    {
      rule: 'repeat-verification',
      text: 'repeating `npm run e2e:ios`, which this run already ran in P10 (64 min)',
      source: [
        { kind: 'lane', field: 'openTool' },
        { kind: 'journal', seq: 101, event: 'phase.verify' },
      ],
    },
  ],
  eta: {
    minutes: { low: 22, high: 53 },
    confidence: 'medium',
    basis: '2 finished tasks averaged 11 min',
    source: [],
  },
  timeline: [
    {
      id: 'p11.task1',
      text: 'p11.task1 — re-shoot',
      status: 'completed',
      startedAt: at(0),
      durationMs: 10 * 60_000,
      source: [],
    },
    {
      id: 'p11.task2',
      text: 'p11.task2 — gutter fix',
      status: 'completed',
      startedAt: at(10),
      durationMs: 12 * 60_000,
      source: [],
    },
    {
      id: 'p11.task3',
      text: 'p11.task3 — design review',
      status: 'in_progress',
      startedAt: at(22),
      durationMs: 34 * 60_000,
      source: [],
    },
  ],
  summary: 'Phase 11 is on p11.task3 — design review (for 34 min). Now: iOS sweep vendor 45/68.',
};

const ACTIVITY: PhaseActivity = {
  slug: 'demo',
  phase: 11,
  sessionId: 's',
  live: true,
  source: 'session-log',
  untrusted: true,
  bytesRead: 900,
  events: [
    { kind: 'text', at: at(40), text: 'Starting the sweep.', line: 'l1' },
    {
      kind: 'tool',
      id: 't1',
      name: 'Bash',
      description: 'Run the iOS sweep',
      summary: 'npm run e2e:ios',
      at: at(44),
      open: true,
      line: 'l2',
    },
  ],
};

function client() {
  return new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

describe('NowReport — a live phase answered from the console alone (#163)', () => {
  it('leads with the plain-language summary and the ETA with its confidence word', () => {
    render(<NowReport report={REPORT} />);
    expect(screen.getByTestId('now-summary')).toHaveTextContent('Phase 11 is on p11.task3 — design review');
    expect(screen.getByText(/22–53 min left/)).toBeInTheDocument();
    expect(screen.getByText(/medium confidence/)).toBeInTheDocument();
  });

  it('draws the active operation as a meter, and links its figure to the journal line it came from', () => {
    render(<NowReport report={REPORT} />);
    const meter = screen.getByRole('meter', { name: 'iOS sweep vendor' });
    expect(meter).toHaveAttribute('aria-valuenow', '45');
    expect(meter).toHaveAttribute('aria-valuemax', '68');
    const link = screen.getAllByRole('link', { name: 'journal 106' })[0]!;
    expect(link.getAttribute('href')).toMatch(/j=106/);
  });

  it('names what it waits on and why it is slow, each cause by its rule, each with its source', () => {
    render(<NowReport report={REPORT} />);
    const why = screen.getByRole('region', { name: 'Why it is slow' });
    const rules = within(why)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-rule'));
    expect(rules).toEqual(['machine-load', 'repeat-verification']);
    expect(within(why).getByRole('link', { name: 'journal 101' })).toBeInTheDocument();
    expect(within(why).getByTitle('machine load average')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting on' })).toHaveTextContent(
      'Bash `npm run e2e:ios`, open 12 min',
    );
  });

  it('lists every task with its start and duration, the active one marked', () => {
    render(<NowReport report={REPORT} />);
    const rows = within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['completed', 'completed', 'in_progress']);
    expect(rows[1]).toHaveTextContent('12m');
    expect(screen.getByText(/2 of 3 tasks done/)).toBeInTheDocument();
  });

  it('draws nothing for a phase that is not live', () => {
    const c = client();
    c.setQueryData([...keys.phaseNow('demo'), '11', 'report'], { ...REPORT, live: false });
    const { container } = render(
      <QueryClientProvider client={c}>
        <NowPanel slug="demo" phase={11} />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the Now panel refreshes with the journal — no reload', () => {
  it('a line that moves the report invalidates the phase views of that plan, and an unrelated one does not', () => {
    const c = client();
    const spy = vi.spyOn(c, 'invalidateQueries');
    applyEffect(c, 'run:journal', { slug: 'demo', event: 'phase.progress', phase: 11 });
    expect(
      spy.mock.calls.some(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(keys.phaseNow('demo')),
      ),
    ).toBe(true);
    spy.mockClear();
    applyEffect(c, 'run:journal', { slug: 'demo', event: 'phase.api-retry', phase: 11 });
    expect(
      spy.mock.calls.some(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(keys.phaseNow('demo')),
      ),
    ).toBe(false);
  });
});

describe('LastActivity — the newest thing a lane did, from its own log (#138)', () => {
  it('names the open call by its description', () => {
    expect(activityLine(ACTIVITY.events[1]!)).toBe('Bash — Run the iOS sweep, running');
    expect(
      activityLine({
        kind: 'tool',
        id: 'x',
        name: 'Bash',
        summary: 'npm test',
        at: at(1),
        exit: 'error',
        code: 2,
        line: 'l',
      }),
    ).toBe('Bash — npm test, failed (exit 2)');
    render(<LastActivityLine activity={ACTIVITY} />);
    expect(screen.getByTestId('last-activity')).toHaveTextContent('Bash — Run the iOS sweep, running');
  });

  it("reads the phase's activity route and renders nothing when the session left no log", () => {
    const c = client();
    c.setQueryData([...keys.phaseNow('demo'), '11', 'activity', 5], ACTIVITY);
    c.setQueryData([...keys.phaseNow('demo'), '12', 'activity', 5], {
      ...ACTIVITY,
      phase: 12,
      source: 'none',
      events: [],
    });
    render(
      <QueryClientProvider client={c}>
        <LastActivity slug="demo" phase={11} />
        <LastActivity slug="demo" phase={12} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('last-activity')).toHaveLength(1);
  });
});
