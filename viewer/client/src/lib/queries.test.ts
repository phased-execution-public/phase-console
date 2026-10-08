/**
 * The data-plane guard, on both directions of the plane.
 *
 * READING: the failure this prevents is quiet — the server grows an event,
 * nothing on the client listens for it, and a screen simply stops updating for
 * that one case, with no error, no console warning, and a page that looks
 * alive. Making the event→effect table total, and asserting it, turns that into
 * a red test.
 *
 * WRITING: the failure is the same shape from the other side. A mutation's
 * invalidation set is a CLAIM about what the write moved, it was written out at
 * every call site, and the copy that forgets a member is not a crash — it is a
 * card that stays on screen after it has been answered. The `keys.after*` cases
 * pin what each name means; the `useApiMutation` cases pin the two rules the
 * hand-rolled copies disagreed about: the re-read happens on FAILURE too, and
 * it is never awaited.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted, because `vi.mock` is hoisted above the imports it replaces and a
// plain `const` would be in its temporal dead zone when the factory runs.
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return { ...actual, toast };
});

import { SSE_EVENTS } from './sse';
import {
  EVENT_EFFECTS,
  applyEffect,
  keys,
  queryClientConfig,
  shellCounts,
  toastError,
  useApiMutation,
} from './queries';
import type { RunState } from './api';
import { nowLanes } from '@/features/runs/lanes-model';
import { Strip } from '@/features/runs/tower/strip';

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

  it('carries every wire name, run events included — 29 free, five more Pro', () => {
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
    expect(SSE_EVENTS).toHaveLength(31 + proNames.length);
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
    expect(keys.afterPrefs()).toEqual([['state']]);
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

describe('toastError', () => {
  beforeEach(() => {
    toast.mockClear();
  });

  it('prints an Error’s own message', () => {
    toastError(new Error('the engine said no'));
    expect(toast).toHaveBeenCalledWith('the engine said no', 'error');
  });

  it('prints a thrown string and a plain rejection object — the dialect that rendered `undefined`', () => {
    toastError('the socket closed');
    expect(toast).toHaveBeenCalledWith('the socket closed', 'error');
    toastError({ message: 'HTTP 409' });
    expect(toast).toHaveBeenCalledWith('HTTP 409', 'error');
  });

  it('never renders `undefined` at a person — the console admits it does not know', () => {
    toastError(undefined);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('could not say'), 'error');
    toastError(new Error(''));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('could not say'), 'error');
    // Nor `[object Object]`: a rejection with no words of its own has none.
    toastError({ code: 500 });
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('could not say'), 'error');
  });
});

describe('useApiMutation', () => {
  beforeEach(() => {
    toast.mockClear();
  });

  /** A live client, so the invalidation set is observed rather than mocked. */
  function mount<TArgs, TResult>(options: Parameters<typeof useApiMutation<TArgs, TResult>>[0]) {
    const client = new QueryClient(queryClientConfig);
    const invalidated: unknown[][] = [];
    const spy = vi
      .spyOn(client, 'invalidateQueries')
      .mockImplementation((filters?: { queryKey?: unknown }) => {
        invalidated.push(filters?.queryKey as unknown[]);
        return Promise.resolve();
      });
    const seen: { current: ReturnType<typeof useApiMutation<TArgs, TResult>> | null } = { current: null };
    function Host() {
      seen.current = useApiMutation<TArgs, TResult>(options);
      return null;
    }
    render(createElement(QueryClientProvider, { client }, createElement(Host)));
    return { seen, invalidated, spy };
  }

  it('says the success line, then re-reads the bundle', async () => {
    const { seen, invalidated } = mount<string, { ok: true }>({
      fn: async () => ({ ok: true }),
      say: 'Reopened',
      invalidates: keys.afterPlanWrite('cart'),
    });
    await act(async () => {
      await seen.current!.mutateAsync('cart');
    });
    expect(toast).toHaveBeenCalledWith('Reopened', 'ok');
    expect(invalidated).toEqual([['plans'], ['stats'], ['plan', 'cart']]);
  });

  it('re-reads on FAILURE too — the case where re-reading matters most', async () => {
    // A card answered on a phone leaves this tab holding one that no longer
    // exists; pressing it 404s, and with the re-read inside the success leg it
    // was skipped, so the phantom stayed on screen and the next press 404'd.
    const { seen, invalidated } = mount<void, void>({
      fn: async () => {
        throw new Error('404 — that card is gone');
      },
      invalidates: keys.afterInboxAct(),
    });
    await act(async () => {
      await seen.current!.mutateAsync().catch(() => undefined);
    });
    expect(toast).toHaveBeenCalledWith('404 — that card is gone', 'error');
    expect(invalidated).toHaveLength(keys.afterInboxAct().length);
  });

  it('takes the bundle from the result when only the answer knows the slug', async () => {
    const { seen, invalidated } = mount<void, { slug: string }>({
      fn: async () => ({ slug: 'billing' }),
      invalidates: (result) => (result ? keys.afterPlanWrite(result.slug) : keys.afterPlanWrite()),
    });
    await act(async () => {
      await seen.current!.mutateAsync();
    });
    expect(invalidated).toContainEqual(['plan', 'billing']);
  });

  it('says nothing when `say` returns nothing, and hands `onFail` the error instead of toasting', async () => {
    const onFail = vi.fn();
    const { seen } = mount<void, string>({
      fn: async () => {
        throw new Error('quiet');
      },
      say: () => '',
      onFail,
    });
    await act(async () => {
      await seen.current!.mutateAsync().catch(() => undefined);
    });
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not await the re-read — a button must not stay disabled for a refetch', async () => {
    const { seen, spy } = mount<void, void>({
      fn: async () => undefined,
      invalidates: keys.afterPrefs(),
    });
    await act(async () => {
      await seen.current!.mutateAsync();
    });
    expect(spy).toHaveBeenCalled();
    expect(seen.current!.isPending).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * run:progress reaches the strip (control-tower phase 19, #25)
 * ------------------------------------------------------------------ */

describe('Your turn is read with the inbox it is projected from (control-tower phase 137)', () => {
  const answer = (state: string, attempts = 0) => ({
    round: { at: '2026-10-07T12:00:00.000Z', n: 3, ranAt: null, changedAt: null },
    headline: '1 needs you now.',
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

describe('a run:progress frame patches the strip, with no refetch', () => {
  it('moves the strip’s clock, its word and its in-flight spend from the frame alone', async () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const run = {
      id: 'run-strip01',
      slug: 'console-speed',
      root: '/repo',
      status: 'running',
      model: 'opus',
      autonomy: 'keep-going',
      spentUsd: 4.2,
      runBudgetUsd: 25,
      createdAt: iso(now - 3_600_000),
      updatedAt: iso(now - 60_000),
      activePhase: 6,
      children: { 6: { pid: 106, phase: 6, sessionId: 's6', startedAt: iso(now - 14 * 60_000) } },
      phases: {
        6: {
          phase: 6,
          status: 'running',
          attempts: 1,
          costUsd: 0,
          attemptStartedAt: iso(now - 14 * 60_000),
          startedAt: iso(now - 14 * 60_000),
          liveness: {
            phase: 6,
            lastOutputAt: iso(now - 5_000),
            turnsSinceLastTool: 0,
            commitsSinceStart: 0,
            treeDirty: false,
          },
        },
      },
    } as unknown as RunState;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(keys.state(), { allowRun: true });
    client.setQueryData(keys.runs(), [run]);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ events: [], untrusted: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );

    // The board's own shape: the runs list from the cache, folded to lanes, one strip per run.
    function Board() {
      const { data } = useQuery<RunState[]>({
        queryKey: keys.runs(),
        queryFn: () => Promise.reject(new Error('the strip must not refetch')),
        enabled: false,
      });
      const runs = data ?? [];
      const lanes = nowLanes(runs);
      return createElement(
        'div',
        null,
        runs.map((r) =>
          createElement(Strip, {
            key: r.id,
            run: r,
            lanes: lanes.filter((l) => l.runId === r.id),
            allowRun: true,
          }),
        ),
      );
    }
    render(createElement(QueryClientProvider, { client }, createElement(Board)));
    expect(screen.getByTestId('strip-clock').textContent).toMatch(/^running 14m/);
    expect(screen.getByTestId('strip-cost').textContent).toBe('$4.20/$25.00');

    // A new attempt boards; this session has spent $2.50 so far.
    // (The cache notifies its observers on the next tick — hence `waitFor`.)
    const frame = (status: string) => ({
      slug: 'console-speed',
      runId: 'run-strip01',
      phase: 6,
      status,
      attempt: 2,
      attemptStartedAt: iso(now - 30_000),
      spentUsd: 2.5,
      phaseClocks: {
        sinceFirstBoardedMs: 14 * 60_000,
        sinceThisAttemptMs: 30_000,
        workedMs: 14 * 60_000,
        queuedMs: null,
        attemptWindows: [
          { attempt: 1, startedAt: iso(now - 14 * 60_000), endedAt: iso(now - 60_000) },
          { attempt: 2, startedAt: iso(now - 30_000) },
        ],
        timeToFirstToolMs: null,
      },
    });
    await act(async () => EVENT_EFFECTS['run:progress'].patch!(client, frame('running')));
    // The frame's window is the clock's anchor: the new attempt, not the old one's 14 minutes.
    await waitFor(() => expect(screen.getByTestId('strip-clock').textContent).toMatch(/^running 3\ds$/));
    expect(screen.getByTestId('strip-cost').textContent).toBe('$6.70/$25.00');

    // The session hands over to the console's check: the word on the glance moves with it.
    await act(async () => EVENT_EFFECTS['run:progress'].patch!(client, frame('verifying')));
    await waitFor(() => expect(screen.getByTestId('strip-clock').textContent).toMatch(/^verifying /));

    expect(invalidate).not.toHaveBeenCalled();
    // Nothing asked for the run again — the only requests a strip may make are its lane's activity
    // line and its why line's sources (control-tower phase 102): the phase's own report and, in
    // the Pro tree, the supervisor's read. None of them is the run.
    const allowed = (url: string) =>
      url.includes('/activity') ||
      url.endsWith('/report') ||
      false;
    const asked = fetch.mock.calls.map(([url]) => String(url)).filter((url) => !allowed(url));
    expect(asked).toEqual([]);
    fetch.mockRestore();
  });
});
