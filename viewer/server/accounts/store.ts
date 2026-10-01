/**
 * The account registry — which Claude identities THIS instance may start work as.
 *
 * Per instance, deliberately (like the push keys and the approvals queue, and
 * unlike `runs/`): two consoles on one machine are usually two projects with
 * two different ideas of which accounts should be burning quota on them, so
 * each instance keeps its own registration system. The same human account
 * signed into two instances is simply two profiles that refresh independently.
 *
 * Three kinds, one registry:
 *
 *  - `default` — the machine's own `claude` login. Synthesized on every read,
 *    never stored, never deletable: it exists because the CLI is signed in,
 *    not because this console registered anything.
 *  - `profile` — a console-managed `CLAUDE_CONFIG_DIR` under this instance's
 *    state dir. The operator signs into it with `claude auth login`; the CLI
 *    owns the credentials (keychain on macOS, `.credentials.json` elsewhere)
 *    and their refresh. This file holds only the metadata around that.
 *  - `token` — a pasted `claude setup-token` value. The secret itself lives in
 *    the keychain (or a 0600 file) via `credentials.ts`; the registry holds
 *    the name the operator gave it, because a bare token has no email to show.
 *
 * Nothing in this file is a secret. Tokens, access tokens and refresh tokens
 * never appear in `accounts.json` — that is `credentials.ts`'s single job.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';
import { backupIfNewer, versionOk } from '../registry-file.ts';
import { ACCOUNT_KINDS } from '../../shared/ops-vocab.js';

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type AccountMeta = {
  id: string;
  kind: AccountKind;
  /** What the operator called it — required for tokens, optional elsewhere. */
  name?: string;
  /** From `claude auth status` / `.claude.json` after a login completes. */
  email?: string;
  /** `pro`, `max`, … — `subscriptionType` as the CLI reports it. */
  plan?: string;
  createdAt: string;
  /**
   * Token accounts: when the credential was last REPLACED (control-tower phase
   * 13, #33) — a setup-token lasts a year from when it was made, so its age
   * counts from here once there is one, and from `createdAt` before.
   */
  replacedAt?: string;
  lastUsed?: string;
  /**
   * LEGACY (read-only since zero-touch-console phase 8). A 4.1.0 registry kept
   * each account's exhausted windows here — bucket name → ISO reset. They live
   * in the machine-wide learned store now (`learned.ts`, keyed by credential,
   * so two consoles share one wall); the facade folds any row still carrying
   * them into that store on construction and drops the field. Nothing writes
   * it any more.
   */
  limitedUntil?: Record<string, string>;
};

/** The one id every instance has without registering anything. */
export const DEFAULT_ACCOUNT_ID = 'default';

/** Ids are path segments and journal keys — keep them boring. */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Module-level, same discipline as the log/push/approvals paths: resolved the
 * moment this module loads, from the instance identity resolved before it.
 */
export const ACCOUNTS_DIR = join(INSTANCE_STATE_DIR, 'accounts');
const REGISTRY_FILE = join(ACCOUNTS_DIR, 'accounts.json');

/**
 * A profile account's whole `~/.claude` world lives here. `dir` is another
 * console's accounts directory when a process reads registrations it does not
 * own — the fleet supervisor's poller, reading every console's.
 */
export function profileConfigDir(id: string, dir: string = ACCOUNTS_DIR): string {
  return join(dir, id, 'config');
}

/**
 * The version this build writes. Readers accept anything `>= REGISTRY_VERSION`
 * — see `readRegistry` — and a file from the future is backed up before it is
 * overwritten. See `registry-file.ts`.
 */
const REGISTRY_VERSION = 1;

/** How many given-up ids are worth refusing to reissue. Oldest out first. */
const RETIRED_IDS_MAX = 512;

type RegistryFile = {
  version: number;
  accounts: AccountMeta[];
  /**
   * What the operator renamed the machine login to. A top-level field rather
   * than a stored meta row: the default is synthesized on every `list()`, and
   * a stored row for it would double-list, double-poll, and force relaxing
   * `add()`'s built-in guard. Old readers ignore the extra key.
   */
  defaultName?: string;
  /**
   * Ids that have been registered and removed. Kept so `newId` never reissues
   * one — see `AccountStore.taken`. Old readers ignore the extra key, and a
   * file without it simply retires nothing, which is what they did before.
   */
  retired?: string[];
  /**
   * The accounts the operator lets carry runs past their plan windows on
   * credit (control-tower phase 93, #146; operator decision 12) — per account,
   * the machine login included, OFF unless a row says so. A top-level map for
   * the reason `defaultName` is one: the default has no stored row.
   */
  overage?: Record<string, OverageSetting>;
};

/**
 * "Use credits past plan limits" (control-tower phase 93, #146): when it was
 * allowed, by whom, and the operator's own spend cap in the account's currency
 * — absent means the API's monthly limit is the cap.
 */
export type OverageSetting = { at: string; by?: string; capUsd?: number };

export class AccountStore {
  private accounts: AccountMeta[] = [];
  private retiredIds: string[] = [];
  private machineName: string | undefined;
  private overageRows: Record<string, OverageSetting> = {};
  private readonly dir: string;
  private readonly file: string;

  /** `dir` is a test seam — two registries over two instance directories, one machine-wide learned file. */
  constructor(dir: string = ACCOUNTS_DIR) {
    this.dir = dir;
    this.file = join(dir, 'accounts.json');
    const { accounts, defaultName, retired, overage } = readRegistry(this.file);
    this.accounts = accounts;
    this.retiredIds = retired;
    this.machineName = defaultName;
    this.overageRows = overage;
  }

  /** The account's "use credits past plan limits" row (#146) — undefined is OFF. */
  overageOf(id: string): OverageSetting | undefined {
    const row = this.overageRows[id];
    return row ? { ...row } : undefined;
  }

  /** Allow (a row) or stop (undefined) an account carrying runs on credit (#146). */
  setOverage(id: string, setting: OverageSetting | undefined): void {
    if (setting) this.overageRows[id] = { ...setting };
    else delete this.overageRows[id];
    this.persist();
  }

  /** The operator's name for the machine login, when they gave it one. */
  get defaultName(): string | undefined {
    return this.machineName;
  }

  setDefaultName(name: string | undefined): void {
    this.machineName = name?.trim() ? name.trim() : undefined;
    this.persist();
  }

  /**
   * REGISTERED accounts only — the synthesized default is the facade's business.
   *
   * The default may nonetheless hold a row in `accounts[]` — a 4.1.0 registry's
   * reserved limits carrier, read for the one-time fold into the learned store
   * (`rowsWithLegacyLimits` / `dropLegacyLimits`). Filtering it out here is
   * what keeps that row invisible to everything that means "accounts the
   * operator added" — `list()` would double-list it beside the synthesized
   * view, `startPolling()` would poll it twice, and `newId()` would count it as
   * a collision.
   */
  stored(): AccountMeta[] {
    return this.accounts.filter((a) => a.id !== DEFAULT_ACCOUNT_ID).map((a) => ({ ...a }));
  }

  get(id: string): AccountMeta | undefined {
    const found = this.accounts.find((a) => a.id === id);
    return found ? { ...found } : undefined;
  }

  /**
   * Mint an id from the display name — readable in journals and paths, unique
   * by suffix when the readable part collides.
   */
  newId(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
      || 'account';
    let id = base === DEFAULT_ACCOUNT_ID ? `${base}-2` : base;
    while (this.taken(id)) {
      id = `${base}-${randomBytes(2).toString('hex')}`;
    }
    return id;
  }

  /**
   * Is this id spoken for — now, or by an account that has been removed?
   *
   * The second half is #22's third ask. An id is a path segment, a journal key
   * and a throttle key, and re-minting a removed one gave the NEW profile the
   * old one's directory path and the old one's history: a run record reading
   * `accountId: "account"` named a path, not a credential, and could not tell
   * the two apart. Retiring is cheap — one more string in a file — and the
   * alternative is a record that cannot be believed.
   */
  private taken(id: string): boolean {
    return this.accounts.some((a) => a.id === id) || this.retiredIds.includes(id);
  }

  /** Ids that have been used and given up. Never reissued — see `taken`. */
  get retired(): string[] {
    return [...this.retiredIds];
  }

  add(meta: AccountMeta): void {
    if (meta.id === DEFAULT_ACCOUNT_ID) throw new Error('the default account is built in');
    if (!ACCOUNT_ID_RE.test(meta.id)) throw new Error(`account id ${JSON.stringify(meta.id)} is not usable`);
    if (this.accounts.some((a) => a.id === meta.id)) throw new Error(`account ${meta.id} already exists`);
    this.accounts.push({ ...meta });
    this.persist();
  }

  update(id: string, patch: Partial<Omit<AccountMeta, 'id' | 'kind'>>): AccountMeta | undefined {
    const found = this.accounts.find((a) => a.id === id);
    if (!found) return undefined;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (found as Record<string, unknown>)[key];
      else (found as Record<string, unknown>)[key] = value;
    }
    this.persist();
    return { ...found };
  }

  remove(id: string): AccountMeta | undefined {
    const index = this.accounts.findIndex((a) => a.id === id);
    if (index < 0) return undefined;
    const [gone] = this.accounts.splice(index, 1);
    // The id goes on the retired list and never comes back (#22): a re-created
    // profile that reused it would inherit its directory path and its journal
    // history while carrying a different credential. Bounded, oldest out
    // first — a name a thousand removals old is not one `newId` will reach for.
    if (!this.retiredIds.includes(id)) this.retiredIds.push(id);
    while (this.retiredIds.length > RETIRED_IDS_MAX) this.retiredIds.shift();
    // A removed account's permission to spend credit goes with it (#146).
    delete this.overageRows[id];
    this.persist();
    return gone;
  }

  /**
   * Every row still carrying 4.1.0's per-row walls — including the RESERVED
   * `default` row the old `markLimited` minted for the machine login. The
   * facade folds them into the learned store, once, on construction.
   */
  rowsWithLegacyLimits(): AccountMeta[] {
    return this.accounts
      .filter((a) => a.limitedUntil && Object.keys(a.limitedUntil).length)
      .map((a) => ({ ...a }));
  }

  /**
   * Forget the per-row walls: the field goes from every row, and the reserved
   * `default` row — a limits carrier, never a registration — goes entirely.
   * Writes only when something changed.
   */
  dropLegacyLimits(): void {
    let changed = false;
    for (const row of this.accounts) {
      if (row.limitedUntil) { delete row.limitedUntil; changed = true; }
    }
    const reserved = this.accounts.findIndex((a) => a.id === DEFAULT_ACCOUNT_ID);
    if (reserved >= 0) { this.accounts.splice(reserved, 1); changed = true; }
    if (changed) this.persist();
  }

  private persist(): void {
    const body: RegistryFile = {
      version: REGISTRY_VERSION,
      accounts: this.accounts,
      ...(this.machineName ? { defaultName: this.machineName } : {}),
      ...(this.retiredIds.length ? { retired: this.retiredIds } : {}),
      ...(Object.keys(this.overageRows).length ? { overage: this.overageRows } : {}),
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    backupIfNewer(this.file, 'accounts.registry');
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * Narrow a row read from disk — the `default` id in particular.
 *
 * A stored `default` row is a 4.1.0 artefact and still legitimate on the way
 * in: the old `markLimited` minted one as a RESERVED limits carrier so the
 * machine login remembered its walls across a restart. It is read here so the
 * facade can fold those walls into the learned store, after which
 * `dropLegacyLimits` removes it; `stored()` filters it out of everything that
 * means "accounts the operator added" meanwhile.
 *
 * What must not survive the read is a `default` row claiming to be a
 * REGISTRATION. `add()` refuses to create one, but nothing stood between a
 * hand-edited (or downgraded, or corrupted) `accounts.json` and a row saying
 * `{id: 'default', kind: 'token'}` — which `Credentials.envFor` would honour by
 * looking up a keychain token for it, running work as an identity the operator
 * never registered under a name that means "the machine's own login". So the
 * kind is pinned to `default` on the way in, and the row keeps only what a
 * limits carrier is for.
 */
function asReadRow(meta: AccountMeta): AccountMeta {
  if (meta.id !== DEFAULT_ACCOUNT_ID) return meta;
  return {
    id: DEFAULT_ACCOUNT_ID,
    kind: 'default',
    createdAt: meta.createdAt,
    ...(meta.limitedUntil ? { limitedUntil: meta.limitedUntil } : {}),
  };
}

/** An unreadable registry degrades to empty — same posture as the instance registry. */
function readRegistry(file: string = REGISTRY_FILE): {
  accounts: AccountMeta[]; defaultName: string | undefined; retired: string[]; overage: Record<string, OverageSetting>;
} {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RegistryFile;
    // `>=`, not `===`. See `registry-file.ts` for why an exact match here is a
    // data-loss bug with our own next release as its fuse.
    if (versionOk(parsed, REGISTRY_VERSION) && Array.isArray(parsed.accounts)) {
      return {
        accounts: parsed.accounts
          .filter((a) => a && typeof a.id === 'string' && ACCOUNT_ID_RE.test(a.id))
          .map(asReadRow),
        defaultName: typeof parsed.defaultName === 'string' && parsed.defaultName.trim()
          ? parsed.defaultName.trim()
          : undefined,
        retired: (Array.isArray(parsed.retired) ? parsed.retired : [])
          .filter((id): id is string => typeof id === 'string' && ACCOUNT_ID_RE.test(id)),
        overage: readOverage(parsed.overage),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('accounts.registry.unreadable', { error: (error as Error).message });
    }
  }
  return { accounts: [], defaultName: undefined, retired: [], overage: {} };
}

/** The `overage` map as read: a row per usable id with an ISO `at`, anything else dropped. */
function readOverage(raw: unknown): Record<string, OverageSetting> {
  const rows: Record<string, OverageSetting> = {};
  if (!raw || typeof raw !== 'object') return rows;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const row = value as Partial<OverageSetting> | null;
    if (!ACCOUNT_ID_RE.test(id) || !row || typeof row.at !== 'string') continue;
    rows[id] = {
      at: row.at,
      ...(typeof row.by === 'string' && row.by ? { by: row.by } : {}),
      ...(typeof row.capUsd === 'number' && Number.isFinite(row.capUsd) && row.capUsd >= 0 ? { capUsd: row.capUsd } : {}),
    };
  }
  return rows;
}
