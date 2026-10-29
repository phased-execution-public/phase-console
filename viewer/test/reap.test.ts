/**
 * The reaper's two gaps (measured-console phase 13).
 *
 * #409 — a job a WATCH names is spared, whoever ended the session. The reaper
 * spared a session's detached jobs only when the session itself had declared
 * `waiting-external` (its outcome file said so at close). The console's own
 * in-turn wait checkpoint — the 45-minute park on a session polling its own
 * detached `verify:local` — ends the session with no such file, so the reaper
 * ended the very job the park then waited on: a sweep plan's P6 parked on
 * `/tmp/p6s3/line7.exit`, a file nothing alive would ever write. Now the park
 * tells the reaper what it watches (`keep`), and a recorded descendant that
 * names the watched file (or its stem's siblings — the job's log) or the pid
 * the ref probes is spared for the spare window, by `ended` and by the sweep.
 *
 * #421 — a cut session's test runner leaves its SERVERS behind. `orphansOf`
 * reaped an orphan that IS a test runner or holds one below it; Playwright's
 * `webServer` children (a catalog server, `next build && next start`) are
 * neither once the runner itself is gone, so a usage-limit cut left them on the
 * next attempt's ports ("http://127.0.0.1:3195/health is already used"). The
 * reaper now records, at sample time, that a descendant was spawned BENEATH a
 * test runner, and reaps such an orphan too — the console's own e2e tour
 * (fixture console, vite) as much as any repository's.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REAP_SPARE_MS, SessionReaper, orphansOf } from '../server/runner/reap.ts';
import type { ProcessRow } from '../server/pid.ts';

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A reaper over a table the test writes, a clock it winds, and an `end` that records. */
function stubReaper() {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const box = { table: [] as ProcessRow[] };
  const ended: number[] = [];
  const reaper = new SessionReaper({
    table: async () => box.table, now: () => clock,
    end: async (pid) => { ended.push(pid); box.table = box.table.filter((row) => row.pid !== pid && row.ppid !== pid); return 'exited'; },
  });
  return { reaper, box, ended, wind: (ms: number) => { clock += ms; }, at: () => clock };
}

test('RP-1: a checkpointed session keeps the job its watch names — by the exit file — and loses its other orphans (#409)', async () => {
  const { reaper, box, ended, wind, at } = stubReaper();
  const t = at();
  const job = { pid: 301, ppid: 300, pgid: 301, startedMs: t, command: "sh -c task verify:local > /tmp/p6s3/line7.log 2>&1; echo $? > /tmp/p6s3/line7.exit" };
  const suite = { pid: 302, ppid: 301, pgid: 301, startedMs: t, command: 'node --test --test-concurrency=1 tests/unit' };
  const stray = { pid: 401, ppid: 400, pgid: 401, startedMs: t, command: 'npx vitest run' };
  try {
    reaper.begin(100, { sessionId: 'sess-409' });
    box.table = [{ pid: 100, ppid: 1, pgid: 100, startedMs: t, command: 'claude -p' },
      { pid: 300, ppid: 100, pgid: 300, startedMs: t, command: 'zsh' }, job, suite,
      { pid: 400, ppid: 100, pgid: 400, startedMs: t, command: 'zsh' }, stray];
    await reaper.observe();
    // The console's in-turn wait checkpoint: it parks on the job's exit file, then ends the session.
    reaper.keep('sess-409', ['cmd:"test -f /tmp/p6s3/line7.exit"']);
    box.table = [{ ...job, ppid: 1 }, suite, { ...stray, ppid: 1 }];
    wind(60_000);
    const reaped = await reaper.ended(100);
    assert.deepEqual(reaped.map((row) => row.pid), [401], 'the stray suite is reaped; the watched job is not');
    assert.deepEqual(ended, [401]);
    wind(60 * 60_000);
    assert.deepEqual(await reaper.sweep(), [], 'and the sweep keeps it while the wait may still run');
    wind(REAP_SPARE_MS);
    assert.deepEqual((await reaper.sweep()).map((row) => row.pid), [301], 'past the spare it is an orphan older than its session');
  } finally { reaper.stop(); }
});

test('RP-2: a ref that probes a pid keeps that job; a ref naming the log\'s stem keeps the job that writes it; a keep for another session keeps nothing (#409)', async () => {
  const { reaper, box, at } = stubReaper();
  const t = at();
  const byPid = { pid: 501, ppid: 500, pgid: 501, startedMs: t, command: 'bash -c npm test' };
  const byStem = { pid: 502, ppid: 500, pgid: 502, startedMs: t, command: 'bash -c npx playwright test > /srv/x/runs/p8-gate.log 2>&1; echo $? > /srv/x/runs/p8-gate.code' };
  const other = { pid: 503, ppid: 500, pgid: 503, startedMs: t, command: 'bash -c pytest -q > /srv/x/runs/other.log' };
  try {
    reaper.begin(200, { sessionId: 'sess-a' });
    box.table = [{ pid: 200, ppid: 1, pgid: 200, startedMs: t, command: 'claude -p' },
      { pid: 500, ppid: 200, pgid: 500, startedMs: t, command: 'zsh' }, byPid, byStem, other];
    await reaper.observe();
    reaper.keep('sess-a', ['cmd:"! kill -0 501"', 'cmd:"test -f /srv/x/runs/p8-gate.done"']);
    reaper.keep('sess-b', ['cmd:"test -f /srv/x/runs/other.done"']);
    box.table = [{ ...byPid, ppid: 1 }, { ...byStem, ppid: 1 }, { ...other, ppid: 1 }];
    const reaped = await reaper.ended(200);
    assert.deepEqual(reaped.map((row) => row.pid), [503], 'only the job no watch of THIS session names');
  } finally { reaper.stop(); }
});

test('RP-3: a cut session\'s Playwright webServer children are reaped once the runner is gone; an orphan never beneath a runner is not (#421)', async () => {
  const { reaper, box, ended, at } = stubReaper();
  const t = at();
  const runner = { pid: 301, ppid: 300, pgid: 301, startedMs: t, command: 'node /repo/node_modules/.bin/playwright test --project tv-smoke --project tv-public' };
  const catalog = { pid: 302, ppid: 301, pgid: 301, startedMs: t, command: 'node e2e/_helpers/tv-catalog-server.mjs 3195' };
  const nextSh = { pid: 303, ppid: 301, pgid: 301, startedMs: t, command: 'sh -c pnpm next build && I18N_API_BASE=http://127.0.0.1:3195 pnpm next start -p 3105' };
  const nextServer = { pid: 304, ppid: 303, pgid: 301, startedMs: t, command: 'next-server (v15.1.0)' };
  // The console's own tour: node e2e/run.ts → playwright → the fixture console and vite.
  const tour = { pid: 311, ppid: 310, pgid: 311, startedMs: t, command: 'node e2e/run.ts' };
  const tourRunner = { pid: 312, ppid: 311, pgid: 311, startedMs: t, command: 'node /pe/viewer/node_modules/.bin/playwright test' };
  const fixture = { pid: 313, ppid: 312, pgid: 311, startedMs: t, command: 'node --experimental-strip-types server/index.ts --port 4917 --no-open' };
  const vite = { pid: 314, ppid: 312, pgid: 311, startedMs: t, command: 'node /pe/viewer/node_modules/.bin/vite --port 5917' };
  const daemon = { pid: 321, ppid: 320, pgid: 321, startedMs: t, command: 'node scripts/dev-daemon.mjs' };
  try {
    reaper.begin(100, { sessionId: 'sess-421' });
    box.table = [{ pid: 100, ppid: 1, pgid: 100, startedMs: t, command: 'claude -p' },
      { pid: 300, ppid: 100, pgid: 300, startedMs: t, command: 'zsh' }, runner, catalog, nextSh, nextServer,
      { pid: 310, ppid: 100, pgid: 310, startedMs: t, command: 'zsh' }, tour, tourRunner, fixture, vite,
      { pid: 320, ppid: 100, pgid: 320, startedMs: t, command: 'zsh' }, daemon];
    await reaper.observe();
    // The usage limit cuts the session; the runners die with their shells, their servers do not.
    box.table = [{ ...catalog, ppid: 1 }, { ...nextSh, ppid: 1 }, nextServer, { ...fixture, ppid: 1 }, { ...vite, ppid: 1 }, { ...daemon, ppid: 1 }];
    const reaped = await reaper.ended(100);
    assert.deepEqual(reaped.map((row) => row.pid).sort(), [302, 303, 313, 314], 'every server a test runner started');
    assert.deepEqual(ended.sort(), [302, 303, 313, 314]);
    assert.ok(box.table.some((row) => row.pid === 321), 'an orphan no runner started is nobody\'s to reap');
  } finally { reaper.stop(); }
});

test('RP-3: the rule, pure — orphansOf reads "spawned beneath a runner" from what was recorded', () => {
  const t = Date.parse('2026-10-26T12:00:00Z');
  const seen = new Map([
    [302, { startedMs: t, command: 'node e2e/_helpers/tv-catalog-server.mjs 3195', underRunner: true }],
    [321, { startedMs: t, command: 'node scripts/dev-daemon.mjs' }],
  ]);
  const rows = [{ pid: 302, ppid: 1, pgid: 301, startedMs: t, command: 'node e2e/_helpers/tv-catalog-server.mjs 3195' },
    { pid: 321, ppid: 1, pgid: 321, startedMs: t, command: 'node scripts/dev-daemon.mjs' }];
  assert.deepEqual(orphansOf(rows, seen, t + 1_000).map((row) => row.pid), [302]);
});

/**
 * Exit criterion 2, with real processes: a session that started its suite
 * detached and was checkpointed by the console (no outcome file) keeps the
 * suite alive, and the suite writes its sentinel; the twin with no watch
 * loses it, which is #409.
 */
test('RP-4: a checkpointed session\'s detached suite, watched by `cmd:"test -f …/x.done"`, lives and writes its sentinel (#409)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-reap-keep-'));
  writeFileSync(join(dir, 'slow.test.mjs'), "import test from 'node:test';\ntest('slow', () => new Promise((done) => setTimeout(done, 2500)));\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST')));
  const strays: number[] = [];
  const session = (name: string) => {
    const done = join(dir, `${name}.done`);
    const pidFile = join(dir, `${name}.pid`);
    // The "session": a group leader whose one command detaches a suite the way
    // the plan teaches (`nohup … &`, its own group), then idles.
    const leader = spawn('bash', ['-c', [
      'set -m',
      `nohup sh -c ${JSON.stringify(`node --test ${join(dir, 'slow.test.mjs')} > ${join(dir, `${name}.log`)} 2>&1; echo $? > ${done}`)} >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`,
      'sleep 120',
    ].join('\n')], { detached: true, stdio: 'ignore', env });
    return { leader, done, pidFile };
  };
  const kept = session('kept');
  const lost = session('lost');
  try {
    const reaper = new SessionReaper();
    reaper.begin(kept.leader.pid!, { sessionId: 'rp4-kept' });
    reaper.begin(lost.leader.pid!, { sessionId: 'rp4-lost' });
    for (let i = 0; i < 100 && !(existsSync(kept.pidFile) && existsSync(lost.pidFile)); i++) await settle(50);
    const keptJob = Number(readFileSync(kept.pidFile, 'utf8'));
    const lostJob = Number(readFileSync(lost.pidFile, 'utf8'));
    strays.push(keptJob, lostJob);
    await settle(400);
    await reaper.observe();
    // The console's checkpoint: the park names the sentinel, then the session is ended.
    reaper.keep('rp4-kept', [`cmd:"test -f ${kept.done}"`]);
    for (const { leader } of [kept, lost]) {
      const exited = new Promise((done) => leader.once('exit', done));
      process.kill(leader.pid!, 'SIGKILL');
      await exited;
    }
    await settle(200);
    await reaper.ended(kept.leader.pid!);
    await reaper.ended(lost.leader.pid!);
    await settle(300);
    assert.equal(alive(keptJob), true, 'the watched job outlives the checkpoint');
    assert.equal(alive(lostJob), false, 'the unwatched twin is reaped, as #222 wants');
    for (let i = 0; i < 100 && !existsSync(kept.done); i++) await settle(100);
    assert.equal(readFileSync(kept.done, 'utf8').trim(), '0', 'and it wrote the sentinel the park waits on');
    assert.equal(existsSync(lost.done), false);
    reaper.stop();
  } finally {
    for (const pid of strays) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    for (const { leader } of [kept, lost]) { try { process.kill(-leader.pid!, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * RP-5 — the runner's half: the console's own checkpoint names the job
 * ------------------------------------------------------------------ */

const MINUTE = 60_000;

/** A runner over a stub engine and one held session, as `clock-guard-own-loop.test.ts` builds one. */
async function heldRun() {
  const { Runner } = await import('../server/runner/runner.ts');
  const { chmodSync, mkdirSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'pc-reap-park-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const script = (name: string, body: string) => { writeFileSync(join(scripts, name), body); chmodSync(join(scripts, name), 0o755); };
  script('phase-graph.sh', `#!/usr/bin/env bash
S="${stub}"; mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  script('phase-lock.sh', '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const inSession = new Promise<void>((done) => { entered = done; });
  let sink: ((event: import('../server/runner/spawn.ts').StreamEvent) => void) | undefined;
  const at = { now: Date.parse('2026-10-26T10:00:00.000Z') };
  const instance = new Runner({
    scriptsDir: scripts, now: () => new Date(at.now), verificationText: () => '`true`',
    spawn: async (request) => {
      sink = request.onEvent;
      request.onHandle?.({ pid: undefined, open: () => true, send: () => true, setFrozen: () => {} });
      request.onEvent?.({ kind: 'init', sessionId: 'sess-rp5', model: 'stub-1', tools: 0 });
      entered();
      await held;
      writeFileSync(join(stub, 'done'), '1\n');
      return { signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-rp5', costUsd: 0.01, turns: 2, resultText: 'done', durationMs: 10, argv: ['-p'] };
    },
  });
  return {
    instance, root, inSession, release: () => release(),
    say: (event: import('../server/runner/spawn.ts').StreamEvent) => sink?.(event),
    wind: (ms: number) => { at.now += ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('RP-5: the in-turn wait checkpoint on a detached job names that job to the reaper before it ends the session (#409)', async () => {
  const { sessionReaper } = await import('../server/runner/reap.ts');
  const run = await heldRun();
  const exit = '/tmp/pc-rp5/line7.exit';
  try {
    await run.instance.start({ slug: 'demo', root: run.root, onlyPhases: [1] });
    await run.inSession;
    // The session detaches its suite, then polls the sentinel in-turn — the #409 shape.
    run.say({ kind: 'tool', id: 'toolu_job', name: 'Bash', summary: `nohup sh -c 'npm test > /tmp/pc-rp5/line7.log 2>&1; echo $? > ${exit}' >/dev/null 2>&1 &` });
    run.say({ kind: 'tool-result', id: 'toolu_job', ok: true });
    run.say({ kind: 'tool', id: 'toolu_poll', name: 'Bash', summary: `until [ -f ${exit} ]; do sleep 10; done` });
    for (let minute = 0; minute < 60 && run.instance.current()!.phases['1'].status === 'running'; minute += 5) {
      run.wind(5 * MINUTE);
      await run.instance.tickLiveness();
    }
    assert.equal(run.instance.current()!.phases['1'].status, 'waiting', 'the console parked the phase on its own job');
    assert.ok(sessionReaper.keptRefs('sess-rp5').includes(exit), `the reaper was told: ${JSON.stringify(sessionReaper.keptRefs('sess-rp5'))}`);
    run.release();
    await run.instance.wait();
  } finally { run.cleanup(); }
});
