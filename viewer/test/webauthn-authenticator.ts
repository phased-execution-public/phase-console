/**
 * A software authenticator for the owner-key tests (control-tower phase 148) —
 * what a passkey provider does, by hand: a key pair, a COSE public key, the
 * authenticator data, the `none` attestation object, the client data a browser
 * writes, and the signature over `authenticatorData ‖ sha256(clientDataJSON)`.
 *
 * It exists so the recorded vectors in `owner-passkey.test.ts` can be re-made
 * and mutated — a stale challenge, another origin, another relying party, no
 * user verification, a counter that went back, a tampered signature — from the
 * same keys. It imports nothing from `server/`.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

/** CBOR, encoded: integers, byte and text strings, arrays, maps, booleans and null. */
export function cbor(value: unknown): Buffer {
  const head = (major: number, arg: number): Buffer => {
    if (arg < 24) return Buffer.from([(major << 5) | arg]);
    if (arg < 0x100) return Buffer.from([(major << 5) | 24, arg]);
    if (arg < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(arg, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(arg, 1); return b;
  };
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') { const text = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, text.length), text]); }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new TypeError(`cbor: ${typeof value}`);
}

export type Alg = 'ES256' | 'EdDSA';

/** What a ceremony is made for — and every field a test bends. */
export type Ceremony = {
  challenge: string;
  origin: string;
  rpId: string;
  type?: string;
  up?: boolean;
  uv?: boolean;
  signCount?: number;
  fmt?: string;
  attStmt?: Map<number | string, unknown>;
  crossOrigin?: boolean;
};

export class SoftAuthenticator {
  readonly alg: Alg;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly credentialId: Buffer;

  /** A fixed private key (JWK) makes a recorded vector re-makeable; none makes a fresh one. */
  constructor(alg: Alg, fixed?: { jwk: Record<string, string>; credentialId: string }) {
    this.alg = alg;
    if (fixed) {
      this.privateKey = createPrivateKey({ key: fixed.jwk, format: 'jwk' });
      this.credentialId = Buffer.from(fixed.credentialId, 'base64url');
    } else {
      const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.credentialId = randomBytes(32);
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  coseKey(): Map<number, unknown> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string; y?: string };
    if (this.alg === 'ES256') {
      return new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
    }
    return new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]);
  }

  private authData(c: Ceremony, attested: boolean): Buffer {
    const flags = (c.up === false ? 0 : 0x01) | (c.uv === false ? 0 : 0x04) | (attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(c.signCount ?? 0, 0);
    const parts = [sha256(c.rpId), Buffer.from([flags]), counter];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length, 0);
      parts.push(Buffer.alloc(16), length, this.credentialId, cbor(this.coseKey()));
    }
    return Buffer.concat(parts);
  }

  private clientData(c: Ceremony, type: string): Buffer {
    return Buffer.from(JSON.stringify({
      type: c.type ?? type, challenge: c.challenge, origin: c.origin, ...(c.crossOrigin !== undefined ? { crossOrigin: c.crossOrigin } : { crossOrigin: false }),
    }), 'utf8');
  }

  /** `navigator.credentials.create()`'s answer, as the client sends it. */
  register(c: Ceremony): { id: string; rawId: string; type: 'public-key'; response: { clientDataJSON: string; attestationObject: string } } {
    const attestation = cbor(new Map<string, unknown>([
      ['fmt', c.fmt ?? 'none'], ['attStmt', c.attStmt ?? new Map()], ['authData', this.authData(c, true)],
    ]));
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: { clientDataJSON: this.clientData(c, 'webauthn.create').toString('base64url'), attestationObject: attestation.toString('base64url') },
    };
  }

  /** `navigator.credentials.get()`'s answer, signed. */
  assert(c: Ceremony): { id: string; rawId: string; type: 'public-key'; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string } } {
    const authData = this.authData(c, false);
    const clientData = this.clientData(c, 'webauthn.get');
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = this.alg === 'ES256'
      ? sign('sha256', signed, { key: this.privateKey, dsaEncoding: 'der' })
      : sign(null, signed, this.privateKey);
    return {
      id: this.id, rawId: this.id, type: 'public-key',
      response: {
        clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'), userHandle: '',
      },
    };
  }
}
