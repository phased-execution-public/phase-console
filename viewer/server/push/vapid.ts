/**
 * VAPID — proving to a push service who is sending.
 *
 * A push service will not forward a message from an anonymous sender. RFC 8292
 * settles that with a keypair the application server keeps: the browser is
 * given the public half when it subscribes, and every message carries a JWT
 * signed by the private half. The push service checks the two agree.
 *
 * The keypair is generated once and kept. Regenerating it silently invalidates
 * every existing subscription — the browser would keep sending to an endpoint
 * bound to a key we no longer hold, and nothing would arrive — so the file is
 * written once and only ever read afterwards.
 *
 * Which is why "I could not read it" is NOT "there is none". Only ENOENT mints
 * a key. A truncated file (a power cut mid-write), a permission problem, a
 * JWK the crypto layer will not take — every one of those leaves the file
 * exactly where it is and turns push OFF, loudly, on the environment card.
 * The console runs fine without push; it does not run fine after silently
 * unsubscribing the operator's phone.
 *
 * `node:crypto` covers all of this. `dsaEncoding: 'ieee-p1363'` is the part
 * that matters: ES256 wants the raw r‖s pair, and Node's default for EC keys is
 * DER, which a push service rejects as malformed.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR } from '../config.ts';
import { log } from '../log.ts';

export type Vapid = {
  /** The uncompressed P-256 point, base64url — what a browser wants as `applicationServerKey`. */
  publicKey: string;
  privateKey: KeyObject;
  /** The `sub` claim: who to contact about this sender. */
  subject: string;
};

/**
 * Per instance, deliberately: each console mints its own VAPID pair on the
 * first subscribe, and a browser's subscription is bound to the key that
 * created it. Sharing one pair across instances would let any console deliver
 * to any other's devices — and the default instance keeping the legacy path is
 * what stops an upgrade from invalidating the subscriptions an operator's
 * phone already holds.
 */
const PUSH_DIR = join(INSTANCE_STATE_DIR, 'push');
const KEY_FILE = join(PUSH_DIR, 'vapid.json');

/**
 * A push service will reject a JWT whose `sub` is not a `mailto:` or `https:`
 * URL, and some are stricter than others about it being plausible. The console
 * already knows one real address in the common case — the login allowed to
 * reach it remotely — so that is used before falling back.
 */
export function vapidSubject(remoteUsers: string[]): string {
  const email = remoteUsers.find((u) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u));
  return email ? `mailto:${email}` : 'mailto:phase-console@localhost';
}

/** Why there is no key, when there is none — one sentence, plus the errand. */
export type VapidRefusal = { error: string; fix: string };

export function loadVapid(subject: string): Vapid | VapidRefusal {
  let found = read();
  // One retry, and only for the transient half: EMFILE under fd pressure and
  // EIO are moments, and a moment must not cost an operator their
  // notifications for the life of the process.
  if (found.kind === 'unreadable') found = read();

  if (found.kind === 'unreadable') {
    // Deliberately no write, and deliberately no move-aside either: minting
    // over this file is the accident the header warns about, and moving it
    // aside to mint beside it is the same accident with a receipt. Push stays
    // off until a person decides.
    log.error('push.vapid.unreadable', { file: KEY_FILE, why: found.why });
    return {
      error: `the VAPID key file could not be read (${found.why}) — push is off`,
      // Deliberately NO "move it aside": we could not read the file, which is
      // not the same as knowing it is broken. It is probably intact, and moving
      // an intact key is exactly what unsubscribes every device.
      fix: 'The key file was left untouched. Restart the console; if it keeps failing, check for '
        + `file-descriptor or disk trouble and inspect ${KEY_FILE} — do NOT delete or move it `
        + 'unless it is genuinely corrupt, because a new key unsubscribes every device.',
    };
  }

  if (found.kind === 'damaged') {
    // Here we DID read it and the content is wrong, so naming the repair is fair.
    log.error('push.vapid.damaged', { file: KEY_FILE, why: found.why });
    return {
      error: `the VAPID key file is damaged (${found.why}) — push is off`,
      fix: 'Push stays off rather than mint a new key, which would silently unsubscribe every '
        + `device. Inspect ${KEY_FILE}; if it cannot be repaired, move it aside and re-subscribe `
        + 'each device in Settings → Notifications.',
    };
  }

  if (found.kind === 'ok') {
    try {
      return {
        publicKey: found.stored.publicKey,
        privateKey: createPrivateKey({ key: found.stored.privateKeyJwk, format: 'jwk' }),
        subject,
      };
    } catch (error) {
      // A shaped file whose JWK the crypto layer refuses. This used to throw
      // out of the Push constructor and take the whole Service down with it.
      log.error('push.vapid.unusable', { file: KEY_FILE, error: (error as Error).message });
      return {
        error: `the stored VAPID private key is not usable (${(error as Error).message}) — push is off`,
        fix: `Inspect ${KEY_FILE}; if it cannot be repaired, move it aside and re-subscribe each `
          + 'device in Settings → Notifications.',
      };
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const created = {
    publicKey: rawPublicKey(publicKey),
    privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, string>,
  };
  try {
    write(created);
  } catch (error) {
    // EEXIST is the race, not a failure: something minted a key between our
    // read and our write. Ours was never published — read theirs and use it.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      log.warn('push.vapid.raced', { file: KEY_FILE });
      const again = read();
      if (again.kind === 'ok') {
        try {
          return {
            publicKey: again.stored.publicKey,
            privateKey: createPrivateKey({ key: again.stored.privateKeyJwk, format: 'jwk' }),
            subject,
          };
        } catch { /* fall through to the refusal below */ }
      }
      return {
        error: 'another writer created the VAPID key file while this console was minting one — push is off',
        fix: `Restart the console. If it persists, inspect ${KEY_FILE}.`,
      };
    }
    // A key that cannot be persisted is worse than none: it changes every boot,
    // and each boot unsubscribes whatever the last one subscribed.
    log.error('push.vapid.write-failed', { file: KEY_FILE, error: (error as Error).message });
    return {
      error: `the VAPID key could not be written (${(error as Error).message}) — push is off`,
      fix: `Make ${PUSH_DIR} writable by this console and restart it.`,
    };
  }
  log.info('push.vapid.created', { file: KEY_FILE });
  return { publicKey: created.publicKey, privateKey, subject };
}

/** A public EC key as the uncompressed point browsers expect: `0x04 ‖ x ‖ y`. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * The Authorization header
 * ------------------------------------------------------------------ */

/**
 * One JWT per push service, reused until it is close to expiring.
 *
 * `aud` is the *origin* of the endpoint, not the endpoint, so every
 * subscription on the same service shares a token. Signing per message would be
 * a P-256 signature per notification for no benefit.
 */
const tokens = new Map<string, { header: string; expiresAt: number }>();

const TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Renew early: a token that expires in transit is a silent delivery failure. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;

export function authorization(vapid: Vapid, endpoint: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin;
  const cached = tokens.get(audience);
  if (cached && cached.expiresAt - now > RENEW_BEFORE_MS) return cached.header;

  const expiresAt = now + TOKEN_LIFETIME_MS;
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(expiresAt / 1000),
    sub: vapid.subject,
  }));
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), {
    key: vapid.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const header = `vapid t=${head}.${claims}.${signature}, k=${vapid.publicKey}`;
  tokens.set(audience, { header, expiresAt });
  return header;
}

/** Tests reach for this; nothing in the server does. */
export function resetTokenCache(): void {
  tokens.clear();
}

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

type Stored = { publicKey: string; privateKeyJwk: Record<string, string> };

/**
 * Three answers, not two. `none` is the first run and is the ONLY one that may
 * mint a key; `unreadable` is a file that is there and that we must assume
 * still holds the private half of every live subscription.
 */
type ReadResult =
  | { kind: 'none' }
  | { kind: 'ok'; stored: Stored }
  /** The file is there and its CONTENT is wrong — the power-cut case. */
  | { kind: 'damaged'; why: string }
  /**
   * The file is there and we could not read it AT ALL. Usually transient
   * (EMFILE under fd pressure, EIO), so the errand must never say "move it
   * aside": doing that to an intact key is the incident this module exists to
   * prevent.
   */
  | { kind: 'unreadable'; why: string };

function read(): ReadResult {
  let text: string;
  try {
    text = readFileSync(KEY_FILE, 'utf8');
  } catch (error) {
    // ENOENT is the only failure that means "first run". EACCES, EISDIR, EMFILE
    // and friends all mean "there is something there I could not read", and
    // minting over one of those is how every device gets unsubscribed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'unreadable', why: (error as Error).message };
  }
  let parsed: Stored;
  try {
    parsed = JSON.parse(text) as Stored;
  } catch (error) {
    // A 0-byte or half-flushed file lands here — the power-cut case.
    return { kind: 'damaged', why: `not JSON — ${(error as Error).message}` };
  }
  if (!parsed?.publicKey || !parsed?.privateKeyJwk) {
    return { kind: 'damaged', why: 'the file holds no keypair' };
  }
  return { kind: 'ok', stored: parsed };
}

/**
 * Atomically, 0600, and — unlike every other state writer here — EXCLUSIVELY.
 *
 * The rest of this server publishes state with temp + `renameSync`, which
 * OVERWRITES. Overwriting this one file is the whole incident: the private half
 * of every live subscription gone, and a log line where the outage should be.
 * `linkSync` is the same atomic publish and fails `EEXIST` instead, so a file
 * that appeared between the read and the write survives byte for byte and the
 * caller goes and reads it. There is no move-aside path here on purpose —
 * renaming the old key out of the way and minting beside it is the same
 * rotation with a receipt.
 */
function write(value: Stored): void {
  mkdirSync(PUSH_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${KEY_FILE}.${process.pid}.tmp`;
  // A private key, so nobody else's mode bits. `mode` applies on create only,
  // and a crashed predecessor could have left this path behind, so chmod too.
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  try {
    linkSync(tmp, KEY_FILE);
  } finally {
    try { unlinkSync(tmp); } catch { /* the link is what matters */ }
  }
}

export { KEY_FILE as VAPID_FILE, PUSH_DIR };
