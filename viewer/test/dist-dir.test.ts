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
import { SHOTS_DIR, STOPS, VIEWPORTS, readStamp, shotPath, type TourStamp } from '../e2e/lib/shots.ts';
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
  // Only a checkout where the tour has run has pictures; a fresh clone has none.
  if (!existsSync(SHOTS_DIR)) return t.skip('no tour has run in this checkout (npm run test:e2e)');
  // The pictures answer for THIS route table only when the tour that left them
  // was asked for these stops (#353): each viewport's `.tour.json` says what it
  // was given. A folder from a tour of another table is stale, named as such —
  // and the gate's server suite, which runs long before its e2e stage re-shoots
  // the tour, skips on it by its own flag and re-asks after that stage.
  const stale = staleViewports(STOPS.map((s) => s.name), (name) => readStamp(name));
  if (stale.length) {
    const said = `the pictures in e2e/.shots are from a tour of another route table:\n  ${stale.join('\n  ')}`;
    if (process.env.PHASE_CONSOLE_GATE_STAGE === 'server-suite')
      return t.skip(`${said}\n  (the gate's e2e stage tours this tree and asks again)`);
    assert.fail(`${said}\n  run npm run test:e2e (or test:e2e:dist) to photograph this tree's stops`);
  }
  const missing: string[] = [];
  for (const v of VIEWPORTS) {
    for (const s of STOPS) {
      const p = shotPath(v.name, s.name);
      if (!existsSync(p) || statSync(p).size === 0) missing.push(`${v.name}/${s.name}`);
    }
  }
  assert.deepEqual(missing, [], `stops the tour did not photograph:\n  ${missing.join('\n  ')}`);
});

/** Each viewport whose `.tour.json` was not a tour of `want`, in one line each (#353). */
function staleViewports(want: readonly string[], stampOf: (project: string) => TourStamp | null): string[] {
  const stale: string[] = [];
  for (const v of VIEWPORTS) {
    const stamp = stampOf(v.name);
    if (!stamp) {
      stale.push(`${v.name}: no .tour.json — the pictures predate the stamp`);
      continue;
    }
    const never = want.filter((name) => !stamp.stops.includes(name));
    const gone = stamp.stops.filter((name) => !want.includes(name));
    if (never.length || gone.length)
      stale.push(
        `${v.name}: toured ${stamp.rev ?? 'an unstamped build'} at ${stamp.at} with ${stamp.stops.length} stops — ` +
          `${never.length} of today's never in it (${never.slice(0, 4).join(', ')}${never.length > 4 ? ', …' : ''})` +
          (gone.length ? `, ${gone.length} gone since` : ''),
      );
  }
  return stale;
}

test('a viewport folder is stale exactly when its tour was given another route table', () => {
  const want = ['runs', 'turn', 'settings-accounts'];
  const at = '2026-10-13T17:30:00.000Z';
  const stamps: Record<string, TourStamp | null> = {
    'phone-360': { rev: 'e68f18ad', stops: [...want], at },
    'tablet-768': { rev: 'e68f18ad', stops: ['runs'], at },
    'desk-1024': null,
    'desk-1280': { rev: 'e68f18ad', stops: [...want, 'approve'], at },
  };
  const stale = staleViewports(want, (name) => stamps[name] ?? null);
  assert.equal(stale.length, 3, stale.join('\n'));
  assert.match(stale[0]!, /^tablet-768: toured e68f18ad .* 2 of today's never in it \(turn, settings-accounts\)$/);
  assert.match(stale[1]!, /^desk-1024: no \.tour\.json/);
  assert.match(stale[2]!, /^desk-1280: .* 0 of today's never in it \(\), 1 gone since$/);
  assert.deepEqual(staleViewports(want, () => ({ rev: null, stops: [...want].reverse(), at })), []);
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
