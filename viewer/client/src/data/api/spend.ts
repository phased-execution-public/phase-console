/**
 * Spend — `GET /api/spend` lands in Phase 4 (server A); this is the agreed
 * shape so the client can be built against it. Nothing calls it yet.
 *
 * `today` is the day cap's view (settled runs plus what the ladder spent,
 * against `ladderPerDayUsd` — `null` when no cap is set); `runs` is each run
 * against its own budget; `series` is the per-day history a chart draws.
 */

import { request } from '../http';

export type SpendView = {
  /** `ladderLeftUsd`: the cap less today's ladder spend, never below zero; null with no cap. */
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null; ladderLeftUsd?: number | null };
  runs: { runId: string; slug: string; spentUsd: number; budgetUsd: number | null }[];
  /** `usd`: the day's settled and ladder spend together, summed by the server. */
  series: { day: string; settledUsd: number; ladderUsd: number; usd?: number }[];
  /**
   * The series summed by the server (quiet-console phase 19), so a page prints
   * the window's cost without adding it up. The three new fields are absent
   * from a server older than 7.0.
   */
  total?: { settledUsd: number; ladderUsd: number; usd: number };
};

/** The spend fetcher — merged into `api` by `./index`. Nothing calls it yet. */
export const spendApi = {
  spend: () => request<SpendView>('/api/spend'),
};
