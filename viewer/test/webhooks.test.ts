/**
 * The webhook leg — what leaves this machine, and what must not.
 *
 * Two exit criteria are pinned here and both are about absence, which is the
 * hard kind to test: with the flag off NO outbound request is ever made, and a
 * payload built from a notification full of secret-shaped strings contains none
 * of them. Absence is asserted against a fetch that RECORDS rather than one that
 * is merely allowed to be unused, so "nothing was sent" is a measured zero.
 */

import './state-sandbox.ts';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Webhooks, WEBHOOK_PAYLOAD_FIELDS, WEBHOOK_PAYLOAD_VERSION, WEBHOOK_BACKOFF_BASE_MS,
  WEBHOOK_BACKOFF_MAX_MS, backoffMs, composeWebhookPayload, maskUrl, redact, webhookUrlRefusal,
  type WebhookFetch,
} from '../server/webhooks.ts';

const URL_A = 'https://hooks.example.com/services/AAAA/BBBB/cccccccccccccccccccccccc';
const URL_B = 'https://relay.example.org/inbox/zzzz';

type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fetch that records every call and answers however the test says. */
function recorder(answer: () => { status: number; ok: boolean } | Promise<never> = () => ({ status: 204, ok: true })) {
  const sent: Sent[] = [];
  const fetchImpl: WebhookFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
    return await answer();
  };
  return { sent, fetchImpl };
}

/**
 * A register with nothing in it.
 *
 * The state directory is sandboxed per PROCESS, not per test, so every
 * `Webhooks` in this file reads the same file — a row left by an earlier test
 * would otherwise receive the next one's announcements.
 */
function fresh(options: Partial<Parameters<typeof Webhooks.prototype.constructor>[0]> & {
  enabled?: boolean; fetch?: WebhookFetch; now?: () => number;
} = {}): Webhooks {
  const hooks = new Webhooks({
    enabled: options.enabled ?? true,
    instance: 'test-console',
    link: (url: string) => `http://127.0.0.1:4123${url}`,
    fetch: options.fetch,
    now: options.now,
  });
  for (const row of hooks.list()) hooks.remove(row.id);
  return hooks;
}

/** Wait for the fire-and-forget POSTs `announce` starts. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/* ------------------------------------------------------------------ *
 * Criterion 1 — the flag
 * ------------------------------------------------------------------ */

test('with --allow-webhooks off, a registered URL receives nothing', async () => {
  const { sent, fetchImpl } = recorder();
  // Registered while enabled — the row is on disk exactly as it would be after
  // a day the console ran with the flag.
  const enabled = fresh({ fetch: fetchImpl });
  const added = enabled.add(URL_A, 'chat', null);
  assert.ok(!('error' in added), 'the URL should have been accepted');

  const off = new Webhooks({
    enabled: false, instance: 'test-console', link: (url: string) => url, fetch: fetchImpl,
  });
  assert.equal(off.list().length, 1, 'the row survives the restart, it is delivery that is off');
  off.announce('halted', { title: 'Run halted', body: 'nope', url: '/#/runs', notificationId: 'n1' });
  await settle();
  assert.equal(sent.length, 0, 'a console without the flag made an outbound request');

  // And the on-demand button is refused too, with a sentence naming the flag.
  const probe = await off.test(off.list()[0].id);
  assert.equal(probe.ok, false);
  assert.match(probe.detail, /--allow-webhooks/);
  assert.equal(sent.length, 0);

  for (const row of off.list()) off.remove(row.id);
});

test('the flag defaults to off', async () => {
  const { parseFlags } = await import('../server/config.ts');
  assert.equal(parseFlags([]).allowWebhooks, false);
  assert.equal(parseFlags(['--allow-run', '--allow-writes']).allowWebhooks, false);
  assert.equal(parseFlags(['--allow-webhooks']).allowWebhooks, true);
});

/* ------------------------------------------------------------------ *
 * Criterion 1 — category filtering
 * ------------------------------------------------------------------ */

test('with the flag on, only the categories a hook asked for reach it', async () => {
  const { sent, fetchImpl } = recorder();
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'halted only', { halted: true, phase: false, ready: false });
  hooks.add(URL_B, 'phases only', { halted: false, phase: true, ready: false });

  hooks.announce('halted', { title: 'Run halted', body: 'verification failed', url: '/#/plan/x/run', notificationId: 'n1', slug: 'x' });
  await settle();
  assert.deepEqual(sent.map((s) => s.url), [URL_A]);

  hooks.announce('phase', { title: 'Phase 3 landed', body: '$1.20', url: '/#/plan/x/phase/3', notificationId: 'n2', slug: 'x', phase: 3 });
  await settle();
  assert.deepEqual(sent.map((s) => s.url), [URL_A, URL_B]);

  // A category neither asked for reaches nobody.
  hooks.announce('ready', { title: 'Work became ready', body: '', url: '/#/ready', notificationId: 'n3' });
  await settle();
  assert.equal(sent.length, 2, 'an unsubscribed category was delivered anyway');

  for (const row of hooks.list()) hooks.remove(row.id);
});

test('the payload carries exactly the documented fields, and the headers name the console', async () => {
  const { sent, fetchImpl } = recorder();
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'chat', { halted: true });
  hooks.announce('halted', {
    title: 'Run halted', body: 'phase 4 would not settle', url: '/#/plan/demo/run',
    notificationId: 'abc', slug: 'demo', phase: 4, runId: 'run-9',
  });
  await settle();

  assert.equal(sent.length, 1);
  const [call] = sent;
  assert.deepEqual(Object.keys(call.body).sort(), [...WEBHOOK_PAYLOAD_FIELDS].sort());
  assert.equal(call.body.version, WEBHOOK_PAYLOAD_VERSION);
  assert.equal(call.body.category, 'halted');
  assert.equal(call.body.urgent, true, 'halted is an urgent category');
  assert.equal(call.body.slug, 'demo');
  assert.equal(call.body.phase, 4);
  assert.equal(call.body.runId, 'run-9');
  assert.equal(call.body.url, '/#/plan/demo/run');
  assert.equal(call.body.link, 'http://127.0.0.1:4123/#/plan/demo/run');
  // Slack and Telegram render `text`; Discord renders `content`. Same line.
  assert.equal(call.body.text, 'Run halted — phase 4 would not settle');
  assert.equal(call.body.content, call.body.text);
  assert.equal(call.headers['x-phase-console-category'], 'halted');
  assert.equal(call.headers['x-phase-console-instance'], 'test-console');
  assert.equal(call.headers['content-type'], 'application/json');

  for (const row of hooks.list()) hooks.remove(row.id);
});

test('a payload names an inbox record, and carries no token, action or button', async () => {
  const { sent, fetchImpl } = recorder();
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'chat', { approval: true });
  hooks.announce('approval', { title: 'Permission needed', body: 'rm -rf', url: '/#/plan/x/run', notificationId: 'rec-1', slug: 'x' });
  await settle();

  const keys = Object.keys(sent[0].body);
  for (const forbidden of ['callback', 'actions', 'token', 'approvalId', 'tag']) {
    assert.ok(!keys.includes(forbidden), `a webhook payload must not carry ${forbidden}`);
  }
  for (const row of hooks.list()) hooks.remove(row.id);
});

/* ------------------------------------------------------------------ *
 * Criterion 2 — redaction
 * ------------------------------------------------------------------ */

/**
 * One per secret shape `redact` claims to know, with what it must become.
 *
 * `expected` is the point. The first version of this table asserted only that a
 * payload did not CONTAIN the secret, and three specific rules could then be
 * deleted with every test still green — the generic high-entropy rule was
 * masking the tail of each fixture, which is enough to defeat a `includes()`
 * check and not enough to redact anything. So each fixture is now short enough
 * that only its own rule can match it, and the assertion is equality: the rule
 * must consume the WHOLE secret.
 */
const MASKED = '[redacted]';
const SECRETS: ReadonlyArray<readonly [string, string, string]> = [
  ['anthropic key', 'sk-ant-api03-AAAABBBBCCCCDDDD', MASKED],
  ['openai-style key', 'sk-proj0123456789abcdefghij', MASKED],
  ['github classic', 'ghp_0123456789abcdefghij', MASKED],
  ['github fine-grained', 'github_pat_11abcdefghij0123456789', MASKED],
  ['slack bot token', 'xoxb-1234567890-abcdef', MASKED],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', MASKED],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4C', MASKED],
  ['slack webhook url', 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX', MASKED],
  ['discord webhook url', 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGh', MASKED],
  ['telegram bot url', 'https://api.telegram.org/bot123456:AAHdqTcvCH1vGWJx', MASKED],
  ['pem block', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34\n-----END RSA PRIVATE KEY-----', MASKED],
  ['bare high-entropy token', 'Zm9vYmFyQmF6UXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWpr', MASKED],
  // Two keep their non-secret half: "something was removed from here" is more
  // useful than a line that reads as if the console had nothing to say.
  ['assignment', 'API_KEY=s3cr3tValue0123456789', `API_KEY=${MASKED}`],
  ['bearer header', 'Authorization: Bearer abcdefgh12345678', `Authorization: ${MASKED}`],
  // With no key name in front of it — a curl line pasted into a message.
  ['bare bearer', 'Bearer abcdefgh12345678', MASKED],
  ['url userinfo', 'https://admin:hunter2@internal.example.com/x', `https://${MASKED}@internal.example.com/x`],
];

test('each secret shape is masked by its OWN rule, whole', () => {
  for (const [name, secret, expected] of SECRETS) {
    assert.equal(redact(secret), expected, `${name} was not fully masked`);
  }
});

test('every secret shape is masked out of a payload', async () => {
  const { sent, fetchImpl } = recorder();
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'chat', { halted: true });

  for (const [name, secret] of SECRETS) {
    hooks.announce('halted', {
      title: `Run halted: ${secret}`,
      body: `the session printed ${secret} and stopped`,
      url: '/#/runs',
      notificationId: `n-${name.replace(/\s+/g, '-')}`,
    });
  }
  await settle();
  assert.equal(sent.length, SECRETS.length);

  for (const [index, [name, secret]] of SECRETS.entries()) {
    const wire = JSON.stringify(sent[index].body);
    // The secret-bearing SUBSTRING, so a rule that keeps a non-secret half
    // (`API_KEY=`, the userinfo scheme) is still held to losing the rest.
    const value = secret.includes('=') ? secret.split('=').slice(1).join('=')
      : secret.startsWith('Authorization') ? secret.split(' ').slice(1).join(' ')
        : secret.includes('@') && secret.startsWith('https://') ? 'hunter2'
          : secret;
    assert.ok(!wire.includes(value), `${name} survived redaction: ${wire}`);
    assert.match(wire, /\[redacted\]/, `${name} produced no mask at all`);
  }
  for (const row of hooks.list()) hooks.remove(row.id);
});

test('redaction keeps the things a run is identified by', () => {
  // A commit sha, a UUID, a slug, an ISO timestamp and a dollar figure are the
  // whole point of the notification. A redactor that eats them is worse than
  // none, because it is silently useless.
  const keep = [
    'af1c3e1ab2c3d4e5f60718293a4b5c6d7e8f9012',
    '4557c636-1234-4abc-8def-0123456789ab',
    'console-audit-hardening',
    '2026-08-25T12:34:56.000Z',
    '$1.20',
    'phase 19 of 23',
  ];
  for (const value of keep) {
    assert.equal(redact(`Phase landed: ${value}`), `Phase landed: ${value}`, `redaction ate ${value}`);
  }
});

test('an assignment keeps its key and loses its value', () => {
  assert.equal(redact('token=abcdef0123456789abcdef'), 'token=[redacted]');
  assert.match(redact('https://admin:hunter2@example.com/x'), /^https:\/\/\[redacted\]@/);
});

/* ------------------------------------------------------------------ *
 * The URL is a credential
 * ------------------------------------------------------------------ */

test('nothing the API serves contains the URL', () => {
  const hooks = fresh();
  hooks.add(URL_A, 'chat', null);
  const wire = JSON.stringify(hooks.state());
  assert.ok(!wire.includes(URL_A), 'the registered URL was served back to the caller');
  assert.ok(!wire.includes('cccccccccccccccccccccccc'), 'the secret path segment was served back');
  assert.match(wire, /https:\/\/hooks\.example\.com/, 'the origin is what tells two rows apart');
  assert.equal(hooks.state().hooks[0].tail, '…cccccc');
  for (const row of hooks.list()) hooks.remove(row.id);
});

test('maskUrl degrades rather than throwing on a URL it cannot parse', () => {
  assert.deepEqual(maskUrl('not a url'), { origin: 'unknown', tail: '' });
});

/* ------------------------------------------------------------------ *
 * Where this console may POST
 * ------------------------------------------------------------------ */

test('a webhook URL may not point back inside this machine', () => {
  for (const bad of [
    'http://hooks.example.com/x',            // not https
    'https://127.0.0.1/hook',                // loopback
    'https://localhost/hook',
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://10.1.2.3/hook',                 // RFC 1918
    'https://192.168.0.5/hook',
    'https://intranet/hook',                 // dotless
    '',
  ]) {
    assert.ok(webhookUrlRefusal(bad), `${bad || '(empty)'} should have been refused`);
  }
  assert.equal(webhookUrlRefusal(URL_A), null);
  // The sentences are an operator's, not a push service's.
  assert.ok(!String(webhookUrlRefusal('http://hooks.example.com/x')).includes('endpoint'));
});

test('a refused URL is never registered', () => {
  const hooks = fresh();
  const result = hooks.add('https://127.0.0.1/hook', 'loopback', null);
  assert.ok('error' in result);
  assert.equal(hooks.list().length, 0);
});

/* ------------------------------------------------------------------ *
 * Backoff
 * ------------------------------------------------------------------ */

test('backoff doubles per consecutive failure and is capped', () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), WEBHOOK_BACKOFF_BASE_MS);
  assert.equal(backoffMs(2), WEBHOOK_BACKOFF_BASE_MS * 2);
  assert.equal(backoffMs(3), WEBHOOK_BACKOFF_BASE_MS * 4);
  assert.equal(backoffMs(40), WEBHOOK_BACKOFF_MAX_MS);
  assert.ok(backoffMs(99) <= WEBHOOK_BACKOFF_MAX_MS);
});

test('a failing URL goes quiet, comes back, and a success clears the streak', async () => {
  let clock = 1_000_000;
  let refuse = true;
  const { sent, fetchImpl } = recorder(() => (refuse ? { status: 500, ok: false } : { status: 204, ok: true }));
  const hooks = fresh({ fetch: fetchImpl, now: () => clock });
  hooks.add(URL_A, 'flaky', { halted: true });

  const fire = async () => {
    hooks.announce('halted', { title: 'Run halted', body: '', url: '/#/runs', notificationId: `n${clock}` });
    await settle();
  };

  await fire();
  assert.equal(sent.length, 1);
  assert.equal(hooks.list()[0].failures, 1);
  assert.equal(hooks.list()[0].quietUntil, clock + WEBHOOK_BACKOFF_BASE_MS);

  // Inside the quiet window: skipped entirely, not attempted and rejected.
  clock += WEBHOOK_BACKOFF_BASE_MS - 1;
  await fire();
  assert.equal(sent.length, 1, 'a quiet hook was attempted anyway');

  // Past it: attempted again, and the second failure backs off twice as far.
  clock += 2;
  await fire();
  assert.equal(sent.length, 2);
  assert.equal(hooks.list()[0].failures, 2);
  assert.equal(hooks.list()[0].quietUntil, clock + WEBHOOK_BACKOFF_BASE_MS * 2);

  // A success ends it — no quiet window, no failure count, no stale rejection.
  refuse = false;
  clock += WEBHOOK_BACKOFF_BASE_MS * 2 + 1;
  await fire();
  assert.equal(sent.length, 3);
  const [row] = hooks.list();
  assert.equal(row.failures, 0);
  assert.equal(row.quietUntil, undefined);
  assert.equal(row.lastFailure, undefined);
  assert.ok(row.lastOkAt);

  for (const r of hooks.list()) hooks.remove(r.id);
});

test('a URL that hangs or throws is a failure, never an exception into the run', async () => {
  const fetchImpl: WebhookFetch = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'dead', { halted: true });
  // If this threw, the test would fail here rather than in an assertion.
  hooks.announce('halted', { title: 'Run halted', body: '', url: '/#/runs', notificationId: 'n1' });
  await settle();
  assert.equal(hooks.list()[0].failures, 1);
  assert.equal(hooks.list()[0].lastFailure?.reason, 'timed out');
  assert.equal(hooks.list()[0].lastFailure?.status, 0);
  for (const row of hooks.list()) hooks.remove(row.id);
});

/* ------------------------------------------------------------------ *
 * The register
 * ------------------------------------------------------------------ */

test('adding the same URL twice keeps one row and clears its backoff', async () => {
  const { fetchImpl } = recorder(() => ({ status: 500, ok: false }));
  const hooks = fresh({ fetch: fetchImpl });
  hooks.add(URL_A, 'first', { halted: true });
  hooks.announce('halted', { title: 'x', body: '', url: '/#/runs', notificationId: 'n1' });
  await settle();
  assert.equal(hooks.list()[0].failures, 1);

  const again = hooks.add(URL_A, 'second', { phase: true });
  assert.ok(!('error' in again));
  assert.equal(hooks.list().length, 1, 'a re-paste made a second destination');
  assert.equal(hooks.list()[0].label, 'second');
  assert.equal(hooks.list()[0].failures, 0, 'a re-paste is also "try again now"');
  assert.equal(hooks.list()[0].quietUntil, undefined);
  for (const row of hooks.list()) hooks.remove(row.id);
});

test('a row with no label is named after its origin', () => {
  const hooks = fresh();
  const added = hooks.add(URL_A, '   ', null);
  assert.ok(!('error' in added));
  assert.equal(hooks.list()[0].label, 'hooks.example.com');
  for (const row of hooks.list()) hooks.remove(row.id);
});

test('categories are sanitised, and an unknown one cannot be smuggled in', () => {
  const hooks = fresh();
  const added = hooks.add(URL_A, 'chat', { halted: true, 'not-a-category': true, phase: 'yes' });
  assert.ok(!('error' in added));
  const [row] = hooks.list();
  assert.equal(row.categories.halted, true);
  assert.ok(!('not-a-category' in row.categories));
  // A non-boolean takes the catalogue default rather than becoming truthy.
  assert.equal(row.categories.phase, true);
  // The UPDATE path sanitises too. Nothing pinned this until a mutation showed
  // `setCategories` could write whatever arrived: `add` was guarded and the
  // route that changes a live row was not, which is the half an operator uses.
  const updated = hooks.setCategories(row.id, { halted: false, 'not-a-category': true, phase: 'yes' });
  assert.equal(updated?.categories.halted, false);
  assert.ok(!('not-a-category' in (updated?.categories ?? {})), 'an unknown category was written on update');
  assert.equal(updated?.categories.phase, true, 'a non-boolean should take the catalogue default');
  assert.equal(hooks.setCategories('no-such-id', {}), null);
  assert.equal(hooks.remove('no-such-id'), false);
  for (const r of hooks.list()) hooks.remove(r.id);
});

test('composeWebhookPayload clips a runaway body rather than shipping a log', () => {
  const payload = composeWebhookPayload('phase', {
    title: 'Phase 1 landed', body: 'x'.repeat(5_000), url: '/#/x', notificationId: 'n',
  }, { instance: 'c', link: (u) => u, at: new Date('2026-08-25T00:00:00.000Z') });
  assert.ok(payload.body.length <= 500);
  assert.ok(payload.body.endsWith('…'));
  assert.equal(payload.at, '2026-08-25T00:00:00.000Z');
  assert.equal(payload.urgent, false, 'phase is not an urgent category');
});

test('the payload carries a per-announcement urgency override, else the catalogue decides', () => {
  const ctx = {
    instance: 'test-console',
    link: (url: string) => `http://127.0.0.1:4123${url}`,
    at: new Date('2026-09-01T00:00:00Z'),
  };
  const base = { title: 't', body: 'b', url: '/#/runs', notificationId: 'n1' };
  assert.equal(composeWebhookPayload('stalled', base, ctx).urgent, false, 'stalled is quiet by catalogue');
  assert.equal(composeWebhookPayload('stalled', { ...base, urgent: true }, ctx).urgent, true,
    'the escalated stall says urgent on the wire, same as the push and the record');
  assert.equal(composeWebhookPayload('approval', base, ctx).urgent, true);
  // The override changes a VALUE, never the field list the docs are held to.
  assert.deepEqual(
    Object.keys(composeWebhookPayload('stalled', { ...base, urgent: true }, ctx)).sort(),
    [...WEBHOOK_PAYLOAD_FIELDS].sort(),
  );
});

/* ------------------------------------------------------------------ *
 * The machine profile's rows (zero-touch phase 17, FLT-3)
 * ------------------------------------------------------------------ */

test('FLT-3: a machine-profile row is delivered to, listed as the profile\'s, never persisted and never removable here', async () => {
  const { sent, fetchImpl } = recorder();
  const base = fresh({ fetch: fetchImpl });
  assert.equal(base.list().length, 0);
  const hooks = new Webhooks({
    enabled: true,
    instance: 'test-console',
    link: (url: string) => `http://127.0.0.1:4123${url}`,
    fetch: fetchImpl,
    profileHooks: [
      { url: URL_B, name: 'machine chat', categories: ['halted'] },
      { url: 'http://127.0.0.1:9/nope' },
    ],
  });
  const rows = hooks.list();
  assert.equal(rows.length, 1, 'a refused URL from the file is skipped, not registered');
  assert.equal(rows[0]!.profile, true);
  assert.equal(rows[0]!.label, 'machine chat');
  assert.equal(hooks.remove(rows[0]!.id), false, 'the file owns it — removing it here would come back at the next boot');

  hooks.announce('halted', { title: 'A run halted', body: 'b', url: '/', category: 'halted', urgent: true } as never);
  await settle();
  assert.equal(sent.length, 1, 'every console delivers to the machine\'s rows');

  // A row this console registers itself is persisted; the profile's is not.
  const own = hooks.add(URL_A, 'own', null);
  assert.ok(!('error' in own));
  const reread = new Webhooks({ enabled: true, instance: 'test-console', link: (url: string) => url });
  assert.deepEqual(reread.list().map((row) => row.label), ['own'], 'only the console\'s own row reached the file');
  for (const row of reread.list()) reread.remove(row.id);
});
