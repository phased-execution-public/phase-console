/**
 * The owner key's proof — a passkey's registration and assertion, verified by
 * hand with `node:crypto` (control-tower phase 148, #208; §Architecture 19).
 *
 * WebAuthn without a dependency, the way `server/license/` verifies Ed25519:
 *
 *   - a minimal CBOR reader — definite lengths, integers, byte and text
 *     strings, arrays, maps, `true`/`false`/`null`; no tags, no floats, no
 *     indefinite lengths, bounded in depth and size — which is everything an
 *     attestation object and a COSE key are made of;
 *   - COSE keys to `node:crypto` keys: ES256 (EC2 on P-256, alg -7) and EdDSA
 *     (OKP Ed25519, alg -8), nothing else;
 *   - attestation `none` only. The console proves who PRESSES, not which
 *     authenticator model was bought, so it never asks for a manufacturer's
 *     statement — and with none to verify there is no certificate chain to get
 *     wrong;
 *   - user verification REQUIRED: a PIN, a fingerprint or a face, never a bare
 *     touch;
 *   - a challenge good once, for five minutes (`Ceremonies`);
 *   - the origin and the relying-party id taken from the request's own host:
 *     `localhost`, or an https host this console serves (`--remote`). An IP
 *     origin is refused — WebAuthn needs a name — with the hint to open the
 *     console at `localhost`;
 *   - a signature counter that never goes back (a clone, or a replay), where
 *     the authenticator keeps one at all — a synced passkey reads 0 for ever.
 *
 * Nothing secret is held here or anywhere: the console keeps the public half
 * of a key (`registry.ts`), and a challenge lives in memory until it is used
 * or five minutes pass.
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

import { OWNER_CHALLENGE_MS } from '../../shared/door-model.js';

/** The two algorithms a key may be: ES256 (COSE -7) and EdDSA (COSE -8). */
export const PASSKEY_ALGS = Object.freeze({ ES256: -7, EdDSA: -8 } as const);
export type PasskeyAlg = keyof typeof PASSKEY_ALGS;

/** Why a ceremony was refused — one word each, so a test and the journal can name it. */
export type PasskeyFault =
  | 'shape' | 'cbor' | 'type' | 'challenge' | 'origin' | 'rp-id' | 'attestation'
  | 'user-presence' | 'user-verification' | 'credential' | 'algorithm' | 'signature' | 'counter';

export class PasskeyError extends Error {
  readonly fault: PasskeyFault;

  constructor(fault: PasskeyFault, message: string) {
    super(message);
    this.name = 'PasskeyError';
    this.fault = fault;
  }
}

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

/** base64url text to bytes, refusing anything that is not base64url. */
export function fromBase64url(text: unknown, what: string): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(text) || text.length > 64 * 1024) {
    throw new PasskeyError('shape', `${what} is not base64url`);
  }
  return Buffer.from(text.replace(/=+$/, ''), 'base64url');
}

export const toBase64url = (bytes: Buffer | Uint8Array): string => Buffer.from(bytes).toString('base64url');

/* ------------------------------------------------------------------ *
 * CBOR — just enough of RFC 8949 for WebAuthn
 * ------------------------------------------------------------------ */

const CBOR_MAX_DEPTH = 8;
const CBOR_MAX_ITEMS = 256;

/**
 * Read ONE CBOR item from `bytes` at `start`: the value, and where it ended. A
 * map is a `Map` (COSE keys are integers); a byte string is a `Buffer`.
 */
export function readCbor(bytes: Buffer, start = 0): { value: unknown; end: number } {
  let pos = start;
  const need = (n: number) => {
    if (n < 0 || pos + n > bytes.length) throw new PasskeyError('cbor', 'the CBOR ends before its item does');
  };
  const head = (): { major: number; arg: number } => {
    need(1);
    const first = bytes[pos++]!;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, arg: info };
    if (info === 24) { need(1); return { major, arg: bytes[pos++]! }; }
    if (info === 25) { need(2); const arg = bytes.readUInt16BE(pos); pos += 2; return { major, arg }; }
    if (info === 26) { need(4); const arg = bytes.readUInt32BE(pos); pos += 4; return { major, arg }; }
    if (info === 27) {
      need(8);
      const high = bytes.readUInt32BE(pos);
      const low = bytes.readUInt32BE(pos + 4);
      pos += 8;
      if (high > 0x1f_ffff) throw new PasskeyError('cbor', 'a CBOR integer past 2^53');
      return { major, arg: high * 2 ** 32 + low };
    }
    throw new PasskeyError('cbor', 'an indefinite or reserved CBOR length');
  };
  const item = (depth: number): unknown => {
    if (depth > CBOR_MAX_DEPTH) throw new PasskeyError('cbor', 'the CBOR nests too deep');
    const { major, arg } = head();
    switch (major) {
      case 0: return arg;
      case 1: return -1 - arg;
      case 2: {
        need(arg);
        const value = Buffer.from(bytes.subarray(pos, pos + arg));
        pos += arg;
        return value;
      }
      case 3: {
        need(arg);
        const value = bytes.toString('utf8', pos, pos + arg);
        pos += arg;
        return value;
      }
      case 4: {
        if (arg > CBOR_MAX_ITEMS) throw new PasskeyError('cbor', 'a CBOR array too long');
        const list: unknown[] = [];
        for (let i = 0; i < arg; i += 1) list.push(item(depth + 1));
        return list;
      }
      case 5: {
        if (arg > CBOR_MAX_ITEMS) throw new PasskeyError('cbor', 'a CBOR map too long');
        const map = new Map<number | string, unknown>();
        for (let i = 0; i < arg; i += 1) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') throw new PasskeyError('cbor', 'a CBOR map key that is not a number or a text');
          if (map.has(key)) throw new PasskeyError('cbor', 'a CBOR map names one key twice');
          map.set(key, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (arg === 20) return false;
        if (arg === 21) return true;
        if (arg === 22) return null;
        throw new PasskeyError('cbor', 'a CBOR float or simple value this reader does not take');
      default:
        throw new PasskeyError('cbor', 'a CBOR tag');
    }
  };
  const value = item(0);
  return { value, end: pos };
}

/** One whole CBOR document — nothing may follow its item. */
export function decodeCbor(bytes: Buffer): unknown {
  const { value, end } = readCbor(bytes, 0);
  if (end !== bytes.length) throw new PasskeyError('cbor', 'bytes follow the CBOR item');
  return value;
}

/* ------------------------------------------------------------------ *
 * Authenticator data and COSE keys
 * ------------------------------------------------------------------ */

export type AuthData = {
  rpIdHash: Buffer;
  /** user present · user verified · backup eligible · backed up · attested credential · extensions */
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean };
  signCount: number;
  credential?: { aaguid: Buffer; id: Buffer; publicKey: Map<number | string, unknown> };
};

/** Authenticator data, read whole: 32 bytes of rp-id hash, a flags byte, a counter, then what the flags announce. */
export function parseAuthData(bytes: Buffer): AuthData {
  if (bytes.length < 37) throw new PasskeyError('shape', 'the authenticator data is shorter than 37 bytes');
  const bits = bytes[32]!;
  const flags = {
    up: (bits & 0x01) !== 0, uv: (bits & 0x04) !== 0, be: (bits & 0x08) !== 0,
    bs: (bits & 0x10) !== 0, at: (bits & 0x40) !== 0, ed: (bits & 0x80) !== 0,
  };
  const data: AuthData = { rpIdHash: Buffer.from(bytes.subarray(0, 32)), flags, signCount: bytes.readUInt32BE(33) };
  let pos = 37;
  if (flags.at) {
    if (bytes.length < pos + 18) throw new PasskeyError('shape', 'the attested credential data is cut short');
    const aaguid = Buffer.from(bytes.subarray(pos, pos + 16));
    const length = bytes.readUInt16BE(pos + 16);
    pos += 18;
    if (length < 16 || length > 1023 || bytes.length < pos + length) throw new PasskeyError('credential', 'a credential id of a length WebAuthn does not allow');
    const id = Buffer.from(bytes.subarray(pos, pos + length));
    pos += length;
    const read = readCbor(bytes, pos);
    if (!(read.value instanceof Map)) throw new PasskeyError('credential', 'the credential public key is not a COSE map');
    pos = read.end;
    data.credential = { aaguid, id, publicKey: read.value as Map<number | string, unknown> };
  }
  if (flags.ed) pos = readCbor(bytes, pos).end;
  if (pos !== bytes.length) throw new PasskeyError('shape', 'bytes follow the authenticator data');
  return data;
}

function coordinate(map: Map<number | string, unknown>, label: number, what: string): string {
  const value = map.get(label);
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new PasskeyError('credential', `the COSE key's ${what} is not 32 bytes`);
  return value.toString('base64url');
}

/**
 * A COSE public key as a `node:crypto` key — ES256 or EdDSA, refused otherwise.
 * `createPublicKey` checks the EC point is on the curve, so a forged one fails here.
 */
export function coseKey(map: Map<number | string, unknown>): { alg: PasskeyAlg; key: KeyObject } {
  const kty = map.get(1);
  const alg = map.get(3);
  try {
    if (alg === PASSKEY_ALGS.ES256 && kty === 2 && map.get(-1) === 1) {
      const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: coordinate(map, -2, 'x'), y: coordinate(map, -3, 'y') }, format: 'jwk' });
      return { alg: 'ES256', key };
    }
    if (alg === PASSKEY_ALGS.EdDSA && kty === 1 && map.get(-1) === 6) {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: coordinate(map, -2, 'x') }, format: 'jwk' });
      return { alg: 'EdDSA', key };
    }
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    throw new PasskeyError('credential', 'the COSE key is not a valid public key');
  }
  throw new PasskeyError('algorithm', `only ES256 (EC2 P-256) and EdDSA (Ed25519) keys are accepted — this one is alg ${String(alg)}, kty ${String(kty)}`);
}

/** A stored public half (SPKI DER, base64url) back into a key. */
export function publicKeyOf(spki: string): KeyObject {
  return createPublicKey({ key: fromBase64url(spki, 'the stored public key'), format: 'der', type: 'spki' });
}

/* ------------------------------------------------------------------ *
 * The relying party — from the request's own host
 * ------------------------------------------------------------------ */

export type RelyingParty =
  | { ok: true; rpId: string; origin: string; secure: boolean }
  | { ok: false; reason: string };

/**
 * The origin and relying-party id a ceremony must name, from the Host the
 * request came to: `localhost` (http, any port), or a host this console serves
 * through `--remote` (https). An IP is refused — a passkey is bound to a name —
 * and so is a host the console does not serve.
 */
export function relyingPartyOf(host: string | undefined, remoteHosts: readonly string[] = []): RelyingParty {
  let url: URL;
  try {
    url = new URL(`http://${String(host ?? '').trim()}`);
  } catch {
    return { ok: false, reason: 'the request names no host a passkey can be bound to' };
  }
  const hostname = url.hostname.toLowerCase();
  const port = url.port;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')) {
    return {
      ok: false,
      reason: `a passkey is bound to a name, not an address — open this console at http://localhost${port ? `:${port}` : ''} on this machine`,
    };
  }
  if (hostname === 'localhost') return { ok: true, rpId: 'localhost', origin: `http://localhost${port ? `:${port}` : ''}`, secure: false };
  if (remoteHosts.map((name) => name.toLowerCase()).includes(hostname)) {
    return { ok: true, rpId: hostname, origin: `https://${hostname}${port && port !== '443' ? `:${port}` : ''}`, secure: true };
  }
  return {
    ok: false,
    reason: `this console does not serve ${hostname} — open it at http://localhost on this machine, or at its own https address`,
  };
}

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

/** What a ceremony must name: the challenge this console issued, the origin and the relying-party id. */
export type Expected = { challenge: string; origin: string; rpId: string };

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkClientData(raw: Buffer, type: 'webauthn.create' | 'webauthn.get', expected: Expected): void {
  let data: ClientData;
  try {
    data = JSON.parse(raw.toString('utf8')) as ClientData;
  } catch {
    throw new PasskeyError('shape', 'the client data is not JSON');
  }
  if (!data || typeof data !== 'object') throw new PasskeyError('shape', 'the client data is not an object');
  if (data.type !== type) throw new PasskeyError('type', `the client data says ${String(data.type)}, not ${type}`);
  let offered: Buffer;
  try {
    offered = fromBase64url(data.challenge, 'the challenge');
  } catch {
    throw new PasskeyError('challenge', 'the client data names no challenge');
  }
  if (!sameBytes(offered, fromBase64url(expected.challenge, 'the issued challenge'))) {
    throw new PasskeyError('challenge', 'the challenge is not the one this console issued for this ceremony');
  }
  if (data.origin !== expected.origin) {
    throw new PasskeyError('origin', `the browser signed for ${String(data.origin)}, and this console expected ${expected.origin}`);
  }
  if (data.crossOrigin === true) throw new PasskeyError('origin', 'the ceremony ran in a cross-origin frame');
}

function checkAuthData(data: AuthData, expected: Expected): void {
  if (!sameBytes(data.rpIdHash, sha256(expected.rpId))) {
    throw new PasskeyError('rp-id', `the key signed for another relying party, not ${expected.rpId}`);
  }
  if (!data.flags.up) throw new PasskeyError('user-presence', 'the authenticator says nobody was present');
  if (!data.flags.uv) {
    throw new PasskeyError('user-verification', 'the authenticator did not verify the person — the owner key needs a PIN, a fingerprint or a face');
  }
}

function credentialOf(input: unknown): { id: string; response: Record<string, unknown> } {
  const credential = input as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown } | null;
  if (!credential || typeof credential !== 'object' || credential.type !== 'public-key'
    || typeof credential.id !== 'string' || !credential.response || typeof credential.response !== 'object') {
    throw new PasskeyError('shape', 'that is not a public-key credential');
  }
  if (credential.rawId !== undefined && credential.rawId !== credential.id) throw new PasskeyError('shape', 'the credential names two ids');
  return { id: credential.id, response: credential.response as Record<string, unknown> };
}

/** A verified registration — the public half to keep. */
export type Registered = {
  credentialId: string;
  /** SPKI DER, base64url — a public key, nothing secret. */
  publicKey: string;
  alg: PasskeyAlg;
  signCount: number;
  backedUp: boolean;
};

/**
 * `navigator.credentials.create()`'s answer, checked: the client data (type,
 * challenge, origin), the attestation object (`none`, an empty statement), the
 * authenticator data (rp-id hash, present, VERIFIED, a credential) and its key.
 */
export function verifyRegistration(input: unknown, expected: Expected): Registered {
  const { id, response } = credentialOf(input);
  checkClientData(fromBase64url(response.clientDataJSON, 'the client data'), 'webauthn.create', expected);
  const attestation = decodeCbor(fromBase64url(response.attestationObject, 'the attestation object'));
  if (!(attestation instanceof Map)) throw new PasskeyError('shape', 'the attestation object is not a CBOR map');
  if (attestation.get('fmt') !== 'none') {
    throw new PasskeyError('attestation', `only attestation "none" is accepted — this credential carries "${String(attestation.get('fmt'))}"`);
  }
  const statement = attestation.get('attStmt');
  if (!(statement instanceof Map) || statement.size !== 0) throw new PasskeyError('attestation', 'attestation "none" carries an empty statement');
  const authData = attestation.get('authData');
  if (!Buffer.isBuffer(authData)) throw new PasskeyError('shape', 'the attestation object has no authenticator data');
  const data = parseAuthData(authData);
  checkAuthData(data, expected);
  if (!data.flags.at || !data.credential) throw new PasskeyError('credential', 'the authenticator data carries no new credential');
  const credentialId = toBase64url(data.credential.id);
  if (credentialId !== id.replace(/=+$/, '')) throw new PasskeyError('credential', 'the credential id does not match the one the authenticator made');
  const { alg, key } = coseKey(data.credential.publicKey);
  return {
    credentialId,
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    alg,
    signCount: data.signCount,
    backedUp: data.flags.bs,
  };
}

/** The key an assertion is checked against: what the registry keeps. */
export type KnownKey = { id: string; publicKey: string; alg: PasskeyAlg; counter: number };

/**
 * `navigator.credentials.get()`'s answer, checked against one enrolled key:
 * the client data, the authenticator data (rp-id hash, present, VERIFIED), the
 * signature over `authenticatorData ‖ sha256(clientDataJSON)` and a counter that
 * never goes back. The new counter is the caller's to store.
 */
export function verifyAssertion(input: unknown, key: KnownKey, expected: Expected): { signCount: number } {
  const { id, response } = credentialOf(input);
  if (id.replace(/=+$/, '') !== key.id) throw new PasskeyError('credential', 'the assertion is for another key');
  const clientData = fromBase64url(response.clientDataJSON, 'the client data');
  checkClientData(clientData, 'webauthn.get', expected);
  const authData = fromBase64url(response.authenticatorData, 'the authenticator data');
  const data = parseAuthData(authData);
  checkAuthData(data, expected);
  const signature = fromBase64url(response.signature, 'the signature');
  const signed = Buffer.concat([authData, sha256(clientData)]);
  let good = false;
  try {
    const publicKey = publicKeyOf(key.publicKey);
    good = key.alg === 'ES256'
      ? verify('sha256', signed, { key: publicKey, dsaEncoding: 'der' }, signature)
      : verify(null, signed, publicKey, signature);
  } catch {
    good = false;
  }
  if (!good) throw new PasskeyError('signature', 'the signature does not verify against the enrolled key');
  if ((data.signCount !== 0 || key.counter !== 0) && data.signCount <= key.counter) {
    throw new PasskeyError('counter', `the key's signature counter went back (${data.signCount} after ${key.counter}) — a cloned key, or a replay`);
  }
  return { signCount: data.signCount };
}

/* ------------------------------------------------------------------ *
 * Ceremonies — a challenge good once, for five minutes
 * ------------------------------------------------------------------ */

export type CeremonyKind = 'create' | 'get';

export type Ceremony = {
  id: string;
  kind: CeremonyKind;
  challenge: string;
  rpId: string;
  origin: string;
  expiresAt: number;
  /** What the ceremony was begun for — the enrol link's id, the session that began it. */
  context: Record<string, string>;
};

/** At most this many ceremonies wait at once; a new one past it pushes out the oldest. */
const CEREMONIES_MAX = 64;

/**
 * The challenges in flight. Memory only — a challenge is never written down,
 * so a console restarted mid-ceremony asks the person to start again — and a
 * ceremony is TAKEN by the attempt that finishes it, good or bad: a challenge
 * answers once.
 */
export class Ceremonies {
  private readonly pending = new Map<string, Ceremony>();

  begin(kind: CeremonyKind, rp: { rpId: string; origin: string }, context: Record<string, string> = {}, now = Date.now()): Ceremony {
    this.prune(now);
    while (this.pending.size >= CEREMONIES_MAX) this.pending.delete(this.pending.keys().next().value!);
    const ceremony: Ceremony = {
      id: randomBytes(12).toString('hex'),
      kind,
      challenge: randomBytes(32).toString('base64url'),
      rpId: rp.rpId,
      origin: rp.origin,
      expiresAt: now + OWNER_CHALLENGE_MS,
      context,
    };
    this.pending.set(ceremony.id, ceremony);
    return ceremony;
  }

  /** The ceremony, removed — or a refusal naming why: unknown (or used), stale, or of the other kind. */
  take(id: unknown, kind: CeremonyKind, now = Date.now()): Ceremony | PasskeyError {
    const ceremony = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!ceremony) return new PasskeyError('challenge', 'no such ceremony — it was used already, or this console restarted; start again');
    this.pending.delete(ceremony.id);
    if (ceremony.kind !== kind) return new PasskeyError('challenge', 'that ceremony was begun for something else');
    if (now > ceremony.expiresAt) return new PasskeyError('challenge', 'the challenge is stale — it was good for five minutes; start again');
    return ceremony;
  }

  /** How many wait — a test reads it; nothing else needs to. */
  size(): number {
    return this.pending.size;
  }

  private prune(now: number): void {
    for (const [id, ceremony] of this.pending) if (now > ceremony.expiresAt) this.pending.delete(id);
  }
}
