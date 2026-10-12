/**
 * Plans: the list, one plan's projections and everything read off it — its
 * handoffs, the raw markdown, the gate, the review, the notes and the landing
 * — and the portfolio's totals.
 */

import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { plural } from '@/lib/format';
import { toast } from '@/ui/toast';
import { api, type LockFilter, type PlanDetail } from './api';
import { keys } from './keys';
import { press } from './press';

export function usePlans(enabled = true) {
  return useQuery({ queryKey: keys.plans(), queryFn: api.plans, enabled });
}

/**
 * One plan, and the fix for the defect that made the old plan view unusable
 * while anything else was happening.
 *
 * The old view held the detail in `useState`, and its `changed` subscriber set
 * it back to `null` before refetching — so *any* write anywhere in the repo
 * (another session finishing a phase, a file saved in an editor, the watcher
 * warming) blanked the page you were reading to a spinner and scrolled you back
 * to the top. `placeholderData: keepPreviousData` is the whole fix: the last
 * answer stays on screen while the next one is fetched, including across a slug
 * change, and `isFetching` is what says "a newer one is coming".
 */
/**
 * `include` names the projection groups this caller needs beyond the board —
 * `shared/projection.js`. Omit it and you get the board: what the Route tab,
 * the dashboard rows, the gate card and the command palette all read, and the
 * only variant `usePlanDetails` ever fetches.
 *
 * ⚠️ **Pass a STABLE array.** A fresh literal each render is a fresh query key
 * each render. Every caller here passes a module-level constant from
 * `tabs.ts`'s `TAB_INCLUDES`, via `includesForTab()`.
 */
export function usePlan(slug: string | undefined, include?: readonly string[]) {
  return useQuery({
    queryKey: keys.plan(slug ?? '', include),
    queryFn: () => api.plan(slug!, { include }),
    enabled: Boolean(slug),
    placeholderData: keepPreviousData,
  });
}

/**
 * The engine pool, polled every second while `enabled` — only while a plan
 * page's own read is still pending, so "computing the board (N queued)" can
 * say why the page is empty (#44). Nothing polls it otherwise.
 */
export function useEngineQueue(enabled: boolean) {
  return useQuery({
    queryKey: ['engine-queue'] as const,
    queryFn: () => api.engineQueue(),
    enabled,
    refetchInterval: enabled ? 1000 : false,
  });
}

/**
 * Fetch a plan's board BEFORE anyone has asked for it — on hover, on focus.
 *
 * A pointer resting on a row, or a Tab landing on it, is the cheapest reliable
 * signal there is that the next click is that row: it buys the round trip that
 * would otherwise happen after the click, while the reader is still deciding.
 *
 * Three things keep it from being a way to spend requests:
 *
 * - `prefetchQuery` is a no-op when the key already holds fresh data, and with
 *   `staleTime: Infinity` everything already fetched IS fresh — so hovering the
 *   same row ten times costs one request, not ten.
 * - The include set has to be the one the DESTINATION will ask for, which is
 *   why it is a parameter and defaults to the board projection. A prefetch of
 *   a different set warms a key nothing reads and the page then pays twice —
 *   the failure mode is invisible, because both requests succeed.
 * - A failure is swallowed. A prefetch nobody asked for must never surface an
 *   error; the real query will ask again and report properly.
 */
export function usePrefetchPlan(): (slug: string | undefined, include?: readonly string[]) => void {
  const client = useQueryClient();
  return useCallback(
    (slug: string | undefined, include?: readonly string[]) => {
      if (!slug) return;
      void client
        .prefetchQuery({
          queryKey: keys.plan(slug, include),
          queryFn: () => api.plan(slug, { include }),
        })
        .catch(() => {
          /* see the note above */
        });
    },
    [client],
  );
}

/** The two DOM props that mean "this is probably next" — spread onto a row or a link. */
export function prefetchIntent(
  prefetch: (slug: string, include?: readonly string[]) => void,
  slug: string,
  include?: readonly string[],
) {
  return {
    onMouseEnter: () => prefetch(slug, include),
    onFocus: () => prefetch(slug, include),
  };
}

/**
 * Several plans at once, under the same `['plan', slug]` keys as `usePlan`.
 *
 * The ready queue and the dashboard both need facts `/api/plans` does not carry
 * — a phase's title, its size, whether it is gated, how much it unblocks — and
 * those live in the per-plan detail. Fetching them here rather than adding a
 * server endpoint keeps the frozen API frozen, and because the keys are shared,
 * the board warms the cache for exactly the plans you are most likely to open
 * next: clicking through to one is then instant.
 *
 * The cost is bounded by the caller passing a short list, and by the server's
 * own cache — a cold plan costs an engine invocation, a warm one costs nothing.
 * Callers render from the summary first and let each row upgrade as its detail
 * lands, so a slow plan delays a title, never the page.
 *
 * ⚠️ **The map is built in a `useMemo`, not in `useQueries`' `combine`.** A
 * `combine` that returns a `Map` returns a value TanStack's structural sharing
 * cannot compare, so every render produces a new snapshot for the
 * `useSyncExternalStore` behind `useQueries` — which re-renders, which combines
 * again. The symptom is not a slow page: React blows the update-depth limit and
 * throws during render, so the *whole app* goes blank and the console only says
 * "an error occurred in <ReadyView>". Keep the derived shape out of `combine`.
 */
export function usePlanDetails(slugs: readonly string[], enabled = true) {
  const results = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: keys.plan(slug),
      queryFn: () => api.plan(slug),
      enabled,
      // A plan whose engine run fails should leave a row un-enriched, not retry
      // a shell-out at somebody several times over.
      retry: false,
    })),
  });

  const bySlug = useMemo(() => {
    const map = new Map<string, PlanDetail>();
    results.forEach((result, i) => {
      if (result.data) map.set(slugs[i], result.data);
    });
    return map;
    // `results` is a fresh array each render, so this recomputes each time. That
    // is a dozen map writes, and it is the price of not handing React a value it
    // has to diff. It cannot loop: nothing here feeds a store.
  }, [results, slugs]);

  return { bySlug, loading: results.some((r) => r.isPending) };
}

export function useHandoff(slug: string | undefined, phase: number | string | undefined) {
  return useQuery({
    queryKey: keys.handoff(slug ?? '', phase ?? ''),
    queryFn: () => api.handoff(slug!, phase!),
    enabled: Boolean(slug) && phase != null && phase !== '',
    placeholderData: keepPreviousData,
  });
}

export function usePlanRaw(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.planRaw(slug ?? ''),
    queryFn: () => api.planRaw(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * What boarding would find wrong with this plan's §Verification commands.
 *
 * Under the `['plan', slug]` prefix on purpose, unlike the journal and the
 * rulings: it is a reading OF the plan file and of this machine's PATH, so the
 * one thing that invalidates it — the plan changing on disk — is exactly what
 * that prefix already invalidates.
 *
 * Failure is not an error worth retrying at people: a console whose server
 * predates the endpoint 404s, and the health panel's honest answer to that is
 * to say nothing rather than to claim the plan is clean.
 */
export function useVerifyPreflight(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.verifyPreflight(slug ?? ''),
    queryFn: () => api.verifyPreflight(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/**
 * A gate's machine-checkable status. Only asked for phases that declare one —
 * the engine shells out per call, so this is not something to ask idly.
 */
export function useGateStatus(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.gate(slug ?? '', phase ?? ''),
    queryFn: () => api.gate(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    // A gate that cannot be evaluated is not an error worth retrying at people.
    retry: false,
  });
}

/**
 * What earlier phases left for this one — handoff notes, deferral rulings and
 * boot-deliverable mail, in the order the phase's own boot prompt carries them.
 *
 * `enabled` is the caller's: this is a subprocess on the server and it belongs
 * to a sheet somebody opened, not to every plan row on the page. Three small
 * files, so no `keepPreviousData` — a blank beat while switching phases is
 * honest, and stale notes attributed to the wrong phase are not.
 */
export function usePhaseNotes(slug: string | undefined, phase: number | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.notes(slug ?? '', phase ?? ''),
    queryFn: () => api.notes(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    retry: false,
  });
}

/**
 * A phase's diff and the verdict on it.
 *
 * `enabled` is the caller's, because this is the most expensive read on the
 * plan surface — two `git log`s and a `git diff` — and it must not fire for a
 * phase nobody has opened the review for. `keepPreviousData` so switching
 * files inside an open review does not blank the panel.
 */
export function usePhaseReview(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.review(slug ?? '', phase ?? ''),
    queryFn: () => api.review(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    // A repository git cannot read is not an error worth retrying at people.
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/**
 * A plan's landing: the branch, the range, and the packet if one exists.
 *
 * `enabled` is the caller's for the same reason the review's is — this costs a
 * `git status` over the whole tree and a `git log` over the plan's whole range,
 * so it fires when somebody opens the card, not on every plan render.
 */
export function useLanding(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.landing(slug ?? ''),
    queryFn: () => api.landing(slug!),
    enabled: Boolean(slug) && enabled,
    // A source directory that is not a repository is an answer, not an outage.
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/**
 * The launch dialog's one look at what isolation would DO for a plan — cached
 * a minute, asked only while a dialog that shows the control is open.
 */
export function useIsolationPreflight(slug: string | undefined) {
  return useQuery({
    queryKey: slug ? keys.isolationPreflight(slug) : ['plan', 'none', 'isolation-preflight'],
    queryFn: () => api.isolationPreflight(slug!),
    enabled: Boolean(slug),
    staleTime: 60_000,
  });
}

/**
 * The whole portfolio — every plan read, every issue collected.
 *
 * It is invalidated by `changed` like the plans list, because it is the same
 * facts aggregated: a phase landing moves the velocity chart and the ready
 * total, and a stats page that disagrees with the board it sits beside is worse
 * than no stats page.
 */
export function useStats(enabled = true) {
  return useQuery({ queryKey: keys.stats(), queryFn: api.stats, enabled });
}

/**
 * Every phase claim this console can see (#24), narrowed BY THE SERVER when
 * the filter says so — `?held=1`, `?lapsed=1`, `?scope=<repo>` — rather than
 * folded here, so the page asks exactly the question the route answers. A
 * claim changing is a docs change and invalidates every narrowing (all of
 * them live under `['locks']`); a lease LAPSING changes no file, so the list
 * also re-reads on a half-minute clock.
 */
export function useLocks(filter: LockFilter = {}, enabled = true) {
  return useQuery({
    queryKey: keys.lockRows(filter),
    queryFn: () => api.locks(filter),
    enabled,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

const WRITES_OFF = 'Writes are disabled. Restart the console with --allow-writes to release a claim.';

/** Why a release cannot be pressed on this console — said, never a button that does nothing. */
export const releaseRefusal = (allowWrites: boolean): string | undefined =>
  allowWrites ? undefined : WRITES_OFF;

/**
 * Releasing a claim — one press door for every place a lock is seen (the
 * Locks section, a phase's verbs). The owner lives in the lock file and the
 * server reads it (`Service.releaseLock`), so a release carries none. A live
 * lease is refused with the server's own sentence; "already free" is a
 * success; a bulk release reports per claim, because "3 released" over a
 * batch where one refused hides the one line worth reading.
 */
export function useLockRelease(): {
  release: (slug: string, phase: number, force?: boolean) => Promise<boolean>;
  releaseLapsed: () => Promise<number>;
  busy: boolean;
} {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const after = useCallback(
    (slug?: string) => {
      void client.invalidateQueries({ queryKey: keys.plans() });
      void client.invalidateQueries({ queryKey: keys.stats() });
      void client.invalidateQueries({ queryKey: keys.locks() });
      if (slug) void client.invalidateQueries({ queryKey: keys.plan(slug) });
    },
    [client],
  );

  const release = useCallback(
    async (slug: string, phase: number, force = false) => {
      setBusy(true);
      try {
        const pressed = await press(() => api.releaseLock(slug, phase, force));
        if (pressed.state === 'asked') {
          toast(pressed.words, 'info');
          return false;
        }
        toast(
          pressed.result.owner
            ? `Released ${slug} P${phase} — it was held by ${pressed.result.owner}`
            : `${slug} P${phase} was already free`,
          'ok',
        );
        return true;
      } catch (error) {
        // A 409 carries its own sentence ("… is still working this phase").
        toast((error as Error).message, 'warn');
        return false;
      } finally {
        setBusy(false);
        after(slug);
      }
    },
    [after],
  );

  const releaseLapsed = useCallback(async () => {
    setBusy(true);
    try {
      const pressed = await press(() => api.releaseExpiredLocks());
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info');
        return 0;
      }
      const { results, released } = pressed.result;
      const failed = results.filter((one) => !one.ok);
      if (!results.length) toast('No claim has lapsed.', 'ok');
      else if (failed.length) {
        toast(
          `Released ${released} of ${results.length} — ${failed
            .map((one) => `${one.slug} P${one.phase}: ${one.detail ?? 'refused'}`)
            .join('; ')}`,
          'warn',
        );
      } else toast(`Released ${plural(released, 'lapsed claim')}.`, 'ok');
      return released;
    } catch (error) {
      toast((error as Error).message, 'error');
      return 0;
    } finally {
      setBusy(false);
      after();
    }
  }, [after]);

  return { release, releaseLapsed, busy };
}

/* ------------------------------------------------------------------ *
 * The plan page's reads on demand (7.0, quiet-console phase 10)
 * ------------------------------------------------------------------ */

/**
 * One QA report's text — the latest round when `round` is absent. Asked only
 * while the report sheet is open: the address (`?report=`) is what opens it.
 */
export function useQaReport(slug: string, phase: number, round: number | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.qaReport(slug, phase, round),
    queryFn: () => api.qaReport(slug, phase, round),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * The lint, asked again on a person's press — never on mount: the page draws
 * the verdict cached with the plan, and this is the engine's word NOW, for a
 * plan edited a minute ago. `refetch()` is the press.
 */
export function usePlanLint(slug: string) {
  return useQuery({ queryKey: keys.planLint(slug), queryFn: () => api.planLint(slug), enabled: false });
}

/** What is left, in sessions — the unit the console runs (`GET /api/plans/<slug>/work`). */
export function usePlanWork(slug: string, enabled = true) {
  return useQuery({
    queryKey: keys.planWork(slug),
    queryFn: () => api.planWork(slug),
    enabled: Boolean(slug) && enabled,
    staleTime: 60_000,
  });
}

/**
 * A phase's boot prompt — an ENGINE SHELL-OUT on the server, so it is asked
 * only once somebody opens the fold that shows it (`enabled`), never on mount.
 */
export function usePhasePrompt(slug: string, phase: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.prompt(slug, phase),
    queryFn: () => api.prompt(slug, phase),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/** The end-of-phase banner after `phase` — the same shell-out rule as the boot prompt. */
export function useNextPrompt(slug: string, phase: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.nextPrompt(slug, phase),
    queryFn: () => api.nextPrompt(slug, phase),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * The Source view's engine fold: the board as the terminal prints it, the
 * engine's machine block and the session plan — three engine reads, each asked
 * only while its fold is open.
 */
export function useBoardText(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.boardText(slug),
    queryFn: () => api.boardText(slug),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

export function useMemoryBlock(slug: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.memoryBlock(slug),
    queryFn: () => api.memoryBlock(slug),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

export function useSessionPlan(slug: string, model: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.sessionPlan(slug, model),
    queryFn: () => api.sessionPlan(slug, model),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * A phase's QA brief (`phase-graph.sh --qa-prompt`) — what a reviewer session
 * is told. The same shell-out rule as the boot prompt: asked only while the
 * fold that shows it is open.
 */
export function useQaPrompt(slug: string, phase: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.qaPrompt(slug, phase),
    queryFn: () => api.qaPrompt(slug, phase),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}
