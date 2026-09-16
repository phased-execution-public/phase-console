/**
 * Follow mode — the log explorer's live tail.
 *
 * Its own `EventSource` against `/api/debug/tail`, rather than a name on the
 * shared `/events` stream, for two reasons that are really one: a tail is
 * per-QUERY (two tabs following different sources are two subscriptions), and
 * it must stop costing anything the moment the reader turns it off. A named
 * event on the shared stream would be neither — every tab would pay for every
 * other tab's filter, forever.
 *
 * Reconnection is the browser's own, exactly as `lib/sse.ts` says: a
 * hand-rolled retry loop reconnects on the cases the platform already handles
 * and misses the ones it does not.
 */

import { useEffect, useRef, useState } from 'react';

import { debugIndexPath, type DebugEntry, type DebugIndexParams } from '@/lib/api';
import { consolePath } from '@/lib/base';

/**
 * How many followed rows are kept.
 *
 * A tail is a window, not an archive — the archive is the index read under it,
 * and the endpoint that answers "everything since 14:02" is a `?since=`, not a
 * browser tab left open overnight. Unbounded, a busy lane's journal would grow
 * this array until the page stopped painting.
 */
export const TAIL_KEEP = 400;

export type TailState = {
  /** Newest first, matching the index's order so the two can be concatenated. */
  entries: DebugEntry[];
  status: 'off' | 'connecting' | 'live' | 'error';
  /**
   * A frame arrived FULL, which means rows between it and the previous one
   * were dropped.
   *
   * This is the only loss a tail actually has, and getting there took two
   * tries. The first cut set this from the handshake — "you reconnected and
   * the log has moved past your cursor" — and drew a banner saying the rows
   * were gone. They were not: the server reads `since: cursor` on the next
   * tick, so a reconnect bridges its own gap. Announcing a loss that did not
   * happen is the same defect as absorbing one that did, pointed the other
   * way. So the claim is measured at the frame that could not fit.
   */
  behind: boolean;
};

/**
 * Follow a filtered tail.
 *
 * The subscription is keyed on the SERIALISED path rather than on the params
 * object: a new object with the same contents on every render would tear the
 * stream down and rebuild it on every keystroke in the search box.
 */
export function useDebugTail(params: DebugIndexParams, enabled: boolean): TailState {
  const path = debugIndexPath('/api/debug/tail', params);
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [status, setStatus] = useState<TailState['status']>('off');
  const [behind, setBehind] = useState(false);
  // Cleared through a ref rather than in the effect body, so turning follow
  // off leaves the rows on screen until the next connection replaces them —
  // a reader who pauses a tail is reading what it last showed them.
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
    const onError = () => {
      // `EventSource` reconnects by itself; `CLOSED` is the terminal state and
      // the only one worth reporting as an error rather than as a blip.
      setStatus(stream.readyState === EventSource.CLOSED ? 'error' : 'connecting');
    };
    const onEntries = (event: MessageEvent) => {
      let payload: { entries?: DebugEntry[]; capped?: boolean };
      try {
        payload = JSON.parse(event.data) as { entries?: DebugEntry[]; capped?: boolean };
      } catch {
        return;
      }
      // A full frame is a dropped gap — the one loss this stream really has.
      // Deliberately STICKY for the session (round-3 ruling): the rows a full
      // frame lost never arrive, so the window on screen keeps its hole until
      // the page reloads, and a banner that cleared on the next quiet frame
      // would claim the hole had closed. The explorer holds the full record.
      if (payload.capped) setBehind(true);
      const fresh = (payload.entries ?? []).filter((entry) => {
        // The server sends only rows newer than its cursor, and an UNDATED row
        // rides every pass because it can never be ordered against one — so
        // de-duplicating here is what keeps `outcome.unreadable` visible
        // without repeating it every two seconds.
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
