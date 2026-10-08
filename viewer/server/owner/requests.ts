/**
 * An authority press that became a REQUEST (control-tower phase 148, #208;
 * §Architecture 19).
 *
 * On a console with an owner key, a press through a door the table does not
 * let make it — a script or an unenrolled browser (`local`), a paired phone
 * beyond its low and medium answers (`device`), a session's token, the
 * supervisor's bearer — is not applied and not dropped: it is written here,
 * naming who asked and through which door, and shown on its item ("asked by
 * <label> — confirm?") or, when it is about no item, as a `decision` item of
 * its own. The owner confirms it in one press, and the console presses it
 * then, through the owner's door, exactly as it was asked; or refuses it.
 *
 * `owner-requests.json` (0600). The body is kept because confirming presses
 * it — and a body that carries a secret is refused whole before anything is
 * written (`bodyCarriesSecret`), so nothing secret is ever kept here.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { AuthorityRoute, AuthorityVerb, PressDoor } from '../../shared/door-model.js';
import { readJsonObject, writePrivateJson } from './registry.ts';

export const REQUEST_STATES = Object.freeze(['open', 'confirmed', 'refused', 'failed'] as const);
export type RequestState = (typeof REQUEST_STATES)[number];

/** What a request is about, when it is about an item the turn already shows. */
export type RequestItem =
  | { kind: 'human-step'; id: string }
  | { kind: 'approval'; id: string }
  | { kind: 'gate'; slug: string; phase: number }
  | { kind: 'plan-approval'; slug: string }
  | { kind: 'question'; slug: string };

export type AuthorityRequest = {
  id: string;
  at: string;
  state: RequestState;
  /** Who asked: the door, the name its proof carries (a login, a run, a label), and the proof. */
  door: PressDoor;
  label: string;
  proof: string;
  /** The press: its `AUTHORITY_ROUTES` row, the authority it carries and its tier. */
  press: string;
  authority: AuthorityVerb;
  risk: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  summary: string;
  item: RequestItem | null;
  /** How many times the same press was asked again while this one stood. */
  repeats: number;
  settledAt?: string;
  settledBy?: string;
  /** What pressing it answered, once confirmed. */
  result?: { status: number; error?: string };
};

/** A request as a page and the turn read it — with its sentence. */
export type AuthorityRequestView = Omit<AuthorityRequest, 'body'> & { body: Record<string, unknown>; ask: string };

/** At most this many requests stand open; one more is refused (429), never dropped silently. */
export const REQUESTS_OPEN_MAX = 100;
/** A settled request is kept this long, then swept. */
export const REQUEST_KEEP_MS = 7 * 24 * 60 * 60_000;
/** A body larger than this is not kept — and so not asked for. */
export const REQUEST_BODY_MAX = 32 * 1024;

const DOOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  local: 'the local door (a script, the CLI or a browser with no owner key)',
  device: 'a paired device',
  session: "a session's token",
  supervisor: "the supervisor's bearer",
});

/** The sentence a person reads on the item: who asked, how, and the question. */
export function askSentence(request: Pick<AuthorityRequest, 'label' | 'door' | 'summary'>): string {
  return `asked by ${request.label} through ${DOOR_NAMES[request.door] ?? `the ${request.door} door`} — ${request.summary.split(' — ')[0]} — confirm?`;
}

export function requestView(request: AuthorityRequest): AuthorityRequestView {
  const { fingerprint, ...rest } = request as AuthorityRequest & { fingerprint?: string };
  void fingerprint;
  return { ...rest, ask: askSentence(request) };
}

/** The item a press's path names, if any — what "on its item" means. */
export function requestItemOf(path: string): RequestItem | null {
  const segments = path.split(/[?#]/)[0]!.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (segments[0] !== 'api') return null;
  const [, head, a, b, c] = segments;
  if (head === 'human-steps' && a) return { kind: 'human-step', id: a };
  if (head === 'approvals' && a) return { kind: 'approval', id: a };
  if (head === 'plans' && a && b === 'gate' && c && /^\d+$/.test(c)) return { kind: 'gate', slug: a, phase: Number(c) };
  if (head === 'run' && a && b === 'plan-approval') return { kind: 'plan-approval', slug: a };
  if (head === 'run' && a && b === 'answer') return { kind: 'question', slug: a };
  return null;
}

function fingerprintOf(input: { door: string; label: string; method: string; path: string; body: unknown }): string {
  return createHash('sha256').update(JSON.stringify([input.door, input.label, input.method, input.path, input.body])).digest('hex').slice(0, 32);
}

function rowOf(value: unknown): (AuthorityRequest & { fingerprint: string }) | null {
  const row = value as Partial<AuthorityRequest & { fingerprint: string }> | null;
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !(REQUEST_STATES as readonly string[]).includes(String(row.state))
    || typeof row.method !== 'string' || typeof row.path !== 'string') return null;
  return { ...(row as AuthorityRequest & { fingerprint: string }), body: row.body && typeof row.body === 'object' ? row.body : {} };
}

export type RequestInput = {
  door: PressDoor;
  label: string;
  proof: string;
  row: Pick<AuthorityRoute, 'verb' | 'summary'>;
  authority: AuthorityVerb;
  risk: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
};

export class AuthorityRequests {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private rows(): (AuthorityRequest & { fingerprint: string })[] {
    const raw = readJsonObject(this.file);
    return Array.isArray(raw?.requests)
      ? (raw!.requests as unknown[]).map(rowOf).filter((row): row is AuthorityRequest & { fingerprint: string } => row !== null)
      : [];
  }

  private save(rows: (AuthorityRequest & { fingerprint: string })[], now: number): void {
    const kept = rows.filter((row) => row.state === 'open' || now - Date.parse(row.settledAt ?? row.at) <= REQUEST_KEEP_MS);
    writePrivateJson(this.file, { version: 1, requests: kept });
  }

  /**
   * Record a press as a request. The same press from the same door and label,
   * asked again while the first stands, is that request (`repeats` counts it),
   * never a second one. Refused — and nothing written — past the open bound.
   */
  record(input: RequestInput, now = Date.now()): { ok: true; request: AuthorityRequest; created: boolean } | { ok: false; status: number; error: string } {
    const rows = this.rows();
    const fingerprint = fingerprintOf(input);
    const standing = rows.find((row) => row.state === 'open' && row.fingerprint === fingerprint);
    if (standing) {
      standing.repeats += 1;
      this.save(rows, now);
      return { ok: true, request: standing, created: false };
    }
    if (rows.filter((row) => row.state === 'open').length >= REQUESTS_OPEN_MAX) {
      return { ok: false, status: 429, error: `${REQUESTS_OPEN_MAX} requests already wait for the owner — confirm or refuse some first` };
    }
    const request: AuthorityRequest & { fingerprint: string } = {
      id: randomBytes(6).toString('hex'),
      at: new Date(now).toISOString(),
      state: 'open',
      door: input.door,
      label: input.label.slice(0, 120),
      proof: input.proof,
      press: input.row.verb,
      authority: input.authority,
      risk: input.risk,
      method: input.method,
      path: input.path.slice(0, 400),
      body: input.body,
      summary: input.row.summary,
      item: requestItemOf(input.path),
      repeats: 0,
      fingerprint,
    };
    this.save([...rows, request], now);
    return { ok: true, request, created: true };
  }

  get(id: string): AuthorityRequest | null {
    return this.rows().find((row) => row.id === id) ?? null;
  }

  open(): AuthorityRequest[] {
    return this.rows().filter((row) => row.state === 'open');
  }

  all(): AuthorityRequest[] {
    return this.rows();
  }

  /** The owner's answer, written once: an open request becomes confirmed, refused or failed. */
  settle(id: string, state: Exclude<RequestState, 'open'>, by: string, result?: AuthorityRequest['result'], now = Date.now()): AuthorityRequest | null {
    const rows = this.rows();
    const row = rows.find((candidate) => candidate.id === id && candidate.state === 'open');
    if (!row) return null;
    row.state = state;
    row.settledAt = new Date(now).toISOString();
    row.settledBy = by;
    if (result) row.result = result;
    this.save(rows, now);
    return row;
  }
}
