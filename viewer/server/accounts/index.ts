/**
 * Accounts — the facade the rest of the console talks to.
 *
 * One object owns the registry (`store.ts`), the secrets and credential reads
 * (`credentials.ts`) and the meters (`usage.ts`), and everything it hands out
 * is REDACTED: an `AccountView` carries names, emails, plans and percentages,
 * never a token and never a path to one. The service streams these views to
 * the browser verbatim, so the redaction boundary is here, not in a route.
 *
 * The runner asks four questions and nothing else: `envFor(accountId)` when
 * spawning, `leaveAccount(...)` when a session leaves an account behind — a
 * wall, a refusal, a person's switch — `headroom(...)` before it spends, and
 * `pickAccount(...)`/`rankAccounts(...)` when policy says switch. All four are
 * answerable from cache — the runner never waits on a keychain or the network
 * mid-phase.
 *
 * Two stores behind one facade since zero-touch-console phase 8. The REGISTRY
 * (`store.ts`) is per instance and holds what this console registered; the
 * LEARNED store (`learned.ts`) is machine-wide and holds what any console on
 * the machine found out about a CREDENTIAL — its walls, its entitlement (the
 * breaker), its last successful and failed meter read, its organisation, and a
 * tombstone for a registration that is gone. A wall the pe-hub console learns
 * at 14:02 is the hub console's fact at 14:02 too.
 */

import { createHash } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { INSTANCE } from '../config.ts';
import { log } from '../log.ts';
import { parseAuth, type AuthStatus } from '../runner/auth.ts';
import { classify, type RetirementEvidence } from '../runner/errors.ts';
import {
  AccountStore, ACCOUNTS_DIR, DEFAULT_ACCOUNT_ID, profileConfigDir,
  type AccountKind, type AccountMeta, type OverageSetting,
} from './store.ts';
import { Credentials, realExec, type ClaudeOauth, type Exec } from './credentials.ts';
import { ensureProfileWorkspace } from './workspace.ts';
import {
  ACCOUNT_COOLDOWN_MS, NAMELESS_WALL, SHARED_WALLS, credentialFingerprint, hashedOrgId, LearnedAccounts,
  type CredentialClass, type Entitlement, type EntitlementView, type LearnedProbe, type LeaveBy, type LeaveKind,
} from './learned.ts';
import { probeEnv, runProbeSession, type ProbeSession, type ProbeSessionOptions } from './entitlement-probe.ts';
import {
  agedUsage, forecastUsage, liveBuckets, UsagePoller, USAGE_STALE_MS,
  type AccountUsage, type BucketForecast, type TokenAnswer, type UsageCredits, type UsageMeta,
} from './usage.ts';
import {
  keepAliveDueAt, loginFix, renewLogin, tokenExpiresAt, tokenLoginState, KEEP_ALIVE_TICK_MS, UNATTENDED_OFFER, type Renewal,
} from './keep-alive.ts';
import {
  ALERT_PCT, AUTH_STATES, CREDIT_SESSION_FRESH_MS, FORECAST_LEAD_HOURS, METER_STATES, ORG_SCOPED_CLASSES, WALL_PCT, WARN_PCT, creditReasonPhrase,
} from '../../shared/ops-vocab.js';

export { DEFAULT_ACCOUNT_ID, ACCOUNT_ID_RE, profileConfigDir } from './store.ts';
export type { AccountMeta, AccountKind } from './store.ts';
export type { AccountUsage, BucketForecast, UsageBucket } from './usage.ts';
export { ACCOUNT_COOLDOWN_MS, SHARED_WALLS, SUSPECT_CLEAR_MS, hashedOrgId } from './learned.ts';
export type { Entitlement, EntitlementView, CredentialClass, LearnedProbe, LeaveBy, LeaveKind } from './learned.ts';

/**
 * The quota door's refusal line, in percent of the five-hour window: a run
 * started against a window this spent would only find the wall the expensive
 * way. Stricter than `WALL_PCT`, which is what a meter has to read to be a
 * wall in its own right — three points of slack for the first phase's spend.
 */
export const PREFLIGHT_REFUSE_PCT = 97;

/**
 * Why the switch picker passed over an account (`carriesUntil`, and the
 * picker's own `unknown` and floor rules). `pct`, `lastsMs` and `resetsAt` are
 * null for an account with no reading to weigh (`bucket: 'unknown'`).
 */
export type SwitchDecline = {
  /** The window that would wall first, is under the run's floor, or `unknown`. */
  bucket: string;
  /** Its reading now, in percent. */
  pct: number | null;
  /** How long its headroom lasts at the burn it was weighed at. */
  lastsMs: number | null;
  /** When that window resets — how long work moved there would be held. */
  resetsAt: string | null;
  why: string;
};

/**
 * Would work moved onto an account with these meters still be running when the
 * current wall resets at `untilMs`? Null when it would; the window that walls
 * first when it would not (control-tower phase 78, #100).
 *
 * A switch has a price — a checkpointed session and a cold cache on the new
 * account — and it buys nothing once the run's own wall has reset, so a target
 * has to carry the work at least that long. Each shared window (`five_hour`,
 * `seven_day`, and the model's own `seven_day_<family>` when one is named) that
 * resets AFTER `untilMs` must have headroom for the whole horizon at the burn
 * `burn` gives it, in percent per hour — MEASURED, since control-tower phase 92
 * (#141): the target's own burn plus the moving work's (`switchCandidates`).
 * Phase 78 assumed a constant 20 %/h five-hour and 4 %/h weekly
 * (`SWITCH_BURN_PCT_PER_HOUR`, retired). A window with no measured burn cannot
 * be judged and declines nothing; a window that resets first cannot hold work
 * past the moment waiting would have resumed it, however full it reads. No
 * meters is not evidence of a wall here — the picker's `unknown` rule answers
 * that — and a horizon already past asks nothing.
 */
export function carriesUntil(
  buckets: Readonly<Record<string, Readonly<{ utilization: number; resetsAt: string }>>>,
  untilMs: number, nowMs: number, family?: string,
  burn: Readonly<Record<string, number | null | undefined>> = {},
): SwitchDecline | null {
  const horizon = untilMs - nowMs;
  if (!(horizon > 0)) return null;
  const windows = ['five_hour', 'seven_day', ...(family ? [`seven_day_${family}`] : [])];
  let first: (SwitchDecline & { lastsMs: number }) | null = null;
  for (const name of windows) {
    const bucket = buckets[name];
    if (!bucket || typeof bucket.utilization !== 'number') continue;
    const resets = Date.parse(bucket.resetsAt);
    if (!Number.isFinite(resets) || resets <= untilMs) continue;
    const rate = burn[name];
    if (typeof rate !== 'number' || !(rate > 0)) continue;
    const lastsMs = Math.max(0, 100 - bucket.utilization) / rate * 3_600_000;
    if (lastsMs >= horizon) continue;
    if (first && first.lastsMs <= lastsMs) continue;
    const shown = rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10;
    first = {
      bucket: name, pct: bucket.utilization, lastsMs, resetsAt: bucket.resetsAt,
      why: `its ${name} window reads ${Math.round(bucket.utilization)} % — about ${Math.max(1, Math.round(lastsMs / 60_000))} min of work `
        + `at ${shown} %/h measured, and it would wall before the current wall resets at ${new Date(untilMs).toISOString()}, `
        + `then hold until ${bucket.resetsAt}`,
    };
  }
  return first;
}

/** One account's room NOW (`Accounts.roomOf`). */
export type AccountRoom = { ok: boolean; headroomPct: number | null; resetsAt: string | null; why?: string };

/**
 * What a live session last said about the account's credit (control-tower
 * phase 93, #146) — the `rate_limit_event`'s overage fields, and when.
 */
export type SessionCredit = {
  usingOverage?: boolean; overageStatus?: string; overageDisabledReason?: string; overageResetsAt?: number;
};

/**
 * An account's credits as the console acts on them (control-tower phase 93,
 * #146; operator decision 12). `allowed` is the operator's "use credits past
 * plan limits", OFF by default; `available` is the account's OWN credit state
 * — true, false, or null when no source has said (unknown is never assumed);
 * `carrying` is both, and it is the one bit every plan-window threshold reads.
 */
export type CreditView = {
  allowed: boolean;
  available: boolean | null;
  carrying: boolean;
  /** Why `available` is what it is, in words: "out of credits", "credit state unknown — …", "5.00 of 40.00 USD used". */
  reason: string;
  /** Spent this month, the API's monthly limit, the cap in force (the operator's, else that limit), and what the cap leaves. */
  used: number | null;
  limit: number | null;
  cap: number | null;
  remaining: number | null;
  currency: string | null;
  /** The operator's own cap, when one is set. */
  capUsd?: number;
  /** A live session spent credit within `CREDIT_SESSION_FRESH_MS`. */
  onCredit: boolean;
  /** When the credit state was read (the usage read's clock). */
  readAt?: string;
};

const money = (value: number, currency: string | null): string => `${value.toFixed(2)}${currency ? ` ${currency}` : ''}`;

/**
 * The verdict (control-tower phase 93, #146): may this account's credits carry
 * work right now? Two sources, the newer refusal winning — a session's
 * `overageStatus: rejected` or `overageDisabledReason` stands until a usage
 * read made AFTER it says credits are on; the read's block otherwise, stale
 * past `USAGE_STALE_MS` like any meter. Credits stop when they are off, when
 * the spend limit stopped them, or when what was used reaches the cap.
 */
export function creditVerdict(input: {
  setting: OverageSetting | undefined;
  credits: UsageCredits | undefined;
  readAt: string | undefined;
  session: (SessionCredit & { at: number }) | undefined;
  nowMs: number;
}): CreditView {
  const { setting, credits, readAt, session, nowMs } = input;
  const readMs = readAt ? Date.parse(readAt) : NaN;
  const limit = credits?.monthlyLimit ?? null;
  const cap = typeof setting?.capUsd === 'number' ? (limit === null ? setting.capUsd : Math.min(setting.capUsd, limit)) : limit;
  const used = credits?.used ?? null;
  const currency = credits?.currency ?? null;
  const onCredit = Boolean(session?.usingOverage) && nowMs - (session?.at ?? 0) <= CREDIT_SESSION_FRESH_MS;
  const shape = (available: boolean | null, reason: string): CreditView => ({
    allowed: Boolean(setting), available, carrying: Boolean(setting) && available === true, reason,
    used, limit, cap, remaining: cap !== null && used !== null ? Math.max(0, Math.round((cap - used) * 100) / 100) : null,
    currency, ...(typeof setting?.capUsd === 'number' ? { capUsd: setting.capUsd } : {}), onCredit,
    ...(readAt ? { readAt } : {}),
  });
  const refused = session && (session.overageStatus === 'rejected' || Boolean(session.overageDisabledReason));
  if (refused && !(Number.isFinite(readMs) && readMs > session.at && credits?.enabled)) {
    return shape(false, creditReasonPhrase(session.overageDisabledReason) ?? 'the CLI refused the session credit');
  }
  if (!credits) return shape(null, 'credit state unknown — no usage read has reported this account\'s credits');
  if (!Number.isFinite(readMs) || nowMs - readMs > USAGE_STALE_MS) {
    return shape(null, Number.isFinite(readMs)
      ? `credit state unknown — the last usage read is ${Math.round((nowMs - readMs) / 60_000)} min old`
      : 'credit state unknown — no usage read has succeeded');
  }
  if (!credits.enabled) {
    return shape(false, creditReasonPhrase(credits.disabledReason)
      ?? (credits.userDisabled ? 'turned off by the account holder' : credits.spendLimitReached ? 'the spend limit is reached' : 'not enabled'));
  }
  if (credits.spendLimitReached) return shape(false, 'the spend limit is reached');
  if (used !== null && typeof setting?.capUsd === 'number' && used >= setting.capUsd) {
    return shape(false, `the console's spend cap of ${money(setting.capUsd, currency)} is reached`);
  }
  if (used !== null && limit !== null && used >= limit) return shape(false, `the monthly limit of ${money(limit, currency)} is reached`);
  return shape(true, used !== null && cap !== null ? `${money(used, currency)} of ${money(cap, null)} used` : 'credits available');
}

/** What the switch picker answers (`Accounts.switchCandidates`). */
export type SwitchCandidates = {
  /** The accounts that carry the work past the current wall, best first. */
  ranked: string[];
  /** The ranked accounts the horizon rule passed over, each with its reason. */
  declined: (SwitchDecline & { id: string })[];
  /**
   * The soonest a pool member walled NOW frees up, when that is before the
   * current wall resets — the moment a wait should look again. Null otherwise.
   */
  wake: string | null;
};

/**
 * Where an account's login stands. `unknown` is the honest word for a
 * setup-token — it exposes no expiry and no refresh, so the console can only
 * find out by spending it.
 */
export type AuthState = (typeof AUTH_STATES)[number];
export type MeterState = (typeof METER_STATES)[number];

/**
 * WHO an account id answers right now (control-tower phase 91, #131): the
 * facade's identity key — a digest of the credential, the organisation and the
 * email — plus the address and organisation name a person reads. A run binds
 * to one at start (`RunState.identity`), because `default` is a SLOT that
 * follows whatever the machine login is, and a re-login as somebody else must
 * not move a run onto their quota unseen. No secret, no path, no raw orgId.
 */
export type RunIdentity = { account: string; key: string; email?: string; org?: string };

export type { Renewal } from './keep-alive.ts';

/** What leaves the server. No secrets, no filesystem paths, no raw orgId. */
export type AccountView = {
  id: string;
  kind: AccountKind;
  /** True for the synthesized machine login — cannot be removed. */
  builtIn: boolean;
  name?: string;
  email?: string;
  org?: string;
  /** The organisation's id, HASHED (eight hex) — enough to see two accounts share one, never the id itself. */
  orgId?: string;
  /** The credential's fingerprint (the learned store's key) — two ids showing one are one login. */
  credential: string;
  plan?: string;
  /** Profiles only: has anyone actually completed `claude auth login` in it? */
  signedIn?: boolean;
  /** Where this account's login stands, from the CLI's own credential. */
  authState?: AuthState;
  /** The breaker's word for this credential (or its organisation), effective now. */
  entitlement: EntitlementView;
  usage?: AccountUsage;
  /** ISO — the last meter read that failed, from the learned store; absent when none has. */
  lastErrorAt?: string;
  /** ISO — the last meter read that SUCCEEDED on any console on this machine (the learned store's clock). */
  lastSuccessAt?: string;
  limitedUntil?: Record<string, string>;
  /** The name a REMOVED registration was known by, when this id is answered from a tombstone. */
  tombstone?: { name: string; retiredAt: string };
  /** The last time a run moved OFF this account, who moved it and why — machine-wide. */
  lastLeftAt?: { at: string; by: LeaveBy; kind: LeaveKind; reason: string };
  /** The newest one-turn check of whether this credential may run work (phase 15). */
  probe?: LearnedProbe;
  /** Token accounts: when the setup-token stops working — a year from when it was added (phase 91). */
  tokenExpiresAt?: string;
  /**
   * Login-backed accounts: the unattended path, offered — a long-lived token
   * does not lapse between sessions (control-tower phase 91, #147 ask 3).
   */
  unattended?: string;
  /** How often this console's poller reads the meters for this account now, in ms — what a meter's age is judged against. */
  pollEveryMs?: number;
  /**
   * Would `rankAccounts` pick this account right now (no model named, nobody
   * excluded)? `rank` is its place among the candidates, 1 first, which is the
   * order an `auto` pick walks; `why` is the rank's own reason when it is out.
   * Derived from the same predicate the rank uses, never re-derived beside it.
   */
  breaker?: AccountCandidacy;
  /** Each window's forecast and who is burning the account (control-tower phase 92, #141). */
  forecast?: AccountForecast;
  /** The account's credits and whether they carry its runs past its plan windows (control-tower phase 93, #146). */
  credits?: CreditView;
  /**
   * What its meter can say, whatever its buckets (control-tower phase 13, #33)
   * — so every account gets a bar, and a broken login is drawn as broken
   * rather than absent (`METER_STATES`).
   */
  meter: MeterState;
  /** The live runs set to PAY as this account — the bar marks the one a run is paying as (phase 13, #33). */
  paying: PayingRun[];
};

/** A run spending an account now: its plan, its id, its live lanes. */
export type BurningRun = { slug: string; runId: string; lanes: number[] };

/** A live run set to pay as an account — whether or not a lane of it is spending this minute. */
export type PayingRun = { slug: string; runId: string };

/**
 * The meter state a view carries (control-tower phase 13, #33): a broken
 * login outranks stale numbers — its bar must say it is broken, not show the
 * last good reading as if it were live.
 */
export function meterStateOf(authState: AuthState | undefined, usage: AccountUsage | undefined): MeterState {
  if (usage?.unsupported) return 'unsupported';
  if (authState === 'expired' || authState === 'signed-out' || authState === 'unusable') return 'broken';
  if (Object.keys(usage?.buckets ?? {}).length) return 'ok';
  return usage?.error ? 'broken' : 'none';
}

/**
 * An account's forecast as the view carries it (control-tower phase 92, #141):
 * every live window's burn and projected wall, the soonest of those walls and
 * which window it is, and the runs burning the account.
 */
export type AccountForecast = {
  buckets: Record<string, BucketForecast>;
  wallsAt: string | null;
  bucket: string | null;
  burning: BurningRun[];
};

/** One account's standing in the rank — `candidacy()`'s answer, as the view carries it. */
export type AccountCandidacy =
  | { candidate: true; rank?: number }
  | { candidate: false; why: string; until?: string };

/** A registration this console REMOVED, still answered from the learned store's tombstone. */
export type TombstoneView = {
  id: string;
  name: string;
  retiredAt: string;
  credential: string;
  /** Hashed, like every orgId that leaves the server. */
  orgId?: string;
  entitlement: EntitlementView;
};

/** A check was asked for while one of the same account was still running. */
export class ProbeInFlightError extends Error {
  constructor(label: string) {
    super(`A check of ${label} is already running — its answer lands on the row when it finishes.`);
    this.name = 'ProbeInFlightError';
  }
}

/**
 * An account that cannot be removed right now, and what is holding it (#22).
 *
 * A distinct class rather than a message, because the route's answer differs:
 * this is a 409 — the request is well formed and would be fine in a minute —
 * where a bad id is a 400. `status` rides the error so the route needs no
 * second import to tell them apart.
 */
export class AccountInUseError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'AccountInUseError';
  }
}

/**
 * A token added under a name an account already has (control-tower phase 13,
 * #33). Re-pasting a token used to mint a second account for one identity —
 * the duplicate the usage dialog warns about, made by the console's own
 * repair path — so the add is refused and points at the account to repair.
 */
export class AccountNameTakenError extends Error {
  readonly status = 409;
  readonly existing: { id: string; kind: AccountKind };

  constructor(message: string, existing: { id: string; kind: AccountKind }) {
    super(message);
    this.name = 'AccountNameTakenError';
    this.existing = existing;
  }
}

/** Who asked for a check, and the seams a test drives it through. */
export type EntitlementProbeOptions = {
  /** The request's derived actor, whole — it goes onto `session.start` and the run line. */
  actor: { by: string } & Record<string, unknown>;
  /** Where the session runs. Defaults to a directory of its own under the registry. */
  cwd?: string;
} & Pick<ProbeSessionOptions, 'spawnFn' | 'timeoutMs' | 'ladder' | 'onEnded'>;

/** What a check found and did. */
export type EntitlementProbeResult = {
  account: AccountView;
  probe: LearnedProbe;
  /** Did a `claude` actually start (a signed-out login or a missing token is refused before any spend)? */
  spent: boolean;
  /** The breaker's move, when the check moved it. */
  moved?: { from: EntitlementView['state']; to: EntitlementView['state'] };
};

/**
 * Why a run is leaving an account — the argument to the ONE helper that marks
 * it (`leaveAccount`). `usage`: a window (the classifier's wall or the live
 * stream's), with the bucket's own name and reset when they parsed;
 * `credential`: a refusal no re-login mends, which RETIRES the credential's
 * organisation; `operator`: a person's switch, recorded and held against
 * nobody.
 */
export type LeaveReason = {
  kind: LeaveKind;
  reason: string;
  by: LeaveBy;
  /** `usage`: the window's registry name (`five_hour`, `seven_day_opus`, `learned_window`). */
  bucket?: string;
  /** `usage`: when the window reopens, when the CLI said. */
  resetsAt?: Date | null;
  /** `credential`: which class refused. */
  class?: CredentialClass;
  /**
   * `credential`: the verdict came from a category the API RETURNED, as data
   * on an `api_retry` event — not from a pattern matched against the session's
   * prose. It is half the gate on the organisation's row (the other half is
   * `ORG_SCOPED_CLASSES`), and it defaults to false because prose is what
   * almost every refusal is read from.
   *
   * Without it, a phase whose output merely QUOTED an org-refusal or billing
   * sentence retired the whole organisation — and the remedy for an outage is
   * to write the outage down.
   */
  structured?: boolean;
  /**
   * `credential`, class `certificate`: which SESSION met the fault. The
   * corroboration ledger counts distinct sessions, because one wedged lane
   * failing three times against one dropout is one opinion, not three.
   */
  session?: string;
  /** `usage`: a per-MODEL window — walls the bucket, never the account. */
  perModel?: boolean;
  /**
   * `credential`: what the verdict stood on and whose stop it was
   * (control-tower phase 54, #57) — kept on the retirement, so the account
   * view, the halt and a later switch can say why.
   */
  evidence?: RetirementEvidence;
};

/** What `leaveAccount` did, for the caller's journal line. */
export type LeaveResult = {
  accountId: string;
  credential: string;
  orgId?: string;
  /** `orgId` as a journal may carry it — the same eight hex the view shows. */
  orgIdHash?: string;
  /** The breaker's effective word after the write. */
  state: EntitlementView['state'];
  /** ISO — when the account is next a candidate, when a clock bounds it. */
  until?: string;
  /** The wall written, if one was. */
  wall?: { bucket: string; resetsAt: string };
  /** What the scheduler should hold this account until (ms), or null for "nothing to hold". */
  throttleUntilMs: number | null;
};

/** The quota door's verdict — never an exception (ACT-2). */
export type HeadroomVerdict =
  | {
    ok: true; accountId: string; /** Percent of the five-hour window used, when a live meter says. */ fiveHourPct?: number; warn?: { pct: number; resetsAt: string };
    /** Credits carry the account past its plan windows (control-tower phase 93, #146). */
    onCredit?: true;
  }
  | {
    ok: false; accountId: string; kind: 'retired' | 'wall' | 'spent'; reason: string; resetsAt?: string;
    /** `retired` (a `suspect` included): the retirement's evidence, when the breaker kept one (#57). */
    evidence?: RetirementEvidence;
  };

export type AccountsOptions = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  onChange?: () => void;
  /** Test seams: the registry directory (per instance) and the learned file (machine-wide). */
  registryDir?: string;
  learnedFile?: string;
  /**
   * Where profile logins and token files live — this instance's accounts
   * directory by default. A process reading another console's registrations
   * (the fleet supervisor's poller) names that console's.
   */
  accountsDir?: string;
  /** The label prefix for the learned store's ids — `<instance>/<accountId>`. Defaults to this console's. */
  instanceId?: string;
  /** Threshold crossings, for the announcer (W6). Percent, per bucket. */
  onThreshold?: (view: AccountView, bucket: string, level: 'warn' | 'alert', utilization: number, resetsAt: string) => void;
  /**
   * An account serving live runs is projected to wall inside the lead
   * (control-tower phase 92, #141): told once per window and reset, from a
   * real reading. The service announces it under `usage-climbing`.
   */
  onForecast?: (view: AccountView, bucket: string, forecast: BucketForecast) => void;
  /**
   * An account allowed to use credits stopped carrying its runs, or started
   * again (control-tower phase 93, #146) — once per transition, with the
   * reason. The service tells the operator; the rules read the new state on
   * their own.
   */
  onCredits?: (view: AccountView, change: { carrying: boolean; reason: string }) => void;
  /** How long before a projected wall `onForecast` fires, in ms — the operator's lead, `FORECAST_LEAD_HOURS` by default. */
  forecastLeadMs?: () => number;
  /**
   * An account's login went from known-good to expired/signed-out. Fired once
   * per transition, never on first observation — a profile mid-login must not
   * raise "sign in again" before anyone has signed in at all.
   */
  onAuthChange?: (view: AccountView, state: AuthState) => void;
  /**
   * The identity behind an account id changed — the machine login signed in as
   * somebody else, a profile re-logged (control-tower phase 91, #131). Told once
   * per change, never on a first observation; what the previous login learned
   * (its walls, its breaker) is already gone when this fires.
   */
  onIdentityChange?: (accountId: string, now: RunIdentity) => void;
  /**
   * A login-backed account's renewal failed while its access token had lapsed:
   * the console can no longer renew it, and a person has to (#147 ask 4). Once
   * per failure, with the exact fix.
   */
  onLoginAtRisk?: (view: AccountView, risk: { reason: string; fix: string }) => void;
  usageBase?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

// Owned by `shared/ops-vocab.js` since zero-touch-console phase 4, when the
// runner started deciding on in-session usage warnings against the same
// threshold the account meters announce at; re-exported under the names this
// module always had.
export { ALERT_PCT, WARN_PCT };

/** How long an identity read (exec-backed on macOS) is trusted before re-asking. */
const IDENTITY_TTL_MS = 60_000;

/** Expiry closer than this reads as `expiring` — the CLI refresh window. */
const AUTH_EXPIRING_MS = 30 * 60_000;

type Identity = {
  email?: string; org?: string; orgId?: string; plan?: string; signedIn: boolean; at: number;
  /** The oauth blob's own expiry, when one was readable. */
  expiresAt?: number;
  /** The blob holds what renews its access token (#111). */
  canRefresh?: boolean;
};

/** The model family a per-model window is named after (`seven_day_opus` ↔ an opus run). */
function familyOf(forModel: string | undefined): string | undefined {
  return forModel ? /(opus|sonnet|haiku|fable)/.exec(forModel.toLowerCase())?.[1] : undefined;
}

/**
 * Where a login-backed credential stands, from its blob alone. `expiresAt` is
 * the ACCESS token's expiry, a few hours out, and the CLI renews it at the next
 * session under that login — so a lapsed access token whose blob can renew it
 * is `refreshable`, never `expired` (control-tower phase 76, #111): an idle
 * profile read `expired` hours after its last session and dropped out of every
 * switch, the account with the most headroom included. `expired` is left for a
 * refusal (`Accounts.blobState`) and for a lapsed blob with nothing to renew it.
 */
function authStateOf(signedIn: boolean, expiresAt: number | undefined, now: number, canRefresh = false): AuthState {
  if (!signedIn) return 'signed-out';
  if (!expiresAt) return 'ok';
  if (expiresAt <= now) return canRefresh ? 'refreshable' : 'expired';
  if (expiresAt <= now + AUTH_EXPIRING_MS) return 'expiring';
  return 'ok';
}

export class Accounts {
  private readonly store: AccountStore;
  /** The machine-wide learned state — walls, the breaker, reads, tombstones. */
  readonly learned: LearnedAccounts;
  private readonly creds: Credentials;
  private readonly poller: UsagePoller;
  private readonly exec: Exec;
  private readonly identities = new Map<string, Identity>();
  /** Last announced threshold level per account:bucket, for hysteresis. */
  private announced = new Map<string, 'warn' | 'alert'>();
  /** Last observed auth state per account — the transition detector. */
  private auth = new Map<string, AuthState>();
  private isActive: (accountId: string) => boolean = () => false;
  /** Which runs spend an account now (`setBurningProbe`) — the forecast's "who is burning it". */
  private burning: (accountId: string) => BurningRun[] = () => [];
  /** Which live runs are set to pay as an account (`setPayingProbe`) — the bar's "paying" mark. */
  private paying: (accountId: string) => PayingRun[] = () => [];
  /** The projected walls already told, per account, window and reset (`onForecast`). */
  private readonly forecastTold = new Set<string>();
  /** What each account's live sessions last said about credit (#146), and when. */
  private readonly sessionCredit = new Map<string, SessionCredit & { at: number }>();
  /** Whether each allowed account was carrying at the last look — `onCredits` fires on a change (#146). */
  private readonly carryingWas = new Map<string, boolean>();
  private readonly opts: AccountsOptions;
  private readonly instanceId: string;
  private readonly accountsDir: string;
  /** The entitlement checks running now, by account — one at a time per account. */
  private readonly probing = new Map<string, Promise<EntitlementProbeResult>>();
  /** Each account's identity key (`identityKey`) and when it was read — the meters' owner (#109). */
  private readonly identityKeys = new Map<string, { key: string; at: number }>();
  /** A digest of the access token last handed to the poller, per account. */
  private readonly lastTokens = new Map<string, string>();
  /** A digest of the LIVE access token the endpoint refused, per account — `expired` until a new one replaces it (#111). */
  private readonly refusedTokens = new Map<string, string>();
  /** The renewal running now, by account — one at a time (`renewLogin`). */
  private readonly renewing = new Map<string, Promise<Renewal>>();
  /** The failed renewal last told about, by account — so each is told once. */
  private readonly atRisk = new Map<string, string>();
  /** When each account last proved its login with `claude auth status` after a read (`confirmLogin`). */
  private readonly loginProvedAt = new Map<string, string>();
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(opts: AccountsOptions = {}) {
    this.opts = opts;
    this.exec = opts.exec ?? realExec;
    this.instanceId = opts.instanceId ?? INSTANCE.id;
    this.accountsDir = opts.accountsDir ?? ACCOUNTS_DIR;
    this.store = new AccountStore(opts.registryDir);
    this.learned = new LearnedAccounts({
      ...(opts.learnedFile ? { file: opts.learnedFile } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.creds = new Credentials(this.exec, opts.platform ?? process.platform, undefined, this.accountsDir);
    this.poller = new UsagePoller({
      resolveToken: (id) => this.resolveToken(id),
      onUpdate: (id, usage, meta) => this.usageUpdated(id, usage, meta),
      isActive: (id) => this.isActive(id),
      exec: this.exec,
      ...(opts.usageBase ? { base: opts.usageBase } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.adoptLegacyWalls();
  }

  /**
   * A 4.1.0 registry kept each account's walls in its own row (`limitedUntil`),
   * and the machine login's in a reserved row minted for the purpose. Those
   * are the learned store's now — machine-wide, keyed by credential — so a
   * row's windows are folded in once and the field dropped, and the reserved
   * default row goes with it. Idempotent: a registry this build wrote has
   * nothing to fold.
   */
  private adoptLegacyWalls(): void {
    const rows = this.store.rowsWithLegacyLimits();
    if (!rows.length) return;
    const nowMs = this.now();
    for (const row of rows) {
      const fingerprint = this.fingerprintOf(row.id);
      for (const [bucket, iso] of Object.entries(row.limitedUntil ?? {})) {
        if (Date.parse(iso) > nowMs) this.learned.markWall(fingerprint, bucket, iso, nowMs);
      }
    }
    this.store.dropLegacyLimits();
    log.info('accounts.learned.adopted', { accounts: rows.map((row) => row.id) });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The learned store's label for an id: `<instance>/<accountId>`. */
  private labelOf(accountId: string): string {
    return `${this.instanceId}/${accountId}`;
  }

  /**
   * The credential a registration points at, as the learned store keys it. An
   * id nobody registered is fingerprinted as the machine login's would be under
   * that id — a stable key for a tombstone, never a credential anything reads.
   */
  fingerprintOf(accountId: string | undefined): string {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const meta = this.meta(id) ?? null;
    return credentialFingerprint(meta ? this.creds.credentialLocator(meta) : `unregistered:${this.labelOf(id)}`);
  }

  /**
   * The runner tells us how to recognise an account with a live session (ACT-3:
   * the seam had no production caller, so every account was polled on the
   * ten-minute idle clock — the one a live session was spending included).
   */
  setActiveProbe(probe: (accountId: string) => boolean): void {
    this.isActive = probe;
  }

  /** Who is burning each account — the service's runs, their lanes (control-tower phase 92, #141). */
  setBurningProbe(probe: (accountId: string) => BurningRun[]): void {
    this.burning = probe;
  }

  /** Who is set to PAY as each account — the service's live runs (control-tower phase 13, #33). */
  setPayingProbe(probe: (accountId: string) => PayingRun[]): void {
    this.paying = probe;
  }

  /** How soon the poller would ask about this account again, given the active probe — a test seam. */
  pollCadenceFor(accountId: string): number {
    return this.poller.cadenceFor(accountId);
  }

  startPolling(): void {
    let pollDefault = true;
    if (pollDefault) this.poller.track(DEFAULT_ACCOUNT_ID);
    for (const meta of this.store.stored()) this.poller.track(meta.id);
    // Keep-alive rides the same start (control-tower phase 91, #147): every
    // login-backed account is renewed through the CLI just before it lapses.
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => { void this.keepAlive().catch(() => undefined); }, KEEP_ALIVE_TICK_MS);
      this.keepAliveTimer.unref?.();
    }
  }

  stop(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.poller.stop();
  }

  /* ---------------- reading ---------------- */

  has(id: string): boolean {
    return id === DEFAULT_ACCOUNT_ID || Boolean(this.store.get(id));
  }

  /**
   * The account's credits as the console acts on them (control-tower phase 93,
   * #146): the operator's setting, the account's own credit state, the spend.
   */
  creditOf(accountId: string | undefined, nowMs = this.now()): CreditView {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const snapshot = this.poller.snapshot(id);
    return creditVerdict({
      setting: this.store.overageOf(id), credits: snapshot?.credits, readAt: snapshot?.fetchedAt,
      session: this.sessionCredit.get(id), nowMs,
    });
  }

  /**
   * Do credits carry this account's runs past its plan windows right now
   * (#146)? The operator allowed it AND its own credit state says so — the one
   * bit every plan-window threshold reads: the preflight door, the 80/95 %
   * pushes, the forecast's warning and hold, the runner's 95 % decision and
   * its live wall.
   */
  creditCarries(accountId: string | undefined): boolean {
    return this.creditOf(accountId).carrying;
  }

  /**
   * "Use credits past plan limits" (control-tower phase 93, #146; operator
   * decision 12): per account, OFF by default. Switching it ON is verified,
   * not trusted — the account's own credit state must say credits are there
   * under the cap (the operator's, else the API's monthly limit), or it is
   * refused with the reason. OFF needs nothing.
   */
  setOverage(
    accountId: string, allowed: boolean, opts: { capUsd?: number | null; by?: string } = {},
  ): { ok: true; credits: CreditView } | { ok: false; reason: string } {
    const id = accountId || DEFAULT_ACCOUNT_ID;
    if (!this.has(id)) return { ok: false, reason: `no account ${id}` };
    const nowMs = this.now();
    if (!allowed) {
      this.store.setOverage(id, undefined);
      this.carryingWas.delete(id);
      log.info('accounts.overage-set', { account: id, allowed: false, ...(opts.by ? { by: opts.by } : {}) });
      this.changed();
      return { ok: true, credits: this.creditOf(id, nowMs) };
    }
    const capUsd = typeof opts.capUsd === 'number' && Number.isFinite(opts.capUsd) && opts.capUsd >= 0 ? opts.capUsd : undefined;
    const setting: OverageSetting = {
      at: new Date(nowMs).toISOString(), ...(opts.by ? { by: opts.by } : {}), ...(capUsd !== undefined ? { capUsd } : {}),
    };
    const snapshot = this.poller.snapshot(id);
    const verdict = creditVerdict({ setting, credits: snapshot?.credits, readAt: snapshot?.fetchedAt, session: this.sessionCredit.get(id), nowMs });
    if (!verdict.carrying) {
      log.info('accounts.overage-refused', { account: id, reason: verdict.reason });
      return { ok: false, reason: `${this.labelFor(id)} cannot use credits past its plan limits: ${verdict.reason}` };
    }
    this.store.setOverage(id, setting);
    this.carryingWas.set(id, true);
    log.info('accounts.overage-set', { account: id, allowed: true, ...(capUsd !== undefined ? { capUsd } : {}), ...(opts.by ? { by: opts.by } : {}) });
    this.changed();
    return { ok: true, credits: verdict };
  }

  /**
   * A live session's word on credit (control-tower phase 93, #146): its
   * `rate_limit_event`'s overage fields. A refusal (`overageStatus: rejected`,
   * an `overageDisabledReason`) stops the carry at once, before any poll.
   */
  noteSessionCredit(accountId: string | undefined, info: SessionCredit): void {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    this.sessionCredit.set(id, { ...info, at: this.now() });
    this.creditWatch(id);
  }

  /** Tell `onCredits` when an allowed account's carry changed, once per change (#146). */
  private creditWatch(accountId: string): void {
    if (!this.store.overageOf(accountId)) {
      this.carryingWas.delete(accountId);
      return;
    }
    const verdict = this.creditOf(accountId);
    const was = this.carryingWas.get(accountId);
    this.carryingWas.set(accountId, verdict.carrying);
    if (was === undefined || was === verdict.carrying) return;
    log.info('accounts.credits-changed', { account: accountId, carrying: verdict.carrying, reason: verdict.reason });
    const meta = this.meta(accountId);
    if (!meta) return;
    void this.view(meta).then((view) => {
      this.opts.onCredits?.(view, { carrying: verdict.carrying, reason: verdict.reason });
    });
    this.changed();
  }

  meta(id: string): AccountMeta | undefined {
    if (id === DEFAULT_ACCOUNT_ID) {
      return {
        id: DEFAULT_ACCOUNT_ID, kind: 'default', createdAt: '',
        ...(this.store.defaultName ? { name: this.store.defaultName } : {}),
      };
    }
    return this.store.get(id);
  }

  /**
   * Every account as the browser may see it. Identity reads are cached. Each
   * candidate carries its place in the rank (`breaker.rank`) — the order an
   * `auto` pick walks — computed once for the list by `rankAccounts` itself.
   */
  async list(): Promise<AccountView[]> {
    const views: AccountView[] = [await this.view(this.meta(DEFAULT_ACCOUNT_ID)!)];
    for (const meta of this.store.stored()) views.push(await this.view(meta));
    const order = this.rankAccounts(null, undefined, this.now());
    for (const view of views) {
      const at = order.indexOf(view.id);
      if (view.breaker?.candidate && at >= 0) view.breaker = { candidate: true, rank: at + 1 };
    }
    return views;
  }

  /**
   * The registrations this console REMOVED that the machine-wide learned store
   * still remembers — the tombstones `labelFor` answers a journal's old ids
   * from, as rows a person can read (phase 15). An id registered again is not
   * a tombstone any more, whatever the store says; newest removal first.
   */
  tombstones(): TombstoneView[] {
    const prefix = `${this.instanceId}/`;
    const nowMs = this.now();
    const out: TombstoneView[] = [];
    for (const row of Object.values(this.learned.snapshot().credentials)) {
      if (!row.tombstone) continue;
      for (const label of row.ids) {
        if (!label.startsWith(prefix)) continue;
        const id = label.slice(prefix.length);
        if (this.has(id)) continue;
        const orgId = hashedOrgId(row.orgId);
        out.push({
          id, name: row.tombstone.name, retiredAt: row.tombstone.retiredAt, credential: row.fingerprint,
          ...(orgId ? { orgId } : {}),
          entitlement: this.learned.entitlementOf(row.fingerprint, row.orgId, nowMs),
        });
      }
    }
    return out.sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  }

  private async view(meta: AccountMeta): Promise<AccountView> {
    const identity = await this.identity(meta);
    const pollEveryMs = this.poller.cadenceFor(meta.id);
    const snapshot = this.poller.snapshot(meta.id);
    // Each bucket with its age and a stale mark (#109) — a copy for the view.
    const usage = snapshot ? agedUsage(snapshot, pollEveryMs, this.now()) : undefined;
    const limited = this.limitedUntil(meta.id);
    const fingerprint = this.fingerprintOf(meta.id);
    const learned = this.learned.credential(fingerprint);
    const entitlement = this.learned.entitlementOf(fingerprint, learned?.orgId, this.now());
    // Display the LAST OBSERVED state, never a recomputation: the identity
    // cache can be up to a minute staler than the poller's read, and a view
    // that recomputed from it un-noted a fresh `expired` — which made the
    // transition announce again on the next poll. A RETIRED credential reads
    // `unusable` whatever its login says: the login may be valid and the
    // organisation still refuses it work.
    // A token account's login is read from its age (control-tower phase 91,
    // #147): a setup-token lasts a year, so `unknown` was never the honest word.
    // Its age says when it WILL stop; the poller's verdict says it HAS — an
    // endpoint that served this credential and now refuses it (control-tower
    // phase 13, #33) — and a verdict outranks an estimate.
    const polled = this.auth.get(meta.id);
    const observed = meta.kind === 'token'
      ? (polled === 'expired' || polled === 'signed-out' ? polled : tokenLoginState(Date.parse(meta.replacedAt ?? meta.createdAt), this.now()))
      : polled ?? authStateOf(identity.signedIn, identity.expiresAt, Date.now(), identity.canRefresh);
    const state: AuthState = entitlement.state === 'retired' || entitlement.state === 'suspect' ? 'unusable' : observed;
    const orgId = hashedOrgId(learned?.orgId ?? identity.orgId);
    return {
      id: meta.id,
      kind: meta.kind,
      builtIn: meta.id === DEFAULT_ACCOUNT_ID,
      ...(meta.name ? { name: meta.name } : {}),
      ...(identity.email ? { email: identity.email } : meta.email ? { email: meta.email } : {}),
      ...(identity.org ? { org: identity.org } : {}),
      ...(orgId ? { orgId } : {}),
      credential: fingerprint,
      ...(identity.plan ? { plan: identity.plan } : meta.plan ? { plan: meta.plan } : {}),
      ...(meta.kind === 'profile' ? { signedIn: identity.signedIn } : {}),
      authState: state,
      entitlement,
      ...(usage ? { usage } : {}),
      ...(learned?.lastErrorAt ? { lastErrorAt: learned.lastErrorAt } : {}),
      ...(learned?.lastSuccessAt ? { lastSuccessAt: learned.lastSuccessAt } : {}),
      ...(Object.keys(limited).length ? { limitedUntil: limited } : {}),
      ...(learned?.lastLeftAt ? { lastLeftAt: learned.lastLeftAt } : {}),
      ...(learned?.probe ? { probe: learned.probe } : {}),
      pollEveryMs,
      breaker: this.standing(meta.id, this.now()),
      forecast: this.forecastOf(meta.id, snapshot, this.now()),
      credits: this.creditOf(meta.id),
      ...(meta.kind === 'token'
        ? (() => { const ends = tokenExpiresAt(Date.parse(meta.replacedAt ?? meta.createdAt)); return ends ? { tokenExpiresAt: ends } : {}; })()
        : { unattended: UNATTENDED_OFFER }),
      meter: meterStateOf(state, usage),
      paying: this.payingOn(meta.id),
    };
  }

  /** The paying probe, read defensively — a view must render whatever the runs are doing. */
  private payingOn(id: string): PayingRun[] {
    try {
      return this.paying(id);
    } catch {
      return [];
    }
  }

  /**
   * Every account's forecast per live window, from the poller's cache — what
   * `/api/metrics` exports (control-tower phase 92, #141). Sync, like the rank.
   */
  forecasts(nowMs = this.now()): { id: string; buckets: Record<string, BucketForecast> }[] {
    return this.accountIds().map((id) => ({ id, buckets: forecastUsage(this.poller.snapshot(id), nowMs) }));
  }

  /**
   * One account's forecast (control-tower phase 92, #141): every live window's
   * burn and projected wall from the readings the poller kept, the soonest wall,
   * and the runs burning the account now.
   */
  private forecastOf(id: string, snapshot: AccountUsage | undefined, nowMs: number): AccountForecast {
    const buckets = forecastUsage(snapshot, nowMs);
    let wallsAt: string | null = null;
    let bucket: string | null = null;
    for (const [name, forecast] of Object.entries(buckets)) {
      if (forecast.wallsAt && (wallsAt === null || Date.parse(forecast.wallsAt) < Date.parse(wallsAt))) {
        wallsAt = forecast.wallsAt;
        bucket = name;
      }
    }
    let burning: BurningRun[] = [];
    try {
      burning = this.burning(id);
    } catch {
      burning = [];
    }
    return { buckets, wallsAt, bucket, burning };
  }

  /**
   * Who a login-backed account belongs to, from the CLI's own files — cheap
   * enough to keep fresh, exec-backed enough to cache. Token accounts have no
   * identity beyond the name the operator gave them (the whole reason the add
   * flow demands a name).
   */
  private async identity(meta: AccountMeta): Promise<Identity> {
    if (meta.kind === 'token') return { signedIn: true, at: 0 };
    const cached = this.identities.get(meta.id);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached;
    const configDir = meta.kind === 'profile' ? profileConfigDir(meta.id, this.accountsDir) : null;
    const who = this.creds.readIdentity(configDir);
    const oauth = await this.creds.readClaudeOauth(configDir);
    const identity: Identity = {
      ...(who?.email ? { email: who.email } : {}),
      ...(who?.org ? { org: who.org } : {}),
      ...(who?.orgId ? { orgId: who.orgId } : {}),
      ...(oauth?.subscriptionType ? { plan: oauth.subscriptionType } : {}),
      signedIn: Boolean(oauth),
      at: Date.now(),
      ...(oauth?.expiresAt ? { expiresAt: oauth.expiresAt } : {}),
      ...(oauth?.canRefresh ? { canRefresh: true } : {}),
    };
    this.identities.set(meta.id, identity);
    // The organisation is a CREDENTIAL fact — the breaker's key — and goes to
    // the machine-wide store, never into the view raw.
    this.learned.noteIdentity(this.fingerprintOf(meta.id), {
      label: this.labelOf(meta.id), ...(who?.orgId ? { orgId: who.orgId } : {}),
    });
    // Somebody else signed in under this login's locator (#109): the meters
    // on hand are the previous identity's, so they go, and a read is asked for
    // now rather than at the end of the account's clock.
    if (this.poller.noteIdentity(meta.id, this.rememberIdentityKey(meta.id, who))) this.changed();
    // A FRESH credential read is an auth observation; a cache hit is not.
    this.noteAuth(meta.id, this.blobState(meta.id, oauth));
    return identity;
  }

  /**
   * Whose login an account is, as its meters are keyed (control-tower phase 76,
   * #109): a digest of the credential's fingerprint and the organisation and
   * email the CLI recorded beside it. `default` is fingerprinted by its
   * LOCATOR, so a re-login as somebody else keeps the fingerprint — the
   * organisation and the email are what move. A token account has no identity
   * beyond its credential (`addToken` already forgets a replaced one). The
   * read is a file read, cached like `identity`'s unless `fresh`.
   */
  private identityKey(meta: AccountMeta, fresh = false): string | undefined {
    if (meta.kind === 'token') return undefined;
    const cached = this.identityKeys.get(meta.id);
    if (!fresh && cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.key;
    const configDir = meta.kind === 'profile' ? profileConfigDir(meta.id, this.accountsDir) : null;
    return this.rememberIdentityKey(meta.id, this.creds.readIdentity(configDir));
  }

  private rememberIdentityKey(id: string, who: { email?: string; org?: string; orgId?: string } | null): string {
    const key = createHash('sha256')
      .update([this.fingerprintOf(id), who?.orgId ?? '', who?.email ?? ''].join('\n'))
      .digest('hex')
      .slice(0, 16);
    const before = this.identityKeys.get(id)?.key;
    this.identityKeys.set(id, { key, at: Date.now() });
    // Only a login that names somebody is an identity; a profile mid-login is not.
    if (before !== key && (who?.email || who?.orgId)) this.noteIdentityKey(id, key, who);
    return key;
  }

  /**
   * An identity key seen for the first time in this process, told to the
   * machine-wide store (control-tower phase 91, #109's deferral, #131): when it
   * differs from the one the credential's row learned under, the walls and the
   * breaker of the previous login go, the login state is read afresh, and the
   * service is told — it parks every run bound to the old identity.
   */
  private noteIdentityKey(id: string, key: string, who: { email?: string; org?: string; orgId?: string }): void {
    const moved = this.learned.noteIdentityKey(this.fingerprintOf(id), key, this.labelOf(id));
    if (!moved?.changed) return;
    this.auth.delete(id);
    this.refusedTokens.delete(id);
    this.atRisk.delete(id);
    this.loginProvedAt.delete(id);
    log.info('accounts.identity-rekeyed', { account: id, walls: moved.walls, breaker: moved.breaker });
    this.changed();
    const now: RunIdentity = { account: id, key, ...(who.email ? { email: who.email } : {}), ...(who.org ? { org: who.org } : {}) };
    try {
      this.opts.onIdentityChange?.(id, now);
    } catch (error) {
      log.warn('accounts.identity-change-failed', { account: id, error: (error as Error).message });
    }
  }

  /**
   * Who this account id answers NOW (control-tower phase 91, #131) — read
   * afresh from the CLI's own `.claude.json`, so a re-login is seen the moment
   * it happens. A token account is its credential. Undefined for an id nobody
   * registered, or a login that names nobody yet.
   */
  identityOf(accountId?: string): RunIdentity | undefined {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const meta = this.meta(id);
    if (!meta) return undefined;
    if (meta.kind === 'token') return { account: id, key: `token:${this.fingerprintOf(id)}`, ...(meta.email ? { email: meta.email } : {}) };
    const configDir = meta.kind === 'profile' ? profileConfigDir(id, this.accountsDir) : null;
    const who = this.creds.readIdentity(configDir);
    if (!who?.email && !who?.orgId) return undefined;
    const key = this.rememberIdentityKey(id, who);
    return { account: id, key, ...(who.email ? { email: who.email } : {}), ...(who.org ? { org: who.org } : {}) };
  }

  /**
   * Every registered account that answers the same PERSON as `identity` — its
   * email and organisation — other than the one it was read on: where a run
   * bound to that identity may move when its own account now answers somebody
   * else (#131's "move to the same-identity profile").
   */
  sameIdentity(identity: Pick<RunIdentity, 'account' | 'email' | 'org'>): string[] {
    if (!identity.email) return [];
    return this.accountIds().filter((id) => {
      if (id === identity.account) return false;
      const other = this.identityOf(id);
      return Boolean(other && other.email === identity.email && (!identity.org || !other.org || other.org === identity.org));
    });
  }

  /* ---------------- keep-alive (control-tower phase 91, #147) ---------------- */

  /**
   * Renew one login-backed account through the CLI's own refresh
   * (`keep-alive.ts`, measured), single-flight per account. A renewal that
   * failed while the token had lapsed is told once (`onLoginAtRisk`); it is no
   * VERDICT on the login — `expired` still comes only from the endpoint
   * refusing a live token (#111), because a refresh can fail for want of a
   * network as easily as for a revoked login.
   */
  async renewLogin(accountId?: string): Promise<Renewal> {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const meta = this.meta(id);
    if (!meta || meta.kind === 'token') return { outcome: 'no-login', reason: 'a setup-token has nothing to renew' };
    const running = this.renewing.get(id);
    if (running) return running;
    const configDir = meta.kind === 'profile' ? profileConfigDir(id, this.accountsDir) : null;
    const work = renewLogin({ exec: this.exec, configDir, read: () => this.creds.readClaudeOauth(configDir) })
      .then((answer) => { this.noteRenewal(meta, configDir, answer); return answer; })
      .finally(() => this.renewing.delete(id));
    this.renewing.set(id, work);
    return work;
  }

  private noteRenewal(meta: AccountMeta, configDir: string | null, answer: Renewal): void {
    log.info('accounts.keep-alive', {
      account: meta.id, outcome: answer.outcome,
      ...(answer.after ? { expiresAt: new Date(answer.after).toISOString() } : {}),
    });
    this.identities.delete(meta.id);
    if (answer.outcome === 'renewed') {
      this.atRisk.delete(meta.id);
      this.changed();
      return;
    }
    if (answer.outcome !== 'failed') return;
    const mark = String(answer.before ?? 'none');
    if (this.atRisk.get(meta.id) === mark) return;
    this.atRisk.set(meta.id, mark);
    const fix = loginFix(meta.kind, configDir, this.labelFor(meta.id), homedir());
    log.warn('accounts.login-at-risk', { account: meta.id, reason: answer.reason });
    const tell = this.opts.onLoginAtRisk;
    if (tell) void this.view(meta).then((view) => tell(view, { reason: answer.reason, fix })).catch(() => undefined);
  }

  /**
   * One keep-alive pass: every login-backed account whose access token is
   * inside `KEEP_ALIVE_LEAD_MS` of lapsing (or past it) is renewed, the rest
   * are not asked. A console following the machine's poll owner leaves it to
   * the owner, which hosts every console's registrations — two renewals of one
   * login at once would race the CLI's refresh-token rotation.
   */
  async keepAlive(nowMs = Date.now()): Promise<Record<string, Renewal>> {
    let following = false;
    const out: Record<string, Renewal> = {};
    if (following) return out;
    let withDefault = true;
    const ids = [...(withDefault ? [DEFAULT_ACCOUNT_ID] : []), ...this.store.stored().filter((m) => m.kind === 'profile').map((m) => m.id)];
    for (const id of ids) {
      const meta = this.meta(id)!;
      const configDir = meta.kind === 'profile' ? profileConfigDir(id, this.accountsDir) : null;
      const due = keepAliveDueAt(await this.creds.readClaudeOauth(configDir));
      if (due === null || due > nowMs) continue;
      out[id] = await this.renewLogin(id);
    }
    return out;
  }

  /**
   * Has this account's login come back since `sinceIso`, on the identity
   * `key` (control-tower phase 91, #147, operator decision 12)? True once
   * `claude auth status` confirmed it after a usage read that landed after the
   * stop, the breaker holds no retirement over it, and it answers that same
   * identity. What lets an expired or signed-out stop resume with no press.
   */
  loginRestored(accountId: string | undefined, sinceIso: string, key: string | undefined): boolean {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (!key || this.identityOf(id)?.key !== key) return false;
    const proved = this.loginProvedAt.get(id);
    const read = this.learned.credential(this.fingerprintOf(id))?.lastSuccessAt;
    if (!proved || !read || !(proved >= sinceIso) || !(read >= sinceIso)) return false;
    const word = this.entitlementOf(id).state;
    return word !== 'retired' && word !== 'suspect';
  }

  /**
   * A read landed on an account whose breaker holds an `auth` retirement — the
   * runner's word for an expired or signed-out login. Ask `claude auth status`
   * under its own environment; logged in, and the read having landed after the
   * retirement, the lapse is answered and the retirement reopened. Only `auth`:
   * an organisation, billing or policy refusal says nothing a sign-in mends
   * (RCV-1). The proof is kept for `loginRestored`.
   */
  private async confirmLogin(accountId: string, readAt: string, retiredAt: string): Promise<void> {
    const meta = this.meta(accountId);
    if (!meta || meta.kind === 'token') return;
    const configDir = meta.kind === 'profile' ? profileConfigDir(accountId, this.accountsDir) : null;
    let status: AuthStatus;
    try {
      const env = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;
      if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
      const { stdout } = await this.exec('claude', ['auth', 'status', '--json'], { env });
      status = parseAuth(stdout, '', new Date(this.now()).toISOString());
    } catch {
      return;
    }
    if (!status.loggedIn) return;
    const fingerprint = this.fingerprintOf(accountId);
    const word = this.learned.entitlementOf(fingerprint, undefined, this.now());
    const at = new Date(this.now()).toISOString();
    this.loginProvedAt.set(accountId, at);
    // `noteProof` is the breaker's own door for this: it answers a CLASSIFIER's
    // retirement (demote and clear in one write) and leaves one a person wrote.
    const reopened = (word.state === 'retired' || word.state === 'suspect') && word.class === 'auth' && readAt > retiredAt
      ? this.learned.noteProof(fingerprint, { at, by: 'proof', reason: 'the login works again — `claude auth status` and a usage read both succeeded' }, this.labelOf(accountId))
      : null;
    if (reopened) {
      if (this.auth.get(accountId) === 'unusable') this.auth.delete(accountId);
      log.info('accounts.login-restored', { account: accountId, from: reopened.from, to: reopened.to });
    }
    this.changed();
  }

  /**
   * The login state a credential blob supports, before any answer (#111). A
   * lapsed access token the blob can renew is `refreshable`; the blob-level
   * `expired` is a LIVE token the endpoint already refused — until a new token
   * replaces it, the blob's own clock does not flip that verdict back to `ok`,
   * which would announce "sign in again" on every poll.
   */
  private blobState(id: string, oauth: ClaudeOauth | null): AuthState {
    const refused = this.refusedTokens.get(id);
    if (oauth && refused) {
      if (refused === tokenDigest(oauth.accessToken)) return 'expired';
      this.refusedTokens.delete(id);
    }
    return authStateOf(Boolean(oauth), oauth?.expiresAt, Date.now(), Boolean(oauth?.canRefresh));
  }

  /**
   * What `claude auth status` said under this account's env — the runner's
   * preflight probe, forwarded so the organisation it named reaches the
   * learned store (a token account has no `.claude.json` to read it from).
   */
  noteAuthProbe(accountId: string | undefined, status: AuthStatus): void {
    if (!status.orgId) return;
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    this.learned.noteIdentity(this.fingerprintOf(id), { label: this.labelOf(id), orgId: status.orgId });
  }

  /**
   * Record an observed auth state; announce only the transition INTO a broken
   * state FROM a known-good one. First observation never fires (a fresh
   * profile mid-login must not raise "sign in again"), and the poller's own
   * refresh attempt runs before its reads land here, so a login the CLI can
   * still refresh never presents as broken at all.
   */
  private noteAuth(id: string, state: AuthState): void {
    const before = this.auth.get(id);
    if (before === state) return;
    this.auth.set(id, state);
    this.changed();
    const broken = state === 'expired' || state === 'signed-out';
    const wasGood = before === 'ok' || before === 'expiring' || before === 'refreshable';
    if (broken && wasGood && this.opts.onAuthChange) {
      const meta = this.meta(id);
      if (meta) void this.view(meta).then((view) => this.opts.onAuthChange?.(view, state));
    }
  }

  /** Last observed login state, for callers that only need the word. */
  authStateFor(accountId: string | undefined): AuthState | undefined {
    return this.auth.get(accountId ?? DEFAULT_ACCOUNT_ID);
  }

  /* ---------------- registration ---------------- */

  /**
   * A pasted `claude setup-token`. Validated by shape only — the token is
   * proven the first time something runs under it, and the usage poller will
   * say `unsupported` if the endpoint refuses the kind. The name is required
   * because a token carries no email to show (requirement: ask the operator
   * to name the account when the API cannot).
   */
  async addToken(name: string, token: string): Promise<AccountView> {
    const trimmed = token.trim();
    if (!/^[\w-]{20,512}$/.test(trimmed)) {
      throw new Error('that does not look like a token from `claude setup-token`');
    }
    // One name, one account (control-tower phase 13, #33): re-pasting was how
    // an operator answered "this token does not work", and it minted a second
    // row for one identity. The answer is the account that already has it.
    const folded = (text: string | undefined) => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const taken = this.store.stored().find((meta) => meta.name && folded(meta.name) === folded(name));
    if (taken) {
      throw new AccountNameTakenError(
        `an account named "${taken.name}" already exists (${taken.id}) — `
          + (taken.kind === 'token'
            ? `replace its credential instead (PUT /api/accounts/${taken.id}/credential), so nothing that names it has to change`
            : 'sign it in again instead, or give the new token another name'),
        { id: taken.id, kind: taken.kind },
      );
    }
    const id = this.store.newId(name);
    await this.creds.storeToken(id, trimmed);
    const meta: AccountMeta = { id, kind: 'token', name, createdAt: new Date().toISOString() };
    this.store.add(meta);
    // The one release from a sticky `unsupported`. A minted id is normally
    // fresh, but `newId` reuses a readable base once its holder is removed, so
    // a cache entry can outlive the account that earned it — and re-pasting is
    // also how an operator answers "this token does not work". Either way the
    // credential behind this id is new, so nothing learned about the old one
    // may speak for it.
    this.poller.forgetCredentialVerdict(id);
    // …and the learned store's row for the locator: a different credential
    // under an old keychain item is a different credential (walls, breaker,
    // tombstone and all — see `LearnedAccounts.forget`).
    this.learned.forget(this.fingerprintOf(id));
    this.poller.track(id);
    this.poller.kick(id);
    this.changed();
    log.info('accounts.token.added', { account: id });
    return this.view(meta);
  }

  /**
   * Replace a token account's credential, keeping its id and its name
   * (control-tower phase 13, #33) — the repair `addToken` used to perform by
   * minting a second account. The id is what journals, run files and pools
   * name, so it must not change; everything the machine learned about the OLD
   * credential must — its walls, its breaker and its tombstone (the learned
   * row), the poller's `unsupported` and its login verdicts — because the
   * credential behind this id is new. `undefined` when no such account; a
   * profile or the machine login has no token and is signed in again instead.
   */
  async replaceToken(id: string, token: string): Promise<AccountView | undefined> {
    const meta = this.store.get(id);
    if (!meta && id !== DEFAULT_ACCOUNT_ID) return undefined;
    if (!meta || meta.kind !== 'token') {
      throw new Error(`${this.labelFor(id)} has no token to replace — sign it in again instead`);
    }
    const trimmed = token.trim();
    if (!/^[\w-]{20,512}$/.test(trimmed)) {
      throw new Error('that does not look like a token from `claude setup-token`');
    }
    const before = this.fingerprintOf(id);
    await this.creds.storeToken(id, trimmed);
    // A setup-token lasts a year from when it was made, so its age starts again.
    const updated = this.store.update(id, { replacedAt: new Date().toISOString() }) ?? meta;
    this.learned.forget(before);
    if (this.fingerprintOf(id) !== before) this.learned.forget(this.fingerprintOf(id));
    this.poller.forgetCredentialVerdict(id);
    this.auth.delete(id);
    this.refusedTokens.delete(id);
    this.identities.delete(id);
    this.poller.track(id);
    this.poller.kick(id);
    this.changed();
    log.info('accounts.token.replaced', { account: id });
    return this.view(updated);
  }

  /**
   * The fix for a login that is expired or signed out, as a person types it —
   * EVERY kind, the machine login included (control-tower phase 13, #33): the
   * one `loginFix` sentence the keep-alive warning already speaks, so the run's
   * preflight refusal and the account card say the same thing.
   */
  signInFix(accountId: string | undefined): string {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const kind = this.meta(id)?.kind ?? 'default';
    const configDir = kind === 'profile' ? profileConfigDir(id, this.accountsDir) : null;
    return loginFix(kind, configDir, this.labelFor(id), homedir());
  }

  /**
   * Start a profile: the directory exists from this moment, the login happens
   * in a terminal the service puts in front of the operator, and
   * `completeLogin` reads back who they became.
   */
  beginProfile(name?: string): { id: string; dir: string } {
    const id = this.store.newId(name ?? 'account');
    const dir = profileConfigDir(id, this.accountsDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.store.add({ id, kind: 'profile', ...(name ? { name } : {}), createdAt: new Date().toISOString() });
    // A directory minted again under a reused id is a new credential: nothing
    // learned about the old one speaks for it.
    this.learned.forget(this.fingerprintOf(id));
    this.poller.track(id);
    this.changed();
    log.info('accounts.profile.created', { account: id });
    return { id, dir };
  }

  /** After a login terminal exits: read back the identity, remember it. */
  async completeLogin(id: string): Promise<AccountView | undefined> {
    // The machine login signs in from the console too (control-tower phase 13,
    // #33): its exit drops what the console believed about the OLD login — the
    // cached identity, a refused token, the last verdict — and reads it again.
    // The CLI's own store is read, never written.
    if (id === DEFAULT_ACCOUNT_ID) {
      const builtIn = this.meta(id);
      if (!builtIn) return undefined;
      this.identities.delete(id);
      this.refusedTokens.delete(id);
      this.auth.delete(id);
      this.poller.kick(id);
      this.changed();
      return this.view(builtIn);
    }
    const meta = this.store.get(id);
    if (!meta || meta.kind !== 'profile') return undefined;
    this.identities.delete(id);
    const dir = profileConfigDir(id, this.accountsDir);
    // `claude auth status` under the profile confirms its credentials — it
    // renews nothing (measured, control-tower phase 91; keep-alive does) — and
    // the identity file fills in the address to display.
    try {
      const { stdout } = await this.exec('claude', ['auth', 'status'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      });
      const status = parseAuth(stdout, '', new Date().toISOString());
      if (status.email || status.subscription) {
        this.store.update(id, {
          ...(status.email ? { email: status.email } : {}),
          ...(status.subscription ? { plan: status.subscription } : {}),
        });
      }
    } catch (error) {
      log.warn('accounts.login.probe-failed', { account: id, error: (error as Error).message });
    }
    const who = this.creds.readIdentity(dir);
    if (who?.email) this.store.update(id, { email: who.email });
    this.poller.kick(id);
    this.changed();
    return this.view(this.store.get(id)!);
  }

  /**
   * Forget an account. The profile directory (and with it, on Linux, its
   * credentials file) is removed, and on macOS so is the CLI's HASHED keychain
   * item for that directory — it exists only because this console minted the
   * dir, and with the dir gone its hash can never come up again. The plain
   * `Claude Code-credentials` item (the machine login) is never touched:
   * deleting from the CLI's shared store is the one write this console never
   * performs.
   */
  async remove(id: string): Promise<boolean> {
    if (id === DEFAULT_ACCOUNT_ID) throw new Error('the machine login cannot be removed here');
    // The tombstone BEFORE the row goes: the fingerprint is derived from the
    // registration's kind, and once the row is gone the id fingerprints as an
    // unregistered one. `labelFor` answers this name for as long as a journal
    // still says the id paid for something (ACT-10).
    const before = this.store.get(id);
    if (before) {
      this.learned.tombstone(this.fingerprintOf(id), this.labelOf(id), before.name ?? before.email ?? id);
    }
    const meta = this.store.remove(id);
    if (!meta) return false;
    this.poller.untrack(id);
    this.identities.delete(id);
    this.identityKeys.delete(id);
    this.lastTokens.delete(id);
    this.refusedTokens.delete(id);
    this.auth.delete(id);
    if (meta.kind === 'token') await this.creds.deleteToken(id);
    if (meta.kind === 'profile') await this.creds.deleteProfileCredential(profileConfigDir(id, this.accountsDir));
    try {
      rmSync(profileConfigDir(id, this.accountsDir), { recursive: true, force: true });
      rmSync(profileConfigDir(id, this.accountsDir).replace(/\/config$/, ''), { recursive: true, force: true });
    } catch { /* best effort — an empty husk is untidy, not unsafe */ }
    this.changed();
    log.info('accounts.removed', { account: id, kind: meta.kind });
    return true;
  }

  /**
   * Give an account a new display name. The NAME only, never the id: ids are
   * journal keys, throttle keys, path segments and the keychain-service hash
   * input — renaming one would orphan credentials and break every reference.
   * The machine login stores its name as the registry's `defaultName`, because
   * its row is synthesized and a stored row would double-list.
   */
  async rename(id: string, name: string): Promise<AccountView | undefined> {
    const trimmed = name.trim().slice(0, 64);
    if (id === DEFAULT_ACCOUNT_ID) {
      this.store.setDefaultName(trimmed || undefined);
    } else {
      if (!this.store.get(id)) return undefined;
      this.store.update(id, { name: trimmed || undefined });
    }
    this.changed();
    log.info('accounts.renamed', { account: id, named: Boolean(trimmed) });
    const meta = this.meta(id);
    return meta ? this.view(meta) : undefined;
  }

  /* ---------------- what the runner needs ---------------- */

  /**
   * Env to merge into a child so it runs as this account. `null` = inherit.
   *
   * A profile's config dir is provisioned on the way out (the `skills` and
   * `plugins` links, the login's plugin settings, and workspace trust for
   * `trustRoots`) — see `workspace.ts` for the incident
   * that made this load-bearing: a bare `CLAUDE_CONFIG_DIR` boots sessions
   * that cannot find `/phased-execution` and exit success with zero turns.
   */
  async envFor(accountId: string | undefined, trustRoots: string[] = []): Promise<NodeJS.ProcessEnv | null> {
    if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return null;
    const env = await this.creds.envFor(this.store.get(accountId) ?? null);
    if (env?.CLAUDE_CONFIG_DIR) ensureProfileWorkspace(env.CLAUDE_CONFIG_DIR, trustRoots);
    return env;
  }

  /** Where this instance keeps its profile accounts — one directory per id. */
  get dir(): string {
    return this.accountsDir;
  }

  /** The config dir a child under this account uses — transcript porting. */
  configDirFor(accountId: string | undefined): string {
    const meta = accountId ? this.meta(accountId) : null;
    return this.creds.configDirFor(meta ?? null);
  }

  /**
   * ONE path for every kind, into the MACHINE-WIDE store. The default account
   * used to branch away into a volatile field here (its walls did not survive
   * a restart), then into a reserved registry row (they survived a restart and
   * not a second console); the learned store is keyed by the credential, so
   * the machine login's wall is every console's wall (ACT-10).
   */
  markLimited(accountId: string | undefined, bucket: string, resetsAt: string): void {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    this.learned.markWall(this.fingerprintOf(id), bucket, resetsAt, this.now(), this.labelOf(id));
    this.poller.kick(id);
    this.changed();
  }

  /**
   * The live walls for one account — bucket → ISO reset, expired ones dropped.
   *
   * `nowMs` is a seam, not decoration: the Scheduler derives its throttles from
   * this and runs on an injectable clock, so a caller with a test clock must be
   * able to ask "live at THAT instant". Defaulting to `Date.now()` keeps every
   * existing caller reading exactly as it did.
   */
  limitedUntil(accountId: string | undefined, nowMs = Date.now()): Record<string, string> {
    return this.learned.walls(this.fingerprintOf(accountId ?? DEFAULT_ACCOUNT_ID), nowMs);
  }

  /**
   * The breaker as ONE stamp, for the healer's fingerprint (control-tower
   * phase 5, #36): per account, its effective entitlement word, which record
   * answered it, when it was written, and the names of its live walls. A
   * retirement, a clearance, a cool-down running out, a wall set or lapsing —
   * each moves it; a meter poll moves only the read clocks and the utilisation
   * numbers, which are deliberately not in it (they tick while nothing
   * happens, the lease's lesson in `evidenceFingerprint`).
   */
  breakerStamp(nowMs = this.now()): string {
    return this.accountIds().map((id) => {
      const word = this.entitlementOf(id, nowMs);
      const walls = Object.keys(this.limitedUntil(id, nowMs)).sort().join('+');
      return `${id}=${word.state}/${word.via}/${word.at ?? ''}/${walls}`;
    }).join(';');
  }

  /** The breaker's effective word for one account, now. */
  entitlementOf(accountId: string | undefined, nowMs = this.now()): EntitlementView {
    const fingerprint = this.fingerprintOf(accountId ?? DEFAULT_ACCOUNT_ID);
    return this.learned.entitlementOf(fingerprint, undefined, nowMs);
  }

  /**
   * A run is LEAVING this account — the one helper every mover, every
   * classifier arm and the operator's verb go through (ACT-5, SES-2, R-A3).
   * It writes what the departure means to the machine-wide store, so the
   * account is not the next `pickAccount` answer for whoever asks next,
   * whichever console they ask:
   *
   *  - `usage` with a reset → the wall, under the window's own name, until the
   *    reset (and `cooling` until then); without a reset → `cooling` for
   *    `ACCOUNT_COOLDOWN_MS`, which is what stops the measured A→B→A ping-pong.
   *    A per-MODEL window walls only its bucket and cools nothing: the account
   *    is the right place for every other model.
   *  - `credential` → `retired`, for the credential AND its organisation.
   *  - `operator` → recorded (`lastLeftAt`), held against nobody.
   *
   * Answers what to throttle in the scheduler and what to journal; the caller
   * (the runner) owns both, because this facade has neither a scheduler nor a
   * run journal.
   */
  leaveAccount(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const fingerprint = this.fingerprintOf(id);
    const nowMs = this.now();
    const at = new Date(nowMs).toISOString();
    const orgId = this.learned.credential(fingerprint)?.orgId;
    const label = this.labelOf(id);
    this.learned.noteLeft(fingerprint, { at, by: leaving.by, kind: leaving.kind, reason: leaving.reason }, label);

    let wall: LeaveResult['wall'];
    let throttleUntilMs: number | null = null;
    let until: string | undefined;

    if (leaving.kind === 'usage') {
      const resets = leaving.resetsAt && Number.isFinite(leaving.resetsAt.getTime()) && leaving.resetsAt.getTime() > nowMs
        ? leaving.resetsAt : null;
      if (leaving.bucket && resets) {
        wall = { bucket: leaving.bucket, resetsAt: resets.toISOString() };
        this.learned.markWall(fingerprint, wall.bucket, wall.resetsAt, nowMs, label);
      }
      if (!leaving.perModel) {
        // The account as a whole is the wrong place for a while: the wall's
        // own clock when one parsed, the cool-down when none did.
        until = (resets ?? new Date(nowMs + ACCOUNT_COOLDOWN_MS)).toISOString();
        throttleUntilMs = Date.parse(until);
        // `cooling` is entered from `entitled` by the table; an account that
        // just spent enough to hit a wall has proved it could pay, so an
        // `unknown` is promoted first rather than refused.
        if (this.learned.entitlementOf(fingerprint, orgId, nowMs).state === 'unknown') {
          this.learned.setEntitlement(fingerprint, { state: 'entitled', at, by: leaving.by, reason: 'it was spending when the wall came' }, { label });
        }
        this.learned.setEntitlement(fingerprint, {
          state: 'cooling', at, by: leaving.by, reason: leaving.reason, until,
        }, { label });
      }
    } else if (leaving.kind === 'credential') {
      // Whose fault is it, and how far does the answer reach? Two questions,
      // and passing the orgId through class-blind answered the second one
      // "everything" for every class. It is `ORG_SCOPED_CLASSES` — a refusal
      // that is ABOUT the organisation — and then only when the API returned
      // the verdict as data rather than as a sentence somebody's phase quoted.
      const orgScoped = Boolean(
        leaving.class && leaving.structured && ORG_SCOPED_CLASSES.includes(leaving.class),
      );
      if (leaving.class === 'certificate') {
        // A certificate is a property of the network PATH between this machine
        // and the API. It is not the credential's fault — this facade's own
        // classifier says so — and a home connection dropping out answers TLS
        // exactly as a corporate proxy does. So the breaker moves only once
        // the corroboration ledger has seen the same fault from several
        // sessions over several minutes, and then only to `cooling`, which
        // expires. `retired` has no clock, which is why a half-hour of no
        // network cost two and a half hours of hand-clearing.
        const strike = this.learned.noteCertificateStrike(fingerprint, {
          at, session: leaving.session ?? id, reason: leaving.reason,
        }, label);
        if (strike.corroborated) {
          until = new Date(nowMs + ACCOUNT_COOLDOWN_MS).toISOString();
          throttleUntilMs = Date.parse(until);
          if (this.learned.entitlementOf(fingerprint, orgId, nowMs).state === 'unknown') {
            this.learned.setEntitlement(fingerprint, {
              state: 'entitled', at, by: leaving.by, reason: 'it was reaching the API before this',
            }, { label });
          }
          this.learned.setEntitlement(fingerprint, {
            state: 'cooling', at, by: leaving.by, reason: leaving.reason, until, class: 'certificate',
          }, { label });
          log.info('accounts.certificate.corroborated', {
            account: id, strikes: strike.strikes, sessions: strike.sessions, spanMs: strike.spanMs,
          });
        }
      } else {
        this.learned.setEntitlement(fingerprint, {
          state: 'retired', at, by: leaving.by, reason: leaving.reason,
          ...(leaving.class ? { class: leaving.class } : {}),
          ...(leaving.evidence ? { evidence: leaving.evidence } : {}),
        }, { label, ...(orgId ? { orgId } : {}), orgScoped });
        // A retired account still gets a scheduler hold: the breaker is what
        // excludes it from the rank, the hold is what keeps a queued entry that
        // was admitted a moment ago from boarding on it in the same tick.
        throttleUntilMs = nowMs + ACCOUNT_COOLDOWN_MS;
        this.auth.set(id, 'unusable');
      }
    }

    this.poller.kick(id);
    this.changed();
    const view = this.learned.entitlementOf(fingerprint, orgId, nowMs);
    return {
      accountId: id, credential: fingerprint,
      ...(orgId ? { orgId, orgIdHash: hashedOrgId(orgId) } : {}),
      state: view.state, ...(until ? { until } : view.until ? { until: view.until } : {}),
      ...(wall ? { wall } : {}), throttleUntilMs,
    };
  }

  /**
   * A session SPENT under this account and ended well (control-tower phase
   * 54): proof it could pay when it ran. Its shared walls and the spent
   * model's own lift, a usage cooling ends (#78), and a classifier's
   * retirement or a `suspect` is cleared (#57). Answers what moved, for the
   * runner's journal; the runner re-arms the phases those walls held.
   */
  noteSpend(accountId: string | undefined, model?: string): {
    lifted: string[]; cooled: boolean; entitlement?: { from: EntitlementView['state']; to: EntitlementView['state'] };
  } {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const fingerprint = this.fingerprintOf(id);
    const label = this.labelOf(id);
    const at = new Date(this.now()).toISOString();
    const family = familyOf(model);
    const walls = this.learned.liftWalls(fingerprint, [...SHARED_WALLS, ...(family ? [`seven_day_${family}`] : [])], at, label);
    const entitlement = this.learned.noteProof(fingerprint, { at, by: 'runner', reason: 'a session spent under it' }, label) ?? undefined;
    if (walls.lifted.length || walls.cooled || entitlement) {
      log.info('accounts.spend-proved', { account: id, lifted: walls.lifted, cooled: walls.cooled, ...(entitlement ? entitlement : {}) });
      this.changed();
    }
    return { ...walls, ...(entitlement ? { entitlement } : {}) };
  }

  /**
   * A credential-class refusal, keyed by the organisation: retires this
   * account and, through the org row, every account sharing the orgId. The
   * `leaveAccount` credential arm ends here; this is also the door a prelude
   * probe (phase 11) will use when a declared one-turn session is refused.
   */
  retire(accountId: string | undefined, orgId: string | undefined, reason: string, by: LeaveBy, cls?: CredentialClass): LeaveResult {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (orgId) this.learned.noteIdentity(this.fingerprintOf(id), { label: this.labelOf(id), orgId });
    return this.leaveAccount(id, {
      kind: 'credential', reason, by,
      ...(cls ? { class: cls } : {}),
      // NAMING the organisation is the assertion that this refusal is about
      // it — the one thing that may take out every sibling login. A caller
      // that passes none (the operator's own retire verb, the one-turn check)
      // is talking about this credential and nothing else.
      structured: Boolean(orgId),
    });
  }

  /**
   * The operator's clearance — the one transition out of `retired`. Opens the
   * credential AND its organisation to `unknown`; the next successful read or
   * spend proves it again. Answers false when the account was not retired.
   */
  clearRetired(accountId: string | undefined, by: LeaveBy = 'operator'): boolean {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const fingerprint = this.fingerprintOf(id);
    const orgId = this.learned.credential(fingerprint)?.orgId;
    const word = this.learned.entitlementOf(fingerprint, orgId, this.now()).state;
    if (word !== 'retired' && word !== 'suspect') return false;
    // The org's row may be the one answering `retired` while the credential's
    // own says something else; clearing writes the credential `unknown`
    // (refused when its own word is not `retired`, which is fine) and drops
    // the org's row either way.
    const at = new Date(this.now()).toISOString();
    this.learned.setEntitlement(fingerprint, {
      state: 'unknown', by, reason: `cleared by ${by}`, at,
    }, orgId ? { orgId } : {});
    this.learned.clearOrg(orgId, by);
    // The retirement's own scheduler hold goes with it. `leaveAccount` asks
    // for one (`throttleUntilMs`) and `scheduler.throttle` writes it through
    // as the nameless wall; left standing, the Continue that follows a
    // clearance sat `queued` on a "usage window" for up to half an hour
    // (control-tower phase 33, the tower rehearsal). Only a hold no later than
    // the retirement's own: a later nameless wall is a real window the CLI
    // hit without naming it, and a clearance is no reason to forget it.
    const left = this.learned.credential(fingerprint)?.lastLeftAt;
    const hold = Date.parse(this.limitedUntil(id)[NAMELESS_WALL] ?? '');
    if (left?.kind === 'credential' && Number.isFinite(hold)
      && hold <= Date.parse(left.at) + ACCOUNT_COOLDOWN_MS + 1_000) {
      this.learned.liftWalls(fingerprint, [NAMELESS_WALL], at, this.labelOf(id));
    }
    // Every sibling's `unusable` paint goes with the organisation's word.
    for (const [other, state] of [...this.auth]) if (state === 'unusable') this.auth.delete(other);
    this.auth.delete(id);
    this.identities.delete(id);
    this.poller.kick(id);
    this.changed();
    log.info('accounts.retired.cleared', { account: id, by });
    return true;
  }

  /* ---------------- does the API take this credential's work? ---------------- */

  /**
   * Ask the API whether this account may run work — ONE declared one-turn
   * session under its own environment (`entitlement-probe.ts`; chapter 11
   * ACT-8, zero-touch-console phase 15) — and write what it found where every
   * console on the machine reads it: the learned store's `probe` record, and
   * the breaker when the answer moves it.
   *
   * What the answer does to the breaker is the breaker's rules, nothing new:
   *
   *  - a credential-class refusal RETIRES the credential and its organisation
   *    through `retire`, exactly as a phase's refusal does — the same
   *    classifier read the same kind of stop;
   *  - an answer — including a usage limit or a spent cap, which are answers
   *    too: the API took the credential and then counted — promotes `unknown`
   *    to `entitled` and moves nothing else. A `cooling` keeps its clock, and a
   *    `retired` stays retired however well the check went: clearing is the
   *    one door out, and it is a person's (`clearRetired`);
   *  - a session that could not answer (a timeout, an overloaded API, a CLI
   *    that would not start) moves nothing — "I could not ask" is not "no".
   *
   * Refused before any spend where a check could only mislead: a login last
   * observed signed out or expired, a profile nobody has signed into, and a
   * token account whose token is missing — whose child would inherit the
   * machine login and answer for the wrong credential. One check per account
   * at a time (`ProbeInFlightError`).
   */
  async probeEntitlement(accountId: string, opts: EntitlementProbeOptions): Promise<EntitlementProbeResult | undefined> {
    const meta = this.meta(accountId);
    if (!meta) return undefined;
    if (this.probing.has(meta.id)) throw new ProbeInFlightError(this.labelFor(meta.id));
    const running = this.runEntitlementProbe(meta, opts).finally(() => this.probing.delete(meta.id));
    this.probing.set(meta.id, running);
    return running;
  }

  /** Is a check of this account running right now? */
  probeInFlight(accountId: string): boolean {
    return this.probing.has(accountId);
  }

  private async runEntitlementProbe(meta: AccountMeta, opts: EntitlementProbeOptions): Promise<EntitlementProbeResult> {
    const id = meta.id;
    const label = this.labelOf(id);
    const fingerprint = this.fingerprintOf(id);
    const orgOf = () => this.learned.credential(fingerprint)?.orgId;
    const before = this.learned.entitlementOf(fingerprint, orgOf(), this.now()).state;
    const by = opts.actor.by;

    const refused = await this.probeRefusal(meta);
    let cwd = opts.cwd;
    let accountEnv: NodeJS.ProcessEnv | null = null;
    let why = refused;
    if (!why) {
      cwd ??= join(ACCOUNTS_DIR, 'probe');
      try {
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
      } catch (error) {
        why = `its working directory could not be made: ${(error as Error).message}`;
      }
    }
    if (!why) {
      accountEnv = await this.envFor(id, cwd ? [cwd] : []);
      // `envFor` answers null for a token it cannot read, and a null env
      // INHERITS the machine login: the check would answer for the wrong
      // credential under this account's name.
      if (meta.kind === 'token' && !accountEnv?.CLAUDE_CODE_OAUTH_TOKEN) why = 'the stored token is missing — paste it again';
    }
    if (why) {
      const probe = this.recordProbe(fingerprint, label, { status: 'skip', reason: why, by, at: new Date(this.now()).toISOString() });
      log.info('accounts.entitlement-probe.ran', { ...opts.actor, account: id, status: 'skip', spent: false, reason: why });
      return { account: await this.view(this.meta(id)!), probe, spent: false };
    }

    log.info('session.start', { ...opts.actor, account: id, owner: 'console/entitlement-probe' });
    const session = await runProbeSession({
      env: probeEnv(accountEnv), cwd: cwd!,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.ladder ? { ladder: opts.ladder } : {}),
      ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
    });
    const verdict = probeVerdict(session);
    const at = new Date(this.now()).toISOString();

    if (verdict.status === 'fail') {
      this.retire(id, undefined, `a one-turn check was refused: ${verdict.reason}`, 'probe', verdict.class);
    } else if (verdict.status === 'ok') {
      // Proof the API takes this credential's work: an `unknown` is proved, and
      // a CLASSIFIER's retirement — or the `suspect` a read left it — is
      // contradicted and cleared (control-tower phase 54, #57). A person's
      // retirement stays theirs to clear.
      this.learned.noteProof(fingerprint, { at, by: 'probe', reason: `a one-turn check the API took: ${verdict.reason}` }, label);
    }
    const probe = this.recordProbe(fingerprint, label, {
      status: verdict.status, reason: verdict.reason, by, at,
      ...(verdict.class ? { class: verdict.class } : {}),
      ...(session.costUsd !== undefined ? { costUsd: session.costUsd } : {}),
      ms: session.ms, ending: session.ending,
      ...(session.cliVersion ? { cliVersion: session.cliVersion } : {}),
    });
    const after = this.learned.entitlementOf(fingerprint, orgOf(), this.now()).state;
    log.info('accounts.entitlement-probe.ran', {
      ...opts.actor, account: id, status: verdict.status, spent: true, ending: session.ending, ms: session.ms,
      ...(verdict.class ? { class: verdict.class } : {}),
      costUsd: session.costUsd ?? null, turns: session.turns ?? null, cliVersion: session.cliVersion ?? null,
      ...(before !== after ? { from: before, to: after } : {}),
      reason: verdict.reason.slice(0, 200),
    });
    this.identities.delete(id);
    this.poller.kick(id);
    this.changed();
    return {
      account: await this.view(this.meta(id)!),
      probe,
      spent: true,
      ...(before !== after ? { moved: { from: before, to: after } } : {}),
    };
  }

  /** Why a check would mislead right now, or null when it may run. Costs a credential read, never a session. */
  private async probeRefusal(meta: AccountMeta): Promise<string | null> {
    const auth = this.auth.get(meta.id);
    if (auth === 'expired' || auth === 'signed-out') return `its login is ${auth} — sign it in again, then check`;
    if (meta.kind === 'profile' && !(await this.identity(meta)).signedIn) {
      return 'nobody has signed into this profile yet — sign it in, then check';
    }
    return null;
  }

  private recordProbe(fingerprint: string, label: string, probe: Omit<LearnedProbe, 'count'>): LearnedProbe {
    return this.learned.noteProbe(fingerprint, probe, label) ?? { ...probe, count: 1 };
  }

  /**
   * May a run START under this account right now? The quota door's whole
   * question, answered from cache and never thrown (ACT-2): a retired
   * credential is refused by name; a learned wall on a shared window (or the
   * model's own) is refused until its reset; a live five-hour meter at
   * `PREFLIGHT_REFUSE_PCT` is refused with the reset; anything else is a yes,
   * carrying a `warn` when the meter is past `WARN_PCT` so the caller can
   * announce a busy window. Reads `liveBuckets`, not the raw snapshot — a
   * meter past its reset or its staleness bound is not evidence.
   */
  headroom(accountId: string | undefined, forModel?: string, nowMs = this.now()): HeadroomVerdict {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const label = this.labelFor(id);
    const entitlement = this.entitlementOf(id, nowMs);
    if (entitlement.state === 'retired') {
      return {
        ok: false, accountId: id, kind: 'retired',
        reason: `${label} is retired${entitlement.via === 'org' ? ' with its organisation' : ''}`
          + `${entitlement.reason ? ` — ${entitlement.reason}` : ''}. Clear it under Settings ▸ Accounts once the organisation allows it again.`,
        ...(entitlement.evidence ? { evidence: entitlement.evidence } : {}),
      };
    }
    if (entitlement.state === 'suspect') {
      // Still out (#57): a green read argues with the retirement, it does not
      // yet overrule it. A check, a spend, or the contradiction standing does.
      return {
        ok: false, accountId: id, kind: 'retired',
        reason: `${label}'s retirement is suspect — ${entitlement.contradicted?.reason ?? 'a later read contradicts it'}`
          + `${entitlement.reason ? ` (it was retired: ${entitlement.reason})` : ''}. Check it under Settings ▸ Accounts to clear it now.`,
        ...(entitlement.evidence ? { evidence: entitlement.evidence } : {}),
      };
    }
    // Credits carry it past every plan window (control-tower phase 93, #146):
    // neither a learned wall nor the five-hour door refuses it while they do.
    if (this.creditCarries(id)) {
      const five = liveBuckets(this.poller.snapshot(id), nowMs).five_hour;
      return { ok: true, accountId: id, onCredit: true, ...(five ? { fiveHourPct: five.utilization } : {}) };
    }
    const limited = this.limitedUntil(id, nowMs);
    const family = familyOf(forModel);
    const learned = limited.five_hour ?? limited.seven_day ?? (family ? limited[`seven_day_${family}`] : undefined);
    if (learned) {
      return {
        ok: false, accountId: id, kind: 'wall', resetsAt: learned,
        reason: `${label} hit its usage limit — it resets ${new Date(learned).toLocaleString()}.`,
      };
    }
    const five = liveBuckets(this.poller.snapshot(id), nowMs).five_hour;
    if (!five) return { ok: true, accountId: id };
    if (five.utilization >= PREFLIGHT_REFUSE_PCT) {
      return {
        ok: false, accountId: id, kind: 'spent', resetsAt: five.resetsAt,
        reason: `${label} has ${Math.round(100 - five.utilization)}% of its 5-hour window left `
          + `(resets ${new Date(five.resetsAt).toLocaleString()}).`,
      };
    }
    return {
      ok: true, accountId: id, fiveHourPct: five.utilization,
      ...(five.utilization >= WARN_PCT ? { warn: { pct: five.utilization, resetsAt: five.resetsAt } } : {}),
    };
  }

  /**
   * Every account id this instance knows — the synthesized default first, then
   * the registered ones. `rankAccounts` and the Scheduler's throttle snapshot
   * both need exactly this list, and had built it inline.
   */
  accountIds(): string[] {
    return [DEFAULT_ACCOUNT_ID, ...this.store.stored().map((meta) => meta.id)];
  }

  /** Last-known meters for one account, straight from the poller's cache. */
  /**
   * Re-read one account's meters and answer with what came back.
   *
   * The awaiting counterpart to the `poller.kick` calls above: those are
   * side-effects of something else happening, this is somebody asking.
   */
  async refreshUsage(accountId: string | undefined): Promise<AccountUsage | undefined> {
    return this.poller.refresh(accountId ?? DEFAULT_ACCOUNT_ID);
  }

  /** Every account at once, in parallel — the "Refresh all" the panels offer. */
  async refreshAllUsage(): Promise<void> {
    const ids = [DEFAULT_ACCOUNT_ID, ...this.store.stored().map((meta) => meta.id)];
    await Promise.all([...new Set(ids)].map((id) => this.poller.refresh(id)));
  }

  usageFor(accountId: string | undefined): AccountUsage | undefined {
    return this.poller.snapshot(accountId ?? DEFAULT_ACCOUNT_ID);
  }

  /**
   * The account a limit-hit run should continue under: any other account
   * whose shared windows are not known-exhausted, freshest headroom first.
   * Unknown usage ranks between the measured — an account we know is at 20%
   * beats it; one measured at 80% does not. Sync on purpose: answered from
   * cache, mid-phase, with nothing to await.
   *
   * `undefined` reads as "escaping the machine login" (the runner's shape:
   * an absent accountId IS the default account); an explicit `null` means
   * "exclude no one" — the launch-time `auto` pick.
   */
  pickAccount(excluding: string | null | undefined, forModel?: string, nowMs = Date.now()): string | null {
    return this.rankAccounts(excluding, forModel, nowMs)[0] ?? null;
  }

  /**
   * Every account such a run COULD continue under, best first — the list
   * `pickAccount` takes its head from, for callers that must probe before they
   * trust (the auth preflight tries each in turn with `checkAuthFor`, because
   * headroom says nothing about whether the login still works).
   *
   * The predicate, in full — the account-selection rule the resource ladder
   * climbs by: not the one being escaped; its shared windows (`five_hour`,
   * `seven_day`) neither learned-exhausted nor measured at 99%+; for a named
   * model, its per-model window likewise; and its login not KNOWN broken
   * (`expired` / `signed-out` as last observed — `unknown` and never-observed
   * pass, since a setup-token exposes no expiry and a fresh profile has not
   * been read yet; so does `refreshable`, an idle login whose access token the
   * next session renews — #111). Ranked by the worse of the two shared utilizations,
   * ascending; unknown usage scores 50, between the measured.
   */
  rankAccounts(excluding: string | null | undefined, forModel?: string, nowMs = Date.now()): string[] {
    const exclude = excluding === null ? null : excluding ?? DEFAULT_ACCOUNT_ID;
    // A per-model window disqualifies only for the model that would spend it
    // (`seven_day_opus` ↔ an opus run) and never feeds the score: an account
    // exhausted on Opus is the RIGHT place for a Sonnet phase, and worst-case
    // scoring would defeat the per-model design of the windows.
    const family = familyOf(forModel);
    // One PERSON is one meter (control-tower phase 92, #141): a profile that
    // answers the same login as the account being left is that account — the
    // machine login `default` read as headroom for the admin@ profile it was
    // the same meter as — and two profiles of one person rank once.
    const leaving = exclude ? this.personOf(exclude) : null;
    const candidates: { id: string; person: string | null; tier: number; score: number; entitled: number; order: number }[] = [];
    this.accountIds().forEach((id, order) => {
      if (id === exclude) return;
      const person = this.personOf(id);
      if (leaving && person === leaving) return;
      const verdict = this.candidacy(id, family, nowMs);
      if (verdict.ok) candidates.push({ id, person, tier: verdict.tier, score: verdict.score, entitled: verdict.entitled, order });
    });
    candidates.sort((a, b) => a.tier - b.tier || a.score - b.score || a.entitled - b.entitled || a.order - b.order);
    const seen = new Set<string>();
    return candidates
      .filter((c) => {
        if (!c.person) return true;
        if (seen.has(c.person)) return false;
        seen.add(c.person);
        return true;
      })
      .map((c) => c.id);
  }

  /** `personOf`'s answers, kept as long as the identity cache keeps its reads. */
  private readonly persons = new Map<string, { at: number; person: string | null }>();

  /**
   * WHO an account is as a person — its login's email and organisation — or
   * null for a token account or a login that names nobody (control-tower phase
   * 92). Read without side effects: `identityOf` re-keys what the machine
   * learned when a login changes, and a rank must never do that.
   */
  private personOf(id: string): string | null {
    const cached = this.persons.get(id);
    if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.person;
    const meta = this.meta(id);
    let person: string | null = null;
    if (meta && meta.kind !== 'token') {
      try {
        const who = this.creds.readIdentity(meta.kind === 'profile' ? profileConfigDir(id, this.accountsDir) : null);
        if (who?.email) person = `${who.email.toLowerCase()}\n${(who.orgId ?? '').toLowerCase()}`;
      } catch {
        person = null;
      }
    }
    this.persons.set(id, { at: Date.now(), person });
    return person;
  }

  /**
   * The switch picker (control-tower phase 78, #100): `rankAccounts` inside
   * the run's `pool` when it has one, less every account that would wall before
   * `until` — the reset of the wall the run is leaving (`carriesUntil`). An
   * account at 98 % of its weekly window ranked last before this and was still
   * taken when it was the only one, and walled within the hour for three days.
   *
   * With no `until` (no wall to weigh against, or one already past) the answer
   * is the rank, untouched. `wake` is the soonest a pool member that is walled
   * or cooling NOW frees up, when that is before `until`: the moment a run that
   * found nowhere to go should look again, rather than at its own reset.
   */
  switchCandidates(
    excluding: string | null | undefined, forModel?: string,
    opts: {
      until?: number | string | null; pool?: readonly string[] | null;
      /** The run's own `minHeadroomPct` per account (control-tower phase 92): a target under it in EITHER window is passed over. */
      floors?: Readonly<Record<string, number>> | null;
      /**
       * The switch leaves a USAGE wall or window (the default): an account with
       * no live reading has no known headroom and is passed over. `false` for a
       * credential failover — the account being left cannot run at all, and a
       * setup-token the usage endpoint never meters is still a place to go.
       */
      usage?: boolean;
      nowMs?: number;
    } = {},
  ): SwitchCandidates {
    const nowMs = opts.nowMs ?? this.now();
    const until = typeof opts.until === 'string' ? Date.parse(opts.until) : opts.until ?? Number.NaN;
    const pool = opts.pool?.length ? opts.pool : null;
    const family = familyOf(forModel);
    const ranked = this.rankAccounts(excluding, forModel, nowMs).filter((id) => !pool || pool.includes(id));
    const exclude = excluding === null ? null : excluding ?? DEFAULT_ACCOUNT_ID;
    const horizon = Number.isFinite(until) && until > nowMs;
    const windows = ['five_hour', 'seven_day', ...(family ? [`seven_day_${family}`] : [])];
    // The work being moved burns what it burned where it was (#141): measured
    // on the account being left, else the fastest burn measured on this machine.
    const work = horizon ? this.workBurn(exclude, nowMs) : {};
    const kept: string[] = [];
    const declined: SwitchCandidates['declined'] = [];
    for (const id of ranked) {
      const snapshot = this.poller.snapshot(id);
      const live = liveBuckets(snapshot, nowMs);
      // Unknown usage is NO headroom (#100, 2026-09-25 12:53Z): an account with
      // no live reading of either shared window took a release phase and parked
      // it for 51 hours on a weekly wall nobody had read.
      if (opts.usage !== false && !live.five_hour && !live.seven_day) {
        declined.push({
          id, bucket: 'unknown', pct: null, lastsMs: null, resetsAt: null,
          why: `${this.labelFor(id)}'s usage is unknown — no live reading of its shared windows, and unknown usage is no headroom`,
        });
        continue;
      }
      const floor = opts.floors?.[id] ?? 0;
      const under = floor > 0
        ? windows.map((name) => ({ name, bucket: live[name] })).find((w) => w.bucket && 100 - w.bucket.utilization < floor)
        : undefined;
      if (under?.bucket) {
        declined.push({
          id, bucket: under.name, pct: under.bucket.utilization, lastsMs: null, resetsAt: under.bucket.resetsAt,
          why: `its ${under.name} window has ${Math.round(100 - under.bucket.utilization)} % left, under the run's ${floor} % floor`,
        });
        continue;
      }
      if (horizon) {
        const own = forecastUsage(snapshot, nowMs);
        const burn: Record<string, number | null> = {};
        for (const name of windows) {
          const mine = own[name]?.burnPctPerHour ?? null;
          const moved = work[name] ?? (name.startsWith('seven_day_') ? work.seven_day : undefined);
          burn[name] = typeof moved === 'number' ? (mine ?? 0) + moved : mine;
        }
        const decline = carriesUntil(live, until, nowMs, family, burn);
        if (decline) {
          declined.push({ id, ...decline });
          continue;
        }
      }
      kept.push(id);
    }
    if (!horizon) return { ranked: kept, declined, wake: null };
    let wake: number | null = null;
    for (const id of this.accountIds()) {
      if (id === exclude || ranked.includes(id) || (pool && !pool.includes(id))) continue;
      const verdict = this.candidacy(id, family, nowMs);
      if (verdict.ok || !verdict.until) continue;
      const at = Date.parse(verdict.until);
      if (Number.isFinite(at) && at > nowMs && at < until && (wake === null || at < wake)) wake = at;
    }
    return { ranked: kept, declined, wake: wake === null ? null : new Date(wake).toISOString() };
  }

  /**
   * The burn the work being moved will bring, per window, in percent per hour
   * (control-tower phase 92, #141): what it was measured spending on the
   * account it leaves; with nothing measured there, the fastest burn measured
   * on any account of this machine. Empty when nothing is measured anywhere.
   */
  private workBurn(from: string | null, nowMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    const read = (id: string) => {
      for (const [name, forecast] of Object.entries(forecastUsage(this.poller.snapshot(id), nowMs))) {
        if (forecast.burnPctPerHour !== null && forecast.burnPctPerHour > (out[name] ?? -1)) out[name] = forecast.burnPctPerHour;
      }
    };
    if (from) read(from);
    if (Object.keys(out).length) return out;
    for (const id of this.accountIds()) read(id);
    return out;
  }

  /**
   * How much room one account has NOW (control-tower phase 78, #106) — the
   * `switch-account` rung's re-judgement of a usage wall it read off a stored
   * checkpoint. `ok` is the quota door's yes AND the rank's (no learned wall, no
   * spent five-hour window, not retired, cooling or signed out, no shared
   * window at `WALL_PCT`). `headroomPct` is what is left of the fullest live
   * window — 0 under a learned wall or a breaker, null when nothing live was
   * read — and `resetsAt` when the wall it is under lifts.
   */
  roomOf(accountId: string | undefined, forModel?: string, nowMs = this.now()): AccountRoom {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    const family = familyOf(forModel);
    const buckets = liveBuckets(this.poller.snapshot(id), nowMs);
    const read = [buckets.five_hour?.utilization, buckets.seven_day?.utilization, family ? buckets[`seven_day_${family}`]?.utilization : undefined]
      .filter((v): v is number => typeof v === 'number');
    const measured = read.length ? Math.max(0, 100 - Math.max(...read)) : null;
    const door = this.headroom(id, forModel, nowMs);
    if (!door.ok) {
      return { ok: false, headroomPct: door.kind === 'spent' ? measured : 0, resetsAt: door.resetsAt ?? null, why: door.reason };
    }
    const standing = this.candidacy(id, family, nowMs);
    if (!standing.ok) return { ok: false, headroomPct: 0, resetsAt: standing.until ?? null, why: `${this.labelFor(id)}: ${standing.why}` };
    return { ok: true, headroomPct: measured, resetsAt: null };
  }

  /**
   * One account's standing in the rank, as the view carries it — the rank's
   * own predicate (`candidacy`), for nobody excluded and no model named. The
   * dashboard says WHY an account is out in the rank's words because they are
   * the rank's words: a second copy of these rules beside `rankAccounts` is
   * how the page and the switch would come to disagree.
   */
  private standing(id: string, nowMs: number): AccountCandidacy {
    const verdict = this.candidacy(id, undefined, nowMs);
    return verdict.ok
      ? { candidate: true }
      : { candidate: false, why: verdict.why, ...(verdict.until ? { until: verdict.until } : {}) };
  }

  /**
   * Is this account a place a run could continue, and if so how good a one?
   * The whole account-selection rule the resource ladder climbs by, for ONE
   * id, in the order the checks cost: its login not KNOWN broken (`expired` /
   * `signed-out` as last observed — `unknown` and never-observed pass, since a
   * setup-token exposes no expiry and a fresh profile has not been read yet);
   * the breaker neither `retired` nor `cooling`; its shared windows
   * (`five_hour`, `seven_day`) neither learned-exhausted nor measured at
   * `WALL_PCT`; and for a named model its per-model window likewise. A
   * candidate carries the rank's sort keys.
   */
  private candidacy(id: string, family: string | undefined, nowMs: number):
    | { ok: false; why: string; until?: string }
    | { ok: true; tier: number; score: number; entitled: number } {
    // A login observed broken is no place to continue: the switch would
    // spend a session discovering what the registry already knows.
    const auth = this.auth.get(id);
    if (auth === 'expired' || auth === 'signed-out') return { ok: false, why: `its login is ${auth}` };
    // The breaker (SES-2, ACT-8): a retired credential — or one whose
    // organisation is — is never a candidate, however much headroom its
    // meters show; a cooling one is out for its clock (ACT-5's ping-pong).
    const entitlement = this.entitlementOf(id, nowMs);
    if (entitlement.state === 'retired' || entitlement.state === 'suspect') {
      return {
        ok: false,
        why: `${entitlement.state}${entitlement.via === 'org' ? ' with its organisation' : ''}${entitlement.reason ? ` — ${entitlement.reason}` : ''}`,
      };
    }
    if (entitlement.state === 'cooling') {
      return {
        ok: false,
        why: `cooling${entitlement.reason ? ` — ${entitlement.reason}` : ''}`,
        ...(entitlement.until ? { until: entitlement.until } : {}),
      };
    }
    const limited = this.limitedUntil(id, nowMs);
    // Exact shared keys only — a learned `seven_day_opus` must never
    // blanket-disqualify an account for every model.
    if (limited.five_hour) return { ok: false, why: 'its five_hour window is walled', until: limited.five_hour };
    if (limited.seven_day) return { ok: false, why: 'its seven_day window is walled', until: limited.seven_day };
    // Only meters that are still evidence. `limitedUntil` above is the
    // DETECTOR's answer and has always been expiry-filtered; this is the
    // POLLER's, and it was not — so a bucket read at 100% before a window
    // that has since reset, or a snapshot no successful poll had refreshed
    // for hours, disqualified an account exactly as hard as a real wall. The
    // account stayed out of the rotation until the next successful poll,
    // which is the one thing a console with a failing poller cannot make.
    const snapshot = this.poller.snapshot(id);
    const buckets = liveBuckets(snapshot, nowMs);
    const shared = [buckets.five_hour?.utilization, buckets.seven_day?.utilization]
      .filter((v): v is number => typeof v === 'number');
    const worst = shared.length ? Math.max(...shared) : undefined;
    if (worst !== undefined && worst >= WALL_PCT) return { ok: false, why: `a shared window reads ${Math.round(worst)} %` };
    if (family) {
      const key = `seven_day_${family}`;
      if (limited[key]) return { ok: false, why: `its ${key} window is walled`, until: limited[key] };
      const measured = buckets[key]?.utilization;
      if (typeof measured === 'number' && measured >= WALL_PCT) return { ok: false, why: `its ${key} window reads ${Math.round(measured)} %` };
    }
    // Three tiers (SES-4). Live meters score by the worse shared window;
    // an account NEVER polled scores 50, between the measured — right for a
    // fresh profile. An account whose polling is FAILING — a snapshot too
    // old to be evidence, or one whose last read errored — ranks below every
    // live meter: not knowing is the symptom when the credential is the
    // thing that is broken, and the old rule handed such an account the 50
    // and let the switch land on it (the audit's [C3-2]). Within a tier,
    // `entitled` (a successful read, a spend) beats `unknown`.
    const polled = Boolean(snapshot);
    const failing = polled && (!shared.length || Boolean(snapshot?.error));
    return {
      ok: true,
      tier: !polled ? 0 : failing ? 1 : 0,
      score: worst ?? 50,
      entitled: entitlement.state === 'entitled' ? 0 : 1,
    };
  }

  /**
   * A display name for journals and banners. An id no registry holds any more
   * is answered from its tombstone — a journal line that says `support` paid
   * for something stays readable after `support` is removed (ACT-10).
   */
  labelFor(accountId: string | undefined): string {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (id === DEFAULT_ACCOUNT_ID) return this.store.defaultName ?? 'the machine login';
    const meta = this.store.get(id);
    if (meta) return meta.name ?? meta.email ?? id;
    const tomb = this.learned.tombstoneFor(this.labelOf(id));
    return tomb ? `${tomb.name} (removed)` : id;
  }


  /* ---------------- internals ---------------- */

  private async resolveToken(accountId: string): Promise<TokenAnswer> {
    const meta = this.meta(accountId);
    if (!meta) return null;
    if (meta.kind === 'token') {
      const token = await this.creds.readToken(accountId);
      return token ? { token, tokenKind: 'setup-token' } : { error: 'stored token is missing' };
    }
    const configDir = meta.kind === 'profile' ? profileConfigDir(accountId, this.accountsDir) : null;
    let oauth = await this.creds.readClaudeOauth(configDir);
    const due = keepAliveDueAt(oauth);
    if (oauth && due !== null && due <= Date.now()) {
      // Due, or lapsed: renewed BEFORE the endpoint is asked (control-tower
      // phase 91, #111 clause 3), through the CLI's own refresh — a `-p` start
      // it refuses after refreshing (`keep-alive.ts`, measured). `claude auth
      // status`, which this used to call, renews nothing. An idle profile's
      // meters stay readable instead of going stale on a lapsed token.
      await this.renewLogin(accountId);
      oauth = await this.creds.readClaudeOauth(configDir);
    }
    // The authoritative auth-state writer: it rides every poller tick and sits
    // AFTER the refresh attempt. A lapsed access token the login can renew is
    // `refreshable` (#111) and is still asked with — the refusal that follows
    // is expected, and only a refused LIVE token is a sign-in verdict
    // (`usageUpdated`). A transport failure writes no verdict at all (#110).
    this.noteAuth(accountId, this.blobState(accountId, oauth));
    if (!oauth) {
      return meta.kind === 'profile'
        ? { error: 'not signed in yet — finish `claude auth login` for this profile' }
        : { error: 'no Claude login found on this machine' };
    }
    this.lastTokens.set(accountId, tokenDigest(oauth.accessToken));
    const lapsed = Boolean(oauth.expiresAt && oauth.expiresAt <= Date.now() && oauth.canRefresh);
    const identity = this.identityKey(meta, true);
    return { token: oauth.accessToken, ...(identity ? { identity } : {}), ...(lapsed ? { lapsed: true } : {}) };
  }

  private usageUpdated(accountId: string, usage: AccountUsage, meta: UsageMeta): void {
    // The learned half of every poll: the clocks (`fetchedAt` is now the last
    // SUCCESS, `lastErrorAt` the last failure — ACT-4), the organisation when
    // the body named one, and the positive fact a successful read proves.
    const fingerprint = this.fingerprintOf(accountId);
    const label = this.labelOf(accountId);
    if (meta.orgId) this.learned.noteIdentity(fingerprint, { label, orgId: meta.orgId });
    // The login verdicts a read carries (#110, #111). The endpoint refusing a
    // LIVE access token is the one road to `expired`; a lapsed one it was
    // always going to refuse, and a request that never reached it is weather.
    // A clean read clears a refusal.
    if (meta.failure === 'refused' && !meta.lapsed) {
      const token = this.lastTokens.get(accountId);
      if (this.meta(accountId)?.kind === 'token') {
        // A setup-token the endpoint served and now refuses (the poller files
        // a first refusal as `unsupported`, a verdict on the KIND): no blob to
        // renew and no digest to compare, so the verdict stands until a clean
        // read or a replaced credential (control-tower phase 13, #33).
        this.noteAuth(accountId, 'expired');
      } else if (token) {
        this.refusedTokens.set(accountId, token);
        this.noteAuth(accountId, 'expired');
      }
    } else if (meta.outcome === 'ok') {
      this.refusedTokens.delete(accountId);
      if (this.auth.get(accountId) === 'expired') this.noteAuth(accountId, 'ok');
    }
    if (meta.outcome === 'ok' && usage.fetchedAt) {
      // An expired or signed-out login's retirement is answered by proof
      // (control-tower phase 91, #147): this read, and `claude auth status`.
      const word = this.learned.entitlementOf(fingerprint, undefined, this.now());
      if ((word.state === 'retired' || word.state === 'suspect') && word.class === 'auth') {
        // The retirement's own time, read BEFORE `noteRead` demotes it below.
        void this.confirmLogin(accountId, usage.fetchedAt, word.state === 'suspect' ? word.retired?.at ?? word.at ?? '' : word.at ?? '').catch(() => undefined);
      }
      this.learned.noteRead(fingerprint, { successAt: usage.fetchedAt }, label);
      // Every fresh reading re-reads the walls it can speak for (#78): a wall
      // is "until at the latest", never the reported reset taken on trust.
      const reread = this.learned.rereadWalls(fingerprint, usage.buckets, usage.fetchedAt, label);
      if (reread) {
        log.info('accounts.walls-reread', {
          account: accountId, lifted: reread.lifted, moved: reread.moved.map((m) => m.bucket),
          cooling: typeof reread.cooling === 'string' ? reread.cooling : reread.cooling ? 'shortened' : null,
        });
      }
    } else if (meta.outcome === 'error' && usage.lastErrorAt) this.learned.noteRead(fingerprint, { errorAt: usage.lastErrorAt }, label);
    this.creditWatch(accountId);
    this.thresholds(accountId, usage);
    this.forecastWarnings(accountId, usage);
    this.changed();
  }

  /**
   * Warn at 80, alert at 95, once per level per window — the announced level
   * resets when the meter drops back under (a new window), so the next climb
   * announces again. Fed from real polls only; stale cache never re-fires.
   */
  private thresholds(accountId: string, usage: AccountUsage): void {
    if (!this.opts.onThreshold || usage.error || usage.unsupported) return;
    // A window credits carry past is not "nearly spent" (#146).
    if (this.creditCarries(accountId)) return;
    for (const [bucket, meter] of Object.entries(usage.buckets)) {
      const key = `${accountId}:${bucket}:${meter.resetsAt}`;
      const level: 'warn' | 'alert' | null =
        meter.utilization >= ALERT_PCT ? 'alert' : meter.utilization >= WARN_PCT ? 'warn' : null;
      if (!level) {
        this.announced.delete(key);
        continue;
      }
      const before = this.announced.get(key);
      if (before === 'alert' || before === level) continue;
      this.announced.set(key, level);
      const meta = this.meta(accountId);
      if (!meta) continue;
      void this.view(meta).then((view) => {
        this.opts.onThreshold?.(view, bucket, level, meter.utilization, meter.resetsAt);
      });
    }
  }

  /**
   * Tell `onForecast` once per window and reset when an account serving live
   * runs is projected to wall inside the lead (control-tower phase 92, #141) —
   * "admin@ weekly walls ≈10:50Z, resets 09-30 12:00Z", hours ahead rather
   * than at 95 %. Fed from real reads only, like the thresholds.
   */
  private forecastWarnings(accountId: string, usage: AccountUsage): void {
    if (!this.opts.onForecast || usage.error || usage.unsupported || !this.isActive(accountId)) return;
    // …nor does it wall: no warning, and no hold (#146).
    if (this.creditCarries(accountId)) return;
    const nowMs = this.now();
    const lead = this.opts.forecastLeadMs?.() ?? FORECAST_LEAD_HOURS * 3_600_000;
    for (const [bucket, forecast] of Object.entries(forecastUsage(usage, nowMs))) {
      if (!forecast.wallsAt || Date.parse(forecast.wallsAt) - nowMs > lead) continue;
      const key = `${accountId}:${bucket}:${forecast.resetsAt}`;
      if (this.forecastTold.has(key)) continue;
      this.forecastTold.add(key);
      const meta = this.meta(accountId);
      if (!meta) continue;
      void this.view(meta).then((view) => {
        this.opts.onForecast?.(view, bucket, forecast);
      });
    }
  }

  private changed(): void {
    this.opts.onChange?.();
  }
}

/** A short digest of an access token — enough to tell two apart, never the token. */
function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * What a one-turn check's stop means — read by `classify()`, the classifier a
 * phase's stop is judged by, so the two can never disagree about a refusal.
 * `fail` is a credential-class refusal (`class` says which); `ok` is any stop
 * that proves the API TOOK work under the credential — a completed turn, a
 * usage limit (the API accepted the credential and then counted), a spent cap
 * or turn budget; `skip` is everything that proves nothing either way.
 */
export function probeVerdict(session: ProbeSession): { status: LearnedProbe['status']; reason: string; class?: CredentialClass } {
  if (session.ending === 'spawn-failed') return { status: 'skip', reason: `the session could not start: ${session.error ?? 'no reason given'}` };
  if (session.ending === 'timeout') return { status: 'skip', reason: `the session did not answer: ${session.error ?? 'timed out'}` };
  const disposition = classify(session.signal);
  switch (disposition.kind) {
    case 'credential-refused':
      return { status: 'fail', reason: disposition.reason, class: disposition.class };
    case 'ok':
      return { status: 'ok', reason: 'a one-turn session under this account completed' };
    case 'wait-until':
      return { status: 'ok', reason: `the API took the credential and answered with its usage limit — ${disposition.reason}` };
    case 'resume':
      return { status: 'ok', reason: `the API took the credential and the session spent its own cap (${disposition.raise})` };
    case 'switch-model':
      return disposition.bucket
        ? { status: 'ok', reason: `the API took the credential and answered with a per-model limit — ${disposition.reason}` }
        : { status: 'skip', reason: `the API could not answer: ${disposition.reason}` };
    case 'needs-human':
      return disposition.cause === 'usage-window'
        ? { status: 'ok', reason: `the API took the credential and answered with its usage limit — ${disposition.reason}` }
        : { status: 'skip', reason: `the session could not tell: ${disposition.reason}` };
    case 'connectivity':
      // The one answer that is not about the credential at all. "I could not
      // ask" is not "no" — this module's own rule — and a check run during an
      // outage must move nothing, least of all onto a class with a breaker.
      return { status: 'skip', reason: `the check could not reach the API: ${disposition.reason}` };
    default:
      return { status: 'skip', reason: `the session could not tell: ${disposition.reason}` };
  }
}
