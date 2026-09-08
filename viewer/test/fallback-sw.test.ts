/**
 * The EMERGENCY service worker, held to the shared push module.
 *
 * `server/fallback-sw.js` is what `/sw.js` answers with when there is no build
 * — the "deleted dist" state, and the few seconds mid-build when `dist/` has
 * been emptied and not yet rewritten. It matters because a registered service
 * worker whose script URL 404s is UNREGISTERED by the browser, and every push
 * subscription bound to it dies silently. So this file must always load.
 *
 * That is also why it cannot `import` from `shared/sw-push.js` the way
 * `client/src/sw.ts` does: `lib/pwa.ts` registers `/sw.js` without
 * `type: 'module'`, so it is a CLASSIC worker and an `import` statement there
 * is a syntax error — which would take the registration, and the subscriptions,
 * down with it. It restates the shared decisions instead.
 *
 * A hand-copy with nothing watching it is exactly how it drifted: the click
 * target lost the origin clamp that `shared/sw-push.js` documents as a
 * deliberate hardening, and the Android status-bar badge was pointed at the
 * full-colour icon, which the shared module names as producing a grey blob.
 * Neither was caught, because this file had no test of its own.
 *
 * This is that test. It loads the worker into a fabricated worker scope and
 * asserts its BEHAVIOUR equals the shared module's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const SW_SRC = fileURLToPath(new URL('../server/fallback-sw.js', import.meta.url));
const SOURCE = readFileSync(SW_SRC, 'utf8');

const {
  ANSWER_RECEIPTS, MAX_NOTIFICATION_ACTIONS, NOTIFICATION_BADGE, NOTIFICATION_ICON,
  actionOf, clickTarget, notificationActions,
} = await import('../shared/sw-push.js');

const ORIGIN = 'http://127.0.0.1:4123';

type Handlers = Record<string, (event: unknown) => void>;

/** The worker's own restatements of the shared push decisions. */
type Own = {
  NOTIFICATION_ICON: string;
  NOTIFICATION_BADGE: string;
  clickTarget: (info: unknown, origin: string) => string;
  MAX_NOTIFICATION_ACTIONS: number;
  ANSWER_RECEIPTS: Record<string, string>;
  notificationActions: (data: unknown) => unknown;
  actionOf: (action: unknown, data: unknown) => string | null;
};

/**
 * Load the worker into a fabricated `self`, and hand back what it registered.
 *
 * The trailing assignment is the harness's one liberty: a top-level `const` in
 * a script lives in that script's LEXICAL scope, not on the context's global,
 * so there is otherwise no way to read the worker's own constants and prove
 * they are the shared module's values. The file on disk is untouched.
 */
function loadWorker(): { handlers: Handlers; scope: Record<string, unknown>; own: Own } {
  const handlers: Handlers = {};
  const self = {
    addEventListener: (name: string, fn: (event: unknown) => void) => {
      handlers[name] = fn;
    },
    skipWaiting: () => {},
    clients: { claim: () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: () => {}, pushManager: { subscribe: async () => ({}) } },
    location: { origin: ORIGIN },
  };
  const scope: Record<string, unknown> = { self, URL, fetch: async () => ({ ok: true }), console };
  scope.globalThis = scope;
  const EXPORT = '\n;globalThis.__own = { NOTIFICATION_ICON, NOTIFICATION_BADGE, clickTarget,'
    + ' MAX_NOTIFICATION_ACTIONS, ANSWER_RECEIPTS, notificationActions, actionOf };';
  runInNewContext(SOURCE + EXPORT, scope, { filename: SW_SRC });
  return { handlers, scope, own: scope.__own as Own };
}

test('it is a CLASSIC script — no import statement, or the registration dies', () => {
  // Not a style rule. `lib/pwa.ts` registers this without `type: 'module'`; an
  // `import` here is a syntax error, the worker never installs, and the browser
  // unregisters it along with the push subscriptions it carries.
  assert.doesNotMatch(SOURCE, /^\s*import\s/m, 'fallback-sw.js must not use ESM imports');
  assert.doesNotMatch(SOURCE, /^\s*export\s/m, 'fallback-sw.js must not use ESM exports');
  // And it must parse as a script in a bare context, which loading it proves.
  assert.doesNotThrow(() => loadWorker());
});

test('it registers the five listeners that ARE its whole job', () => {
  const { handlers } = loadWorker();
  assert.deepEqual(
    Object.keys(handlers).sort(),
    ['activate', 'install', 'notificationclick', 'push', 'pushsubscriptionchange'].sort(),
  );
});

test('its icon and badge are the shared module’s, not a full-colour blob', () => {
  const { own } = loadWorker();
  assert.equal(own.NOTIFICATION_ICON, NOTIFICATION_ICON);
  assert.equal(own.NOTIFICATION_BADGE, NOTIFICATION_BADGE);
  assert.notEqual(NOTIFICATION_BADGE, NOTIFICATION_ICON, 'the badge is a MASK, so it is its own asset');
  // And nothing in the file still points a badge at the colour icon by hand.
  assert.doesNotMatch(SOURCE, /badge:\s*'\/icons\/icon-192\.png'/);
});

test('its click target is clamped to this origin, exactly as the shared one is', () => {
  const ownClickTarget = loadWorker().own.clickTarget;
  assert.equal(typeof ownClickTarget, 'function', 'fallback-sw.js defines clickTarget');

  const cases: Array<{ url?: string } | null | undefined> = [
    undefined,
    null,
    {},
    { url: '/' },
    { url: '/#/plan/demo/run' },
    { url: '#/now' },
    // The ones that matter: an absolute URL somewhere else must NOT be opened.
    { url: 'https://evil.example/steal' },
    { url: 'http://127.0.0.1:9999/other-console' },
    { url: '//evil.example/protocol-relative' },
    { url: 'javascript:alert(1)' },
    { url: '::::not a url::::' },
  ];
  for (const info of cases) {
    assert.equal(
      ownClickTarget(info, ORIGIN),
      clickTarget(info, ORIGIN),
      `clickTarget disagrees for ${JSON.stringify(info)}`,
    );
  }
  // Stated once positively, so the guarantee is legible without the diff.
  assert.equal(ownClickTarget({ url: 'https://evil.example/steal' }, ORIGIN), `${ORIGIN}/`);
});

/**
 * …and the handler must actually USE it.
 *
 * Asserting the helper alone proves nothing: the defect was never a wrong
 * `clickTarget`, it was a `notificationclick` that built its own URL and never
 * called one. (Verified: reverting the call site while leaving the function in
 * place kept the test above green.) So this drives the real listener.
 */
test('clicking a notification whose url points elsewhere opens THIS console', async () => {
  for (const target of ['https://evil.example/steal', '//evil.example/x', 'http://127.0.0.1:9999/other']) {
    const { handlers, scope } = loadWorker();
    const opened: string[] = [];
    const navigated: string[] = [];
    const self = scope.self as {
      clients: {
        matchAll: () => Promise<unknown[]>;
        openWindow: (url: string) => Promise<void>;
      };
    };
    self.clients.openWindow = async (url: string) => void opened.push(url);

    let settled: unknown;
    handlers.notificationclick({
      notification: { close: () => {}, data: { url: target } },
      action: '',
      waitUntil: (p: unknown) => (settled = p),
    });
    await settled;

    assert.deepEqual(navigated, []);
    assert.deepEqual(opened, [`${ORIGIN}/`], `a click on ${target} must stay on this origin`);
  }
});

test('clicking a notification with a real in-app url opens exactly that', async () => {
  const { handlers, scope } = loadWorker();
  const opened: string[] = [];
  const self = scope.self as { clients: { openWindow: (url: string) => Promise<void> } };
  self.clients.openWindow = async (url: string) => void opened.push(url);

  let settled: unknown;
  handlers.notificationclick({
    notification: { close: () => {}, data: { url: '/#/plan/demo/run' } },
    action: '',
    waitUntil: (p: unknown) => (settled = p),
  });
  await settled;

  assert.deepEqual(opened, [`${ORIGIN}/#/plan/demo/run`]);
});

test('a push with no payload still shows something', () => {
  // iOS counts a push that shows no notification against the app's standing,
  // so "nothing to show" must not be reachable — the same rule sw-push.js keeps.
  const { handlers, scope } = loadWorker();
  const shown: Array<[string, Record<string, unknown>]> = [];
  const self = scope.self as { registration: { showNotification: (t: string, o: object) => void } };
  self.registration.showNotification = (title, options) =>
    void shown.push([title, options as Record<string, unknown>]);

  handlers.push({ data: null, waitUntil: (p: unknown) => p });
  assert.equal(shown.length, 1);
  const [title, options] = shown[0];
  assert.ok(title.length > 0);
  assert.ok(String(options.body).length > 0);
  assert.equal(options.icon, NOTIFICATION_ICON);
  assert.equal(options.badge, NOTIFICATION_BADGE);
});

test('an approval push carries Allow and Deny; an ordinary one carries neither', () => {
  const { handlers, scope } = loadWorker();
  const shown: Array<Record<string, unknown>> = [];
  const self = scope.self as { registration: { showNotification: (t: string, o: object) => void } };
  self.registration.showNotification = (_title, options) =>
    void shown.push(options as Record<string, unknown>);

  handlers.push({
    data: { json: () => ({ title: 'Phase 7', body: 'may I edit', approvalId: 'a1' }) },
    waitUntil: (p: unknown) => p,
  });
  // JSON round-trip: the worker runs in its own vm realm, so its objects have
  // a different `Object.prototype` and `deepStrictEqual` refuses them even
  // when they are structurally identical.
  assert.deepEqual(JSON.parse(JSON.stringify(shown[0].actions)), [
    { action: 'allow', title: 'Allow' },
    { action: 'deny', title: 'Deny' },
  ]);

  handlers.push({ data: { json: () => ({ title: 'done' }) }, waitUntil: (p: unknown) => p });
  assert.equal(shown[1].actions, undefined);
});

/* ------------------------------------------------------------------ *
 * The action buttons, restated
 * ------------------------------------------------------------------ *
 *
 * The same reason the icon and the click clamp are held here: this file cannot
 * import the shared module, so every decision it restates is a copy that can
 * drift. These are the four the action-callback feature added.
 */

test('its action decisions equal the shared module’s, payload for payload', () => {
  const { own } = loadWorker();
  assert.equal(own.MAX_NOTIFICATION_ACTIONS, MAX_NOTIFICATION_ACTIONS);
  // Compared as JSON, not as objects: the worker is loaded into a separate VM
  // realm, so its `Object.prototype` is a different one and `deepStrictEqual`
  // fails on two byte-identical tables. The VALUES are the contract.
  assert.equal(JSON.stringify(own.ANSWER_RECEIPTS), JSON.stringify(ANSWER_RECEIPTS));

  const payloads: unknown[] = [
    {},
    { approvalId: 'a-1' },
    { actions: [{ action: 'approve', title: 'Approve' }] },
    { actions: [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }] },
    // The cap, the junk, and the shapes that must produce NO buttons rather
    // than a partial row.
    { actions: [{ action: 'a', title: 'A' }, { action: 'b', title: 'B' }, { action: 'c', title: 'C' }] },
    { actions: [{ action: '', title: 'x' }] },
    { actions: [{ action: 'ok' }] },
    { actions: [] },
    { actions: 'nope' },
    // A payload carrying BOTH: the explicit list wins, because the server that
    // sent it authorised exactly those verbs in the token beside it.
    { approvalId: 'a-1', actions: [{ action: 'approve', title: 'Approve' }] },
  ];
  for (const data of payloads) {
    assert.equal(
      JSON.stringify(own.notificationActions(data) ?? null),
      JSON.stringify(notificationActions(data as never) ?? null),
      `notificationActions disagrees for ${JSON.stringify(data)}`,
    );
  }

  for (const [action, data] of [
    ['approve', { actions: [{ action: 'approve', title: 'Approve' }] }],
    ['allow', { actions: [{ action: 'approve', title: 'Approve' }] }],
    ['allow', { approvalId: 'a-1' }],
    ['', { approvalId: 'a-1' }],
    [undefined, { approvalId: 'a-1' }],
    ['approve', {}],
  ] as const) {
    assert.equal(
      own.actionOf(action, data),
      actionOf(action as never, data as never),
      `actionOf disagrees for ${JSON.stringify([action, data])}`,
    );
  }
});

/**
 * …and, as with `clickTarget`, the handler must actually USE it.
 *
 * A correct `actionOf` beside a `notificationclick` that posts whatever
 * `event.action` says is the same defect this file exists for, one layer up.
 */
test('a button the notification never offered posts nothing', async () => {
  const { handlers, scope } = loadWorker();
  const posted: string[] = [];
  scope.fetch = async (url: string) => { posted.push(url); return { ok: true }; };

  const notification = {
    close: () => {},
    data: {
      url: '/#/now',
      approvalId: null,
      notificationId: null,
      actions: [{ action: 'approve', title: 'Approve' }],
      callback: 'tok',
    },
  };
  const waits: Promise<unknown>[] = [];
  (handlers.notificationclick as (e: unknown) => void)({
    notification,
    action: 'allow',                       // never offered by this notification
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  assert.deepEqual(posted, [], 'a verb the payload did not carry must not reach the server');
});

test('a pressed button posts the TOKEN, never an endpoint from the payload', async () => {
  const { handlers, scope } = loadWorker();
  const posted: { url: string; body: unknown }[] = [];
  scope.fetch = async (url: string, init: { body?: string }) => {
    posted.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true };
  };

  const waits: Promise<unknown>[] = [];
  (handlers.notificationclick as (e: unknown) => void)({
    notification: {
      close: () => {},
      data: {
        url: '/#/plan/demo/phase/4',
        approvalId: null,
        notificationId: null,
        actions: [{ action: 'approve', title: 'Approve' }],
        callback: 'signed-token',
      },
    },
    action: 'approve',
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);

  assert.deepEqual(posted, [{
    url: '/api/push/action',
    body: { token: 'signed-token', action: 'approve', by: 'notification' },
  }]);
});

test('a payload from a server older than action tokens still answers its card', async () => {
  // An operator's phone can hold a subscription older than the whole feature.
  const { handlers, scope } = loadWorker();
  const posted: string[] = [];
  scope.fetch = async (url: string) => { posted.push(url); return { ok: true }; };

  const waits: Promise<unknown>[] = [];
  (handlers.notificationclick as (e: unknown) => void)({
    notification: {
      close: () => {},
      data: { url: '/#/plan/demo/run', approvalId: 'ap-7', notificationId: null },
    },
    action: 'deny',
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  assert.deepEqual(posted, ['/api/approvals/ap-7']);
});
