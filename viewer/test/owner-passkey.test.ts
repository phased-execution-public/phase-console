/**
 * PK-1..9 (control-tower phase 148, #208) — the owner key is a passkey,
 * verified by hand with `node:crypto`, and its registry holds public halves only.
 *
 * PK-1  A recorded registration and assertion verify, for both algorithms the
 *       console accepts — ES256 (EC2 P-256) and EdDSA (Ed25519) — with
 *       attestation `none` and user verification.
 * PK-2  A challenge is single-use and good for five minutes: a stale one, a
 *       used one and another ceremony's are refused.
 * PK-3  The origin and the relying-party id are the request's own host:
 *       `localhost` or an https host the console serves; another origin,
 *       another relying party and an IP origin (with the localhost hint) are refused.
 * PK-4  User verification is REQUIRED (and presence): a bare touch is refused.
 * PK-5  The signature counter never goes back.
 * PK-6  A tampered signature, a manufacturer's attestation, another algorithm
 *       and malformed CBOR are refused.
 * PK-7  The FIRST key is accepted only from a loopback request at the
 *       machine, through `phase-console owner enroll`'s one-time link (ten minutes).
 * PK-8  A later key, and a removal, only inside an owner session, with a fresh touch.
 * PK-9  Every change is journalled, announced on every subscribed device and
 *       in the bell — and the registry (0600) holds public halves only.
 * EC8   No secret is stored: the registry, the session store, the request
 *       store and the journal hold no private key, cookie value or challenge.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR } from '../server/config.ts';
import { log } from '../server/log.ts';
import { ownerDoorMode } from '../server/owner/door.ts';
import {
  Ceremonies, PasskeyError, decodeCbor, relyingPartyOf, verifyAssertion, verifyRegistration, type Expected,
} from '../server/owner/passkey.ts';
import { OWNER_CHALLENGE_MS, OWNER_LINK_MS } from '../shared/door-model.js';
import { SoftAuthenticator, cbor } from './webauthn-authenticator.ts';
import { Browser, ORIGIN, PORT, call, enrol, enrolFirst, enrolLink, freshOwnerState, newService, signIn } from './owner-harness.ts';

/** Recorded once with a software authenticator (`webauthn-authenticator.ts`) at http://localhost:4130 — public halves only. */
const RECORDED = {
  ES256: {
    credentialId: '-BfbMIh8TGZXkH012C1gKtBy65UcLB1Q_FvsbaPqJVE',
    create: {
      challenge: 'rec-ES256-create-AAAAAAAAAAAAAAAAAAAAAAAAAA',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoicmVjLUVTMjU2LWNyZWF0ZS1BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDEzMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVikSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAAAAAAAAAAAAAAAAAAAAAAAAIPgX2zCIfExmV5B9NdgtYCrQcuuVHCwdUPxb7G2j6iVRpQECAyYgASFYIO01fYXkjiZaN7ceVdkTQAdKSH70eeyCgfB1mbzl_OZwIlggqokPJM3b_Q8xE4nsnTbCcc1ra1JDFH2jNutEjPyjy9k',
    },
    get: {
      challenge: 'rec-ES256-get-BBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoicmVjLUVTMjU2LWdldC1CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDEzMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAABw',
      signature: 'MEYCIQCtMG50J_8TmNDvAJ1mQk-HAMG-tOqtH6tCyLypaf54EAIhAP3VnA1YjZWA1BT61uxJpKI_KwX4K0g-TmCgXHwv5ILd',
    },
  },
  EdDSA: {
    credentialId: 'McMsxfptzx2MXVFW9N2VTEQ8xY7nkRYfNWbuhm0OHDc',
    create: {
      challenge: 'rec-EdDSA-create-AAAAAAAAAAAAAAAAAAAAAAAAAA',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoicmVjLUVkRFNBLWNyZWF0ZS1BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDEzMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YViBSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDHDLMX6bc8djF1RVvTdlUxEPMWO55EWHzVm7oZtDhw3pAEBAycgBiFYIO97RNxv_Gj0IkzeJEJ6kVmorsoIWQoPBX3xgWUc5V12',
    },
    get: {
      challenge: 'rec-EdDSA-get-BBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoicmVjLUVkRFNBLWdldC1CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQiIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDEzMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAA',
      signature: '_B_f_HAq0QHXZVxQEDVtPkmlwegBcAZqBy7AN1zuHVHAsWd1jpVZBcqS_82Gxls2ETLh4YTHB_wlgpcCqUaZCg',
    },
  },
} as const;

type Alg = keyof typeof RECORDED;
const LOCAL = { origin: 'http://localhost:4130', rpId: 'localhost' };
const ALGS: Alg[] = ['ES256', 'EdDSA'];

function fault(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PasskeyError) return error.fault;
    throw error;
  }
  return 'none';
}

const registration = (alg: Alg) => {
  const v = RECORDED[alg];
  return { id: v.credentialId, rawId: v.credentialId, type: 'public-key', response: { clientDataJSON: v.create.clientDataJSON, attestationObject: v.create.attestationObject } };
};

const keyOf = (alg: Alg, counter = 0) => {
  const r = verifyRegistration(registration(alg), { challenge: RECORDED[alg].create.challenge, ...LOCAL });
  return { id: r.credentialId, publicKey: r.publicKey, alg: r.alg, counter };
};

const assertion = (alg: Alg, edit: Partial<{ signature: string; authenticatorData: string }> = {}) => {
  const v = RECORDED[alg];
  return {
    id: v.credentialId, rawId: v.credentialId, type: 'public-key',
    response: { clientDataJSON: v.get.clientDataJSON, authenticatorData: edit.authenticatorData ?? v.get.authenticatorData, signature: edit.signature ?? v.get.signature, userHandle: '' },
  };
};

const getExpected = (alg: Alg) => ({ challenge: RECORDED[alg].get.challenge, ...LOCAL });

/* ------------------------------------------------------------------ *
 * PK-1 — the recorded vectors, both algorithms
 * ------------------------------------------------------------------ */

test('PK-1: a recorded registration and assertion verify — ES256 and EdDSA, attestation none, the person verified', () => {
  for (const alg of ALGS) {
    const registered = verifyRegistration(registration(alg), { challenge: RECORDED[alg].create.challenge, ...LOCAL });
    assert.equal(registered.alg, alg);
    assert.equal(registered.credentialId, RECORDED[alg].credentialId);
    assert.match(registered.publicKey, /^[A-Za-z0-9_-]+$/, 'a public key, SPKI DER as base64url');
    assert.deepEqual(verifyAssertion(assertion(alg), keyOf(alg), getExpected(alg)), { signCount: alg === 'ES256' ? 7 : 0 });
  }
});

test('PK-1: a fresh authenticator of each algorithm registers and signs in — the same checks, end to end', () => {
  for (const alg of ALGS) {
    const authenticator = new SoftAuthenticator(alg);
    const create: Expected = { challenge: 'Y2hhbGxlbmdlLWNyZWF0ZQ', ...LOCAL };
    const registered = verifyRegistration(authenticator.register(create), create);
    const key = { id: registered.credentialId, publicKey: registered.publicKey, alg: registered.alg, counter: registered.signCount };
    const get: Expected = { challenge: 'Y2hhbGxlbmdlLWdldA', ...LOCAL };
    assert.deepEqual(verifyAssertion(authenticator.assert({ ...get, signCount: 3 }), key, get), { signCount: 3 });
  }
});

/* ------------------------------------------------------------------ *
 * PK-2 — a challenge good once, for five minutes
 * ------------------------------------------------------------------ */

test('PK-2: a stale challenge, a used one and another ceremony\'s are refused', () => {
  for (const alg of ALGS) {
    assert.equal(fault(() => verifyRegistration(registration(alg), { challenge: RECORDED[alg].get.challenge, ...LOCAL })), 'challenge',
      `${alg}: a challenge this console did not issue for this ceremony`);
  }
  const ceremonies = new Ceremonies();
  const t0 = Date.parse('2026-10-07T10:00:00Z');
  const stale = ceremonies.begin('create', LOCAL, {}, t0);
  const taken = ceremonies.take(stale.id, 'create', t0 + OWNER_CHALLENGE_MS + 1);
  assert.ok(taken instanceof PasskeyError && taken.fault === 'challenge' && /stale/.test(taken.message), 'five minutes and a millisecond is stale');
  const once = ceremonies.begin('get', LOCAL, {}, t0);
  assert.ok(!(ceremonies.take(once.id, 'get', t0 + 1000) instanceof PasskeyError), 'inside five minutes it answers');
  assert.ok(ceremonies.take(once.id, 'get', t0 + 2000) instanceof PasskeyError, 'and only once');
  const other = ceremonies.begin('get', LOCAL, {}, t0);
  assert.ok(ceremonies.take(other.id, 'create', t0) instanceof PasskeyError, 'a sign-in\'s challenge enrols nothing');
  assert.ok(ceremonies.take('nonsense', 'get', t0) instanceof PasskeyError);
  const a = ceremonies.begin('get', LOCAL, {}, t0);
  const b = ceremonies.begin('get', LOCAL, {}, t0);
  assert.notEqual(a.challenge, b.challenge);
  assert.equal(Buffer.from(a.challenge, 'base64url').length, 32, 'a 256-bit challenge');
});

/* ------------------------------------------------------------------ *
 * PK-3 — origin and relying party, from the request's own host
 * ------------------------------------------------------------------ */

test('PK-3: another origin and another relying party are refused; an IP origin is told to open localhost', () => {
  for (const alg of ALGS) {
    const challenge = RECORDED[alg].create.challenge;
    assert.equal(fault(() => verifyRegistration(registration(alg), { challenge, origin: 'http://localhost:4123', rpId: 'localhost' })), 'origin',
      'another console\'s port is another origin');
    assert.equal(fault(() => verifyRegistration(registration(alg), { challenge, origin: 'http://localhost:4130', rpId: 'example.com' })), 'rp-id');
    const key = keyOf(alg);
    assert.equal(fault(() => verifyAssertion(assertion(alg), key, { ...getExpected(alg), origin: 'https://evil.example' })), 'origin');
    assert.equal(fault(() => verifyAssertion(assertion(alg), key, { ...getExpected(alg), rpId: 'evil.example' })), 'rp-id');
  }
  // A credential a page at another origin made, sent here.
  const authenticator = new SoftAuthenticator('EdDSA');
  const expected: Expected = { challenge: 'b3RoZXItb3JpZ2lu', ...LOCAL };
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, origin: 'https://phish.example' }), expected)), 'origin');
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, rpId: 'phish.example' }), expected)), 'rp-id');
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, crossOrigin: true }), expected)), 'origin', 'a cross-origin frame');
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, type: 'webauthn.get' }), expected)), 'type');

  assert.deepEqual(relyingPartyOf('localhost:4130'), { ok: true, rpId: 'localhost', origin: 'http://localhost:4130', secure: false });
  assert.deepEqual(relyingPartyOf('Mac.Tailnet.ts.net', ['mac.tailnet.ts.net']),
    { ok: true, rpId: 'mac.tailnet.ts.net', origin: 'https://mac.tailnet.ts.net', secure: true });
  for (const ip of ['127.0.0.1:4130', '192.168.1.20:4130', '[::1]:4130']) {
    const rp = relyingPartyOf(ip);
    assert.equal(rp.ok, false, ip);
    if (!rp.ok) assert.match(rp.reason, /open this console at http:\/\/localhost:4130/, `${ip}: the hint names localhost`);
  }
  assert.equal(relyingPartyOf('evil.example').ok, false, 'a host this console does not serve');
});

/* ------------------------------------------------------------------ *
 * PK-4..6 — the person verified, the counter, the signature, the rest
 * ------------------------------------------------------------------ */

test('PK-4: user verification is required — a bare touch, or no presence at all, is refused', () => {
  for (const alg of ALGS) {
    const authenticator = new SoftAuthenticator(alg);
    const expected: Expected = { challenge: 'bm8tdXY', ...LOCAL };
    assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, uv: false }), expected)), 'user-verification');
    assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, up: false }), expected)), 'user-presence');
    const registered = verifyRegistration(authenticator.register(expected), expected);
    const key = { id: registered.credentialId, publicKey: registered.publicKey, alg: registered.alg, counter: 0 };
    let error: PasskeyError | null = null;
    try { verifyAssertion(authenticator.assert({ ...expected, uv: false }), key, expected); } catch (e) { error = e as PasskeyError; }
    assert.equal(error?.fault, 'user-verification');
    assert.match(String(error?.message), /PIN, a fingerprint or a face/);
  }
});

test('PK-5: the signature counter never goes back; a synced key that keeps none reads 0 for ever', () => {
  assert.deepEqual(verifyAssertion(assertion('ES256'), keyOf('ES256', 6), getExpected('ES256')), { signCount: 7 }, 'forward is fine');
  assert.equal(fault(() => verifyAssertion(assertion('ES256'), keyOf('ES256', 7), getExpected('ES256'))), 'counter', 'the same count again is a replay');
  assert.equal(fault(() => verifyAssertion(assertion('ES256'), keyOf('ES256', 9), getExpected('ES256'))), 'counter', 'a count that went back is a clone');
  assert.deepEqual(verifyAssertion(assertion('EdDSA'), keyOf('EdDSA', 0), getExpected('EdDSA')), { signCount: 0 },
    'zero after zero: an authenticator that keeps no counter');
});

test('PK-6: a tampered signature, another attestation, another algorithm and bad CBOR are refused', () => {
  for (const alg of ALGS) {
    const key = keyOf(alg);
    const signature = Buffer.from(RECORDED[alg].get.signature, 'base64url');
    signature[signature.length - 3]! ^= 0x01;
    assert.equal(fault(() => verifyAssertion(assertion(alg, { signature: signature.toString('base64url') }), key, getExpected(alg))), 'signature');
    // The signed bytes moved (the UV bit taken out by hand): the old signature no longer covers them.
    const data = Buffer.from(RECORDED[alg].get.authenticatorData, 'base64url');
    data[32]! &= ~0x04;
    assert.equal(fault(() => verifyAssertion(assertion(alg, { authenticatorData: data.toString('base64url') }), key, getExpected(alg))), 'user-verification');
    data[32]! |= 0x04;
    data[36]! ^= 0x01;
    assert.equal(fault(() => verifyAssertion(assertion(alg, { authenticatorData: data.toString('base64url') }), keyOf(alg, 0), getExpected(alg))), 'signature',
      'a counter edited by hand is a signature that no longer covers it');
    assert.equal(fault(() => verifyAssertion({ ...assertion(alg), id: 'c29tZW9uZS1lbHNl', rawId: 'c29tZW9uZS1lbHNl' }, key, getExpected(alg))), 'credential', 'another key\'s');
  }
  const authenticator = new SoftAuthenticator('ES256');
  const expected: Expected = { challenge: 'YXR0ZXN0YXRpb24', ...LOCAL };
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, fmt: 'packed', attStmt: new Map([['alg', -7]]) }), expected)), 'attestation');
  assert.equal(fault(() => verifyRegistration(authenticator.register({ ...expected, attStmt: new Map([['x5c', []]]) }), expected)), 'attestation',
    'none carries an empty statement');
  // An RS256 (-257) key is not one of the two.
  const rsa = new Map<number, unknown>([[1, 3], [3, -257], [-1, Buffer.alloc(256, 1)], [-2, Buffer.from([1, 0, 1])]]);
  const authData = Buffer.concat([
    createHash('sha256').update('localhost').digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, 16]), Buffer.alloc(16, 7), cbor(rsa),
  ]);
  const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url');
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: expected.challenge, origin: LOCAL.origin })).toString('base64url');
  assert.equal(fault(() => verifyRegistration({ id: Buffer.alloc(16, 7).toString('base64url'), type: 'public-key', response: { clientDataJSON, attestationObject } }, expected)),
    'algorithm');
  // CBOR this reader does not take: an indefinite length, a float, bytes after the item, a short item.
  for (const bad of [Buffer.from([0x9f, 0xff]), Buffer.from([0xfb, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0x01, 0x02]), Buffer.from([0x58, 0x10, 0x00])]) {
    assert.equal(fault(() => decodeCbor(bad)), 'cbor', bad.toString('hex'));
  }
  assert.equal(fault(() => verifyRegistration({ type: 'public-key', response: {} }, expected)), 'shape', 'no id');
});

/* ------------------------------------------------------------------ *
 * PK-7..9 — the enrolment rules, through the router
 * ------------------------------------------------------------------ */

test('PK-7: the first key only at the machine, through `owner enroll`\'s one-time link', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    assert.equal(ownerDoorMode(), 'unenrolled');
    // A phone the proxy vouched for is not the machine.
    const remote = await call(service, 'POST', '/api/owner/enroll/link', { host: 'mac.tailnet.ts.net', headers: { 'tailscale-user-login': 'me@example.com' } });
    assert.notEqual(remote.status, 200, 'not through the --remote door');
    const browser = new Browser(service);
    const authenticator = new SoftAuthenticator('ES256');
    // No link, no first key — a browser at localhost is not enough.
    const bare = await enrol(browser, authenticator);
    assert.equal(bare.status, 403);
    assert.match(String(bare.answer.error), /owner enroll/);
    const token = await enrolLink(service);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    // The link at an IP origin: a passkey needs a name.
    const atIp = await call(service, 'POST', '/api/owner/enroll/begin', { host: `127.0.0.1:${PORT}`, body: { token } });
    assert.equal(atIp.status, 400);
    assert.match(String(atIp.answer.error), /localhost/);
    const first = await enrol(browser, authenticator, { token, label: 'MacBook Touch ID' });
    assert.equal(first.status, 201, JSON.stringify(first.answer));
    assert.equal((first.answer.key as { label: string }).label, 'MacBook Touch ID');
    assert.equal(ownerDoorMode(), 'enrolled', 'one key turns the table\'s enrolled mode on');
    assert.ok(browser.cookie, 'the browser that enrolled it is the owner\'s now');
    // The link worked once.
    const again = await enrol(new Browser(service), new SoftAuthenticator('EdDSA'), { token });
    assert.notEqual(again.status, 201, 'a used link enrols nothing');
    // And the CLI on an enrolled console is told where a later key comes from.
    const later = await call(service, 'POST', '/api/owner/enroll/link', { host: `127.0.0.1:${PORT}` });
    assert.equal(later.status, 409);
    assert.match(String(later.answer.error), /signed in as the owner/);
    assert.equal(state.registry.count(), 1);
  } finally {
    service.close();
  }
});

test('PK-7: the first key closes the machine\'s door — a second first-key link left standing enrols nothing', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const first = await enrolLink(service);
    const spare = await enrolLink(service);
    assert.equal((await enrol(new Browser(service), new SoftAuthenticator('ES256'), { token: first })).status, 201);
    const late = await enrol(new Browser(service), new SoftAuthenticator('EdDSA'), { token: spare });
    assert.equal(late.status, 401, 'with a key, a later one is the owner\'s to enrol');
    assert.equal(state.registry.count(), 1);
  } finally {
    service.close();
  }
});

test('PK-7: a link is good for ten minutes', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const token = await enrolLink(service);
    for (const link of state.links.values()) link.expiresAt = Date.now() - 1;
    const late = await enrol(new Browser(service), new SoftAuthenticator('EdDSA'), { token });
    assert.equal(late.status, 403);
    assert.equal(OWNER_LINK_MS, 10 * 60_000);
  } finally {
    service.close();
  }
});

/** Age every owner session's last touch by `ms` — a fresh window that has run out. */
function ageTouches(file: string, ms: number): void {
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { sessions: { assertedAt: string }[] };
  for (const row of rows.sessions) row.assertedAt = new Date(Date.parse(row.assertedAt) - ms).toISOString();
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
}

test('PK-8: a later key and a removal only inside an owner session, with a fresh touch', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const owner = new Browser(service);
    const mac = new SoftAuthenticator('ES256');
    await enrolFirst(service, owner, mac);
    // Another browser, no session: refused.
    const stranger = await enrol(new Browser(service), new SoftAuthenticator('EdDSA'));
    assert.equal(stranger.status, 401);
    // The owner's browser, its touch gone stale: asked to touch the key again.
    ageTouches(state.sessions.file, 6 * 60_000);
    const stale = await enrol(owner, new SoftAuthenticator('EdDSA'));
    assert.equal(stale.status, 401);
    assert.equal(stale.answer.reassert, true);
    // Touch it, and the second key enrols.
    assert.equal((await signIn(owner, mac, 1)).status, 200);
    const yubikey = new SoftAuthenticator('EdDSA');
    const second = await enrol(owner, yubikey, { label: 'YubiKey' });
    assert.equal(second.status, 201, JSON.stringify(second.answer));
    assert.equal(state.registry.count(), 2);
    // A removal from a stranger is refused; from the owner, fresh, it lands and ends that key's sessions.
    const other = new Browser(service);
    assert.equal((await signIn(other, yubikey, 0)).status, 200, 'the YubiKey signs a second browser in');
    assert.equal((await new Browser(service).call('DELETE', `/api/owner/keys/${yubikey.id}`)).status, 401);
    const removed = await owner.call('DELETE', `/api/owner/keys/${yubikey.id}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.answer));
    assert.equal(state.registry.count(), 1);
    assert.equal((await other.call('GET', '/api/owner')).answer.state, 'enrolled', 'the removed key\'s session ended with it');
    assert.equal((await owner.call('GET', '/api/owner')).answer.state, 'unlocked');
  } finally {
    service.close();
  }
});

test('PK-9: every change is journalled, announced and in the bell — and the registry is 0600, public halves only', async () => {
  const state = freshOwnerState();
  const service = newService();
  const lines: { name: string; data: Record<string, unknown> }[] = [];
  const announced: { category: string; title: string }[] = [];
  const info = log.info;
  log.info = ((name: string, data: Record<string, unknown>) => { lines.push({ name, data }); return info.call(log, name as never, data as never); }) as typeof log.info;
  (service as unknown as { announce: (category: string, message: { title: string }) => void }).announce = (category, message) => {
    announced.push({ category, title: message.title });
  };
  try {
    const owner = new Browser(service);
    await enrolFirst(service, owner, new SoftAuthenticator('EdDSA'), 'MacBook');
    const phone = new SoftAuthenticator('ES256');
    assert.equal((await enrol(owner, phone, { label: 'Phone' })).status, 201);
    assert.equal((await owner.call('DELETE', `/api/owner/keys/${phone.id}`)).status, 200);
    assert.deepEqual(lines.filter((l) => l.name.startsWith('policy.owner-key')).map((l) => [l.name, l.data.label]), [
      ['policy.owner-key-enrolled', 'MacBook'], ['policy.owner-key-enrolled', 'Phone'], ['policy.owner-key-removed', 'Phone'],
    ]);
    assert.deepEqual(announced.map((a) => a.category), ['health', 'health', 'health'], 'on every subscribed device');
    assert.match(announced[0]!.title, /An owner key was enrolled — MacBook/);
    const bell = (await service.attention(true)).items.filter((item) => item.kind === 'health' && /owner key/.test(item.title));
    assert.equal(bell.length, 3, 'and in the bell');
    // The registry: 0600, public halves only.
    const file = join(state.dir, 'owner-doors.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const row = JSON.parse(readFileSync(file, 'utf8')).keys[0];
    assert.deepEqual(Object.keys(row).sort(), ['alg', 'backedUp', 'counter', 'createdAt', 'id', 'label', 'lastUsedAt', 'origin', 'publicKey', 'rpId']);
    assert.equal(row.origin, ORIGIN);
  } finally {
    log.info = info;
    service.close();
  }
});

test('EC8: no secret is stored — no private key, cookie value, challenge or link token in any owner file or the journal', async () => {
  const state = freshOwnerState();
  const service = newService();
  const journal: string[] = [];
  const info = log.info;
  log.info = ((name: string, data: unknown) => { journal.push(JSON.stringify([name, data])); return info.call(log, name as never, data as never); }) as typeof log.info;
  try {
    const owner = new Browser(service);
    const mac = new SoftAuthenticator('ES256');
    const token = await enrolLink(service);
    const begun = await owner.call('POST', '/api/owner/enroll/begin', { token, label: 'MacBook' });
    const challenge = String((begun.answer.publicKey as { challenge: string }).challenge);
    const finished = await owner.call('POST', '/api/owner/enroll/finish', {
      ceremony: begun.answer.ceremony, label: 'MacBook', credential: mac.register({ challenge, origin: ORIGIN, rpId: 'localhost' }),
    });
    assert.equal(finished.status, 201);
    const cookieValue = owner.cookie!.slice(owner.cookie!.indexOf('=') + 1);
    const secret = cookieValue.split('.')[1]!;
    assert.equal(Buffer.from(secret, 'base64url').length, 32, 'a 256-bit cookie secret');
    // A request, recorded — its store is scanned too.
    assert.equal((await call(service, 'POST', '/api/policy', { body: { add: { deny: ['Bash(shred:*)'] } } })).status, 202);
    const d = (mac.privateKey.export({ format: 'jwk' }) as { d: string }).d;
    const pkcs8 = mac.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const files = ['owner-doors.json', 'owner-sessions.json', 'owner-requests.json'].map((name) => readFileSync(join(state.dir, name), 'utf8'));
    let consoleLog = '';
    try { consoleLog = readFileSync(join(INSTANCE_STATE_DIR, 'console.log'), 'utf8'); } catch { consoleLog = ''; }
    const haystacks = [...files, journal.join('\n'), consoleLog];
    const needles: [string, string][] = [
      ['the private key', d], ['the private key (PKCS#8)', pkcs8.slice(10, 60)], ['the cookie value', cookieValue],
      ['the cookie secret', secret], ['the challenge', challenge], ['the link token', token],
    ];
    for (const [what, needle] of needles) {
      for (const [i, hay] of haystacks.entries()) assert.ok(!hay.includes(needle), `${what} is in haystack ${i}`);
    }
    assert.ok(files[1]!.includes('"hash"'), 'the session store keeps a hash');
  } finally {
    log.info = info;
    service.close();
  }
});
