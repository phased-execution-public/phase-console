/**
 * FPR-1..3 (one-pool phase 2, #319) — `GET /api/fleet/profile` serves no
 * secret in full.
 *
 * `fleetProfileView()` returned the machine profile whole, so a read that
 * needs no flag answered the notify command (which may carry a token) and
 * every webhook URL (the whole authorisation to post to its channel) verbatim
 * — while the same view's `console.notifyCommand` was already a boolean for
 * exactly that reason, and Settings ▸ Everything already withheld both.
 *
 * FPR-1  Every `secret: true` field of `PROFILE_META` is withheld on the route
 *        — a webhook as its origin and a masked tail, anything else
 *        `[withheld]` — with `secrets.<key>.hasValue`; no token crosses the wire.
 * FPR-2  The profile's own writer still saves the full values, and every
 *        other field is served as it was.
 * FPR-3  An unset secret is said as unset, never as withheld.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { fleetProfile, updateFleetProfile } from '../shared/instances.mjs';
import { PROFILE_META } from '../shared/prefs-model.js';
import { WITHHELD } from '../server/prefs-schema.ts';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

const NOTIFY = 'curl -s https://notify.example.invalid/x?token=TOKEN123';
const HOOK = 'https://hooks.example.invalid/services/x/TOKEN456';

/** The route, asked over loopback the way a browser asks it. */
async function getProfile(service: InstanceType<typeof Service>): Promise<{ status: number; body: string }> {
  const server: Server = createServer((req, res) => {
    void handleApi({ service } as never, req, res, new URL(`http://127.0.0.1${req.url ?? '/'}`))
      .catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/fleet/profile`);
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('FPR-1 (#319): the route withholds every secret field — no notify command, no webhook URL', async () => {
  updateFleetProfile((profile) => ({
    ...profile,
    remoteHost: 'console.example.ts.net',
    notifyCommand: NOTIFY,
    webhooks: [{ url: HOOK, name: 'Team channel', categories: ['halted'] }],
  }));
  const service = new Service(flags as never);
  try {
    const view = service.fleetProfileView();
    const secretKeys = Object.entries(PROFILE_META).filter(([, meta]) => meta.secret).map(([key]) => key).sort();
    assert.deepEqual(secretKeys, ['notifyCommand', 'webhooks'], 'the fields the schema calls secret');
    assert.equal(view.profile.notifyCommand, WITHHELD);
    const hooks = view.profile.webhooks as unknown as { origin?: string; tail?: string; name?: string; url?: string }[];
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0]!.url, undefined, 'a webhook is never served by its URL');
    assert.equal(hooks[0]!.name, 'Team channel');
    assert.deepEqual(view.secrets, { notifyCommand: { hasValue: true }, webhooks: { hasValue: true } });
    assert.equal(view.console.notifyCommand, true, 'the console half says set, as it did');

    const wire = await getProfile(service);
    assert.equal(wire.status, 200, wire.body);
    for (const token of ['TOKEN123', 'TOKEN456', NOTIFY, HOOK]) {
      assert.equal(wire.body.includes(token), false, `the wire carries ${token}`);
    }
    assert.match(wire.body, /console\.example\.ts\.net/, 'what is not secret is served as it was');
  } finally {
    service.close();
  }
});

test('FPR-2 (#319): the profile\'s own writer still saves the full values', () => {
  updateFleetProfile((profile) => ({ ...profile, notifyCommand: NOTIFY, webhooks: [{ url: HOOK }] }));
  const held = fleetProfile() as unknown as { notifyCommand?: string; webhooks?: { url: string }[] };
  assert.equal(held.notifyCommand, NOTIFY, 'the machine profile holds the command');
  assert.equal(held.webhooks?.[0]?.url, HOOK, 'and the URL — the route withholds, the file keeps');
});

test('FPR-3 (#319): an unset secret is said as unset', () => {
  updateFleetProfile((profile) => {
    const next = { ...profile } as Record<string, unknown>;
    delete next.notifyCommand;
    delete next.webhooks;
    return next as typeof profile;
  });
  const service = new Service(flags as never);
  try {
    const view = service.fleetProfileView();
    assert.equal(view.profile.notifyCommand, undefined);
    assert.deepEqual(view.secrets, { notifyCommand: { hasValue: false }, webhooks: { hasValue: false } });
    assert.equal(view.console.notifyCommand, false);
  } finally {
    service.close();
  }
});
