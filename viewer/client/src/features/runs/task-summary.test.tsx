/**
 * The task list, on the browser's side of the channel.
 *
 * Three properties, and each of them was a live defect:
 *
 *  1. **the panel is seeded from the RECORD, not the replay.** The transcript
 *     is read as a 400-entry tail, and in a measured 10,792-entry run not one
 *     of its 85 `TaskCreate`s fell inside the window — so the browser folded a
 *     stream of updates to rows it had never seen, and the panel stayed empty
 *     on every reload. The server's fold sees every line.
 *  2. **an empty list clears** (r2 client-15). A whole-list rewrite of `[]` is
 *     a session saying it finished or abandoned its plan; reading it as
 *     "nothing to see" left the last list on the screen for ever.
 *  3. **one summary, three surfaces.** `taskSummary` is read here, on the Now
 *     lane cards and on the Sessions rows — the `PhaseStateChip` rule.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { keys, queryClientConfig } from '@/lib/queries';
import type { PhaseRecord, PhaseTask, RunState, TranscriptEntry } from '@/lib/api';
import { NO_ACTIVITY, activity } from './console-model';
import { SessionPanes } from './session-panes';
import { TaskLine } from './task-summary';

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
  it('reads `done/total · what it is doing` off the one summary', () => {
    render(<TaskLine tasks={TASKS} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('1/3');
    expect(screen.getByTestId('task-summary')).toHaveTextContent('Wiring the runner');
  });

  it('names the task plainly when the session gave no active form', () => {
    render(<TaskLine tasks={[{ id: 'a', content: 'do the thing', status: 'in_progress' }]} />);
    expect(screen.getByTestId('task-summary')).toHaveTextContent('do the thing');
  });

  it('renders nothing at all when the session published no list', () => {
    const { container } = render(<TaskLine tasks={undefined} />);
    expect(container).toBeEmptyDOMElement();
    // …and an empty list is the same silence: "it did not say" is not a fact
    // worth a row of furniture.
    expect(render(<TaskLine tasks={[]} />).container).toBeEmptyDOMElement();
  });

  it('never claims work that has not started', () => {
    render(<TaskLine tasks={[{ id: 'a', content: 'not started', status: 'pending' }]} />);
    const line = screen.getByTestId('task-summary');
    expect(line).toHaveTextContent('0/1');
    expect(line.textContent).not.toContain('not started');
  });
});

describe('the fold', () => {
  it('builds a list from the script channel, ids and all', () => {
    let state = NO_ACTIVITY;
    state = activity(state, 'stream', { kind: 'task', op: 'create', taskId: 'p8.task1', content: 'one' });
    state = activity(state, 'stream', { kind: 'task', op: 'create', taskId: 'p8.task2', content: 'two' });
    state = activity(state, 'stream', {
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
    let state = activity(NO_ACTIVITY, 'stream', { kind: 'task', op: 'create', taskId: 'a', content: 'one' });
    state = activity(state, 'stream', { kind: 'task', op: 'reset' });
    expect(state.todos).toEqual([]);
  });

  it('lets an empty whole-list write CLEAR the panel (r2 client-15)', () => {
    let state = activity(NO_ACTIVITY, 'stream', {
      kind: 'todos',
      items: [{ content: 'one', status: 'pending' }],
    });
    expect(state.todos).toHaveLength(1);
    state = activity(state, 'stream', { kind: 'todos', items: [] });
    expect(state.todos).toEqual([]);
  });

  it('keeps the identity contract — an unchanged fold is the same object', () => {
    const state = activity(NO_ACTIVITY, 'stream', {
      kind: 'task',
      op: 'create',
      taskId: 'a',
      content: 'one',
    });
    // Nine in ten stream events change nothing, and the same reference is what
    // makes React bail out of the re-render.
    expect(
      activity(state, 'stream', { kind: 'task', op: 'update', taskId: 'ghost', status: 'completed' }),
    ).toBe(state);
    expect(activity(state, 'stream', { kind: 'todos', items: 'not an array' })).toBe(state);
  });
});

/* ------------------------------------------------------------------ *
 * The seed — the half a replay cannot do
 * ------------------------------------------------------------------ */

function runWith(tasks: PhaseTask[] | undefined, id = 'r1'): RunState {
  const record = { phase: 8, status: 'running', attempts: 1, costUsd: 0, ...(tasks ? { tasks } : {}) };
  return {
    id,
    slug: 'demo',
    status: 'running',
    phases: { '8': record as PhaseRecord },
  } as unknown as RunState;
}

function mount(run: RunState, transcript: TranscriptEntry[] = [], runId = 'r1') {
  const client = new QueryClient(queryClientConfig);
  client.setQueryData([...keys.transcript('demo'), runId], transcript);
  client.setQueryData(keys.run('demo'), { run, history: [], eta: null });
  return render(
    <QueryClientProvider client={client}>
      <SessionPanes slug="demo" runId={runId} phase={8} live allowRun={false} />
    </QueryClientProvider>,
  );
}

describe('seeding the panel from the run record', () => {
  it('shows the list a finished run ended on, with an empty transcript', () => {
    mount(runWith(TASKS));
    expect(screen.getByText('Task list')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    // `activeForm` is what an in-progress row reads as — a state, not an order.
    expect(screen.getByText('Wiring the runner')).toBeInTheDocument();
  });

  it('shows nothing when the record has no list — no invented panel', () => {
    mount(runWith(undefined));
    expect(screen.queryByText('Task list')).not.toBeInTheDocument();
  });

  it("does not seed a replay of a DIFFERENT run with the live one's list", () => {
    // The pane is showing run `r0`; the cache holds `r1`. Seeding across them
    // would put one run's task list under another run's console.
    const client = new QueryClient(queryClientConfig);
    client.setQueryData([...keys.transcript('demo'), 'r0'], []);
    client.setQueryData(keys.run('demo'), { run: runWith(TASKS, 'r1'), history: [], eta: null });
    render(
      <QueryClientProvider client={client}>
        <SessionPanes slug="demo" runId="r0" phase={8} live allowRun={false} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Task list')).not.toBeInTheDocument();
  });

  it('finds the run in `history` too, so an old run replays its own list', () => {
    const client = new QueryClient(queryClientConfig);
    client.setQueryData([...keys.transcript('demo'), 'r0'], []);
    client.setQueryData(keys.run('demo'), {
      run: runWith(undefined, 'r1'),
      history: [runWith(TASKS, 'r0')],
      eta: null,
    });
    render(
      <QueryClientProvider client={client}>
        <SessionPanes slug="demo" runId="r0" phase={8} live allowRun={false} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });
});
