/**
 * The stream, shared: one connection per BROWSER (#236), and a run's partials
 * on request.
 *
 * A browser allows six connections per host over HTTP/1.1, and each tab used
 * to hold its own `/events` for as long as it lived — so a fourth tab left two
 * connections for every fetch of every tab, a slow `/api/runs` queued
 * unrelated clicks inside the browser, and a second tab looked like it broke
 * the first. Here ONE tab, the leader, holds the stream and relays every frame
 * and every status to the others on a `BroadcastChannel`; the others close
 * theirs.
 *
 * The leader is whoever holds a Web Lock, not whoever beats loudest. The
 * browser releases a lock the moment its tab goes — closed, crashed or
 * discarded — and grants it to the next tab waiting, which opens the stream
 * from the last event id any tab saw (`?last=`), so a hand-over costs no
 * events. A heartbeat would have to survive the timer throttling every
 * browser applies to a hidden tab, which is exactly the tab a leader usually
 * is.
 *
 * `run:stream` — a session's output as it is written — goes only to a
 * connection that asked for that run. A surface that renders a transcript
 * holds `useRunStream(runId)` while it is on screen; the tab holding the
 * stream asks the server for what every tab holds, through
 * `POST /api/events/subscribe` on the open connection, or — when the server
 * does not know the connection — by reopening with `?stream=`.
 *
 * A hidden tab's cache waits. Every tab hears every frame, so every tab
 * re-read the same lists on every event, and four tabs were four copies of
 * each `/api/runs`. A tab nobody can see now applies no effect at all; the
 * moment it is seen again it re-reads what it has on screen, once.
 *
 * Never on first paint: a tab opens its own stream at boot exactly as it
 * always did (`./live`), and the shell starts sharing once it has rendered
 * (`share()`); a tab that then finds a leader closes its own.
 */

import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { LivePort, SseEvent, SseStatus } from './live';

/** What one tab tells the others. */
type Frame =
  | { t: 'event'; name: SseEvent; data: unknown; id: string }
  | { t: 'status'; status: SseStatus }
  /** Every run one tab wants partials for — the whole set, every time. */
  | { t: 'want'; tab: string; runs: string[] }
  /** A tab that went: its wants go with it. */
  | { t: 'bye'; tab: string }
  /** A new leader asking every tab what it wants. */
  | { t: 'who' };

/** The channel and the lock share one name, as every tab of one console does. */
const SHARED = 'phase-console-events';
const tab = Math.random().toString(36).slice(2);

/**
 * `pending` until `share()` has looked; `solo` where the browser cannot elect
 * (no Web Locks, no `BroadcastChannel`) — the tab keeps its own stream, as
 * before; `follower` or `leader` once it has.
 */
let role: 'pending' | 'solo' | 'follower' | 'leader' = 'pending';
/** The stream this tab holds, handed over by `share()`. */
let live: LivePort | null = null;
let channel: BroadcastChannel | null = null;
/** Resolving it ends the leadership and releases the lock — the test seam's lever. */
let abdicate: (() => void) | null = null;
/** The runs the open stream carries partials for, as the server was last told. */
let carried = '';
/**
 * The runs the open stream's own address names. A stream the browser
 * reconnects by itself asks again at that address, so after a reconnect this,
 * not `carried`, is what the server holds.
 */
let opened = '';
/** Subscriptions go out one at a time, so the last one sent is the one the server holds. */
let posting: Promise<unknown> = Promise.resolve();
/** This tab's wants: run id → how many surfaces hold it. */
const wants = new Map<string, number>();
/** The leader's record of every other tab's wants. */
const others = new Map<string, string[]>();
/** The cache an effect skipped while this tab was hidden — read again once the tab is seen. */
let held: QueryClient | null = null;

function say(frame: Frame): void {
  try {
    channel?.postMessage(frame);
  } catch {
    /* a closed channel: this tab is going */
  }
}

/** Every run some tab wants, sorted, so two tabs asking alike ask once. */
function union(): string[] {
  const all = new Set(wants.keys());
  for (const runs of others.values()) for (const run of runs) all.add(run);
  return [...all].sort();
}

/**
 * The tab holding the stream asks the server for every run some tab wants:
 * on the open connection when the server knows it, else on a new stream that
 * names them — from the last id seen, so the swap loses nothing.
 */
function sync(): void {
  if (role !== 'solo' && role !== 'leader') return;
  const runs = union();
  const named = runs.join(',');
  if (named === carried) return;
  carried = named;
  const reopen = () => {
    opened = named;
    live!.openStream(runs);
  };
  const on = live!.connection();
  if (!on) {
    reopen();
    return;
  }
  posting = posting.then(() => live!.subscribe({ connection: on, streams: runs }).catch(reopen));
}

/** A stream greeted the server — first opened, or reconnected by the browser at its own address. */
function greeted(): void {
  carried = opened;
  sync();
}

/** Tell the leader what this tab wants now — or, holding the stream, the server. */
function announce(): void {
  if (role === 'follower') say({ t: 'want', tab, runs: [...wants.keys()] });
  else sync();
}

function onFrame(frame: Frame): void {
  if (frame.t === 'event') {
    if (role === 'follower') live!.deliver(frame.name, frame.data, frame.id);
  } else if (frame.t === 'status') {
    if (role === 'follower') live!.showStatus(frame.status);
  } else if (frame.t === 'who') {
    if (role === 'follower') announce();
  } else if (role === 'leader') {
    if (frame.t === 'want') {
      others.set(frame.tab, frame.runs);
      // A tab that just joined has not heard a status yet.
      say({ t: 'status', status: live!.getSseStatus() });
    } else {
      others.delete(frame.tab);
    }
    sync();
  }
}

/**
 * This tab leads now: relay what its stream hears, learn what every tab
 * wants, and hold the lock for as long as the tab lives. A tab that has led
 * from the start keeps the stream it opened at boot; one taking over from a
 * leader that went opens one, from the last id it heard relayed.
 */
function lead(holding: boolean): Promise<void> {
  role = 'leader';
  live!.link.relay = (name, data, id) => say({ t: 'event', name, data, id });
  live!.link.status = (status) => say({ t: 'status', status });
  if (holding) {
    sync();
  } else {
    const runs = union();
    carried = opened = runs.join(',');
    live!.openStream(runs);
  }
  say({ t: 'who' });
  return new Promise((resolve) => {
    abdicate = resolve;
  });
}

/** Another tab leads: close this tab's stream — its frames arrive relayed — and say what this tab wants. */
function follow(): void {
  role = 'follower';
  live!.openStream();
  announce();
}

/** While this tab is hidden its cache waits: the effect is skipped, and the cache remembered. */
function hold(client: QueryClient): boolean {
  if (!document.hidden) return false;
  held = client;
  return true;
}

/** Seen again: re-read what is on screen, once, for everything the tab let pass. */
function seen(): void {
  if (document.hidden || !held) return;
  void held.invalidateQueries();
  held = null;
}

/**
 * Share this tab's stream with the console's other tabs — or keep it, alone,
 * where the browser cannot elect. The shell calls it once it has rendered,
 * with the stream `./live` holds; once is all it does.
 */
export function share(port: LivePort): void {
  if (live) return;
  live = port;
  port.link.hello = greeted;
  port.link.hold = hold;
  document.addEventListener('visibilitychange', seen);
  port.connect();
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof BroadcastChannel !== 'function' || !locks) {
    role = 'solo';
    sync();
    return;
  }
  role = 'follower';
  channel = new BroadcastChannel(SHARED);
  channel.onmessage = (event: MessageEvent<Frame>) => onFrame(event.data);
  addEventListener('pagehide', () => {
    if (role === 'follower') say({ t: 'bye', tab });
  });
  addEventListener('pageshow', announce);
  locks
    .request(SHARED, { ifAvailable: true }, (lock) => {
      if (lock) return lead(true);
      follow();
      // Queue for the hand-over: granted the moment the leader's tab goes.
      locks.request(SHARED, () => lead(false)).catch(() => {});
      return undefined;
    })
    .catch(() => {});
}

/**
 * Hold one run's `run:stream` while a surface that renders it is on screen.
 * Counted, so two panes on one run let it go once, together. Before the shell
 * has shared its stream the want is only remembered: `share()` asks for it.
 */
export function acquireRunStream(runId: string): () => void {
  wants.set(runId, (wants.get(runId) ?? 0) + 1);
  announce();
  return () => {
    const held = (wants.get(runId) ?? 1) - 1;
    if (held > 0) wants.set(runId, held);
    else wants.delete(runId);
    announce();
  };
}

/** `run:stream` for one run while the calling component is mounted; nothing for no run. */
export function useRunStream(runId: string | null | undefined): void {
  useEffect(() => (runId ? acquireRunStream(runId) : undefined), [runId]);
}

/** Test seam only — the sharing half back to nothing, its lock released. */
export function __resetShareForTests(): void {
  channel?.close();
  abdicate?.();
  document.removeEventListener('visibilitychange', seen);
  held = null;
  channel = null;
  abdicate = null;
  live = null;
  carried = opened = '';
  posting = Promise.resolve();
  role = 'pending';
  wants.clear();
  others.clear();
}
