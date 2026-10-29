/**
 * Runs: the open run's whole record, and everything read off one run — its
 * journal, transcript, timeline, ledger, attempts, rulings and phase reports —
 * plus the approvals its sessions hold, the start's prelude and the money.
 */

import { useMemo } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { api, runList, runStrip } from './api';
import type {
  AccountRequirement,
  RelayMode,
  RunProofs,
  RunVerifications,
  SessionSizing,
  WeekReportAnswer,
} from '@shared/wire/runs.js';
import { q, request } from './http';
import { keys } from './keys';

/** The measured shapes this module reads — the wire's (`shared/wire/runs.js`), re-exported for their importers. */
export type {
  EtaScore,
  RunProof,
  RunProofs,
  RunVerification,
  RunVerifications,
  SessionCap,
  SessionCapTable,
  SessionSizing,
  SessionsPerPhase,
  WeekMetrics,
  WeekReportAnswer,
} from '@shared/wire/runs.js';

/** The launch draft's answers to probe 5 — fingerprints; waivers as `<phase>:<fp>`. */
export interface VerifyAnswers {
  approve: string[];
  waive: string[];
}

/**
 * What the launch form's draft sends the prelude — client-only: it rides in
 * `GET /api/run/:slug/prelude`'s query, never as a body.
 */
export interface PreludeDraft {
  accounts?: AccountRequirement[];
  relay?: RelayMode;
  resumeOnRestart?: boolean;
  acknowledgedWaivers?: string[];
  model?: string;
  profile?: string;
  mcpPolicy?: string;
  /** Probe 5's question: the phases the run will drive, its autonomy, and the answers so far. */
  onlyPhases?: number[];
  autonomy?: string;
  verifyAnswers?: VerifyAnswers;
  /** Probes 6 and 7: the draft's checkout — whether it cuts a branch, and whether it stands in a tree of its own. */
  gitMode?: string;
  isolation?: string;
}

/** The convergence loop's standing and its last pass per plan (`GET /api/converge`). */
export function useConverge(enabled = true) {
  return useQuery({
    queryKey: keys.converge(),
    queryFn: api.converge,
    enabled,
    staleTime: 15_000,
  });
}

/**
 * A session parked on an approval is invisible until someone looks, so the badge
 * is kept current from wherever you happen to be in the app — but only on a
 * server that has a runner. Asking one that predates it just fills the browser
 * console with 404s.
 */
export function useApprovals(enabled: boolean) {
  return useQuery({ queryKey: keys.approvals(), queryFn: api.approvals, enabled });
}

/**
 * The run-start prelude (phase 11) for the launch form's draft: the manifest
 * with every row's state and the probes' verdicts, recomputed when the
 * draft's answers change. Kept while a new draft loads, so the table never
 * blanks between keystrokes.
 */
export function usePrelude(slug: string | undefined, draft: PreludeDraft, enabled = true) {
  const key = JSON.stringify([
    draft.accounts ?? [],
    draft.relay ?? '',
    draft.resumeOnRestart ?? null,
    draft.acknowledgedWaivers ?? [],
    draft.model ?? '',
    draft.profile ?? '',
    draft.mcpPolicy ?? '',
    draft.onlyPhases ?? [],
    draft.autonomy ?? '',
    draft.verifyAnswers ?? null,
    // Probes 6 and 7 judge the draft's checkout (control-tower phase 22): a
    // branch or isolation changed on the form is a different question.
    draft.gitMode ?? '',
    draft.isolation ?? '',
  ]);
  return useQuery({
    queryKey: keys.prelude(slug ?? '', key),
    queryFn: () => api.runPrelude(slug!, draft),
    enabled: Boolean(slug) && enabled,
    retry: false,
    placeholderData: keepPreviousData,
    select: (data) => data.prelude,
  });
}

/**
 * One plan's run, its history and its ETA.
 *
 * `keepPreviousData` for the same reason the plan detail has it: a run emits
 * `run:phase` every few seconds while it works, and each one invalidates this
 * key. Dropping to a skeleton on every phase event would make the tab unusable
 * precisely while there is something to watch.
 *
 * `enabled` is the stale-server guard. A console whose server predates the
 * autopilot has no run endpoints, and asking anyway just fills the browser
 * console with 404s — the view says so instead.
 */
export function useRun(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.run(slug ?? ''),
    queryFn: () => api.run(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The whole records of a few named runs, by slug — the Sessions rows' lanes
 * (#369): each live run's account, spend, tasks and clocks live only on its
 * whole record, never on the slim list. Under `useRun`'s own key, so the live
 * events that keep the run page fresh keep these fresh too; a handful of
 * reads, never the run list.
 */
export function useRunRecords(slugs: readonly string[], enabled = true) {
  const results = useQueries({
    queries: slugs.map((slug) => ({
      queryKey: keys.run(slug),
      queryFn: () => api.run(slug),
      enabled,
      placeholderData: keepPreviousData,
    })),
  });
  const bySlug = useMemo(() => {
    const map = new Map<string, NonNullable<(typeof results)[number]['data']>>();
    results.forEach((result, i) => {
      if (result.data) map.set(slugs[i]!, result.data);
    });
    return map;
    // `results` is a fresh array each render (the `usePlanDetails` trade).
  }, [results, slugs]);
  return { bySlug };
}

/**
 * Every run of every plan, newest first — each one's WHOLE record.
 *
 * What the 6.2 pages draw, and nothing new should: on a console with history
 * the whole list is megabytes, re-read on every phase event (#234). A list
 * reads `useRunList`, a strip `useRunStrip`, and only the open run `useRun`.
 *
 * `keepPreviousData` for the same reason `useRun` has it, and it matters more
 * here: a live run emits `run:phase` every few seconds and `EVENT_EFFECTS`
 * invalidates this key on each one. Without a placeholder the fleet table — and
 * the dashboard's live strip — would drop to a skeleton every few seconds
 * precisely while there is something to watch.
 */
export function useRuns(enabled = true) {
  return useQuery({
    queryKey: keys.runs(),
    queryFn: api.runs,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * The slim list's key — under `['runs']`, like the strip's (`['runs', 'latest',
 * slug]`), so every event and bundle
 * that re-reads the whole list re-reads them too. Not in `keys`: a member of
 * that object rides first paint, and these have no reader on it.
 */
export const RUN_LIST = ['runs', 'slim'] as const;

/**
 * Every run, slim — what a LIST draws: its status and lifecycle, its halt, the
 * lanes it holds and one word per phase. `keepPreviousData` for `useRuns`'
 * reason: the phase events re-read it while there is most to watch.
 */
export function useRunList(enabled = true) {
  return useQuery({
    queryKey: RUN_LIST,
    queryFn: runList,
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** One plan's newest run, slim — what a strip draws; `null` for a plan that never ran. */
export function useRunStrip(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['runs', 'latest', slug ?? ''] as const,
    queryFn: () => runStrip(slug!),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * A live phase's report — doing, done and left, waiting on, why slow, when
 * (control-tower phase 95, #163). Refreshed by the journal lines that move it,
 * and every half minute besides: the open call and the session's last words
 * move without a journal line.
 *
 * `run` names a PAST run of the plan (quiet-console phase 11, the History
 * view): what that run's record says the phase was doing when it ended. A
 * past run does not move, so it is read once and never polled.
 */
export function usePhaseReport(
  slug: string | undefined,
  phase: number | undefined,
  enabled = true,
  run?: string,
) {
  return useQuery({
    queryKey: [...keys.phaseNow(slug ?? ''), String(phase), 'report', ...(run ? [run] : [])],
    queryFn: () => api.phaseReport(slug!, phase!, run ? { run } : {}),
    enabled: Boolean(slug) && phase != null && enabled,
    refetchInterval: run ? false : 30_000,
    retry: false,
  });
}

/**
 * A phase's last events, from its session's own log (control-tower phase 95,
 * #138). Polled while shown: a session's tool calls are not journal lines —
 * except for a past run's (`run`), whose session has ended.
 */
export function usePhaseActivity(
  slug: string | undefined,
  phase: number | undefined,
  enabled = true,
  limit = 20,
  run?: string,
) {
  return useQuery({
    queryKey: [...keys.phaseNow(slug ?? ''), String(phase), 'activity', limit, ...(run ? [run] : [])],
    queryFn: () => api.phaseActivity(slug!, phase!, limit, run ? { run } : {}),
    enabled: Boolean(slug) && phase != null && enabled,
    refetchInterval: run ? false : 15_000,
    retry: false,
  });
}

/**
 * A plan's stored triggers' key — its own prefix, which the `run:triggers`
 * event re-reads (`data/live.ts`). Not in `keys`: a member of that object
 * rides first paint, and only the run view reads this.
 */
export const triggersKey = (slug: string) => ['triggers', slug] as const;

/**
 * The plan's stored triggers, armed first (control-tower phase 98, #137) —
 * per PLAN, so they answer before any run exists and outlive the run they
 * were armed on.
 */
export function useTriggers(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: triggersKey(slug ?? ''),
    queryFn: () => api.runTriggers(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
    select: (data) => data.triggers,
  });
}

/**
 * The recorded events of a run, replayed once into the console.
 *
 * Never invalidated (see `keys.transcript`): what happened after it was read
 * arrives on the live stream, and re-reading it would only re-deliver events the
 * console already folded. A missing replay is not an error worth showing.
 */
/**
 * A session replay. With `phase`, that phase's own replay (control-tower phase
 * 94, #133) under its own key; without, the whole run's, merged in order.
 */
export function useTranscript(
  slug: string | undefined,
  id: string | undefined,
  enabled = true,
  phase?: number,
) {
  return useQuery({
    queryKey:
      phase == null
        ? [...keys.transcript(slug ?? ''), id ?? 'latest']
        : [...keys.transcript(slug ?? ''), id ?? 'latest', phase],
    queryFn: () => api.runTranscript(slug!, id, undefined, phase),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * The plan a plan-mode phase presented, as text (control-tower phase 11, #34)
 * — what the halt card's reader draws. Under the run's key, so an Approve
 * that moves the run re-reads it.
 */
export function usePlanText(slug: string, phase: number) {
  return useQuery({
    queryKey: [...keys.run(slug), 'plan-text', phase],
    queryFn: () => api.runPlanText(slug, phase),
    retry: false,
  });
}

/** Fetched when a diagnosis panel is opened, because most rows are never opened. */
export function useDiagnosis(slug: string | undefined, phase: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: keys.diagnosis(slug ?? '', phase ?? ''),
    queryFn: () => api.phaseDiagnosis(slug!, phase!),
    enabled: Boolean(slug) && phase != null && enabled,
    retry: false,
  });
}

/**
 * A run's journal — the audit trail, read once and then appended to live.
 *
 * `keepPreviousData` because the tail is re-read whenever the run id changes
 * and the reader is usually mid-scroll; dropping to a skeleton there loses
 * their place. A run with no journal file yet is not an error worth retrying.
 */
export function useJournal(slug: string | undefined, id?: number, limit = 500, enabled = true) {
  return useQuery({
    queryKey: keys.journal(slug ?? '', id),
    queryFn: () => api.runJournal(slug!, id, limit),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The run on a time axis.
 *
 * `keepPreviousData` for the journal's reason — the axis is re-projected
 * whenever a phase lands, and dropping the whole Gantt to a skeleton mid-read
 * loses the bar the reader was looking at.
 */
export function useTimeline(slug: string | undefined, id?: string, enabled = true) {
  return useQuery({
    queryKey: keys.timeline(slug ?? '', id),
    queryFn: () => api.runTimeline(slug!, id),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * The run's ledger (zero-touch phase 19): why each start happened, what every
 * session cost and ran, held to the run's spend. `keepPreviousData` for the
 * timeline's reason — it is re-projected whenever a phase lands.
 */
export function useLedger(slug: string | undefined, id?: string, enabled = true) {
  return useQuery({
    queryKey: keys.ledger(slug ?? '', id),
    queryFn: () => api.runLedger(slug!, id),
    enabled: Boolean(slug) && enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Every open plan's ledgers, per plan and per account — Insights. */
export function useLedgerSummary(enabled = true) {
  return useQuery({
    queryKey: keys.ledgerSummary(),
    queryFn: () => api.ledgerSummary(),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * One phase's boardings, with the consecutive pairs already diffed.
 *
 * Fetched only when a phase is actually being compared (`enabled`), because
 * the projection reads the whole journal and nothing on the page needs it
 * until someone opens the drawer.
 */
export function useAttempts(
  slug: string | undefined,
  phase: number | undefined,
  id?: string,
  enabled = true,
) {
  return useQuery({
    queryKey: keys.attempts(slug ?? '', phase ?? '', id),
    queryFn: () => api.runAttempts(slug!, phase!, id),
    enabled: Boolean(slug) && phase !== undefined && enabled,
    retry: false,
  });
}

/**
 * The plan's whole ruling ledger, oldest first.
 *
 * Answers for a plan nobody has ever started a run on, which is every plan
 * somebody is driving by hand — so it is NOT gated on there being a run.
 */
export function useRulings(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.rulings(slug ?? ''),
    queryFn: () => api.runRulings(slug!),
    enabled: Boolean(slug) && enabled,
    retry: false,
  });
}

/**
 * Money: today's settled spend against the day cap, each run against its
 * budget, and the 7-day series.
 *
 * Instance-wide and cheap to invalidate — TanStack only refetches a query
 * something is currently rendering, so the `run:phase` invalidation costs
 * nothing on the pages that do not show it.
 */
export function useSpend(enabled = true) {
  return useQuery({
    queryKey: keys.spend(),
    queryFn: api.spend,
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/* ------------------------------------------------------------------ *
 * What the open directory's runs measured (quiet-console phase 25) —
 * Insights and the run view's Verification section draw them (phase 26)
 * ------------------------------------------------------------------ */

export const readSessionSizing = (): Promise<SessionSizing> => request<SessionSizing>('/api/sizing');

/** The census behind the sizing is re-derived as sessions end, which no event announces. */
const SIZING_STALE_MS = 60_000;

/**
 * What a session may spend — Insights. Kept a minute rather than until an
 * event moves it, because nothing on the stream says the census moved; a
 * console with no plan directory open answers 409 until one is, so a refusal
 * is not asked again.
 */
export function useSessionSizing(enabled = true) {
  return useQuery({
    queryKey: ['sizing'] as const,
    queryFn: readSessionSizing,
    enabled,
    staleTime: SIZING_STALE_MS,
    retry: false,
  });
}

/** What the week report is asked: the window (two instants) and whether to replay. */
export interface WeekReportQuery {
  since?: string;
  until?: string;
  replay?: boolean;
}

/** The week before `until` (now) unless `since` says otherwise; `replay` re-derives with today's models. */
export function readWeekReport(query: WeekReportQuery = {}): Promise<WeekReportAnswer> {
  const params = new URLSearchParams();
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.replay) params.set('replay', '1');
  const search = params.toString();
  return request<WeekReportAnswer>(`/api/report${search ? `?${search}` : ''}`);
}

/** How long the server remembers one question's answer; a page asking again inside it reads that memo. */
const REPORT_MEMO_MS = 5 * 60_000;

/**
 * The week in numbers — Insights. `since` and `until` are the window (the
 * week before `until`, now, by default) and `replay` re-derives four of its
 * models with today's rules: each is part of the key, because another window
 * is another report. Kept as long as the server's memo, and never asked again
 * after a refusal — a window the server will not read (400) or no plan
 * directory (409) answers the same until something else changes.
 */
export function useWeekReport(options: WeekReportQuery = {}, enabled = true) {
  const { since, until, replay = false } = options;
  return useQuery({
    queryKey: ['report', since ?? null, until ?? null, replay] as const,
    queryFn: () => readWeekReport({ since, until, replay }),
    enabled,
    staleTime: REPORT_MEMO_MS,
    retry: false,
  });
}

export const readRunProofs = (slug: string, phase?: number): Promise<RunProofs> =>
  request<RunProofs>(`/api/run/${q(slug)}/proofs${phase ? `?phase=${phase}` : ''}`);

export function readRunVerifications(
  slug: string,
  query: { phase?: number; run?: string; limit?: number } = {},
): Promise<RunVerifications> {
  const params = new URLSearchParams();
  if (query.phase) params.set('phase', String(query.phase));
  if (query.run) params.set('run', query.run);
  if (query.limit) params.set('limit', String(query.limit));
  const search = params.toString();
  return request<RunVerifications>(`/api/run/${q(slug)}/verifications${search ? `?${search}` : ''}`);
}
