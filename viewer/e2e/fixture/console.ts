/**
 * The console the browser tours: sandboxed, seeded, live, and gone when the run is.
 *
 * Playwright's `webServer` runs this as a plain Node script
 * (`node e2e/fixture/console.ts --port 4961`). It never boots `server/index.ts`
 * itself — `spawnConsole()` from `test/spawn-console.ts` is the only door, the
 * one `test/state-isolation.test.ts` holds every spawner to — so the console
 * gets temporary XDG homes and a throwaway plan library, and nothing it does
 * can reach the operator's own preferences, push devices or run history.
 *
 * In order: seed the library and the run history (`seed.ts`), put the stub
 * `claude` first on PATH (`stub-claude.mjs`), boot with `--allow-run` and
 * `--no-converge` (the live lane needs the first; the second keeps the healer
 * off the seeded halts, which are there to be LOOKED at), start one real run on
 * the toured plan, and when its lane is live write `e2e-fixture.json` into the
 * library root with `ready: true`. The specs read that file (`lib/shots.ts`
 * `fixture()`) — for the anchor their clock is fixed to, and to know the lane
 * is up before they look for it.
 */
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { environmentReport } from '../../server/env-doctor.ts';
import { sandbox, spawnConsole } from '../../test/spawn-console.ts';
import { reap } from './reap.ts';
import { seed } from './seed.ts';

const VIEWER = fileURLToPath(new URL('../..', import.meta.url));
const at = process.argv.indexOf('--port');
const port = Number(at >= 0 ? process.argv[at + 1] : 4961);

const box = sandbox('e2e');
// A tour run from inside a supervised session (the autopilot re-runs
// §Verification) must not hand that session's identity to the console it
// boots: its outcome file, its lock owner, its trace. The sandbox is a console
// of its own, answerable to nobody's run.
for (const key of Object.keys(box.env)) {
  if (/^PE_|^TRACEPARENT$|^CLAUDE_CODE_SESSION_ID$/.test(key)) delete box.env[key];
}
// The run-start prelude refuses a console with no way to announce anything
// (`probeDelivery`); the in-browser channel is enough, and it delivers nowhere.
box.env.PHASE_CONSOLE_NOTIFY = 'true';

const anchor = Math.floor(Date.now() / 60_000) * 60_000;
const info = seed(box, anchor);
const handshake = join(box.root, 'e2e-fixture.json');
const write = (extra: Record<string, unknown>): void =>
  writeFileSync(
    handshake,
    `${JSON.stringify({ ...info, stateDir: join(box.stateHome, 'phase-console'), ...extra }, null, 2)}\n`,
  );
write({ ready: false });

const bin = join(dirname(box.root), 'bin');
mkdirSync(bin, { recursive: true });
copyFileSync(fileURLToPath(new URL('./stub-claude.mjs', import.meta.url)), join(bin, 'claude'));
chmodSync(join(bin, 'claude'), 0o755);

// The console reads one quiet machine load, whatever the machine is doing
// (`steady-load.mjs`): the register must measure the same pages at load 8 and 80.
const steadyLoad = `--import=${new URL('./steady-load.mjs', import.meta.url).href}`;
// And one clean PATH, however the tour was started (control-tower phase 30).
// The console's doctor reads its own PATH (`server/env-doctor.ts`), and
// `npm run test:e2e` prepends every ancestor directory's `node_modules/.bin` —
// most of them missing, and the one beside the home directories themselves
// shaped like another account's home. Those two rows stood two more "needs
// you" cards on the Tower, so the register measured one Runs page under
// `npm run` and another under `node e2e/run.ts`, the way the baseline is
// banked. The console gets every entry the doctor has nothing to say about,
// which is the PATH a shell that never went through npm hands it.
const steadyPath = (process.env.PATH ?? '')
  .split(':')
  .filter((dir) => dir && environmentReport({ PATH: dir }).length === 0)
  .join(':');
const { child } = spawnConsole(VIEWER, port, ['--allow-run', '--no-converge'], {
  sandbox: box,
  withRoot: true,
  env: {
    PATH: `${bin}:${steadyPath}`,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, steadyLoad].filter(Boolean).join(' '),
  },
});

// The sandbox's temp directory — every process the console starts names it.
// `npm run test:e2e` (`e2e/run.ts`) is told where it is, so it can fail the run
// on anything still naming it once the tour is over (#90).
const sandboxDir = dirname(box.root);
if (process.env.PHASE_CONSOLE_E2E_ROOTS)
  appendFileSync(process.env.PHASE_CONSOLE_E2E_ROOTS, `${sandboxDir}\n`);

let ending = false;
function end(code: number): void {
  if (ending) return;
  ending = true;
  // The console first, so its own shutdown ladders its lanes; then whatever
  // it left — a lane is detached, and survives a console that died before its
  // ladder ran — reaped by process group BEFORE the directory goes (#90).
  const done = (): void => {
    void reap(sandboxDir).finally(() => {
      box.cleanup();
      process.exit(code);
    });
  };
  if (child.exitCode != null || child.signalCode != null) return done();
  child.once('exit', done);
  child.kill('SIGTERM');
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    done();
  }, 8_000).unref();
}
child.once('exit', (code) => {
  if (ending) return;
  process.stderr.write(`e2e fixture: the console exited on its own (code ${code})\n`);
  end(1);
});
process.on('SIGTERM', () => end(0));
process.on('SIGINT', () => end(0));

type Reply = { status: number; json: Record<string, unknown> };
function call(path: string, method = 'GET', body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: 10_000,
        headers: { 'x-phase-console': '1', ...(payload ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function goLive(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await call('/api/state')).status === 200) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  // The prelude's three required answers, as a person gives them at the door.
  const started = await call(`/api/run/${info.tourPlan}/start`, 'POST', {
    resumeOnRestart: true,
    relay: 'off',
    accounts: [{ id: 'default', minHeadroomPct: 0 }],
  });
  if (started.status !== 200) {
    write({
      ready: true,
      live: false,
      why: `start answered ${started.status}: ${JSON.stringify(started.json).slice(0, 400)}`,
    });
    return;
  }
  for (let i = 0; i < 300; i++) {
    const run = (await call(`/api/run/${info.tourPlan}`)).json as {
      run?: { status?: string; children?: unknown; child?: unknown };
    };
    const live =
      run.run?.status === 'running' &&
      JSON.stringify(run.run.children ?? run.run.child ?? null).includes('pid');
    if (live) return write({ ready: true, live: true });
    await sleep(100);
  }
  write({ ready: true, live: false, why: 'the run never showed a live lane' });
}
goLive().catch((err: unknown) => write({ ready: true, live: false, why: String(err) }));
