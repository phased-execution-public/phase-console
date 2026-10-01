/**
 * The boot marker: how the console before this one ended, decided without
 * reading its log.
 *
 * The verdict used to be a read of the console's own log — the whole file,
 * walked back at most 400 lines for a `start` with no `exit` after it. A busy
 * console writes ~350 lines an hour, so one that died after an hour or so of
 * uptime had already pushed its own `start` out of reach: the answer came back
 * "nothing to conclude", and the crash ledger, its inbox row and the breaker
 * never heard of the crash. And a duplicate launch the port refused wrote its
 * own start/exit pair into the same log, which reads as a clean ending of the
 * console that was still running.
 *
 *   **BM-1** — a real console killed after 10,000 log lines is on the ledger at
 *   the next boot. The one case here that boots consoles, because it is the only
 *   one that can prove the entry point writes the marker once it owns the port,
 *   settles it at the next boot, and removes it at a clean exit.
 *
 *   **BM-2** — a clean exit takes its marker with it, and the next boot records
 *   nothing.
 *
 *   **BM-3** — a launch the port refused never owned it: it records nothing,
 *   leaves the live console's marker alone, and masks no later crash.
 *
 *   **BM-4, BM-5** — identity and races: a pid is not a process, and a dead
 *   console's marker is counted once however many launches find it.
 *
 * The unit cases settle markers against REAL processes — a child that is still
 * running, one that has exited, one killed mid-test — so the probe they meet is
 * the one a booting console asks.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { VIEWER_DIR } from '../server/config.ts';
import {
  bootMarkerDir,
  crashLedgerFile,
  readBootMarkers,
  readCrashLedger,
  releaseBootMarker,
  settleBootMarkers,
  writeBootMarker,
} from '../server/crash-ledger.ts';
import type { Entry } from '../server/log.ts';
import { sandbox, spawnConsole } from './spawn-console.ts';

const dirs: string[] = [];
const children: ChildProcess[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'boot-marker-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A process that is running — a console holding its port, as far as the probe can tell. */
function running(): { child: ChildProcess; pid: number; startedAt: string } {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  children.push(child);
  return { child, pid: child.pid!, startedAt };
}

/** A process that has exited and been reaped — a console that is gone. */
function exited(): { pid: number; startedAt: string } {
  const startedAt = new Date().toISOString();
  const { pid } = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return { pid, startedAt };
}

/** SIGKILL, and wait until the pid is really gone — reaped, not a zombie. */
async function killHard(child: ChildProcess): Promise<void> {
  const gone = once(child, 'exit');
  child.kill('SIGKILL');
  await gone;
}

const markerText = (dir: string, pid: number): string =>
  readFileSync(join(bootMarkerDir(dir), `${pid}.json`), 'utf8');

/* ------------------------------------------------------------------ *
 * BM-1 — a real console, 10,000 lines, a refused duplicate, a kill
 * ------------------------------------------------------------------ */

test('BM-1: a console killed after 10,000 log lines is on the ledger at the next boot', async (t) => {
  const box = sandbox('boot-marker');
  // One log for every launch, as on a real machine: the shared file is where a
  // refused duplicate's start/exit pair used to pass for a clean ending.
  const logFile = join(box.stateHome, 'console.log');
  // The first console a fresh sandbox starts adopts the machine as its default
  // instance, and the default keeps the flat state directory.
  const instanceDir = join(box.stateHome, 'phase-console');
  const markers = bootMarkerDir(instanceDir);
  const port = await freePort();
  const consoles: ChildProcess[] = [];
  const launch = (stdio: 'ignore' | 'pipe' = 'ignore'): ChildProcess => {
    const { child } = spawnConsole(VIEWER_DIR, port, ['--log-file', logFile], { sandbox: box, withRoot: true, stdio });
    consoles.push(child);
    return child;
  };
  t.after(() => {
    for (const child of consoles) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    box.cleanup();
  });

  const first = launch();
  assert.ok(await up(port), 'the first console never answered');
  assert.deepEqual(readdirSync(markers), [`${first.pid}.json`], 'a console that owns its port says so on disk');

  // A day of a busy console, compressed: each request writes one line, and the
  // `start` the old verdict walked back to ends up 10,000 lines behind.
  await flood(port, 10_000);
  const after = linesAfterStart(readLog(logFile), first.pid!);
  assert.ok(after >= 10_000, `the console logged ${after} lines after its start`);

  // A duplicate the port refuses. It writes its own start and exit into the
  // same log — the pair that read as a clean ending — and nothing else.
  const before = readFileSync(join(markers, `${first.pid}.json`), 'utf8');
  const duplicate = launch('pipe');
  let said = '';
  duplicate.stdout?.resume();
  duplicate.stderr?.setEncoding('utf8');
  duplicate.stderr?.on('data', (chunk: string) => { said += chunk; });
  const [refusedWith] = await withTimeout(once(duplicate, 'exit'), 30_000, 'the duplicate never gave up the port');
  assert.equal(refusedWith, 1);
  assert.match(said, /already in use/);
  assert.equal(readFileSync(join(markers, `${first.pid}.json`), 'utf8'), before,
    "the live console's marker is untouched");
  assert.deepEqual(readdirSync(markers), [`${first.pid}.json`], 'and the refused launch wrote none of its own');
  assert.equal(existsSync(crashLedgerFile(instanceDir)), false, 'and recorded nothing');
  assert.ok(readLog(logFile).some((entry) => entry.event === 'exit' && entry.data?.reason === 'port-in-use'),
    'its exit record is in the shared log, where it used to mask what came next');

  // The first console dies hard: no exit record, no chance to say anything.
  await killHard(first);

  const second = launch();
  assert.ok(await up(port), 'the second console never answered');
  const ledger = readCrashLedger(instanceDir);
  assert.equal(ledger.length, 1, 'exactly one hard ending — the killed console, never the refused one');
  assert.equal(ledger[0].pid, second.pid, 'stamped by the boot that noticed it, which is what its inbox row keys on');
  assert.deepEqual(readdirSync(markers), [`${second.pid}.json`],
    "the dead console's marker is consumed, and the new owner has its own");

  const entries = readLog(logFile);
  const warned = entries.filter((entry) => entry.event === 'previous-run-crashed');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].data?.pid, first.pid, 'the warning names the console that ended');
  const booted = entries.find((entry) => entry.event === 'start' && entry.data?.pid === second.pid);
  assert.equal(booted?.data?.previousRunCrashed, true);
  const bundle = JSON.parse((await call(port, '/api/debug/bundle')).body) as { console?: Record<string, unknown> };
  assert.equal(bundle.console?.previousRunEndedCleanly, false, 'and the debug bundle carries the same verdict');

  // BM-2 through the real exit path: a clean stop takes the marker with it.
  const stopped = once(second, 'exit');
  second.kill('SIGTERM');
  const [code] = await withTimeout(stopped, 30_000, 'the second console did not stop on SIGTERM');
  assert.equal(code, 0);
  assert.deepEqual(readdirSync(markers), [], 'a console that reached its exit record left no marker');
  assert.equal(readCrashLedger(instanceDir).length, 1, 'and nothing more reached the ledger');
});

/* ------------------------------------------------------------------ *
 * BM-2 — a clean exit
 * ------------------------------------------------------------------ */

test('BM-2: a clean exit takes its marker with it, and the next boot records nothing', async () => {
  const dir = stateDir();
  const first = await settleBootMarkers({ pid: 7001, stateDir: dir });
  assert.deepEqual(first, { crashed: [], live: [], endedCleanly: null },
    'no console has ever owned the port here: nothing to judge, which is not the same as clean');

  const owner = exited();
  const written = writeBootMarker(4130, { pid: owner.pid, startedAt: owner.startedAt, stateDir: dir });
  assert.ok(written);
  assert.deepEqual(readBootMarkers(dir), [written], 'one marker, for as long as it owns the port');

  // Only the process that wrote a marker removes it — matched on its start
  // time, not the pid alone.
  const someoneElse = new Date(Date.parse(owner.startedAt) - 3_600_000).toISOString();
  assert.equal(releaseBootMarker({ pid: owner.pid, startedAt: someoneElse, stateDir: dir }), false);
  assert.equal(readBootMarkers(dir).length, 1);
  // Its exit record is written, and in the same breath its marker goes.
  assert.equal(releaseBootMarker({ pid: owner.pid, startedAt: owner.startedAt, stateDir: dir }), true);
  assert.deepEqual(readBootMarkers(dir), []);

  const next = await settleBootMarkers({ pid: 7002, stateDir: dir });
  assert.deepEqual(next.crashed, []);
  assert.equal(next.endedCleanly, true, 'a console owned the port before and left nothing behind');
  assert.equal(existsSync(crashLedgerFile(dir)), false, 'nothing reaches the ledger');
});

/* ------------------------------------------------------------------ *
 * BM-3 — a duplicate the port refused
 * ------------------------------------------------------------------ */

test('BM-3: a launch the port refused records nothing, leaves the live console alone, and masks no later crash', async () => {
  const dir = stateDir();
  const live = running();
  writeBootMarker(4130, { pid: live.pid, startedAt: live.startedAt, stateDir: dir });
  const before = markerText(dir, live.pid);

  // The duplicate settles at boot like any launch, is refused the port, and
  // leaves through its exit record — which is exactly what used to mask the
  // live console's ending.
  const duplicate = await settleBootMarkers({ pid: 7101, stateDir: dir });
  assert.deepEqual(duplicate.crashed, []);
  assert.deepEqual(duplicate.live.map((marker) => marker.pid), [live.pid], 'it met a console still running');
  assert.equal(duplicate.endedCleanly, null, 'and concluded nothing about how that one will end');
  assert.equal(releaseBootMarker({ pid: 7101, stateDir: dir }), false, 'it never wrote a marker, so it removes none');
  assert.equal(markerText(dir, live.pid), before, "the live console's marker is untouched");
  assert.equal(existsSync(crashLedgerFile(dir)), false);

  // And it never wrote one, not even for the moment before its exit took it
  // away again — which no reader could catch, so this half is a claim about the
  // source: the entry point writes the marker in one place, the listen
  // callback, and a launch the port refuses never gets there.
  const entry = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const writes = [...entry.matchAll(/\bwriteBootMarker\(/g)];
  assert.equal(writes.length, 1, 'the marker is written in one place');
  const listen = entry.indexOf('server.listen(');
  const callbackEnd = entry.indexOf('\n});', listen);
  assert.ok(listen > 0 && writes[0].index! > listen && writes[0].index! < callbackEnd,
    'and that place is inside the listen callback');

  // The live console then ends hard. Nothing the duplicate did stands between
  // that and the ledger.
  await killHard(live.child);
  const next = await settleBootMarkers({ pid: 7102, stateDir: dir });
  assert.deepEqual(next.crashed.map((marker) => marker.pid), [live.pid]);
  assert.equal(next.endedCleanly, false);
  assert.deepEqual(readCrashLedger(dir).map((entry) => entry.pid), [7102]);
  assert.deepEqual(readBootMarkers(dir), [], 'claimed, so no later boot counts it twice');
});

/* ------------------------------------------------------------------ *
 * BM-4, BM-5 — identity and races
 * ------------------------------------------------------------------ */

test('BM-4: a pid is not a process — a recycled pid, or the booting process\'s own, is a console that is gone', async () => {
  const dir = stateDir();
  // A live pid whose process started an hour before the marker says its owner
  // did: the pid has been handed to something else since.
  const recycled = new Date(performance.timeOrigin - 3_600_000).toISOString();
  writeBootMarker(4130, { pid: process.pid, startedAt: recycled, stateDir: dir });
  const found = await settleBootMarkers({ pid: 7201, stateDir: dir });
  assert.deepEqual(found.crashed.map((marker) => marker.pid), [process.pid]);
  assert.deepEqual(found.live, []);

  // A marker under the booting process's OWN pid was left by an earlier holder
  // of that pid — this process has written nothing yet.
  writeBootMarker(4130, { pid: 7202, startedAt: new Date().toISOString(), stateDir: dir });
  const own = await settleBootMarkers({ pid: 7202, stateDir: dir });
  assert.deepEqual(own.crashed.map((marker) => marker.pid), [7202]);
  assert.equal(readCrashLedger(dir).length, 2);

  // …and the live one it really is: the same pid, its real start time.
  writeBootMarker(4130, { pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString(), stateDir: dir });
  const alive = await settleBootMarkers({ pid: 7203, stateDir: dir });
  assert.deepEqual(alive.live.map((marker) => marker.pid), [process.pid]);
  assert.deepEqual(alive.crashed, []);
});

test('BM-5: two launches racing over one dead console count it once, and a retry counts nothing', async () => {
  const dir = stateDir();
  const gone = exited();
  writeBootMarker(4130, { pid: gone.pid, startedAt: gone.startedAt, stateDir: dir });

  const [a, b] = await Promise.all([
    settleBootMarkers({ pid: 7301, stateDir: dir }),
    settleBootMarkers({ pid: 7302, stateDir: dir }),
  ]);
  assert.equal(a.crashed.length + b.crashed.length, 1, 'one unlink wins; the other launch records nothing');
  assert.equal(readCrashLedger(dir).length, 1);

  // A launch that then lost the port to something that is not a console is
  // retried by its supervisor every few seconds. None of those retries may
  // count the same ending again, or a squatter on the port reads as a loop.
  const retry = await settleBootMarkers({ pid: 7303, stateDir: dir });
  assert.deepEqual(retry.crashed, []);
  assert.equal(readCrashLedger(dir).length, 1);
});

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

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

function call(port: number, path: string, agent?: Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', ...(agent ? { agent } : {}) }, (res) => {
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

/**
 * `count` requests for files that do not exist. A 404 is logged at `info`
 * whatever the debug channels say, so each one is a line in the console's log.
 */
async function flood(port: number, count: number): Promise<void> {
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const i = next++;
      const { status } = await call(port, `/nothing-${i}.png`, agent);
      assert.equal(status, 404);
    }
  };
  try {
    await Promise.all(Array.from({ length: 16 }, worker));
  } finally {
    agent.destroy();
  }
}

function readLog(file: string): Entry[] {
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return line ? [JSON.parse(line) as Entry] : []; } catch { return []; }
  });
}

/** How many lines the log holds after the `start` record of the console with this pid. */
function linesAfterStart(entries: Entry[], pid: number): number {
  const at = entries.findIndex((entry) => entry.event === 'start' && entry.data?.pid === pid);
  assert.ok(at >= 0, `no start record for pid ${pid}`);
  return entries.length - at - 1;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { setTimeout(() => reject(new Error(message)), ms).unref(); }),
  ]);
}
