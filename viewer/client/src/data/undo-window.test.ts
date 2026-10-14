/**
 * The undo window (turn-by-turn phase 5): a terminal press is held on the page
 * for `UNDO_WINDOW_MS`, then sent once; undone, it is never sent.
 *
 *   UW-1 nothing is sent before the window ends;
 *   UW-2 it is sent exactly once after it;
 *   UW-3 undo inside the window sends nothing, ever;
 *   UW-4 undo after the send is a no-op;
 *   UW-5 send-now sends at once, and only once;
 *   UW-6 the hook holds one press per card, and a second press sends the first.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UNDO_WINDOW_MS, holdPress, useHeldPress } from './undo-window';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('holdPress', () => {
  it('the window is five seconds', () => {
    expect(UNDO_WINDOW_MS).toBe(5000);
  });

  it('UW-1 UW-2 nothing is sent before the window ends; it is sent once after', async () => {
    const send = vi.fn();
    const held = holdPress(send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    expect(held.state).toBe('held');
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(held.state).toBe('sent');
    await expect(held.settled).resolves.toBe('sent');
  });

  it('UW-3 undo inside the window sends nothing, ever', async () => {
    const send = vi.fn();
    const held = holdPress(send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 100);
    expect(held.undo()).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 10);
    held.sendNow();
    expect(send).not.toHaveBeenCalled();
    expect(held.state).toBe('undone');
    await expect(held.settled).resolves.toBe('undone');
  });

  it('UW-4 undo after the send is a no-op', () => {
    const send = vi.fn();
    const held = holdPress(send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(held.undo()).toBe(false);
    expect(held.state).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('UW-5 send-now sends at once, and the window’s end sends nothing more', () => {
    const send = vi.fn();
    const held = holdPress(send, { ms: 1000 });
    held.sendNow();
    held.sendNow();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs on the clock it is given', () => {
    const fires: (() => void)[] = [];
    const timers = { set: vi.fn((fire: () => void) => fires.push(fire)), clear: vi.fn() };
    const send = vi.fn();
    holdPress(send, { ms: 250, timers });
    expect(timers.set).toHaveBeenCalledWith(expect.any(Function), 250);
    fires[0]!();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('UW-6 useHeldPress', () => {
  it('holds one press, then drops its words once it is sent', async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useHeldPress());
    act(() => result.current.hold('Approve', send));
    expect(result.current.held).toEqual({ label: 'Approve', ms: UNDO_WINDOW_MS });
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.held).toBeNull();
  });

  it('undo drops the press and sends nothing', async () => {
    const send = vi.fn();
    const { result } = renderHook(() => useHeldPress());
    act(() => result.current.hold('Deny', send));
    await act(async () => {
      result.current.undo();
    });
    expect(result.current.held).toBeNull();
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it('a second press sends the first at once and holds itself', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useHeldPress());
    act(() => result.current.hold('Approve', first));
    act(() => result.current.hold('Deny', second));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(result.current.held?.label).toBe('Deny');
  });

  it('a card that leaves the page sends what it holds', () => {
    const send = vi.fn();
    const { result, unmount } = renderHook(() => useHeldPress());
    act(() => result.current.hold('Not doing this', send));
    unmount();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
