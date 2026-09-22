/**
 * Web push: the crypto, the delivery, and the register.
 *
 * The encryption is the part worth testing hardest, because every way of
 * getting it wrong looks identical from here — a push service accepts the
 * message, returns 201, and the browser silently discards it. There is no error
 * to observe. So the test decrypts what was produced, using an independent
 * implementation of the browser's half rather than the sender's own helpers: if
 * both sides shared a mistake, a round-trip through shared code would still
 * pass.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, randomBytes,
} from 'node:crypto';

// STATE_DIR is resolved when config.ts is first imported, so the redirect has to
// happen before anything pulls it in — otherwise this writes a VAPID key and a
// subscription register into the real state directory.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'phase-push-'));
process.env.XDG_CONFIG_HOME = join(process.env.XDG_STATE_HOME, 'config');

let push: typeof import('../server/push/index.ts');
let send: typeof import('../server/push/send.ts');
let vapidMod: typeof import('../server/push/vapid.ts');
let catalogue: typeof import('../server/push/catalogue.ts');

before(async () => {
  push = await import('../server/push/index.ts');
  send = await import('../server/push/send.ts');
  vapidMod = await import('../server/push/vapid.ts');
  catalogue = await import('../server/push/catalogue.ts');
});

/**
 * The fixture key, asserted to have loaded.
 *
 * `loadVapid` returns `Vapid | VapidRefusal` since Phase 6: a key file that
 * cannot be READ disables push rather than minting a replacement, because
 * minting is what silently unsubscribes every device. Every call in this file
 * expects the happy half, so the narrowing lives here once.
 */
function fixtureVapid() {
  const loaded = vapidMod.loadVapid('mailto:you@example.com');
  assert.ok(!('error' in loaded), `the fixture key must load: ${JSON.stringify(loaded)}`);
  return loaded;
}

/* ------------------------------------------------------------------ *
 * A browser, for the crypto to talk to
 * ------------------------------------------------------------------ */

function makeBrowser() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const p256dh = Buffer.concat([
    Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url'),
  ]);
  const auth = randomBytes(16);
  return {
    privateKey: keys.privateKey,
    p256dh,
    auth,
    subscription: {
      endpoint: 'https://push.example.com/sub/abc123',
      keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') },
    },
    /** RFC 8188 §2 in reverse, written out here rather than shared with the sender. */
    decrypt(record: Buffer): string {
      const salt = record.subarray(0, 16);
      const idLength = record[20];
      const senderPublic = record.subarray(21, 21 + idLength);
      const sealed = record.subarray(21 + idLength);

      const shared = diffieHellman({
        privateKey: keys.privateKey,
        publicKey: createPublicKey({
          key: {
            kty: 'EC', crv: 'P-256',
            x: senderPublic.subarray(1, 33).toString('base64url'),
            y: senderPublic.subarray(33, 65).toString('base64url'),
          },
          format: 'jwk',
        }),
      });
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth,
        Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, senderPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
      assert.equal(plain[plain.length - 1], 2, 'last record should be delimited with 0x02');
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Encryption
 * ------------------------------------------------------------------ */

test('a message decrypts to exactly what was sent', () => {
  const browser = makeBrowser();
  const payload = Buffer.from(JSON.stringify({ title: 'a', body: 'b' }));
  assert.equal(browser.decrypt(send.encrypt(browser.subscription, payload)), payload.toString());
});

test('the record is laid out as RFC 8188 says', () => {
  const browser = makeBrowser();
  const payload = Buffer.from('hello');
  const record = send.encrypt(browser.subscription, payload);
  assert.equal(record.subarray(16, 20).readUInt32BE(), 4096, 'record size');
  assert.equal(record[20], 65, 'key id length is a P-256 point');
  assert.equal(record[21], 4, 'the point is uncompressed');
  // salt + rs + idlen + key + (payload + delimiter + GCM tag)
  assert.equal(record.length, 16 + 4 + 1 + 65 + payload.length + 1 + 16);
});

test('the same message twice is never the same bytes twice', () => {
  const browser = makeBrowser();
  const payload = Buffer.from('same');
  const a = send.encrypt(browser.subscription, payload);
  const b = send.encrypt(browser.subscription, payload);
  assert.notEqual(a.toString('base64'), b.toString('base64'), 'the ephemeral key must be per message');
  assert.equal(browser.decrypt(a), 'same');
  assert.equal(browser.decrypt(b), 'same');
});

test('keys of the wrong size are refused rather than producing junk', () => {
  const browser = makeBrowser();
  assert.throws(() => send.encrypt(
    { ...browser.subscription, keys: { ...browser.subscription.keys, p256dh: 'AAAA' } },
    Buffer.from('x'),
  ), /65-byte point/);
  assert.throws(() => send.encrypt(
    { ...browser.subscription, keys: { ...browser.subscription.keys, auth: 'AAAA' } },
    Buffer.from('x'),
  ), /16 bytes/);
});

/* ------------------------------------------------------------------ *
 * VAPID
 * ------------------------------------------------------------------ */

test('the Authorization header is a well-formed ES256 JWT for the endpoint origin', () => {
  vapidMod.resetTokenCache();
  const vapid = fixtureVapid();
  const header = vapidMod.authorization(vapid, 'https://push.example.com/sub/abc?q=1');

  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  assert.ok(token && key, `unparseable header: ${header}`);
  assert.equal(key, vapid.publicKey);

  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString());
  // The audience is the origin, not the endpoint — a service rejects the latter.
  assert.equal(parsed.aud, 'https://push.example.com');
  assert.equal(parsed.sub, 'mailto:you@example.com');
  assert.ok(parsed.exp > Math.floor(Date.now() / 1000));
  // Raw r‖s. DER would be ~70 bytes and rejected as malformed.
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
});

test('one token per push service, reused', () => {
  vapidMod.resetTokenCache();
  const vapid = fixtureVapid();
  const a = vapidMod.authorization(vapid, 'https://push.example.com/one');
  const b = vapidMod.authorization(vapid, 'https://push.example.com/two');
  const other = vapidMod.authorization(vapid, 'https://other.example.org/one');
  assert.equal(a, b, 'same service, same token');
  assert.notEqual(a, other, 'different service, different audience');
});

test('the keypair survives a reload — regenerating would silently break every subscription', () => {
  const first = fixtureVapid();
  const second = fixtureVapid();
  assert.equal(first.publicKey, second.publicKey);
});

test('the VAPID subject prefers a real address over a placeholder', () => {
  assert.equal(vapidMod.vapidSubject(['you@example.com']), 'mailto:you@example.com');
  assert.equal(vapidMod.vapidSubject(['not-an-address']), 'mailto:phase-console@localhost');
  assert.equal(vapidMod.vapidSubject([]), 'mailto:phase-console@localhost');
});

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

function stubFetch(status: number, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status >= 400 ? 'nope' : null, { status, headers });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

test('a delivery carries the headers a push service requires', async () => {
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const { calls, impl } = stubFetch(201);

  const result = await send.deliver(vapid, browser.subscription, {
    title: 'Permission needed', body: 'demo phase 3', tag: 'abc123', url: '/#/runs', category: 'approval',
  }, { fetchImpl: impl, urgent: true });

  assert.deepEqual(result, { kind: 'sent', status: 201 });
  const [call] = calls;
  const headers = call.init.headers as Record<string, string>;
  assert.equal(call.url, browser.subscription.endpoint);
  assert.equal(call.init.method, 'POST');
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers.urgency, 'high');
  assert.equal(headers.topic, send.topicFor('abc123'));
  assert.match(headers.authorization, /^vapid t=/);
  assert.ok(Number(headers.ttl) > 0);

  // And the body really is the message, not a hopeful blob.
  const decoded = JSON.parse(browser.decrypt(Buffer.from(call.init.body as Uint8Array)));
  assert.equal(decoded.title, 'Permission needed');
  assert.equal(decoded.category, 'approval');
});

test('every topic is one a push service will accept', () => {
  // Apple answers `BadWebPushTopic` to anything that is not a decodable
  // base64url string of at most 32 characters — measured, not read. A length of
  // `n % 4 === 1` is the case that catches people, because it looks fine.
  const tags = ['phase', 'push-test', 'run/slug:1 with spaces!', '', 'x'.repeat(500), 'a1b2c3d4e5f60718'];
  for (const tag of tags) {
    const topic = send.topicFor(tag);
    assert.match(topic, /^[A-Za-z0-9_-]+$/, `${tag} produced non-base64url`);
    assert.ok(topic.length <= 32, `${tag} produced ${topic.length} chars`);
    assert.notEqual(topic.length % 4, 1, `${tag} produced an undecodable length`);
  }
});

test('the same tag always collapses to the same topic', () => {
  // The header exists to replace rather than queue. That only works if the tag
  // maps to one topic, every time.
  assert.equal(send.topicFor('run:abc:halted'), send.topicFor('run:abc:halted'));
  assert.notEqual(send.topicFor('run:abc:halted'), send.topicFor('run:abc:parked'));
});

test('the topic on the wire is the hashed one', async () => {
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const { calls, impl } = stubFetch(201);
  await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'push-test', url: '/', category: 'phase',
  }, { fetchImpl: impl });
  assert.equal((calls[0].init.headers as Record<string, string>).topic, send.topicFor('push-test'));
});

test('an over-long body is trimmed rather than rejected by the service', async () => {
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const { calls, impl } = stubFetch(201);
  await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'x'.repeat(5000), url: '/', tag: 'a', category: 'phase',
  }, { fetchImpl: impl });
  const decoded = JSON.parse(browser.decrypt(Buffer.from(calls[0].init.body as Uint8Array)));
  assert.ok(decoded.body.length <= 400, `body was ${decoded.body.length}`);
  assert.ok(decoded.body.endsWith('…'));
});

test('each status becomes the decision it implies', async () => {
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const cases: [number, string][] = [[201, 'sent'], [404, 'gone'], [410, 'gone'], [429, 'throttled'], [500, 'failed']];
  for (const [status, kind] of cases) {
    const { impl } = stubFetch(status, status === 429 ? { 'retry-after': '120' } : {});
    const result = await send.deliver(vapid, browser.subscription, {
      title: 't', body: 'b', tag: 'a', url: '/', category: 'phase',
    }, { fetchImpl: impl });
    assert.equal(result.kind, kind, `${status} should be ${kind}`);
    if (result.kind === 'throttled') assert.equal(result.retryAfter, 120);
  }
});

test('a network that is simply down is a failure, not a dead subscription', async () => {
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const impl = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
  const result = await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'a', url: '/', category: 'phase',
  }, { fetchImpl: impl });
  assert.equal(result.kind, 'failed');
  assert.equal(result.kind === 'failed' && result.status, 0);
});

/* ------------------------------------------------------------------ *
 * The catalogue
 * ------------------------------------------------------------------ */

test('the noisy categories are off and the blocking ones are on', () => {
  const defaults = catalogue.defaultCategories();
  assert.equal(defaults.approval, true);
  assert.equal(defaults.halted, true);
  assert.equal(defaults.phase, true);
  assert.equal(defaults.finished, true);
  assert.equal(defaults.changed, false, 'a file-level firehose must be opt-in');
  assert.equal(defaults.ready, false);
  // A lane that is still spending and has stopped producing work is worth
  // hearing about by default: it is the money question, and it is rare.
  assert.equal(defaults.stalled, true);
});

test('only what blocks a run is marked urgent', () => {
  const urgent = catalogue.CATEGORIES.filter((c) => c.urgent).map((c) => c.id);
  // `needs-you` earns it on exactly the test the other two pass: the phase has
  // stopped and nothing further happens until a person acts. `parked` and
  // `finished` do not — a run asleep until a usage window reopens moves again
  // on its own, and a finished one is not waiting for anybody.
  // `stalled` is the newest candidate and deliberately fails the same test:
  // nothing is blocked on the operator and the run has not stopped, so a card
  // that buzzed a wrist for it would be turned off inside a week — taking the
  // signal with it.
  // `session-ask` passes it the same way `approval` does: the session is
  // stopped dead at a prompt, and nothing proceeds until a person answers it.
  // `qa` passes it too, narrowly: the hold is announced only after the
  // machine's own chase (the at-finish dispatcher, then the ladder) left the
  // verdict owed — at which point every dependent phase is held and nothing
  // records a verdict by itself.
  assert.deepEqual(urgent.sort(), ['approval', 'halted', 'needs-you', 'qa', 'session-ask'],
    'urgency is reserved for "nothing proceeds without you" — widening it is how a channel gets muted');
});

test('unknown categories are dropped and missing ones take their default', () => {
  const cleaned = catalogue.sanitiseCategories({ approval: false, nonsense: true, phase: 'yes' });
  assert.equal(cleaned.approval, false);
  assert.equal('nonsense' in cleaned, false);
  // A non-boolean is not an opinion, so the default stands.
  assert.equal(cleaned.phase, true);
  assert.equal(cleaned.finished, true);
});

/* ------------------------------------------------------------------ *
 * The register
 * ------------------------------------------------------------------ */

function subscriptionJson() {
  const browser = makeBrowser();
  return { browser, json: browser.subscription };
}

test('subscribing twice from one browser updates rather than duplicates', () => {
  const register = new push.Push(['you@example.com']);
  const { json } = subscriptionJson();
  const first = register.subscribe(json, undefined, 'Mac · Chrome');
  const second = register.subscribe(json, undefined, 'Mac · Chrome (again)');
  assert.ok(!('error' in first) && !('error' in second));
  assert.equal(register.list().length, 1);
  assert.equal(register.list()[0].label, 'Mac · Chrome (again)');
});

test('a subscription keeps the site it came in under and the device it belongs to — public, persisted, strings only', async () => {
  const { recent } = await import('../server/log.ts');
  const register = new push.Push([]);
  // Every test browser shares one endpoint, and a repeat endpoint is an UPDATE
  // that logs nothing — so each browser here gets an endpoint of its own.
  const fresh = () => ({ ...subscriptionJson().json, endpoint: `https://push.example.com/sub/${randomBytes(6).toString('hex')}` });
  const json = fresh();
  const device = register.subscribe(json, undefined, 'phone', { site: 'https://192.168.1.20:4443', deviceId: 'a1b2c3d4e5f6' });
  assert.ok(!('error' in device));
  assert.equal(device.site, 'https://192.168.1.20:4443');
  assert.equal(device.deviceId, 'a1b2c3d4e5f6');

  const listed = register.list().find((row) => row.id === device.id)!;
  assert.equal(listed.site, 'https://192.168.1.20:4443', 'a page may see where a device subscribed');
  assert.equal(listed.deviceId, 'a1b2c3d4e5f6');
  assert.ok(!('endpoint' in listed) && !('keys' in listed), 'and still never its endpoint or keys');
  const reread = new push.Push([]).list().find((row) => row.id === device.id)!;
  assert.equal(reread.site, 'https://192.168.1.20:4443', 'kept on disk');
  assert.equal(reread.deviceId, 'a1b2c3d4e5f6');

  const line = recent(500).findLast((entry) => entry.event === 'push.subscribed' && entry.data?.id === device.id);
  assert.equal(line?.data?.site, 'https://192.168.1.20:4443', 'the subscribed line names the site');
  assert.equal(line?.data?.deviceId, 'a1b2c3d4e5f6', 'and the device');

  const moved = register.subscribe(json, undefined, 'phone', { site: 'https://mac.local:4443' });
  assert.ok(!('error' in moved));
  assert.equal(moved.id, device.id, 'the same browser, the same row');
  assert.equal(moved.site, 'https://mac.local:4443', 'under the site it came in under this time');
  assert.equal(moved.deviceId, 'a1b2c3d4e5f6', 'a re-subscribe that names no device keeps the one it had');

  const junk = register.subscribe(fresh(), undefined, 'tablet', { site: 42, deviceId: ['a1b2c3d4e5f6'] });
  assert.ok(!('error' in junk));
  assert.equal('site' in junk, false, 'a site that is not a string is no site');
  assert.equal('deviceId' in junk, false);
  const plain = register.subscribe(fresh(), undefined, 'laptop');
  assert.ok(!('error' in plain));
  assert.equal('site' in plain, false, 'and a caller that says nothing records nothing');

  // The register file is this whole suite's: leave it as it was found.
  for (const row of [device, junk, plain]) register.unsubscribe(row.id);
});

test('a re-subscribe keeps the categories already chosen', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  const device = register.subscribe(json, { phase: false }, 'phone');
  assert.ok(!('error' in device));
  register.subscribe(json, undefined, 'phone');
  assert.equal(register.list()[0].categories.phase, false);
});

test('a subscription that is not one is refused with a reason', () => {
  const register = new push.Push([]);
  assert.match((register.subscribe(null, undefined, '') as { error: string }).error, /no subscription/);
  assert.match((register.subscribe({ endpoint: 'nope' }, undefined, '') as { error: string }).error, /not a URL/);
  // The server POSTs to this. It does not get to be anything but a push service.
  assert.match((register.subscribe({
    endpoint: 'http://push.example.com/x', keys: { p256dh: 'a', auth: 'b' },
  }, undefined, '') as { error: string }).error, /https/);
  // Scheme, then host, then keys — the order the refusals read in.
  const at = (endpoint: string) => (register.subscribe(
    { endpoint, keys: { p256dh: 'a', auth: 'b' } }, undefined, '',
  ) as { error: string }).error;
  assert.match(at('https://127.0.0.1:9000/x'), /loopback|private/);
  assert.match(at('https://localhost/x'), /loopback|private/);
  assert.match(at('https://intranet/x'), /bare host name/);
  assert.match((register.subscribe({
    endpoint: 'https://push.example.com/x', keys: { p256dh: 'AAAA', auth: 'BBBB' },
  }, undefined, '') as { error: string }).error, /65-byte/);
});

test('an endpoint is a push service or it is refused', () => {
  // The console POSTs to this URL with a VAPID Authorization header on every
  // matching announcement, unattended, for as long as the row lives — and
  // `POST /api/push/subscribe` is gated on the cross-site header and nothing
  // else. The comment on that check always claimed loopback was refused; only
  // the scheme ever was. This table is the whole value of the predicate.
  for (const url of [
    'https://push.example.com/sub/abc123',
    'https://push.example/x',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QAbc',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=X',
  ]) assert.equal(push.endpointRefusal(url), null, url);

  for (const url of [
    'nope', 'file:///etc/passwd', 'http://push.example.com/x',
    'https://localhost/x', 'https://LOCALHOST:8443/x', 'https://foo.localhost/x',
    // `new URL` normalises all three of these to 127.0.0.1 before we see them.
    'https://127.0.0.1/x', 'https://127.1/x', 'https://0x7f.0.0.1/x', 'https://2130706433/x',
    // IPv6 arrives bracketed, and a v4-mapped address is rewritten to hex.
    'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x',
    'https://[::ffff:c0a8:101]/x', 'https://[fe80::1]/x', 'https://[FEBF::1]/x',
    'https://[fd00::1]/x', 'https://[fc00::1]/x', 'https://[::]/x',
    // The cloud metadata address, which is the reason link-local is in the list.
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/x', 'https://172.16.0.1/x', 'https://192.168.1.4/x',
    'https://intranet-jenkins/build',
  ]) assert.ok(push.endpointRefusal(url), url);
});

test('the register never hands out the keys it holds', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  register.subscribe(json, undefined, 'phone');
  const [device] = register.list();
  assert.equal('endpoint' in device, false, 'an endpoint is a credential');
  assert.equal('keys' in device, false);
  assert.equal(device.service, 'https://push.example.com');
});

test('unsubscribing works by id or by endpoint', () => {
  const register = new push.Push([]);
  const a = subscriptionJson();
  const b = subscriptionJson();
  b.json.endpoint = 'https://push.example.com/sub/second';
  const first = register.subscribe(a.json, undefined, 'one') as { id: string };
  register.subscribe(b.json, undefined, 'two');
  assert.equal(register.unsubscribe(first.id), true);
  assert.equal(register.unsubscribe(b.json.endpoint), true);
  assert.equal(register.unsubscribe('neither'), false);
  assert.equal(register.list().length, 0);
});

test('categories can be changed per device', () => {
  const register = new push.Push([]);
  const { json } = subscriptionJson();
  const device = register.subscribe(json, undefined, 'phone') as { id: string };
  const updated = register.setCategories(device.id, { changed: true, approval: false });
  assert.equal(updated?.categories.changed, true);
  assert.equal(updated?.categories.approval, false);
  assert.equal(register.setCategories('nope', {}), null);
});

test('the state a client is given carries the key and the catalogue', () => {
  const register = new push.Push([]);
  const state = register.state();
  assert.equal(Buffer.from(state.publicKey, 'base64url').length, 65);
  assert.equal(state.categories.length, catalogue.CATEGORIES.length);
});

test('a rejection body naming its reason is classified, for the health streak', async () => {
  // Apple's real shape for the measured outage: 403 with {"reason":"BadJwtToken"}.
  // 29 sends died on it with nothing but log lines; the classification is what
  // lets a streak become an environment issue instead of silence.
  const browser = makeBrowser();
  const vapid = fixtureVapid();
  const impl = (async () => new Response('{"reason":"BadJwtToken"}', { status: 403 })) as unknown as typeof fetch;
  const result = await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'a', url: '/', category: 'halted',
  }, { fetchImpl: impl });
  assert.equal(result.kind, 'failed');
  assert.equal((result as { reason?: string }).reason, 'BadJwtToken');

  // A body with no reason stays classifiable by status alone.
  const bare = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const plain = await send.deliver(vapid, browser.subscription, {
    title: 't', body: 'b', tag: 'a', url: '/', category: 'halted',
  }, { fetchImpl: bare });
  assert.equal(plain.kind, 'failed');
  assert.equal((plain as { reason?: string }).reason, undefined);
});

/* ------------------------------------------------------------------ *
 * "Did anybody hear it?" — the fan-out's own verdict (D23)
 * ------------------------------------------------------------------ */

/**
 * Point `deliver`'s default `fetch` at a canned answer for the duration of one
 * call. `Push.announce` reaches `deliver` through the module, not through an
 * injectable, so this is the seam — restored in a `finally` by every caller.
 */
function withFetch(reply: (n: number) => Response, run: () => void): () => void {
  const real = globalThis.fetch;
  let n = 0;
  (globalThis as { fetch: unknown }).fetch = async () => reply(n++);
  run();
  return () => { (globalThis as { fetch: unknown }).fetch = real; };
}

/** Wait for the aggregate to settle: `announce` is deliberately not awaited. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => { setTimeout(r, 2); });
}

function registerWith(labels: string[]): InstanceType<typeof push.Push> {
  const register = new push.Push(['you@example.com']);
  // The register is PERSISTED, and every `new Push()` in this file loads the
  // same file — so the devices earlier cases subscribed are still here. A case
  // about "every device" has to know exactly which devices it has.
  for (const device of register.list()) register.unsubscribe(device.id);
  labels.forEach((label, i) => {
    // Distinct endpoints, because the register keys a device BY endpoint: two
    // fixture browsers sharing one URL are one device, and a case about "every
    // device" would quietly be a case about one.
    const browser = makeBrowser();
    const ok = register.subscribe(
      { ...browser.subscription, endpoint: `https://push.example.com/sub/d23-${i}` }, undefined, label,
    );
    assert.ok(!('error' in ok), `subscribing ${label} must work`);
  });
  return register;
}

test('a notification that reached none of its devices says so', async () => {
  // The measured failure: three stall cards died on BOTH devices and nothing
  // anywhere reported it. Two devices on two services never reach a streak of
  // 3 on either `service|reason` key, so the streak alarm cannot see this —
  // the verdict has to be taken per NOTIFICATION.
  const register = registerWith(['Mac · Chrome', 'iPhone · Safari']);
  const seen: { title: string; devices: { label: string; outcome: string }[] }[] = [];
  register.onUndelivered = (info) => { seen.push({ title: info.title, devices: info.devices }); };

  const restore = withFetch(() => new Response('nope', { status: 500 }), () => {
    register.announce('halted', { title: 'A run halted', body: 'b', tag: 'd23-all-fail', url: '/' });
  });
  await settle();
  restore();

  assert.equal(seen.length, 1, 'one notification, one verdict — not one per device');
  assert.equal(seen[0].title, 'A run halted');
  assert.equal(seen[0].devices.length, 2);
  assert.ok(seen[0].devices.every((d) => d.outcome === 'failed'));
});

test('one device hearing it is enough — the notification was delivered', async () => {
  const register = registerWith(['Mac · Chrome', 'iPhone · Safari']);
  let fired = 0;
  register.onUndelivered = () => { fired++; };

  // First attempt accepted, second refused. A device that did not hear it is
  // the device's problem (the streak and `lastReject` carry that); it is not
  // this alarm, which exists for "nobody heard it".
  const restore = withFetch((n) => (n === 0
    ? new Response(null, { status: 201 })
    : new Response('nope', { status: 500 })), () => {
    register.announce('halted', { title: 'A run halted', body: 'b', tag: 'd23-one-ok', url: '/' });
  });
  await settle();
  restore();

  assert.equal(fired, 0, 'a partly-delivered notification is delivered');
});

test('a fan-out that was entirely deduped is not an undelivered notification', async () => {
  const register = registerWith(['Mac · Chrome']);
  let fired = 0;

  // The first announce lands, so nothing is undelivered. The second is the
  // same tag to the same device inside the dedupe window: zero attempts, which
  // is not the same fact as zero arrivals.
  const restore = withFetch(() => new Response(null, { status: 201 }), () => {
    register.announce('halted', { title: 'A run halted', body: 'b', tag: 'd23-dedupe', url: '/' });
  });
  await settle();
  restore();
  register.onUndelivered = () => { fired++; };
  const restore2 = withFetch(() => new Response('nope', { status: 500 }), () => {
    register.announce('halted', { title: 'A run halted', body: 'b', tag: 'd23-dedupe', url: '/' });
  });
  await settle();
  restore2();

  assert.equal(fired, 0, 'no attempt was made, so nothing failed to arrive');
});

/* ------------------------------------------------------------------ *
 * Nobody to send to, and whose tag it is (zero-touch phase 17, FLT-1 / FLT-4)
 * ------------------------------------------------------------------ */

test('ACC-10.1: a fan-out to zero devices is a `no-device` report, not silence', () => {
  const register = registerWith([]);
  const reports: { outcome: string; detail?: string }[] = [];
  const nobody: { category: string; subscribed: number }[] = [];
  register.onNoDevice = (info) => { nobody.push({ category: info.category, subscribed: info.subscribed }); };
  const attempt = register.announce(
    'needs-you', { title: 'A phase needs you', body: 'b', tag: 'flt1-none', url: '/' }, Date.now(),
    (report) => { reports.push(report); },
  );
  assert.equal(attempt, null, 'nothing was attempted, so nothing is in flight');
  assert.deepEqual(reports.map((r) => r.outcome), ['no-device'], 'the record says there was nobody to send it to');
  assert.match(reports[0]!.detail ?? '', /no device is subscribed/);
  assert.deepEqual(nobody, [{ category: 'needs-you', subscribed: 0 }]);

  // A device that opted out of the category is a different fact — named as such.
  const opted = registerWith(['Mac · Chrome']);
  const [device] = opted.list();
  opted.setCategories(device!.id, { ready: false });
  const optedReports: { outcome: string; detail?: string }[] = [];
  opted.announce('ready', { title: 'Ready', body: 'b', tag: 'flt1-opted', url: '/' }, Date.now(), (r) => { optedReports.push(r); });
  assert.deepEqual(optedReports.map((r) => r.outcome), ['no-device']);
  assert.match(optedReports[0]!.detail ?? '', /1 device subscribed, none to ready/);
});

test('ACC-10.1: a console with no device and --remote set files push-broken ONCE, naming the category', async () => {
  const { Service } = await import('../server/service.ts');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowRun: false,
    remoteHosts: ['console.example.ts.net'], remoteUsers: ['you@example.com'],
    scriptsDir: new URL('../../scripts', import.meta.url).pathname, logFile: null, maxSessions: 3, defaultSkills: [],
  } as never);
  try {
    for (const device of svc.push.list()) svc.push.unsubscribe(device.id);
    const channel = () => svc.environment.issues.filter((issue) => issue.kind === 'push-broken');
    assert.equal(channel().length, 1, 'the boot doctor files the channel row: no device, no notifier, no webhook');
    assert.match(channel()[0]!.detail, /no delivery channel/);

    // The real fan-out, twice: the row names the category once and is not repeated.
    svc.push.announce('needs-you', { title: 'A phase needs you', body: 'b', tag: 'flt1-svc-1', url: '/' });
    svc.push.announce('halted', { title: 'A run halted', body: 'b', tag: 'flt1-svc-2', url: '/' });
    assert.equal(channel().length, 1, 'once per process, however many announcements found nobody');
    assert.match(channel()[0]!.detail, /"needs-you" announcements are reaching nobody/);

    // A device subscribing clears it at once — not at the next restart.
    const browser = makeBrowser();
    const subscribed = svc.push.subscribe({ ...browser.subscription, endpoint: 'https://push.example.com/sub/flt1-svc' }, undefined, 'iPhone · Safari');
    assert.ok(!('error' in subscribed));
    assert.equal(channel().length, 0, 'a console that can reach someone is not broken');
    svc.push.unsubscribe('https://push.example.com/sub/flt1-svc');
    assert.equal(channel().length, 1, 'and losing the last device brings the row back');
  } finally {
    svc.close();
  }
});

test('ACC-10.1: tagFor is namespaced by instance before hashing — two consoles never share a topic', () => {
  const a = push.tagForInstance('4557c636-hub', 'health', 'env-doctor');
  const b = push.tagForInstance('f922d743-pe-hub', 'health', 'env-doctor');
  assert.notEqual(a, b, 'identical parts, two instances, two tags');
  assert.notEqual(send.topicFor(a), send.topicFor(b), 'and so two topics: one card never replaces the other');
  assert.equal(push.tagForInstance('4557c636-hub', 'health', 'env-doctor'), a, 'still stable for one console');
  // This process's own tagFor is the same function over this console's id.
  assert.match(push.tagFor('needs-you', 'demo', 2), /^[0-9a-f]{16}$/);
  assert.notEqual(push.tagFor('needs-you', 'demo', 2), push.tagForInstance('some-other-console', 'needs-you', 'demo', 2));
});

/* ------------------------------------------------------------------ *
 * A register of its own (zero-touch phase 18)
 * ------------------------------------------------------------------ */

test('a register over a directory of its own keeps its own key and devices, and every message names the console that spoke', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-push-register-'));
  const bodies: Buffer[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(Buffer.from(init?.body as Uint8Array));
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const register = new push.Push([], { dir, console: { id: 'relay', name: 'relay' }, fetchImpl: impl });
  assert.ok(register.publicKey, 'it minted a key');
  assert.notEqual(register.publicKey, fixtureVapid().publicKey, 'a pair of its own — never this console’s');
  assert.ok(existsSync(join(dir, 'vapid.json')));
  const browser = makeBrowser();
  assert.ok(!('error' in register.subscribe(browser.subscription, undefined, 'phone')));
  assert.ok(existsSync(join(dir, 'subscriptions.json')), 'its devices, beside its key');

  // The fleet subscription's tags carry the instance id: the console namespaced
  // the tag before hashing, and the register carries it as it came.
  const tag = push.tagForInstance('4557c636-hub', 'needs-you', 'demo', 2);
  await register.announce('halted', {
    title: 'A run halted', body: 'b', tag, url: '/c/4557c636-hub/#/', console: { id: '4557c636-hub', name: 'hub' },
  });
  assert.equal(bodies.length, 1);
  const spoken = JSON.parse(browser.decrypt(bodies[0]));
  assert.deepEqual(spoken.console, { id: '4557c636-hub', name: 'hub' }, 'the console that spoke, not the register');
  assert.equal(spoken.tag, tag);
  assert.notEqual(tag, push.tagForInstance('f922d743-pe-hub', 'needs-you', 'demo', 2), 'and no other console shares it');

  await register.announce('halted', { title: 'Its own', body: 'b', tag: 'relay-own', url: '/' });
  assert.deepEqual(JSON.parse(browser.decrypt(bodies[1])).console, { id: 'relay', name: 'relay' },
    'a message naming nobody speaks as the register');
});
