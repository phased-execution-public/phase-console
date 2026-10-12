/**
 * The one stream: what changed, pushed by the server, applied to the cache.
 *
 * TanStack Query is *what is true*; the stream is *when it changed*. This file
 * holds the connection a tab listens on and `EVENT_EFFECTS`, the one table of
 * what each event does to the cache. Sharing the connection between the tabs
 * of a browser, and asking for a run's partials, is `./live-share` — fetched
 * after first paint rather than carried on it.
 *
 * Reconnection inside a tab is the browser's own: an `EventSource` retries on
 * its schedule and resends `Last-Event-ID`, and the server replays from there.
 * A retry loop on top of that would be a second reconnect racing the first.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { consolePath } from '@/lib/base';
import type {
  AccountsState,
  ConsoleState,
  ConvergeStatusView,
  ConvergeView,
  HumanStepRecord,
  HumanStepsList,
  McpState,
  PhaseRecord,
  PlanDetail,
  RunDetail,
  RunState,
  SessionRegistryView,
  TerminalState,
} from './api';
import { post } from './http';
import { keys } from './keys';

/**
 * Every event name the server emits, as it appears on the wire.
 *
 * Run events are `run:`-prefixed by the runner itself
 * (`server/runner/runner.ts` → `onEvent('run:' + event, …)`), which is why the
 * client listens for `run:phase` and not `phase`. `run:state` is the one the
 * *service* emits directly, when a stop/skip/retry/pause lands on a run no loop
 * is driving. `hello` is the un-replayed handshake frame and is not in this list
 * — nothing invalidates on it; it names the connection a subscription is for.
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
  // The REPOSITORY's conflict radar moved (phase 7) — a pair's verdict
  // changed, or a pair touching a clash zone appeared or went. Deliberately
  // not `run:*`: the radar's unit is the repository, and one transition is
  // news to every run in it. Transitions only, so a quiet repository is
  // silent on the wire.
  'repo:radar',
  // A person's turn moved (control-tower phase 42): a step was declared,
  // opened, checked, proven or settled. The step, as it now reads, rides the
  // event, so the card's status line and the strip's summons are a cache
  // write — a proof landing on the phone moves the desk's strip in the tick.
  'human-step',
  // A round of the console's own clock changed Your turn (control-tower phase
  // 136): something came due, was proven, expired, was withdrawn or escalated.
  // The round's counter rides the event; the turn and the inbox are read again.
  'turn',
  // A plan's structural lint finished. `/api/plans/<slug>` no longer awaits it:
  // `validate.sh` walks every handoff, and on the 22-handoff plan somebody was
  // actually working on that was 11.27 s the page paid before it could paint a
  // table the lint does not appear in. The RESULT rides this event and is
  // written straight into the plan's cache, so it is a push and never a reason
  // to go and ask again.
  'plan:lint',
  // A live lane moved, at most once every three seconds and only when what a
  // surface renders actually changed. The firehose (`run:stream`) deliberately
  // invalidates nothing, and the events that DO invalidate fire at phase
  // boundaries — twenty to seventy minutes apart on a real plan — so every
  // cache-backed surface was correct at boot and then again an hour later.
  // This is the one event between those boundaries, and it is applied as a
  // PATCH: it carries what it changes, so it costs no round trip at all.
  'run:progress',
  // A restart's update moved (2026-09-18): it began, it answered, the restart
  // followed or did not. Every tab's Restart card and banner hear it, not only
  // the one whose button was pressed.
  'restart',
  // A phase's review verdict moved — given, changed, or cleared by a reopen.
  // The plan's review section and the board it holds read it again.
  'review',
  // A plan's landing packet was written: its landing section reads it again.
  'landing',
  // A plan's stored triggers moved — armed, fired, expired or cancelled.
  'run:triggers',
  // A run spent a budget: the runner has parked it, and the event says which cap.
  'run:budget',
] as const;

export type SseEvent = (typeof SSE_EVENTS)[number];
export type SseStatus = 'connecting' | 'live' | 'offline';
export type SseListener = (data: unknown, name: SseEvent) => void;

const listeners = new Map<string, Set<SseListener>>();
const statusListeners = new Set<() => void>();

let started = false;
let source: EventSource | null = null;
let status: SseStatus = 'connecting';
/** The newest event id this tab has seen, its own or relayed — where a reopen resumes. */
let lastId = '';
/**
 * The server's name for the open stream, from its `hello` — what a
 * subscription is addressed to. None from a server too old to name one.
 */
let connection: string | undefined;

/**
 * What the sharing half, `./live-share`, hangs on this one: the leader passes
 * each frame and each status on to the other tabs, and hears the name of each
 * stream it opens. Empty until it loads.
 */
export const link: {
  relay?: (name: SseEvent, data: unknown, id: string) => void;
  status?: (status: SseStatus) => void;
  hello?: () => void;
  /** True while this tab is hidden: its cache waits, and is read again when the tab is seen. */
  hold?: (client: QueryClient) => boolean;
} = {};

/** Move the status this tab shows — its own stream's, or the leader's, relayed. */
export function showStatus(next: SseStatus): void {
  if (status === next) return;
  status = next;
  for (const notify of statusListeners) notify();
  link.status?.(next);
}

/**
 * A frame arriving — on this tab's stream, or relayed from the leader's. Any
 * named frame proves the pipe is up, even if `onopen` was missed across a
 * background tab's throttle. The id kept is the HIGHEST seen: a run's partials
 * are held up to a quarter second per lane, so one can arrive after a later
 * event, and a reopen from an id that went backwards replays what the page has.
 */
export function deliver(name: SseEvent, data: unknown, id: string): void {
  if (+id > +lastId) lastId = id;
  showStatus('live');
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

/**
 * Open — or reopen — the stream this tab holds, carrying `runs`' partials and
 * resuming from the last id seen; with nothing, close it (a tab that follows
 * the leader holds none).
 */
export function openStream(runs?: readonly string[]): void {
  source?.close();
  source = null;
  connection = undefined;
  if (!runs) return;
  // Run ids and event ids are URL-safe as they stand: hex, dashes and digits.
  const stream = new EventSource(
    consolePath(runs.length || lastId ? `/events?stream=${runs.join()}&last=${lastId}` : '/events'),
  );
  source = stream;

  stream.onopen = () => showStatus('live');
  stream.onerror = () => {
    // `CLOSED` means the browser has given up (the server said something final).
    // Anything else is its own retry in flight — the honest word for that is
    // "connecting", not "error", and there is nothing for us to do about it.
    showStatus(stream.readyState === stream.CLOSED ? 'offline' : 'connecting');
  };
  stream.addEventListener('hello', (event) => {
    connection = (JSON.parse((event as MessageEvent).data) as { connection?: string }).connection;
    link.hello?.();
  });
  for (const name of SSE_EVENTS) {
    stream.addEventListener(name, (event) => {
      const message = event as MessageEvent;
      let data: unknown = null;
      try {
        data = JSON.parse(message.data);
      } catch {
        /* keep null */
      }
      deliver(name, data, message.lastEventId);
      link.relay?.(name, data, lastId);
    });
  }
}

/** Open the shared stream. Idempotent; safe to call from any subscriber. */
export function connect(): void {
  if (started || typeof EventSource === 'undefined') return;
  started = true;
  openStream([]);
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

/**
 * What `./live-share` drives, handed to it by the shell rather than imported:
 * a chunk that imports this file at run time pulls it — and everything it
 * reads — out of the chunk first paint already carries.
 */
export const port = {
  connect,
  deliver,
  openStream,
  showStatus,
  getSseStatus,
  link,
  connection: () => connection,
  subscribe: (body: { connection: string; streams: string[] }) => post('/api/events/subscribe', body),
};

export type LivePort = typeof port;

/** Test seam only — drops the singleton so a case can start from nothing. */
export function __resetStreamForTests(): void {
  openStream();
  started = false;
  status = 'connecting';
  lastId = '';
  delete link.relay;
  delete link.status;
  delete link.hello;
  delete link.hold;
  listeners.clear();
  statusListeners.clear();
}

/* ---------------- event → effect ----------------
 *
 * TanStack Query is *what is true*; the stream is *when it changed*. The old
 * client dropped cached answers inside its fetch helper, so "which events make
 * which screen stale" was spread across every view that happened to subscribe.
 * Here it is one table — `EVENT_EFFECTS` — and `live.test.ts` holds it total
 * over every event the server can emit. An event added on the server with no
 * row here is a red test, not a screen that quietly stops updating.
 */

/** What one event does to the cache. */
type Effect = {
  /** Key prefixes to invalidate. `slugKeys` adds per-slug plan/run keys. */
  invalidate?: readonly (readonly unknown[])[];
  /** Invalidate `['plan', slug]` / `['run', slug]` for the slug(s) in the payload. */
  slugScoped?: 'plan' | 'run' | 'both';
  /** Everything is suspect (a warm/reindex). */
  all?: boolean;
  /**
   * Everything is suspect, but only when the payload says so.
   *
   * The narrower cousin of `all`, for an event that is USUALLY news about
   * nothing the client holds. Returning `false` invalidates nothing at all —
   * not even `invalidate` — because the point is to spend no requests.
   */
  allWhen?: (client: QueryClient, data: Record<string, unknown>) => boolean;
  /** Cheap in-place cache write instead of a refetch. */
  patch?: (client: QueryClient, data: Record<string, unknown>) => void;
  /** Deliberately invalidates nothing — see the note on each. */
  streamOnly?: true;
};

/**
 * A step as it now reads, written into the ledger's list — the card's state
 * word, its status line and its datums move in the tick. Fields the event
 * does not carry (the moves, the window's end) are kept from what the list
 * held; the inbox rows are re-read by the same event, since a settled step is
 * a row that leaves.
 */
export function patchHumanStep(client: QueryClient, raw: unknown): void {
  const step = raw as HumanStepRecord | undefined;
  if (!step?.id) return;
  client.setQueryData(keys.humanSteps(), (prev: HumanStepsList | undefined) =>
    prev
      ? {
          ...prev,
          steps: [
            ...prev.steps.filter((known) => known.id !== step.id),
            { ...prev.steps.find((known) => known.id === step.id), ...step },
          ],
        }
      : prev,
  );
  patchTurnStep(client, step);
}

/**
 * The same step, written into its item on Your turn (control-tower phase 137)
 * — every look the cache holds — so the item's badge and its attempt move in
 * the tick a press answers. Only the item's own record moves: which GROUP it
 * now belongs to is the server's to say (`groupOf`, which first paint does not
 * carry), so a look that was patched is asked again — writing data marks a
 * query fresh, and the re-read the event asked for would otherwise be lost.
 * A look that does not hold the step is not written at all.
 */
function patchTurnStep(client: QueryClient, step: HumanStepRecord): void {
  type Turnish = { groups?: Record<string, { item: string; step?: Record<string, unknown> }[]> };
  let patched = false;
  client.setQueriesData({ queryKey: keys.turn() }, (prev: unknown) => {
    const turn = prev as Turnish | undefined;
    if (!turn?.groups) return undefined;
    let moved = false;
    const groups = Object.fromEntries(
      Object.entries(turn.groups).map(([group, items]) => [
        group,
        items.map((item) => {
          if (item.item !== step.id || !item.step) return item;
          moved = true;
          return { ...item, step: { ...item.step, ...step } };
        }),
      ]),
    );
    if (!moved) return undefined;
    patched = true;
    return { ...turn, groups };
  });
  if (patched) void client.invalidateQueries({ queryKey: keys.turn() });
}

/** The unread badge travels on the event itself; refetching /api/state to learn
 *  a number the payload already carries is a round trip for nothing. */
const patchUnread: Effect['patch'] = (client, data) => {
  if (typeof data.unread !== 'number') return;
  client.setQueryData(keys.state(), (prev: ConsoleState | undefined) =>
    prev ? { ...prev, unread: data.unread as number } : prev,
  );
};

/**
 * Fold a live lane's progress into the two caches that render it.
 *
 * A WRITE and no invalidation, deliberately: the frame carries the phase's
 * status, its attempt, its task counts, this session's dollars and its context,
 * which is everything the summary surfaces print. Refetching a run object to
 * learn numbers the payload already holds would be a round trip every three
 * seconds per lane — the cost this event exists to avoid.
 *
 * Both caches, because they are two views of one fact: `['run', slug]` is the
 * run page and the plan's Run tab, `['runs']` is the list. A patch that reached
 * only one would leave the other stale in exactly the way this closes.
 */
const patchProgress: Effect['patch'] = (client, data) => {
  const slug = typeof data.slug === 'string' ? data.slug : null;
  const phase = typeof data.phase === 'number' ? data.phase : null;
  if (!slug || phase === null) return;

  const fold = (run: RunState | null | undefined): RunState | null | undefined => {
    if (!run || (typeof data.runId === 'string' && run.id !== data.runId)) return run;
    const record = run.phases?.[String(phase)];
    if (!record) return run;
    return {
      ...run,
      phases: {
        ...run.phases,
        [String(phase)]: {
          ...record,
          status: (data.status as PhaseRecord['status']) ?? record.status,
          attempts: typeof data.attempt === 'number' ? data.attempt : record.attempts,
          ...(data.attemptStartedAt ? { attemptStartedAt: data.attemptStartedAt as string } : {}),
          live: {
            ...record.live,
            ...(data.tasks ? { tasks: data.tasks as NonNullable<PhaseRecord['live']>['tasks'] } : {}),
            ...(typeof data.spentUsd === 'number' ? { spentUsd: data.spentUsd } : {}),
            ...(typeof data.contextTokens === 'number' ? { contextTokens: data.contextTokens } : {}),
            // The labelled clocks as of this frame (#28) — a LIVE overlay, like the rest.
            ...(data.phaseClocks && typeof data.phaseClocks === 'object'
              ? { phaseClocks: data.phaseClocks as NonNullable<PhaseRecord['live']>['phaseClocks'] }
              : {}),
          },
        },
      },
    };
  };

  client.setQueryData(keys.run(slug), (prev: RunDetail | undefined) =>
    prev ? { ...prev, run: fold(prev.run) ?? prev.run } : prev,
  );
  client.setQueryData(keys.runs(), (prev: RunState[] | undefined) =>
    Array.isArray(prev) ? prev.map((run) => (run.slug === slug ? (fold(run) ?? run) : run)) : prev,
  );
};

/** The account list travels on the event; writing it beats asking for it back. */
const patchAccounts: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.accounts)) return;
  client.setQueryData(keys.accounts(), (prev: AccountsState | undefined) => ({
    accounts: data.accounts as AccountsState['accounts'],
    allowAccounts: prev?.allowAccounts ?? false,
  }));
};

/**
 * The lint lands after the plan does, and travels on its own event.
 *
 * `/api/plans/<slug>` stopped awaiting `validate.sh` (11.27 s on the plan
 * somebody was actually working on) so the page can paint; the server computes
 * it behind the response and pushes it here. Written only onto a detail the
 * cache already holds — an event for a plan nobody has open is nothing to do,
 * not a reason to fetch one.
 */
const patchLint: Effect['patch'] = (client, data) => {
  if (typeof data.slug !== 'string' || !data.lint) return;
  // EVERY projection of this plan, not only the board one.
  //
  // `['plan', slug]` is a prefix, so this also matches the raw markdown, the
  // boot prompts, the gate and the landing packet — none of which is a
  // `PlanDetail`, and `{...aString, lint}` would quietly corrupt the cache. The
  // `summary` guard is what makes the prefix sweep safe: it patches the entries
  // that ARE plan details (`['plan', slug]` and each `…, 'include', <groups>`)
  // and leaves every sibling alone.
  client.setQueriesData({ queryKey: ['plan', data.slug] }, (prev: unknown) =>
    prev && typeof prev === 'object' && 'summary' in prev
      ? { ...(prev as PlanDetail), lint: data.lint as PlanDetail['lint'] }
      : prev,
  );
};

/** The server list travels on the event; writing it beats asking for it back. */
const patchMcp: Effect['patch'] = (client, data) => {
  if (!Array.isArray(data.servers)) return;
  client.setQueryData(keys.mcp(), (prev: McpState | undefined) => ({
    servers: data.servers as McpState['servers'],
    allowMcp: prev?.allowMcp ?? false,
  }));
};

/** The session list travels on the event; writing it beats asking for it back. */
const patchSessions: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.sessions)) {
    client.setQueryData(keys.terminal(), (prev: TerminalState | undefined) =>
      prev
        ? {
            ...prev,
            sessions: data.sessions as TerminalState['sessions'],
            ...(typeof data.live === 'number' ? { live: data.live as number } : {}),
          }
        : prev,
    );
  }
  // A recovery verdict moves the run record server-side (the write-back), and
  // a NOT-fixed verdict moves nothing that would emit `run:state` — so the run
  // and plan queries are re-read off the same event either way. This payload
  // had no consumer at all for a while: the run was fixed on disk and every
  // open tab kept the halt banner until a manual reload.
  if (data.type === 'recovery-outcome') {
    void client.invalidateQueries({ queryKey: keys.runs() });
    const slug = (data.recovery as { slug?: string } | undefined)?.slug;
    if (slug) {
      void client.invalidateQueries({ queryKey: keys.run(slug) });
      void client.invalidateQueries({ queryKey: keys.plan(slug) });
    }
  }
};

/** The `foreign` list the server appends to every `sessions` event — the registry, written straight into the cache. */
const patchPresence: Effect['patch'] = (client, data) => {
  if (Array.isArray(data.foreign)) {
    client.setQueryData<SessionRegistryView>(keys.sessionRegistry(), {
      sessions: data.foreign as SessionRegistryView['sessions'],
    });
  }
};
/** A finished convergence pass: merge its view into the cache by slug — the full report rides the event. */
const patchConverge: Effect['patch'] = (client, data) => {
  if (!data || typeof data.slug !== 'string' || !Array.isArray(data.actions)) return;
  const view = data as unknown as ConvergeView;
  client.setQueryData<ConvergeStatusView>(keys.converge(), (current) => {
    const rest = (current?.reports ?? []).filter((report) => report.slug !== view.slug);
    return {
      automatic: current?.automatic ?? true,
      everyMs: current?.everyMs ?? 0,
      pending: (current?.pending ?? []).filter((p) => p.slug !== view.slug),
      running: (current?.running ?? []).filter((slug) => slug !== view.slug),
      reports: [...rest, view],
    };
  });
};

/**
 * Did this `warm` come from opening a root we are NOT looking at?
 *
 * Three readings, and only one of them costs a request:
 *
 * - **No cached state at all** — this tab is still loading. There is nothing
 *   stale to throw away, and anything already in flight is being answered by
 *   the very server that just warmed. `false`.
 * - **Same root** — boot, or a re-open of the same directory. The boards were
 *   rebuilt from the same files; every answer we hold is still the answer.
 *   `false`, and this is the case that used to cost a whole cache.
 * - **A different root**, or a server too old to say which — everything we hold
 *   is about another project. `true`.
 *
 * Deliberately NOT keyed on `generation`: it advances on every `changed` too,
 * so a tab whose `/api/state` was a few file-saves behind would read every warm
 * as a root switch. The root path is the fact this question is actually about.
 */
function warmedAnotherRoot(client: QueryClient, data: Record<string, unknown>): boolean {
  const held = client.getQueryData<ConsoleState>(keys.state());
  if (!held) return false;
  const warmed = typeof data.root === 'string' ? data.root : null;
  return warmed === null || warmed !== held.root?.path;
}

export const EVENT_EFFECTS: Record<SseEvent, Effect> = {
  /* ---- the repo moved under us ---- */
  // Queue and runs ride along: lock files live under docs/handoffs, so a
  // foreign claim or release arrives as `changed` — and the queue page used
  // to sit stale (observed live: entries [] while a real manual lock held
  // the phase) because nothing here invalidated it.
  changed: {
    // `locks` too: a claim, a refresh or a release is a `.locks/` change (#24).
    invalidate: [keys.plans(), keys.stats(), keys.state(), keys.queue(), keys.runs(), keys.locks()],
    slugScoped: 'plan',
  },
  /*
   * The server finished pre-computing every board.
   *
   * This used to be `{ all: true }` — `invalidateQueries()` with no key, i.e.
   * throw away the entire cache. It fires from exactly ONE place, `open()`, so
   * in practice it arrived a moment after console boot and re-fetched the plan
   * a browser had just finished loading: the second of two identical 46 KB
   * requests, on the slowest part of the page's life.
   *
   * Nothing about a warm changes what an answer WOULD have been — the boards
   * are recomputed from the same files the previous answer was built from. The
   * one case where the client is genuinely holding the wrong thing is `open()`
   * against a DIFFERENT root, and the event now says which root it warmed, so
   * that case can be recognised instead of assumed. See `warmedAnotherRoot`.
   *
   * The safety `{ all: true }` accidentally provided — "a console restarted and
   * this tab may have missed events" — is not this event's job and never was:
   * a restart the browser slept through emits no warm the tab is listening to.
   * `useLiveData`'s reconnect guard covers it, deliberately and by name.
   */
  warm: { allWhen: warmedAnotherRoot },
  /* Watcher/server health is part of what `/api/state` reports (including
     `serverStale`, which the shell turns into a banner). */
  health: { invalidate: [keys.state()] },
  /* A restart's update moved: the Restart card reads `/api/restart`, and the
     shell's banner reads `restartUpdate` off `/api/state`. */
  restart: { invalidate: [keys.restart(), keys.state()] },

  /* ---- approvals ---- */
  approval: { invalidate: [keys.approvals()] },
  // A card answered on a phone has to take the badge down on the laptop.
  'approval:resolved': { invalidate: [keys.approvals()] },

  /* ---- the inbox ---- */
  notification: { invalidate: [keys.notifications(), keys.state()] },
  'notification:delivery': { invalidate: [keys.notifications()] },
  'notification:read': { invalidate: [keys.notifications()], patch: patchUnread },
  'notification:cleared': { invalidate: [keys.notifications()], patch: patchUnread },

  /* ---- the unified work inbox ----
     `Service.emit()` debounces this one, so it arrives when something a person
     is waiting on actually changed. All three keys move together because a
     single fact reaches the operator through all three surfaces: the inbox
     rows, the approval cards the run page still draws, and the badge that
     `/api/state` feeds. */
  inbox: { invalidate: [keys.inbox(), keys.approvals(), keys.notifications()] },

  /* ---- sessions ----
     The list rides on the event, so this is a cache write rather than a
     refetch: a session appearing or ending must reach the dashboard card and
     the nav badges in the same tick, and there is nothing to ask for that the
     payload does not already carry. Invalidation stays as the belt to that
     braces — `/api/terminal` also answers `available` and the flags. */
  // The registry rides the same event: the server appends `foreign` — every
  // hook-reported session with its presence — to each `sessions` emission.
  sessions: {
    invalidate: [keys.terminal(), keys.sessionRegistry()],
    patch: (client, data) => {
      patchSessions(client, data);
      patchPresence(client, data);
    },
  },

  /* ---- autopilot ----
     A run starting, finishing, or having a phase land changes the board too:
     `plans` carries each plan's ready-set, and that is what a finished phase
     moves. */
  'run:run': {
    // A start writes `run.start` — the ledger's why-started — as well as moving the board.
    invalidate: [keys.runs(), keys.plans(), keys.spend(), keys.ledgerAll(), keys.ledgerSummary()],
    slugScoped: 'both',
  },
  'run:phase': {
    invalidate: [
      keys.runs(),
      keys.spend(),
      keys.timelineAll(),
      keys.attemptsAll(),
      keys.ledgerAll(),
      keys.ledgerSummary(),
    ],
    slugScoped: 'both',
  },
  'run:verify': { slugScoped: 'run' },
  'run:state': { invalidate: [keys.runs(), keys.plans(), keys.spend()], slugScoped: 'both' },
  /* A lane's liveness answer CHANGED — it went silent, started spinning, hit a
     stalemate, or came back. `runner.ts` emits only transitions, so this is
     news by construction and can afford to invalidate: the run payload carries
     `liveness[]`, and the fleet table badges a stalled run without being on
     its page. */
  'run:liveness': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* The silent-session watchdog ACTED on a lane — nudged it, recycled it, or
     parked the phase after both. Its own event because none of the three is
     visible in any other one: a nudge changes no status at all, and a recycle
     kills a child whose settle arrives seconds later, which is a page showing
     a running session that is already gone. Invalidates the run for the same
     reason `run:liveness` does — the phase record carries `stallRemedy`. */
  'run:watchdog': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* The run's git situation moved — commits, checkouts, or a radar verdict.
     `runs` for `run:liveness`'s reason: the run payload carries `git`, and the
     fleet table wants to badge a run whose branch is heading for a conflict
     without being on its page. Emitted only on a CHANGE, so it can afford to
     invalidate; a probe that fired every five minutes regardless would make
     this the most expensive entry in the table. */
  'run:git': { invalidate: [keys.runs()], slugScoped: 'run' },
  /* A ruling landed in the ledger. Both halves move: the plan-wide ledger the
     page reads, and `run.rulings` — the slice the run payload carries. */
  'run:rulings': {
    invalidate: [],
    slugScoped: 'run',
    patch: (client, data) => {
      const slug = typeof data.slug === 'string' ? data.slug : null;
      if (slug) void client.invalidateQueries({ queryKey: keys.rulings(slug) });
    },
  },
  /* Admission moved. `runs` because a phase crossing between queued and
     running is a change to a run; `state` because the header's "2 of 3
     running, 1 queued" is read from `/api/state`. Deliberately NOT
     slug-scoped: a grant released on one plan is precisely what unblocks
     another, and the plan that needs to hear about it is the other one —
     which is also why `['scopes']` is invalidated as a bare prefix rather
     than for the slug the event happens to name. */
  'run:queue': { invalidate: [keys.runs(), keys.state(), keys.queue(), ['scopes']] },
  /* A convergence pass landed: the view rides the event, so this is a cache
     write by slug; `runs` is invalidated too because a relaunch or a heal has
     just changed a run, and `/api/converge` is re-read as the belt to those
     braces (the pending/running lists move independently of any one pass). */
  'run:converge': { invalidate: [keys.converge(), keys.runs()], patch: patchConverge },

  /* ---- accounts ----
     The redacted list rides on the event (see `patchAccounts`), so this is a
     cache write first; the invalidation is the belt to those braces, because
     `/api/accounts` also carries `allowAccounts`. */
  accounts: { invalidate: [keys.accounts()], patch: patchAccounts },

  /* ---- MCP servers ----
     Same shape as accounts, and for the same reason: the redacted list rides on
     the event, and the invalidation is the belt to those braces because
     `/api/mcp` also carries `allowMcp`. A registry change also moves F15, which
     the lint panel reads through the plan — hence `plans` too. */
  mcp: { invalidate: [keys.mcp(), keys.plans()], patch: patchMcp },

  /* ---- the firehose ----
     These two arrive many times a second while a phase is talking. The run view
     subscribes to them directly and appends; routing them through the cache
     would refetch the whole run object per line. Invalidating nothing here is
     the point, not an omission. */
  'run:stream': { streamOnly: true },
  /* ---- …and the slow half of it ----
     One frame per live lane per three seconds, only when what a surface renders
     has changed, applied as a cache WRITE. Between phase boundaries this is the
     only thing that moves the Runs list, the plan's Run tab and the boards, and
     it does it with zero fetches: the event already carries every field it
     changes, which is exactly the argument `plan:lint` makes below. */
  'run:progress': { patch: patchProgress },
  // The journal is what the trace is projected from, so a new line means the
  // picture has moved — and it is the ONLY signal that says so, since the
  // spans come from four files and only this one announces itself. The live
  // Journal panel still tails the stream directly through `onSse`; this row
  // additionally invalidates the trace and the git table.
  // (`streamOnly` is deliberately NOT set: `applyEffect` returns early on it,
  // so a row carrying both a `patch` and that flag would run neither. The flag
  // only ever meant "this row has no cache effect", and now it has one.)
  // The ROW is in both trees — `EVENT_EFFECTS` is total over `SseEvent`, so a
  // row a marker swallows is a TS2741 only the free tree's typecheck sees — and
  // since control-tower phase 95 so is its `patch`, which refreshes a live
  // phase's Now panel in both editions. Only the two debug invalidations inside
  // it are marked: a tree with no Debug ▸ Timeline has nothing to refresh there.
  'run:journal': {
    invalidate: [],
    patch: (client, data) => {
      const slug = typeof data.slug === 'string' ? data.slug : null;
      if (!slug) return;
      // A line that moves a live phase's report refreshes its Now panel — the
      // task list, a progress count, a verification, a session (control-tower
      // phase 95, #163). Not every line: a busy run journals many a minute.
      if (typeof data.event !== 'string' || NOW_EVENTS.has(data.event)) {
        void client.invalidateQueries({ queryKey: keys.phaseNow(slug) });
      }
    },
  },


  /* ---- the repository's conflict radar (phase 7) ---- */
  // `keys.runs()` because that is where a radar verdict is READ today: the git
  // card on each run. `keys.repo()` because the Repo destination's working
  // trees section shows the same trees, and its git sections all read under it.
  'repo:radar': { invalidate: [keys.runs(), keys.repo()] },

  /* ---- a person's turn ----
     The step rides the event (control-tower phase 42), so its card's status
     line and every inbox row drawing it are patched in place; the inbox is
     re-read as well, because a step that settled is a row that leaves — and
     with it the run's summons, which is what moves its strip out of Needs
     you with no reload. */
  'human-step': { invalidate: [keys.inbox()], patch: (client, data) => patchHumanStep(client, data.step) },

  /* ---- a round changed the turn (control-tower phase 136) ----
     Only a round that CHANGED something sends it, so it is rare: the inbox —
     which the turn is projected from — is read again, and with it every look
     at Your turn (`keys.turn()` sits under the inbox prefix, phase 137). */
  turn: { invalidate: [keys.inbox()] },

  /* ---- the lint, arriving after the page ----
     A cache WRITE and no invalidation: the plan detail the browser is holding
     is correct in every other respect, and refetching a 288 KB document to
     collect one field the event already carries is the round trip this whole
     change exists to remove. */
  'plan:lint': { patch: patchLint },

  /* ---- a review verdict and a landing packet ----
     Both are sections of the plan's page, read under its prefix, and the
     verdict also moves what the board holds back. */
  review: { invalidate: [keys.plans()], slugScoped: 'plan' },
  landing: { slugScoped: 'plan' },
  /* ---- a plan's stored triggers ----
     Their own prefix (`['triggers', slug]`, phase 11's section), like the
     journal's: re-reading the run to learn that a trigger fired would cost the
     whole record for one line of it. */
  'run:triggers': { invalidate: [['triggers']] },
  /* ---- a budget near its line, or spent ----
     The runner parks the run on a spent one; the run and the money read it
     again. An approaching one is also written into the open run in the tick
     (`patchBudgetApproach`), so the run view's banner and its raise draw
     before the re-read lands — the warning exists to come before the park. */
  'run:budget': { invalidate: [keys.spend()], slugScoped: 'run', patch: patchBudgetApproach },
};

/**
 * An approaching budget (`state: 'approaching'`), written onto its holder in
 * the cached run: the run's own dollar budget on the run, every other budget
 * on the phase it is about — the shape `noteBudgetApproaching` keeps
 * server-side (`server/runner/runner-base.ts`), keyed by the budget. A spent
 * budget changes nothing here: the park is the run's, and the re-read says it.
 */
export function patchBudgetApproach(client: QueryClient, data: Record<string, unknown>): void {
  const fact = data.fact as BudgetApproach | undefined;
  const slug = typeof data.slug === 'string' ? data.slug : null;
  if (data.state !== 'approaching' || !slug || !fact || typeof fact.budget !== 'string') return;
  const phase = typeof data.phase === 'number' ? data.phase : null;
  client.setQueryData(keys.run(slug), (prev: RunDetail | undefined) => {
    const run = prev?.run;
    if (!prev || !run || (typeof data.runId === 'string' && data.runId !== run.id)) return prev;
    if (fact.budget === 'run-usd' || phase == null) {
      return {
        ...prev,
        run: { ...run, budgetApproaching: { ...run.budgetApproaching, [fact.budget]: fact } },
      };
    }
    const record = run.phases[String(phase)];
    if (!record) return prev;
    const next = { ...record, budgetApproaching: { ...record.budgetApproaching, [fact.budget]: fact } };
    return { ...prev, run: { ...run, phases: { ...run.phases, [String(phase)]: next } } };
  });
}

type BudgetApproach = NonNullable<RunState['budgetApproaching']>[string];

/** Slugs named by an event payload, in the two shapes the server uses. */
function slugsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as { slug?: unknown; slugs?: unknown };
  if (Array.isArray(record.slugs)) return record.slugs.filter((s): s is string => typeof s === 'string');
  if (typeof record.slug === 'string') return [record.slug];
  return [];
}

/**
 * One event, applied to the cache.
 *
 * Exported for the tests: the table above is a set of claims about what an
 * arriving event costs, and the only way to check a claim like "a warm at boot
 * re-fetches nothing" is to apply the event to a real client and look. Nothing
 * in the app calls it except `useLiveData`.
 */
export function applyEffect(client: QueryClient, name: SseEvent, data: unknown): void {
  const effect = EVENT_EFFECTS[name];
  if (!effect || effect.streamOnly || link.hold?.(client)) return;

  if (effect.all) {
    void client.invalidateQueries();
    return;
  }

  // `allWhen` answers for the whole event, both ways: `true` is `all`, and
  // `false` means this arrival is news about nothing — not "fall through to
  // the narrower keys". An event that wants both shapes should be two effects.
  if (effect.allWhen) {
    if (effect.allWhen(client, (data ?? {}) as Record<string, unknown>)) void client.invalidateQueries();
    return;
  }

  for (const key of effect.invalidate ?? []) {
    void client.invalidateQueries({ queryKey: key });
  }

  if (effect.slugScoped) {
    for (const slug of slugsOf(data)) {
      if (effect.slugScoped !== 'run') void client.invalidateQueries({ queryKey: keys.plan(slug) });
      if (effect.slugScoped !== 'plan') void client.invalidateQueries({ queryKey: keys.run(slug) });
    }
  }

  if (effect.patch && data && typeof data === 'object') {
    effect.patch(client, data as Record<string, unknown>);
  }
}

/**
 * Mount once, in the shell. Wires every server event to its cache effect.
 *
 * Plus the one invalidation that is not an event: a stream that went away and
 * CAME BACK. Everything above assumes the tab saw every emission; a laptop that
 * slept, a console that restarted, a tunnel that dropped, all break that
 * assumption silently, and the events missed in the gap are unrecoverable by
 * construction. So the first return to `live` after a loss re-reads whatever is
 * on screen. It is the honest home for the safety `warm: { all: true }` used to
 * give by accident — accurate about a restart the old one could not see, and
 * quiet at boot, where the old one was loudest.
 */
export function useLiveData(): void {
  const client = useQueryClient();
  useEffect(() => {
    const offs = SSE_EVENTS.map((name) => onSse(name, (data) => applyEffect(client, name, data)));
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

  const status = useSseStatus();
  // The FIRST `live` is a connection, not a reconnection — invalidating there
  // would re-fetch the page's own opening requests, which is the double-fetch
  // this phase exists to remove. Only a `live` that follows a loss counts, so
  // the ref holds three states rather than a boolean.
  const link = useRef<'cold' | 'live' | 'lost'>('cold');
  useEffect(() => {
    if (status !== 'live') {
      if (link.current === 'live') link.current = 'lost';
      return;
    }
    const reconnected = link.current === 'lost';
    link.current = 'live';
    if (reconnected) void client.invalidateQueries();
  }, [status, client]);
}

/** The journal lines that move a live phase's report (see `run:journal` above). */
const NOW_EVENTS = new Set([
  'phase.tasks',
  'phase.progress',
  'phase.session',
  'phase.verify',
  'phase.start',
  'phase.stall',
  'phase.queued',
]);
