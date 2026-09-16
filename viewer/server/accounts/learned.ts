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
import {
  ENTITLEMENT_STATES, PROBE_STATUSES, entitlementMayMove, isEntitlementState,
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

/** The file's own schema version; readers accept `>=`, writers stamp this. */
const LEARNED_VERSION = 1;

/**
 * Who wrote the breaker's word — the movers, the arms and the verbs of one
 * helper, and (phase 15) `probe`: a one-turn session a person asked for, whose
 * answer is evidence about the credential rather than about any run.
 */
export type LeaveBy = 'classifier' | 'live-wall' | 'preflight' | 'operator' | 'runner' | 'poller' | 'console' | 'probe';

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
  /** `retired` only: which credential class refused. */
  class?: CredentialClass;
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
  /** Set when the last registration naming this credential was removed. */
  tombstone?: { name: string; retiredAt: string };
  /** The newest one-turn check of whether the credential may run work, and how many there have been. */
  probe?: LearnedProbe;
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
    ...(narrowProbe(c.probe) ?? {}),
  };
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
    if (orgWord?.state === 'retired') return { ...orgWord, via: 'org' };
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

  /** A meter read succeeded (or failed) at `at`. Success also proves entitlement. */
  noteRead(fingerprint: string, read: { successAt?: string; errorAt?: string }, label?: string): void {
    this.withLock((data) => {
      const row = this.row(data, fingerprint, label);
      let changed = false;
      if (read.successAt) {
        row.lastSuccessAt = read.successAt;
        changed = true;
        // A successful read is the positive fact `entitled` stands for. It
        // never reopens a `retired` credential (the table refuses), and it
        // does not cut a `cooling` short — the wall's own clock does that.
        if (row.entitlement.state === 'unknown') {
          row.entitlement = { state: 'entitled', at: read.successAt, by: 'poller', reason: 'the usage endpoint answered' };
        }
      }
      if (read.errorAt) { row.lastErrorAt = read.errorAt; changed = true; }
      return changed ? true : null;
    });
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
   * table. `retired` also writes the ORGANISATION's row when the credential's
   * orgId is known, which is what excludes every sibling account; `unknown`
   * (a clearance) clears the organisation's too. Answers the effective state
   * after the write, or null when the write was refused.
   */
  setEntitlement(fingerprint: string, next: Entitlement, opts: { orgId?: string; label?: string } = {}): EntitlementView | null {
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
      if (next.state === 'retired' && orgId) {
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
        if (row.orgId === orgId && row.entitlement.state === 'retired') {
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
    if (org?.state === 'retired') return { ...org, via: 'org' };
    const row = data.credentials[fingerprint];
    return row ? { ...row.entitlement, via: 'credential' } : { state: 'unknown', via: 'none' };
  }
}

/** Every breaker word, for a reader that renders them in order. */
export const ENTITLEMENT_ORDER: readonly EntitlementState[] = ENTITLEMENT_STATES;
