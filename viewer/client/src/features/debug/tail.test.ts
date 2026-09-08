/**
 * `useDebugTail` — the follow stream, driven.
 *
 * This file exists because the destination's own suite could not reach any of
 * it. jsdom has no `EventSource`, and `test-setup.ts`'s stand-in has a no-op
 * `addEventListener` — so every assertion about follow mode passed whether the
 * hook worked or not, and QA round 2 proved it: neutering the gap banner and
 * deleting the resume path both left 45 tests green.
 *
 * So the fake here is DRIVEABLE. The four properties it pins are the four the
 * hook actually promises: rows arrive newest-first, a repeat is dropped, a
 * frame that filled its cap is reported as a loss, and turning follow off
 * closes the stream.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DriveableEventSource, type Listener } from './driveable-event-source';
import { useDebugTail, TAIL_KEEP } from './tail';

const row = (at: string, event = 'phase.boarded') => ({
  source: 'journal' as const,
  at,
  level: 'info' as const,
  event,
  text: 'a line',
});

const real = globalThis.EventSource;

// Assignment, not `defineProperty`: `test-setup.ts` installs its own stand-in
// as writable-but-not-configurable, so redefining the property throws.
beforeEach(() => {
  DriveableEventSource.last = null;
  (globalThis as { EventSource: unknown }).EventSource = DriveableEventSource;
});

afterEach(() => {
  (globalThis as { EventSource: unknown }).EventSource = real;
});

describe('useDebugTail', () => {
  it('does not open a stream until follow is on', () => {
    const { result } = renderHook(() => useDebugTail({}, false));
    expect(DriveableEventSource.last).toBeNull();
    expect(result.current.status).toBe('off');
  });

  it('reports rows newest-first, whatever order the wire used', () => {
    // The wire is oldest-first because the client appends; the list is
    // newest-first because that is the index's order and the two are
    // concatenated on screen.
    const { result } = renderHook(() => useDebugTail({}, true));
    act(() => {
      DriveableEventSource.last!.open();
      DriveableEventSource.last!.emit('entries', {
        entries: [row('2026-09-01T10:00:00.000Z', 'first'), row('2026-09-01T10:00:01.000Z', 'second')],
        cursor: '2026-09-01T10:00:01.000Z',
      });
    });
    expect(result.current.entries.map((e) => e.event)).toEqual(['second', 'first']);
    expect(result.current.status).toBe('live');
  });

  it('drops a row it has already shown', () => {
    // An undated row rides every pass — it can never be ordered against a
    // cursor — so without this it would repeat every two seconds.
    const { result } = renderHook(() => useDebugTail({}, true));
    act(() => {
      DriveableEventSource.last!.emit('entries', { entries: [row('', 'outcome.unreadable')] });
      DriveableEventSource.last!.emit('entries', { entries: [row('', 'outcome.unreadable')] });
    });
    expect(result.current.entries).toHaveLength(1);
  });

  it('reports a loss only when a frame says it filled its cap', () => {
    // The first cut set this from the handshake and claimed rows were gone
    // that the next tick delivered. A full frame is the only loss a tail
    // actually has.
    const { result } = renderHook(() => useDebugTail({}, true));
    act(() => {
      DriveableEventSource.last!.emit('entries', {
        entries: [row('2026-09-01T10:00:00.000Z')],
        capped: false,
      });
    });
    expect(result.current.behind).toBe(false);

    act(() => {
      DriveableEventSource.last!.emit('entries', {
        entries: [row('2026-09-01T10:00:02.000Z')],
        capped: true,
      });
    });
    expect(result.current.behind).toBe(true);
  });

  it('keeps a bounded window, not an archive', () => {
    const { result } = renderHook(() => useDebugTail({}, true));
    act(() => {
      for (let i = 0; i < TAIL_KEEP + 20; i += 1) {
        DriveableEventSource.last!.emit('entries', {
          entries: [row(new Date(Date.parse('2026-09-01T10:00:00.000Z') + i * 1000).toISOString(), `e${i}`)],
        });
      }
    });
    expect(result.current.entries).toHaveLength(TAIL_KEEP);
    // Newest kept, oldest cut.
    expect(result.current.entries[0].event).toBe(`e${TAIL_KEEP + 19}`);
  });

  it('survives a frame it cannot parse', () => {
    const { result } = renderHook(() => useDebugTail({}, true));
    act(() => {
      const stream = DriveableEventSource.last!;
      // Bypass `emit`'s JSON.stringify to deliver something unparseable.
      stream.addEventListener('entries', () => {});
      for (const fn of (stream as unknown as { listeners: Map<string, Set<Listener>> }).listeners.get(
        'entries',
      ) ?? []) {
        fn({ data: 'not json' } as MessageEvent);
      }
    });
    expect(result.current.entries).toHaveLength(0);
  });

  it('closes the stream when follow goes off', () => {
    const { rerender } = renderHook(({ on }) => useDebugTail({}, on), {
      initialProps: { on: true },
    });
    const stream = DriveableEventSource.last!;
    expect(stream.closed).toBe(false);
    rerender({ on: false });
    expect(stream.closed).toBe(true);
  });

  it('reopens on a changed query rather than reusing a stream with the old filter', () => {
    const { rerender } = renderHook(({ source }) => useDebugTail({ source }, true), {
      initialProps: { source: ['console'] as ('console' | 'journal')[] },
    });
    const first = DriveableEventSource.last!;
    rerender({ source: ['journal'] });
    expect(first.closed).toBe(true);
    expect(DriveableEventSource.last).not.toBe(first);
    expect(DriveableEventSource.last!.url).toContain('source=journal');
  });
});
