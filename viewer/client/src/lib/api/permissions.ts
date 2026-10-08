/**
 * The scoped grant (control-tower phase 149, #212) — a permission item answered
 * with ONE press that the server applies at the scope chosen, and every grant
 * as a row a person can read and take back.
 *
 * Kept out of the `lib/api` barrel, like `owner.ts`: no first-paint page reads
 * it (the screens are phase 138's). Every judgement is the server's
 * (`server/permissions/grants.ts`): the risk of a cell, the never list, the
 * owner door for a high grant, the blast radius, what a revoke undoes.
 */

import type { GRANT_SCOPES, GRANT_STATES, RISK_TIERS, RULE_FAMILIES, WALLS } from '@shared/turn-model.js';
import { post, request } from './client';

export type GrantScope = (typeof GRANT_SCOPES)[number];
export type GrantState = (typeof GRANT_STATES)[number];

/** EXACTLY what one grant changed — what its row shows and what a revoke undoes. */
export type GrantChange =
  | { kind: 'hook'; rule: string; runId: string; phase: number; command?: string }
  | { kind: 'settings'; runId: string; list: 'deny' | 'allow'; rule: string }
  | {
      kind: 'policy';
      layer: 'plan' | 'repository' | 'machine';
      file: string;
      slug?: string;
      op: 'strike' | 'remove' | 'add';
      list: 'deny' | 'allow';
      rule: string;
    }
  | { kind: 'capability'; flag: string; unit: string; restart: 'when-idle' };

/** Who a high grant reaches, and until when — the server's computation, shown before the rule is typed. */
export interface BlastRadius {
  runs: string[];
  plans: string[] | 'every';
  phases: { slug: string; phase: number }[] | 'every';
  repositories: 'this' | 'every';
  until: string | null;
  sentence: string;
}

/** One grant — who, which door, the item, the wall, the rule, the scope, the end, what it changed. */
export interface GrantRecord {
  id: string;
  at: string;
  by: string;
  door: string | null;
  item: string | null;
  card?: string;
  wall: (typeof WALLS)[number];
  tool: string;
  rule: string;
  command?: string;
  family: (typeof RULE_FAMILIES)[number];
  risk: (typeof RISK_TIERS)[number];
  scope: GrantScope;
  slug: string | null;
  phase: number | null;
  runId: string | null;
  until: string | null;
  changed: GrantChange[];
  reason?: string;
  blast?: BlastRadius;
  /** A high grant made on a console with no owner key — the typed rule alone. */
  unkeyed?: true;
  state: GrantState;
  endedAt?: string;
  endedBy?: string;
  endReason?: string;
}

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
  grants: () => request<{ grants: GrantRecord[]; live: number }>('/api/permissions/grants'),
  /** Grant a permission item at one scope; a high one carries the rule typed back. */
  grant: (itemId: string, body: { scope: GrantScope; rule?: string; reason?: string }) =>
    post<GrantAnswer>(`/api/human-steps/${encodeURIComponent(itemId)}/grant`, body),
  /** Revoke one live grant — exactly what it changed is undone. Needs no owner key. */
  revoke: (id: string, reason?: string) =>
    post<{ ok: true; grant: GrantRecord }>(
      `/api/permissions/grants/${encodeURIComponent(id)}/revoke`,
      reason ? { reason } : {},
    ),
  /** Revoke every live grant. */
  revokeAll: (reason?: string) =>
    post<{ ok: true; revoked: number; grants: GrantRecord[] }>(
      '/api/permissions/grants/revoke-all',
      reason ? { reason } : {},
    ),
};
