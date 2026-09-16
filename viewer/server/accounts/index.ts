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

import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE } from '../config.ts';
import { log } from '../log.ts';
import { parseAuth, type AuthStatus } from '../runner/auth.ts';
import { classify } from '../runner/errors.ts';
import {
  AccountStore, ACCOUNTS_DIR, DEFAULT_ACCOUNT_ID, profileConfigDir,
  type AccountKind, type AccountMeta,
} from './store.ts';
import { Credentials, realExec, type Exec } from './credentials.ts';
import { ensureProfileWorkspace } from './workspace.ts';
import {
  ACCOUNT_COOLDOWN_MS, credentialFingerprint, hashedOrgId, LearnedAccounts,
  type CredentialClass, type Entitlement, type EntitlementView, type LearnedProbe, type LeaveBy, type LeaveKind,
} from './learned.ts';
import { probeEnv, runProbeSession, type ProbeSession, type ProbeSessionOptions } from './entitlement-probe.ts';
import { liveBuckets, UsagePoller, type AccountUsage, type TokenAnswer, type UsageMeta } from './usage.ts';
import { ALERT_PCT, AUTH_STATES, WALL_PCT, WARN_PCT } from '../../shared/ops-vocab.js';

export { DEFAULT_ACCOUNT_ID, ACCOUNT_ID_RE, profileConfigDir } from './store.ts';
export type { AccountMeta, AccountKind } from './store.ts';
export type { AccountUsage, UsageBucket } from './usage.ts';
export { ACCOUNT_COOLDOWN_MS, hashedOrgId } from './learned.ts';
export type { Entitlement, EntitlementView, CredentialClass, LearnedProbe, LeaveBy, LeaveKind } from './learned.ts';

/**
 * The quota door's refusal line, in percent of the five-hour window: a run
 * started against a window this spent would only find the wall the expensive
 * way. Stricter than `WALL_PCT`, which is what a meter has to read to be a
 * wall in its own right — three points of slack for the first phase's spend.
 */
export const PREFLIGHT_REFUSE_PCT = 97;

/**
 * Where an account's login stands. `unknown` is the honest word for a
 * setup-token — it exposes no expiry and no refresh, so the console can only
 * find out by spending it.
 */
export type AuthState = (typeof AUTH_STATES)[number];

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
  /** How often this console's poller reads the meters for this account now, in ms — what a meter's age is judged against. */
  pollEveryMs?: number;
  /**
   * Would `rankAccounts` pick this account right now (no model named, nobody
   * excluded)? `rank` is its place among the candidates, 1 first, which is the
   * order an `auto` pick walks; `why` is the rank's own reason when it is out.
   * Derived from the same predicate the rank uses, never re-derived beside it.
   */
  breaker?: AccountCandidacy;
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
  /** `usage`: a per-MODEL window — walls the bucket, never the account. */
  perModel?: boolean;
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
  | { ok: true; accountId: string; /** Percent of the five-hour window used, when a live meter says. */ fiveHourPct?: number; warn?: { pct: number; resetsAt: string } }
  | { ok: false; accountId: string; kind: 'retired' | 'wall' | 'spent'; reason: string; resetsAt?: string };

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
   * An account's login went from known-good to expired/signed-out. Fired once
   * per transition, never on first observation — a profile mid-login must not
   * raise "sign in again" before anyone has signed in at all.
   */
  onAuthChange?: (view: AccountView, state: AuthState) => void;
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
};

/** The model family a per-model window is named after (`seven_day_opus` ↔ an opus run). */
function familyOf(forModel: string | undefined): string | undefined {
  return forModel ? /(opus|sonnet|haiku|fable)/.exec(forModel.toLowerCase())?.[1] : undefined;
}

/** Where a login-backed credential stands right now. */
function authStateOf(signedIn: boolean, expiresAt: number | undefined, now: number): AuthState {
  if (!signedIn) return 'signed-out';
  if (!expiresAt) return 'ok';
  if (expiresAt <= now) return 'expired';
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
  private readonly opts: AccountsOptions;
  private readonly instanceId: string;
  private readonly accountsDir: string;
  /** The entitlement checks running now, by account — one at a time per account. */
  private readonly probing = new Map<string, Promise<EntitlementProbeResult>>();

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

  /** How soon the poller would ask about this account again, given the active probe — a test seam. */
  pollCadenceFor(accountId: string): number {
    return this.poller.cadenceFor(accountId);
  }

  startPolling(): void {
    let pollDefault = true;
    if (pollDefault) this.poller.track(DEFAULT_ACCOUNT_ID);
    for (const meta of this.store.stored()) this.poller.track(meta.id);
  }

  stop(): void {
    this.poller.stop();
  }

  /* ---------------- reading ---------------- */

  has(id: string): boolean {
    return id === DEFAULT_ACCOUNT_ID || Boolean(this.store.get(id));
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
    const usage = this.poller.snapshot(meta.id);
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
    const observed = meta.kind === 'token'
      ? 'unknown'
      : this.auth.get(meta.id) ?? authStateOf(identity.signedIn, identity.expiresAt, Date.now());
    const state: AuthState = entitlement.state === 'retired' ? 'unusable' : observed;
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
      pollEveryMs: this.poller.cadenceFor(meta.id),
      breaker: this.standing(meta.id, this.now()),
    };
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
    };
    this.identities.set(meta.id, identity);
    // The organisation is a CREDENTIAL fact — the breaker's key — and goes to
    // the machine-wide store, never into the view raw.
    this.learned.noteIdentity(this.fingerprintOf(meta.id), {
      label: this.labelOf(meta.id), ...(who?.orgId ? { orgId: who.orgId } : {}),
    });
    // A FRESH credential read is an auth observation; a cache hit is not.
    this.noteAuth(meta.id, authStateOf(identity.signedIn, identity.expiresAt, Date.now()));
    return identity;
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
    const wasGood = before === 'ok' || before === 'expiring';
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
    const meta = this.store.get(id);
    if (!meta || meta.kind !== 'profile') return undefined;
    this.identities.delete(id);
    const dir = profileConfigDir(id, this.accountsDir);
    // `claude auth status` under the profile confirms — and refreshes — its
    // credentials; the identity file fills in the address to display.
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
      this.learned.setEntitlement(fingerprint, {
        state: 'retired', at, by: leaving.by, reason: leaving.reason,
        ...(leaving.class ? { class: leaving.class } : {}),
      }, { label, ...(orgId ? { orgId } : {}) });
      // A retired account still gets a scheduler hold: the breaker is what
      // excludes it from the rank, the hold is what keeps a queued entry that
      // was admitted a moment ago from boarding on it in the same tick.
      throttleUntilMs = nowMs + ACCOUNT_COOLDOWN_MS;
      this.auth.set(id, 'unusable');
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
   * A credential-class refusal, keyed by the organisation: retires this
   * account and, through the org row, every account sharing the orgId. The
   * `leaveAccount` credential arm ends here; this is also the door a prelude
   * probe (phase 11) will use when a declared one-turn session is refused.
   */
  retire(accountId: string | undefined, orgId: string | undefined, reason: string, by: LeaveBy, cls?: CredentialClass): LeaveResult {
    const id = accountId ?? DEFAULT_ACCOUNT_ID;
    if (orgId) this.learned.noteIdentity(this.fingerprintOf(id), { label: this.labelOf(id), orgId });
    return this.leaveAccount(id, { kind: 'credential', reason, by, ...(cls ? { class: cls } : {}) });
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
    if (this.learned.entitlementOf(fingerprint, orgId, this.now()).state !== 'retired') return false;
    // The org's row may be the one answering `retired` while the credential's
    // own says something else; clearing writes the credential `unknown`
    // (refused when its own word is not `retired`, which is fine) and drops
    // the org's row either way.
    this.learned.setEntitlement(fingerprint, {
      state: 'unknown', by, reason: `cleared by ${by}`, at: new Date(this.now()).toISOString(),
    }, orgId ? { orgId } : {});
    this.learned.clearOrg(orgId, by);
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
    } else if (verdict.status === 'ok' && this.learned.entitlementOf(fingerprint, orgOf(), this.now()).state === 'unknown') {
      this.learned.setEntitlement(fingerprint, { state: 'entitled', at, by: 'probe', reason: verdict.reason }, { label });
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
      };
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
   * been read yet). Ranked by the worse of the two shared utilizations,
   * ascending; unknown usage scores 50, between the measured.
   */
  rankAccounts(excluding: string | null | undefined, forModel?: string, nowMs = Date.now()): string[] {
    const exclude = excluding === null ? null : excluding ?? DEFAULT_ACCOUNT_ID;
    // A per-model window disqualifies only for the model that would spend it
    // (`seven_day_opus` ↔ an opus run) and never feeds the score: an account
    // exhausted on Opus is the RIGHT place for a Sonnet phase, and worst-case
    // scoring would defeat the per-model design of the windows.
    const family = familyOf(forModel);
    const candidates: { id: string; tier: number; score: number; entitled: number; order: number }[] = [];
    this.accountIds().forEach((id, order) => {
      if (id === exclude) return;
      const verdict = this.candidacy(id, family, nowMs);
      if (verdict.ok) candidates.push({ id, tier: verdict.tier, score: verdict.score, entitled: verdict.entitled, order });
    });
    candidates.sort((a, b) => a.tier - b.tier || a.score - b.score || a.entitled - b.entitled || a.order - b.order);
    return candidates.map((c) => c.id);
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
    if (entitlement.state === 'retired') {
      return {
        ok: false,
        why: `retired${entitlement.via === 'org' ? ' with its organisation' : ''}${entitlement.reason ? ` — ${entitlement.reason}` : ''}`,
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
    if (oauth && oauth.expiresAt && oauth.expiresAt < Date.now() + 60_000) {
      // Stale. `claude auth status` under the same env makes the CLI refresh
      // its own credential — the one safe way to write it — then re-read.
      try {
        const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : { ...process.env };
        await this.exec('claude', ['auth', 'status'], { env });
        oauth = await this.creds.readClaudeOauth(configDir);
      } catch { /* the stale token may still be honoured; try it */ }
    }
    // The authoritative auth-state writer: it rides every poller tick and sits
    // AFTER the refresh attempt, so only a login the CLI itself could not
    // rescue ever reads as expired here.
    this.noteAuth(accountId, authStateOf(Boolean(oauth), oauth?.expiresAt, Date.now()));
    if (!oauth) {
      return meta.kind === 'profile'
        ? { error: 'not signed in yet — finish `claude auth login` for this profile' }
        : { error: 'no Claude login found on this machine' };
    }
    return { token: oauth.accessToken };
  }

  private usageUpdated(accountId: string, usage: AccountUsage, meta: UsageMeta): void {
    // The learned half of every poll: the clocks (`fetchedAt` is now the last
    // SUCCESS, `lastErrorAt` the last failure — ACT-4), the organisation when
    // the body named one, and the positive fact a successful read proves.
    const fingerprint = this.fingerprintOf(accountId);
    const label = this.labelOf(accountId);
    if (meta.orgId) this.learned.noteIdentity(fingerprint, { label, orgId: meta.orgId });
    if (meta.outcome === 'ok' && usage.fetchedAt) this.learned.noteRead(fingerprint, { successAt: usage.fetchedAt }, label);
    else if (meta.outcome === 'error' && usage.lastErrorAt) this.learned.noteRead(fingerprint, { errorAt: usage.lastErrorAt }, label);
    this.thresholds(accountId, usage);
    this.changed();
  }

  /**
   * Warn at 80, alert at 95, once per level per window — the announced level
   * resets when the meter drops back under (a new window), so the next climb
   * announces again. Fed from real polls only; stale cache never re-fires.
   */
  private thresholds(accountId: string, usage: AccountUsage): void {
    if (!this.opts.onThreshold || usage.error || usage.unsupported) return;
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

  private changed(): void {
    this.opts.onChange?.();
  }
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
    default:
      return { status: 'skip', reason: `the session could not tell: ${disposition.reason}` };
  }
}
