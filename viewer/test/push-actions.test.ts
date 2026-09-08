/**
 * Answering from the notification: the token, and what it is allowed to mean.
 *
 * The whole feature rests on one claim — a service worker holding a payload
 * can answer a question and can do nothing else. That claim is made in three
 * places and each is tested here separately, because each of them alone is
 * enough to break it:
 *
 *   1. **the token** proves WHICH item and WHICH verbs, and nothing forged,
 *      expired, re-schemed or truncated reads back;
 *   2. **the verb set** is a closed three, and the two halves that produce it
 *      (`PUSH_ACTION_VERBS` and the buttons a payload carries) agree;
 *   3. **the mint↔inbox agreement** — a token names an id built by
 *      `inboxItemId`, and `server/inbox.ts` mints the ids it will be looked up
 *      against with the same function and the same subject. A drift there is
 *      the failure with no symptom: every notification button silently falls
 *      back to opening the app, and nothing is red.
 */

// The guard: sandbox before ../server loads, or this reads the operator's real
// push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  actionKey,
  MAX_NOTIFICATION_ACTIONS,
  PUSH_ACTION_TTL_MS,
  PUSH_ACTION_VERBS,
  SpentTokens,
  isPushActionVerb,
  mintActionToken,
  notificationButtons,
  readActionToken,
} from '../server/push/actions.ts';
import { inboxItemId } from '../shared/attention-model.js';
import { notificationActions, actionOf, actionRequest } from '../shared/sw-push.js';

const ITEM = inboxItemId({ kind: 'gate', slug: 'demo', phase: 4 });

/* ------------------------------------------------------------------ *
 * 1. the token
 * ------------------------------------------------------------------ */

test('a minted token reads back as the item and verbs it was minted for', () => {
  const token = mintActionToken(ITEM, ['approve']);
  assert.ok(token, 'a real item and a real verb must mint');
  const grant = readActionToken(token!);
  assert.ok(!('error' in grant), `expected a grant, got ${JSON.stringify(grant)}`);
  assert.equal(grant.item, ITEM);
  assert.deepEqual(grant.verbs, ['approve']);
  assert.ok(grant.nonce, 'every token carries a nonce so one notification is spendable once');
});

test('two tokens for the same item are different tokens', () => {
  // Otherwise answering one notification would spend every other notification
  // about the same item, which is the opposite of the intended behaviour: two
  // pushes are two offers to answer.
  const a = mintActionToken(ITEM, ['approve']);
  const b = mintActionToken(ITEM, ['approve']);
  assert.notEqual(a, b);
});

test('nothing mints without both an item and a verb this console offers', () => {
  assert.equal(mintActionToken('', ['approve']), null);
  assert.equal(mintActionToken('   ', ['approve']), null);
  assert.equal(mintActionToken(ITEM, []), null);
  // The restraint that matters: a verb that starts or kills work is not
  // notification-answerable, so a caller asking for one mints nothing rather
  // than minting a token with an empty verb list.
  assert.equal(mintActionToken(ITEM, ['recover']), null);
  assert.equal(mintActionToken(ITEM, ['stop', 'freeze', 'steer']), null);
});

test('a token is capped at the number of buttons a platform will render', () => {
  const token = mintActionToken(ITEM, ['allow', 'deny', 'approve']);
  const grant = readActionToken(token!);
  assert.ok(!('error' in grant));
  assert.equal(grant.verbs.length, MAX_NOTIFICATION_ACTIONS);
});

test('a tampered token does not read back', () => {
  const token = mintActionToken(ITEM, ['approve'])!;
  const [body, sig] = token.split('.');

  // A different item, honestly re-encoded, with the original signature.
  const forgedBody = Buffer.from(
    JSON.stringify({ v: 1, i: inboxItemId({ kind: 'gate', slug: 'other', phase: 1 }), a: ['approve'], e: Date.now() + 60_000, n: 'x' }),
    'utf8',
  ).toString('base64url');
  assert.deepEqual(readActionToken(`${forgedBody}.${sig}`), { error: 'token is not valid' });

  // One BIT of the signature — flipped in the bytes, then re-encoded.
  //
  // Not by editing the last base64url character: a 32-byte digest is 43
  // characters, the last of which carries only four significant bits, so `A`
  // and `B` there decode to the SAME bytes and the "tampered" token is the
  // original. That version of this test passed on one run and failed on the
  // next, entirely on what the digest happened to end with.
  const bytes = Buffer.from(sig, 'base64url');
  bytes[0] ^= 0x01;
  const flipped = bytes.toString('base64url');
  assert.notEqual(flipped, sig, 'the flip must actually change the signature');
  assert.deepEqual(readActionToken(`${body}.${flipped}`), { error: 'token is not valid' });

  // The shapes that are not tokens at all.
  for (const junk of ['', 'nodot', '.', 'a.', '.b', null, 42, {}]) {
    const refusal = readActionToken(junk as never);
    assert.ok('error' in refusal, `${JSON.stringify(junk)} must not read as a grant`);
  }
});

test('a CORRECTLY SIGNED token under a future schema is refused, not misread', () => {
  // This one is re-signed with the console's own key, so the signature check
  // passes and ONLY the version check can catch it. That distinction is the
  // whole test: the first version of it swapped the body and left the old
  // signature, which the signature check refused — so deleting the version
  // check left it green. A `v: 2` grant may mean something entirely
  // different, and reading it as a v1 is how a forward-compatible field
  // becomes a hole.
  const token = mintActionToken(ITEM, ['approve'])!;
  const [body] = token.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  decoded.v = 2;
  const reBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  const reSigned = createHmac('sha256', actionKey()).update(reBody).digest('base64url');

  // Prove the harness first: re-signing an UNCHANGED body must read back, or
  // this test would pass for the wrong reason on any signing change.
  const control = createHmac('sha256', actionKey()).update(body).digest('base64url');
  assert.ok(!('error' in readActionToken(`${body}.${control}`)), 'the re-signing harness itself is wrong');

  assert.deepEqual(readActionToken(`${reBody}.${reSigned}`), { error: 'token is not valid' });
});

test('a token expires, and says so in words a person can act on', () => {
  const now = Date.now();
  const token = mintActionToken(ITEM, ['approve'], now)!;
  assert.ok(!('error' in readActionToken(token, now + PUSH_ACTION_TTL_MS - 1)));
  const dead = readActionToken(token, now + PUSH_ACTION_TTL_MS);
  assert.ok('error' in dead);
  assert.match(dead.error, /expired/);
});

test('a nonce is spendable exactly once', () => {
  const spent = new SpentTokens();
  const at = Date.now() + 60_000;
  assert.equal(spent.claim('n1', at), true);
  assert.equal(spent.claim('n1', at), false);
  assert.equal(spent.claim('n2', at), true);
});

/* ------------------------------------------------------------------ *
 * 2. the verb set, and the buttons it produces
 * ------------------------------------------------------------------ */

test('the answerable verbs are exactly the three that ANSWER something', () => {
  // Named literally rather than derived: this list is a decision, and a test
  // that recomputed it from the object would pass whatever the object said.
  // A notification button may answer a question that is already waiting; it
  // may never start or kill work.
  assert.deepEqual(Object.keys(PUSH_ACTION_VERBS), ['allow', 'deny', 'approve']);
  for (const forbidden of ['recover', 'stop', 'freeze', 'steer', 'release', 'restart', 'dismiss', 'login']) {
    assert.equal(isPushActionVerb(forbidden), false, `${forbidden} must not be answerable from a notification`);
  }
});

test('buttons come out in the catalogue order, whatever order they went in', () => {
  // Muscle memory on a lock screen: Allow is always left of Deny.
  assert.deepEqual(notificationButtons(['deny', 'allow']), [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ]);
  assert.deepEqual(notificationButtons(['approve']), [{ action: 'approve', title: 'Approve' }]);
  assert.deepEqual(notificationButtons(['recover']), []);
});

test('the worker only presses a button the payload actually offered', () => {
  const payload = { actions: notificationButtons(['approve']), callback: 'tok' };
  assert.equal(actionOf('approve', payload), 'approve');
  // A verb the notification never carried — a stale worker, a crafted click.
  assert.equal(actionOf('allow', payload), null);
  // Tapping the body of the notification is not a press.
  assert.equal(actionOf('', payload), null);
  assert.equal(actionOf(undefined, payload), null);
});

test('a worker older than action tokens still answers an approval', () => {
  // An operator's phone can hold a subscription older than any of this. The
  // legacy payload carries only `approvalId`, and the two buttons an approval
  // has always had are synthesised from it.
  assert.deepEqual(notificationActions({ approvalId: 'a-1' }), [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ]);
  assert.equal(actionOf('allow', { approvalId: 'a-1' }), 'allow');
});

test('the callback request names no endpoint from the payload', () => {
  const { url, init } = actionRequest('tok', 'approve');
  assert.equal(url, '/api/push/action');
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>)['x-phase-console'], '1');
  assert.deepEqual(JSON.parse(String(init.body)), { token: 'tok', action: 'approve', by: 'notification' });
});

/* ------------------------------------------------------------------ *
 * 3. the mint <-> inbox agreement
 * ------------------------------------------------------------------ */

test('the ids the announcers mint are the ids the inbox will be searched by', async () => {
  // The failure this exists for has no symptom: if `service-base.ts` mints a
  // gate id one way and `server/inbox.ts` mints it another, the callback finds
  // nothing, answers 410, and the worker opens the app — exactly what it did
  // before the feature existed. Nothing is red and nothing works.
  //
  // Asserted against `inboxItemId` directly with the SAME subject each
  // producer passes, because that is the whole of the agreement.
  assert.equal(
    inboxItemId({ kind: 'gate', slug: 'demo', phase: 4 }),
    inboxItemId({ kind: 'gate', slug: 'demo', phase: 4, runId: undefined, subject: undefined }),
  );

  const approval = { id: 'ap-9', slug: 'demo', phase: 4, runId: 'run-1' };
  assert.equal(
    inboxItemId({ kind: 'approval', slug: approval.slug, phase: approval.phase, runId: approval.runId, subject: approval.id }),
    inboxItemId({ kind: 'approval', slug: 'demo', phase: 4, runId: 'run-1', subject: 'ap-9' }),
  );

  // And the producers really do use it. Read as source rather than executed:
  // building a live gated run to observe one push would be a fixture asserting
  // against itself, and the drift this catches is textual.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const base = readFileSync(fileURLToPath(new URL('../server/service-base.ts', import.meta.url)), 'utf8');
  const live = readFileSync(fileURLToPath(new URL('../server/service-live.ts', import.meta.url)), 'utf8');
  assert.match(base, /answer:\s*\{\s*\n?\s*item:\s*inboxItemId\(\{\s*\n?\s*kind:\s*'approval'/,
    'the approval announcer must mint its item id with inboxItemId');
  assert.match(live, /item:\s*inboxItemId\(\{\s*kind:\s*'gate',\s*slug,\s*phase\s*\}\)/,
    'the gate announcer must mint its item id with inboxItemId');
});

test('a review-held phase gets the notification and NOT the Approve button', async () => {
  // `gated` is also the status of a phase the console's own review hold keeps
  // back, and there is no gate on that phase to approve — the reviewer has to
  // lift their own hold. Same stop, same loudness, no button. And since
  // parallel-repaint P2 the button is for a HUMAN gate only: the inbox raises
  // a gate item for exactly those, and a button on an `ai`/`auto` gate
  // answered 410 and opened the app.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const live = readFileSync(fileURLToPath(new URL('../server/service-live.ts', import.meta.url)), 'utf8');
  assert.match(live, /const approvable = Boolean\(gate\) && gate\?\.clear === false && humanGate;/);
  // The family is the engine's — `manual`/`OVERDUE` from `--gate-status`, `human`
  // from `--gate-kind` — never the plan-vocab word alone, which production
  // never puts on a `gated` event. Same regex `runner-loop.ts` boards on.
  assert.match(live, /const humanGate = \/\^\(manual\|human\|OVERDUE\)\$\/i\.test\(gate\?\.kind \?\? ''\)/);
  assert.match(live, /\.\.\.\(approvable\s*\n?\s*\?\s*\{ answer:/);
});
