/**
 * A session's console (7.0, quiet-console phase 12).
 *
 *  1. **Exit criterion 1: a pane holds its run's stream for exactly as long as
 *     it is mounted.** The server sends a run's partials only to a connection
 *     that asked for that run, so a lane pane that draws them must hold
 *     `run:stream` while it is on screen and let it go when it leaves — and a
 *     pane that never draws session text (the run's own) must never hold it.
 *     The stream here is a stub: `useRunStream` writes `acquire`/`release`
 *     into a trace from the same effect shape the real hook has, and `onSse`
 *     keeps its listeners where the case can push frames and count what is
 *     left after the pane is gone.
 *  2. **One session per pane.** A frame for another run, or another lane of
 *     the same run, never reaches the pane; the runner's narration does.
 *  3. **The console itself**: the tail it follows, the search that stops the
 *     tail, the detail it hides, a line's address and the delivery tick.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { trace, listeners } = vi.hoisted(() => ({
  trace: [] as string[],
  listeners: new Map<string, Set<(data: unknown, name: string) => void>>(),
}));

// The real hook is `useEffect(() => (runId ? acquireRunStream(runId) : undefined), [runId])`;
// the stub keeps that shape and writes what it would hold into the trace.
vi.mock('@/data/live-share', async (importOriginal) => {
  const { useEffect } = await import('react');
  return {
    ...(await importOriginal<typeof import('@/data/live-share')>()),
    useRunStream(runId: string | null | undefined) {
      useEffect(() => {
        if (!runId) return undefined;
        trace.push(`acquire ${runId}`);
        return () => {
          trace.push(`release ${runId}`);
        };
      }, [runId]);
    },
  };
});

vi.mock('@/data/live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/live')>()),
  onSse(name: string, fn: (data: unknown, name: string) => void) {
    const set = listeners.get(name) ?? new Set();
    listeners.set(name, set);
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  },
}));

import type { TranscriptEntry } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from '@/shell/router';
import {
  LINE_PARAM,
  RunConsole,
  lineHref,
  lineMatches,
  linesForPhase,
  linkedLine,
  useLiveLines,
} from './console';
import type { ConsoleLine } from './console-model';
import { RunSessionPanes } from './session-panes';

/** Deliver one frame to every listener of its name, as the stream would. */
const push = (name: string, data: unknown) =>
  act(() => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn(data, name);
  });

/** How many listeners are still attached, across every event name. */
const listening = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  trace.length = 0;
  listeners.clear();
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});

/** Panes with their replays and the run already answered, so nothing fetches. */
function mountPanes(node: ReactElement) {
  const client = new QueryClient(queryClientConfig);
  for (const phase of [undefined, 3, 4]) {
    client.setQueryData(
      phase == null ? [...keys.transcript('demo'), 'run-1'] : [...keys.transcript('demo'), 'run-1', phase],
      [],
    );
  }
  client.setQueryData(keys.run('demo'), { run: null, history: [], eta: null });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/plan/demo/run">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

/* ------------------------------------------------------------------ *
 * 1 · The stream, held and let go
 * ------------------------------------------------------------------ */

describe('exit criterion 1 — a pane holds its run’s stream while it is mounted', () => {
  it('a lane pane acquires run-1 once, draws only its own session, and releases it on unmount', () => {
    const view = mountPanes(<RunSessionPanes slug="demo" runId="run-1" phase={3} live allowRun={false} />);
    expect(trace).toEqual(['acquire run-1']);

    push('run:stream', { runId: 'run-1', slug: 'demo', phase: 3, kind: 'text', text: 'three speaks' });
    push('run:stream', { runId: 'run-1', slug: 'demo', phase: 4, kind: 'text', text: 'four speaks' });
    push('run:stream', { runId: 'run-2', slug: 'other', phase: 3, kind: 'text', text: 'another run speaks' });
    push('run:phase', { runId: 'run-1', slug: 'demo', phase: 3, status: 'running', model: 'opus' });

    const log = screen.getByRole('log', { name: 'Phase 3 console' });
    expect(within(log).getByText('three speaks')).toBeInTheDocument();
    expect(within(log).queryByText('four speaks')).toBeNull();
    expect(within(log).queryByText('another run speaks')).toBeNull();
    expect(within(log).getByText('phase 3 started on opus')).toBeInTheDocument();

    view.unmount();
    expect(trace).toEqual(['acquire run-1', 'release run-1']);
    expect(listening()).toBe(0);
  });

  it('the run’s own pane never holds the stream: it draws the narration and no session text', () => {
    const view = mountPanes(
      <RunSessionPanes slug="demo" runId="run-1" live allowRun={false} runLevel title="Run console" />,
    );
    expect(trace).toEqual([]);
    expect(listeners.get('run:stream')?.size ?? 0).toBe(0);

    push('run:stream', { runId: 'run-1', slug: 'demo', phase: 6, kind: 'text', text: 'six speaks' });
    push('run:phase', { runId: 'run-1', slug: 'demo', phase: 6, status: 'running', model: 'opus' });

    const log = screen.getByRole('log', { name: 'Run console' });
    expect(within(log).queryByText('six speaks')).toBeNull();
    expect(within(log).getByText('phase 6 started on opus')).toBeInTheDocument();

    view.unmount();
    expect(trace).toEqual([]);
    expect(listening()).toBe(0);
  });

  it('two panes of one run acquire it twice and release it twice', () => {
    const view = mountPanes(
      <>
        <RunSessionPanes slug="demo" runId="run-1" phase={3} live allowRun={false} />
        <RunSessionPanes slug="demo" runId="run-1" phase={4} live allowRun={false} />
      </>,
    );
    expect(trace).toEqual(['acquire run-1', 'acquire run-1']);
    view.unmount();
    expect(trace).toEqual(['acquire run-1', 'acquire run-1', 'release run-1', 'release run-1']);
    expect(listening()).toBe(0);
  });

  it('a pane on a stale server holds nothing and listens to nothing', () => {
    mountPanes(<RunSessionPanes slug="demo" runId="run-1" phase={3} live allowRun={false} enabled={false} />);
    expect(trace).toEqual([]);
    expect(listening()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The replay, narrowed the same way
 * ------------------------------------------------------------------ */

describe('linesForPhase', () => {
  const entry = (seq: number, phase?: number): TranscriptEntry => ({
    seq,
    at: '2026-08-04T00:00:00Z',
    event: 'stream',
    data:
      phase == null ? { kind: 'text', text: `line ${seq}` } : { phase, kind: 'text', text: `line ${seq}` },
  });

  it('keeps the lane asked for and drops the others', () => {
    const all = [entry(1, 6), entry(2, 7), entry(3, 6)];
    expect(linesForPhase(all, 6)?.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('keeps the run’s narration, which belongs to no lane', () => {
    // Dropping it would leave a lane's replay starting mid-sentence.
    expect(linesForPhase([entry(1), entry(2, 7)], 7)?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('is the identity with no phase — a whole-run pane replays everything', () => {
    const all = [entry(1, 6), entry(2, 7)];
    expect(linesForPhase(all, undefined)).toBe(all);
    expect(linesForPhase(undefined, 6)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 3 · The buffer
 * ------------------------------------------------------------------ */

describe('useLiveLines — seeding the task list from the record', () => {
  it('does not invent a write time the record does not carry', () => {
    const { result } = renderHook(() => useLiveLines());
    act(() => {
      result.current.seedTasks([
        { id: 'p3.task1', content: 'merge the branch', status: 'completed' },
        { id: 'p3.task2', content: 'write the handoff', status: 'pending' },
      ]);
    });
    expect(result.current.activity.todos).toHaveLength(2);
    // `0`, not the moment the page opened: the record carries the rows, not when they were written.
    expect(result.current.activity.todosAt).toBe(0);
  });

  it('keeps the real write time a replay established', () => {
    const { result } = renderHook(() => useLiveLines());
    const wrote = Date.parse('2026-09-02T11:04:00Z');
    act(() => {
      result.current.hydrate([
        {
          seq: 1,
          at: new Date(wrote).toISOString(),
          event: 'stream',
          data: { kind: 'todos', items: [{ content: 'wire the endpoint', status: 'in_progress' }] },
        },
      ]);
    });
    expect(result.current.activity.todosAt).toBe(wrote);
    // The record then seeds MORE rows than the replay saw, and the time survives it.
    act(() => {
      result.current.seedTasks([
        { id: 'a', content: 'wire the endpoint', status: 'in_progress' },
        { id: 'b', content: 'write the handoff', status: 'pending' },
      ]);
    });
    expect(result.current.activity.todos).toHaveLength(2);
    expect(result.current.activity.todosAt).toBe(wrote);
  });

  it('seeds once, and never over a panel the live stream has carried further', () => {
    const { result } = renderHook(() => useLiveLines());
    act(() => {
      result.current.record('stream', {
        kind: 'todos',
        items: [
          { content: 'a', status: 'pending' },
          { content: 'b', status: 'pending' },
        ],
      });
    });
    act(() => {
      result.current.seedTasks([{ id: 'x', content: 'stale', status: 'pending' }]);
    });
    expect(result.current.activity.todos.map((t) => t.content)).toEqual(['a', 'b']);
  });
});

describe('useLiveLines — the verification checklist', () => {
  it('a replay that predates the settled events leaves no row running', () => {
    // Older replays carry only START events: every row opened and nothing closed
    // one, so a finished run's pane claimed both commands were still going.
    const { result } = renderHook(() => useLiveLines());
    act(() => {
      result.current.hydrate([
        {
          seq: 1,
          at: '2026-09-02T11:00:00Z',
          event: 'verify',
          data: { phase: 3, command: 'npm test', index: 0, total: 2 },
        },
        {
          seq: 2,
          at: '2026-09-02T11:00:01Z',
          event: 'verify',
          data: { phase: 3, command: 'npm run lint', index: 1, total: 2 },
        },
        { seq: 3, at: '2026-09-02T11:40:00Z', event: 'phase', data: { phase: 3, status: 'done' } },
      ]);
    });
    expect(result.current.activity.verify.commands.map((c) => c.state)).toEqual(['unknown', 'unknown']);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · The console
 * ------------------------------------------------------------------ */

const AT = new Date(1970, 0, 1, 14, 7, 52).getTime();

const LINES: ConsoleLine[] = [
  { id: 1, kind: 'tool', text: 'Bash  npm test', tool: 'toolu_01abc', at: AT },
  { id: 2, kind: 'thinking', text: 'considering the cache', at: AT + 1000 },
  { id: 3, kind: 'text', text: 'The suite is green.', at: AT + 2000 },
  { id: 4, kind: 'hook', text: 'PreToolUse (Bash) — ok', at: AT + 3000 },
  { id: 5, kind: 'injected', text: 'are you stuck?', mark: 'ask:1', delivered: false, at: AT + 4000 },
];

function mountConsole(props: Partial<Parameters<typeof RunConsole>[0]> = {}, address = '#/plan/demo/run') {
  return render(
    <MemoryRouterProvider initial={address}>
      <RunConsole lines={LINES} title="Phase 6 console" {...props} />
    </MemoryRouterProvider>,
  );
}

const count = () => screen.getByTestId('console-count').textContent;
const followButton = () => screen.getByRole('button', { name: /^Follow/ });
const lineEl = (id: number) => document.querySelector(`[data-line="${id}"]`) as HTMLElement;

describe('RunConsole — the box', () => {
  it('is a polite, named log of one height, whose body chains its scroll at its ends', () => {
    mountConsole();
    const log = screen.getByRole('log', { name: 'Phase 6 console' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log.className).toContain('live-body');
    expect(log.className).toContain('h-[min(380px,calc(var(--app-height,100%)*0.5))]');
    expect(log.className).not.toMatch(/overscroll-contain/);
  });

  it('heads with the status mark, the name, the vitals and the controls', () => {
    mountConsole({
      status: <span data-testid="mark">Running</span>,
      subtitle: 'opus, worked 12m 03s',
      actions: <span data-testid="controls">controls</span>,
    });
    expect(screen.getByRole('heading', { level: 3, name: 'Phase 6 console' })).toBeInTheDocument();
    expect(screen.getByTestId('mark')).toBeInTheDocument();
    expect(screen.getByText('opus, worked 12m 03s')).toBeInTheDocument();
    expect(screen.getByTestId('controls')).toBeInTheDocument();
  });

  it('says it is waiting in one line when nothing has been said', () => {
    mountConsole({ lines: [] });
    expect(screen.getByTestId('console-empty')).toHaveTextContent(
      'Nothing yet — this session’s lines appear here as it works.',
    );
    expect(count()).toBe('0 lines');
  });

  it('stamps every line with its wall clock', () => {
    mountConsole();
    expect(within(lineEl(1)).getByText('14:07:52')).toBeInTheDocument();
  });

  it('hands Clear to the pane', () => {
    const onClear = vi.fn();
    mountConsole({ onClear });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('RunConsole — detail', () => {
  it('keeps the model’s working and the hook calls behind Detail, counted', () => {
    mountConsole();
    expect(count()).toBe('3 lines');
    expect(screen.queryByText('considering the cache')).toBeNull();

    const detail = screen.getByRole('button', { name: 'Show detail (2)' });
    expect(detail).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(detail);
    expect(screen.getByText('considering the cache')).toBeInTheDocument();
    expect(screen.getByText('PreToolUse (Bash) — ok')).toBeInTheDocument();
    expect(count()).toBe('5 lines');
    expect(screen.getByRole('button', { name: 'Hide detail' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no Detail when nothing is hidden', () => {
    mountConsole({ lines: [LINES[0]!, LINES[2]!] });
    expect(screen.queryByRole('button', { name: /detail/i })).toBeNull();
  });
});

describe('RunConsole — the search', () => {
  it('filters by the words, stops the tail, and Escape clears it and follows again', () => {
    mountConsole();
    expect(followButton()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox', { name: 'Search the console' });
    expect(box).toHaveFocus();

    fireEvent.change(box, { target: { value: 'NPM' } });
    expect(screen.getByText('Bash npm test')).toBeInTheDocument();
    expect(screen.queryByText('The suite is green.')).toBeNull();
    expect(count()).toBe('1 of 3 lines');
    // A filtered view does not scroll to a bottom nobody is reading.
    expect(followButton()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('The suite is green.')).toBeInTheDocument();
    expect(followButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('matches a kind’s word and a tool id as well as the text', () => {
    mountConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox', { name: 'Search the console' });
    fireEvent.change(box, { target: { value: 'says' } });
    expect(screen.getByText('The suite is green.')).toBeInTheDocument();
    expect(screen.queryByText('Bash npm test')).toBeNull();
    fireEvent.change(box, { target: { value: 'toolu_01' } });
    expect(screen.getByText('Bash npm test')).toBeInTheDocument();
  });

  it('names the needle in one line when nothing matches, with the way back', () => {
    mountConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the console' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByTestId('console-no-match')).toHaveTextContent('No line here matches “zzz”.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(screen.getByText('The suite is green.')).toBeInTheDocument();
  });

  it('lineMatches is a case-blind substring over the text, the kind’s word and the tool id', () => {
    const line = LINES[0]!;
    expect(lineMatches(line, '')).toBe(true);
    expect(lineMatches(line, 'NPM TEST')).toBe(true);
    expect(lineMatches(line, 'tool')).toBe(true);
    expect(lineMatches(line, 'toolu_01abc')).toBe(true);
    // A substring, never a pattern: the dot is a dot.
    expect(lineMatches({ ...line, text: 'see a.b(c)' }, 'a.b(')).toBe(true);
    expect(lineMatches(line, 'cache')).toBe(false);
  });
});

describe('RunConsole — following the tail', () => {
  it('stops when the reader scrolls up, and Follow jumps back to the newest line', () => {
    mountConsole();
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });

    log.scrollTop = 100;
    fireEvent.scroll(log);
    expect(followButton()).toHaveTextContent('Follow');
    expect(followButton()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(followButton());
    expect(followButton()).toHaveTextContent('Following');
    expect(log.scrollTop).toBe(1000);
  });
});

describe('a line’s address', () => {
  it('rides on ?line=, built by the routes module and keeping the rest of the address', () => {
    expect(LINE_PARAM).toBe('line');
    expect(lineHref(7, '#/plan/demo/run?lane=p6')).toBe('#/plan/demo/run?lane=p6&line=7');
    expect(lineHref(7, '#/plan/demo/run?line=3')).toBe('#/plan/demo/run?line=7');
    expect(linkedLine('#/plan/demo/run?lane=p6&line=12')).toBe(12);
    expect(linkedLine('#/plan/demo/run')).toBeNull();
    expect(linkedLine('#/plan/demo/run?line=twelve')).toBeNull();
  });

  it('the kind’s word copies the line’s link and marks the line', async () => {
    mountConsole({}, '#/plan/demo/run?lane=p6');
    fireEvent.click(within(lineEl(3)).getByRole('button', { name: 'says' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toMatch(/#\/plan\/demo\/run\?lane=p6&line=3$/);
    expect(lineEl(3)).toHaveClass('is-linked');
    expect(lineEl(1)).not.toHaveClass('is-linked');
  });

  it('an address that names a line marks it on arrival and stops the tail there', () => {
    mountConsole({}, '#/plan/demo/run?line=3');
    expect(lineEl(3)).toHaveClass('is-linked');
    expect(followButton()).toHaveAttribute('aria-pressed', 'false');
  });

  it('a line the buffer no longer holds marks nothing', () => {
    mountConsole({}, '#/plan/demo/run?line=99');
    expect(document.querySelector('.is-linked')).toBeNull();
    expect(followButton()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('an operator’s message', () => {
  it('ticks when the session echoes it back', () => {
    const view = mountConsole();
    const pending = within(lineEl(5)).getByTitle('Written to the session; waiting for it to echo back');
    expect(pending).toHaveTextContent('·');
    expect(pending).not.toHaveClass('is-delivered');

    view.rerender(
      <MemoryRouterProvider initial="#/plan/demo/run">
        <RunConsole
          lines={[...LINES.slice(0, 4), { ...LINES[4]!, delivered: true }]}
          title="Phase 6 console"
        />
      </MemoryRouterProvider>,
    );
    const landed = within(lineEl(5)).getByTitle('The session echoed this back: it landed');
    expect(landed).toHaveTextContent('✓');
    expect(landed).toHaveClass('is-delivered');
  });
});
