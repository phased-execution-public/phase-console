/**
 * Every run of the plan — the Run view's History reading (7.0, quiet-console
 * phase 11).
 *
 *   H-1 the list is the whole history: every run with its word in context and
 *       its spend, the current one marked "this run", each line the address of
 *       that run opened — and a plan run once still lists its one run;
 *   H-2 the list orders by when a run started or by what it spent;
 *   H-3 a picked run (`?run=`) opens under the list: its word, id, clocks,
 *       spend, why it stopped (the family and the sentence — no remedy for a
 *       past run) and its phases, one line each;
 *   H-4 a phase's fold reads THAT run's report and activity (`?run=<id>`), and
 *       only once someone opens it; the activity is marked as the model's words;
 *   H-5 a picked id the history does not hold says so, with the way back;
 *   H-6 on a phone the opened run stands in place of the list.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, media } = vi.hoisted(() => ({ request: vi.fn(), media: { phone: false } }));

// Every read of the reading meets the one http door under `data/`.
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return { ...actual, request: (path: string) => request(path) };
});
vi.mock('@/lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media')>();
  return { ...actual, usePhone: () => media.phone };
});

import type { PhaseActivity, PhaseRecord, PhaseReport, PlanDetail, RunState } from '@/data/api';
import { ApiError } from '@/data/http';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import { runViewHref } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { TooltipProvider } from '@/ui/tooltip';
import { RunHistoryView } from './history';

const NOW = Date.now();
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const HOUR = 3_600_000;

const CURRENT = 'current00000aaaabbbb';
const OLDER = 'older0000000ccccdddd';
const OLDEST = 'oldest000000eeeeffff';

const record = (phase: number, status: string, over: Partial<PhaseRecord> = {}): PhaseRecord =>
  ({ phase, status, attempts: 1, costUsd: 1.1, ...over }) as PhaseRecord;

const run = (over: Partial<RunState>): RunState =>
  ({
    id: CURRENT,
    slug: 'demo',
    root: '/repo',
    status: 'running',
    autonomy: 'keep-going',
    model: 'opus',
    phaseBudgetUsd: null,
    runBudgetUsd: null,
    spentUsd: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    createdAt: iso(2 * HOUR),
    updatedAt: iso(HOUR),
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    ...over,
  }) as RunState;

const HISTORY: RunState[] = [
  run({
    id: CURRENT,
    status: 'running',
    spentUsd: 4.2,
    createdAt: iso(2 * HOUR),
    phases: { '1': record(1, 'done') },
  }),
  run({
    id: OLDER,
    status: 'halted',
    spentUsd: 12.5,
    createdAt: iso(26 * HOUR),
    updatedAt: iso(25 * HOUR),
    halt: { at: iso(25 * HOUR), reason: 'A §Verification command failed.', phase: 2, kind: 'verify-failed' },
    phases: {
      '1': record(1, 'done', { costUsd: 1.1 }),
      '2': record(2, 'failed', { attempts: 3, costUsd: 11.4 }),
    },
  }),
  run({
    id: OLDEST,
    status: 'finished',
    spentUsd: 1,
    createdAt: iso(50 * HOUR),
    updatedAt: iso(49 * HOUR),
    finishedReason: 'every phase it was asked for is done',
    phases: { '1': record(1, 'done', { costUsd: 1 }) },
  }),
];

const DETAIL = {
  summary: { slug: 'demo', title: 'demo plan', status: 'active' },
  plan: null,
  phases: [
    { phase: 1, title: 'Foundations', state: 'done', size: 'M', weight: 1, gated: false },
    { phase: 2, title: 'Surface', state: 'ready', size: 'L', weight: 1, gated: false },
    { phase: 3, title: 'Cutover', state: 'waiting', size: 'S', weight: 1, gated: false },
  ],
} as unknown as PlanDetail;

const REPORT = {
  slug: 'demo',
  runId: OLDER,
  phase: 2,
  at: iso(25 * HOUR),
  status: 'failed',
  live: false,
  doing: {},
  done: { count: 2, total: 5, items: [] },
  left: { count: 3, items: [] },
  waitingOn: [],
  whySlow: [{ rule: 'machine-load', text: 'The machine was loaded the whole time.', source: [] }],
  eta: { minutes: { low: 10, high: 20 }, confidence: 'low', basis: 'its own rate', source: [] },
  timeline: [],
  summary: 'It was wiring the cutover when the check went red.',
} as unknown as PhaseReport;

const ACTIVITY: PhaseActivity = {
  slug: 'demo',
  runId: OLDER,
  phase: 2,
  live: false,
  source: 'session-log',
  untrusted: true,
  bytesRead: 120,
  events: [
    {
      kind: 'tool',
      id: 't1',
      name: 'Bash',
      description: 'Run the unit tests',
      at: iso(25 * HOUR),
      exit: 'error',
      code: 1,
      line: 'L1',
    },
    { kind: 'text', at: iso(25 * HOUR), text: 'The tests  are\n red; fixing.', line: 'L2' },
    { kind: 'marker', at: iso(25 * HOUR), marker: 'input', text: 'Carry on with the fix', line: 'L3' },
  ],
};

const asked = () => request.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  media.phone = false;
  request.mockReset();
  request.mockImplementation(async (path: string) => {
    if (/^\/api\/run\/demo\/phase\/\d+\/report\?/.test(path)) return REPORT;
    if (/^\/api\/run\/demo\/phase\/\d+\/activity\?/.test(path)) return ACTIVITY;
    throw new ApiError(`unmocked ${path}`, 500, path);
  });
});
afterEach(() => {
  media.phone = false;
});

function mount(props: { history?: RunState[]; currentId?: string | null; picked?: string | null } = {}) {
  const client = new QueryClient(queryClientConfig);
  const history = props.history ?? HISTORY;
  const picked = props.picked ?? null;
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouterProvider initial={runViewHref('demo', 'history', picked)}>
          <RunHistoryView
            slug="demo"
            detail={DETAIL}
            history={history}
            currentId={props.currentId === undefined ? (history[0]?.id ?? null) : props.currentId}
            picked={picked}
          />
        </MemoryRouterProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const rows = () => screen.getAllByTestId('history-row');
const order = () => rows().map((row) => row.getAttribute('data-run'));
const statusOf = (row: HTMLElement) => row.querySelector('[data-status]')!;

describe('<RunHistoryView>', () => {
  it('H-1 lists every run with its word and its spend, the current one marked, each line its address', () => {
    mount();
    expect(screen.getByTestId('run-history').getAttribute('aria-label')).toBe('Every run of this plan');
    expect(order()).toEqual([CURRENT, OLDER, OLDEST]);
    const [current, older, oldest] = rows() as [HTMLElement, HTMLElement, HTMLElement];

    expect(statusOf(current).getAttribute('data-status')).toBe('running');
    expect(statusOf(older).getAttribute('data-status')).toBe('halted');
    expect(statusOf(oldest).getAttribute('data-status')).toBe('finished');
    // A stop a newer run overtook reads as the Runs home reads it: superseded, quiet —
    // the note on a line of its own under the word, which never wraps.
    expect(statusOf(older).textContent).not.toContain('a newer run');
    expect(statusOf(older).parentElement!.textContent).toContain('a newer run');

    expect(within(current).getByText('$4.20')).toBeInTheDocument();
    expect(within(older).getByText('$12.50')).toBeInTheDocument();
    expect(within(oldest).getByText('$1.00')).toBeInTheDocument();

    expect(within(current).getByTestId('history-current').textContent).toBe('this run');
    expect(within(older).queryByTestId('history-current')).toBeNull();

    // The id is drawn short in the machine face, the whole of it one press from the clipboard.
    expect(within(older).getByText(OLDER.slice(0, 12)).tagName).toBe('CODE');
    expect(
      within(older).getByRole('button', { name: `Copy the id of run ${OLDER.slice(0, 12)}` }),
    ).toBeTruthy();

    expect(within(older).getByRole('link').getAttribute('href')).toBe(
      `#/plan/demo/run?view=history&run=${OLDER}`,
    );
    expect(within(older).getByText('1 of 3')).toBeInTheDocument();
    // Nothing opened, nothing read.
    expect(screen.queryByTestId('history-picked')).toBeNull();
    expect(asked()).toEqual([]);
  });

  it('H-1 still lists a plan’s one run — it is the history', () => {
    mount({ history: [HISTORY[0]!] });
    expect(order()).toEqual([CURRENT]);
  });

  it('H-2 orders by what each run spent, and back by when it started', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Spent' }));
    expect(order()).toEqual([OLDER, CURRENT, OLDEST]);
    fireEvent.click(screen.getByRole('button', { name: 'Started' }));
    expect(order()).toEqual([CURRENT, OLDER, OLDEST]);
  });

  it('H-3 opens a picked run under the list: its word, clocks, spend, why it stopped, and its phases', () => {
    mount({ picked: OLDER });
    const picked = screen.getByTestId('history-picked');
    expect(picked.getAttribute('data-run')).toBe(OLDER);
    expect(within(picked).getByRole('heading', { level: 2 }).textContent).toBe(`Run ${OLDER.slice(0, 12)}`);
    expect(statusOf(picked).getAttribute('data-status')).toBe('halted');
    expect(within(picked).getByText('$12.50')).toBeInTheDocument();
    expect(within(picked).getByText('Ended')).toBeInTheDocument();
    // Its row in the list is the one marked.
    expect(rows()[1]!.getAttribute('aria-current')).toBe('true');

    // Why it stopped: the family and the sentence — a past run's stop offers no remedy.
    const halt = within(picked).getByTestId('halt-row');
    expect(halt.getAttribute('data-halt-category')).toBeTruthy();
    expect(within(halt).getByTestId('halt-sentence').textContent).toBeTruthy();
    expect(within(picked).queryByTestId('halt-recommended')).toBeNull();

    const phases = within(picked).getAllByTestId('history-phase');
    expect(phases.map((line) => line.getAttribute('data-phase'))).toEqual(['1', '2']);
    const surface = phases[1]!;
    expect(within(surface).getByText('P2')).toBeInTheDocument();
    expect(within(surface).getByText('Surface')).toBeInTheDocument();
    expect(statusOf(surface).getAttribute('data-status')).toBe('failed');
    expect(within(surface).getByText('3 attempts')).toBeInTheDocument();
    expect(within(surface).getByText('$11.40')).toBeInTheDocument();
    expect(within(phases[0]!).getByText('Foundations')).toBeInTheDocument();
    // Folded, the phases have read nothing.
    expect(asked()).toEqual([]);
  });

  it('H-3 keeps the recommended move for the current run, stopped — pressing it can still matter', () => {
    const halted = run({
      id: CURRENT,
      status: 'halted',
      halt: { at: iso(HOUR), reason: 'A §Verification command failed.', phase: 1, kind: 'verify-failed' },
      phases: { '1': record(1, 'failed') },
    });
    mount({ history: [halted, HISTORY[1]!], picked: CURRENT });
    const picked = screen.getByTestId('history-picked');
    expect(within(picked).getByTestId('halt-row')).toBeInTheDocument();
    expect(within(picked).getByTestId('halt-recommended')).toBeInTheDocument();
  });

  it('H-3 says how a run that was not stopped ended', () => {
    mount({ picked: OLDEST });
    const picked = screen.getByTestId('history-picked');
    expect(within(picked).getByText('every phase it was asked for is done')).toBeInTheDocument();
    expect(within(picked).queryByTestId('halt-row')).toBeNull();
  });

  it('H-4 opening a phase reads THAT run’s report and activity, and draws what they answer', async () => {
    mount({ picked: OLDER });
    const surface = screen.getAllByTestId('history-phase')[1]!;
    fireEvent.click(within(surface).getByRole('button', { name: 'What it did' }));

    const report = await within(surface).findByTestId('history-report');
    expect(report.textContent).toContain('It was wiring the cutover when the check went red.');
    expect(report.textContent).toContain('2 of 5 tasks done, 3 left.');
    expect(within(report).getByText('The machine was loaded the whole time.')).toBeInTheDocument();
    expect(within(report).getByTestId('history-eta').textContent).toBe('It estimated 10–20 minutes left.');

    const activity = await within(surface).findByTestId('history-activity');
    expect(activity.hasAttribute('data-untrusted')).toBe(true);
    expect(activity.textContent).toContain('the model’s words');
    const lines = within(activity).getAllByRole('listitem');
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['tool', 'text', 'marker']);
    expect(within(lines[0]!).getByText('Bash').tagName).toBe('CODE');
    expect(lines[0]!.textContent).toContain('Run the unit tests, failed (exit 1)');
    expect(lines[1]!.textContent).toContain('The tests are red; fixing.');
    expect(lines[2]!.textContent).toContain('Told: Carry on with the fix');

    await waitFor(() =>
      expect(asked()).toEqual(
        expect.arrayContaining([
          `/api/run/demo/phase/2/report?run=${OLDER}`,
          `/api/run/demo/phase/2/activity?limit=20&run=${OLDER}`,
        ]),
      ),
    );
    // Only the phase someone opened was read.
    expect(asked().filter((path) => path.includes('/phase/1/'))).toEqual([]);
  });

  it('H-4 says the server’s own words when a phase’s read fails', async () => {
    request.mockImplementation(async (path: string) => {
      throw new ApiError(`no record of phase 2 in run ${OLDER}`, 404, path);
    });
    mount({ picked: OLDER });
    const surface = screen.getAllByTestId('history-phase')[1]!;
    fireEvent.click(within(surface).getByRole('button', { name: 'What it did' }));
    expect(await within(surface).findAllByText(`no record of phase 2 in run ${OLDER}`)).toHaveLength(2);
  });

  it('H-5 says so when the picked id is not in the history, with the way back to the list', () => {
    mount({ picked: 'no-such-run' });
    const line = screen.getByTestId('history-unknown');
    expect(line.textContent).toContain('no-such-run');
    expect(within(line).getByRole('link', { name: 'Show every run' }).getAttribute('href')).toBe(
      runViewHref('demo', 'history'),
    );
    expect(screen.queryByTestId('history-picked')).toBeNull();
    // The list is still there to pick from.
    expect(rows()).toHaveLength(3);
  });

  it('H-6 on a phone, the opened run stands in place of the list, with the way back', () => {
    media.phone = true;
    mount({ picked: OLDER });
    expect(screen.getByTestId('history-picked')).toBeInTheDocument();
    expect(screen.queryAllByTestId('history-row')).toHaveLength(0);
    expect(screen.getByTestId('history-back').getAttribute('href')).toBe(runViewHref('demo', 'history'));
  });

  it('H-6 on a phone with nothing opened, the list is one record per run', () => {
    media.phone = true;
    mount();
    expect(order()).toEqual([CURRENT, OLDER, OLDEST]);
    expect(rows()[0]!.tagName).toBe('LI');
  });

  it('says in one line when the plan has never run', () => {
    mount({ history: [], currentId: null });
    expect(screen.getByTestId('history-empty').textContent).toBe('This plan has not been run yet.');
  });

  it('has no axe violations — the list, the opened run and a phase’s fold open', async () => {
    const { container } = mount({ picked: OLDER });
    const surface = screen.getAllByTestId('history-phase')[1]!;
    fireEvent.click(within(surface).getByRole('button', { name: 'What it did' }));
    await within(surface).findByTestId('history-activity');
    await within(surface).findByTestId('history-report');
    await expectNoAxeViolations(container);
  });
});
