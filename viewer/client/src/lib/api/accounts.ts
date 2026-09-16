/**
 * Claude accounts — the registry (always redacted), the usage meters, sign-in,
 * and the mid-run switch.
 */

import { request, post, q } from './client';
import {
  type ACCOUNT_KINDS,
  type AUTH_STATES,
  type CREDENTIAL_CLASSES,
  type ENTITLEMENT_STATES,
  type LEAVE_KINDS,
  type PROBE_STATUSES,
} from '../../../../shared/ops-vocab.js';
import type { RunState } from './runs';

/* ---------------- Claude accounts ---------------- */

export interface UsageBucket {
  /** Percent, 0–100. */
  utilization: number;
  /** ISO 8601. */
  resetsAt: string;
}

export interface AccountUsage {
  /** Keyed by the endpoint's own names — `five_hour`, `seven_day`, `seven_day_opus`, … */
  buckets: Record<string, UsageBucket>;
  /** ISO — the last read that SUCCEEDED. Absent when none ever has: "never readable" is not "read hours ago". */
  fetchedAt?: string;
  /** ISO — the last read that FAILED; advances on every failure. */
  lastErrorAt?: string;
  /** The endpoint will never serve this credential kind — "no usage data", not an error. */
  unsupported?: boolean;
  error?: string;
}

/**
 * The breaker's word for a credential (or its organisation), effective now —
 * `unknown → entitled | retired`, `entitled → cooling | retired`,
 * `cooling → entitled | retired`, `retired → unknown` (a person clears it).
 */
export interface EntitlementView {
  state: (typeof ENTITLEMENT_STATES)[number];
  /** Which record answered: the credential's own row, its organisation's, or nothing learned yet. */
  via: 'credential' | 'org' | 'none';
  reason?: string;
  at?: string;
  detail?: string;
  /** `cooling` only: ISO — when the account is a candidate again. */
  until?: string;
  /** `retired` only: which credential class refused. */
  class?: (typeof CREDENTIAL_CLASSES)[number];
  /** Who wrote the word — `classifier`, `live-wall`, `preflight`, `operator`, `poller`, `probe`, … */
  by?: string;
}

/**
 * The newest one-turn check of whether a credential may run work (phase 15) —
 * `ok` the API took work under it, `fail` it refused the credential, `skip` it
 * could not be asked. Machine-wide, like the breaker it may have moved.
 */
export interface AccountProbe {
  at: string;
  status: (typeof PROBE_STATUSES)[number];
  reason: string;
  /** Who pressed it — the request's derived actor. */
  by: string;
  class?: (typeof CREDENTIAL_CLASSES)[number];
  costUsd?: number;
  ms?: number;
  ending?: string;
  cliVersion?: string;
  /** Every check this credential has had, on any console. */
  count: number;
}

/**
 * Would the rank pick this account now? `rank` is its place among the
 * candidates (1 first — the order an `auto` pick walks); `why` is the rank's
 * own reason when it is out, `until` when a clock ends it.
 */
export type AccountStanding =
  { candidate: true; rank?: number } | { candidate: false; why: string; until?: string };

/** A registration this console removed, still answered from the learned store's tombstone. */
export interface TombstoneView {
  id: string;
  name: string;
  retiredAt: string;
  credential: string;
  orgId?: string;
  entitlement: EntitlementView;
}

/** One registered Claude identity, redacted: never a token, never a path, never a raw orgId. */
export interface AccountView {
  id: string;
  kind: (typeof ACCOUNT_KINDS)[number];
  /** The machine's own login — always present, never removable. */
  builtIn: boolean;
  name?: string;
  email?: string;
  org?: string;
  /** The organisation's id, HASHED (eight hex) — two accounts showing one share an organisation. */
  orgId?: string;
  /** The credential's fingerprint — two ids showing one are one login. Optional here so an older server still renders. */
  credential?: string;
  plan?: string;
  /** Profiles only: whether `claude auth login` has completed in it. */
  signedIn?: boolean;
  /** Where the login stands. `unknown` is a setup-token's honest answer; `unusable` is a retired credential. */
  authState?: (typeof AUTH_STATES)[number];
  /** The breaker's word (phase 15's dashboard renders it); optional so an older server's list still renders. */
  entitlement?: EntitlementView;
  usage?: AccountUsage;
  /** ISO — the last meter read that failed, from the machine-wide learned store. */
  lastErrorAt?: string;
  /** ISO — the last meter read that SUCCEEDED on any console on this machine. */
  lastSuccessAt?: string;
  /** Windows learned exhausted the hard way — bucket → ISO reset time. Machine-wide since 5.0.0. */
  limitedUntil?: Record<string, string>;
  /** The name a REMOVED registration was known by, when this id is answered from a tombstone. */
  tombstone?: { name: string; retiredAt: string };
  /** The last time a run moved OFF this account, who moved it and why. */
  lastLeftAt?: { at: string; by: string; kind: (typeof LEAVE_KINDS)[number]; reason: string };
  /** The newest one-turn check of this credential (phase 15). */
  probe?: AccountProbe;
  /** How often this console reads the meters for this account now, in ms. */
  pollEveryMs?: number;
  /** The rank's verdict on this account right now. */
  breaker?: AccountStanding;
}

export interface AccountsState {
  accounts: AccountView[];
  allowAccounts: boolean;
  /** The registrations this console removed that the learned store still remembers. Absent on an older server. */
  tombstones?: TombstoneView[];
}

/** What a one-turn check found and did. */
export interface AccountProbeResult {
  account: AccountView;
  probe: AccountProbe;
  /** Did a session actually start? A signed-out login or a missing token is refused before any spend. */
  spent: boolean;
  moved?: { from: EntitlementView['state']; to: EntitlementView['state'] };
}

export interface AccountLoginStart {
  accountId: string;
  /** The exact command, for the operator to run themselves when nothing opened. */
  command: string;
  /** `embedded` = a pty on the Agent page; `external` = Terminal.app opened; `command` = copy-paste. */
  mode: 'embedded' | 'external' | 'command';
  terminal?: { sessionId: string; token: string; expiresAt: number };
  detail?: string;
}

/** The account fetchers — merged into `api` by `./index`. */
export const accountsApi = {
  /* ---- Claude accounts ---- */
  accounts: () => request<AccountsState>('/api/accounts'),
  accountAdd: (name: string, token: string) =>
    post<{ account: AccountView }>('/api/accounts', { name, token }),
  accountDelete: (id: string) =>
    request<{ removed: boolean }>(`/api/accounts/${q(id)}`, { method: 'DELETE' }),
  /** Display-name only — the id (journal key, path segment) never changes. */
  accountRename: (id: string, name: string) =>
    request<{ account: AccountView }>(`/api/accounts/${q(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  accountLogin: (body: { accountId?: string; name?: string } = {}) =>
    post<AccountLoginStart>('/api/accounts/login', body),
  /**
   * The operator's clearance of a RETIRED account — the one transition out of
   * the breaker's `retired`, for the credential and every account in its
   * organisation (`--allow-accounts`). No `by`: the server derives the actor
   * from the request.
   */
  accountClearRetired: (id: string) =>
    post<{ account: AccountView }>(`/api/accounts/${q(id)}/clear-retired`, {}),
  /**
   * Ask the API whether the account may run work: ONE declared one-turn session
   * under it, answered when it ends (`--allow-accounts`; 409 while a check of
   * the same account is running). No `by`: the server derives the actor.
   */
  accountProbeEntitlement: (id: string) =>
    post<AccountProbeResult>(`/api/accounts/${q(id)}/probe-entitlement`, {}),
  /** Acts NOW: a live session is checkpointed and re-attempted under the account. */
  runSwitchAccount: (slug: string, accountId: string) =>
    post<{ ok: boolean; reason?: string; run?: RunState | null }>(`/api/run/${q(slug)}/switch-account`, {
      accountId,
    }),
  /**
   * "I signed in over there — look again." Re-reads an account's identity AND
   * awaits a fresh usage poll, so the answer is the new numbers rather than
   * the ones the press was meant to replace.
   *
   * With no id it re-reads EVERY account and answers with all of them — the
   * one press a panel offers.
   */
  accountRefresh: (accountId?: string) =>
    post<{ account?: AccountView; accounts?: AccountView[] }>('/api/accounts/refresh', {
      ...(accountId ? { accountId } : {}),
    }),
};
