/**
 * What the machine has LEARNED about its Claude credentials — one file, shared
 * by every console on the machine (zero-touch-console phase 8; the audit's
 * SES-2, SES-4, ACT-4, ACT-5, ACT-8, ACT-10).
 *
 * Registration is per instance (`store.ts`: which accounts THIS console may
 * start work as) and stays so. The facts below are not about a registration,
 * they are about a CREDENTIAL — and one credential is very often registered
 * twice on one machine: the machine login is `default` in every instance, and
 * the audit found `account` registered in both consoles as two config dirs
 * under one id. So a wall one console learned was invisible to the other, which
 * spent a session rediscovering it; a refusal that cost $223.69 on one login
 * was never written anywhere a second console — or the same console after a
 * restart — could read it.
 *
 * Keyed two ways, because two questions are asked of it:
 *
 *  - **by credential fingerprint** — `sha256(<the credential's locator>)`, the
 *    keychain item or the config directory the CLI keeps the login in
 *    (`credentials.ts`'s `credentialLocator`). Stable across instances and
 *    restarts, derived from no secret. Under it: the usage WALLS
 *    (bucket → ISO reset), the ENTITLEMENT (the breaker), the last successful
 *    and the last failed meter read, the orgId the credential was last seen
 *    belonging to, and the labels (`<instance>/<accountId>`) that have named
 *    it — so a retired id keeps a tombstone `labelFor` can answer.
 *  - **by orgId** — the organisation the credential belongs to. A credential-
 *    class refusal (an organisation policy, a billing hold) is the ORG's fact,
 *    not one login's: a second profile signed into the same org fails
 *    identically, and did (REC-14). `retired` on an org excludes every
 *    credential that reports the orgId.
 *
 * The breaker's state machine is `ENTITLEMENT_TRANSITIONS` in
 * `shared/ops-vocab.js`; this file refuses a write outside it. The EFFECTIVE
 * state is derived on read (`entitlementOf`): a `cooling` past its clock reads
 * as `entitled` again without anything writing it back, and an org's `retired`
 * outranks the credential's own word.
 *
 * Atomic tmp+rename, 0600, dir 0700, and an `O_EXCL` lock around every
 * read-modify-write — the same discipline as `shared/instances.mjs`'s
 * registry, for the same reason: two consoles writing one file is the normal
 * case, not an edge one. Reads are from disk every time (the file is small and
 * the other writer is another process) behind an mtime check.
 */

import { createHash } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { STATE_DIR } from '../config.ts';
import { log } from '../log.ts';
import type { RetirementEvidence } from '../runner/errors.ts';
import {
  ENTITLEMENT_STATES, PROBE_STATUSES, WALL_PCT, entitlementMayMove, isEntitlementState,
  type CredentialClass, type EntitlementState, type LeaveKind, type ProbeStatus,
} from '../../shared/ops-vocab.js';

export type { EntitlementState, CredentialClass, LeaveKind, ProbeStatus };

/**
 * How long an account a usage wall left WITHOUT a parseable reset stays out of
 * the rotation — and the floor the scheduler holds a retired account for.
 *
 * Thirty minutes: the longest gap the usage poller itself ever leaves between
 * two reads (`ERROR_CAP_MS`), so by the time the cool-down ends a successful
 * poll has had every chance to say whether the window really reopened. The
 * measured ping-pong this bounds (ACT-5: 16 of 17 lifetime switches were a
 * reciprocal A→B→A pair) turned round in minutes.
 */
export const ACCOUNT_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a contradiction has to STAND before a green read alone clears a
 * `suspect` (control-tower phase 54, #57): the same half hour as a cool-down —
 * the poller's longest gap — so at least one more read agrees. A check the API
 * takes, or a spend, clears it at once; a refusal meanwhile retires it again.
 */
export const SUSPECT_CLEAR_MS = ACCOUNT_COOLDOWN_MS;

/**
 * The walls that hold a whole ACCOUNT out, rather than one model: the shared
 * windows, and the nameless one a live wall files when the CLI named no
 * window (`scheduler.ts` `LEARNED_WALL_BUCKET`).
 */
export const SHARED_WALLS = Object.freeze(['five_hour', 'seven_day', 'learned_window'] as const);
/** The nameless wall — no meter speaks for it by name, so the shared windows do. */
export const NAMELESS_WALL = 'learned_window';

/** What a fresh reading moved (control-tower phase 54, #78). */
export type WallReread = {
  /** Walls a reading showed open, dropped. */
  lifted: string[];
  /** Walls whose reset a reading showed earlier, moved to it. */
  moved: { bucket: string; from: string; to: string }[];
  /** A usage cooling that ended, or that a standing wall's earlier reset shortened. */
  cooling?: 'ended' | { from: string; to: string };
};

/* ---------------- certificate corroboration ---------------- */

/**
 * What it takes to believe a certificate fault is STANDING rather than the
 * weather. Three numbers, and each answers a way one blip could fake it:
 * strikes, so a single stop never decides; sessions, so one wedged lane
 * failing three times against one dropout does not count as three opinions;
 * and a span, so three stops inside twenty seconds — the measured shape of the
 * incident this exists to survive — stay one event.
 */
export const CERT_STRIKES_NEEDED = 3;
export const CERT_SESSIONS_NEEDED = 2;
export const CERT_SPAN_NEEDED_MS = 10 * 60_000;
/** Older than this and a strike is a different incident, not corroboration. */
export const CERT_STRIKE_WINDOW_MS = 60 * 60_000;
/** Kept on the row: the verdict reads the first and the last, never the middle. */
const CERT_STRIKES_KEPT = 8;

/** What the ledger says after a strike — the caller decides what to do about it. */
export type CertificateVerdict = {
  strikes: number;
  sessions: number;
  spanMs: number;
  /** Enough strikes, from enough sessions, over enough time, uninterrupted. */
  corroborated: boolean;
};

/** The file's own schema version; readers accept `>=`, writers stamp this. */
const LEARNED_VERSION = 1;

/**
 * Who wrote the breaker's word — the movers, the arms and the verbs of one
 * helper, and (phase 15) `probe`: a one-turn session a person asked for, whose
 * answer is evidence about the credential rather than about any run.
 */
export type LeaveBy = 'classifier' | 'live-wall' | 'preflight' | 'operator' | 'runner' | 'poller' | 'console' | 'probe'
  /**
   * An authenticated call that LANDED, later than a retirement that claimed
   * this machine could not reach the API. The one automatic door out of
   * `retired`, and it opens for exactly one class (`certificate`), because it
   * is the only one a successful read is evidence about.
   */
  | 'proof';

export type Entitlement = {
  state: EntitlementState;
  /** The sentence that moved it — the classifier's reason, the operator's clearance. */
  reason?: string;
  /** ISO — when this state was written. */
  at?: string;
  detail?: string;
  by?: LeaveBy;
  /** `cooling` only: ISO — when the cool-down (or the wall's own reset) ends. */
  until?: string;
  /** `retired` and `suspect`: which credential class refused. */
  class?: CredentialClass;
  /**
   * `retired` and `suspect` (control-tower phase 54, #57): what the verdict
   * stood on — a kind the API returned or a sentence on its error channel, the
   * words that matched, and whose stop it was.
   */
  evidence?: RetirementEvidence;
  /** `suspect` only: the retirement it demoted — when, by whom, and why. */
  retired?: { at?: string; by?: LeaveBy; reason?: string };
  /** `suspect` only: the green read or check that contradicts the retirement. */
  contradicted?: { at: string; by: LeaveBy; reason: string };
};

/** Where a credential stands, EFFECTIVELY, at `nowMs` — the reader's answer. */
export type EntitlementView = Entitlement & {
  /** Which record answered: the credential's own row, or its organisation's. */
  via: 'credential' | 'org' | 'none';
};

export type LearnedCredential = {
  fingerprint: string;
  /** `<instanceId>/<accountId>` labels that have pointed at this credential, first-seen order. */
  ids: string[];
  /** The organisation the credential was last seen belonging to. */
  orgId?: string;
  /** bucket → ISO reset; pruned of lapsed windows on every write. */
  walls: Record<string, string>;
  entitlement: Entitlement;
  /** ISO — the last meter read that SUCCEEDED. Absent when none ever has. */
  lastSuccessAt?: string;
  /** ISO — the last meter read that FAILED; advances on every failure. */
  lastErrorAt?: string;
  /** The last time a run left this account for another, and who moved it. */
  lastLeftAt?: { at: string; by: LeaveBy; kind: LeaveKind; reason: string };
  /**
   * The certificate-shaped stops seen against this credential, newest last —
   * the corroboration ledger. Dropped whole by a successful read, because
   * "and nothing worked in between" is half of what corroboration means.
   */
  certificateStrikes?: { at: string; session: string }[];
  /** Set when the last registration naming this credential was removed. */
  tombstone?: { name: string; retiredAt: string };
  /** The newest one-turn check of whether the credential may run work, and how many there have been. */
  probe?: LearnedProbe;
  /**
   * Whose login the credential was when this row learned what it holds — the
   * facade's identity key (control-tower phase 91, #109's deferral). `default`
   * is keyed by its LOCATOR, so a re-login as somebody else keeps the
   * fingerprint; this is what tells the two logins apart, and a change of it
   * drops the walls and the breaker that belonged to the previous one.
   */
  identity?: string;
};

/**
 * What the newest check of a credential's entitlement found (zero-touch-console
 * phase 15, ACT-8) — a real one-turn session under the account, so it is a fact
 * with an age and a price, kept beside the breaker it may have moved.
 *
 * `status` is the probes' own word (`PROBE_STATUSES`): `ok` the API took work
 * under the credential, `fail` it refused the credential (`class` says how),
 * `skip` it could not be asked (signed out, no token, a timeout, an overloaded
 * API) — which moves nothing. `count` is every check this credential has had,
 * on any console, spent or not.
 */
export type LearnedProbe = {
  at: string;
  status: ProbeStatus;
  reason: string;
  /** Who asked — the request's derived actor's `by`. */
  by: string;
  class?: CredentialClass;
  /** What the session reported spending; absent when nothing was spent or nothing was reported. */
  costUsd?: number;
  ms?: number;
  /** How the session ended, as the console saw it (`result`, `refused-early`, `timeout`, …). */
  ending?: string;
  /** `system/init.claude_code_version`, when the session got that far. */
  cliVersion?: string;
  count: number;
};


type LearnedFile = {
  version: number;
  credentials: Record<string, LearnedCredential>;
  orgs: Record<string, { entitlement: Entitlement }>;
};

/** The machine-wide file. `STATE_DIR` is `stateHome()` — NOT the instance's own directory. */
export const LEARNED_FILE = join(STATE_DIR, 'accounts', 'learned.json');

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;

/** `sha256(locator)`, the first 16 hex — a filename-safe key, derived from no secret. */
export function credentialFingerprint(locator: string): string {
  return createHash('sha256').update(locator).digest('hex').slice(0, 16);
}

/** An orgId as the browser may see it: hashed, so the view names nothing Anthropic issued. */
export function hashedOrgId(orgId: string | undefined): string | undefined {
  return orgId ? createHash('sha256').update(orgId).digest('hex').slice(0, 8) : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function empty(): LearnedFile {
  return { version: LEARNED_VERSION, credentials: {}, orgs: {} };
}

function freshCredential(fingerprint: string): LearnedCredential {
  return { fingerprint, ids: [], walls: {}, entitlement: { state: 'unknown' } };
}

function narrowEntitlement(raw: unknown): Entitlement {
  const e = (raw ?? {}) as Record<string, unknown>;
  const state = isEntitlementState(e.state) ? e.state : 'unknown';
  return {
    state,
    ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
    ...(typeof e.at === 'string' ? { at: e.at } : {}),
    ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
    ...(typeof e.by === 'string' ? { by: e.by as LeaveBy } : {}),
    ...(typeof e.until === 'string' ? { until: e.until } : {}),
    ...(typeof e.class === 'string' ? { class: e.class as CredentialClass } : {}),
    ...(e.evidence && typeof e.evidence === 'object' ? { evidence: narrowEvidence(e.evidence as Record<string, unknown>) } : {}),
    ...(e.retired && typeof e.retired === 'object' ? { retired: { ...(e.retired as NonNullable<Entitlement['retired']>) } } : {}),
    ...(e.contradicted && typeof e.contradicted === 'object'
      && typeof (e.contradicted as { at?: unknown }).at === 'string'
      ? { contradicted: { ...(e.contradicted as NonNullable<Entitlement['contradicted']>) } } : {}),
  };
}

/** A retirement's evidence read from disk: a source it does not know reads as a text match. */
function narrowEvidence(e: Record<string, unknown>): RetirementEvidence {
  return {
    source: e.source === 'api' ? 'api' : 'text',
    matched: typeof e.matched === 'string' ? e.matched.slice(0, 200) : '',
    ...(typeof e.session === 'string' ? { session: e.session } : {}),
    ...(typeof e.phase === 'number' ? { phase: e.phase } : {}),
    ...(typeof e.slug === 'string' ? { slug: e.slug } : {}),
    ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
  };
}

/** Narrow one row read from disk; a row nothing can believe becomes a fresh one. */
function narrowCredential(fingerprint: string, raw: unknown): LearnedCredential {
  const c = (raw ?? {}) as Record<string, unknown>;
  const walls: Record<string, string> = {};
  for (const [bucket, iso] of Object.entries((c.walls as Record<string, unknown>) ?? {})) {
    if (typeof iso === 'string') walls[bucket] = iso;
  }
  const tomb = c.tombstone as Record<string, unknown> | undefined;
  const left = c.lastLeftAt as Record<string, unknown> | undefined;
  return {
    fingerprint,
    ids: Array.isArray(c.ids) ? c.ids.filter((v): v is string => typeof v === 'string') : [],
    ...(typeof c.orgId === 'string' && c.orgId ? { orgId: c.orgId } : {}),
    walls,
    entitlement: narrowEntitlement(c.entitlement),
    ...(typeof c.lastSuccessAt === 'string' ? { lastSuccessAt: c.lastSuccessAt } : {}),
    ...(typeof c.lastErrorAt === 'string' ? { lastErrorAt: c.lastErrorAt } : {}),
    ...(left && typeof left.at === 'string' && typeof left.reason === 'string'
      ? { lastLeftAt: { at: left.at, by: left.by as LeaveBy, kind: left.kind as LeaveKind, reason: left.reason } }
      : {}),
    ...(tomb && typeof tomb.name === 'string' && typeof tomb.retiredAt === 'string'
      ? { tombstone: { name: tomb.name, retiredAt: tomb.retiredAt } }
      : {}),
    ...(narrowStrikes(c.certificateStrikes) ?? {}),
    ...(narrowProbe(c.probe) ?? {}),
    // Whose login the row learned under (control-tower phase 91) — kept, or a
    // re-login would never be seen past the next read of the file.
    ...(typeof c.identity === 'string' && /^[0-9a-f]{8,64}$/.test(c.identity) ? { identity: c.identity } : {}),
  };
}

/** The corroboration ledger, or nothing when the row carries none worth reading. */
function narrowStrikes(raw: unknown): { certificateStrikes: { at: string; session: string }[] } | null {
  if (!Array.isArray(raw)) return null;
  const kept = raw.flatMap((entry) => {
    const s = entry as Record<string, unknown> | undefined;
    return s && typeof s.at === 'string' && typeof s.session === 'string'
      ? [{ at: s.at, session: s.session }]
      : [];
  });
  return kept.length ? { certificateStrikes: kept } : null;
}

/** A stored probe record, or nothing when the row carries none a reader can believe. */
function narrowProbe(raw: unknown): { probe: LearnedProbe } | null {
  const p = raw as Record<string, unknown> | undefined;
  if (!p || typeof p.at !== 'string' || typeof p.reason !== 'string') return null;
  if (!(PROBE_STATUSES as readonly unknown[]).includes(p.status)) return null;
  return {
    probe: {
      at: p.at,
      status: p.status as ProbeStatus,
      reason: p.reason,
      by: typeof p.by === 'string' ? p.by : 'unknown',
      ...(typeof p.class === 'string' ? { class: p.class as CredentialClass } : {}),
      ...(typeof p.costUsd === 'number' && Number.isFinite(p.costUsd) ? { costUsd: p.costUsd } : {}),
      ...(typeof p.ms === 'number' && Number.isFinite(p.ms) ? { ms: p.ms } : {}),
      ...(typeof p.ending === 'string' ? { ending: p.ending } : {}),
      ...(typeof p.cliVersion === 'string' ? { cliVersion: p.cliVersion } : {}),
      count: typeof p.count === 'number' && Number.isFinite(p.count) && p.count > 0 ? Math.floor(p.count) : 1,
    },
  };
}


export class LearnedAccounts {
  private readonly file: string;
  private cached: { mtimeMs: number; size: number; data: LearnedFile } | null = null;
  private readonly now: () => number;

  constructor(opts: { file?: string; now?: () => number } = {}) {
    this.file = opts.file ?? LEARNED_FILE;
    this.now = opts.now ?? Date.now;
  }

  /** Where this store reads and writes — for tests and the dashboard's provenance line. */
  get path(): string {
    return this.file;
  }


  /* ---------------- reading ---------------- */

  private read(): LearnedFile {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(this.file);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      this.cached = null;
      return empty();
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) {
      return this.cached.data;
    }
    let data = empty();
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LearnedFile>;
      if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number' && parsed.version >= LEARNED_VERSION) {
        for (const [fp, row] of Object.entries(parsed.credentials ?? {})) {
          if (/^[0-9a-f]{8,64}$/.test(fp)) data.credentials[fp] = narrowCredential(fp, row);
        }
        for (const [orgId, row] of Object.entries(parsed.orgs ?? {})) {
          if (typeof orgId === 'string' && orgId) data.orgs[orgId] = { entitlement: narrowEntitlement((row as { entitlement?: unknown })?.entitlement) };
        }
      } else {
        data = empty();
      }
    } catch (error) {
      // An unreadable file degrades to empty — the same posture as the
      // registry. It is never overwritten from here: the next write goes
      // through the lock and re-reads.
      log.warn('accounts.learned.unreadable', { error: (error as Error).message });
      data = empty();
    }
    this.cached = { ...stat, data };
    return data;
  }

  /** One credential's row, as stored — or undefined when nothing was ever learned. */
  credential(fingerprint: string): LearnedCredential | undefined {
    const row = this.read().credentials[fingerprint];
    return row ? structuredClone(row) : undefined;
  }

  /** Every row, for the dashboard (phase 15) and the tests. */
  snapshot(): LearnedFile {
    return structuredClone(this.read());
  }

  /** The live walls of one credential at `nowMs` — bucket → ISO, lapsed windows dropped. */
  walls(fingerprint: string, nowMs = this.now()): Record<string, string> {
    const raw = this.read().credentials[fingerprint]?.walls ?? {};
    const live: Record<string, string> = {};
    for (const [bucket, iso] of Object.entries(raw)) {
      if (Date.parse(iso) > nowMs) live[bucket] = iso;
    }
    return live;
  }

  /**
   * Where the credential stands NOW. The organisation's `retired` outranks
   * anything the credential's own row says; a `cooling` whose clock has passed
   * reads `entitled` (the state it was entered from, by construction of the
   * transition table) without a write; everything else is the stored word.
   */
  entitlementOf(fingerprint: string, orgId?: string, nowMs = this.now()): EntitlementView {
    const data = this.read();
    const row = data.credentials[fingerprint];
    const org = orgId ?? row?.orgId;
    const orgWord = org ? data.orgs[org]?.entitlement : undefined;
    if (orgWord?.state === 'retired' || orgWord?.state === 'suspect') return { ...orgWord, via: 'org' };
    if (!row) return { state: 'unknown', via: 'none' };
    const own = row.entitlement;
    if (own.state === 'cooling') {
      const until = own.until ? Date.parse(own.until) : NaN;
      if (!Number.isFinite(until) || until <= nowMs) {
        return { state: 'entitled', at: own.at, reason: 'the cool-down has passed', via: 'credential' };
      }
    }
    return { ...own, via: 'credential' };
  }

  /** The name a removed registration was known by, if this store ever saw one for `label`. */
  tombstoneFor(label: string): { name: string; retiredAt: string } | undefined {
    for (const row of Object.values(this.read().credentials)) {
      if (row.tombstone && row.ids.includes(label)) return { ...row.tombstone };
    }
    return undefined;
  }

  /* ---------------- writing ---------------- */

  /**
   * Run `mutate` with the file held and write back what it returns. `null`
   * means nothing to write. The lock is the registry's: `O_EXCL` wins for one
   * process; a stale lock is reclaimed; a live holder is waited for, briefly,
   * then written past — losing a wall to a race is a smaller failure than a
   * console that cannot record one.
   */
  private withLock<T>(mutate: (data: LearnedFile) => T | null): T | null {
    const lock = `${this.file}.lock`;
    let held = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      for (let waited = 0; !held; waited += LOCK_POLL_MS) {
        try {
          closeSync(openSync(lock, 'wx', 0o600));
          held = true;
        } catch {
          let age = 0;
          try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = LOCK_STALE_MS + 1; }
          if (age > LOCK_STALE_MS) {
            try { rmSync(lock, { force: true }); } catch { /* raced */ }
            continue;
          }
          if (waited >= LOCK_WAIT_MS) break;
          sleepSync(LOCK_POLL_MS);
        }
      }
      this.cached = null;
      const data = this.read();
      const out = mutate(data);
      if (out === null) return null;
      this.persist(data);
      return out;
    } finally {
      if (held) {
        try { rmSync(lock, { force: true }); } catch { /* released by expiry */ }
      }
    }
  }

  private persist(data: LearnedFile): void {
    data.version = LEARNED_VERSION;
    const tmp = `${this.file}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    this.cached = null;
  }

  private row(data: LearnedFile, fingerprint: string, label?: string): LearnedCredential {
    const row = (data.credentials[fingerprint] ??= freshCredential(fingerprint));
    if (label && !row.ids.includes(label)) row.ids.push(label);
    return row;
  }

  /**
   * A NEW credential was written under an old locator — a token re-pasted for
   * an existing id, a profile directory minted again under a reused id. What
   * was learned about the previous credential does not speak for this one: the
   * row goes, walls, breaker, reads and tombstone alike. The one release from
   * everything here, for the one event that changes the answer (the same rule
   * as the poller's `forgetCredentialVerdict`).
   */
  forget(fingerprint: string): void {
    this.withLock((data) => {
      if (!data.credentials[fingerprint]) return null;
      delete data.credentials[fingerprint];
      return true;
    });
  }

  /**
   * Which registration labels (`<instance>/<accountId>`) name this credential,
   * and which organisation it belongs to. A NEW orgId on a retired credential
   * opens the breaker to `unknown` — a re-login into another organisation is a
   * different question, and the old answer does not carry (the one transition
   * out of `retired` besides a person's clearance).
   */
  noteIdentity(fingerprint: string, facts: { label?: string; orgId?: string }): void {
    this.withLock((data) => {
      const row = this.row(data, fingerprint);
      let changed = false;
      if (facts.label && !row.ids.includes(facts.label)) { row.ids.push(facts.label); changed = true; }
      if (facts.label && row.tombstone) { delete row.tombstone; changed = true; }
      if (facts.orgId && facts.orgId !== row.orgId) {
        if (row.orgId && row.entitlement.state === 'retired') {
          row.entitlement = {
            state: 'unknown', at: new Date(this.now()).toISOString(), by: 'console',
            reason: `the credential moved from organisation ${hashedOrgId(row.orgId)} to ${hashedOrgId(facts.orgId)}`,
          };
        }
        row.orgId = facts.orgId;
        changed = true;
      }
      return changed ? true : null;
    });
  }

  /**
   * The identity a credential answers NOW (control-tower phase 91, #109's
   * deferral, #131). The first observation is remembered and moves nothing; a
   * DIFFERENT identity under the same row drops what the previous login
   * earned — its walls, its breaker word, its certificate strikes — because a
   * wall another person's week hit, or a refusal of another person's login,
   * says nothing about this one. Machine-wide and on disk, so a re-login that
   * happened while every console was down is still seen. Answers what went
   * (`changed: false` for a first observation), or null when nothing did.
   */
  noteIdentityKey(fingerprint: string, key: string, label?: string): { changed: boolean; walls: string[]; breaker: EntitlementView['state'] | null } | null {
    return this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      if (row.identity === key) return null;
      const before = row.identity;
      row.identity = key;
      if (before === undefined) return { changed: false, walls: [], breaker: null };
      const walls = Object.keys(row.walls);
      row.walls = {};
      delete row.certificateStrikes;
      const breaker = row.entitlement.state === 'unknown' ? null : row.entitlement.state;
      row.entitlement = {
        state: 'unknown', at: new Date(this.now()).toISOString(), by: 'console',
        reason: 'the login under this credential changed identity — what the previous one learned does not carry',
      };
      return { changed: true, walls, breaker };
    });
  }

  /**
   * A meter read succeeded (or failed) at `at`. Success also proves
   * entitlement — and, since 5.2.0, REOPENS a certificate-class retirement.
   *
   * The rule it breaks is deliberate and narrow. A `retired` normally stays
   * retired however well a check went, because the classes that write it are
   * statements about the credential or its organisation, and a poll succeeding
   * says nothing about those. A CERTIFICATE retirement is not such a
   * statement: it is a claim about the network path, and an authenticated call
   * that lands is direct, positive proof the path is fine. The measured cost
   * of throwing that proof away was two and a half hours during which the
   * poller kept succeeding, hourly, against seven credentials the breaker
   * insisted were unusable — the evidence that would open the door was being
   * collected and discarded.
   *
   * `retired → unknown → entitled` in one write, because both legs are on the
   * transition table and stopping at `unknown` would leave the account ranked
   * below one nobody has ever read.
   */
  noteRead(fingerprint: string, read: { successAt?: string; errorAt?: string }, label?: string): void {
    this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      let changed = false;
      if (read.successAt) {
        row.lastSuccessAt = read.successAt;
        changed = true;
        const own = row.entitlement;
        const reopens = own.state === 'retired'
          && own.class === 'certificate'
          // Later than the retirement, or the proof is older than the fault.
          && Date.parse(read.successAt) > Date.parse(own.at ?? '');
        if (reopens) {
          row.entitlement = {
            state: 'entitled', at: read.successAt, by: 'proof',
            reason: 'an authenticated read reached the API after this credential was retired for a certificate',
          };
          // The strikes were about a path that demonstrably works.
          delete row.certificateStrikes;
          log.info('accounts.retired.reopened', { fingerprint, by: 'proof', class: 'certificate', at: read.successAt });
        } else if (own.state === 'unknown') {
          // A successful read is the positive fact `entitled` stands for. It
          // does not cut a `cooling` short — the wall's own clock does that.
          row.entitlement = { state: 'entitled', at: read.successAt, by: 'poller', reason: 'the usage endpoint answered' };
        }
        // A CLASSIFIER's retirement — this credential's, or its organisation's
        // — contradicted by a read that landed after it (control-tower phase
        // 54, #57). A usage read is evidence the credential reaches the API,
        // not that it may spend, so it DEMOTES to `suspect` and never clears in
        // the same write; a contradiction that has STOOD for
        // `SUSPECT_CLEAR_MS` is what clears it.
        if (!reopens && !this.demote(data, row, {
          at: read.successAt, by: 'poller', reason: 'the usage endpoint answered after the retirement',
        })) {
          this.settleSuspect(data, row, {
            at: read.successAt, by: 'poller', reason: 'green reads have contradicted the retirement for half an hour',
          }, SUSPECT_CLEAR_MS);
        }
        // Proof of reach also ends a certificate streak: corroboration means
        // "and nothing succeeded in between".
        if (!reopens && row.certificateStrikes?.length) {
          delete row.certificateStrikes;
        }
      }
      if (read.errorAt) { row.lastErrorAt = read.errorAt; changed = true; }
      return changed ? true : null;
    });
  }

  /**
   * Proof the credential can do WORK (control-tower phase 54, #57): a one-turn
   * check the API took (`probe`), or a session that spent under it (`runner`).
   * A classifier's retirement is demoted and cleared in one write — both legs
   * are on the transition table, and the proof answers the question the
   * retirement asked — a `suspect` is cleared, and an `unknown` is proved.
   * Its organisation's classifier word goes the same way. A retirement a
   * person or a refused check wrote is not the classifier's and is untouched.
   * Answers the move, or null when nothing moved.
   */
  noteProof(
    fingerprint: string, proof: { at: string; by: LeaveBy; reason: string }, label?: string,
  ): { from: EntitlementState; to: EntitlementState } | null {
    return this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      const from = this.viewOf(data, fingerprint, row.orgId).state;
      this.demote(data, row, proof);
      this.settleSuspect(data, row, proof, 0);
      if (row.entitlement.state === 'unknown') {
        row.entitlement = { state: 'entitled', at: proof.at, by: proof.by, reason: proof.reason };
      }
      const to = this.viewOf(data, fingerprint, row.orgId).state;
      return from === to ? null : { from, to };
    });
  }

  /**
   * Move a classifier's `retired` that `c` post-dates to `suspect` — the
   * credential's own word and its organisation's. Answers whether anything
   * moved. The retirement travels inside the suspect: its reason, class and
   * evidence, and when and by whom it was written.
   */
  private demote(data: LearnedFile, row: LearnedCredential, c: { at: string; by: LeaveBy; reason: string }): boolean {
    let moved = false;
    if (contradicts(row.entitlement, c.at)) {
      row.entitlement = suspectOf(row.entitlement, c);
      log.info('accounts.retired.suspect', { fingerprint: row.fingerprint, by: c.by, class: row.entitlement.class ?? null, at: c.at });
      moved = true;
    }
    const org = row.orgId ? data.orgs[row.orgId] : undefined;
    if (org && contradicts(org.entitlement, c.at)) {
      org.entitlement = suspectOf(org.entitlement, c);
      log.info('accounts.retired.suspect', { org: hashedOrgId(row.orgId), by: c.by, class: org.entitlement.class ?? null, at: c.at });
      moved = true;
    }
    return moved;
  }

  /**
   * Clear a `suspect` at least `minAgeMs` old at `c.at` — the credential's to
   * `entitled`, its organisation's row dropped — because the contradiction
   * stood, or proof arrived. Answers whether anything moved.
   */
  private settleSuspect(
    data: LearnedFile, row: LearnedCredential, c: { at: string; by: LeaveBy; reason: string }, minAgeMs: number,
  ): boolean {
    const old = (word: Entitlement | undefined) => word?.state === 'suspect'
      && Date.parse(c.at) - Date.parse(word.at ?? '') >= minAgeMs;
    let moved = false;
    if (old(row.entitlement)) {
      row.entitlement = { state: 'entitled', at: c.at, by: c.by, reason: c.reason };
      moved = true;
    }
    if (row.orgId && old(data.orgs[row.orgId]?.entitlement)) {
      delete data.orgs[row.orgId];
      moved = true;
    }
    if (moved) log.info('accounts.suspect.cleared', { fingerprint: row.fingerprint, by: c.by, at: c.at });
    return moved;
  }

  /**
   * One more certificate-shaped stop against this credential — and is that
   * now enough to believe it?
   *
   * The question exists because the two conditions that produce this text are
   * indistinguishable from one stop: a corporate MITM appliance, which is
   * standing and needs a person, and a home connection reconnecting through a
   * captive portal or a router answering TLS for itself, which clears in
   * minutes with nothing for anyone to fix. The console used to assume the
   * first, on one sighting, and retire the organisation.
   *
   * Corroboration is three strikes, from at least two SESSIONS, spanning at
   * least ten minutes, with no successful read in between (`noteRead` drops
   * the streak). Several sessions because one wedged session can fail three
   * times against one blip; ten minutes because a blip is shorter than the
   * thing worth stopping for.
   */
  noteCertificateStrike(
    fingerprint: string, strike: { at: string; session: string; reason: string }, label?: string,
  ): CertificateVerdict {
    return this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      const kept = (row.certificateStrikes ?? [])
        .filter((s) => Date.parse(strike.at) - Date.parse(s.at) <= CERT_STRIKE_WINDOW_MS);
      kept.push({ at: strike.at, session: strike.session.slice(0, 64) });
      // Bounded: the verdict only ever reads the first and the last.
      row.certificateStrikes = kept.slice(-CERT_STRIKES_KEPT);
      const strikes = row.certificateStrikes;
      const sessions = new Set(strikes.map((s) => s.session)).size;
      const spanMs = Date.parse(strikes[strikes.length - 1].at) - Date.parse(strikes[0].at);
      return {
        strikes: strikes.length,
        sessions,
        spanMs,
        corroborated: strikes.length >= CERT_STRIKES_NEEDED
          && sessions >= CERT_SESSIONS_NEEDED
          && spanMs >= CERT_SPAN_NEEDED_MS,
      };
    }) ?? { strikes: 0, sessions: 0, spanMs: 0, corroborated: false };
  }

  /**
   * A fresh usage reading re-reads every wall it can speak for (control-tower
   * phase 54, #78). A wall is "until AT THE LATEST": the reset the CLI reported
   * once is a ceiling, never a promise — measured, a weekly window reported
   * ~12 h late held a park while the same account served the same run again.
   * So a bucket read below `WALL_PCT` lifts its wall, a reading whose reset is
   * EARLIER shortens it (never later), and a nameless live wall
   * (`learned_window`) lifts once every shared window reads below it. A usage
   * `cooling` then ends when no shared wall is left and the shared windows
   * read open, or shortens to the latest shared wall that stands; a
   * certificate's cooling is not a usage fact and is untouched. Answers what
   * moved, or null when nothing did.
   */
  rereadWalls(
    fingerprint: string, buckets: Record<string, { utilization: number; resetsAt: string }>, atIso: string, label?: string,
  ): WallReread | null {
    const nowMs = Date.parse(atIso);
    if (!Number.isFinite(nowMs)) return null;
    // EVERY named shared window, read and open: a reading that lacks one says
    // nothing about it, and the nameless wall may be that very window.
    const named = SHARED_WALLS.filter((name) => name !== NAMELESS_WALL);
    const sharedOpen = named.every((name) => buckets[name] !== undefined && buckets[name].utilization < WALL_PCT);
    return this.withLock((data) => {
      const row = data.credentials[fingerprint];
      if (!row) return null;
      if (label && !row.ids.includes(label)) row.ids.push(label);
      const change: WallReread = { lifted: [], moved: [] };
      for (const [name, until] of Object.entries(row.walls)) {
        if (Date.parse(until) <= nowMs) continue;
        const reading = buckets[name];
        if (reading ? reading.utilization < WALL_PCT : name === NAMELESS_WALL && sharedOpen) {
          delete row.walls[name];
          change.lifted.push(name);
        } else if (reading && Date.parse(reading.resetsAt) > nowMs && Date.parse(reading.resetsAt) < Date.parse(until)) {
          row.walls[name] = reading.resetsAt;
          change.moved.push({ bucket: name, from: until, to: reading.resetsAt });
        }
      }
      const own = row.entitlement;
      if (own.state === 'cooling' && own.class !== 'certificate' && own.until && Date.parse(own.until) > nowMs) {
        const standing = SHARED_WALLS.map((name) => row.walls[name]).filter((iso) => iso && Date.parse(iso) > nowMs) as string[];
        if (!standing.length && sharedOpen) {
          row.entitlement = { state: 'entitled', at: atIso, by: 'poller', reason: 'a fresh reading shows headroom before the reported reset' };
          change.cooling = 'ended';
        } else if (standing.length) {
          const latest = standing.reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b));
          if (Date.parse(latest) < Date.parse(own.until)) {
            change.cooling = { from: own.until, to: latest };
            row.entitlement = { ...own, until: latest };
          }
        }
      }
      return change.lifted.length || change.moved.length || change.cooling ? change : null;
    });
  }

  /**
   * A session SPENT under this credential (control-tower phase 54, #78): its
   * shared windows — and the model it ran on — had headroom when it did, so
   * those walls lift and a usage `cooling` ends. Answers what lifted.
   */
  liftWalls(fingerprint: string, names: readonly string[], atIso: string, label?: string): { lifted: string[]; cooled: boolean } {
    return this.withLock((data) => {
      const row = data.credentials[fingerprint];
      if (!row) return null;
      if (label && !row.ids.includes(label)) row.ids.push(label);
      const lifted = names.filter((name) => row.walls[name] !== undefined);
      for (const name of lifted) delete row.walls[name];
      const own = row.entitlement;
      const cooled = own.state === 'cooling' && own.class !== 'certificate';
      if (cooled) row.entitlement = { state: 'entitled', at: atIso, by: 'runner', reason: 'a session spent under it' };
      return lifted.length || cooled ? { lifted, cooled } : null;
    }) ?? { lifted: [], cooled: false };
  }

  /** Record an exhausted window; lapsed windows are dropped on the same write. */
  markWall(fingerprint: string, bucket: string, resetsAt: string, nowMs = this.now(), label?: string): void {
    this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      const kept: Record<string, string> = {};
      for (const [name, iso] of Object.entries(row.walls)) {
        if (Date.parse(iso) > nowMs) kept[name] = iso;
      }
      kept[bucket] = resetsAt;
      row.walls = kept;
      return true;
    });
  }

  /**
   * Move the breaker. Refused — logged, not applied — outside the transition
   * table. Answers the effective state after the write, or null when the write
   * was refused.
   *
   * `orgScoped` is what lets a `retired` reach the ORGANISATION's row, which
   * excludes every sibling account at once. It is an explicit opt-in rather
   * than "the credential has an orgId, so use it", because every credential
   * has an orgId and the caller is the only one who knows whether the refusal
   * was ABOUT the organisation: `Accounts.leaveAccount` requires both an
   * org-scoped class and a structured verdict from the API. Without the
   * opt-in, one session's transient stop retired both organisations on this
   * machine inside eight minutes, and multi-account failover — the thing that
   * exists for "this credential cannot spend" — had no survivor.
   *
   * A `unknown` (a clearance) still clears the organisation's row, because
   * opening a door needs no permission that closing it did.
   */
  setEntitlement(
    fingerprint: string, next: Entitlement,
    opts: { orgId?: string; label?: string; orgScoped?: boolean } = {},
  ): EntitlementView | null {
    return this.withLock((data) => {
      const row = this.row(data, fingerprint, opts.label);
      const orgId = opts.orgId ?? row.orgId;
      if (opts.orgId && opts.orgId !== row.orgId) row.orgId = opts.orgId;
      const from = row.entitlement.state;
      if (!entitlementMayMove(from, next.state)) {
        log.warn('accounts.learned.transition-refused', { fingerprint, from, to: next.state, by: next.by ?? null });
        return null;
      }
      row.entitlement = { ...next, at: next.at ?? new Date(this.now()).toISOString() };
      if (next.state === 'retired' && orgId && opts.orgScoped) {
        data.orgs[orgId] = { entitlement: { ...row.entitlement } };
      }
      if (next.state === 'unknown' && orgId && data.orgs[orgId]?.entitlement.state === 'retired') {
        delete data.orgs[orgId];
      }
      return this.viewOf(data, fingerprint, orgId);
    });
  }

  /**
   * The clearance's second half: the organisation's breaker row goes, and so
   * does the `retired` word on every credential that reports the orgId — the
   * operator is saying "this organisation allows work again", which is one
   * fact about every login in it, not about the one row they pressed on.
   */
  clearOrg(orgId: string | undefined, by: LeaveBy = 'operator'): void {
    if (!orgId) return;
    this.withLock((data) => {
      let changed = false;
      if (data.orgs[orgId]) { delete data.orgs[orgId]; changed = true; }
      for (const row of Object.values(data.credentials)) {
        if (row.orgId === orgId && (row.entitlement.state === 'retired' || row.entitlement.state === 'suspect')) {
          row.entitlement = { state: 'unknown', at: new Date(this.now()).toISOString(), by, reason: `organisation cleared by ${by}` };
          changed = true;
        }
      }
      return changed ? true : null;
    });
  }

  /** The last time a run left this account — the dashboard's "moved off at" line. */
  noteLeft(fingerprint: string, left: { at: string; by: LeaveBy; kind: LeaveKind; reason: string }, label?: string): void {
    this.withLock((data) => {
      this.row(data, fingerprint, label).lastLeftAt = { ...left, reason: left.reason.slice(0, 200) };
      return true;
    });
  }

  /**
   * A check of the credential's entitlement finished (phase 15): the newest
   * answer replaces the last, and the count goes up whatever the answer was —
   * a check that could not be asked still happened, and a person pressing a
   * button that spends is a person worth counting.
   */
  noteProbe(fingerprint: string, probe: Omit<LearnedProbe, 'count'>, label?: string): LearnedProbe | null {
    return this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      row.probe = { ...probe, reason: probe.reason.slice(0, 300), count: (row.probe?.count ?? 0) + 1 };
      return { ...row.probe };
    });
  }

  /** The registration named `label` was removed; keep the name for `labelFor`. */
  tombstone(fingerprint: string, label: string, name: string, at = new Date(this.now()).toISOString()): void {
    this.withLock((data) => {
      const row = this.row(data, fingerprint);
      if (!row.ids.includes(label)) row.ids.push(label);
      row.tombstone = { name, retiredAt: at };
      return true;
    });
  }

  private viewOf(data: LearnedFile, fingerprint: string, orgId: string | undefined): EntitlementView {
    const org = orgId ? data.orgs[orgId]?.entitlement : undefined;
    if (org?.state === 'retired' || org?.state === 'suspect') return { ...org, via: 'org' };
    const row = data.credentials[fingerprint];
    return row ? { ...row.entitlement, via: 'credential' } : { state: 'unknown', via: 'none' };
  }
}

/** Every breaker word, for a reader that renders them in order. */
export const ENTITLEMENT_ORDER: readonly EntitlementState[] = ENTITLEMENT_STATES;

/**
 * Is `word` a CLASSIFIER's retirement that something at `atIso` post-dates?
 * The one retirement a green read or check may argue with (#57): a person's
 * and a refused check's are statements nothing automatic contradicts.
 */
function contradicts(word: Entitlement | undefined, atIso: string): boolean {
  return word?.state === 'retired' && word.by === 'classifier'
    && Date.parse(atIso) > Date.parse(word.at ?? '');
}

/** The `suspect` a contradicted retirement becomes — the retirement kept inside it. */
function suspectOf(word: Entitlement, c: { at: string; by: LeaveBy; reason: string }): Entitlement {
  return {
    state: 'suspect', at: c.at, by: c.by,
    ...(word.reason ? { reason: word.reason } : {}),
    ...(word.class ? { class: word.class } : {}),
    ...(word.evidence ? { evidence: word.evidence } : {}),
    retired: { ...(word.at ? { at: word.at } : {}), ...(word.by ? { by: word.by } : {}), ...(word.reason ? { reason: word.reason } : {}) },
    contradicted: { at: c.at, by: c.by, reason: c.reason },
  };
}
