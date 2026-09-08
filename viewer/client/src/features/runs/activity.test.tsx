/**
 * "What it is doing" — the three gaps of issue #9, and the fourth panel.
 *
 * All three were the same shortfall seen three times: the console already held
 * the fact and did not put it on screen.
 *
 *   1. Every tool call is stamped with `at` and every list rewrite with
 *      `todosAt`, and the panel read neither — the right-hand column was a
 *      duration, so a reader could see that a `Bash` took four minutes and never
 *      that it happened nine hours ago.
 *   2. The paint table was two entries against a vocabulary of three, so
 *      `pending` painted identically to a status the panel did not recognise at
 *      all — and the dot was the only carrier of status, `aria-hidden`.
 *   3. A running verification reported nothing until it was over.
 */

import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { VERIFY_STATES } from '@shared/console-model.js';
import { NO_ACTIVITY, type Activity } from './console-model';
import { ActivityPanels, VERIFY_STATE, type TaskMark } from './activity';

/**
 * The `const` assertion in `shared/task-model.js` is load-bearing, and nothing
 * pinned it (QA round 3, NEW-1).
 *
 * Without it, plain JS widens `mark` to `string`, `TaskMark` becomes `string`,
 * and `MARK_CLASS` turns into an open record where a deleted entry compiles —
 * a task's dot silently losing its shape, which is #9.2's own defect. Round 2
 * fixed that; this is what keeps it fixed. The invariant lives in `task-model.js`
 * and the type that depends on it lives here, so the pin has to be here too.
 *
 * It is a TYPE assertion, checked by `typecheck:client` and not at runtime: with
 * the `const` assertion in place this line is an error and `@ts-expect-error`
 * suppresses it; the moment the assertion leaves, the line compiles, the
 * suppression has nothing to do, and `tsc` says `TS2578`.
 */
// @ts-expect-error — 'not-a-real-mark' is not one of the three marks
const WRONG_MARK: TaskMark = 'not-a-real-mark';
void WRONG_MARK;

/** 1970-01-01 14:07:52 local — a clock the test can name exactly. */
const AT = new Date(1970, 0, 1, 14, 7, 52).getTime();

const panels = (over: Partial<Activity>): Activity => ({ ...NO_ACTIVITY, ...over });

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
    ] as never,
  });

  it('paints all three statuses distinctly — `pending` is a choice, not a fallback', () => {
    const { container } = render(<ActivityPanels activity={TODOS} live now={AT} />);
    // Three DIFFERENT state tokens. `pending` used to fall through to
    // `text-ink-faint`, which is also what an unrecognised status paints as.
    expect(container.querySelector('.state-done')).toBeInTheDocument();
    expect(container.querySelector('.state-running')).toBeInTheDocument();
    expect(container.querySelector('.state-queued')).toBeInTheDocument();
  });

  it('carries the status in TEXT, never in the dot alone', () => {
    render(<ActivityPanels activity={TODOS} live now={AT} />);
    // The dot is `aria-hidden`, so without this `pending` and `in_progress` are
    // one row written twice to a screen reader, and differ by colour alone to
    // everyone else.
    const row = screen.getByText(/Wiring the endpoint/).closest('li')!;
    expect(within(row).getByText(/Doing/)).toBeInTheDocument();
  });

  it('has a key naming all three statuses', () => {
    const { container } = render(<ActivityPanels activity={TODOS} live now={AT} />);
    const legend = container.querySelector('[data-slot="legend"]')!;
    for (const word of ['To do', 'Doing', 'Done']) {
      expect(within(legend as HTMLElement).getByText(word)).toBeInTheDocument();
    }
  });

  it('says when the session last wrote the list', () => {
    render(<ActivityPanels activity={TODOS} live now={AT} />);
    expect(screen.getByText(/Written at 14:07:52\./)).toBeInTheDocument();
  });

  it('says nothing about a write time it does not have', () => {
    render(<ActivityPanels activity={panels({ todos: TODOS.todos })} live now={AT} />);
    expect(screen.queryByText(/Written at/)).toBeNull();
  });

  it('a ROW whose status the table has no entry for still renders', () => {
    expect(() =>
      render(
        <ActivityPanels
          now={AT}
          live
          activity={panels({
            todos: [{ id: 'x', content: 'from the future', status: 'deferred' }] as never,
          })}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText('from the future')).toBeInTheDocument();
  });
});

/**
 * The crash M2 was really about, and which the row test above cannot reach.
 *
 * The unguarded read was in the LEGEND, which maps over `TASK_STATUSES` — so
 * the input that breaks it is a status in the vocabulary that the paint table
 * has no entry for, which only a mocked module can produce. Round 2 caught that
 * the first pin never touched the changed line: with the guard reverted the file
 * stayed green (QA round 2, F2).
 *
 * A fourth status is not hypothetical — `TASK_STATUSES` is the CLI's vocabulary
 * as much as ours, and the server-side totality assertion catches it only for
 * OUR half.
 */
describe('a status in the vocabulary with no mark (QA r2 F2)', () => {
  it('does not take the whole card down', async () => {
    vi.resetModules();
    vi.doMock('@shared/task-model.js', async () => {
      const real = await vi.importActual<typeof import('@shared/task-model.js')>('@shared/task-model.js');
      return { ...real, TASK_STATUSES: [...real.TASK_STATUSES, 'deferred'] };
    });
    try {
      const { ActivityPanels: Panels } = await import('./activity');
      const { NO_ACTIVITY: EMPTY } = await import('./console-model');

      expect(() =>
        render(
          <Panels
            now={AT}
            live
            activity={{ ...EMPTY, todos: [{ id: 'a', content: 'wire it', status: 'pending' }] as never }}
          />,
        ),
      ).not.toThrow();
      // …and the unknown status is still named, from the only thing that knows it.
      expect(screen.getByText('deferred')).toBeInTheDocument();
    } finally {
      // In a `finally`, so a failed expectation cannot leave the module registry
      // mocked for whatever runs next (QA round 3, NEW-2). Vitest's fork
      // isolation would contain it anyway; a test that tidies up only when it
      // passes is still a test that tidies up only when it passes.
      vi.doUnmock('@shared/task-model.js');
      vi.resetModules();
    }
  });
});

describe('tool activity and subagents', () => {
  it('puts a clock time on every tool row, beside how long it took', () => {
    render(
      <ActivityPanels
        now={AT}
        live={false}
        activity={panels({
          tools: [
            { id: 't1', name: 'Bash', summary: 'npm test', at: AT, ms: 240_000, ok: true, detail: '' },
          ] as never,
        })}
      />,
    );
    // The duration alone cannot place a call in time, which is the whole
    // question on a run replayed after a reload.
    expect(screen.getByText('14:07:52')).toBeInTheDocument();
    expect(screen.getByText('4m')).toBeInTheDocument();
  });

  it('stamps a subagent lane too', () => {
    render(
      <ActivityPanels
        now={AT}
        live
        activity={panels({
          agents: [{ id: 'a1', agent: 'qa', title: 'review', text: '', at: AT, done: false }] as never,
        })}
      />,
    );
    expect(screen.getByText('14:07:52')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
  });
});

describe('the verification, while it runs', () => {
  it('paints every state the fold can assign, and no invented sixth', () => {
    // The row's state and its paint must come from one list. A state the fold
    // can produce and the panel cannot draw is the one case a reader cannot
    // tell from a rendering bug — which is the whole of gap 2, one panel over.
    expect(Object.keys(VERIFY_STATE).sort()).toEqual([...VERIFY_STATES].sort());
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
    expect(screen.getByText('passed')).toBeInTheDocument();
    // The one in flight has an elapsed time — the old pane had no running
    // indicator at all, only a line and then forty minutes of silence.
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('2m')).toBeInTheDocument();
  });

  it('surfaces a skip explicitly, with the reason', () => {
    render(<ActivityPanels activity={VERIFY} live now={AT} />);
    expect(screen.getByText('rg --version')).toBeInTheDocument();
    expect(screen.getByText('skipped')).toBeInTheDocument();
    expect(screen.getByText(/`rg` is not installed here/)).toBeInTheDocument();
  });

  it('shows a failed command’s exit code and a tail of its output', () => {
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
    // Twice, deliberately: once as the row's own state and once as the card's
    // verdict. The row is the one that must carry the exit code.
    expect(screen.getAllByText('failed')).toHaveLength(2);
    expect(screen.getByText('900ms · 1')).toBeInTheDocument();
    expect(screen.getByText(/AssertionError: expected 3 to be 4/)).toBeInTheDocument();
    expect(screen.getByText('`npm test` exited 1')).toBeInTheDocument();
  });

  it('renders on its own, with no session activity at all', () => {
    // The verification runs AFTER the session ends, so the card must not depend
    // on there being a task list or a tool call to hang it on.
    const { container } = render(<ActivityPanels activity={VERIFY} live={false} now={AT} />);
    expect(container.querySelector('div')).not.toBeNull();
    expect(screen.getByText('Verification')).toBeInTheDocument();
  });

  it('draws nothing when nothing has happened', () => {
    const { container } = render(<ActivityPanels activity={NO_ACTIVITY} live={false} now={AT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the in-flight command’s elapsed clock TICKS (QA r1 M3)', () => {
    // Nothing re-renders this pane between a command's start event and its
    // result — the forty minutes the checklist was written for — so a
    // render-time `Date.now()` painted the same number for the whole suite.
    // No `now` prop here on purpose: that is the production call site's shape.
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
    // `useNow(live && …)` arms no interval on a run that is over, which is what
    // keeps a page of replayed lanes from waking once a second each.
    render(<ActivityPanels activity={VERIFY} live={false} />);
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('is clean to axe', async () => {
    const { container } = render(<ActivityPanels activity={VERIFY} live now={AT} />);
    await expectNoAxeViolations(container);
  });
});
