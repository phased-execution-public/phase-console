/**
 * Logs ▸ Health (7.0, quiet-console phase 20) — the Health, Doctor, Process,
 * Retirement, Bundle and Metrics cases of 6.2's Debug page suite, ported to the
 * questions-between-hairlines markup. The thread is that suite's: **a
 * diagnostics page never reassures you about the thing that is broken.**
 *
 *  - Nothing costly runs until it is asked for: the doctor shells out and the
 *    bundle is a pass over every source, so each waits for its press.
 *  - The doctor's first BLOCKING failure leads — the server's pick — and an
 *    advisory failure says a start still goes ahead.
 *  - A watch clock that did not answer is "did not answer", never "nothing is
 *    parked"; a failed metrics scrape is an error, never "0 families".
 *  - An environment finding carries its fix beside it.
 *  - A fact this process did not report says so, never a blank or a zero.
 *  - The whole state and the bundle are read on the press that copies them,
 *    never on the page's own read.
 *
 * Mounted as the place mounts it, over the server answering by path. The
 * runtime strip's own cases are `runtime-strip.test.tsx`'s; here it is the
 * first question, and its failure is said in place.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path (the part before `?`); every request is logged whole. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read instanceof Error) throw read;
    if (typeof read === 'function') return (read as (path: string) => unknown)(path);
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { AccountsState, ConsoleState, DebugBundle, DoctorReport, DoctorRow } from '@/data/api';
import type { HealthSeriesView } from '@/data/logs';
import { ApiError } from '@/data/http';
import type { CeilingWindow, StartCeilingCounters } from '@/data/machine';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { parseHash, type Route } from '@/shell/routes';
import { TooltipProvider } from '@/ui/tooltip';
import HealthSection, { doctorOrder } from './health-section';
import { logsSectionHref } from './routes';

/* ---------------- the server's answers ---------------- */

const SCRAPE = [
  'phase_console_process_heap_used_bytes 1610612736',
  'phase_console_process_heap_limit_bytes 6442450944',
  'phase_console_process_event_loop_delay_seconds 0.003',
  'phase_console_process_sse_clients 2',
].join('\n');

const STATE = {
  root: { path: '/repo', ok: true, planCount: 3, handoffCount: 2 },
  platform: 'darwin',
  supervisor: { detail: 'launchd' },
  generation: 42,
  bootedAt: '2026-09-29T08:00:00.000Z',
  distRev: 'abcdef1234567',
  execArgv: ['--max-old-space-size=8192'],
} as unknown as ConsoleState;

const NO_ACCOUNTS: AccountsState = { accounts: [], allowAccounts: false };

function bundle(over: Partial<DebugBundle> = {}): DebugBundle {
  return {
    schema: 'phase-console/debug-bundle',
    version: 1,
    generatedAt: '2026-09-01T10:00:00.000Z',
    console: {},
    root: '~/repo',
    plans: [],
    health: { environment: [], watches: { passes: 4, asked: [], open: true } },
    metrics: [],
    delivery: { outcomes: {}, undelivered: 0, announcements: 0, devices: 0 },
    entries: [],
    sources: [],
    notes: [],
    ...over,
  };
}

const ROWS: DoctorRow[] = [
  { id: 'accounts', label: 'Accounts', status: 'ok', blocking: true, reason: 'one account with headroom' },
  {
    id: 'hooks',
    label: 'Hooks',
    status: 'fail',
    blocking: false,
    reason: 'the presence hook is not installed',
  },
  { id: 'mcp', label: 'MCP servers', status: 'skip', blocking: false, reason: 'none registered' },
  { id: 'gh', label: 'GitHub CLI', status: 'fail', blocking: true, reason: 'gh is not signed in' },
];

const REPORT: DoctorReport = {
  instance: { id: 'abcd1234-repo', name: 'repo', root: '/repo', port: 4130, default: false },
  mode: 'console',
  ok: false,
  cliFloor: '2.1.268',
  at: '2026-09-29T10:00:00.000Z',
  rows: ROWS,
  firstFailing: ROWS[3]!,
};

/** A retired credential whose retirement a later read contradicted (#57). */
const SUSPECT = {
  state: 'suspect',
  via: 'credential',
  evidence: {
    source: 'text',
    matched: 'credit balance is too low',
    session: 'abcdef0123456789',
    phase: 7,
    slug: 'demo',
  },
  contradicted: { at: '2026-09-29T09:00:00.000Z', by: 'usage-poll', reason: 'a usage read answered 200' },
} as const;

/** The line that stops the strays — the CLI's, which the page draws to copy. */
const STOP = 'phase-console doctor --stop-strays';

/** `/api/ceiling`: room under every limit unless a case fills one. */
function ceiling(
  over: { work?: Partial<CeilingWindow>; probe?: Partial<CeilingWindow> } = {},
): StartCeilingCounters {
  return {
    work: {
      starts: 12,
      usd: 48.2,
      limits: { startsPerHour: 40, usdPerHour: 250 },
      windowMs: 3_600_000,
      doors: { 'converge-relaunch': 7, 'wait-clock': 5 },
      full: null,
      until: null,
      ...over.work,
    },
    probe: {
      starts: 6,
      usd: 0,
      limits: { startsPerHour: 24, usdPerHour: 0 },
      windowMs: 3_600_000,
      doors: {},
      full: null,
      until: null,
      ...over.probe,
    },
  };
}

/** Two console processes whose package roots are gone. */
const STRAYS = [
  {
    pid: 4711,
    pgid: 4700,
    command: 'node /home/x/old/viewer/server/main.ts --port 4131',
    root: '/home/x/old',
  },
  { pid: 5120, pgid: 5120, command: 'node /home/x/older/viewer/server/main.ts', root: '/home/x/older' },
];

/* ---------------- the page ---------------- */

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  const address = logsSectionHref('health');
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={address}>
        <TooltipProvider>
          <HealthSection route={parseHash(address) as Route} />
        </TooltipProvider>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

const callsTo = (path: string) => server.calls.filter((one) => one === path);

/** A KeyValue's rows inside `root`, label → its value cell. */
function facts(root: HTMLElement): Record<string, HTMLElement> {
  return Object.fromEntries(
    [...root.querySelectorAll('dt')].map((dt) => [
      dt.textContent ?? '',
      dt.nextElementSibling as HTMLElement,
    ]),
  );
}

/** The section's questions, by their `data-health`, in the order drawn. */
const questions = () =>
  [...document.querySelectorAll('[data-health]')].map((one) => one.getAttribute('data-health'));

async function readTheBundle(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Read them' }));
  return screen.findByTestId('bundle-health');
}

const writeText = vi.fn(async (_text: string) => {});

/** `/api/health/series`: a few points of each measure, the bounds the server keeps them to. */
const SERIES: HealthSeriesView = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-29T10:00:00.000Z',
  bounds: { maxPoints: 2100, days: 30, sampleMs: 300_000 },
  measures: {
    gate: [
      { at: '2026-09-20T12:00:00.000Z', v: 410 },
      { at: '2026-09-27T12:00:00.000Z', v: 352, note: 'abc1234' },
    ],
    load: [
      { at: '2026-09-29T09:50:00.000Z', v: 0.4 },
      { at: '2026-09-29T09:55:00.000Z', v: 0.75 },
      { at: '2026-09-29T10:00:00.000Z', v: 0.5 },
    ],
    persist: [{ at: '2026-09-29T09:55:00.000Z', v: 12.4 }],
    reconcile: [
      { at: '2026-09-22T00:00:00.000Z', v: 3.1 },
      { at: '2026-09-29T00:00:00.000Z', v: -1.2 },
    ],
  },
};

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/metrics': SCRAPE,
    '/api/state': STATE,
    '/api/accounts': NO_ACCOUNTS,
    '/api/doctor': REPORT,
    '/api/debug/bundle': bundle(),
    '/api/ceiling': ceiling(),
    '/api/health/series': SERIES,
    '/api/doctor/strays': { at: '2026-09-29T10:00:00.000Z', strays: [], stop: STOP },
  };
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

/* ------------------------------------------------------------------ *
 * The questions
 * ------------------------------------------------------------------ */

describe('the questions, top to bottom', () => {
  it('asks eight questions in their order, each a region named by its heading — and no retirements over none', async () => {
    mount();
    await screen.findByTestId('process');
    expect(questions()).toEqual([
      'runtime',
      'series',
      'doctor',
      'process',
      'ceiling',
      'strays',
      'bundle',
      'bundle-health',
    ]);
    for (const name of [
      'This console’s runtime',
      'Over time',
      'Doctor',
      'This process',
      'Automatic starts this hour',
      'Stray consoles',
      'The bundle',
      'Environment, the watch clock and metrics',
    ])
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(screen.queryByTestId('retirements')).toBeNull();
  });

  it('reads the runtime on arrival, and says in place when the scrape failed while the rest still stands', async () => {
    server.reads['/api/metrics'] = new ApiError('the metrics renderer threw', 500, '/api/metrics');
    mount();
    const runtime = screen.getByRole('region', { name: 'This console’s runtime' });
    expect(await within(runtime).findByText(/could not be read from/)).toHaveTextContent(
      'The runtime could not be read from /api/metrics: the metrics renderer threw',
    );
    expect(within(runtime).queryByRole('meter')).toBeNull();
    // The page a person opens BECAUSE the console misbehaves keeps working.
    expect(screen.getByRole('button', { name: 'Run the doctor' })).toBeEnabled();
    expect(await screen.findByTestId('process')).toBeInTheDocument();
  });

  it('draws the runtime it read: the heap against its limit, the loop delay, the event streams', async () => {
    mount();
    const runtime = screen.getByRole('region', { name: 'This console’s runtime' });
    expect(await within(runtime).findByRole('meter', { name: 'Heap' })).toHaveAttribute(
      'aria-valuetext',
      '1.5 GB of 6.0 GB',
    );
    expect(within(runtime).getByText('3 ms')).toBeInTheDocument();
    expect(within(runtime).getByText('2')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The doctor
 * ------------------------------------------------------------------ */

describe('over time: the four measures, bounded', () => {
  it('draws a figure for each measure from the server’s points, and says the bounds in words', async () => {
    mount();
    const series = await screen.findByTestId('health-series');
    expect(series).toBe(screen.getByRole('region', { name: 'Over time' }));
    expect(await within(series).findByTestId('health-series-bounds')).toHaveTextContent(
      'Kept for 30 days, and at most 2100 points of each measure, the newest. Load and save time are sampled every 5 minutes; the gate has a point per run. Times are UTC.',
    );
    for (const id of ['gate', 'load', 'persist'] as const) {
      expect(within(series).getByTestId(`health-series-${id}`)).toHaveAttribute(
        'data-points',
        String(SERIES.measures[id].length),
      );
    }
    // Each is a strip with its newest value, and no total: a load does not add up.
    expect(within(series).getByTestId('health-series-gate')).toHaveTextContent('Gate time 5m 52s');
    expect(within(series).getByTestId('health-series-load')).toHaveTextContent('Load per core 0.50');
    expect(within(series).getByTestId('health-series-persist')).toHaveTextContent('Save time 12 ms');
    expect(series).not.toHaveTextContent('in all');
  });


  it('says what a measure with no points has not seen, in words and never a zero', async () => {
    server.reads['/api/health/series'] = {
      ...SERIES,
      measures: { gate: [], load: [], persist: [], reconcile: [] },
    };
    mount();
    const series = await screen.findByTestId('health-series');
    expect(await within(series).findByText('The full gate has not run on this machine.')).toBeInTheDocument();
    expect(within(series).getByText('No load has been sampled yet.')).toBeInTheDocument();
    expect(within(series).getByText('No run has been saved since sampling began.')).toBeInTheDocument();
  });

  it('says the server’s words when the series cannot be read, and Try again asks again', async () => {
    let asks = 0;
    server.reads['/api/health/series'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the series file is unreadable', 500, '/api/health/series');
      return SERIES;
    };
    mount();
    const series = await screen.findByTestId('health-series');
    expect(await within(series).findByText(/Health over time could not be read/)).toHaveTextContent(
      'Health over time could not be read: the series file is unreadable',
    );
    // The rest of the page still stands.
    expect(await screen.findByTestId('process')).toBeInTheDocument();
    fireEvent.click(within(series).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('health-series-bounds')).toBeInTheDocument();
    expect(asks).toBe(2);
  });
});

describe('the doctor leads with the check to fix first', () => {
  it('asks only when the reader does, then draws a probe word per row with the first blocking failure first', async () => {
    mount();
    const doctor = await screen.findByTestId('doctor');
    await screen.findByTestId('process');
    expect(callsTo('/api/doctor')).toEqual([]);

    fireEvent.click(within(doctor).getByRole('button', { name: 'Run the doctor' }));
    expect(await screen.findByTestId('doctor-verdict')).toHaveTextContent(
      'Blocked: GitHub CLI — fix that first.',
    );
    const rows = screen.getAllByTestId('doctor-row');
    expect(rows.map((row) => row.getAttribute('data-row'))).toEqual(['gh', 'hooks', 'accounts', 'mcp']);
    // The word is the probe vocabulary's, through the status family — never a colour of this page's own.
    const words = rows.map((row) => row.querySelector('[data-vocab="probe"]'));
    expect(words.map((word) => word?.getAttribute('data-status'))).toEqual(['fail', 'fail', 'ok', 'skip']);
    expect(words.map((word) => word?.textContent)).toEqual(['Fail', 'Fail', 'OK', 'Not asked']);
    // An advisory failure says a start still goes ahead — on a line of its own,
    // because a reason that ends on a command would swallow a sentence run on
    // after it — and the blocking one does not.
    expect(rows[1]).toHaveTextContent('the presence hook is not installed');
    expect(within(rows[1]!).getByText('A start still goes ahead: this one is advice.')).toHaveClass('block');
    expect(rows[0]).not.toHaveTextContent('A start still goes ahead');
    expect(callsTo('/api/doctor')).toHaveLength(1);
  });

  it('says nothing blocks a start when every blocking row passed', async () => {
    server.reads['/api/doctor'] = { ...REPORT, ok: true, firstFailing: null, rows: [ROWS[0]] };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run the doctor' }));
    const verdict = await screen.findByTestId('doctor-verdict');
    expect(verdict).toHaveTextContent('Nothing blocks a start.');
    expect(verdict).toHaveTextContent('CLI floor 2.1.268.');
  });

  it('keeps a check’s flag whole, so it wraps before the flag and never inside it', async () => {
    server.reads['/api/doctor'] = {
      ...REPORT,
      ok: true,
      firstFailing: null,
      rows: [
        {
          id: 'publish',
          label: 'Outward writes (--allow-publish)',
          status: 'skip',
          blocking: false,
          reason: 'off',
        },
      ],
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run the doctor' }));
    const [row] = await screen.findAllByTestId('doctor-row');
    expect(row).toHaveTextContent('Outward writes (--allow-publish)');
    expect(within(row!).getByText('(--allow-publish)')).toHaveClass('whitespace-nowrap');
  });

  it('orders the server’s first failure first even when another blocking failure is listed before it', () => {
    const row = (id: string, status: DoctorRow['status'], blocking = true): DoctorRow => ({
      id,
      label: id,
      status,
      blocking,
      reason: '',
    });
    const rows = [
      row('a', 'ok'),
      row('b', 'fail'),
      row('c', 'fail', false),
      row('d', 'fail'),
      row('e', 'skip'),
    ];
    // The first failing row leads, then the other blocking failures, then the
    // advice, then what passed, then what was not asked — the server's order within each.
    expect(doctorOrder(rows, rows[3]!).map((one) => one.id)).toEqual(['d', 'b', 'c', 'a', 'e']);
    expect(doctorOrder(rows, null).map((one) => one.id)).toEqual(['b', 'd', 'c', 'a', 'e']);
  });

  it('says the doctor could not run, in its own words, and draws no verdict over a failed read', async () => {
    let asks = 0;
    server.reads['/api/doctor'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('gh hung for 30 s', 504, '/api/doctor');
      return REPORT;
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run the doctor' }));
    const failed = await screen.findByText('The doctor could not run: gh hung for 30 s');
    expect(failed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
    expect(screen.queryByTestId('doctor-verdict')).toBeNull();
    expect(screen.queryByText('Nothing blocks a start.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('doctor-verdict')).toHaveTextContent('Blocked: GitHub CLI');
    expect(asks).toBe(2);
  });

  it('asks again on Check again, and the verdict follows the new answer', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run the doctor' }));
    expect(await screen.findByTestId('doctor-verdict')).toHaveTextContent('Blocked: GitHub CLI');

    server.reads['/api/doctor'] = { ...REPORT, ok: true, firstFailing: null, rows: [ROWS[0]] };
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.getByTestId('doctor-verdict')).toHaveTextContent('Nothing blocks a start.'),
    );
    expect(callsTo('/api/doctor')).toHaveLength(2);
    expect(screen.getAllByTestId('doctor-row').map((row) => row.getAttribute('data-row'))).toEqual([
      'accounts',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * This process
 * ------------------------------------------------------------------ */

describe('this process: the generation, the build and a restart’s update', () => {
  it('draws the generation, the build it serves, how node started it, what supervises it and where it reads', async () => {
    mount();
    const process = await screen.findByTestId('process');
    await waitFor(() => expect(facts(process).Generation).toHaveTextContent('42'));
    const rows = facts(process);
    expect(Object.keys(rows)).toEqual([
      'Generation',
      'Booted',
      'Serving build',
      'Node arguments',
      'Supervisor',
      'Source',
      'Platform',
    ]);
    expect(rows.Booted!.querySelector('time')).toHaveAttribute('dateTime', '2026-09-29T08:00:00.000Z');
    // The build, short and copyable whole.
    const build = within(rows['Serving build']!).getByRole('button', { name: 'abcdef123456' });
    expect(build).toHaveAttribute('title', 'abcdef1234567 — press to copy');
    expect(rows['Node arguments']).toHaveTextContent('--max-old-space-size=8192');
    expect(rows.Supervisor).toHaveTextContent('launchd');
    expect(rows.Source).toHaveTextContent('/repo');
    expect(rows.Platform).toHaveTextContent('darwin');
  });

  it('says what this process did not report, rather than leaving a blank or a zero', async () => {
    server.reads['/api/state'] = { root: null } as unknown as ConsoleState;
    mount();
    const process = await screen.findByTestId('process');
    await waitFor(() => expect(facts(process).Generation).toHaveTextContent('not reported'));
    const rows = facts(process);
    expect(rows.Booted).toHaveTextContent('not reported');
    expect(rows['Serving build']).toHaveTextContent('unstamped');
    expect(rows['Node arguments']).toHaveTextContent('none');
    expect(rows.Supervisor).toHaveTextContent('not reported');
    expect(rows.Source).toHaveTextContent('none open');
    expect(rows.Platform).toHaveTextContent('not reported');
  });

  it('draws a restart’s update with the restart vocabulary: what, who, since when, and what it waits on', async () => {
    server.reads['/api/state'] = {
      ...STATE,
      restartUpdate: {
        state: 'waiting',
        startedAt: '2026-09-29T09:00:00.000Z',
        by: 'operator',
        detail: 'Restart when idle',
        lanes: 2,
        plans: ['demo'],
      },
    };
    mount();
    const restart = await screen.findByTestId('restart-update');
    const word = await within(restart).findByText('Waiting for a quiet point');
    expect(word.closest('[data-status]')).toHaveAttribute('data-vocab', 'restart');
    expect(word.closest('[data-status]')).toHaveAttribute('data-status', 'waiting');
    expect(restart).toHaveTextContent('Restart when idle. Asked by operator, started');
    expect(restart).toHaveTextContent('waiting on 2 live lanes (demo).');
    expect(restart.querySelector('time')).toHaveAttribute('dateTime', '2026-09-29T09:00:00.000Z');
  });

  it('says so when no restart has happened', async () => {
    mount();
    const restart = await screen.findByTestId('restart-update');
    expect(within(restart).getByText('No restart or update since this process booted.')).toBeInTheDocument();
    expect(restart.querySelector('[data-status]')).toBeNull();
  });

  it('copies the state with its projection widened, never on the page’s own read', async () => {
    mount();
    const process = await screen.findByTestId('process');
    await waitFor(() => expect(facts(process).Generation).toHaveTextContent('42'));
    expect(server.calls).not.toContain('/api/state?include=full');

    fireEvent.click(within(process).getByRole('button', { name: 'Copy the whole state' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(callsTo('/api/state?include=full')).toHaveLength(1);
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(STATE);
  });
});

/* ------------------------------------------------------------------ *
 * Retired credentials
 * ------------------------------------------------------------------ */

describe('a retirement’s evidence, and its contradiction', () => {
  it('draws what a retirement stood on and the later read that contradicted it, after This process', async () => {
    server.reads['/api/accounts'] = {
      allowAccounts: true,
      accounts: [
        { id: 'account-1', kind: 'token', name: 'work', email: 'work@example.com', entitlement: SUSPECT },
      ],
    };
    mount();
    const question = await screen.findByTestId('retirements');
    expect(question).toBe(screen.getByRole('region', { name: 'Retired credentials' }));
    expect(questions()).toEqual([
      'runtime',
      'series',
      'doctor',
      'process',
      'retirements',
      'ceiling',
      'strays',
      'bundle',
      'bundle-health',
    ]);
    expect(within(question).getByText('work')).toBeInTheDocument();
    expect(within(question).getByTestId('retirement-evidence')).toHaveTextContent(
      'Was retired on from a session that spent nothing · “credit balance is too low” · session abcdef01 · phase 7 of demo',
    );
    expect(within(question).getByTestId('retirement-contradicted')).toHaveTextContent(
      'by usage-poll — a usage read answered 200',
    );
  });

  it('names a removed registration as removed, and leaves out an account with no retirement story', async () => {
    server.reads['/api/accounts'] = {
      allowAccounts: true,
      accounts: [
        {
          id: 'account-2',
          kind: 'token',
          name: 'healthy',
          entitlement: { state: 'entitled', via: 'credential' },
        },
      ],
      tombstones: [
        {
          id: 'gone-1',
          name: 'old laptop',
          retiredAt: '2026-09-20T08:00:00.000Z',
          credential: 'fp-1',
          entitlement: { ...SUSPECT, state: 'retired' },
        },
      ],
    };
    mount();
    const question = await screen.findByTestId('retirements');
    expect(within(question).getByText('old laptop (removed)')).toBeInTheDocument();
    expect(within(question).getByTestId('retirement-evidence')).toHaveTextContent(
      'Retired on from a session',
    );
    expect(within(question).queryByText('healthy')).toBeNull();
  });

  it('asks no such question on a console with nothing retired', async () => {
    server.reads['/api/accounts'] = {
      allowAccounts: true,
      accounts: [
        {
          id: 'account-2',
          kind: 'token',
          name: 'healthy',
          entitlement: { state: 'entitled', via: 'credential' },
        },
      ],
    };
    mount();
    await screen.findByTestId('process');
    await waitFor(() => expect(callsTo('/api/accounts')).toHaveLength(1));
    expect(screen.queryByTestId('retirements')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------ */

describe('the bundle, for whoever asks', () => {
  it('reads the bundle on the press that copies it, and offers it as a real download', async () => {
    mount();
    const question = screen.getByRole('region', { name: 'The bundle' });
    await screen.findByTestId('process');
    expect(callsTo('/api/debug/bundle')).toEqual([]);

    fireEvent.click(within(question).getByRole('button', { name: 'Copy for AI' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(callsTo('/api/debug/bundle')).toHaveLength(1);
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({ schema: 'phase-console/debug-bundle' });

    const download = within(question).getByRole('link', { name: 'Download the bundle' });
    expect(download).toHaveAttribute('href', '/api/debug/bundle?download=1');
    expect(download).toHaveAttribute('download');
    // One run's own files are the journal's, and the line says where.
    expect(within(question).getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '#/logs/journal');
    expect(question).toHaveTextContent('masked on the way out of the server');
  });
});

/* ------------------------------------------------------------------ *
 * Environment, the watch clock and metrics
 * ------------------------------------------------------------------ */

describe('environment, the watch clock and metrics — read on a press', () => {
  it('does not assemble a bundle until the reader asks', async () => {
    mount();
    await screen.findByTestId('process');
    expect(screen.queryByTestId('bundle-health')).toBeNull();
    expect(callsTo('/api/debug/bundle')).toEqual([]);

    await readTheBundle();
    expect(callsTo('/api/debug/bundle')).toHaveLength(1);
  });

  it('carries an environment issue’s fix beside the finding', async () => {
    server.reads['/api/debug/bundle'] = bundle({
      health: {
        environment: [{ kind: 'path-missing-dir', detail: 'PATH names ~/gone', fix: 'Reinstall the CLI.' }],
        watches: { passes: 4, asked: ['gh:o/r#run/1'], open: true },
      },
    });
    mount();
    const health = await readTheBundle();
    // An issue with no errand beside it is a complaint, not a finding.
    const finding = within(health).getByText('PATH names ~/gone').closest('li')!;
    expect(within(finding).getByText('Reinstall the CLI.')).toBeInTheDocument();
    expect(within(finding).getByText('path-missing-dir')).toBeInTheDocument();
  });

  it('says what an empty environment means, rather than an empty list', async () => {
    mount();
    const health = await readTheBundle();
    expect(health).toHaveTextContent(
      'Nothing found: every entry on PATH exists and belongs to this user, and push delivery has not failed.',
    );
  });

  it('counts the watched refs on the glance and folds the refs themselves until asked', async () => {
    server.reads['/api/debug/bundle'] = bundle({
      health: { environment: [], watches: { passes: 4, asked: ['gh:o/r#run/1'], open: true } },
    });
    mount();
    const health = await readTheBundle();
    const clock = facts(health);
    expect(clock.Armed).toHaveTextContent('yes');
    expect(clock.Passes).toHaveTextContent('4');
    expect(clock['Refs watched']).toHaveTextContent('1');
    // The fold unmounts its body — the ref is absent, not merely hidden.
    expect(within(health).queryByText('gh:o/r#run/1')).toBeNull();

    fireEvent.click(within(health).getByRole('button', { name: /The refs/ }));
    expect(await within(health).findByText('gh:o/r#run/1')).toBeInTheDocument();
  });

  it('a watch clock that did not answer makes no claim about what is parked', async () => {
    // `null`'s only producer is a caught throw, so "nothing is parked on a ref"
    // would be a claim the page cannot make.
    server.reads['/api/debug/bundle'] = bundle({ health: { environment: [], watches: null } });
    mount();
    const health = await readTheBundle();
    expect(
      within(health).getByText(
        'The watch clock did not answer, so this console cannot say what is parked on a ref.',
      ),
    ).toBeInTheDocument();
    expect(facts(health).Armed).toBeUndefined();
    expect(within(health).queryByText(/Nothing is parked on a ref/i)).toBeNull();
  });

  it('says the metrics are a snapshot rather than implying a history, and counts what it drew', async () => {
    server.reads['/api/debug/bundle'] = bundle({
      metrics: [{ name: 'phase_console_up', type: 'gauge', help: '', samples: [{ labels: {}, value: 1 }] }],
    });
    mount();
    const health = await readTheBundle();
    expect(health).toHaveTextContent(
      '1 family, as /api/metrics renders them now: a snapshot, not a history. What this console does keep over time is under Over time, above.',
    );
    expect(within(health).getByRole('link', { name: '/api/metrics' })).toHaveAttribute(
      'href',
      '/api/metrics',
    );
  });

  it('draws a family of labelled samples as a figure, a datum per sample, and a lone sample as a line', async () => {
    server.reads['/api/debug/bundle'] = bundle({
      metrics: [
        {
          name: 'phase_console_runs',
          type: 'gauge',
          help: 'Runs by status.',
          samples: [
            { labels: { status: 'active' }, value: 3 },
            { labels: { status: 'done' }, value: 12 },
          ],
        },
        { name: 'phase_console_up', type: 'gauge', help: '', samples: [{ labels: {}, value: 1 }] },
      ],
    });
    mount();
    const health = await readTheBundle();
    const runs = health.querySelector<HTMLElement>('[data-metric="phase_console_runs"]')!;
    expect(runs).toHaveTextContent('Runs by status.');
    expect(runs.querySelector('[data-figure]')).not.toBeNull();
    expect(
      [...runs.querySelectorAll('[data-datum]')].map((d) => [
        d.getAttribute('data-datum'),
        d.getAttribute('data-value'),
      ]),
    ).toEqual([
      ['status=active', '3'],
      ['status=done', '12'],
    ]);
    const up = health.querySelector<HTMLElement>('[data-metric="phase_console_up"]')!;
    expect(up.querySelector('[data-figure]')).toBeNull();
    expect(up).toHaveTextContent('no labels1');
  });

  it('a failed metrics scrape is an error, not "0 families right now"', async () => {
    server.reads['/api/debug/bundle'] = bundle({
      health: { environment: [], watches: null },
      notes: ['Metrics could not be rendered: the scrape threw'],
    });
    mount();
    const health = await readTheBundle();
    const failed = within(health).getByTestId('metrics-failed');
    expect(failed).toHaveTextContent('Metrics could not be rendered: the scrape threw');
    expect(failed).toHaveAttribute('data-severity', 'error');
    expect(within(health).queryByText(/0 families, as/)).toBeNull();
  });

  it('says the bundle could not be read, in its own words, with a way to ask again', async () => {
    let asks = 0;
    server.reads['/api/debug/bundle'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the bundle timed out', 503, '/api/debug/bundle');
      return bundle();
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Read them' }));
    const failed = await screen.findByText('The bundle could not be read: the bundle timed out');
    expect(failed.closest('[data-severity]')).toHaveAttribute('data-severity', 'error');
    expect(screen.queryByTestId('bundle-health')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('bundle-health')).toBeInTheDocument();
    expect(asks).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * The start ceiling and the stray consoles (quiet-console phase 26)
 * ------------------------------------------------------------------ */

describe('the start ceiling', () => {
  it('with room: each count against its limit, the doors, and the probe’s own budget beside it', async () => {
    mount();
    const region = screen.getByRole('region', { name: 'Automatic starts this hour' });
    expect(await within(region).findByTestId('ceiling-verdict')).toHaveTextContent(
      'There is room: the next automatic start goes ahead. Counted over a sliding 1h.',
    );
    expect(within(region).getByRole('meter', { name: 'Automatic starts this hour' })).toHaveAttribute(
      'aria-valuetext',
      '12 of 40',
    );
    expect(within(region).getByRole('meter', { name: 'Session spend this hour' })).toHaveAttribute(
      'aria-valuetext',
      '$48.20 of $250.00',
    );
    const rows = facts(region);
    expect(rows['Work starts by door']).toHaveTextContent('converge-relaunch 7, wait-clock 5');
    expect(within(region).getByRole('meter', { name: 'MCP probe starts this hour' })).toHaveAttribute(
      'aria-valuetext',
      '6 of 24',
    );
    // A limit of 0 is no limit: the count alone, and no meter to fill.
    expect(rows['Probe spend']).toHaveTextContent('$0.00, no limit');
    expect(within(region).queryByRole('meter', { name: 'MCP probe spend this hour' })).toBeNull();
    expect(within(region).getByRole('link', { name: 'Set the limits in Automation' })).toHaveAttribute(
      'href',
      '#/settings/automation',
    );
  });

  it('full: which limit, against what, and until when — the server’s word, never a count compared here', async () => {
    server.reads['/api/ceiling'] = ceiling({
      work: { usd: 251.5, full: 'usdPerHour', until: '2026-09-29T11:12:00.000Z' },
      probe: { starts: 24, full: 'startsPerHour', until: '2026-09-29T10:40:00.000Z' },
    });
    mount();
    const verdict = await screen.findByTestId('ceiling-verdict');
    expect(verdict).toHaveTextContent(
      'The work ceiling is full: $251.50 of session spend against a limit of $250.00. Nothing more starts by itself before',
    );
    expect(verdict.querySelector('time')).toHaveAttribute('dateTime', '2026-09-29T11:12:00.000Z');
    expect(screen.getByTestId('ceiling-probe-verdict')).toHaveTextContent(
      'The MCP probe’s budget is full: 24 starts against a limit of 24.',
    );
    // The full limit's meter is painted as the summons it is; the one with room is not.
    expect(screen.getByRole('meter', { name: 'Session spend this hour' })).toHaveClass('state-needs-you');
    expect(screen.getByRole('meter', { name: 'Automatic starts this hour' })).toHaveClass('state-running');
  });

  it('a read that failed says so in its own words, and asks again', async () => {
    let asks = 0;
    server.reads['/api/ceiling'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the ceiling is not wired', 500, '/api/ceiling');
      return ceiling();
    };
    mount();
    const region = screen.getByRole('region', { name: 'Automatic starts this hour' });
    expect(
      await within(region).findByText('The start ceiling could not be read: the ceiling is not wired'),
    ).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    expect(await within(region).findByTestId('ceiling-verdict')).toBeInTheDocument();
  });
});

describe('the stray consoles', () => {
  it('none is one quiet line', async () => {
    mount();
    expect(await screen.findByTestId('strays-none')).toHaveTextContent(
      'None: every console process on this machine still has its code.',
    );
    expect(screen.queryByText(STOP)).toBeNull();
  });

  it('each stray’s pid, command and root, and the CLI’s line to stop them, to copy — never a press that signals', async () => {
    server.reads['/api/doctor/strays'] = { at: '2026-09-29T10:00:00.000Z', strays: STRAYS, stop: STOP };
    mount();
    const list = await screen.findByRole('list', { name: 'Stray consoles' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-stray'))).toEqual(['4711', '5120']);
    expect(rows[0]).toHaveTextContent('pid 4711, group 4700');
    expect(rows[0]).toHaveTextContent('node /home/x/old/viewer/server/main.ts --port 4131');
    expect(rows[0]).toHaveTextContent('root /home/x/old');
    const region = screen.getByRole('region', { name: 'Stray consoles' });
    expect(region).toHaveTextContent('2 console processes on this machine run code that is gone.');
    fireEvent.click(within(region).getByRole('button', { name: 'Copy the command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(STOP));
    // Listed, never stopped: the page only ever read.
    expect(server.calls.filter((path) => path.includes('strays'))).toEqual(['/api/doctor/strays']);
  });

  it('Scan again reads the machine again', async () => {
    mount();
    await screen.findByTestId('strays-none');
    server.reads['/api/doctor/strays'] = {
      at: '2026-09-29T10:05:00.000Z',
      strays: STRAYS.slice(0, 1),
      stop: STOP,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(await screen.findByRole('list', { name: 'Stray consoles' })).toBeInTheDocument();
    expect(callsTo('/api/doctor/strays')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Stray consoles' })).toHaveTextContent(
      '1 console process on this machine runs code that is gone.',
    );
  });
});
