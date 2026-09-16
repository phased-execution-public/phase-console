/**
 * One connection, many listeners.
 *
 * Every view that wanted live data used to open its own `EventSource`. A browser
 * allows about six connections per host over HTTP/1.1, and the shell, the
 * dashboard, the runs page and a plan's autopilot tab together held most of them
 * open forever — so the *fetches* those same views depend on queued behind
 * connections that never finish. The symptom is precise and misleading: the page
 * looks alive, and nothing updates until you reload.
 *
 * So there is exactly one stream and it is shared, it is opened once and never
 * closed, and **reconnection is the browser's own**. An `EventSource` retries on
 * its own schedule and resends `Last-Event-ID`; the server replays from there
 * (`server/api/routes.ts`). A hand-rolled retry loop on top of that is not extra
 * safety, it is a second reconnect racing the first.
 */

import { useSyncExternalStore } from 'react';
import { consolePath } from './base';

/**
 * Every event name the server emits, as it appears on the wire.
 *
 * Run events are `run:`-prefixed by the runner itself
 * (`server/runner/runner.ts` → `onEvent('run:' + event, …)`), which is why the
 * client listens for `run:phase` and not `phase`. `run:state` is the one the
 * *service* emits directly, when a stop/skip/retry/pause lands on a run no loop
 * is driving. `hello` is the un-replayed handshake frame and is not in this list
 * — nothing invalidates on it.
 */
export const SSE_EVENTS = [
  'changed',
  'warm',
  'health',
  'approval',
  'approval:resolved',
  'notification',
  'notification:delivery',
  'notification:read',
  'notification:cleared',
  // Terminal and agent sessions. Deliberately added after the fact: the socket
  // is a session's own live channel, but the dashboard list and the nav badges
  // are not holding it, and they were the surfaces that could not know.
  'sessions',
  'run:run',
  'run:phase',
  'run:stream',
  'run:journal',
  'run:verify',
  'run:state',
  // Admission moved: something was granted a scope, queued behind one, or
  // released. Its own event because it changes what the console may START,
  // which no other event describes — a phase can sit queued for minutes while
  // nothing about any run's own state changes at all.
  'run:queue',
  // The convergence loop finished a pass on a plan: the flattened report rides
  // the event (`server/converge.ts` `convergeView`) — what it re-boarded,
  // released, healed or left as an errand — so the Pulse's convergence line
  // is a cache write, never a refetch.
  'run:converge',
  // The Claude account registry or its usage meters moved — an account was
  // added or signed in, a poll landed, a window was learned exhausted. The
  // full redacted list rides on the event.
  'accounts',
  // The MCP registry or its health moved — a server was added, switched off,
  // signed in, or answered a probe differently. The full redacted list rides on
  // the event, exactly as `accounts` does, so this is a cache write and not a
  // reason to go and ask again.
  'mcp',
  // The unified WORK inbox moved: an errand was raised or acknowledged, an
  // approval landed, a gate opened. Declared in Phase 3, ahead of the server
  // that emits it (Phase 4) — an event nothing sends is inert, where a surface
  // built against an event nobody declared is a screen that silently stops
  // updating. `EVENT_EFFECTS` already gives it somewhere to land.
  'inbox',
  // A lane's liveness answer changed — it went silent, started spinning, hit a
  // stalemate, or came back. Only TRANSITIONS are emitted (`runner.ts`
  // `evaluateLane` returns early when the answer has not moved), so this is
  // news by construction rather than a per-minute heartbeat. The Run page
  // renders it; the shell hears about it anyway because a stall also raises an
  // inbox row.
  'run:liveness',
  // The silent-session watchdog acted on a lane: nudged it, recycled it, or
  // parked the phase after both. Separate from `run:liveness` because that one
  // says what the lane IS and this one says what the console DID about it —
  // and because a nudge moves no status at all, so nothing else fires for it.
  'run:watchdog',
  // The run's git situation moved: its branch gained or lost commits, a
  // checkout appeared or went, or the branch radar changed its verdict about a
  // pair. Its own event because none of that is visible in any other one — two
  // isolated runs on one repository can diverge for an hour while every phase
  // event says the same thing, and the moment worth telling somebody about
  // (`clean → overlap`) happens between phases rather than at one.
  //
  // The whole view rides on the event, so a page is a cache write. The runner
  // emits only when the answer CHANGED, which is what makes that affordable: a
  // five-minute probe that fired regardless would be a refetch of every run on
  // a timer, dressed up as a stream.
  'run:git',
  // A ruling landed in the plan's ledger — a session recorded a judgement call
  // the plan did not make for it. Its own event because nothing else moves
  // when one is written: no phase changes state, no run advances, and the
  // ledger outlives every run of the plan.
  'run:rulings',
  // A plan's structural lint finished. `/api/plans/<slug>` no longer awaits it:
  // `validate.sh` walks every handoff, and on the 22-handoff plan somebody was
  // actually working on that was 11.27 s the page paid before it could paint a
  // table the lint does not appear in. The RESULT rides this event and is
  // written straight into the plan's cache, so it is a push and never a reason
  // to go and ask again.
  'plan:lint',
] as const;

export type SseEvent = (typeof SSE_EVENTS)[number];
export type SseStatus = 'connecting' | 'live' | 'offline';
export type SseListener = (data: unknown, name: SseEvent) => void;

const listeners = new Map<string, Set<SseListener>>();
const statusListeners = new Set<() => void>();

let source: EventSource | null = null;
let status: SseStatus = 'connecting';

function setStatus(next: SseStatus): void {
  if (status === next) return;
  status = next;
  for (const notify of statusListeners) notify();
}

function fanOut(name: SseEvent, data: unknown): void {
  for (const fn of listeners.get(name) ?? []) {
    // One bad listener must not stop the rest, and must not take the stream
    // down with it — this callback is on the socket's own path.
    try {
      fn(data, name);
    } catch {
      /* ignore */
    }
  }
}

/** Open the shared stream. Idempotent; safe to call from any subscriber. */
export function connect(): void {
  if (source || typeof EventSource === 'undefined') return;
  const stream = new EventSource(consolePath('/events'));
  source = stream;

  stream.onopen = () => setStatus('live');
  stream.onerror = () => {
    // `CLOSED` means the browser has given up (the server said something final).
    // Anything else is its own retry in flight — the honest word for that is
    // "connecting", not "error", and there is nothing for us to do about it.
    setStatus(stream.readyState === stream.CLOSED ? 'offline' : 'connecting');
  };

  for (const name of SSE_EVENTS) {
    stream.addEventListener(name, (event) => {
      let data: unknown = null;
      try {
        data = JSON.parse((event as MessageEvent).data);
      } catch {
        /* keep null */
      }
      // Any named frame arriving proves the pipe is up, even if `onopen` was
      // missed across a background tab throttle.
      setStatus('live');
      fanOut(name, data);
    });
  }
}

/** Subscribe to one event name. Returns the unsubscribe. */
export function onSse(name: SseEvent, fn: SseListener): () => void {
  connect();
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    // The stream stays open with no listeners: closing and reopening it as
    // views mount costs a reconnect each time and buys nothing.
  };
}

/** Subscribe to several at once. */
export function onSseAll(names: readonly SseEvent[], fn: SseListener): () => void {
  const offs = names.map((name) => onSse(name, fn));
  return () => {
    for (const off of offs) off();
  };
}

export function getSseStatus(): SseStatus {
  return status;
}

/** The shell's "reconnecting" slot reads this. */
export function useSseStatus(): SseStatus {
  return useSyncExternalStore(
    (notify) => {
      connect();
      statusListeners.add(notify);
      return () => {
        statusListeners.delete(notify);
      };
    },
    () => status,
    () => 'connecting' as const,
  );
}

/** Test seam only — drops the singleton so a case can start from nothing. */
export function __resetStreamForTests(): void {
  source?.close();
  source = null;
  listeners.clear();
  statusListeners.clear();
  status = 'connecting';
}
