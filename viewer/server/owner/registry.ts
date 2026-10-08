/**
 * The owner keys this console knows — `owner-doors.json`, public halves only
 * (control-tower phase 148, #208; §Architecture 19).
 *
 * One row per enrolled passkey: its credential id, its public key (SPKI DER),
 * its algorithm, the label a person gave it, the origin it was enrolled at,
 * when it was made and last used, and its signature counter. Nothing in the
 * file is secret — a stolen copy proves nothing, and a lost one costs a
 * re-enrolment — and it is written 0600 all the same, beside the console's
 * other state. The file's existence with one row in it is what turns the door
 * table's enrolled mode on (`ownerDoorMode`).
 *
 * The residual risk, as §Architecture 19 states it: a process running as the
 * operator that deliberately rewrites this file can replace the keys; the
 * console walls the paths a session takes (`console-forge`) and announces
 * every change it makes itself. It re-reads the file when its mtime moves, so
 * what it acts on is what is on disk.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PasskeyAlg } from './passkey.ts';

/** Write JSON the console's way — tmp + rename, 0600 — creating the directory. */
export function writePrivateJson(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw error;
  }
}

/** Read a JSON object, or null for a missing or unreadable file — never a throw. */
export function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type OwnerKeyRow = {
  /** The credential id, base64url. */
  id: string;
  /** The public key, SPKI DER, base64url. */
  publicKey: string;
  alg: PasskeyAlg;
  label: string;
  /** Where it was enrolled: `http://localhost:<port>` or an https host. */
  origin: string;
  rpId: string;
  createdAt: string;
  lastUsedAt: string | null;
  counter: number;
  /** The authenticator said it syncs (a passkey in a password manager) — shown, never required. */
  backedUp: boolean;
};

/** A key as a page reads it. The public key stays home — a page has no use for it. */
export type OwnerKeyView = Omit<OwnerKeyRow, 'publicKey'>;

/** A change to the keys — what the bell shows, for a week. Public, like the keys. */
export type OwnerKeyChange = { change: 'enrolled' | 'removed'; keyId: string; label: string; at: string; by: string };

type RegistryFile = { version: 1; userId: string; keys: OwnerKeyRow[]; changes: OwnerKeyChange[] };

/** The changes kept beside the keys — the newest twenty. */
const CHANGES_MAX = 20;

/** At most this many keys — a person's browsers and a spare, not a fleet. */
export const OWNER_KEYS_MAX = 16;

const ALGS = new Set(['ES256', 'EdDSA']);

function rowOf(value: unknown): OwnerKeyRow | null {
  const row = value as Partial<OwnerKeyRow> | null;
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || typeof row.publicKey !== 'string'
    || !ALGS.has(String(row.alg))) return null;
  return {
    id: row.id, publicKey: row.publicKey, alg: row.alg as PasskeyAlg,
    label: typeof row.label === 'string' ? row.label : 'owner key',
    origin: typeof row.origin === 'string' ? row.origin : '', rpId: typeof row.rpId === 'string' ? row.rpId : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '', lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : null,
    counter: Number.isSafeInteger(row.counter) && (row.counter as number) >= 0 ? (row.counter as number) : 0,
    backedUp: row.backedUp === true,
  };
}

export function keyView(row: OwnerKeyRow): OwnerKeyView {
  const { publicKey, ...view } = row;
  void publicKey;
  return view;
}

/** A label as a person typed it: one line, at most 48 characters, never empty. */
export function keyLabel(text: unknown): string {
  const label = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  return label || 'owner key';
}

export class OwnerRegistry {
  private cache: { mtimeMs: number; size: number; data: RegistryFile } | null = null;

  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): RegistryFile {
    let stat: { mtimeMs: number; size: number } | null = null;
    try { stat = statSync(this.file); } catch { stat = null; }
    if (!stat) return { version: 1, userId: '', keys: [], changes: [] };
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) return this.cache.data;
    const raw = readJsonObject(this.file);
    const keys = Array.isArray(raw?.keys) ? (raw!.keys as unknown[]).map(rowOf).filter((row): row is OwnerKeyRow => row !== null) : [];
    const changes = Array.isArray(raw?.changes)
      ? (raw!.changes as OwnerKeyChange[]).filter((c) => c && (c.change === 'enrolled' || c.change === 'removed') && typeof c.at === 'string')
      : [];
    const data: RegistryFile = { version: 1, userId: typeof raw?.userId === 'string' ? raw.userId : '', keys, changes };
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    return data;
  }

  private write(data: RegistryFile): void {
    writePrivateJson(this.file, data);
    this.cache = null;
  }

  count(): number {
    return this.read().keys.length;
  }

  list(): OwnerKeyView[] {
    return this.read().keys.map(keyView);
  }

  get(id: string): OwnerKeyRow | null {
    return this.read().keys.find((row) => row.id === id) ?? null;
  }

  /**
   * The WebAuthn user handle this console enrols every key under — random, and
   * its own: two consoles on one machine share the relying party `localhost`,
   * and a passkey made for one must never replace the other's.
   */
  userId(): string {
    const data = this.read();
    if (data.userId) return data.userId;
    const userId = randomBytes(16).toString('base64url');
    this.write({ ...data, userId });
    return userId;
  }

  /** The changes to the keys, newest last. */
  changes(): OwnerKeyChange[] {
    return [...this.read().changes];
  }

  /** A new key, or the reason it is not one: a credential already enrolled, or a full registry. */
  add(row: OwnerKeyRow, by: string): { ok: true } | { ok: false; reason: string } {
    const data = this.read();
    if (data.keys.some((key) => key.id === row.id)) return { ok: false, reason: 'that key is enrolled already' };
    if (data.keys.length >= OWNER_KEYS_MAX) return { ok: false, reason: `this console holds ${OWNER_KEYS_MAX} owner keys — remove one first` };
    const change: OwnerKeyChange = { change: 'enrolled', keyId: row.id, label: row.label, at: row.createdAt, by };
    this.write({
      ...data, userId: data.userId || randomBytes(16).toString('base64url'), keys: [...data.keys, row],
      changes: [...data.changes, change].slice(-CHANGES_MAX),
    });
    return { ok: true };
  }

  remove(id: string, by: string, at = new Date().toISOString()): OwnerKeyRow | null {
    const data = this.read();
    const row = data.keys.find((key) => key.id === id) ?? null;
    if (row) {
      const change: OwnerKeyChange = { change: 'removed', keyId: row.id, label: row.label, at, by };
      this.write({ ...data, keys: data.keys.filter((key) => key.id !== id), changes: [...data.changes, change].slice(-CHANGES_MAX) });
    }
    return row;
  }

  /** A use: the counter the assertion carried, and when. */
  used(id: string, counter: number, at: string): void {
    const data = this.read();
    if (!data.keys.some((key) => key.id === id)) return;
    this.write({ ...data, keys: data.keys.map((key) => (key.id === id ? { ...key, counter, lastUsedAt: at } : key)) });
  }
}
