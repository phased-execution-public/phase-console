/**
 * The Restart button where nothing supervises the console — end to end.
 *
 * A real console is started in a sandbox the way `./start` or the desktop
 * launcher starts one (no launchd, no systemd), asked whether it can restart,
 * told to, and then expected back on the SAME port with the SAME flags — a
 * successor it spawned itself. Shut down then ends the successor, and nothing
 * replaces it, which is the difference between a restart and a crash loop.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sandbox, spawnConsole } from './spawn-console.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');

type Reply = { status: number; json: Record<string, unknown> };

function http(port: number, path: string, method = 'GET', body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path, method, timeout: 5_000,
      headers: {
        'x-phase-console': '1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(port: number, tries = 150): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

async function waitDown(port: number, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { await http(port, '/api/state'); } catch { return true; }
    await sleep(200);
  }
  return false;
}

/** Whoever is listening on the port — the original or its successor. `null` where lsof is not around. */
function listenerPid(port: number): number | null {
  try {
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(out.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

test('an unsupervised console restarts itself: same port, same flags, and Shut down still ends it', async (t) => {
  const port = await freePort();
  const box = sandbox('self-restart');
  // The way a terminal or the desktop launcher starts it: no supervisor at all.
  delete box.env.XPC_SERVICE_NAME;
  delete box.env.INVOCATION_ID;
  delete box.env.PHASE_CONSOLE_SUPERVISED;
  const { child } = spawnConsole(VIEWER, port, ['--allow-run'], { sandbox: box, withRoot: true });
  t.after(() => {
    // Whatever is still listening — the original or a successor the test lost — goes with the sandbox.
    const pid = listenerPid(port);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    box.cleanup();
  });

  assert.ok(await waitUp(port), 'the console came up');

  const ready = await http(port, '/api/restart');
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ok, true, JSON.stringify(ready.json));
  assert.equal(ready.json.selfRestart, true, 'nothing supervises it, so it restarts by itself');
  assert.equal((ready.json.supervisor as { kind: string }).kind, 'none');

  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const posted = await http(port, '/api/restart', 'POST', { by: 'test' });
  assert.equal(posted.status, 200, JSON.stringify(posted.json));
  assert.equal(await exited, 0, 'the original exits cleanly');

  assert.ok(await waitUp(port, 200), 'a successor came back on the same port');
  const state = await http(port, '/api/state');
  assert.equal(state.json.allowRun, true, 'the successor carries the flags the original was started with');
  const successor = listenerPid(port);
  if (successor !== null) assert.notEqual(successor, child.pid, 'a different process is serving now');
  const again = await http(port, '/api/restart');
  assert.equal(again.json.selfRestart, true, 'and it can do it again');

  // A restart is not a crash loop: Shut down ends the successor and nothing replaces it.
  const down = await http(port, '/api/shutdown', 'POST', { by: 'test', confirm: true });
  assert.equal(down.status, 200, JSON.stringify(down.json));
  assert.ok(await waitDown(port), 'the successor exited and nothing came back');
});
