/**
 * The push logic, tested without a browser.
 *
 * This is the path that has never been exercised by any other test in this
 * repo, and it is the one that matters most when it breaks: a notification
 * arrives at 3am with the app closed, and either the Allow button answers the
 * approval or it does not. There is no screen to look at and nothing to retry
 * — a session simply stays parked until morning.
 *
 * It used to be untestable because it lived inside `web/sw.js`, in a global
 * scope no test runner has. `shared/sw-push.js` is the same decisions as plain
 * functions; `client/src/sw.ts` is what is left, which is listeners and awaits.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ANSWER_RECEIPTS,
  CONSOLE_HEADERS,
  MAX_NOTIFICATION_ACTIONS,
  NOTIFICATION_BADGE,
  NOTIFICATION_ICON,
  actionOf,
  actionRequest,
  answeredNotification,
  clickTarget,
  decisionOf,
  decisionRequest,
  notificationActions,
  notificationOptions,
  notificationTitle,
  parsePayload,
  readRequest,
  resubscribeRequest,
} = await import('../shared/sw-push.js');

const ORIGIN = 'http://127.0.0.1:4123';

/* ---------------- the payload ---------------- */

test('a push with no payload still has something to show', () => {
  // iOS counts a push that shows no notification against the app's standing,
  // so "nothing to show" must not be a reachable state.
  for (const empty of [null, undefined, '', '   ']) {
    const data = parsePayload(empty as string | null);
    assert.deepEqual(data, {});
    assert.equal(notificationTitle(data), 'Phase Console');
    assert.equal(notificationOptions(data).body, 'Something needs you.');
  }
});

test('a malformed payload degrades to the default rather than throwing', () => {
  // A throw here is not an error message — it is a push that shows nothing.
  for (const junk of ['{', 'null', '[1,2]', '"a string"', '42']) {
    assert.deepEqual(parsePayload(junk), {});
  }
});

test('a real payload is carried through to the notification', () => {
  const data = parsePayload(JSON.stringify({
    title: 'Approval needed',
    body: 'Bash(git push:*)',
    tag: 'approval-7',
    url: '/#/plan/cart-api-endpoint/run',
    category: 'approval',
    approvalId: 'a7',
    notificationId: 'n9',
  }));
  assert.equal(notificationTitle(data), 'Approval needed');
  const options = notificationOptions(data);
  assert.equal(options.body, 'Bash(git push:*)');
  assert.equal(options.tag, 'approval-7');
  assert.deepEqual(options.data, {
    url: '/#/plan/cart-api-endpoint/run',
    category: 'approval',
    approvalId: 'a7',
    notificationId: 'n9',
    // An approval carries Allow/Deny even from a server that sends no explicit
    // list, and this payload has no token — so the buttons are the synthesised
    // pair and there is nothing for a callback to answer.
    actions: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }],
    callback: null,
  });
});

test('the same tag replaces rather than stacks, and never re-alerts', () => {
  const options = notificationOptions(parsePayload('{}'));
  assert.equal(options.tag, 'phase-console');
  assert.equal((options as { renotify?: boolean }).renotify, false);
});

test('only an approval gets buttons', () => {
  const withApproval = notificationOptions({ approvalId: 'a1' });
  assert.deepEqual((withApproval as { actions?: unknown }).actions, [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ]);
  // A plain announcement has nothing to answer, so offering a yes and a no
  // would be offering to decide something that does not exist.
  assert.equal((notificationOptions({}) as { actions?: unknown }).actions, undefined);
});

test('the badge is the monochrome mark, not the full-colour icon', () => {
  // Android masks the badge to its alpha channel; a colour icon there is a
  // grey blob, which is how this was wrong before.
  const options = notificationOptions({});
  assert.equal(options.icon, NOTIFICATION_ICON);
  assert.equal(options.badge, NOTIFICATION_BADGE);
  assert.notEqual(NOTIFICATION_BADGE, NOTIFICATION_ICON);
});

/* ---------------- the click ---------------- */

test('only the two action buttons are an answer', () => {
  assert.equal(decisionOf('allow'), 'allow');
  assert.equal(decisionOf('deny'), 'deny');
  // Tapping the body of the notification opens the queue; it does not decide.
  assert.equal(decisionOf(''), null);
  assert.equal(decisionOf(undefined), null);
  assert.equal(decisionOf('Allow'), null);
});

test('a click lands on the URL the payload asked for', () => {
  assert.equal(clickTarget({ url: '/#/ready' }, ORIGIN), `${ORIGIN}/#/ready`);
  assert.equal(clickTarget({}, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget(null, ORIGIN), `${ORIGIN}/`);
});

test('a click can never leave this origin', () => {
  // The one deliberate deviation from web/sw.js. Every real payload is
  // relative, so nothing legitimate changes — but a notification that can open
  // an arbitrary site is a bigger promise than a local console needs to make.
  assert.equal(clickTarget({ url: 'https://example.com/x' }, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget({ url: '//example.com/x' }, ORIGIN), `${ORIGIN}/`);
  assert.equal(clickTarget({ url: 'javascript:alert(1)' }, ORIGIN), `${ORIGIN}/`);
});

/* ---------------- the requests ---------------- */

test('every mutation carries the header the server refuses to work without', () => {
  // Same-origin plus this header is the console's CSRF guard; a request from
  // the worker that omits it is refused, and the refusal looks like the run
  // having ended.
  for (const { init } of [
    decisionRequest('a1', 'allow'),
    readRequest('n1')!,
    resubscribeRequest({ endpoint: 'https://push.example/x' }),
  ]) {
    assert.equal((init.headers as Record<string, string>)['x-phase-console'], '1');
    assert.equal((init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal(init.method, 'POST');
  }
});

test('the decision request names the approval and says where it came from', () => {
  const { url, init } = decisionRequest('a 7/8', 'deny');
  // Encoded: an id is server-generated, but a path built by concatenation is
  // one surprising id away from addressing a different endpoint.
  assert.equal(url, '/api/approvals/a%207%2F8');
  assert.deepEqual(JSON.parse(String(init.body)), { decision: 'deny', by: 'notification' });
});

test('there is nothing to mark read when the payload carried no notification', () => {
  assert.equal(readRequest(null), null);
  assert.equal(readRequest(undefined), null);
  assert.equal(readRequest(''), null);
  assert.deepEqual(JSON.parse(String(readRequest('n1')!.init.body)), { ids: ['n1'] });
});

test('the receipt after an answered approval says which way it went', () => {
  const [allowTitle, allow] = answeredNotification('allow', { approvalId: 'a1', url: '/#/runs' });
  assert.equal(allowTitle, 'Phase Console');
  assert.match(String(allow.body), /Allowed/);
  // Its own tag, so it replaces nothing and is replaced by nothing.
  assert.equal(allow.tag, 'answered-a1');
  assert.deepEqual(allow.data, { url: '/#/runs' });

  const [, deny] = answeredNotification('deny', { approvalId: 'a1' });
  assert.match(String(deny.body), /Denied/);
});

test('a rotated subscription re-registers under a label that says so', () => {
  const { url, init } = resubscribeRequest({ endpoint: 'https://push.example/x' });
  assert.equal(url, '/api/push/subscribe');
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body.subscription, { endpoint: 'https://push.example/x' });
  // The device row is identified by endpoint, but a human reading the device
  // list needs to know this one re-registered itself.
  assert.match(body.label, /re-registered/);
});

test('the console headers are frozen — one object, shared by every request', () => {
  assert.equal(Object.isFrozen(CONSOLE_HEADERS), true);
  // Each request spreads a copy, so a caller cannot mutate the shared one.
  const { init } = decisionRequest('a1', 'allow');
  (init.headers as Record<string, string>)['x-phase-console'] = 'tampered';
  assert.equal(CONSOLE_HEADERS['x-phase-console'], '1');
});

/* ------------------------------------------------------------------ *
 * Action buttons a server chose, and the callback that answers them
 * ------------------------------------------------------------------ */

test('an explicit action list beats the approval fallback, because the token authorised it', () => {
  // A payload can carry both — an approval push still sends `approvalId` so a
  // worker older than tokens can answer it. When both are present the explicit
  // list wins: it is the one the token beside it was minted for.
  const options = notificationOptions({
    approvalId: 'a1',
    actions: [{ action: 'approve', title: 'Approve' }],
    callback: 'tok',
  });
  assert.deepEqual((options as { actions?: unknown }).actions, [{ action: 'approve', title: 'Approve' }]);
});

test('the buttons and the token are carried onto the notification, or the click cannot use them', () => {
  // `notificationclick` fires with only `event.notification`. Anything not
  // copied into `data` here is gone by the time a button is pressed, which may
  // be hours later — and the failure is silent: the button renders and does
  // nothing.
  const data = (notificationOptions({
    actions: [{ action: 'approve', title: 'Approve' }],
    callback: 'tok',
  }) as { data: Record<string, unknown> }).data;
  assert.deepEqual(data.actions, [{ action: 'approve', title: 'Approve' }]);
  assert.equal(data.callback, 'tok');
});

test('a malformed action list produces NO buttons rather than a partial row', () => {
  for (const actions of [[], [{ action: '', title: 'x' }], [{ action: 'ok' }], 'nope', 7, null]) {
    assert.equal(
      notificationActions({ actions } as never), undefined,
      `${JSON.stringify(actions)} produced buttons`,
    );
  }
  // …and more than a platform renders is truncated, not dropped.
  const many = notificationActions({
    actions: [{ action: 'a', title: 'A' }, { action: 'b', title: 'B' }, { action: 'c', title: 'C' }],
  } as never) as unknown[];
  assert.equal(many.length, MAX_NOTIFICATION_ACTIONS);
});

test('only a button the payload offered counts as a press', () => {
  const data = { actions: [{ action: 'approve', title: 'Approve' }], callback: 'tok' };
  assert.equal(actionOf('approve', data), 'approve');
  assert.equal(actionOf('allow', data), null, 'a verb this notification never carried');
  assert.equal(actionOf('', data), null, 'tapping the body is not a press');
  assert.equal(actionOf('approve', {}), null, 'a payload with no buttons has no presses');
});

test('the callback request carries the token and nothing routable', () => {
  const { url, init } = actionRequest('tok', 'approve');
  assert.equal(url, '/api/push/action');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { ...CONSOLE_HEADERS });
  assert.deepEqual(JSON.parse(String(init.body)), { token: 'tok', action: 'approve', by: 'notification' });
  // The property the whole design rests on: nothing in this request says where
  // to go except the one fixed route.
  assert.doesNotMatch(String(init.body), /https?:|\/api\/(?!push\/action)/);
});

test('every answerable verb has a receipt, and an unknown one still gets words', () => {
  for (const verb of ['allow', 'deny', 'approve']) {
    assert.ok(ANSWER_RECEIPTS[verb], `${verb} has no receipt`);
    assert.match(String(answeredNotification(verb, { approvalId: null })[1].body), /\w/);
  }
  assert.equal(String(answeredNotification('approve', { approvalId: null })[1].body),
    ANSWER_RECEIPTS.approve);
  // A newer server sending a verb this worker has never heard of still landed
  // an answer; silence would be the worst report of that.
  assert.equal(String(answeredNotification('teleport', { approvalId: null })[1].body), 'Answered.');
  // With no approval id the tag falls back to the verb, so a double-tap still
  // collapses to one receipt instead of stacking `answered-undefined`.
  assert.equal(answeredNotification('approve', { approvalId: null })[1].tag, 'answered-approve');
});
