/**
 * The scoped grant (control-tower phase 149, #212) — a permission item answered
 * with ONE press that the server applies at the scope chosen, and every grant
 * as a row a person can read and take back.
 *
 * Kept out of the `data/api.ts` barrel, like `owner.ts`: no first-paint page reads
 * it (the screens are phase 138's). Every judgement is the server's
 * (`server/permissions/grants.ts`): the risk of a cell, the never list, the
 * owner door for a high grant, the blast radius, what a revoke undoes.
 */

import type {
  BlastRadius,
  GrantRecord,
  GrantRevokeAnswer,
  GrantScope,
  GrantsList,
  GrantsRevokeAllAnswer,
} from '@shared/wire/sessions.js';
import { useQuery } from '@tanstack/react-query';
import { post, request } from './http';

/* The grant's shapes are the wire's (measured-console phase 32); the answers below are the Grant press's. */
export type { GrantScope, GrantState, GrantChange, BlastRadius, GrantRecord } from '@shared/wire/sessions.js';

/** What the Grant press answers: the row, and the sessions it resumed. */
export interface GrantAnswer {
  ok: true;
  granted: GrantRecord;
  resumes: { slug: string; phase: number; launched: boolean; why?: string }[];
}

/**
 * A refused grant. A high one pressed without its rule answers 400 with the
 * `rule` to type and its `blast`; through the owner door with a stale touch,
 * 401 `{reassert: true}`; through a door that may only ask, 202
 * `{requested: true}` — waiting for the owner, not done.
 */
export interface GrantRefusal {
  error: string;
  rule?: string;
  blast?: BlastRadius;
  reassert?: true;
}

/** The grants list's cache key — Settings ▸ Permissions ▸ Grants reads it; a press on Your turn refreshes it. */
export const GRANTS_QUERY_KEY = ['permissions', 'grants'] as const;

export const permissionsApi = {
  /** Every grant, newest first, and how many are live. */
  grants: () => request<GrantsList>('/api/permissions/grants'),
  /** Grant a permission item at one scope; a high one carries the rule typed back. */
  grant: (itemId: string, body: { scope: GrantScope; rule?: string; reason?: string }) =>
    post<GrantAnswer>(`/api/human-steps/${encodeURIComponent(itemId)}/grant`, body),
  /** Revoke one live grant — exactly what it changed is undone. Needs no owner key. */
  revoke: (id: string, reason?: string) =>
    post<GrantRevokeAnswer>(
      `/api/permissions/grants/${encodeURIComponent(id)}/revoke`,
      reason ? { reason } : {},
    ),
  /** Revoke every live grant. */
  revokeAll: (reason?: string) =>
    post<GrantsRevokeAllAnswer>('/api/permissions/grants/revoke-all', reason ? { reason } : {}),
};

/**
 * Every grant this console made, newest first, with the live count —
 * Settings ▸ Permissions ▸ Grants reads it, and a grant or a revoke anywhere
 * refreshes it. Read each time the list is opened: a grant made on Your turn a
 * minute ago is the row a person came to see. `retry: false` — a server that
 * predates the grants answers 404 and keeps answering it.
 */
export function useGrants(enabled = true) {
  return useQuery({
    queryKey: GRANTS_QUERY_KEY,
    queryFn: () => permissionsApi.grants(),
    enabled,
    retry: false,
    refetchOnMount: 'always',
  });
}
