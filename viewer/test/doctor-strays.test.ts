/**
 * #155 — the Pro package tests leak their console servers (control-tower
 * phase 98, EC8 / PS-1..3).
 *
 * PS-1 (the tests' own teardown) is proved in `pro-package.test.ts` itself —
 * that is where the leak was, so that is where the proof belongs.
 *
 * PS-2: the fleet Heartbeat (`server/fleet.ts`) notices its own root is gone
 * and asks for a clean shutdown rather than going on serving from a deleted
 * checkout; and a console whose root is itself a temporary prefix (a
 * Pro-package test's `npm install -g --prefix <tmp>`) never writes a beat at
 * all, so it can never be read as a live sibling. Proved with injected
 * filesystem/clock — `fleet-daemon.test.ts`'s own rule restated: fake what a
 * real test would otherwise have to delete out from under a live console.
 *
 * PS-3: `phase-console doctor` names every stray console process — a server
 * whose PACKAGE root (not the `--root` plan-library flag; the directory
 * holding its own `package.json`, the same fact `SKILL_DIR` names for this
 * very process) no longer exists — and `--stop-strays` stops exactly those.
 * The `ps` read and the judgement are pure functions in
 * `bin/stray-consoles.mjs`, fed a fake listing for the deterministic cases;
 * one test starts a real detached process itself (never a process this
 * session did not start) to prove the real `ps` read and the real stop both
 * work end to end.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { Heartbeat, type HeartbeatFacts } from '../server/fleet.ts';
import {
  isConsoleServerCommand, judgeStrays, listStrayConsoles, packageRootOfScript,
  parsePsSnapshot, scriptPathOf, stopStray, stopStrayConsoles,
} from '../../bin/stray-consoles.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function baseFacts(port = 4200): HeartbeatFacts {
  return { port, supervisor: null, lanes: { live: 0, max: 4 }, needsYou: 0, lastRemoteAt: null, build: { version: null, rev: null } };
}

/* ==================================================================== *
 * PS-2 — the Heartbeat notices its own root, and a temp-prefix console
 * never joins the census
 * ==================================================================== */

test('PS-2: a beat whose root is present writes the census row exactly as before', async () => {
  const { registerInstance, census } = await import('../shared/instances.mjs');
  const root = mkdtempSync(join(tmpdir(), 'pc-doctor-strays-present-'));
  try {
    const entry = registerInstance(root, { name: 'pc-doctor-strays-present', port: 49991 })!;
    const hb = new Heartbeat(entry.id, () => baseFacts(49991), {
      skillDir: root,
      rootPresent: () => true,
      fromTempPrefix: () => false,
      onRootGone: () => { throw new Error('must not be asked — the root is right there'); },
    });
    hb.beat();
    assert.equal(census().rows.find((r: { id: string }) => r.id === entry.id)?.liveness, 'running');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PS-2: a beat whose root is gone asks for a clean shutdown, journalled/logged, and keeps asking every beat after', () => {
  let calls = 0;
  let lastReason = '';
  const hb = new Heartbeat('pc-doctor-strays-gone', () => baseFacts(), {
    skillDir: '/nonexistent/deleted/root',
    rootPresent: () => false,
    fromTempPrefix: () => false,
    onRootGone: (reason: string) => { calls += 1; lastReason = reason; },
  });
  hb.beat();
  hb.beat();
  assert.equal(calls, 2, 'a shutdown already in flight is idempotent (service-base.ts\'s own requestShutdown guard), '
    + 'so a beat before the process actually exits must keep asking rather than giving up after one try');
  assert.match(lastReason, /root|package\.json/i);
});

test('PS-2: a console whose own root is a temporary prefix never writes a beat — it does not exist for the census (#155)', async () => {
  const { registerInstance, census } = await import('../shared/instances.mjs');
  const root = mkdtempSync(join(tmpdir(), 'pc-doctor-strays-temp-'));
  try {
    const entry = registerInstance(root, { name: 'pc-doctor-strays-temp', port: 49992 })!;
    const before = census().rows.find((r: { id: string }) => r.id === entry.id)?.liveness;
    assert.equal(before, 'unknown', 'the baseline: registered but never beaten reads unknown, not running');
    const hb = new Heartbeat(entry.id, () => baseFacts(49992), {
      skillDir: root,
      rootPresent: () => true, // present — just happens to live under the temp dir
      fromTempPrefix: () => true, // what the real realpath-vs-tmpdir check would answer for this root
      onRootGone: () => { throw new Error('a present root must never be asked about'); },
    });
    hb.beat();
    hb.beat();
    assert.equal(census().rows.find((r: { id: string }) => r.id === entry.id)?.liveness, 'unknown',
      'still unknown — the beat never reached the registry, so this console never registered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('PS-2: the real temp-prefix detector answers by realpath, not by lexical prefix (macOS /var vs /private/var)', async () => {
  const { fromTempPrefix } = await import('../server/fleet.ts') as unknown as { fromTempPrefix: (dir: string) => boolean };
  const inside = mkdtempSync(join(tmpdir(), 'pc-doctor-strays-real-'));
  try {
    assert.equal(fromTempPrefix(inside), true, `${inside} is under ${tmpdir()} and must read as a temp prefix`);
    assert.equal(fromTempPrefix(REPO), false, 'this checkout is not a temp prefix');
  } finally { rmSync(inside, { recursive: true, force: true }); }
});

/* ==================================================================== *
 * PS-3 — the doctor's stray scan: pure functions, fed a fake listing
 * ==================================================================== */

test('PS-3: a console script names its package root — three levels up from viewer/server/index.js, exactly as SKILL_DIR derives it', () => {
  assert.equal(scriptPathOf('node /a/b/viewer/server/index.js --port 1'), '/a/b/viewer/server/index.js');
  assert.equal(scriptPathOf('node /a/b/viewer/server/index.ts --port 1 --root /somewhere'), '/a/b/viewer/server/index.ts');
  assert.equal(scriptPathOf('node /a/b/viewer/fleet/index.js'), '/a/b/viewer/fleet/index.js');
  assert.equal(scriptPathOf('node /usr/bin/something-else.js'), null, 'not a console server script at all');
  assert.equal(packageRootOfScript('/a/b/viewer/server/index.js'), '/a/b');
  assert.equal(packageRootOfScript('/a/b/viewer/fleet/index.js'), '/a/b');
  assert.equal(isConsoleServerCommand('node /a/b/viewer/server/index.js --port 1'), true);
  assert.equal(isConsoleServerCommand('sleep 500'), false);
});

test('PS-3: parsePsSnapshot reads pid, pgid and command off `ps -axo pid=,pgid=,command=` lines', () => {
  const text = '  123   123  node /a/viewer/server/index.js --port 1\n  456   123  /bin/bash -c foo\n\n';
  assert.deepEqual(parsePsSnapshot(text), [
    { pid: 123, pgid: 123, command: 'node /a/viewer/server/index.js --port 1' },
    { pid: 456, pgid: 123, command: '/bin/bash -c foo' },
  ]);
});

test('PS-3: judgeStrays names a console server whose package root is gone, and leaves everything else — including this process — alone', () => {
  const processes = [
    { pid: 1, pgid: 1, command: 'node /gone/viewer/server/index.js --port 1 --root /somewhere-else' },
    { pid: 2, pgid: 2, command: 'node /present/viewer/server/index.js --port 2' },
    { pid: 3, pgid: 3, command: 'sleep 500' },
    { pid: process.pid, pgid: process.pid, command: 'node /gone/viewer/server/index.js --port 3' },
  ];
  const exists = (p: string) => p === '/present';
  const strays = judgeStrays(processes, { exists });
  assert.deepEqual(strays, [{ pid: 1, pgid: 1, command: processes[0].command, root: '/gone' }]);
});

test('PS-3: stopStray sends SIGTERM to the process GROUP first, and SIGKILL only if it is still alive after the grace period', async () => {
  const signals: Array<[number, string]> = [];
  const kill = (pid: number, signal: string) => { signals.push([pid, signal]); };
  const alive = () => signals.filter(([, s]) => s === 'SIGKILL').length === 0;
  const stopped = await stopStray({ pid: 99, pgid: 42, command: 'x', root: '/gone' }, { kill, wait: async () => {}, alive });
  assert.deepEqual(signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']], 'addressed by pgid, negated — the process group, never the bare pid');
  assert.equal(stopped, true);
});

test('PS-3: stopStray does not send SIGKILL when SIGTERM alone was enough', async () => {
  const signals: string[] = [];
  const kill = (_pid: number, signal: string) => { signals.push(signal); };
  const stopped = await stopStray({ pid: 99, pgid: 42, command: 'x', root: '/gone' }, { kill, wait: async () => {}, alive: () => false });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(stopped, true);
});

test('PS-3: the doctor CLI documents and accepts --stop-strays', () => {
  const usage = readFileSync(join(REPO, 'bin', 'doctor-verb.mjs'), 'utf8');
  assert.match(usage, /--stop-strays/);
});

/**
 * The one real case: a detached process THIS test starts and names, whose
 * argv points at a package root it then deletes — proving the real `ps` read
 * and the real group-kill both work, without ever touching a process this
 * session did not start (a live pe-hub/hub console's root is a real,
 * permanent checkout and can never match this predicate — see the PS-3
 * pure-function tests above for why).
 */
test(
  'PS-3: --stop-strays stops a real orphaned console server end to end, through the real ps read, and nothing else',
  { skip: process.platform === 'win32' ? 'ps and process-group signals are POSIX-only' : false },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-strays-real-'));
    const scriptDir = join(dir, 'viewer', 'server');
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, 'index.js');
    // No `process.title` here: Node implements it by overwriting the
    // process's own argv memory on POSIX, which would erase the very script
    // path `ps` is supposed to still be reporting — the fact this whole test
    // depends on.
    writeFileSync(script, 'setInterval(() => {}, 60_000);\n');
    const child = spawn(process.execPath, [script, '--port', '0', '--root', join(dir, 'root')], {
      detached: true, stdio: 'ignore',
    });
    const pid = child.pid!;
    child.unref();
    t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone, which is the point of this test */ } });

    // Give it a moment to actually be running and visible to `ps`.
    let seenAlive = false;
    for (let i = 0; i < 50 && !seenAlive; i++) {
      seenAlive = (await listStrayConsoles()).length >= 0 && (await psHasPid(pid));
      if (!seenAlive) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(seenAlive, 'the fixture process never showed up in ps at all');

    // Its root is real for now — nothing may call it a stray yet.
    const beforeDelete = await listStrayConsoles();
    assert.ok(!beforeDelete.some((s: { pid: number }) => s.pid === pid), 'a console with a real root is never a stray');

    rmSync(dir, { recursive: true, force: true });
    let found: { pid: number; pgid: number; command: string; root: string } | undefined;
    for (let i = 0; i < 50 && !found; i++) {
      const strays = await listStrayConsoles();
      found = strays.find((s: { pid: number }) => s.pid === pid);
      if (!found) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(found, 'the fixture, whose root is now gone, must be named a stray');
    assert.equal(found!.root, dir);

    const stopped = await stopStrayConsoles([found!], { graceMs: 300 });
    assert.equal(stopped[0].stopped, true);

    let goneNow = false;
    for (let i = 0; i < 50 && !goneNow; i++) {
      goneNow = !(await psHasPid(pid));
      if (!goneNow) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(goneNow, '--stop-strays must really end the process, not merely mark it');

    // And nothing else was ever a candidate — least of all this test's own process.
    const finalScan = await listStrayConsoles();
    assert.ok(!finalScan.some((s: { pid: number }) => s.pid === process.pid), 'this test process itself was never a candidate');
  },
);

/** Whether `pid` is visible to a fresh, real `ps` read right now. */
async function psHasPid(pid: number): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid)], (error) => resolve(!error));
  });
}
