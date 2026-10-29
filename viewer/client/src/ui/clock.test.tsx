/**
 * The one page clock (measured-console phase 32): `lib/clock.ts` folded into
 * `ui/clock.ts`, so every figure that tells the time reads one store.
 *
 *   OC-1 any number of figures, at any cadence, run ONE interval — at the
 *        finest cadence any of them asks for — and none when nothing reads;
 *   OC-2 a figure on a coarse cadence is not re-rendered by a fine one beside
 *        it, and two figures on one cadence move on the same tick;
 *   OC-3 an inactive figure holds still, and re-reads when it starts;
 *   OC-4 `useWindowLeft` counts a relayed question's window down by the second.
 */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PAGE_CLOCK, clockState, useNow, usePageNow, useWindowLeft } from './clock';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

function Figure({
  label,
  active = true,
  every,
  onRender,
}: {
  label: string;
  active?: boolean;
  every?: number;
  onRender?: () => void;
}) {
  onRender?.();
  const now = useNow(active, every);
  return <span data-testid={label}>{now}</span>;
}

function PageFigure({ onRender }: { onRender: () => void }) {
  onRender();
  return <span data-testid="page">{usePageNow()}</span>;
}

function Window({ expiresAt }: { expiresAt: string }) {
  return <span data-testid="window">{useWindowLeft(expiresAt)}</span>;
}

describe('the one page clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('OC-1 runs one interval at the finest cadence asked for, and none when nothing reads', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const view = render(
      <>
        <Figure label="a" every={1000} />
        <Figure label="b" every={1000} />
        <Figure label="c" every={30_000} />
        <PageFigure onRender={() => undefined} />
      </>,
    );
    expect(clockState().readers).toBe(4);
    expect(clockState().period).toBe(PAGE_CLOCK.fineMs);
    const armed = spy.mock.calls.filter(([, ms]) => ms === PAGE_CLOCK.fineMs).length;
    expect(armed).toBe(1);
    view.unmount();
    expect(clockState()).toEqual({ readers: 0, fine: 0, period: 0 });
    spy.mockRestore();
  });

  it('OC-2 a coarse figure is not re-rendered by a fine one, and one cadence moves on one tick', () => {
    let coarse = 0;
    const view = render(
      <>
        <Figure label="a" every={1000} />
        <Figure label="b" every={1000} />
        <PageFigure onRender={() => (coarse += 1)} />
      </>,
    );
    const before = coarse;
    act(() => vi.advanceTimersByTime(5000));
    expect(coarse).toBe(before);
    expect(view.getByTestId('a').textContent).toBe(view.getByTestId('b').textContent);
    expect(Number(view.getByTestId('a').textContent)).toBe(NOW + 5000);
    act(() => vi.advanceTimersByTime(PAGE_CLOCK.coarseMs));
    expect(coarse).toBeGreaterThan(before);
    view.unmount();
  });

  it('OC-3 an inactive figure holds still, and re-reads when it starts', () => {
    const view = render(<Figure label="a" active={false} />);
    expect(clockState().readers).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(Number(view.getByTestId('a').textContent)).toBe(NOW);
    view.rerender(<Figure label="a" active />);
    expect(Number(view.getByTestId('a').textContent)).toBe(NOW + 60_000);
    view.unmount();
  });

  it('OC-4 a window counts down by the second', () => {
    const view = render(<Window expiresAt={new Date(NOW + 10_000).toISOString()} />);
    expect(view.getByTestId('window').textContent).toBe('10');
    act(() => vi.advanceTimersByTime(3000));
    expect(view.getByTestId('window').textContent).toBe('7');
    view.unmount();
  });
});
