/**
 * Logs: every log this console writes, the retention behind them, the bundle,
 * the doctor and the log level — plus, in Pro, a run's trace and its git
 * commands.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { DebugLevel, DebugSource, HealthSeriesView } from '@shared/wire/debug.js';
import { request } from './http';
import { keys } from './keys';

/* ---------------- the Logs place ---------------- */

/**
 * How long a log read stays fresh.
 *
 * Shorter than Repo's, and for the opposite reason: a commit graph is
 * expensive and rarely moves, while a log is cheap to re-read and moves
 * constantly — a person on this page is asking what is happening NOW. It is
 * still not a timer: nothing here polls, and the surface that genuinely needs
 * live rows opens the follow tail (`useLogTail`, `screens/logs/tail.ts`) instead, which is a stream
 * the reader turns on rather than a cost the page pays whether or not anyone
 * is watching.
 */
const DEBUG_STALE = 5_000;

/**
 * The index's parameters — what the Logs page asks the index (and the follow
 * stream) for. A client-side shape: it becomes a query string, never a body.
 *
 * `type`, not `interface` — only a type alias is assignable to the
 * `Record<string, …>` the query builder takes, the same reason `repo.ts` gives.
 */
export type DebugIndexParams = {
  source?: DebugSource[];
  level?: DebugLevel[];
  slug?: string;
  run?: string;
  phase?: number;
  /** One trace, exactly: the run's whole story and nothing that merely shares its clock. */
  trace?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
};

export function useDebugIndex(params: DebugIndexParams, enabled = true) {
  return useQuery({
    queryKey: keys.debugIndex(params),
    queryFn: () => api.debugIndex(params),
    enabled,
    staleTime: DEBUG_STALE,
  });
}

/**
 * What every sink this console writes is using, and what the next sweep would
 * do about it.
 *
 * A read with no capability behind it — seeing your own disk is display — and
 * a slow-ish one: it walks the state directory. The stale time is longer than
 * the other debug queries because nothing in the retention table moves in
 * seconds, so a card left open must not re-walk every plan's run directory on
 * a five-second clock.
 */
export function useRetention(enabled = true) {
  return useQuery({
    queryKey: keys.debugRetention(),
    queryFn: () => api.debugRetention(),
    enabled,
    staleTime: 60_000,
  });
}

export function useDebugRuns(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.debugRuns(slug ?? ''),
    queryFn: () => api.debugRuns(slug as string),
    // A run list for no plan is not a request. `enabled` rather than a guard
    // inside `queryFn`, so the hook reports `isPending` forever instead of
    // resolving to an empty list that reads as "this plan has no runs".
    enabled: enabled && Boolean(slug),
    staleTime: DEBUG_STALE,
  });
}

/**
 * The bundle.
 *
 * Deliberately NOT enabled by default: assembling one reads every source and
 * renders a metrics scrape, and Logs ▸ Health must not pay that on every
 * visit for a payload most visits never copy. The section enables it when the
 * reader asks.
 */
export function useDebugBundle(params: { slug?: string } = {}, enabled = false) {
  return useQuery({
    queryKey: keys.debugBundle(params),
    queryFn: () => api.debugBundle(params),
    enabled,
    staleTime: DEBUG_STALE,
  });
}

/**
 * The doctor runs the start's probes — `gh`, the CLI, the hooks — so it is
 * read when the Health section asks, and a minute's answer is reused.
 */
export function useDoctor(enabled = true) {
  return useQuery({ queryKey: keys.doctor(), queryFn: api.doctor, enabled, staleTime: 60_000 });
}

export function useDebugLevel() {
  return useQuery({ queryKey: keys.debugLevel(), queryFn: api.debugLevel, staleTime: DEBUG_STALE });
}

/** What the level card sends: the floor, the channels written whatever it is, and for how long. */
export interface LogLevelChange {
  level: string;
  /** A csv of event prefixes (`git, runner`) or `*`; empty clears every channel for the change's life. */
  debug: string;
  ttlMs: number;
}

/**
 * The level card's two writes. `setLevel` is `POST /api/debug/level` with all
 * three fields — the floor, the debug channels and the change's life; the
 * server reverts it by itself at the deadline — and `revertLevel` is the
 * `DELETE` that drops it at once. Either answer is the new state, written
 * straight into the level's cache entry, so the card reads what the server
 * did rather than what was asked.
 */
export function useLogLevelWrite() {
  const client = useQueryClient();
  const write = useMutation({
    mutationFn: (next: LogLevelChange | null) =>
      next
        ? api.setDebugLevel({ level: next.level, debug: next.debug, ttlMs: next.ttlMs })
        : api.revertDebugLevel(),
    onSuccess: (state) => client.setQueryData(keys.debugLevel(), state),
  });
  return {
    setLevel: (next: LogLevelChange) => write.mutateAsync(next),
    revertLevel: () => write.mutateAsync(null),
    pending: write.isPending,
    error: write.error,
  };
}

/**
 * One scrape of the Prometheus exposition, as the text it is. The parse is the
 * page's (`screens/logs/runtime.ts`): the wire carries text, and what a gauge
 * means is Logs ▸ Health's business.
 */
export function readMetricsScrape(): Promise<string> {
  return request<string>('/api/metrics');
}

/**
 * The console's runtime gauges, re-read every 15 s while something shows
 * them. The scrape's reader is the page's own (`screens/logs/runtime.ts`
 * parses `readMetricsScrape`), handed in here because the query hooks live in
 * `data/` and the exposition's parse does not belong in the wire.
 */
export function useRuntime<T>(read: () => Promise<T>, refetchMs = 15_000) {
  return useQuery({
    queryKey: keys.debugRuntime(),
    queryFn: read,
    refetchInterval: refetchMs,
    staleTime: 10_000,
  });
}

export type { HealthSeriesPointView, HealthSeriesView } from '@shared/wire/debug.js';

export const healthSeriesApi = {
  series: () => request<HealthSeriesView>('/api/health/series'),
};

/** The series, re-read every five minutes — the sampler's own cadence. */
export function useHealthSeries() {
  return useQuery({
    queryKey: ['health', 'series'],
    queryFn: healthSeriesApi.series,
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

