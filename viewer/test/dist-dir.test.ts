/**
 * `PHASE_CONSOLE_DIST_DIR` — which built client a console serves.
 *
 * The real-browser harness (`e2e/`) tours the client through Vite today; the
 * knob is what lets it tour a PRODUCTION build instead — the real CSP, the real
 * service worker — without building into `client/dist`, which a runtime copy
 * serves per request and which no test may touch. So the knob has to move every
 * reader of the built client together: what is served, and the stamp it
 * reports.
 *
 * And the tour's own promise, held here because a node test is what runs after
 * it: every stop `e2e/lib/shots.ts` derives from `shared/route-meta.js` left
 * its picture in every viewport.
 */
import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { VIEWER_DIR } from '../server/config.ts';
import { SHOTS_DIR, STOPS, VIEWPORTS, shotPath } from '../e2e/lib/shots.ts';
import { spawnConsole } from './spawn-console.ts';

test('PHASE_CONSOLE_DIST_DIR redirects the served client and its stamp', async (t) => {
  const dist = mkdtempSync(join(tmpdir(), 'phase-console-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>knob</title><p>served from the knob</p>\n');
  writeFileSync(join(dist, '.build-rev'), 'knob0000\n');
  const port = await freePort();
  const { child, box } = spawnConsole(VIEWER_DIR, port, [], { env: { PHASE_CONSOLE_DIST_DIR: dist } });
  t.after(() => {
    child.kill('SIGKILL');
    box.cleanup();
    rmSync(dist, { recursive: true, force: true });
  });
  assert.ok(await up(port), 'the console never answered');

  const page = await call(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /served from the knob/, 'the console served some other client');
  const state = JSON.parse((await call(port, '/api/state')).body) as { distRev?: string | null };
  assert.equal(state.distRev, 'knob0000', 'the stamp was read from somewhere else');
});

test('the tour left one picture per stop in every viewport', (t) => {
  // Only a checkout where the tour has run has pictures; the server suite runs
  // long before the e2e stage in `gates.sh`, and a fresh clone has none.
  if (!existsSync(SHOTS_DIR)) return t.skip('no tour has run in this checkout (npm run test:e2e)');
  const missing: string[] = [];
  for (const v of VIEWPORTS) {
    for (const s of STOPS) {
      const p = shotPath(v.name, s.name);
      if (!existsSync(p) || statSync(p).size === 0) missing.push(`${v.name}/${s.name}`);
    }
  }
  assert.deepEqual(missing, [], `stops the tour did not photograph:\n  ${missing.join('\n  ')}`);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function call(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function up(port: number, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await call(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
