/**
 * What a session is doing (7.0, quiet-console phase 12) — every case of the
 * 6.x activity panels', Now panel's, task summary's and run-progress suites.
 *
 *  1. **The panels say what the console already holds.** Every tool call has
 *     its clock beside its duration, the task list says when it was written,
 *     each task's status is in words as well as in its mark, and a running
 *     verification reports as it goes — through the status family.
 *  2. **The phase's report** leads with its plain answer and links each figure
 *     to the line it was read from; it refreshes with the journal, no reload.
 *  3. **A row's one line** (`TaskLine`, `LastActivity`) reads the same summary
 *     every surface reads, and prefers what the lane last reported.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VERIFY_STATES } from '@shared/console-model.js';
import type { PhaseActivity, PhaseRecord, PhaseReport, PhaseTask, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { EVENT_EFFECTS, applyEffect } from '@/data/live';
import { MemoryRouterProvider } from '@/shell/router';
import { expectNoAxeViolations } from '@/test/axe';
import {
  ActivityPanels,
  COMMAND_STATE_WORDS,
  LastActivity,
  LastActivityLine,
  LiveNow,
  NowPanel,
  NowReport,
  TaskLine,
  activityLine,
  sourceWords,
  type TaskMarkShape,
} from './activity';
import { NO_SESSION_ACTIVITY, foldActivity, type SessionActivity } from './console-model';

/**
 * The `const` assertion in `shared/task-model.js` is load-bearing: without it
 * `TaskMarkShape` widens to `string` and a deleted mark compiles. A TYPE pin —
 * with the assertion in place this line is an error the directive suppresses;
 * the moment it leaves, the directive has nothing to do and `tsc` says TS2578.
 */
// @ts-expect-error — 'not-a-real-mark' is not one of the three marks
const WRONG_MARK: TaskMarkShape = 'not-a-real-mark';
void WRONG_MARK;

/** 1970-01-01 14:07:52 local — a clock the test can name exactly. */
const AT = new Date(1970, 0, 1, 14, 7, 52).getTime();

const panels = (over: Partial<SessionActivity>): SessionActivity => ({ ...NO_SESSION_ACTIVITY, ...over });

function client() {
  return new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function withData(node: ReactElement, c = client()) {
  return render(
    <QueryClientProvider client={c}>
      <MemoryRouterProvider initial="#/plan/demo/run">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ *
 * 1 · The session's activity
 * ------------------------------------------------------------------ */

describe('the task list', () => {
  const TODOS = panels({
    todosAt: AT,
    todos: [
      { id: 'p3.task1', content: 'merge the branch', status: 'completed' },
      {
        id: 'p3.task2',
        content: 'wire the endpoint',
        activeForm: 'Wiring the endpoint',
        status: 'in_progress',
      },
      { id: 'p3.task3', content: 'write the handoff', status: 'pending' },
    ],
  });

  it('paints all three statuses distinctly — `pending` is a choice, not a fallback', () => {
    const { container } = render(<ActivityPanels activity={TODOS} live now={AT} />);
    expect(container.querySelector('.state-done')).toBeInTheDocument();
    expect(container.querySelector('.state-running')).toBeInTheDocument();
    expect(container.querySelector('.state-queued')).toBeInTheDocument();
  });

  it('carries each status in words, never in the mark alone', () => {
    render(<ActivityPanels activity={TODOS} live now={AT} />);
    const row = screen.getByText(/Wiring the endpoint/).closest('li')!;
    expect(within(row).getByText(/Doing/)).toBeInTheDocument();
  });

  it('has a key naming all three statuses', () => {
    const { container } = render(<ActivityPanels activity={TODOS} live now={AT} />);
    const legend = container.querySelector<HTMLElement>('[data-slot="legend"]')!;
    for (const word of ['To do', 'Doing', 'Done']) expect(within(legend).getByText(word)).toBeInTheDocument();
  });

  it('says how much is done and when the session last wrote the list', () => {
    render(<ActivityPanels activity={TODOS} live now={AT} />);
    expect(screen.getByText('1 of 3 done, written at 14:07:52')).toBeInTheDocument();
  });

  it('says nothing about a write time it does not have', () => {
    render(<ActivityPanels activity={panels({ todos: TODOS.todos })} live now={AT} />);
    expect(screen.queryByText(/written at/)).toBeNull();
  });

  it('draws a row whose status the table has no entry for', () => {
    expect(() =>
      render(
        <ActivityPanels
          now={AT}
          live
          activity={panels({ todos: [{ id: 'x', content: 'from the future', status: 'deferred' }] })}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText('from the future')).toBeInTheDocument();
  });
});

/**
 * The crash the key guards against: a status in the VOCABULARY that the paint
 * table has no entry for — which only a mocked vocabulary can produce. The
 * vocabulary is the CLI's as much as ours, so a fourth word is not hypothetical.
 */
describe('a status in the vocabulary with no mark', () => {
  it('does not take the list down, and is still named', async () => {
    vi.resetModules();
    vi.doMock('@shared/task-model.js', async () => {
      const real = await vi.importActual<typeof import('@shared/task-model.js')>('@shared/task-model.js');
      return { ...real, TASK_STATUSES: [...real.TASK_STATUSES, 'deferred'] };
    });
    try {
      const { ActivityPanels: Panels } = await import('./activity');
      const { NO_SESSION_ACTIVITY: EMPTY } = await import('./console-model');
      expect(() =>
        render(
          <Panels
            now={AT}
            live
            activity={{ ...EMPTY, todos: [{ id: 'a', content: 'wire it', status: 'pending' }] }}
          />,
        ),
      ).not.toThrow();
      expect(screen.getByText('deferred')).toBeInTheDocument();
    } finally {
      // In a `finally`, so a failed expectation cannot leave the registry mocked.
      vi.doUnmock('@shared/task-model.js');
      vi.resetModules();
    }
  });
});

describe('tool calls and subagents', () => {
  it('puts a clock time on every call, beside how long it took', () => {
    render(
      <ActivityPanels
        now={AT}
        live={false}
        activity={panels({
          tools: [{ id: 't1', name: 'Bash', summary: 'npm test', at: AT, ms: 240_000, ok: true, detail: '' }],
        })}
      />,
    );
    // The duration alone cannot place a call in time — the question on a replay.
    expect(screen.getByText('14:07:52')).toBeInTheDocument();
    expect(screen.getByText('4m')).toBeInTheDocument();
    expect(screen.getByText('1 call')).toBeInTheDocument();
  });

  it('says a call is still open while live, and that it has no result on a replay', () => {
    const open = panels({
      tools: [{ id: 't1', name: 'Bash', summary: 'sleep 600', at: AT, ms: null, ok: null, detail: '' }],
    });
    const { rerender } = render(<ActivityPanels now={AT} live activity={open} />);
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText(/1 running/)).toBeInTheDocument();
    rerender(<ActivityPanels now={AT} live={false} activity={open} />);
    expect(screen.getByText('no result')).toBeInTheDocument();
  });

  it('marks a failed call in the failed hue, its detail on hover', () => {
    render(
      <ActivityPanels
        now={AT}
        live={false}
        activity={panels({
          tools: [
            { id: 't1', name: 'Edit', summary: 'src/a.ts', at: AT, ms: 1200, ok: false, detail: 'no match' },
          ],
        })}
      />,
    );
    const outcome = screen.getByText('failed after 1.2s');
    expect(outcome).toHaveClass('state-failed');
    expect(outcome).toHaveAttribute('title', 'no match');
  });

  it('says how many calls are drawn when there are more than the list holds', () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      name: 'Read',
      summary: `f${i}.ts`,
      at: AT,
      ms: 10,
      ok: true,
      detail: '',
    }));
    render(<ActivityPanels now={AT} live={false} activity={panels({ tools })} />);
    expect(screen.getByText('30 calls, the last 24 shown')).toBeInTheDocument();
    expect(screen.getAllByText('Read')).toHaveLength(24);
  });

  it('stamps a subagent’s lane too, and says whether it still works', () => {
    render(
      <ActivityPanels
        now={AT}
        live
        activity={panels({
          agents: [{ id: 'a1', agent: 'qa', title: 'review', text: 'reading', at: AT, done: false }],
        })}
      />,
    );
    expect(screen.getByText('14:07:52')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('1 running of 1')).toBeInTheDocument();
  });
});

describe('the verification, while it runs', () => {
  it('draws every state the fold can assign, and no invented sixth', () => {
    // A state the fold can produce and the panel cannot draw is the one case
    // a reader cannot tell from a rendering bug.
    expect(Object.keys(COMMAND_STATE_WORDS).sort()).toEqual([...VERIFY_STATES].sort());
  });

  const VERIFY = panels({
    verify: {
      at: AT,
      summary: null,
      skipped: [{ command: 'rg --version', lead: 'rg', reason: '`rg` is not installed here' }],
      commands: [
        { index: 0, total: 2, command: 'npm test', state: 'passed', at: AT, ms: 4_200, code: 0 },
        { index: 1, total: 2, command: 'npm run lint', state: 'running', at: AT - 90_000 },
      ],
    },
  });

  it('is a checklist with a state and an elapsed time on each command', () => {
    render(<ActivityPanels activity={VERIFY} live now={AT} />);
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('4.2s')).toBeInTheDocument();
    // The one in flight has its clock — not a line and then forty minutes of silence.
    expect(screen.getByText('Verifying')).toBeInTheDocument();
    expect(screen.getByText('2m')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 done')).toBeInTheDocument();
  });

  it('says a skip explicitly, with its reason', () => {
    render(<ActivityPanels activity={VERIFY} live now={AT} />);
    expect(screen.getByText('rg --version')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText(/`rg` is not installed here/)).toBeInTheDocument();
  });

  it('shows a failed command’s exit code, a tail of its output and the verdict', () => {
    render(
      <ActivityPanels
        now={AT}
        live={false}
        activity={panels({
          verify: {
            at: AT,
            skipped: [],
            summary: { ok: false, reason: '`npm test` exited 1', ran: 1, notRun: 1, skipped: 0 },
            commands: [
              {
                index: 0,
                total: 2,
                command: 'npm test',
                state: 'failed',
                at: AT,
                ms: 900,
                code: 1,
                tail: 'AssertionError: expected 3 to be 4',
              },
            ],
          },
        })}
      />,
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('900ms, exit 1')).toBeInTheDocument();
    expect(screen.getByText(/AssertionError: expected 3 to be 4/)).toBeInTheDocument();
    expect(screen.getByText('Red')).toBeInTheDocument();
    expect(screen.getByText('`npm test` exited 1')).toBeInTheDocument();
  });

  it('says it does not know when a verification ended without a command’s result', () => {
    render(
      <ActivityPanels
        now={AT}
        live={false}
        activity={panels({
          verify: {
            at: AT,
            skipped: [],
            summary: null,
            commands: [{ index: 0, total: 1, command: 'npm test', state: 'unknown', at: AT }],
          },
        })}
      />,
    );
    // The status's own sentence is in its tooltip (#365), said on focus as on hover.
    const unknown = screen.getByText('Unknown').closest<HTMLElement>('[data-status]')!;
    fireEvent.keyDown(window, { key: 'Tab' }); // a keyboard reader's focus follows a key
    fireEvent.focus(unknown);
    expect(screen.getByRole('tooltip')).toHaveTextContent('It started, and no result was recorded');
  });

  it('draws on its own, with no session activity at all', () => {
    // The verification runs AFTER the session ends.
    render(<ActivityPanels activity={VERIFY} live={false} now={AT} />);
    expect(screen.getByRole('heading', { name: 'Verification' })).toBeInTheDocument();
  });

  it('draws nothing when nothing has happened', () => {
    const { container } = render(<ActivityPanels activity={NO_SESSION_ACTIVITY} live={false} now={AT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the in-flight command’s clock TICKS', () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      render(
        <ActivityPanels
          live
          activity={panels({
            verify: {
              at: started,
              summary: null,
              skipped: [],
              commands: [{ index: 0, total: 1, command: 'npm test', state: 'running', at: started }],
            },
          })}
        />,
      );
      expect(screen.getByText('0ms')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });
      expect(screen.queryByText('0ms')).toBeNull();
      expect(screen.getByText('4m')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a finished pane does not tick — there is nothing left to count', () => {
    render(<ActivityPanels activity={VERIFY} live={false} />);
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('is clean to axe', async () => {
    const { container } = render(<ActivityPanels activity={VERIFY} live now={AT} />);
    await expectNoAxeViolations(container);
  });
});

describe('the fold', () => {
  it('builds a list from the script channel, ids and all', () => {
    let state = NO_SESSION_ACTIVITY;
    state = foldActivity(state, 'stream', { kind: 'task', op: 'create', taskId: 'p8.task1', content: 'one' });
    state = foldActivity(state, 'stream', { kind: 'task', op: 'create', taskId: 'p8.task2', content: 'two' });
    state = foldActivity(state, 'stream', {
      kind: 'task',
      op: 'update',
      taskId: 'p8.task1',
      status: 'completed',
    });
    expect(state.todos.map((t) => [t.id, t.status])).toEqual([
      ['p8.task1', 'completed'],
      ['p8.task2', 'pending'],
    ]);
  });

  it('clears on `reset` — the transition no task tool can spell', () => {
    let state = foldActivity(NO_SESSION_ACTIVITY, 'stream', {
      kind: 'task',
      op: 'create',
      taskId: 'a',
      content: 'one',
    });
    state = foldActivity(state, 'stream', { kind: 'task', op: 'reset' });
    expect(state.todos).toEqual([]);
  });

  it('lets an empty whole-list write CLEAR the list', () => {
    let state = foldActivity(NO_SESSION_ACTIVITY, 'stream', {
      kind: 'todos',
      items: [{ content: 'one', status: 'pending' }],
    });
    expect(state.todos).toHaveLength(1);
    state = foldActivity(state, 'stream', { kind: 'todos', items: [] });
    expect(state.todos).toEqual([]);
  });

  it('keeps the identity contract — an unchanged fold is the same object', () => {
    const state = foldActivity(NO_SESSION_ACTIVITY, 'stream', {
      kind: 'task',
      op: 'create',
      taskId: 'a',
      content: 'one',
    });
    expect(
      foldActivity(state, 'stream', { kind: 'task', op: 'update', taskId: 'ghost', status: 'completed' }),
    ).toBe(state);
    expect(foldActivity(state, 'stream', { kind: 'todos', items: 'not an array' })).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · A row's one line
 * ------------------------------------------------------------------ */

const TASKS: PhaseTask[] = [
  { id: 'p8.task1', content: 'p8.task1 — write the writer', status: 'completed' },
  {
    id: 'p8.task2',
    content: 'p8.task2 — wire the runner',
    activeForm: 'Wiring the runner',
    status: 'in_progress',
  },
  { id: 'p8.task3', content: 'p8.task3 — ship it', status: 'pending' },
];

describe('TaskLine', () => {
  it('reads `done/total` and what it is doing off the one summary', () => {
    render(<TaskLine tasks={TASKS} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('1/3');
    expect(screen.getByTestId('task-summary')).toHaveTextContent('Wiring the runner');
  });

  it('names the task plainly when the session gave no active form', () => {
    render(<TaskLine tasks={[{ id: 'a', content: 'do the thing', status: 'in_progress' }]} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('do the thing');
  });

  it('draws nothing at all when the session published no list', () => {
    expect(render(<TaskLine tasks={undefined} />).container).toBeEmptyDOMElement();
    expect(render(<TaskLine tasks={[]} />).container).toBeEmptyDOMElement();
  });

  it('never claims work that has not started', () => {
    render(<TaskLine tasks={[{ id: 'a', content: 'not started', status: 'pending' }]} />);
    const line = screen.getByTestId('task-summary');
    expect(line).toHaveTextContent('0/1');
    expect(line.textContent).not.toContain('not started');
  });
});

describe('run:progress moves a surface, and asks for nothing', () => {
  const RUN_ID = 'run-1a2b3c4d';
  const runWithPhase = (over: Partial<PhaseRecord> = {}): RunState =>
    ({
      id: RUN_ID,
      slug: 'control-tower',
      status: 'running',
      phases: {
        7: {
          phase: 7,
          status: 'running',
          attempts: 1,
          costUsd: 0,
          tasks: [
            { id: 'p7.task1', content: 'read the snapshots', status: 'completed' },
            { id: 'p7.task2', content: 'cap the writer', status: 'pending' },
            { id: 'p7.task3', content: 'cache the parse', status: 'pending' },
          ],
          ...over,
        } as PhaseRecord,
      },
    }) as unknown as RunState;
  const frame = (over: Record<string, unknown> = {}) => ({
    slug: 'control-tower',
    runId: RUN_ID,
    phase: 7,
    status: 'running',
    attempt: 1,
    attemptStartedAt: '2026-09-22T11:00:00.000Z',
    tasks: { total: 3, done: 1, active: 'cap the writer' },
    spentUsd: 0.5,
    contextTokens: 42_000,
    stall: null,
    ...over,
  });

  let c: QueryClient;
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchSpy = vi.fn(() => Promise.reject(new Error('a patch must never reach the network')));
    vi.stubGlobal('fetch', fetchSpy);
    return () => vi.unstubAllGlobals();
  });

  it('folds two frames into the cached run and never fetches', () => {
    c.setQueryData(keys.run('control-tower'), { run: runWithPhase(), history: [], eta: null });
    c.setQueryData(keys.runs(), [runWithPhase()]);
    const patch = EVENT_EFFECTS['run:progress'].patch;
    expect(patch, 'run:progress is a patch, never an invalidate').toBeTypeOf('function');

    patch!(c, frame());
    patch!(c, frame({ tasks: { total: 3, done: 2, active: 'cache the parse' }, spentUsd: 1.75 }));

    const detail = c.getQueryData(keys.run('control-tower')) as { run: RunState };
    const live = detail.run.phases['7']!.live;
    expect(live?.tasks).toEqual({ total: 3, done: 2, active: 'cache the parse' });
    expect(live?.spentUsd).toBe(1.75);
    expect(live?.contextTokens).toBe(42_000);
    // The list is the other view of the same fact.
    const list = c.getQueryData(keys.runs()) as RunState[];
    expect(list[0]!.phases['7']!.live?.tasks?.done).toBe(2);
    expect(fetchSpy, 'not one round trip for two frames across two caches').not.toHaveBeenCalled();
  });

  it('a frame for another run leaves this one alone', () => {
    c.setQueryData(keys.run('control-tower'), { run: runWithPhase(), history: [], eta: null });
    EVENT_EFFECTS['run:progress'].patch!(c, frame({ runId: 'run-99999999' }));
    const detail = c.getQueryData(keys.run('control-tower')) as { run: RunState };
    expect(detail.run.phases['7']!.live).toBeUndefined();
  });

  it('the summary line prints what the lane reported, not what the record remembers', () => {
    const record = runWithPhase().phases['7']!;
    const { rerender } = render(<TaskLine tasks={record.tasks} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('1/3');
    rerender(<TaskLine tasks={record.tasks} live={{ total: 3, done: 2, active: 'cache the parse' }} />);
    const row = screen.getByTestId('task-summary');
    expect(row).toHaveTextContent('2/3');
    expect(row).toHaveTextContent('cache the parse');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The phase's report
 * ------------------------------------------------------------------ */

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

describe('NowReport — a live phase answered from the console alone', () => {
  it('leads with the plain-language answer and the ETA with its confidence', () => {
    withData(<NowReport report={REPORT} />);
    expect(screen.getByTestId('now-summary')).toHaveTextContent('Phase 11 is on p11.task3 — design review');
    expect(screen.getByText(/22–53 min left/)).toHaveTextContent('22–53 min left, medium confidence');
    expect(screen.getByRole('heading', { name: 'Phase 11 now' })).toBeInTheDocument();
  });

  it('says the operation as a meter, and links its figure to the journal line it came from', () => {
    withData(<NowReport report={REPORT} />);
    const meter = screen.getByRole('meter', { name: 'iOS sweep vendor' });
    expect(meter).toHaveAttribute('aria-valuenow', '45');
    expect(meter).toHaveAttribute('aria-valuemax', '68');
    expect(meter).toHaveTextContent('iOS sweep vendor: 45 of 68');
    const link = screen.getByRole('link', { name: 'journal #106' });
    expect(link.getAttribute('href')).toMatch(/j=106/);
  });

  it('names what it waits on and why it is slow, each cause by its rule, each with its source', () => {
    withData(<NowReport report={REPORT} />);
    const why = screen.getByRole('region', { name: 'Why it is slow' });
    expect(
      within(why)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-rule')),
    ).toEqual(['machine-load', 'repeat-verification']);
    expect(within(why).getByRole('link', { name: 'journal #101' })).toBeInTheDocument();
    expect(within(why).getByTitle('machine load average')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting on' })).toHaveTextContent(
      'Bash `npm run e2e:ios`, open 12 min',
    );
  });

  it('lists every task with its start and duration, the current one marked', () => {
    withData(<NowReport report={REPORT} />);
    const rows = within(screen.getByRole('list', { name: 'Tasks' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['completed', 'completed', 'in_progress']);
    expect(rows[1]).toHaveTextContent('12m');
    expect(screen.getByText(/2 of 3 tasks done/)).toBeInTheDocument();
    expect(
      screen.getByText('ETA from this phase’s own rate: 2 finished tasks averaged 11 min.'),
    ).toBeInTheDocument();
  });

  it('says why there is no ETA when there is none', () => {
    withData(
      <NowReport
        report={{
          ...REPORT,
          eta: { minutes: null, confidence: 'none', basis: 'no task has finished yet', source: [] },
        }}
      />,
    );
    expect(screen.getByText('no estimate yet')).toBeInTheDocument();
    expect(screen.getByText('No ETA: no task has finished yet.')).toBeInTheDocument();
  });

  it('names a source in words', () => {
    expect(sourceWords({ kind: 'journal', seq: 7, event: 'phase.progress' })).toBe(
      'journal line 7 (phase.progress)',
    );
    expect(sourceWords({ kind: 'session-line', line: 'l2' })).toBe('session log line l2');
    expect(sourceWords({ kind: 'record', field: 'tasks' })).toBe('phase record tasks');
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

  it('draws a report for each live lane of a run, four at most', () => {
    const c = client();
    for (const phase of [11, 12, 13, 14, 15]) {
      c.setQueryData([...keys.phaseNow('demo'), String(phase), 'report'], { ...REPORT, phase });
    }
    withData(<LiveNow slug="demo" phases={[11, 12, 13, 14, 15]} />, c);
    expect(within(screen.getByTestId('live-now')).getAllByTestId('now-panel')).toHaveLength(4);
  });

  it('draws nothing for a run with no live lane', () => {
    const { container } = withData(<LiveNow slug="demo" phases={[]} />);
    expect(container.querySelector('[data-testid="live-now"]')).toBeNull();
  });
});

describe('the report refreshes with the journal — no reload', () => {
  it('a line that moves the report re-reads the plan’s phase views, and an unrelated one does not', () => {
    const c = client();
    const spy = vi.spyOn(c, 'invalidateQueries');
    const touched = () =>
      spy.mock.calls.some(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(keys.phaseNow('demo')),
      );
    applyEffect(c, 'run:journal', { slug: 'demo', event: 'phase.progress', phase: 11 });
    expect(touched()).toBe(true);
    spy.mockClear();
    applyEffect(c, 'run:journal', { slug: 'demo', event: 'phase.api-retry', phase: 11 });
    expect(touched()).toBe(false);
  });
});

describe('LastActivity — the newest thing a lane did, from its own log', () => {
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
    expect(
      activityLine({ kind: 'marker', marker: 'input', at: at(1), text: 'look  at\nthis', line: 'l' }),
    ).toBe('told: look at this');
    render(<LastActivityLine activity={ACTIVITY} />);
    const line = screen.getByTestId('last-activity');
    expect(line).toHaveTextContent('Bash — Run the iOS sweep, running');
    expect(line).toHaveAttribute('title', 'From the session’s own log, line l2');
  });

  it('draws nothing for a payload without events', () => {
    const { container } = render(<LastActivityLine activity={{ ...ACTIVITY, events: undefined as never }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the phase’s activity and draws nothing when the session left no log', () => {
    const c = client();
    c.setQueryData([...keys.phaseNow('demo'), '11', 'activity', 5], ACTIVITY);
    c.setQueryData([...keys.phaseNow('demo'), '12', 'activity', 5], {
      ...ACTIVITY,
      phase: 12,
      source: 'none',
      events: [],
    });
    withData(
      <>
        <LastActivity slug="demo" phase={11} />
        <LastActivity slug="demo" phase={12} />
      </>,
      c,
    );
    expect(screen.getAllByTestId('last-activity')).toHaveLength(1);
  });
});
