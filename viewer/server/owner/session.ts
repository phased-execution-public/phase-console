/**
 * The owner session — what one passkey assertion buys a browser for twelve
 * hours (control-tower phase 148, #208; §Architecture 19).
 *
 * The shape is a paired device's (`fleet/reach-devices.ts`): a 256-bit secret
 * that exists in the browser's cookie and in the one response that set it, and
 * nowhere else — the console keeps its sha256 and a refusal takes the same
 * constant-time path whether the id is unknown or the secret is wrong. The
 * cookie is `HttpOnly` and `SameSite=Strict` (a remote page can neither read it
 * nor send it), and `__Host-` with `Secure` on an https origin.
 *
 * Three clocks: a session ends after `OWNER_SESSION_IDLE_MS` with no press;
 * `lock` ends it at once (`phase-console owner lock` ends every one); and a
 * HIGH-risk press needs the key touched again inside `OWNER_FRESH_MS` — the
 * session remembers when it last was (`assertedAt`).
 *
 * `owner-sessions.json` (0600) holds the rows, so a console restarted by its
 * own updater does not sign the owner out.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { OWNER_FRESH_MS, OWNER_SESSION_IDLE_MS } from '../../shared/door-model.js';
import { readJsonObject, writePrivateJson } from './registry.ts';

export type OwnerSessionRow = {
  id: string;
  /** sha256 of the cookie's secret, hex — never the secret. */
  hash: string;
  keyId: string;
  /** The key's label when the session began — who the owner door names. */
  label: string;
  origin: string;
  startedAt: string;
  lastSeenAt: string;
  /** The last time the key itself was touched — a HIGH-risk press needs it inside five minutes. */
  assertedAt: string;
};

/** A session as a page reads it — no hash. */
export type OwnerSessionView = Omit<OwnerSessionRow, 'hash'> & { idleEndsAt: string; freshUntil: string; fresh: boolean };

/** At most this many live sessions — a person's browsers. A new one past it ends the oldest. */
const SESSIONS_MAX = 16;
/** `lastSeenAt` is written at most once a minute. */
const SEEN_THROTTLE_MS = 60_000;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const DUMMY = sha256(randomBytes(32).toString('hex'));

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(Buffer.from(DUMMY), Buffer.from(DUMMY));
    return false;
  }
  return timingSafeEqual(left, right);
}

/** The cookie's name: per console (two consoles share `localhost`), and `__Host-` on https. */
export function ownerCookieName(port: number, secure: boolean): string {
  return `${secure ? '__Host-' : ''}pc-owner-${Number.isFinite(port) && port > 0 ? port : 0}`;
}

/** The `Set-Cookie` that hands a browser its session. */
export function ownerCookie(name: string, value: string, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(OWNER_SESSION_IDLE_MS / 1000)}${secure ? '; Secure' : ''}`;
}

/** The `Set-Cookie` that takes it away. */
export function clearedOwnerCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** One cookie's value out of a `Cookie` header, or null. */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const text = Array.isArray(header) ? header.join('; ') : String(header ?? '');
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

function rowOf(value: unknown): OwnerSessionRow | null {
  const row = value as Partial<OwnerSessionRow> | null;
  if (!row || typeof row !== 'object') return null;
  const fields = ['id', 'hash', 'keyId', 'label', 'origin', 'startedAt', 'lastSeenAt', 'assertedAt'] as const;
  return fields.every((field) => typeof row[field] === 'string') ? (row as OwnerSessionRow) : null;
}

export class OwnerSessions {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private rows(now: number): OwnerSessionRow[] {
    const raw = readJsonObject(this.file);
    const rows = Array.isArray(raw?.sessions) ? (raw!.sessions as unknown[]).map(rowOf).filter((row): row is OwnerSessionRow => row !== null) : [];
    return rows.filter((row) => now - Date.parse(row.lastSeenAt) <= OWNER_SESSION_IDLE_MS);
  }

  private save(rows: OwnerSessionRow[]): void {
    writePrivateJson(this.file, { version: 1, sessions: rows });
  }

  static view(row: OwnerSessionRow, now = Date.now()): OwnerSessionView {
    const { hash, ...rest } = row;
    void hash;
    const asserted = Date.parse(row.assertedAt);
    return {
      ...rest,
      idleEndsAt: new Date(Date.parse(row.lastSeenAt) + OWNER_SESSION_IDLE_MS).toISOString(),
      freshUntil: new Date(asserted + OWNER_FRESH_MS).toISOString(),
      fresh: now - asserted <= OWNER_FRESH_MS,
    };
  }

  /** A new session for a key just asserted — and the one moment its cookie value exists here. */
  start(key: { id: string; label: string }, origin: string, now = Date.now()): { session: OwnerSessionView; cookieValue: string } {
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const stamp = new Date(now).toISOString();
    const row: OwnerSessionRow = {
      id, hash: sha256(secret), keyId: key.id, label: key.label, origin, startedAt: stamp, lastSeenAt: stamp, assertedAt: stamp,
    };
    const rows = this.rows(now);
    while (rows.length >= SESSIONS_MAX) rows.shift();
    this.save([...rows, row]);
    return { session: OwnerSessions.view(row, now), cookieValue: `${id}.${secret}` };
  }

  /**
   * The live session a cookie value names, or null — an unknown id, an idle
   * one and a wrong secret take one path. A hit moves `lastSeenAt` (at most
   * once a minute), which is what keeps a working owner signed in.
   */
  verify(cookieValue: string | null | undefined, now = Date.now()): OwnerSessionRow | null {
    const [id, secret] = String(cookieValue ?? '').split('.');
    const rows = this.rows(now);
    const row = id && secret ? rows.find((candidate) => candidate.id === id) : undefined;
    if (!row) {
      sameDigest(sha256(String(secret ?? '')), DUMMY);
      return null;
    }
    if (!sameDigest(sha256(secret!), row.hash)) return null;
    if (now - Date.parse(row.lastSeenAt) >= SEEN_THROTTLE_MS) {
      row.lastSeenAt = new Date(now).toISOString();
      this.save(rows);
    }
    return row;
  }

  /** The key was touched again inside this session: the fresh window restarts. */
  asserted(id: string, now = Date.now()): OwnerSessionRow | null {
    const rows = this.rows(now);
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    row.assertedAt = new Date(now).toISOString();
    row.lastSeenAt = row.assertedAt;
    this.save(rows);
    return row;
  }

  /** Is this session's last touch inside the fresh window? */
  static fresh(row: Pick<OwnerSessionRow, 'assertedAt'>, now = Date.now()): boolean {
    return now - Date.parse(row.assertedAt) <= OWNER_FRESH_MS;
  }

  /** `lock`: one session ends. */
  end(id: string, now = Date.now()): boolean {
    const rows = this.rows(now);
    const kept = rows.filter((row) => row.id !== id);
    if (kept.length === rows.length) return false;
    this.save(kept);
    return true;
  }

  /** Every session ends — `phase-console owner lock` at the machine, or with no key left. Returns how many. */
  endAll(now = Date.now(), keyId?: string): number {
    const rows = this.rows(now);
    const kept = keyId ? rows.filter((row) => row.keyId !== keyId) : [];
    if (kept.length !== rows.length || rows.length) this.save(kept);
    return rows.length - kept.length;
  }

  live(now = Date.now()): OwnerSessionView[] {
    return this.rows(now).map((row) => OwnerSessions.view(row, now));
  }
}
