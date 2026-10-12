/**
 * Follow — the log explorer's live tail, and the one `EventSource` outside
 * `data/live.ts` (the ESLint rule names this file as its exception).
 *
 * Its own stream against `/api/debug/tail` rather than a name on the shared
 * `/events` stream, for two reasons that are really one: a tail is per-QUERY
 * (two tabs following different sources are two subscriptions), and it must
 * stop costing anything the moment the reader turns it off. A named event on
 * the shared stream would be neither — every tab would pay for every other
 * tab's filter, for as long as it stayed open.
 *
 * Reconnection is the browser's own: a hand-rolled retry loop reconnects on
 * the cases the platform already handles and misses the ones it does not.
 */

import { useEffect, useRef, useState } from 'react';
import { debugTailPath, type DebugEntry, type DebugIndexParams } from '@/data/api';
import { consolePath } from '@/lib/base';

/**
 * How many followed rows are kept. A tail is a window, not an archive — the
 * archive is the index read under it, and "everything since 14:02" is a
 * `?since=`, not a tab left open overnight. Unbounded, a busy lane's journal
 * would grow this until the page stopped painting.
 */
export const TAIL_KEEP = 400;

export type TailStatus = 'off' | 'connecting' | 'live' | 'error';

export interface TailState {
  /** Newest first, the index's order, so the two can be put one above the other. */
  entries: DebugEntry[];
  status: TailStatus;
  /**
   * A frame arrived FULL, so rows between it and the one before were dropped —
   * the one loss a tail really has. A reconnect is not one: the server reads
   * from its cursor on the next tick, so a reconnect bridges its own gap, and
   * saying otherwise would announce a loss that did not happen. Sticky for the
   * life of the stream, because the rows a full frame lost never arrive.
   */
  behind: boolean;
}

/**
 * Follow a filtered tail. Keyed on the SERIALISED path, not the params object:
 * a new object with the same contents on every render would tear the stream
 * down and rebuild it on every keystroke.
 */
export function useLogTail(params: DebugIndexParams, enabled: boolean): TailState {
  const path = debugTailPath(params);
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [status, setStatus] = useState<TailStatus>('off');
  const [behind, setBehind] = useState(false);
  // Cleared when a stream opens rather than when it closes, so turning Follow
  // off leaves the rows on screen: a reader who pauses a tail is reading it.
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      setBehind(false);
      return undefined;
    }

    setStatus('connecting');
    setBehind(false);
    seen.current = new Set();
    setEntries([]);

    let stream: EventSource;
    try {
      stream = new EventSource(consolePath(path));
    } catch {
      setStatus('error');
      return undefined;
    }

    const onOpen = () => setStatus('live');
    // `CLOSED` is the terminal state and the only one worth calling an error;
    // anything else is the browser reconnecting by itself.
    const onError = () => setStatus(stream.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    const onEntries = (event: MessageEvent) => {
      let payload: { entries?: DebugEntry[]; capped?: boolean };
      try {
        payload = JSON.parse(event.data) as { entries?: DebugEntry[]; capped?: boolean };
      } catch {
        return;
      }
      if (payload.capped) setBehind(true);
      const fresh = (payload.entries ?? []).filter((entry) => {
        // The server sends only rows newer than its cursor, and an UNDATED row
        // rides every pass because it can never be ordered against one — so
        // the de-duplication is what keeps it visible without repeating it.
        const key = `${entry.at}|${entry.source}|${entry.event}|${entry.text}`;
        if (seen.current.has(key)) return false;
        seen.current.add(key);
        return true;
      });
      if (!fresh.length) return;
      setStatus('live');
      // The wire is oldest-first; the list is newest-first.
      setEntries((prev) => [...fresh.reverse(), ...prev].slice(0, TAIL_KEEP));
    };

    stream.addEventListener('open', onOpen);
    stream.addEventListener('error', onError);
    stream.addEventListener('entries', onEntries as EventListener);

    return () => {
      stream.removeEventListener('open', onOpen);
      stream.removeEventListener('error', onError);
      stream.removeEventListener('entries', onEntries as EventListener);
      stream.close();
    };
  }, [path, enabled]);

  return { entries, status, behind };
}
