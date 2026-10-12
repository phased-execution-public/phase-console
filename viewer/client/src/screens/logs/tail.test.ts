/**
 * `useLogTail` — the follow stream, driven.
 *
 * jsdom has no `EventSource`, and `test-setup.ts`'s stand-in has a no-op
 * `addEventListener` — so an assertion about follow made through it passes
 * whether the hook works or not. 6.x's QA round 2 proved it: neutering the gap
 * banner and deleting the resume path both left the suite green.
 *
 * So the fake here is DRIVEABLE (`driveable-event-source.ts`, the one the page
 * test drives too). What it pins is what the hook promises: the stream opens on
 * the index's own filters and only while follow is on; rows arrive newest
 * first; a repeat is dropped; a frame that filled its cap is reported as a
 * loss, and nothing else is; the window is bounded; the status says connecting
 * until the stream opens and an error only once the browser has given up; a
 * paused tail keeps its rows; and a changed query is a new stream, started
 * clean.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DebugIndexParams } from '@/data/api';
import { DriveableEventSource, type Listener } from './driveable-event-source';
import { TAIL_KEEP, useLogTail } from './tail';

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
  globalThis.EventSource = DriveableEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  globalThis.EventSource = real;
});

/** The stream the hook opened last. */
const stream = (): DriveableEventSource => {
  const last = DriveableEventSource.last;
  if (!last) throw new Error('the hook opened no stream');
  return last;
};

describe('useLogTail', () => {
  it('does not open a stream until follow is on', () => {
    const { result } = renderHook(() => useLogTail({}, false));
    expect(DriveableEventSource.last).toBeNull();
    expect(result.current.status).toBe('off');
  });

  it('opens on the tail with the index’s own filters, so it follows exactly what the page shows', () => {
    renderHook(() => useLogTail({ source: ['journal', 'console'], level: ['error'], q: 'boom' }, true));
    expect(stream().url).toBe('/api/debug/tail?source=journal&source=console&level=error&q=boom');
  });

  it('reports rows newest-first, whatever order the wire used', () => {
    // The wire is oldest-first because the server appends; the list is
    // newest-first because that is the index's order and the two are drawn
    // one above the other.
    const { result } = renderHook(() => useLogTail({}, true));
    act(() => {
      stream().open();
      stream().emit('entries', {
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
    const { result } = renderHook(() => useLogTail({}, true));
    act(() => {
      stream().emit('entries', { entries: [row('', 'outcome.unreadable')] });
      stream().emit('entries', { entries: [row('', 'outcome.unreadable')] });
    });
    expect(result.current.entries).toHaveLength(1);
  });

  it('reports a loss only when a frame says it filled its cap, and keeps saying so', () => {
    // A reconnect is not a loss — the server reads from its cursor on the next
    // tick — so a full frame is the only loss a tail actually has, and the
    // rows it lost never arrive: the flag stays for the life of the stream.
    const { result } = renderHook(() => useLogTail({}, true));
    act(() => {
      stream().emit('entries', { entries: [row('2026-09-01T10:00:00.000Z')], capped: false });
    });
    expect(result.current.behind).toBe(false);

    act(() => {
      stream().emit('entries', { entries: [row('2026-09-01T10:00:02.000Z')], capped: true });
    });
    expect(result.current.behind).toBe(true);

    act(() => {
      stream().emit('entries', { entries: [row('2026-09-01T10:00:03.000Z')], capped: false });
    });
    expect(result.current.behind).toBe(true);
  });

  it('keeps a bounded window, not an archive', () => {
    const { result } = renderHook(() => useLogTail({}, true));
    act(() => {
      for (let i = 0; i < TAIL_KEEP + 20; i += 1) {
        stream().emit('entries', {
          entries: [row(new Date(Date.parse('2026-09-01T10:00:00.000Z') + i * 1000).toISOString(), `e${i}`)],
        });
      }
    });
    expect(result.current.entries).toHaveLength(TAIL_KEEP);
    // Newest kept, oldest cut.
    expect(result.current.entries[0]!.event).toBe(`e${TAIL_KEEP + 19}`);
  });

  it('survives a frame it cannot parse', () => {
    const { result } = renderHook(() => useLogTail({}, true));
    act(() => {
      // Past `emit`'s JSON.stringify, to deliver something unparseable.
      const listeners = (stream() as unknown as { listeners: Map<string, Set<Listener>> }).listeners;
      for (const fn of listeners.get('entries') ?? []) fn({ data: 'not json' } as MessageEvent);
    });
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.status).toBe('connecting');
  });

  it('says connecting until the stream opens, and an error only once the browser has given up', () => {
    const { result } = renderHook(() => useLogTail({}, true));
    expect(result.current.status).toBe('connecting');

    act(() => stream().open());
    expect(result.current.status).toBe('live');

    // An error on a stream the browser is still holding is its own reconnect.
    act(() => stream().emit('error', {}));
    expect(result.current.status).toBe('connecting');

    // CLOSED is the terminal state, and the only one worth calling an error.
    act(() => {
      stream().readyState = DriveableEventSource.CLOSED;
      stream().emit('error', {});
    });
    expect(result.current.status).toBe('error');
  });

  it('closes the stream when follow goes off, and keeps the rows it showed', () => {
    // A reader who pauses a tail is reading it.
    const { result, rerender } = renderHook(({ on }) => useLogTail({}, on), {
      initialProps: { on: true },
    });
    const first = stream();
    act(() => first.emit('entries', { entries: [row('2026-09-01T10:00:00.000Z', 'kept')] }));
    expect(first.closed).toBe(false);

    rerender({ on: false });
    expect(first.closed).toBe(true);
    expect(result.current.status).toBe('off');
    expect(result.current.entries.map((e) => e.event)).toEqual(['kept']);

    // Following again is a new stream, started clean.
    rerender({ on: true });
    expect(stream()).not.toBe(first);
    expect(result.current.entries).toEqual([]);
    expect(result.current.status).toBe('connecting');
  });

  it('reopens on a changed query rather than reusing a stream with the old filter', () => {
    const { result, rerender } = renderHook(({ source }) => useLogTail({ source }, true), {
      initialProps: { source: ['console'] as NonNullable<DebugIndexParams['source']> },
    });
    const first = stream();
    act(() => first.emit('entries', { entries: [row('2026-09-01T10:00:00.000Z')], capped: true }));
    expect(result.current.behind).toBe(true);

    rerender({ source: ['journal'] });
    expect(first.closed).toBe(true);
    expect(stream()).not.toBe(first);
    expect(stream().url).toBe('/api/debug/tail?source=journal');
    // The old filter's rows, and its loss, are not the new stream's.
    expect(result.current.entries).toEqual([]);
    expect(result.current.behind).toBe(false);
  });

  it('keeps one stream across renders with an equal query', () => {
    // Keyed on the serialised path, not the params object: a new object with
    // the same contents on every render must not rebuild the stream.
    const { rerender } = renderHook(({ q }) => useLogTail({ q }, true), { initialProps: { q: 'boom' } });
    const first = stream();
    rerender({ q: 'boom' });
    expect(stream()).toBe(first);
    expect(first.closed).toBe(false);
  });
});
