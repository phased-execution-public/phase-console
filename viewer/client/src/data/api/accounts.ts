/**
 * Claude accounts — the registry (always redacted), the usage meters, sign-in,
 * and the mid-run switch.
 */

import { request, post, q } from '../http';
import type { RunState } from './runs';
import type { SwitchWhen } from '@shared/run-lifecycle.js';
import type {
  AccountAnswer,
  AccountLoginStart,
  AccountProbeResult,
  AccountRefreshAnswer,
  AccountRemoved,
  AccountsState,
} from '@shared/wire/accounts.js';

/* ---------------- Claude accounts ----------------
 * The shapes live in `shared/wire/accounts.js`, the one source server and
 * client import; this file keeps the fetches. */

export type {
  AccountAnswer,
  AccountForecast,
  AccountLoginStart,
  AccountProbe,
  AccountProbeResult,
  AccountRefreshAnswer,
  AccountRemoved,
  AccountsState,
  AccountStanding,
  AccountUsage,
  AccountView,
  BucketForecast,
  CreditView,
  EntitlementView,
  RetirementEvidence,
  TombstoneView,
  UsageBucket,
} from '@shared/wire/accounts.js';

/** The account fetchers — merged into `api` by `./index`. */
export const accountsApi = {
  /* ---- Claude accounts ---- */
  accounts: () => request<AccountsState>('/api/accounts'),
  accountAdd: (name: string, token: string) => post<AccountAnswer>('/api/accounts', { name, token }),
  accountDelete: (id: string) => request<AccountRemoved>(`/api/accounts/${q(id)}`, { method: 'DELETE' }),
  /** Display-name only — the id (journal key, path segment) never changes. */
  accountRename: (id: string, name: string) =>
    request<AccountAnswer>(`/api/accounts/${q(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  /**
   * "Use credits past plan limits" for one account (control-tower phase 93,
   * #146) — the server verifies it from the account's own credit state and
   * answers 409 with the reason when credits cannot carry it.
   */
  accountOverage: (id: string, allowed: boolean, capUsd?: number) =>
    post<AccountAnswer>(`/api/accounts/${q(id)}/overage`, {
      allowed,
      ...(capUsd === undefined ? {} : { capUsd }),
    }),
  accountLogin: (body: { accountId?: string; name?: string; confirm?: string } = {}) =>
    post<AccountLoginStart>('/api/accounts/login', body),
  /** Replace a token account's credential, keeping its id and name (control-tower phase 13, #33). */
  accountReplaceToken: (id: string, token: string) =>
    request<AccountAnswer>(`/api/accounts/${q(id)}/credential`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  /**
   * The operator's clearance of a RETIRED account — the one transition out of
   * the breaker's `retired`, for the credential and every account in its
   * organisation (`--allow-accounts`). No `by`: the server derives the actor
   * from the request.
   */
  accountClearRetired: (id: string) => post<AccountAnswer>(`/api/accounts/${q(id)}/clear-retired`, {}),
  /**
   * Ask the API whether the account may run work: ONE declared one-turn session
   * under it, answered when it ends (`--allow-accounts`; 409 while a check of
   * the same account is running). No `by`: the server derives the actor.
   */
  accountProbeEntitlement: (id: string) =>
    post<AccountProbeResult>(`/api/accounts/${q(id)}/probe-entitlement`, {}),
  /**
   * Acts NOW: a live session that is still working is checkpointed and
   * re-attempted under the account; one only closing out finishes where it is
   * (`deferred`). `when: 'boundary'` checkpoints no live lane at all — each
   * finishes on the account it started on, and everything after is on the new
   * one. The queue moves with the run either way.
   */
  runSwitchAccount: (slug: string, accountId: string, when?: SwitchWhen) =>
    post<{
      ok: boolean;
      reason?: string;
      run?: RunState | null;
      checkpointed?: number;
      deferred?: number[];
      rekeyed?: number;
    }>(`/api/run/${q(slug)}/switch-account`, { accountId, ...(when ? { when } : {}) }),
  /**
   * What that switch would do, doing none of it (`dry: true`, control-tower
   * phase 25): the live lanes it would checkpoint now, and the ones it would
   * leave to finish. The same refusals as the switch itself.
   */
  runSwitchPreview: (slug: string, accountId: string, when?: SwitchWhen) =>
    post<{ ok: boolean; reason?: string; wouldCheckpoint?: number[]; deferred?: number[] }>(
      `/api/run/${q(slug)}/switch-account`,
      { accountId, dry: true, ...(when ? { when } : {}) },
    ),
  /**
   * "I signed in over there — look again." Re-reads an account's identity AND
   * awaits a fresh usage poll, so the answer is the new numbers rather than
   * the ones the press was meant to replace.
   *
   * With no id it re-reads EVERY account and answers with all of them — the
   * one press a panel offers.
   */
  accountRefresh: (accountId?: string) =>
    post<AccountRefreshAnswer>('/api/accounts/refresh', {
      ...(accountId ? { accountId } : {}),
    }),
};
