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
import { WALL_PCT } from '../../shared/ops-vocab.js';

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
};

/** What the facade hands the poller when asked for a way in. */
export type TokenAnswer =
  | { token: string; /** 401/403 mean "this credential kind is not served", not "signed out". */ tokenKind?: 'setup-token' }
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
  private version: string | null = null;
  private stopped = false;

  constructor(opts: UsagePollerOptions) {
    this.opts = opts;
    this.base = (opts.base ?? process.env.PHASE_CONSOLE_USAGE_BASE ?? 'https://api.anthropic.com')
      .replace(/\/+$/, '');
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
  }

  private schedule(accountId: string, delayMs: number): void {
    const existing = this.timers.get(accountId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void this.poll(accountId); }, delayMs);
    timer.unref?.();
    this.timers.set(accountId, timer);
  }

  private async poll(accountId: string): Promise<void> {
    if (this.stopped) return;
    // Single-flight: a kick landing mid-request rides the request.
    const running = this.inFlight.get(accountId);
    if (running) return running;
    const work = this.pollOnce(accountId).finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, work);
    return work;
  }

  private async pollOnce(accountId: string): Promise<void> {
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
        const outcome = await this.fetchUsage(answer.token);
        if (outcome.kind === 'ok') {
          this.failures.delete(accountId);
          this.remember(accountId, { buckets: outcome.buckets, ...(outcome.orgId ? { orgId: outcome.orgId } : {}) });
          nextMs = this.cadence(accountId);
        } else if (outcome.kind === 'refused') {
          if (answer.tokenKind === 'setup-token') {
            // Permanent for this credential kind — stop asking, keep the account.
            this.remember(accountId, { unsupported: true });
            this.untrackTimerOnly(accountId);
            return;
          }
          nextMs = this.backoff(accountId, 1);
          this.remember(accountId, { error: 'credential was refused — signed out, or the login is stale' });
        } else if (outcome.kind === 'rate-limited') {
          nextMs = this.backoff(accountId, 2);
          this.remember(accountId, { error: 'usage endpoint rate-limited this console' });
        } else {
          nextMs = this.backoff(accountId, 1);
          this.remember(accountId, { error: outcome.detail });
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
      orgId?: string; outcome?: UsageMeta['outcome'];
    },
  ): void {
    const previous = this.cache.get(accountId);
    const now = new Date(this.now()).toISOString();
    const usage: AccountUsage = result.buckets
      ? { buckets: result.buckets, fetchedAt: now, ...(previous?.lastErrorAt ? { lastErrorAt: previous.lastErrorAt } : {}) }
      : {
          buckets: previous?.buckets ?? {},
          ...(previous?.fetchedAt ? { fetchedAt: previous.fetchedAt } : {}),
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
          // It is cleared in exactly one place, and it is the only place where
          // the fact could actually have changed: `Accounts.addToken`, where a
          // DIFFERENT credential is written for this id.
          ...(result.unsupported || previous?.unsupported ? { unsupported: true } : {}),
        };
    this.cache.set(accountId, usage);
    this.opts.onUpdate?.(accountId, usage, {
      ...(result.orgId ? { orgId: result.orgId } : {}),
      outcome: result.outcome ?? (result.buckets ? 'ok' : result.unsupported ? 'unsupported' : 'error'),
    });
  }

  private async fetchUsage(token: string): Promise<
    | { kind: 'ok'; buckets: Record<string, UsageBucket>; orgId?: string }
    | { kind: 'refused' }
    | { kind: 'rate-limited' }
    | { kind: 'failed'; detail: string }
  > {
    const doFetch = this.opts.fetchFn ?? fetch;
    const response = await doFetch(`${this.base}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-code/${await this.claudeVersion()}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { kind: 'refused' };
    if (response.status === 429) return { kind: 'rate-limited' };
    if (!response.ok) return { kind: 'failed', detail: `usage endpoint answered ${response.status}` };
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = parseUsageBody(body);
    return { kind: 'ok', buckets: parsed.buckets, ...(parsed.orgId ? { orgId: parsed.orgId } : {}) };
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
export function parseUsageBody(body: Record<string, unknown>): { buckets: Record<string, UsageBucket>; orgId?: string } {
  const buckets = parseBuckets(body);
  const org = (body?.organization ?? body?.org) as Record<string, unknown> | undefined;
  const candidates = [
    body?.organization_id, body?.organization_uuid, body?.org_id, body?.orgId,
    org && typeof org === 'object' ? org.uuid ?? org.id : undefined,
  ];
  const orgId = candidates.find((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128);
  return { buckets, ...(orgId ? { orgId } : {}) };
}
