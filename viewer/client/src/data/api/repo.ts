/**
 * Repo — the read-only git surfaces under `GET /api/repo/…`. The shapes are
 * the wire's (`shared/wire/repo.js`), imported by the server's handlers and by
 * this file alike, so a server change that breaks the client fails the type
 * check on both sides; this file keeps only the fetches. The query parameter
 * bags (`RepoGraphParams`, `RepoDiffParams`) are the client's own and live in
 * `data/repo.ts`.
 */

import { request, q } from '../http';
import type { RepoDiffParams, RepoGraphParams } from '../repo';
import type {
  RepoBranches,
  RepoCheckouts,
  RepoDiff,
  RepoGraph,
  RepoSettles,
  RepoTargets,
} from '@shared/wire/repo.js';

// What a checkout IS to this console, and what a settle-history row says
// happened — both owned by `shared/worktree-model.js` (`CHECKOUT_ROLES`,
// `SETTLE_KINDS`), and re-exported as types only: this module is first paint.
export type { CheckoutRole, SettleKind } from '@shared/worktree-model.js';
export type {
  CheckoutAttribution,
  RepoBranch,
  RepoBranches,
  RepoCheckout,
  RepoCheckoutTree,
  RepoCheckouts,
  RepoCommit,
  RepoDiff,
  RepoDiffFile,
  RepoGraph,
  RepoPatch,
  RepoSettleEvent,
  RepoSettles,
  RepoTarget,
  RepoTargetKind,
  RepoTargets,
} from '@shared/wire/repo.js';

/* ---------------- fetchers ---------------- */

/**
 * Only the parameters that were actually given — an empty value is not a request.
 *
 * This is the client half of the rule P8's round-2 High was about: on the server,
 * `Number(query.get(n))` turns a parameter nobody sent into `0`, so a `unified`
 * with a floor of 0 could not tell silence from an explicit "no context". Sending
 * `unified=` for an undefined field would hand the server exactly that ambiguity
 * back, so an absent field is absent from the URL.
 */
function query(params: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${q(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const repoApi = {
  repoTargets: () => request<RepoTargets>('/api/repo/targets'),

  repoGraph: ({ ref, all, ...rest }: RepoGraphParams = {}) => {
    // `ref` is built by hand because it REPEATS, which `query()` cannot express
    // — but it obeys the same rule: an empty value is not a request, and
    // sending `ref=` would be a named walk of nothing rather than the default.
    const refs = (ref ?? [])
      .filter((r) => r !== '')
      .map((r) => `ref=${q(r)}`)
      .join('&');
    const base = query({ ...rest, ...(all ? { all: 1 } : {}) });
    const path = `/api/repo/graph${base}${refs ? (base ? '&' : '?') + refs : ''}`;
    return request<RepoGraph>(path);
  },

  repoBranches: (repo?: string) => request<RepoBranches>(`/api/repo/branches${query({ repo })}`),

  /** No `repo=`: one registry, one object database — it would answer twice under two names. */
  repoCheckouts: () => request<RepoCheckouts>('/api/repo/checkouts'),

  repoDiff: (params: RepoDiffParams = {}) => request<RepoDiff>(`/api/repo/diff${query(params)}`),

  repoSettles: (params: { limit?: number; slug?: string; runs?: number; entries?: number } = {}) =>
    request<RepoSettles>(`/api/repo/settles${query(params)}`),

};
