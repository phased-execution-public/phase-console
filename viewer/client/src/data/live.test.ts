/**
 * The stream and the cache it moves.
 *
 * READING: the failure this prevents is quiet — the server grows an event,
 * nothing on the client listens for it, and a screen simply stops updating for
 * that one case, with no error, no console warning, and a page that looks
 * alive. Making the event→effect table total, and asserting it, turns that into
 * a red test. The `keys.after*` cases pin what each write bundle means.
 *
 * ONE STREAM PER BROWSER (#236): a second tab must open no stream of its own,
 * hear every frame the first one does, and take the stream over — from the
 * last event either saw — when the first one goes.
 *
 * PARTIALS PER RUN: `run:stream` reaches a connection only for the runs it
 * asked for, so a surface rendering a transcript has to ask — and the leader
 * asks the server for what every tab holds, on the open connection when it can.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_EFFECTS, SSE_EVENTS, applyEffect, type SseEvent } from './live';
import { keys } from './keys';
import { shellCounts } from './console';

describe('SSE → Query bridge', () => {
  it('has an effect for every event the server can emit', () => {
    const missing = SSE_EVENTS.filter((name) => !(name in EVENT_EFFECTS));
    expect(missing, `unhandled events: ${missing.join(', ')}`).toEqual([]);
  });

  it('declares no effect for an event that does not exist', () => {
    const extra = Object.keys(EVENT_EFFECTS).filter(
      (name) => !(SSE_EVENTS as readonly string[]).includes(name),
    );
    expect(extra, `phantom events: ${extra.join(', ')}`).toEqual([]);
  });

  it('carries every wire name, run events included — 35 free, six more Pro', () => {
    // 28 since 2026-09-18: `restart`, a restart's update moving — every tab's
    // Restart card and banner hear it, not only the tab that pressed.
    expect(SSE_EVENTS).toContain('restart');
    // Sessions are on the stream deliberately: the socket is a session's own
    // live channel, but the dashboard card and the nav badges do not hold it.
    expect(SSE_EVENTS).toContain('sessions');
    // Accounts ride the stream so the header meters move without polling.
    expect(SSE_EVENTS).toContain('accounts');
    // Declared in Phase 3, emitted from Phase 4: the unified work inbox. An
    // event nothing sends is inert; a badge built against an event nobody
    // declared is a number that silently stops moving.
    expect(SSE_EVENTS).toContain('inbox');
    // So does the MCP registry: a server that goes needs-auth changes what
    // every launch dialog may offer, and no page is holding that.
    expect(SSE_EVENTS).toContain('mcp');
    // Phase 5 emits both server-side; Phase 7 is what renders them. A lane
    // going silent and a session recording a judgement call are each the only
    // thing that moves when they happen — no phase changes state for either.
    expect(SSE_EVENTS).toContain('run:liveness');
    expect(SSE_EVENTS).toContain('run:rulings');
    // Phase 20's watchdog. A nudge moves no status, so `run:phase` never fires
    // for it and a page with no effect for this name shows a session that is
    // being acted on as if nothing were happening.
    expect(SSE_EVENTS).toContain('run:watchdog');
    // Phase 9's branch probe. Two isolated runs can diverge for an hour while
    // every phase event says the same thing, and the moment worth telling
    // somebody about — a radar going `clean → overlap` — happens BETWEEN
    // phases. Without an effect for this name the Git card is a snapshot of
    // whenever the page last loaded.
    expect(SSE_EVENTS).toContain('run:git');
    expect(EVENT_EFFECTS['run:git'].slugScoped).toBe('run');
    // many-plans-one-repo phase 7's conflict radar. Deliberately NOT `run:*`:
    // the radar's unit is the repository, so one transition is news to every
    // run in it. (This assertion and the count above were both missed when it
    // landed — the count read 26 against 27 names, so this suite was red from
    // that commit until phase 13 noticed.)
    expect(SSE_EVENTS).toContain('repo:radar');
    // The Pro names, declared in a `!pro:` region of `sse.ts` — so the free
    // tree carries 29 names and this tree 32, and the count below is written
    // to hold BOTH (this suite runs in the free tree too, under `verify-free`).
    // Phase 10's mailbox, given a reader in phase 13: its own event for
    // `run:rulings`' reason, the mailbox is per PLAN and outlives every run of
    // it, so nothing else on the wire moves when a message lands. Phase 12's
    // issue drafts: the plan's own list and the estate chip on the repository
    // page both move on it, and nothing else on the wire does.
    const proNames: string[] = [];
    for (const name of proNames) expect(SSE_EVENTS).toContain(name);
    // `run:progress` (control-tower phase 7) is the 29th: the one event that
    // arrives BETWEEN phase boundaries, and the reason a surface can move
    // while a phase works.
    expect(SSE_EVENTS).toContain('run:progress');
    // `human-step` (control-tower phase 42) is the 30th: a person's turn moved,
    // and the step rides the event.
    expect(SSE_EVENTS).toContain('human-step');
    // `turn` (control-tower phase 136) is the 31st: a round of the console's
    // own clock changed Your turn.
    expect(SSE_EVENTS).toContain('turn');
    // quiet-console phase 2: four names the server sent and no client heard —
    // a review verdict, a landing packet, a plan's triggers, a spent budget.
    for (const name of ['review', 'landing', 'run:triggers', 'run:budget'])
      expect(SSE_EVENTS).toContain(name);
    expect(SSE_EVENTS).toHaveLength(35 + proNames.length);
    // The runner prefixes its own events (`server/runner/runner.ts` emits
    // `run:` + event). Listening for `phase` instead of `run:phase` is the
    // mistake this pins down.
    for (const name of [
      'run:run',
      'run:phase',
      'run:stream',
      'run:journal',
      'run:verify',
      'run:state',
      // Admission. Its own event because it changes what the console may
      // START, which none of the others describe — a phase can sit queued for
      // minutes while nothing about any run's own state changes at all.
      'run:queue',
      // A convergence pass: the report rides the event so the Pulse's
      // convergence line is a cache write, not a refetch.
      'run:converge',
    ]) {
      expect(SSE_EVENTS).toContain(name);
    }
    // `hello` is the handshake frame, not a change notification.
    expect(SSE_EVENTS).not.toContain('hello');
  });

  it('keeps the firehose out of the cache', () => {
    // `run:stream` arrives many times a second while a phase is talking;
    // routing it through invalidation would refetch the run object per line.
    expect(EVENT_EFFECTS['run:stream'].streamOnly).toBe(true);

    // `run:journal` used to be the second of the pair and is no longer, and the
    // distinction is worth keeping straight. It still must not invalidate the
    // RUN — that is what `streamOnly` was protecting — but phase 13's trace is
    // projected from the journal and this is the only event that says a new
    // line landed. So it carries an empty `invalidate` and a narrow `patch`:
    // nothing about the run is refetched, and the two debug queries that are
    // genuinely stale are. (`streamOnly` would defeat it entirely —
    // `applyEffect` returns early on the flag, so a row carrying both would run
    // neither half.)
    expect(EVENT_EFFECTS['run:journal'].streamOnly).toBeUndefined();
    expect(EVENT_EFFECTS['run:journal'].invalidate).toEqual([]);
    expect(EVENT_EFFECTS['run:journal'].slugScoped).toBeUndefined();
    // The patch is the Pro half — the free tree has no trace to invalidate, so
    // its row is the bare `{ invalidate: [] }` and this line is not in it.
  });

  it('makes a file change reach the board', () => {
    const changed = EVENT_EFFECTS.changed;
    expect(changed.invalidate).toContainEqual(keys.plans());
    expect(changed.slugScoped).toBe('plan');
  });

  /*
   * This used to read `expect(EVENT_EFFECTS.warm.all).toBe(true)` — and it was
   * true: a warm threw the whole cache away. The event fires from ONE place,
   * the server's `open()`, so what it did on nearly every arrival was re-fetch
   * a plan the browser had finished loading a moment earlier.
   *
   * The contract is conditional now (`first-paint.test.tsx` tests the
   * condition), so the unconditional forms have to be pinned CLOSED here as
   * well: an `all: true` put back would make every one of those tests vacuous
   * while they all still passed.
   */
  it('does not treat a warm as unconditionally suspect', () => {
    expect(EVENT_EFFECTS.warm.all).toBeUndefined();
    expect(EVENT_EFFECTS.warm.invalidate).toBeUndefined();
    expect(typeof EVENT_EFFECTS.warm.allWhen).toBe('function');
  });

  /*
   * Four names the server sent for a release or more while no client listened:
   * a review verdict, a landing packet, a plan's stored triggers and a budget.
   * Each moved something a page reads and nothing re-read it.
   */
  it('moves what each of the four once-unheard events changes, and nothing beside it', () => {
    type Keys = (readonly unknown[])[];
    const cases: [SseEvent, Record<string, unknown>, Keys, Keys][] = [
      [
        'review',
        { slug: 'cart', phase: 3, verdict: 'approved' },
        [keys.plans(), keys.plan('cart')],
        [keys.run('cart')],
      ],
      [
        'landing',
        { slug: 'cart', at: '2026-10-09T00:00:00Z' },
        [keys.plan('cart')],
        [keys.plans(), keys.run('cart')],
      ],
      ['run:triggers', { slug: 'cart' }, [['triggers', 'cart']], [keys.run('cart'), keys.plan('cart')]],
      [
        'run:budget',
        { slug: 'cart', runId: 'r1', phase: 2, state: 'spent', fact: 'phase' },
        [keys.spend(), keys.run('cart')],
        [keys.plan('cart'), keys.plans()],
      ],
    ];
    for (const [name, data, moved, kept] of cases) {
      const client = new QueryClient();
      for (const key of [...moved, ...kept]) client.setQueryData(key, { held: true });
      applyEffect(client, name, data);
      for (const key of moved)
        expect(client.getQueryState(key)?.isInvalidated, `${name} moves ${key.join('/')}`).toBe(true);
      for (const key of kept)
        expect(client.getQueryState(key)?.isInvalidated, `${name} keeps ${key.join('/')}`).toBe(false);
    }
  });

  it('draws an approaching budget into the open run in the tick — the run view’s banner before the re-read (quiet-console phase 11)', () => {
    const client = new QueryClient();
    const run = {
      id: 'r1',
      slug: 'cart',
      budgetApproaching: {},
      phases: { '2': { phase: 2, status: 'waiting' } },
    };
    client.setQueryData(keys.run('cart'), { run, history: [run], eta: null });
    const wait = {
      budget: 'wait',
      phase: 2,
      limit: 120,
      spent: 100,
      left: 20,
      unit: 'minutes',
      spentOn: [],
      at: 'now',
    };
    const usd = {
      budget: 'run-usd',
      phase: null,
      limit: 25,
      spent: 21,
      left: 4,
      unit: 'usd',
      spentOn: [],
      at: 'now',
    };
    applyEffect(client, 'run:budget', {
      slug: 'cart',
      runId: 'r1',
      phase: 2,
      state: 'approaching',
      key: 'k',
      fact: wait,
    });
    applyEffect(client, 'run:budget', {
      slug: 'cart',
      runId: 'r1',
      phase: 2,
      state: 'approaching',
      key: 'k',
      fact: usd,
    });
    type Held = {
      run: {
        budgetApproaching: Record<string, unknown>;
        phases: Record<string, { budgetApproaching?: Record<string, unknown> }>;
      };
    };
    const held = client.getQueryData<Held>(keys.run('cart'))!;
    // A phase's budget on the phase, the run's own dollars on the run — `noteBudgetApproaching`'s shape.
    expect(held.run.phases['2']!.budgetApproaching).toEqual({ wait });
    expect(held.run.budgetApproaching).toEqual({ 'run-usd': usd });

    // A spent budget, another run's event, or one with no fact write nothing.
    applyEffect(client, 'run:budget', {
      slug: 'cart',
      runId: 'r1',
      phase: 2,
      state: 'spent',
      fact: { ...wait, budget: 'ladder' },
    });
    applyEffect(client, 'run:budget', {
      slug: 'cart',
      runId: 'r0',
      phase: 2,
      state: 'approaching',
      fact: { ...wait, budget: 'ladder' },
    });
    applyEffect(client, 'run:budget', { slug: 'cart', runId: 'r1', phase: 2, state: 'approaching' });
    expect(client.getQueryData<Held>(keys.run('cart'))!.run.phases['2']!.budgetApproaching).toEqual({ wait });
  });
});

/* ------------------------------------------------------------------ *
 * One stream per browser, and a run's partials on request
 * ------------------------------------------------------------------ */

/** An `EventSource` that records the address it was opened at, and takes frames from a case. */
class Wire {
  static opened: Wire[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private heard = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    Wire.opened.push(this);
  }

  addEventListener(name: string, fn: (event: MessageEvent) => void): void {
    this.heard.set(name, [...(this.heard.get(name) ?? []), fn]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** One frame, as the server writes it. */
  emit(name: string, data: unknown, id = ''): void {
    for (const fn of this.heard.get(name) ?? [])
      fn({ data: JSON.stringify(data), lastEventId: id } as MessageEvent);
  }
}

/**
 * Web Locks as `share()` asks them: one holder, `ifAvailable` answered with no
 * lock while it is held, and a plain request queued until the holder lets go —
 * which is what the browser does when the holding tab goes.
 */
function fakeLocks() {
  let held = false;
  const queue: (() => void)[] = [];
  const hold = async (grant: (lock: unknown) => unknown) => {
    held = true;
    try {
      return await grant({ name: 'phase-console-events' });
    } finally {
      held = false;
      queue.shift()?.();
    }
  };
  return {
    request(_name: string, options: unknown, callback?: (lock: unknown) => unknown): Promise<unknown> {
      const grant = (callback ?? options) as (lock: unknown) => unknown;
      if (!held) return hold(grant);
      if (callback && (options as { ifAvailable?: boolean }).ifAvailable) return Promise.resolve(grant(null));
      return new Promise((resolve) => queue.push(() => resolve(hold(grant))));
    },
  };
}

type Tab = { live: typeof import('./live'); shared: typeof import('./live-share') };

const answered = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('one stream per browser (#236), and a run’s partials on request', () => {
  const tabs: Tab[] = [];
  const realEventSource = globalThis.EventSource;
  let posted: { url: string; body: unknown }[] = [];
  let reply: () => Response;

  /** A tab of the console: its own copy of both modules, its stream opened at boot, then shared. */
  async function boot(): Promise<Tab> {
    vi.resetModules();
    const tab: Tab = { live: await import('./live'), shared: await import('./live-share') };
    tabs.push(tab);
    tab.live.connect();
    tab.shared.share(tab.live.port);
    return tab;
  }

  const lastPost = () => posted[posted.length - 1];

  beforeEach(() => {
    Wire.opened = [];
    posted = [];
    reply = () => answered(200, { ok: true });
    globalThis.EventSource = Wire as unknown as typeof EventSource;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        posted.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
        return reply();
      }),
    );
    Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeLocks() });
  });

  afterEach(() => {
    for (const tab of tabs.splice(0)) {
      tab.shared.__resetShareForTests();
      tab.live.__resetStreamForTests();
    }
    globalThis.EventSource = realEventSource;
    vi.unstubAllGlobals();
    delete (navigator as unknown as { locks?: unknown }).locks;
  });

  it('a second tab closes the stream it opened at boot, opens no other, and hears every frame the first does', async () => {
    expect(typeof BroadcastChannel).toBe('function');
    await boot();
    const second = await boot();
    // Each tab opened one at boot, as 6.2 did; the second let its own go the
    // moment it found a tab holding the stream.
    expect(Wire.opened).toHaveLength(2);
    expect(Wire.opened[1]!.closed).toBe(true);
    expect(Wire.opened[0]!.closed).toBe(false);

    const heard: unknown[] = [];
    second.live.onSse('changed', (data) => heard.push(data));
    Wire.opened[0]!.onopen?.();
    Wire.opened[0]!.emit('changed', { slug: 'cart' }, '7');
    await vi.waitFor(() => expect(heard).toEqual([{ slug: 'cart' }]));
    expect(second.live.getSseStatus()).toBe('live');
    // Hearing it opened nothing: one connection serves both tabs.
    expect(Wire.opened).toHaveLength(2);
  });

  it('the tab holding the stream asks the server, on that stream, for the runs any tab renders — and lets them go', async () => {
    const first = await boot();
    const second = await boot();
    Wire.opened[0]!.emit('hello', { generation: 1, cursor: 0, replayed: 0, connection: 'conn-1' });

    const letGo = second.shared.acquireRunStream('run-b');
    await vi.waitFor(() =>
      expect(lastPost()).toEqual({
        url: '/api/events/subscribe',
        body: { connection: 'conn-1', streams: ['run-b'] },
      }),
    );
    const letOwnGo = first.shared.acquireRunStream('run-a');
    await vi.waitFor(() =>
      expect(lastPost()?.body).toEqual({ connection: 'conn-1', streams: ['run-a', 'run-b'] }),
    );

    letGo();
    letOwnGo();
    await vi.waitFor(() => expect(lastPost()?.body).toEqual({ connection: 'conn-1', streams: [] }));
    // Every change rode the open stream; nothing was reopened to say it.
    expect(Wire.opened).toHaveLength(2);
  });

  it('when the tab holding the stream goes, the next opens it from the last event either saw, with the runs it renders', async () => {
    const first = await boot();
    const second = await boot();
    second.shared.acquireRunStream('run-b');
    Wire.opened[0]!.emit('changed', { slug: 'cart' }, '41');
    await vi.waitFor(() => expect(second.live.getSseStatus()).toBe('live'));

    // The browser releases a closed tab's lock and grants it to the next tab waiting.
    first.shared.__resetShareForTests();
    await vi.waitFor(() => expect(Wire.opened).toHaveLength(3));
    expect(Wire.opened[2]!.url).toBe('/events?stream=run-b&last=41');
  });

  it('a stream the server no longer knows is opened again, naming the runs and the last event — so nothing is lost', async () => {
    // A browser with no Web Locks keeps its own stream, as before.
    delete (navigator as unknown as { locks?: unknown }).locks;
    const tab = await boot();
    Wire.opened[0]!.emit('hello', { connection: 'gone' });
    Wire.opened[0]!.emit('changed', {}, '12');
    reply = () =>
      answered(404, { error: 'No stream of this console is open under that name.', reopen: true });

    tab.shared.acquireRunStream('run-9');
    await vi.waitFor(() => expect(Wire.opened).toHaveLength(2));
    expect(posted.map((post) => post.url)).toEqual(['/api/events/subscribe']);
    expect(Wire.opened[0]!.closed).toBe(true);
    expect(Wire.opened[1]!.url).toBe('/events?stream=run-9&last=12');
  });

  it('a stream that names no connection — an older server — is opened again rather than asked', async () => {
    delete (navigator as unknown as { locks?: unknown }).locks;
    const tab = await boot();
    tab.shared.acquireRunStream('run-9');
    expect(posted).toEqual([]);
    expect(Wire.opened.map((wire) => wire.url)).toEqual(['/events', '/events?stream=run-9&last=']);
  });

  it('a hidden tab applies no effect and, seen again, re-reads what it has on screen — once', async () => {
    const tab = await boot();
    const client = new QueryClient();
    client.setQueryData(keys.plans(), { held: true });
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      tab.live.applyEffect(client, 'changed', { slug: 'cart' });
      tab.live.applyEffect(client, 'run:phase', { slug: 'cart' });
      expect(client.getQueryState(keys.plans())?.isInvalidated).toBe(false);

      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(client.getQueryState(keys.plans())?.isInvalidated).toBe(true);

      // Seen, a tab applies each effect as it arrives, and the next showing re-reads nothing more.
      client.setQueryData(keys.stats(), { held: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(client.getQueryState(keys.stats())?.isInvalidated).toBe(false);
      tab.live.applyEffect(client, 'changed', { slug: 'cart' });
      expect(client.getQueryState(keys.stats())?.isInvalidated).toBe(true);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it('a stream the browser reconnected by itself is told the runs again: its address names only what it opened with', async () => {
    delete (navigator as unknown as { locks?: unknown }).locks;
    const tab = await boot();
    Wire.opened[0]!.emit('hello', { connection: 'c1' });
    tab.shared.acquireRunStream('run-1');
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    // Dropped and reopened at the same address: a new name, and none of the runs.
    Wire.opened[0]!.emit('hello', { connection: 'c2' });
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(lastPost()?.body).toEqual({ connection: 'c2', streams: ['run-1'] });
  });
});

describe('shellCounts', () => {
  it('counts plans, phases, ready and pending approvals', () => {
    const counts = shellCounts(
      [
        { slug: 'a', kind: 'plan', phases: 8, ready: [1, 2] },
        { slug: 'b', kind: 'plan', phases: 3, ready: [] },
        { slug: 'c', kind: 'document', phases: 0, ready: [] },
      ],
      [{ status: 'pending' }, { status: 'resolved' }],
      4,
    );
    expect(counts).toEqual({
      plans: 2,
      phases: 11,
      ready: 2,
      approvals: 1,
      // Now's badge. The same figure as `approvals` today and deliberately its
      // own key: Phase 4's `/api/inbox` widens what it counts (errands, gates,
      // sign-ins) without renaming the badge on every surface that reads it.
      needsYou: 1,
      // The header chip: with no inbox passed, both fall back to the pending
      // approvals — a chip reading 0 over a parked session is worse.
      asks: 1,
      sessions: 0,
      unread: 4,
      agentSessions: 0,
      terminalSessions: 0,
      mcpAttention: 0,
    });
  });

  it('badges each session page with its own live count, ignoring ended records', () => {
    // One registry, two pages: a single number on both would read as
    // double-counting, and an ended record is history rather than something
    // running — a badge that counted it would never go back to zero.
    const counts = shellCounts(undefined, undefined, 0, [
      { kind: 'claude' },
      { kind: 'claude', exited: { code: 0 } },
      { kind: 'shell' },
      { kind: 'shell' },
      { kind: 'shell', exited: { code: 1 } },
      // A record from a server that predates `kind` is a shell.
      {},
    ]);
    expect(counts.agentSessions).toBe(1);
    expect(counts.terminalSessions).toBe(3);
    // Sessions is ONE destination in 3.0, so its badge is the total of both
    // kinds — the two figures above stay for the panes inside it.
    expect(counts.sessions).toBe(4);
  });

  // The badge links straight to the departures board, so it has to promise
  // exactly what that board will show — and the board drops closed plans. The
  // census beside it (`plans`, `phases`) keeps counting everything, the same
  // split the server makes: closing a plan quiets it, it does not delete it.
  it('leaves a closed plan out of the ready badge but keeps it in the census', () => {
    const counts = shellCounts(
      [
        { slug: 'a', kind: 'plan', phases: 8, ready: [1, 2], status: 'active' },
        { slug: 'b', kind: 'plan', phases: 4, ready: [3, 4], status: 'abandoned' },
      ],
      undefined,
      0,
    );
    expect(counts.ready).toBe(2); // only plan a
    expect(counts.plans).toBe(2); // census: both
    expect(counts.phases).toBe(12); // census: both
  });

  it('counts only live asks off the inbox — an approval and a session-ask count, a gate does not', () => {
    const counts = shellCounts(undefined, undefined, 0, undefined, undefined, [
      { severity: 'urgent', kind: 'approval' },
      { severity: 'urgent', kind: 'session-ask' },
      { severity: 'needs-you', kind: 'gate' },
      { severity: 'fyi', kind: 'ruling' },
    ]);
    expect(counts.asks).toBe(2);
    // …while needsYou keeps its wider promise: everything non-fyi.
    expect(counts.needsYou).toBe(3);
  });

  it('falls back to the pending approvals for a server with no inbox', () => {
    const counts = shellCounts(undefined, [{ status: 'pending' }, { status: 'allow' }], 0);
    expect(counts.asks).toBe(1);
  });

  it('survives an empty cache', () => {
    expect(shellCounts(undefined, undefined, 0)).toEqual({
      plans: 0,
      phases: 0,
      ready: 0,
      approvals: 0,
      needsYou: 0,
      asks: 0,
      sessions: 0,
      unread: 0,
      agentSessions: 0,
      terminalSessions: 0,
      mcpAttention: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

describe('keys.after* — the named invalidation bundles', () => {
  it('names what a plan write moves, and drops the plan key when there is no slug', () => {
    expect(keys.afterPlanWrite('cart')).toEqual([['plans'], ['stats'], ['plan', 'cart']]);
    // `releaseAllExpired` touches no single plan; a bundle holding
    // `['plan', 'undefined']` would invalidate a cache entry nothing holds.
    expect(keys.afterPlanWrite()).toEqual([['plans'], ['stats']]);
  });

  it('reaches the run from a gate and a review, because both can free one', () => {
    expect(keys.afterGate('cart')).toContainEqual(['run', 'cart']);
    expect(keys.afterReview('cart', 4)).toEqual([
      ['plan', 'cart', 'review', '4'],
      ['plan', 'cart'],
      ['plans'],
    ]);
  });

  it('a run verb is the UNION the two hand-rolled copies each had half of', () => {
    // `run-page.tsx` re-read run + approvals + plan; `lane-controls.tsx` re-read
    // runs + run. Neither was wrong; each was missing what the other had.
    expect(keys.afterRunAct('cart')).toEqual([['run', 'cart'], ['runs'], ['plan', 'cart'], ['approvals']]);
  });

  it('an inbox verb is the widest bundle, and honestly so', () => {
    // `human-steps` (control-tower phase 42): a step row's verb moves the ledger the card reads.
    expect(keys.afterInboxAct()).toEqual([
      ['inbox'],
      ['runs'],
      ['plans'],
      ['approvals'],
      ['state'],
      ['human-steps'],
    ]);
    expect(keys.afterRunLaunch()).toEqual([['runs'], ['plans'], ['stats'], ['state']]);
    // A save moves the values a page runs with AND where each came from
    // (quiet-console phase 21: the settings schema).
    expect(keys.afterPrefs()).toEqual([['state'], ['prefs-schema']]);
  });

  it('every bundle is made of real keys — never a key spelled out again', () => {
    // The whole point: a bundle is a NAME for a set of `keys.*` calls. A member
    // written as a literal is a member that stops moving when its key changes.
    const bundles = [
      keys.afterPlanWrite('x'),
      keys.afterGate('x'),
      keys.afterReview('x', 1),
      keys.afterRunAct('x'),
      keys.afterRunLaunch(),
      keys.afterInboxAct(),
      keys.afterPrefs(),
    ];
    for (const bundle of bundles) {
      for (const key of bundle) expect(Array.isArray(key)).toBe(true);
    }
  });
});

describe('Your turn is read with the inbox it is projected from (control-tower phase 137)', () => {
  const answer = (state: string, attempts = 0) => ({
    round: { at: '2026-10-07T12:00:00.000Z', n: 3, ranAt: null, changedAt: null },
    headline: '1 to do now.',
    groups: {
      now: [{ item: 's1', record: 'ledger', group: 'now', rows: [], step: { id: 's1', state, attempts } }],
      decide: [],
      upcoming: [],
      checking: [],
      done: [],
    },
    handled: [],
    counts: { now: 1, decide: 0, upcoming: 0, checking: 0, done: 0, total: 1, handled: 0 },
    seen: null,
    issues: null,
  });

  it('sits under the inbox prefix, so every inbox re-read re-reads it too', () => {
    expect(keys.turn().slice(0, 1)).toEqual(keys.inbox());
    expect(keys.turn()).toEqual(['inbox', 'turn']);
    expect(keys.turn('2026-10-07T10:00:00.000Z')).toEqual(['inbox', 'turn', '2026-10-07T10:00:00.000Z']);
    // The widest bundle reaches it, and no bundle had to learn its name.
    expect(keys.afterInboxAct()).toContainEqual(keys.inbox());
  });

  it('a round that changed the turn, a step that moved and an inbox change each re-read it', () => {
    for (const name of ['turn', 'human-step', 'inbox'] as const) {
      const client = new QueryClient();
      client.setQueryData(keys.turn(), answer('notified'));
      client.setQueryData(keys.turn('2026-10-07T10:00:00.000Z'), answer('notified'));
      applyEffect(client, name, name === 'human-step' ? { step: { id: 's1', state: 'opened' } } : {});
      expect(client.getQueryState(keys.turn())?.isInvalidated, name).toBe(true);
      expect(client.getQueryState(keys.turn('2026-10-07T10:00:00.000Z'))?.isInvalidated, name).toBe(true);
    }
  });

  it('a step that moved is patched into its item in place, before the re-read lands', () => {
    const client = new QueryClient();
    client.setQueryData(keys.turn(), answer('notified'));
    applyEffect(client, 'human-step', { step: { id: 's1', state: 'checking', attempts: 1 } });
    const now = (client.getQueryData(keys.turn()) as ReturnType<typeof answer>).groups.now[0]!;
    expect(now.step).toMatchObject({ id: 's1', state: 'checking', attempts: 1 });
    // Another item's step is left exactly as it was.
    applyEffect(client, 'human-step', { step: { id: 'other', state: 'proven' } });
    expect((client.getQueryData(keys.turn()) as ReturnType<typeof answer>).groups.now[0]!.step.state).toBe(
      'checking',
    );
  });
});
