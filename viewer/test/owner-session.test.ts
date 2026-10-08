/**
 * OS-1..4 (control-tower phase 148, #208) — the owner session: what one
 * passkey assertion buys a browser.
 *
 * OS-1  A 256-bit cookie value — `HttpOnly`, `SameSite=Strict`, `__Host-` and
 *       `Secure` on an https origin — of which only the hash is kept.
 * OS-2  Twelve hours idle ends it; a press keeps it alive.
 * OS-3  `lock` ends it — this browser's, or every one from the machine.
 * OS-4  A HIGH-risk press needs the key touched inside the last five minutes;
 *       a medium one does not.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

import { OWNER_FRESH_MS, OWNER_SESSION_IDLE_MS } from '../shared/door-model.js';
import { OwnerSessions, readCookie } from '../server/owner/session.ts';
import { SoftAuthenticator } from './webauthn-authenticator.ts';
import { Browser, PORT, REMOTE_HOST, call, enrol, enrolFirst, freshOwnerState, newService, signIn } from './owner-harness.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function ageTouches(file: string, ms: number): void {
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { sessions: { assertedAt: string }[] };
  for (const row of rows.sessions) row.assertedAt = new Date(Date.parse(row.assertedAt) - ms).toISOString();
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
}

test('OS-1: the cookie — 256 bits, HttpOnly, SameSite=Strict; __Host- and Secure on https; only its hash is kept', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const owner = new Browser(service);
    const first = await enrolFirst(service, owner, new SoftAuthenticator('ES256'));
    const line = first.cookies[0]!;
    assert.match(line, new RegExp(`^pc-owner-${PORT}=[0-9a-f]{16}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200$`), line);
    const value = owner.cookie!.slice(owner.cookie!.indexOf('=') + 1);
    const [id, secret] = value.split('.');
    assert.equal(Buffer.from(secret!, 'base64url').length, 32, 'a 256-bit secret');
    const stored = readFileSync(state.sessions.file, 'utf8');
    assert.ok(!stored.includes(secret!), 'the secret is not kept');
    assert.ok(stored.includes(sha256(secret!)), 'its sha256 is');
    assert.equal(statSync(state.sessions.file).mode & 0o777, 0o600);
    assert.equal(state.sessions.verify(`${id}.${secret}`)?.id, id);
    assert.equal(state.sessions.verify(`${id}.${'A'.repeat(43)}`), null, 'a wrong secret');
    assert.equal(state.sessions.verify(`ffffffffffffffff.${secret}`), null, 'an unknown id takes the same path');
    // On the console's https host (`--remote`): `__Host-` and Secure — enrolled from a link the owner minted.
    const minted = await owner.call('POST', '/api/owner/enroll/link');
    assert.equal(minted.status, 200, JSON.stringify(minted.answer));
    // The link opens Settings ▸ Permissions ▸ Owner keys, where the ceremony is (phase 138).
    assert.match(String(minted.answer.link), /\/#\/settings\/permissions\?enrol=[\w-]+$/);
    const token = new URL(String(minted.answer.link).replace('#', '')).searchParams.get('enrol')!;
    const phone = new Browser(service, REMOTE_HOST);
    const second = await enrol(phone, new SoftAuthenticator('EdDSA'), { token, label: 'Phone', origin: `https://${REMOTE_HOST}`, rpId: REMOTE_HOST });
    assert.equal(second.status, 201, JSON.stringify(second.answer));
    assert.match(second.cookies[0]!, new RegExp(`^__Host-pc-owner-${PORT}=.+; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$`));
    assert.equal(readCookie(`a=b; __Host-pc-owner-${PORT}=x.y; c=d`, `__Host-pc-owner-${PORT}`), 'x.y');
  } finally {
    service.close();
  }
});

test('OS-2: twelve hours with no press ends a session; a press keeps it alive', () => {
  const state = freshOwnerState();
  const t0 = Date.parse('2026-10-07T08:00:00Z');
  const { cookieValue, session } = state.sessions.start({ id: 'key-1', label: 'MacBook' }, 'http://localhost:4130', t0);
  assert.equal(session.idleEndsAt, new Date(t0 + OWNER_SESSION_IDLE_MS).toISOString());
  assert.equal(OWNER_SESSION_IDLE_MS, 12 * 60 * 60_000);
  assert.ok(state.sessions.verify(cookieValue, t0 + OWNER_SESSION_IDLE_MS - 1), 'just inside twelve hours');
  // That press moved lastSeenAt — twelve more hours from it.
  assert.ok(state.sessions.verify(cookieValue, t0 + 2 * OWNER_SESSION_IDLE_MS - 10), 'a press keeps it alive');
  assert.equal(state.sessions.verify(cookieValue, t0 + 3 * OWNER_SESSION_IDLE_MS), null, 'twelve idle hours end it');
  assert.equal(state.sessions.live(t0 + 3 * OWNER_SESSION_IDLE_MS).length, 0);
});

test('OS-3: lock ends this browser\'s session; `owner lock` at the machine ends every one', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const owner = new Browser(service);
    const mac = new SoftAuthenticator('EdDSA');
    await enrolFirst(service, owner, mac);
    const second = new Browser(service);
    assert.equal((await signIn(second, mac, 0)).status, 200);
    assert.equal(state.sessions.live().length, 2);
    const locked = await owner.call('POST', '/api/owner/lock');
    assert.equal(locked.answer.ended, 1);
    assert.equal(owner.cookie, null, 'the cookie is cleared');
    assert.equal(state.sessions.live().length, 1, 'only this browser\'s');
    // A phone the proxy vouched for, with no owner session: it may not end the owner's.
    (service.flags as { remoteUsers: string[] }).remoteUsers = ['me@example.com'];
    const remote = await call(service, 'POST', '/api/owner/lock', { host: REMOTE_HOST, headers: { 'tailscale-user-login': 'me@example.com' }, body: { all: true } });
    assert.equal(remote.status, 403, JSON.stringify(remote.answer));
    assert.equal(state.sessions.live().length, 1, 'nothing ended');
    // The CLI at the machine: no cookie, every session.
    const cli = await call(service, 'POST', '/api/owner/lock', { host: `127.0.0.1:${PORT}`, body: { all: true } });
    assert.equal(cli.status, 200);
    assert.equal(cli.answer.ended, 1);
    assert.equal((await second.call('GET', '/api/owner')).answer.state, 'enrolled', 'that browser is no longer the owner');
  } finally {
    service.close();
  }
});

test('OS-4: a HIGH-risk press needs a touch inside five minutes; a medium one does not', async () => {
  const state = freshOwnerState();
  const service = newService();
  try {
    const owner = new Browser(service);
    const mac = new SoftAuthenticator('ES256');
    await enrolFirst(service, owner, mac);
    assert.equal(OWNER_FRESH_MS, 5 * 60_000);
    ageTouches(state.sessions.file, OWNER_FRESH_MS + 1000);
    assert.equal(OwnerSessions.fresh(state.sessions.live()[0]!), false);
    // A raise of a run's permission profile is high: refused until the key is touched again.
    const stale = await owner.call('POST', '/api/run/demo/settings', { permissionProfile: 'bypass' });
    assert.equal(stale.status, 401, JSON.stringify(stale.answer));
    assert.equal(stale.answer.reassert, true);
    // A medium press — an edit of the policy — goes through on the session alone.
    const medium = await owner.call('POST', '/api/policy', { add: { deny: ['Bash(shred:*)'] } });
    assert.ok(medium.status !== 401 && medium.status !== 202, `${medium.status} ${JSON.stringify(medium.answer)}`);
    // The touch: the same browser, the same session, a fresh window.
    const touched = await signIn(owner, mac, 1);
    assert.equal(touched.status, 200);
    assert.equal(touched.answer.fresh, true);
    assert.equal(state.sessions.live().length, 1, 'a touch inside a session starts no second one');
    const fresh = await owner.call('POST', '/api/run/demo/settings', { permissionProfile: 'bypass' });
    assert.ok(fresh.status !== 401 && fresh.status !== 202, `past the door now: ${fresh.status} ${JSON.stringify(fresh.answer)}`);
  } finally {
    service.close();
  }
});
