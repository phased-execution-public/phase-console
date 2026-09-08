/**
 * What the page does before it has anything to show.
 *
 * Phase 4's subject is the *order* of the first few seconds, and every defect
 * it fixed had the same shape: nothing was broken, nothing logged, and the work
 * simply happened later than it needed to. That makes them invisible to the
 * ordinary tests — a page that renders correctly after four serial round trips
 * renders correctly — so the assertions here are all about WHEN, and each one
 * is written so that undoing its change turns it red. The comment above each
 * names the undo.
 *
 * ⚠️ Read `features/plans/tabs.test.ts` before adding to this file: it holds
 * the render-tree walk and its five documented blind spots. Nothing here
 * replaces it — this file is about timing, that one is about reachability.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { RouteTab } from '@/features/plans/route-tab';
import { TooltipProvider } from '@/components/ui';
import { ROUTE_TABLE, preloadView, type PageRoute } from '@/app/router';
import { EVENT_EFFECTS, applyEffect, keys, queryClientConfig } from '@/lib/queries';
import { PERSISTED_ROOTS, shouldPersistQuery } from '@/lib/persist';
import { afterLoadIdle } from '@/lib/pwa';
import type { ConsoleState, PlanDetail } from '@/lib/api';

const { state, prompt } = vi.hoisted(() => ({ state: vi.fn(), prompt: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      prompt,
      plans: vi.fn(async () => []),
      stats: vi.fn(async () => null),
      approvals: vi.fn(async () => []),
      runs: vi.fn(async () => []),
      nextPrompt: vi.fn(async () => 'banner'),
    },
  };
});

const ROOT = '/repo';

const READY_STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  root: { path: ROOT, ok: true, planCount: 3, handoffCount: 2 },
  unread: 0,
};

function client() {
  return new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#/now';
  state.mockResolvedValue(READY_STATE);
});

/* ------------------------------------------------------------------ *
 * 1. The route's chunk is asked for before /api/state answers
 * ------------------------------------------------------------------ */

describe('the route chunk does not wait for /api/state', () => {
  /**
   * UNDO THAT REDS THIS: move `useEffect(() => preloadView(head), [head])` in
   * `App.tsx` below either of the two early returns (`!state`, `target`).
   *
   * That is exactly where the cost was. `React.lazy` calls its loader when the
   * element RENDERS, and the shell returned a spinner above `resolveView(head)`
   * — so on a cold `#/plan/<slug>` the plan chunk did not begin downloading
   * until a `/api/state` it does not depend on had come back.
   *
   * The state promise here NEVER resolves, so a passing assertion cannot mean
   * "the preload happened to be fast".
   */
  it('asks for the plan chunk while /api/state is still pending', async () => {
    state.mockImplementation(() => new Promise<ConsoleState>(() => {}));
    window.location.hash = '#/plan/demo';
    const spy = vi.spyOn(ROUTE_TABLE.plan as PageRoute, 'preload');

    render(
      <QueryClientProvider client={client()}>
        <App />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  /**
   * The other half, and the reason the shell can afford to render at all: with
   * no state there is still chrome on screen rather than one page-wide spinner.
   *
   * UNDO THAT REDS THIS: restore `if (!state) return <Spinner label="Starting"/>`.
   */
  it('paints the shell rather than a page-wide spinner', async () => {
    state.mockImplementation(() => new Promise<ConsoleState>(() => {}));
    window.location.hash = '#/plan/demo';

    render(
      <QueryClientProvider client={client()}>
        <App />
      </QueryClientProvider>,
    );

    // A skeleton where the page will be…
    expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
    // …inside the REAL shell, not instead of it. The nav is the chrome that
    // used to arrive only after `/api/state`, which is why a plan open looked
    // like two page loads rather than one.
    expect(screen.getByText('Plans')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  /**
   * An alias must not preload the page it is about to leave.
   *
   * UNDO THAT REDS THIS: make `preloadView` fall through to `DEFAULT_HEAD` for
   * a redirect entry instead of returning.
   */
  it('preloads nothing for a redirect head', () => {
    const spy = vi.spyOn(ROUTE_TABLE.now as PageRoute, 'preload');
    preloadView('dashboard');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/* ------------------------------------------------------------------ *
 * 2. Opening a plan issues no prompt requests
 * ------------------------------------------------------------------ */

const DETAIL = {
  summary: {
    slug: 'demo',
    title: 'demo plan',
    kind: 'plan',
    status: 'active',
    phases: 4,
    done: 1,
    ready: [2, 3, 4],
    waiting: 0,
    inProgress: [],
    stuck: [],
    qaMode: 'off',
    budget: 200_000,
  },
  phases: [
    { phase: 1, title: 'One', state: 'done', size: 'M', weight: 40_000, gated: false },
    { phase: 2, title: 'Two', state: 'ready', size: 'M', weight: 40_000, gated: false },
    { phase: 3, title: 'Three', state: 'ready', size: 'S', weight: 15_000, gated: false },
    { phase: 4, title: 'Four', state: 'ready', size: 'S', weight: 15_000, gated: false },
  ],
  handoffs: [],
  route: { nodes: [], edges: [], layers: 0, rows: 0 },
  lint: { ok: true, issues: [], summary: 'LINT OK', timedOut: false },
} as unknown as PlanDetail;

describe('opening a plan spends no engine invocations', () => {
  /**
   * UNDO THAT REDS THIS: delete `collapsed` from the ready-phase `PromptCard`s
   * in `features/plans/route-tab.tsx`.
   *
   * Each boot prompt is a `phase-graph.sh` shell-out SERVER-side, and
   * `PromptCard` fetches on `enabled: open`. Three ready phases meant three
   * engine runs on the same page load as everything else — for text nobody had
   * asked to see. The board above already says which phases are ready.
   */
  it('issues no prompt request for a ready phase until its card is opened', async () => {
    render(
      <QueryClientProvider client={client()}>
        <TooltipProvider>
          <RouteTab detail={DETAIL} />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    // Three ready phases, three cards, and a Show button on each.
    const cards = await screen.findAllByText(/Boot prompt — phase/);
    expect(cards).toHaveLength(3);

    // An ABSENCE assertion, so it needs a real window rather than one tick —
    // a `PromptCard` that fetched on mount would have done so by now.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(prompt).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * 3. A reload paints from the store
 * ------------------------------------------------------------------ */

describe('the persisted cache', () => {
  /**
   * UNDO THAT REDS THIS: add `'terminal'`, `'accounts'` or `'sessions'` to
   * `PERSISTED_ROOTS` — or, the mistake this actually caught, add `'plan'`.
   *
   * The allowlist is the whole safety argument, and `'plan'` is the trap in it:
   * EVERY plan-scoped key hangs off the `['plan', slug]` prefix, so a rule that
   * matched the key's first element persisted the raw markdown, the gate, the
   * landing packet and a boot prompt per phase — a dozen engine shell-outs —
   * alongside the board. The first version of `shouldPersistQuery` did exactly
   * that and this test is why it does not.
   */
  it('persists a plan board and its projections, and nothing else under the prefix', () => {
    expect(shouldPersistQuery(keys.state())).toBe(true);
    expect(shouldPersistQuery(keys.plans())).toBe(true);
    expect(shouldPersistQuery(keys.plan('demo'))).toBe(true);
    expect(shouldPersistQuery(keys.plan('demo', ['prose', 'handoffs']))).toBe(true);

    for (const key of [
      keys.prompt('demo', 2),
      keys.nextPrompt('demo', 2),
      keys.planRaw('demo'),
      keys.gate('demo', 2),
      keys.landing('demo'),
      keys.handoff('demo', 2),
    ]) {
      expect(shouldPersistQuery(key), `${key.join('/')} is under ['plan'] and must NOT persist`).toBe(false);
    }
    expect(PERSISTED_ROOTS).not.toContain('plan');
  });

  /** Live process facts, which no amount of revalidation makes safe to paint. */
  it('never persists a fact about a process', () => {
    for (const key of [keys.terminal(), keys.accounts(), keys.sessionRegistry(), keys.restart()]) {
      expect(shouldPersistQuery(key), `${String(key[0])} must not survive a reload`).toBe(false);
    }
    expect(PERSISTED_ROOTS).not.toContain('terminal');
  });

  /**
   * UNDO THAT REDS THIS: drop the `onSuccess={() => revalidateRestored(...)}`
   * from `main.tsx`, or make `revalidateRestored` a no-op.
   *
   * `staleTime: Infinity` is the app default, so a restored answer is fresh
   * FOREVER unless something invalidates it — a reload would paint the board
   * from the store and then never ask the server again. That is the silent
   * failure this whole scheme has to avoid, and it is invisible in a browser
   * until a number is a day old.
   */
  it('marks everything it restores as stale, without fetching', async () => {
    const { revalidateRestored } = await import('@/lib/persist');
    const restored = client();
    restored.setQueryData(keys.plans(), []);
    expect(restored.getQueryState(keys.plans())?.isInvalidated).toBeFalsy();

    revalidateRestored(restored);

    expect(restored.getQueryState(keys.plans())?.isInvalidated).toBe(true);
    // The data is still THERE — this is stale-while-revalidate, not a purge.
    expect(restored.getQueryData(keys.plans())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. A warm no longer invalidates unrelated queries
 * ------------------------------------------------------------------ */

describe('a server warm', () => {
  function seeded() {
    const c = client();
    c.setQueryData(keys.state(), READY_STATE);
    c.setQueryData(keys.plans(), [{ slug: 'demo' }]);
    c.setQueryData(keys.terminal(), { sessions: [] });
    return c;
  }
  const stale = (c: QueryClient, key: readonly unknown[]) => Boolean(c.getQueryState(key)?.isInvalidated);

  /**
   * UNDO THAT REDS THIS: put `all: true` back on `EVENT_EFFECTS.warm`.
   *
   * `warm` fires from ONE place, the server's `open()`, so it arrives a moment
   * after console boot — and `invalidateQueries()` with no key threw away the
   * plan a browser had just finished loading, along with the session list, the
   * account meters and everything else. Nothing about a warm changes what an
   * answer would have been: the boards are recomputed from the same files.
   */
  it('re-fetches nothing when the root has not moved', () => {
    const c = seeded();
    applyEffect(c, 'warm', { plans: 3, root: ROOT });

    expect(stale(c, keys.state())).toBe(false);
    expect(stale(c, keys.plans())).toBe(false);
    expect(stale(c, keys.terminal())).toBe(false);
  });

  /**
   * The other direction, and the reason this cannot simply be deleted.
   *
   * UNDO THAT REDS THIS: make `warmedAnotherRoot` return `false` always — i.e.
   * "a warm is never news". A console pointed at another project would then go
   * on rendering the previous project's plans under the new root's name.
   */
  it('re-fetches everything when it warmed a different root', () => {
    const c = seeded();
    applyEffect(c, 'warm', { plans: 3, root: '/somewhere/else' });

    expect(stale(c, keys.state())).toBe(true);
    expect(stale(c, keys.plans())).toBe(true);
    expect(stale(c, keys.terminal())).toBe(true);
  });

  /** A server too old to name the root it warmed is treated as a move. */
  it('re-fetches everything when the payload does not say', () => {
    const c = seeded();
    applyEffect(c, 'warm', { plans: 3 });
    expect(stale(c, keys.plans())).toBe(true);
  });

  /**
   * The boot case, stated on its own because it is the one the old behaviour
   * got wrong every single time: a tab still loading holds nothing stale, and
   * anything already in flight is being answered by the server that just
   * warmed.
   */
  it('re-fetches nothing when the tab holds no state yet', () => {
    const c = client();
    applyEffect(c, 'warm', { plans: 3, root: '/anything' });
    expect(
      c
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.isInvalidated),
    ).toHaveLength(0);
  });

  /**
   * `allWhen` answers for the WHOLE event, both ways — `false` must not fall
   * through to the narrower `invalidate` list.
   *
   * UNDO THAT REDS THIS: in `applyEffect`, drop the `return` after the
   * `allWhen` branch.
   */
  it('is a decision about the whole event, not a filter in front of one', () => {
    expect(EVENT_EFFECTS.warm.invalidate).toBeUndefined();
    const c = seeded();
    applyEffect(c, 'warm', { plans: 0, root: ROOT });
    expect(
      c
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.isInvalidated),
    ).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The service worker registers after first paint
 * ------------------------------------------------------------------ */

describe('the service worker', () => {
  /**
   * UNDO THAT REDS THIS: call `run()` directly in `afterLoadIdle` instead of
   * scheduling it.
   *
   * Registration fetches the worker and then its 1,546,440 B precache across 51
   * entries with `cache: 'reload'` — a deliberate bypass of the HTTP cache —
   * all of it competing with the first plan open. The precache is for the
   * SECOND visit.
   */
  it('does not run its work in the same tick as the mount', async () => {
    const run = vi.fn();
    const cancel = afterLoadIdle(run);

    expect(run).not.toHaveBeenCalled();
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    cancel();
  });

  /**
   * UNDO THAT REDS THIS: drop `stopWaiting()` from `useServiceWorker`'s
   * cleanup, or the `cancelled` guard from `afterLoadIdle`.
   *
   * A shell that unmounts before the idle callback fires must not still
   * register a worker for a page that is gone — the failure mode a deferred
   * side effect always has.
   */
  it('does not run at all if it is cancelled first', async () => {
    const run = vi.fn();
    afterLoadIdle(run)();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(run).not.toHaveBeenCalled();
  });
});
