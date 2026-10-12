/**
 * `GET /api/doctor/strays` (quiet-console phase 25, §Architecture 5): the
 * console processes on this machine whose code is gone (`bin/stray-consoles.mjs`
 * — #155's scan), LISTED for Logs ▸ Health. Stopping one stays the CLI's
 * (`phase-console doctor --stop-strays`): a page signalling processes it did
 * not start is not a read, and the answer names the line instead.
 *
 * Above the "no source directory" wall, and branched BEFORE `doctor`, whose
 * GET answers any path under its head — the property a later refactor could
 * quietly take away by moving the block down.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bareService, call } from './thin-read-harness.ts';

/** `ps -axo pid=,pgid=,command=` as the scan reads it: two console servers and a bystander. */
const PS = [
  '  4101  4101 /usr/local/bin/node /gone/pkg/viewer/server/index.ts --root /tmp/lib --port 4190',
  '  4102  4102 /usr/local/bin/node /kept/pkg/viewer/server/index.ts --port 4191',
  '  4103  4103 /bin/zsh -l',
].join('\n');

/** The service's own `strayConsoles`, over a listing and a filesystem the test owns. */
function scanning<T extends { strayConsoles: (scan?: { psText?: string; exists?: (path: string) => boolean }) => Promise<unknown> }>(
  svc: T,
): T {
  const real = svc.strayConsoles.bind(svc);
  svc.strayConsoles = () => real({ psText: PS, exists: (path: string) => path === '/kept/pkg' }) as never;
  return svc;
}

test('GET /api/doctor/strays answers with no source directory open, listing the stray and naming the line that stops it', async () => {
  const svc = scanning(await bareService());
  try {
    const out = await call(svc, 'GET', '/api/doctor/strays');
    assert.equal(out.status, 200);
    assert.equal(typeof out.body.at, 'string');
    assert.deepEqual(out.body.strays, [
      { pid: 4101, pgid: 4101, command: '/usr/local/bin/node /gone/pkg/viewer/server/index.ts --root /tmp/lib --port 4190', root: '/gone/pkg' },
    ], 'the console whose package root is gone — not the live one, not the shell');
    assert.equal(out.body.stop, 'phase-console doctor --stop-strays');
  } finally {
    svc.close();
  }
});

test('the strays route answers its path, not the doctor reading a path under its head — and nothing stops a stray through it', async () => {
  const svc = scanning(await bareService());
  try {
    const strays = await call(svc, 'GET', '/api/doctor/strays');
    assert.ok(Array.isArray(strays.body.strays), 'the strays route, not the doctor answering a path under its head');
    assert.ok(!('rows' in strays.body) && !('checks' in strays.body));
    // No press stops a stray through the console: the route lists, and that is all it serves.
    const press = await call(svc, 'POST', '/api/doctor/strays', {});
    assert.notEqual(press.status, 200);
    assert.ok(!Array.isArray(press.body.strays));
  } finally {
    svc.close();
  }
});

test("the real scan reads this machine's process list, read-only", async () => {
  const svc = await bareService();
  try {
    const out = await call(svc, 'GET', '/api/doctor/strays');
    assert.equal(out.status, 200);
    assert.ok(Array.isArray(out.body.strays));
    for (const stray of out.body.strays as { pid: number; root: string }[]) {
      assert.notEqual(stray.pid, process.pid, 'never this process');
      assert.equal(typeof stray.root, 'string');
    }
  } finally {
    svc.close();
  }
});
