/**
 * An orphan is a child the CURRENT console did not launch (control-tower phase
 * 110, #175).
 *
 * Measured three times: run `fabb9339985d` P5 on the hub console (pid 55074, no
 * restart) and this plan's P31 on pe-hub (pid 812, twice, an hour apart) were
 * parked `orphaned-session` — "a session from an earlier console is still
 * running" — while the console that had launched the child was the one reading
 * it. The hourly sizing census read every run with NO live set, the read path
 * reconciled each driven run as if nothing drove it, and the park went to disk
 * with no journal line; the runner's next save overwrote it.
 *
 *   OR-8   a child THIS console launched is never an orphan — not on a read with
 *          no live set, not after an hour of quiet, not under the census.
 *   OR-9   a child whose console is gone — another pid, or this pid on an
 *          earlier boot — IS one: parked, and the park is journalled.
 *   OR-10  every child is stamped at launch with the console that launched it.
 *   OR-11  a start beside a session this console launched is refused, never
 *          parked as an earlier console's orphan.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const stateModule = await import('../server/runner/state.ts');
const { clearRunFileCache, flushRunSaves, listRuns, loadRun, newRun, phaseRecord, saveRun } = stateModule;
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
type RunState = import('../server/runner/state.ts').RunState;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;

const DEAD_PID = 0x7ffffffe;
/** This process's start, the way the console stamps its own boot. */
const BOOTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

const PLAN = `---
slug: alpha
created: 2026-10-04
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-orphan-same-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

/** A live process standing in for a `claude` session, and its start as a spawn records it. */
function session(): { child: ChildProcess; pid: number; procStartedAt: string } {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(child.pid, 'the stand-in session started');
  return { child, pid: child.pid!, procStartedAt: new Date().toISOString() };
}

/**
 * A run that reads `running` over one live session, last written an hour ago —
 * the quiet, stale-looking record the census found. `launcher` is who started
 * the session.
 */
function quietRun(
  root: string, pid: number, procStartedAt: string, launcher: { pid: number; bootedAt: string } | null,
): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'running';
  state.activePhase = 2;
  const record = phaseRecord(state, 2);
  record.status = 'running';
  record.sessionId = 'sess-2';
  record.startedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  record.attemptStartedAt = record.startedAt;
  state.children = {
    2: {
      pid, phase: 2, sessionId: 'sess-2', startedAt: record.startedAt, procStartedAt,
      ...(launcher ? { launcher } : {}),
    } as never,
  };
  saveRun(state);
  // An hour of quiet: no write since, which is what a long own-job wait looks like.
  const file = runFile(root, 'alpha', state.id);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RunState;
  raw.updatedAt = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  clearRunFileCache();
  return raw;
}

function onDisk(root: string, id: string): RunState {
  flushRunSaves();
  return JSON.parse(readFileSync(runFile(root, 'alpha', id), 'utf8')) as RunState;
}

function journalled(root: string, id: string): { event: string; data?: Record<string, unknown> }[] {
  const file = journalFile(root, 'alpha', id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
}

test('OR-8: a child THIS console launched is never an orphan — a read with no live set, an hour of quiet, the hourly census', async () => {
  const root = scratch();
  const { child, pid, procStartedAt } = session();
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  try {
    const stored = quietRun(root, pid, procStartedAt, { pid: process.pid, bootedAt: BOOTED_AT });

    // The census's shape: every run of the plan, and nothing named live.
    const [read] = listRuns(root, 'alpha', null);
    assert.equal(read?.status, 'running', `the run this console drives is not reclaimed on a read (${read?.halt?.reason ?? ''})`);
    assert.equal(read?.halt ?? null, null, 'no halt is written for it');
    assert.equal(loadRun(root, 'alpha', stored.id, null)?.status, 'running', 'nor on a single-run read');
    const disk = onDisk(root, stored.id);
    assert.equal(disk.status, 'running', 'and nothing was written over the record');
    assert.equal(disk.halt ?? null, null);

    // The census itself, as the console runs it once an hour.
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);
    await (svc as never as { readSizingCensus: (now: number) => Promise<unknown> }).readSizingCensus(Date.now());
    const after = onDisk(root, stored.id);
    assert.equal(after.status, 'running', 'the census left the live run as it found it');
    assert.equal(after.halt ?? null, null);
    assert.equal(journalled(root, stored.id).filter((line) => line.event === 'run.orphaned').length, 0, 'nothing was orphaned');
  } finally {
    child.kill('SIGKILL');
    await svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('OR-9: a child whose console is gone — another pid, or this pid on an earlier boot — IS an orphan, and the park is journalled', async () => {
  for (const [label, launcher] of [
    ['a console that is no longer running', { pid: DEAD_PID, bootedAt: BOOTED_AT }],
    ['an earlier boot that held this pid', { pid: process.pid, bootedAt: new Date(Date.parse(BOOTED_AT) - 3_600_000).toISOString() }],
  ] as const) {
    const root = scratch();
    const { child, pid, procStartedAt } = session();
    try {
      const stored = quietRun(root, pid, procStartedAt, launcher);
      const [read] = listRuns(root, 'alpha', null);
      assert.equal(read?.status, 'parked', `${label}: its live session is an orphan`);
      assert.equal(read?.halt?.kind, 'orphaned-session');
      assert.match(read!.halt!.reason, new RegExp(`pid ${pid}, phase 2`));
      flushRunSaves();
      const lines = journalled(root, stored.id).filter((line) => line.event === 'run.orphaned');
      assert.equal(lines.length, 1, `${label}: the park is journalled, not written to the record alone`);
      assert.deepEqual(lines[0]!.data?.pids, [pid]);
      assert.deepEqual(lines[0]!.data?.phases, [2]);
      // Read again: the run is parked now, so nothing more is said.
      clearRunFileCache();
      listRuns(root, 'alpha', null);
      flushRunSaves();
      assert.equal(journalled(root, stored.id).filter((line) => line.event === 'run.orphaned').length, 1, `${label}: said once`);
    } finally {
      child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/* ---- a Runner over stub scripts: what a spawn records, and what a start refuses ---- */

type Repo = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-orphan-runner-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"
case "\${2:-}" in
  --memory-block)
    if grep -qx 1 "$S/done"; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase \${3:-}" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(stub, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-A', costUsd: 0.01, turns: 1, resultText: 'done', durationMs: 10, argv: [], injected: 0,
  } as SpawnOutcome;
}

test('OR-10: every child is stamped at launch with the console that launched it — its pid and its boot', async () => {
  const live = stateModule.THIS_CONSOLE as { pid: number; bootedAt: string } | undefined;
  assert.ok(live, 'state.ts names the live console: its pid and when it booted');
  assert.equal(live.pid, process.pid);
  assert.ok(Math.abs(Date.parse(live.bootedAt) - Date.parse(BOOTED_AT)) < 2_000, 'its boot is this process\'s start');

  const r = repo();
  let seen: unknown;
  let instance!: InstanceType<typeof Runner>;
  const spawnFn: SpawnFn = async (request) => {
    request.onPid?.(90_101);
    seen = instance.current()?.children?.['1'];
    r.markDone();
    return ok();
  };
  instance = new Runner({ scriptsDir: r.scripts, spawn: spawnFn, verificationText: () => '`true`' });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
    await instance.wait();
    const record = seen as { pid?: number; launcher?: { pid: number; bootedAt: string } } | undefined;
    assert.equal(record?.pid, 90_101);
    assert.deepEqual(record?.launcher, { pid: live.pid, bootedAt: live.bootedAt }, 'the child record names the console that launched it');
  } finally {
    r.cleanup();
  }
});

test('OR-11: a start beside a session this console launched is refused — never parked as an earlier console\'s orphan', async () => {
  const r = repo();
  const { child, pid, procStartedAt } = session();
  try {
    const stored = newRun({ slug: 'demo', root: r.root });
    stored.status = 'parked';
    stored.halt = { at: new Date().toISOString(), kind: 'nothing-ready', reason: 'nothing was ready' };
    const record = phaseRecord(stored, 1);
    record.status = 'running';
    record.sessionId = 'sess-1';
    record.startedAt = new Date().toISOString();
    stored.children = {
      1: {
        pid, phase: 1, sessionId: 'sess-1', startedAt: record.startedAt, procStartedAt,
        launcher: { pid: process.pid, bootedAt: BOOTED_AT },
      } as never,
    };
    saveRun(stored);
    clearRunFileCache();

    let spawned = 0;
    const instance = new Runner({
      scriptsDir: r.scripts, verificationText: () => '`true`',
      spawn: (async () => { spawned += 1; return ok(); }) as SpawnFn,
    });
    await assert.rejects(
      instance.start({ slug: 'demo', root: r.root, resumeRunId: stored.id }),
      new RegExp(`this console started.*pid ${pid}`),
      'the start is refused, naming the session this console is still running',
    );
    assert.equal(spawned, 0, 'no second session was boarded beside it');
    flushRunSaves();
    const disk = loadRun(r.root, 'demo', stored.id, null)!;
    assert.notEqual(disk.halt?.kind, 'orphaned-session', 'and the run was not parked as an earlier console\'s orphan');
  } finally {
    child.kill('SIGKILL');
    r.cleanup();
  }
});
