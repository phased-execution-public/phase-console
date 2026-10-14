/**
 * The timing grid on one page clock (turn-by-turn phase 8, exit criterion 2),
 * on a fake clock:
 *
 *   TG-1 the grid shows Assigned, Do it, Deadline, Open until, You sent it and
 *        Checked from the item — a missing deadline said as "None set", the
 *        window never called a deadline;
 *   TG-2 a NOT YET card states its *when* in words — at its head and in Do it —
 *        and a start ahead counts down;
 *   TG-3 the countdowns tick every second without re-rendering the card or the
 *        page around it;
 *   TG-4 past the deadline the grid says how overdue, in the failed hue, and the
 *        bar from assigned to deadline is a real meter;
 *   TG-5 the clock's rule: 1 s while a grid is on screen, 30 s otherwise, none
 *        when nothing reads it, and never 1 s under reduced motion.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { Profiler, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { humanStepView } from '@shared/human-step-model.js';
import { queryClientConfig } from '@/data/keys';
import type { TurnItem } from '@/data/api';
import { MemoryRouterProvider } from '@/shell/router';
import { PAGE_CLOCK, clockState } from '@/ui/clock';
import { ItemCard } from '../item-card';
import { TimingGrid, clockSpan } from './timing';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');

function item(over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 's1',
    record: 'projected',
    source: 'plan',
    kind: 'operator-act',
    why: 'reserved',
    proofType: 'probe',
    group: 'now',
    rows: ['row-1'],
    title: 'Create the tunnel',
    need: 'Only the owner holds the account.',
    how: '',
    severity: 'needs-you',
    slug: 'demo',
    phase: 0,
    since: '2026-10-13T09:00:00.000Z',
    href: '/plan/demo',
    actions: [],
    type: 'do',
    personStatus: 'todo',
    readiness: 'now',
    timing: {
      assignedAt: '2026-10-13T09:00:00.000Z',
      deadline: '2026-10-13T12:30:00.000Z',
      openUntil: '2026-10-20T12:00:00.000Z',
      submittedAt: '2026-10-13T11:30:00.000Z',
      checkedAt: '2026-10-13T11:45:00.000Z',
    },
    ...over,
  } as TurnItem;
}

function wrap(node: ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('TG-1 the grid, from the item', () => {
  it('Assigned, Do it, Deadline, Open until, You sent it and Checked', () => {
    wrap(<ItemCard item={item()} perform={vi.fn()} />);
    const grid = screen.getByTestId('turn-timing');
    expect(within(grid).getByTestId('turn-assigned').textContent).toContain('3 h ago');
    expect(within(grid).getByTestId('turn-do-it').textContent).toBe('Do itNow');
    expect(within(grid).getByTestId('turn-deadline').textContent).toContain('30 m 0 s left');
    expect(within(grid).getByTestId('turn-open-until').textContent).toContain('closes in 7 d');
    expect(within(grid).getByTestId('turn-open-until').textContent).not.toMatch(/deadline/i);
    expect(within(grid).getByTestId('turn-sent').textContent).toContain('30 m ago');
    expect(within(grid).getByTestId('turn-checked').textContent).toContain('15 m ago');
  });

  it('a missing deadline is said, not hidden', () => {
    wrap(<ItemCard item={item({ timing: { assignedAt: '2026-10-13T09:00:00.000Z' } })} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-deadline').textContent).toContain('None set');
    expect(screen.queryByTestId('turn-open-until')).toBeNull();
  });
});

describe('TG-2 NOT YET states its when', () => {
  it('a condition in words, at the head and in Do it', () => {
    wrap(
      <ItemCard
        item={item({
          readiness: 'not-yet',
          timing: { assignedAt: '2026-10-13T09:00:00.000Z', startWhen: 'when Phase 13 of demo is done' },
        })}
        perform={vi.fn()}
      />,
    );
    const head = screen.getByTestId('turn-readiness');
    expect(head.getAttribute('data-readiness')).toBe('not-yet');
    expect(within(head).getByTestId('turn-readiness-when').textContent).toBe('when Phase 13 of demo is done');
    expect(screen.getByTestId('turn-do-it').textContent).toContain('When Phase 13 of demo is done');
    expect(screen.queryByTestId('turn-primary')).toBeNull();
    expect(screen.getByTestId('turn-nothing').textContent).toMatch(/opens when it is due/);
  });

  it('a start ahead counts down', () => {
    wrap(
      <ItemCard
        item={item({
          readiness: 'not-yet',
          timing: {
            assignedAt: '2026-10-13T09:00:00.000Z',
            startAt: '2026-10-13T12:10:00.000Z',
            startWhen: 'at 12:10',
          },
        })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('turn-do-it').textContent).toContain('in 10 m 0 s');
  });

  it('a NOW card says Now at its head', () => {
    wrap(
      <ItemCard
        item={item({
          record: 'ledger',
          humanStep: humanStepView({ kind: 'operator-act', title: 'x', state: 'notified', stepId: 's1' }),
        })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('turn-readiness').getAttribute('data-readiness')).toBe('now');
  });
});

describe('TG-3 it ticks without re-rendering the card or the page', () => {
  it('the countdown moves each second; the page around it renders once', () => {
    const renders = vi.fn();
    wrap(
      <Profiler id="page" onRender={(_id, phase) => renders(phase)}>
        <ItemCard item={item()} perform={vi.fn()} />
      </Profiler>,
    );
    const deadline = () => screen.getByTestId('turn-deadline').textContent;
    expect(deadline()).toContain('30 m 0 s left');
    const before = renders.mock.calls.filter(([phase]) => phase === 'mount').length;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(deadline()).toContain('29 m 59 s left');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(deadline()).toContain('29 m 54 s left');
    // The Profiler wraps the whole card: a tick re-renders the clock's readers, which React
    // reports as nested updates — never a new mount, and never the card's own body again.
    expect(renders.mock.calls.filter(([phase]) => phase === 'mount').length).toBe(before);
    expect(screen.getByTestId('turn-timing').getAttribute('data-tick')).toBe(String(PAGE_CLOCK.fineMs));
  });

  it('the card itself does not re-render on a tick', () => {
    let bodies = 0;
    function Counting() {
      bodies += 1;
      return <TimingGrid timing={item().timing!} notYet={false} live />;
    }
    wrap(<Counting />);
    const first = bodies;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(bodies).toBe(first);
    expect(screen.getByTestId('turn-deadline').textContent).toContain('29 m 57 s left');
  });
});

describe('TG-4 overdue', () => {
  it('says how overdue, in the failed hue, beside a real meter', () => {
    wrap(
      <ItemCard
        item={item({
          timing: { assignedAt: '2026-10-13T09:00:00.000Z', deadline: '2026-10-13T11:00:00.000Z' },
        })}
        perform={vi.fn()}
      />,
    );
    const cell = screen.getByTestId('turn-deadline');
    const reading = cell.querySelector('[data-overdue="true"]')!;
    expect(reading.textContent).toBe('overdue by 1 h');
    expect(reading.className).toMatch(/\bstate-failed\b/);
    expect(within(cell).getByRole('meter').getAttribute('aria-valuetext')).toBe('past the deadline');
  });

  it('a settled item draws no countdown and no bar', () => {
    wrap(<ItemCard item={item({ personStatus: 'passed' })} perform={vi.fn()} />);
    expect(within(screen.getByTestId('turn-deadline')).queryByRole('meter')).toBeNull();
    expect(screen.getByTestId('turn-deadline').textContent).not.toMatch(/left|overdue/);
  });
});

describe('TG-5 the clock’s rule', () => {
  it('1 s while a grid is on screen, 30 s otherwise, nothing when nobody reads it', () => {
    const view = wrap(<TimingGrid timing={item().timing!} notYet={false} live />);
    expect(clockState().fine).toBe(1);
    expect(clockState().period).toBe(PAGE_CLOCK.fineMs);
    view.rerender(
      <QueryClientProvider client={new QueryClient(queryClientConfig)}>
        <MemoryRouterProvider initial="#/turn">
          <TimingGrid timing={{ assignedAt: '2026-10-13T09:00:00.000Z' }} notYet={false} live />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    expect(clockState().fine).toBe(0);
    expect(clockState().period).toBe(PAGE_CLOCK.coarseMs);
    view.unmount();
    expect(clockState().readers).toBe(0);
    expect(clockState().period).toBe(0);
  });

  it('never the 1 s tick under reduced motion — and figures say minutes', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      wrap(<TimingGrid timing={item().timing!} notYet={false} live />);
      expect(clockState().period).toBe(PAGE_CLOCK.coarseMs);
      expect(screen.getByTestId('turn-deadline').textContent).toContain('30 m left');
    } finally {
      window.matchMedia = original;
    }
  });

  it('a countdown says seconds only while seconds tick, and only under an hour', () => {
    expect(clockSpan(90_000, true)).toBe('1 m 30 s');
    expect(clockSpan(90_000, false)).toBe('2 m');
    expect(clockSpan(2 * 3_600_000, true)).toBe('2 h');
  });
});
