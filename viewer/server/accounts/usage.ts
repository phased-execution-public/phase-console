/**
 * The usage poller — the same numbers `/usage` shows, per account, on a clock.
 *
 * The endpoint is the one the Claude CLI itself asks (`/api/oauth/usage`), and
 * it is not a documented public API — so everything about this file is built
 * to degrade: answers are cached and served stale with their age attached, a
 * refusal today does not erase what was known this morning, and an endpoint
 * that stops existing turns the meters into "no usage data" rather than an
 * error page. The runner's own limit classifier keeps working regardless; this
 * poller is telemetry, never the detector.
 *
 * Three hard-won facts shape the requests:
 *  - The `User-Agent` must look like the CLI (`claude-code/<version>`) or the
 *    request lands in an aggressively rate-limited bucket and everything is a
 *    429 forever.
 *  - Bucket names are data, not schema: `five_hour`, `seven_day`,
 *    `seven_day_opus` today, whatever tier ships next tomorrow. Anything with
 *    a `utilization` number and a `resets_at` time is a meter.
 *  - Polling cadence is a courtesy budget. Accounts with a live session get
 *    ~90s freshness; idle and exhausted ones are looked at every ten minutes;
 *    failures back off exponentially and 429s back off harder.
 */

import { realExec, type Exec } from './credentials.ts';
import {
  FORECAST_FLAT_PCT_PER_HOUR, FORECAST_MIN_SPAN_MS, FORECAST_WINDOW_MS, WALL_PCT,
} from '../../shared/ops-vocab.js';
import { ConnectivityProbe } from '../connectivity-probe.ts';
import { log } from '../log.ts';

/**
 * A utilization in PERCENT, 0–100 — the unit every meter in this file carries
 * and the unit the console decides in (`WARN_PCT` · `ALERT_PCT` · `WALL_PCT`).
 * The CLI's own `rate_limit_event` speaks in a 0–1 FRACTION; that value is
 * normalised at its boundary (`spawn.ts` → `utilizationPct`) and never
 * compared against these numbers raw (ACT-7). The alias exists so a reader can
 * tell which unit a field is in from its type rather than from a comment.
 */
export type Percent = number;

export type UsageBucket = {
  /** Percent, 0–100 — NOT the 0–1 fraction the CLI's rate_limit_event uses. */
  utilization: Percent;
  /** ISO 8601, straight from the endpoint. */
  resetsAt: string;
  /**
   * VIEW ONLY (`agedUsage`, control-tower phase 76, #109): when the read behind
   * this bucket was made. The poller's own cache never carries it.
   */
  polledAt?: string;
  /**
   * VIEW ONLY: the bucket is history, not a reading — older than
   * `USAGE_STALE_FACTOR` × the account's poll interval, past its own reset, or
   * never read successfully at all.
   */
  stale?: boolean;
};

export type AccountUsage = {
  buckets: Record<string, UsageBucket>;
  /**
   * ISO — when the buckets were last read SUCCESSFULLY. Absent when no read
   * has ever succeeded: "never readable" and "read hours ago" are different
   * facts, and the error path used to stamp the first failure's clock here and
   * carry it for ever, so a credential the endpoint had refused for fourteen
   * hours presented as meters read at 04:07 (ACT-4).
   */
  fetchedAt?: string;
  /** ISO — the last read that FAILED. Advances on every failure; the failure's own clock. */
  lastErrorAt?: string;
  /**
   * The endpoint refused this credential in a way retrying will not fix
   * (a setup-token the usage API does not serve). Distinct from `error`,
   * which is weather.
   */
  unsupported?: boolean;
  error?: string;
  /**
   * The last hour's readings per window (control-tower phase 92, #141) — what
   * `forecastUsage` draws its line through. Written by the poller that READ:
   * the supervisor's, shared whole in its meter file, or a console's own while
   * it polls for itself; a follower's adopt carries them as they are. A failed
   * read keeps them. A view never serves them — it serves the forecast.
   */
  samples?: Record<string, UsageSample[]>;
  /**
   * The account's credit state as the usage endpoint's `extra_usage` block
   * last said it (control-tower phase 93, #146) — absent when no read has said:
   * unknown is never read as on or off. Carried by a failed read like the
   * meters, shared whole in the supervisor's meter file, so a follower sees it.
   */
  credits?: UsageCredits;
};

/**
 * What an account may spend past its plan windows (control-tower phase 93,
 * #146), from the usage endpoint's `extra_usage` block — read live
 * 2026-09-27 as `{is_enabled, monthly_limit, used_credits, utilization,
 * currency, decimal_places, disabled_reason, user_disabled,
 * spend_limit_reached, credits_ever_enabled, daily, weekly}`. Amounts are in
 * the currency's MAJOR unit: the wire's are minor (`monthly_limit: 4000`,
 * `decimal_places: 2` is 40.00), converted here, at the boundary.
 */
export type UsageCredits = {
  /** `is_enabled` — the organisation lets this login spend credits past its plan windows now. */
  enabled: boolean;
  /** `monthly_limit`, major units; null when the block names none. */
  monthlyLimit: number | null;
  /** `used_credits` this month, major units; null when the block names none. */
  used: number | null;
  currency: string | null;
  /** `disabled_reason` verbatim (`out_of_credits`, `org_level_disabled`, …) when credits are off. */
  disabledReason?: string;
  /** `user_disabled` — the person turned credits off themselves. */
  userDisabled?: boolean;
  /** `spend_limit_reached` — the organisation's spend limit stopped them. */
  spendLimitReached?: boolean;
};

/** One reading of one window (control-tower phase 92). */
export type UsageSample = { at: string; pct: Percent };

/** Whether a window is filling (`climbing`), holding (`flat`), or not measured yet. */
export type UsageTrend = 'climbing' | 'flat' | 'unknown';

/**
 * One window's forecast (control-tower phase 92, #141): the reading, the burn
 * a line through the last hour's readings measures, and when that burn walls it.
 * `wallsAt` is null for a window that is flat, unmeasured, or resets first.
 */
export type BucketForecast = {
  pct: Percent;
  /** Percent per hour; null until two readings lie `FORECAST_MIN_SPAN_MS` apart. */
  burnPctPerHour: number | null;
  trend: UsageTrend;
  wallsAt: string | null;
  resetsAt: string;
  /** How many readings the line went through, and the time they span. */
  samples: number;
  spanMs: number;
};

/**
 * What the poller tells the facade beside the redacted snapshot: facts about
 * the CREDENTIAL that belong in the machine-wide learned store and never in a
 * view — the organisation the endpoint says the credential belongs to, when
 * the body carries one.
 */
export type UsageMeta = {
  orgId?: string;
  outcome: 'ok' | 'error' | 'unsupported' | 'no-credentials';
  /**
   * What kind of failure an `error` was (control-tower phase 76): the endpoint
   * REFUSED the credential, rate-limited the console, or answered some other
   * status — or the request never reached an answer at all (`unreachable`:
   * `fetch failed`, DNS, TLS, a reset connection), which says nothing about
   * the credential and is never a sign-in verdict (#110).
   */
  failure?: 'refused' | 'rate-limited' | 'unreachable' | 'failed';
  /**
   * The refused token was an access token past its own expiry whose login can
   * renew it (#111): the refusal was expected and says nothing about the login.
   */
  lapsed?: boolean;
};

/** What the facade hands the poller when asked for a way in. */
export type TokenAnswer =
  | {
    token: string;
    /** 401/403 mean "this credential kind is not served", not "signed out". */
    tokenKind?: 'setup-token';
    /**
     * Whose login this is — an opaque digest of the credential, its
     * organisation and its email (control-tower phase 76, #109). A change
     * drops the meters: they belong to the identity that earned them.
     */
    identity?: string;
    /** The access token is past its expiry and the login can renew it (#111) — a refusal now is expected. */
    lapsed?: boolean;
  }
  | { error: string }
  | null;

export type UsagePollerOptions = {
  resolveToken: (accountId: string) => Promise<TokenAnswer>;
  onUpdate?: (accountId: string, usage: AccountUsage, meta: UsageMeta) => void;
  /** Does this account have a live session right now? Drives cadence. */
  isActive?: (accountId: string) => boolean;
  fetchFn?: typeof fetch;
  exec?: Exec;
  /** Test override; defaults to PHASE_CONSOLE_USAGE_BASE, then the real host. */
  base?: string;
  now?: () => number;
  /**
   * The connectivity probe this poller reports transport failures to and hears
   * recovery from (#110). One of its own by default; a host running several
   * pollers may share one.
   */
  connectivity?: ConnectivityProbe;
};

const ACTIVE_MS = 90_000;
const IDLE_MS = 10 * 60_000;
const ERROR_BASE_MS = 60_000;
const ERROR_CAP_MS = 30 * 60_000;

/**
 * Past this age a cached meter is history, not a reading.
 *
 * Displaying a stale number with its age attached is this poller's whole
 * posture and stays exactly as it was. DECIDING on one is a different act, and
 * `rankAccounts` was doing it: a `five_hour` bucket read at 100% an hour ago
 * disqualified an account for as long as the poll kept failing, which — at
 * `ERROR_CAP_MS` — could be for ever. That inverts the rule this file opens
 * with: the poller is telemetry, never the detector. The detector is the
 * runner's own limit classifier, and what it learns is written to the
 * machine-wide learned store's walls (`learned.ts`), which carry their own expiry.
 *
 * Set to the error backoff cap: a meter older than the longest gap the poller
 * itself will ever leave is one no successful poll is behind.
 */
export const USAGE_STALE_MS = ERROR_CAP_MS;
/**
 * A bucket on a view is stale past this many poll intervals (control-tower
 * phase 76, #109): twice the cadence means a read the poller should have
 * replaced by now did not happen.
 */
export const USAGE_STALE_FACTOR = 2;
/** A meter at or past this reads as exhausted — no point asking often. The wall's own number. */
const EXHAUSTED_PCT = WALL_PCT;

/** The adaptive cadence, exported so the runner's test can assert the number it wires. */
export const USAGE_ACTIVE_MS = ACTIVE_MS;
export const USAGE_IDLE_MS = IDLE_MS;

export class UsagePoller {
  private readonly opts: Required<Pick<UsagePollerOptions, 'resolveToken'>> & UsagePollerOptions;
  private readonly base: string;
  private readonly cache = new Map<string, AccountUsage>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  /** The identity each account's cached meters were earned under (#109). */
  private readonly identities = new Map<string, string>();
  /** The delay each account's timer was last armed with — `lastDelayFor`. */
  private readonly delays = new Map<string, number>();
  private readonly connectivity: ConnectivityProbe;
  private readonly ownsConnectivity: boolean;
  private readonly offRecovered: () => void;
  private version: string | null = null;
  private stopped = false;

  constructor(opts: UsagePollerOptions) {
    this.opts = opts;
    this.base = (opts.base ?? process.env.PHASE_CONSOLE_USAGE_BASE ?? 'https://api.anthropic.com')
      .replace(/\/+$/, '');
    this.ownsConnectivity = !opts.connectivity;
    this.connectivity = opts.connectivity
      ?? new ConnectivityProbe({ base: this.base, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
    this.offRecovered = this.connectivity.onRecovered(() => this.pollAll());
  }

  /** Last-known answer, however old. The age is the caller's to display. */
  snapshot(accountId: string): AccountUsage | undefined {
    return this.cache.get(accountId);
  }

  track(accountId: string): void {
    if (this.stopped || this.timers.has(accountId)) return;
    // First look soon but not instantly — startup spawns enough already.
    this.schedule(accountId, 2_000);
  }

  untrack(accountId: string): void {
    const timer = this.timers.get(accountId);
    if (timer) clearTimeout(timer);
    this.timers.delete(accountId);
    this.cache.delete(accountId);
    this.failures.delete(accountId);
    this.identities.delete(accountId);
    this.delays.delete(accountId);
  }

  /** Ask now — a run just started, a login just completed. Fire and forget. */
  kick(accountId: string): void {
    if (this.stopped) return;
    this.schedule(accountId, 0);
  }

  /**
   * Forget everything learned about this account's credential, keeping nothing.
   *
   * The one release from a sticky `unsupported` (see `remember`), for the one
   * event that can genuinely change the answer: a new secret written for an
   * existing id. Anything else — a retry, a refresh, a restart — is asking the
   * same credential the same question.
   */
  forgetCredentialVerdict(accountId: string): void {
    this.cache.delete(accountId);
    this.failures.delete(accountId);
    this.identities.delete(accountId);
  }

  /**
   * Whose login this account is now (control-tower phase 76, #109). The meters
   * belong to the identity that earned them: when it differs from the one the
   * cached buckets were read under, they are dropped — never carried over, not
   * even through a re-poll that fails — and the account is read again at once.
   * The facade calls it when a fresh identity read notices; a poll notices by
   * itself from `TokenAnswer.identity`. True when it changed.
   */
  noteIdentity(accountId: string, identity: string): boolean {
    if (!this.identityChanged(accountId, identity)) return false;
    if (this.timers.has(accountId)) this.kick(accountId);
    return true;
  }

  private identityChanged(accountId: string, identity: string): boolean {
    const before = this.identities.get(accountId);
    this.identities.set(accountId, identity);
    if (before === undefined || before === identity) return false;
    const dropped = Object.keys(this.cache.get(accountId)?.buckets ?? {});
    this.cache.delete(accountId);
    this.failures.delete(accountId);
    log.info('accounts.identity-changed', { account: accountId, dropped });
    return true;
  }

  /** The delay this account's timer was last armed with, in ms — a test seam, like `cadenceFor`. */
  lastDelayFor(accountId: string): number | undefined {
    return this.delays.get(accountId);
  }

  /**
   * Ask now and WAIT for the answer.
   *
   * `kick` schedules a poll and returns immediately, which is right for the
   * places that only want the numbers to be fresh soon. It is wrong for a
   * Refresh BUTTON: the handler kicked, read the cache the poll had not
   * replaced yet, and answered with the same figures it was asked to replace —
   * so the button appeared to do nothing, forever. This is the awaiting
   * version, and it is what every operator-facing refresh calls.
   *
   * Single-flight is inherited from `poll`, so two people pressing at once
   * share one request rather than racing the courtesy budget.
   */
  async refresh(accountId: string): Promise<AccountUsage | undefined> {
    if (this.stopped) return this.cache.get(accountId);
    await this.poll(accountId);
    return this.cache.get(accountId);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.offRecovered();
    if (this.ownsConnectivity) this.connectivity.stop();
  }

  private schedule(accountId: string, delayMs: number): void {
    const existing = this.timers.get(accountId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void this.poll(accountId); }, delayMs);
    timer.unref?.();
    this.timers.set(accountId, timer);
    this.delays.set(accountId, delayMs);
  }

  /** Every tracked account, now — what the connectivity probe's recovery asks for (#110). */
  private pollAll(): void {
    if (this.stopped) return;
    const ids = [...this.timers.keys()];
    log.info('accounts.connectivity-restored', { accounts: ids.length });
    for (const id of ids) this.schedule(id, 0);
  }

  /** `local`: read the endpoint even while somebody else owns the poll — a Refresh the owner could not answer. */
  private async poll(accountId: string, local = false): Promise<void> {
    if (this.stopped) return;
    // Single-flight: a kick landing mid-request rides the request.
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const work = this.pollOnce(accountId, local).finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, work);
    return work;
  }

  private async pollOnce(accountId: string, local = false): Promise<void> {
    let nextMs = this.cadence(accountId);
    try {
      const answer = await this.opts.resolveToken(accountId);
      if (!answer) {
        // Nothing to ask with — not signed in yet, profile mid-login. Quietly
        // idle-cadence; the facade kicks when that changes.
        this.remember(accountId, { error: 'no credentials to ask with', outcome: 'no-credentials' });
      } else if ('error' in answer) {
        this.remember(accountId, { error: answer.error });
      } else {
        if (answer.identity) this.identityChanged(accountId, answer.identity);
        const outcome = await this.fetchUsage(answer.token);
        if (outcome.kind === 'unreachable') {
          // The request never reached an answer (#110). That is the network,
          // not this account: its back-off does not grow — it keeps its own
          // cadence — and the connectivity probe reads every account the moment
          // the network answers again. Doubling here is what left the meters
          // thirty minutes stale after the outage had ended.
          if (!this.connectivity.offline) log.warn('accounts.connectivity-lost', { account: accountId, error: outcome.detail });
          this.connectivity.noteUnreachable();
          this.remember(accountId, { error: `could not reach the usage endpoint: ${outcome.detail}`, failure: 'unreachable' });
        } else {
          this.connectivity.noteReachable();
          if (outcome.kind === 'ok') {
            this.failures.delete(accountId);
            this.remember(accountId, {
              buckets: outcome.buckets,
              ...(outcome.orgId ? { orgId: outcome.orgId } : {}),
              ...(outcome.credits ? { credits: outcome.credits } : {}),
            });
            nextMs = this.cadence(accountId);
          } else if (outcome.kind === 'refused') {
            // A setup-token the endpoint has NEVER served: permanent for this
            // credential kind — stop asking, keep the account. One it HAS
            // served (a success on file) proved the kind is served, so its
            // refusal is about this credential and reads like any login's
            // (control-tower phase 13, #33) — the token's login state follows it.
            if (answer.tokenKind === 'setup-token' && !this.cache.get(accountId)?.fetchedAt) {
              this.remember(accountId, { unsupported: true });
              this.untrackTimerOnly(accountId);
              return;
            }
            if (answer.lapsed) {
              // An access token past its expiry is refused by design (#111);
              // the login holds what renews it, and the next session under it
              // does. Not a verdict on the login, and no reason to ask less often.
              this.remember(accountId, {
                error: 'the access token has lapsed — the next session under this login renews it',
                failure: 'refused', lapsed: true,
              });
            } else {
              nextMs = this.backoff(accountId, 1);
              this.remember(accountId, { error: 'credential was refused — signed out, or the login is stale', failure: 'refused' });
            }
          } else if (outcome.kind === 'rate-limited') {
            nextMs = this.backoff(accountId, 2);
            this.remember(accountId, { error: 'usage endpoint rate-limited this console', failure: 'rate-limited' });
          } else {
            nextMs = this.backoff(accountId, 1);
            this.remember(accountId, { error: outcome.detail, failure: 'failed' });
          }
        }
      }
    } catch (error) {
      nextMs = this.backoff(accountId, 1);
      this.remember(accountId, { error: (error as Error).message });
    }
    if (!this.stopped && this.timers.has(accountId)) this.schedule(accountId, nextMs);
  }


  /** Drop the timer but keep the cache — `unsupported` is an answer, not a gap. */
  private untrackTimerOnly(accountId: string): void {
    const timer = this.timers.get(accountId);
    if (timer) clearTimeout(timer);
    this.timers.delete(accountId);
  }

  /** The cadence the poller would use for this account now — for the facade's test seam. */
  cadenceFor(accountId: string): number {
    return this.cadence(accountId);
  }

  private cadence(accountId: string): number {
    if (this.opts.isActive?.(accountId)) {
      const cached = this.cache.get(accountId);
      const exhausted = cached && Object.values(cached.buckets).some((b) => b.utilization >= EXHAUSTED_PCT);
      return exhausted ? IDLE_MS : ACTIVE_MS;
    }
    return IDLE_MS;
  }

  private backoff(accountId: string, weight: number): number {
    const count = (this.failures.get(accountId) ?? 0) + weight;
    this.failures.set(accountId, count);
    return Math.min(ERROR_BASE_MS * 2 ** (count - 1), ERROR_CAP_MS);
  }

  /**
   * A failure keeps the old buckets and stamps the reason beside them; only a
   * success moves `fetchedAt`, and a failure moves `lastErrorAt` instead.
   * Stale-and-said-so beats blank.
   *
   * The `?? now` that used to sit on the failure branch's `fetchedAt` is gone:
   * it minted a reading time for a read that never happened, once, and then
   * carried it on every later failure (ACT-4 — `account` showed "meters read
   * 04:07" for fourteen hours of refusals). A snapshot with no successful read
   * behind it now has no `fetchedAt` at all, and `liveBuckets`, `rankAccounts`
   * and the panels each say so in their own way.
   */
  private remember(
    accountId: string,
    result: {
      buckets?: Record<string, UsageBucket>; error?: string; unsupported?: boolean;
      orgId?: string; outcome?: UsageMeta['outcome']; failure?: UsageMeta['failure']; lapsed?: boolean;
      credits?: UsageCredits;
    },
  ): void {
    const previous = this.cache.get(accountId);
    const now = new Date(this.now()).toISOString();
    const usage: AccountUsage = result.buckets
      ? {
          buckets: result.buckets, fetchedAt: now,
          ...(previous?.lastErrorAt ? { lastErrorAt: previous.lastErrorAt } : {}),
          samples: withSample(previous?.samples, result.buckets, this.now()),
          // A read that did not carry the block says nothing about credits:
          // the old answer is not kept beside a newer read (#146).
          ...(result.credits ? { credits: result.credits } : {}),
        }
      : {
          buckets: previous?.buckets ?? {},
          ...(previous?.fetchedAt ? { fetchedAt: previous.fetchedAt } : {}),
          ...(previous?.samples ? { samples: previous.samples } : {}),
          ...(previous?.credits ? { credits: previous.credits } : {}),
          lastErrorAt: now,
          ...(result.error ? { error: result.error } : {}),
          // `unsupported` is a verdict about the CREDENTIAL KIND, not about
          // today: the usage endpoint does not serve setup-tokens, and it will
          // not start to because a later request timed out. Carrying it forward
          // is what makes it permanent. Without this, one transient error — an
          // operator pressing Refresh while offline — erased the verdict, the
          // poller resumed tracking an account it had already proved it could
          // never read, and the panel went back to "no usage data" instead of
          // "this kind of credential has no meters".
          //
          // It is cleared only where the fact could actually have changed —
          // where a DIFFERENT credential is written for this id:
          // `Accounts.addToken` and `Accounts.replaceToken` (phase 13).
          ...(result.unsupported || previous?.unsupported ? { unsupported: true } : {}),
        };
    this.cache.set(accountId, usage);
    const meta: UsageMeta = {
      ...(result.orgId ? { orgId: result.orgId } : {}),
      outcome: result.outcome ?? (result.buckets ? 'ok' : result.unsupported ? 'unsupported' : 'error'),
      ...(result.failure ? { failure: result.failure } : {}),
      ...(result.lapsed ? { lapsed: true } : {}),
    };
    this.opts.onUpdate?.(accountId, usage, meta);
  }

  private async fetchUsage(token: string): Promise<
    | { kind: 'ok'; buckets: Record<string, UsageBucket>; orgId?: string; credits?: UsageCredits }
    | { kind: 'refused' }
    | { kind: 'rate-limited' }
    | { kind: 'failed'; detail: string }
    | { kind: 'unreachable'; detail: string }
  > {
    const doFetch = this.opts.fetchFn ?? fetch;
    const headers = {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': `claude-code/${await this.claudeVersion()}`,
      accept: 'application/json',
    };
    let response: Response;
    try {
      response = await doFetch(`${this.base}/api/oauth/usage`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      // No answer at all — transport, never the credential (#110).
      return { kind: 'unreachable', detail: (error as Error)?.message || String(error) };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'refused' };
    if (response.status === 429) return { kind: 'rate-limited' };
    if (!response.ok) return { kind: 'failed', detail: `usage endpoint answered ${response.status}` };
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = parseUsageBody(body);
    return {
      kind: 'ok', buckets: parsed.buckets,
      ...(parsed.orgId ? { orgId: parsed.orgId } : {}),
      ...(parsed.credits ? { credits: parsed.credits } : {}),
    };
  }

  /**
   * The UA version comes from the installed CLI, asked once. A console that
   * cannot run `claude --version` still polls — with the fallback the endpoint
   * has been seen to accept — rather than not polling at all.
   */
  private async claudeVersion(): Promise<string> {
    if (this.version) return this.version;
    try {
      const { stdout } = await (this.opts.exec ?? realExec)('claude', ['--version']);
      this.version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? '2.1.0';
    } catch {
      this.version = '2.1.0';
    }
    return this.version;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

/**
 * Buckets are whatever the endpoint says they are. Anything object-shaped with
 * a numeric `utilization` and a string `resets_at` is a meter; keys are kept
 * verbatim so a `seven_day_fable` appears the day it exists.
 */
/**
 * The meters in a snapshot that may still be DECIDED on, at `nowMs`.
 *
 * Two ways a cached bucket stops being evidence, and both were being ignored:
 *
 *  - **The snapshot is old.** See `USAGE_STALE_MS`.
 *  - **The window it describes has already reset.** `resetsAt` is the endpoint's
 *    own statement of when this meter goes back to zero. A `five_hour` at 100%
 *    whose `resets_at` passed twenty minutes ago is not an exhausted account,
 *    it is a fresh window nobody has re-polled yet — and treating it as a wall
 *    kept a perfectly usable account out of the rotation until the next
 *    successful poll, which is precisely when the console is least able to
 *    make one.
 *
 * Reading — the panels, the age line — deliberately does not use this. Showing
 * a number and saying how old it is remains honest; acting on it is not.
 */
export function liveBuckets(
  usage: AccountUsage | undefined, nowMs: number,
): Record<string, UsageBucket> {
  if (!usage) return {};
  // No successful read ever: nothing here is evidence, whatever `buckets` holds.
  if (!usage.fetchedAt) return {};
  const fetchedAt = Date.parse(usage.fetchedAt);
  if (Number.isFinite(fetchedAt) && nowMs - fetchedAt > USAGE_STALE_MS) return {};
  const live: Record<string, UsageBucket> = {};
  for (const [name, bucket] of Object.entries(usage.buckets)) {
    const resets = Date.parse(bucket.resetsAt);
    if (Number.isFinite(resets) && resets <= nowMs) continue;
    live[name] = bucket;
  }
  return live;
}


/**
 * The meters as a view shows them (control-tower phase 76, #109): each bucket
 * with the time the read behind it was made (`polledAt`) and a `stale` mark —
 * older than `USAGE_STALE_FACTOR` × the account's poll interval, past its own
 * `resetsAt`, or never read successfully at all. A copy: the poller's cache is
 * never edited to make a view. Display only — what the rank may DECIDE on is
 * `liveBuckets`' answer, and a stale mark changes nothing there.
 */
export function agedUsage(usage: AccountUsage, pollEveryMs: number, nowMs: number): AccountUsage {
  const polledAt = usage.fetchedAt;
  const readAt = polledAt ? Date.parse(polledAt) : NaN;
  const old = !Number.isFinite(readAt) || nowMs - readAt > USAGE_STALE_FACTOR * pollEveryMs;
  const buckets: Record<string, UsageBucket> = {};
  for (const [name, bucket] of Object.entries(usage.buckets)) {
    const resets = Date.parse(bucket.resetsAt);
    buckets[name] = {
      ...bucket,
      ...(polledAt ? { polledAt } : {}),
      stale: old || (Number.isFinite(resets) && resets <= nowMs),
    };
  }
  // The series stays with the poller; a view serves its forecast (phase 92).
  const { samples: _series, ...rest } = usage;
  return { ...rest, buckets };
}

/**
 * The series with this reading added (control-tower phase 92, #141): each
 * window keeps what it read over the last `FORECAST_WINDOW_MS`, and starts
 * again when its reading FALLS more than `SERIES_RESET_DROP_PCT` — a window
 * that reset is a new window, and a line through both would read a crash, not
 * a rate. A window the read no longer names is dropped with its series.
 */
export function withSample(
  previous: Readonly<Record<string, readonly UsageSample[]>> | undefined,
  buckets: Readonly<Record<string, UsageBucket>>, atMs: number,
): Record<string, UsageSample[]> {
  const at = new Date(atMs).toISOString();
  const next: Record<string, UsageSample[]> = {};
  for (const [name, bucket] of Object.entries(buckets)) {
    if (typeof bucket.utilization !== 'number') continue;
    const kept = (previous?.[name] ?? []).filter((sample) => {
      const t = Date.parse(sample.at);
      return Number.isFinite(t) && t < atMs && atMs - t <= FORECAST_WINDOW_MS;
    });
    const last = kept[kept.length - 1];
    next[name] = last && bucket.utilization < last.pct - SERIES_RESET_DROP_PCT
      ? [{ at, pct: bucket.utilization }]
      : [...kept, { at, pct: bucket.utilization }];
  }
  return next;
}

/** A fall this large inside one series is a reset, not noise. */
const SERIES_RESET_DROP_PCT = 5;

/**
 * Each window's forecast at `nowMs` (control-tower phase 92, #141): the burn is
 * the slope of a least-squares line through the readings of the last hour; the
 * wall is where that line crosses 100 % from the current reading, when it does
 * so before the window resets. Only live windows (`liveBuckets`) are forecast —
 * a stale meter or one past its reset has nothing to say about the future.
 */
export function forecastUsage(usage: AccountUsage | undefined, nowMs: number): Record<string, BucketForecast> {
  const out: Record<string, BucketForecast> = {};
  for (const [name, bucket] of Object.entries(liveBuckets(usage, nowMs))) {
    const series = (usage?.samples?.[name] ?? [])
      .map((sample) => ({ t: Date.parse(sample.at), pct: sample.pct }))
      .filter((point) => Number.isFinite(point.t) && point.t <= nowMs && nowMs - point.t <= FORECAST_WINDOW_MS);
    const spanMs = series.length ? series[series.length - 1].t - series[0].t : 0;
    const burn = series.length >= 2 && spanMs >= FORECAST_MIN_SPAN_MS ? slopePerHour(series) : null;
    const trend: UsageTrend = burn === null ? 'unknown' : burn >= FORECAST_FLAT_PCT_PER_HOUR ? 'climbing' : 'flat';
    const resets = Date.parse(bucket.resetsAt);
    let wallsAt: string | null = null;
    if (bucket.utilization >= 100) wallsAt = new Date(nowMs).toISOString();
    else if (burn !== null && trend === 'climbing') {
      const wall = nowMs + ((100 - bucket.utilization) / burn) * 3_600_000;
      if (!Number.isFinite(resets) || wall < resets) wallsAt = new Date(wall).toISOString();
    }
    out[name] = {
      pct: bucket.utilization,
      burnPctPerHour: burn === null ? null : Math.max(0, Math.round(burn * 100) / 100),
      trend, wallsAt, resetsAt: bucket.resetsAt, samples: series.length, spanMs,
    };
  }
  return out;
}

/** The least-squares slope of percent over time, in percent per hour. */
function slopePerHour(points: readonly { t: number; pct: number }[]): number {
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanP = points.reduce((sum, p) => sum + p.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.pct - meanP);
    den += (p.t - meanT) ** 2;
  }
  return den > 0 ? (num / den) * 3_600_000 : 0;
}

export function parseBuckets(body: Record<string, unknown>): Record<string, UsageBucket> {
  const buckets: Record<string, UsageBucket> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as { utilization?: unknown; resets_at?: unknown };
    if (typeof entry.utilization !== 'number' || typeof entry.resets_at !== 'string') continue;
    buckets[key] = {
      // The endpoint speaks PERCENT already; the clamp is the unit's contract,
      // stated at the boundary (`Percent`), not a conversion.
      utilization: asPercent(entry.utilization),
      resetsAt: entry.resets_at,
    };
  }
  return buckets;
}

/** A percent as the meters carry it: clamped to 0–100, never a fraction. */
export function asPercent(value: number): Percent {
  return Math.max(0, Math.min(100, value));
}

/**
 * The whole answer: the meters, plus the one CREDENTIAL fact the body may carry
 * — an organisation id, under any of the spellings an evolving endpoint might
 * use. Kept for the machine-wide learned store (`learned.ts`), which the
 * breaker keys by orgId; never for a view, which sees orgIds hashed. Reading it
 * here costs nothing and means a token account — which `claude auth status`
 * cannot describe — still learns which organisation it spends against.
 */
export function parseUsageBody(
  body: Record<string, unknown>,
): { buckets: Record<string, UsageBucket>; orgId?: string; credits?: UsageCredits } {
  const buckets = parseBuckets(body);
  const credits = parseCredits(body);
  const org = (body?.organization ?? body?.org) as Record<string, unknown> | undefined;
  const candidates = [
    body?.organization_id, body?.organization_uuid, body?.org_id, body?.orgId,
    org && typeof org === 'object' ? org.uuid ?? org.id : undefined,
  ];
  const orgId = candidates.find((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128);
  return { buckets, ...(orgId ? { orgId } : {}), ...(credits ? { credits } : {}) };
}

/**
 * The `extra_usage` block as `UsageCredits` (control-tower phase 93, #146), or
 * undefined when the body has none — or one without `is_enabled`, which is the
 * one field a verdict cannot be made without. Minor units become major by the
 * block's own `decimal_places` (2 when it names none).
 */
export function parseCredits(body: Record<string, unknown>): UsageCredits | undefined {
  const block = body?.extra_usage as Record<string, unknown> | null | undefined;
  if (!block || typeof block !== 'object' || typeof block.is_enabled !== 'boolean') return undefined;
  const places = typeof block.decimal_places === 'number' && Number.isInteger(block.decimal_places)
    && block.decimal_places >= 0 && block.decimal_places <= 6 ? block.decimal_places : 2;
  const major = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) / 10 ** places : null;
  return {
    enabled: block.is_enabled,
    monthlyLimit: major(block.monthly_limit),
    used: major(block.used_credits),
    currency: typeof block.currency === 'string' && block.currency ? block.currency : null,
    ...(typeof block.disabled_reason === 'string' && block.disabled_reason ? { disabledReason: block.disabled_reason } : {}),
    ...(typeof block.user_disabled === 'boolean' ? { userDisabled: block.user_disabled } : {}),
    ...(typeof block.spend_limit_reached === 'boolean' ? { spendLimitReached: block.spend_limit_reached } : {}),
  };
}
