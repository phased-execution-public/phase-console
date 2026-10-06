/**
 * A lane in `Setup:` or in a baseline is work in flight (control-tower phase
 * 105, #173).
 *
 * Hub run `fabb9339985d` read `interrupted` from 21:10Z to 21:41Z on
 * 2026-09-28 while its lane ran P3's `Setup:` and pre-session `task
 * verify:local` — the console up, the lock refreshed at 21:03, 21:13, 21:23
 * and 21:33. The run record carried no `child` (that holds sessions only) and
 * its `updatedAt` stood at the last write, so a read that did not know the run
 * was live reclaimed it as a run nothing drove. The same shape painted phase 14
 * of this plan `interrupted-by-restart` 80 s into its post-verify lint.
 *
 * BL-4  the setup or baseline command's process is recorded on the run with its
 *       `(pid, procStartedAt)`, and a lock the lane refreshes keeps the run
 *       `running`: a read that lacks the live set never paints such a run
 *       `interrupted` — and once the process is gone and the beat is stale or
 *       its console dead, the run is reclaimed exactly as before
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import {
  clearRunFileCache, flushRunSaves, laneInFlight, loadRun, newRun, phaseRecord, saveRun, type RunState, type VerifyingLane,
} from '../server/runner/state.ts';
import { forgetPid, processState, warmPids } from '../server/pid.ts';

const TRASH: string[] = [];
const KIDS: ChildProcess[] = [];
process.on('exit', () => {
  for (const kid of KIDS) { try { kid.kill('SIGKILL'); } catch { /* gone */ } }
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-bl4-'));
  TRASH.push(root);
  return root;
}

/** A real process the record can name — what a setup or baseline command is. */
function liveChild(): { pid: number; procStartedAt: string; kill: () => Promise<void> } {
  const kid = spawn('sleep', ['60'], { stdio: 'ignore' });
  KIDS.push(kid);
  const procStartedAt = new Date().toISOString();
  return {
    pid: kid.pid!, procStartedAt,
    kill: async () => {
      const gone = new Promise((done) => kid.once('exit', done));
      kid.kill('SIGKILL');
      await gone;
      forgetPid(kid.pid!);
    },
  };
}

/** This very process's identity — what a live console stamps its lane beat with. */
const SELF = { pid: process.pid, procStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() };

/** A stored run the way the console leaves one mid-baseline: `running`, no session child, phase 8 `pending`. */
function midBaseline(root: string, check?: Partial<VerifyingLane>): RunState {
  const state = newRun({ slug: 'demo', root });
  state.status = 'running';
  phaseRecord(state, 8).status = 'pending';
  if (check) {
    const now = new Date().toISOString();
    state.verifying = {
      8: {
        phase: 8, purpose: 'baseline', command: 'task verify:local', index: 9, total: 10, startedAt: now,
        commandStartedAt: now, pid: 999_999, ...check,
      } as VerifyingLane,
    };
  }
  return state;
}

/** Read it the way a reader that does not know the run is live does. */
function readCold(root: string, id: string): RunState {
  flushRunSaves();
  clearRunFileCache();
  const back = loadRun(root, 'demo', id);
  assert.ok(back, 'the run file reads');
  return back!;
}

test('BL-4: a run whose baseline command is running reads `running` on a read that lacks the live set — and is reclaimed once it is gone', async () => {
  const root = scratch();
  const child = liveChild();
  const state = midBaseline(root, { child: { pid: child.pid, procStartedAt: child.procStartedAt } });
  saveRun(state);

  assert.equal(laneInFlight(state), true, 'the recorded baseline child holds work');
  const back = readCold(root, state.id);
  assert.equal(back.status, 'running', 'never painted interrupted while the command runs');
  assert.equal(back.halt ?? null, null);

  await child.kill();
  assert.equal(processState(child.pid), 'gone');
  const after = readCold(root, state.id);
  assert.equal(after.status, 'interrupted', 'with the command gone and nothing else behind it, the run is reclaimed as before');
  assert.equal(after.halt?.kind, 'interrupted-by-restart');
});

test('BL-4: a lane in its Setup preamble counts too — the setup command is the recorded child', async () => {
  const root = scratch();
  const child = liveChild();
  const state = midBaseline(root, { stage: 'setup', command: 'npm ci', index: 1, total: 1, child: { pid: child.pid, procStartedAt: child.procStartedAt } });
  saveRun(state);
  assert.equal(readCold(root, state.id).status, 'running');
  await child.kill();
});

test('BL-4: a recycled pid is not the recorded child — the start time is half the identity', async () => {
  const root = scratch();
  const child = liveChild();
  // The same pid, claimed to have started a day earlier: some other process.
  const state = midBaseline(root, { child: { pid: child.pid, procStartedAt: new Date(Date.now() - 86_400_000).toISOString() } });
  saveRun(state);
  // A reader that has sampled the pid can judge its start time (`warmPids`).
  await warmPids([child.pid]);
  assert.equal(laneInFlight(state), false);
  assert.equal(readCold(root, state.id).status, 'interrupted');
  await child.kill();
});

test('BL-4: a lane whose lock its live console refreshed recently keeps the run `running` with no child at all', () => {
  const root = scratch();
  const state = midBaseline(root);
  state.laneBeat = { at: new Date(Date.now() - 2 * 60_000).toISOString(), ...SELF };
  saveRun(state);
  assert.equal(laneInFlight(state), true);
  assert.equal(readCold(root, state.id).status, 'running', 'a refreshed lock is a lane at work');
});

test('BL-4: a STALE lane beat, or one whose console is gone, keeps nothing alive', async () => {
  const root = scratch();
  const stale = midBaseline(root);
  stale.laneBeat = { at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), ...SELF };
  saveRun(stale);
  assert.equal(laneInFlight(stale), false);
  assert.equal(readCold(root, stale.id).status, 'interrupted');

  const dead = liveChild();
  await dead.kill();
  const root2 = scratch();
  const orphan = midBaseline(root2);
  orphan.laneBeat = { at: new Date().toISOString(), pid: dead.pid, procStartedAt: dead.procStartedAt };
  saveRun(orphan);
  assert.equal(laneInFlight(orphan), false, 'the console that beat is gone');
  assert.equal(readCold(root2, orphan.id).status, 'interrupted');
});

/* ------------------------------------------------------------------ *
 * The runner records them
 * ------------------------------------------------------------------ */

function harness(): { root: string; scriptsDir: string } {
  const root = scratch();
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
  writeFileSync(join(root, 'setup.sh'), 'sleep 1\n');
  writeFileSync(join(root, 'slow.sh'), 'sleep 2\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
S="${root}"
case "$2" in
  --memory-block)
    if [ -f "$S/.done-1" ]; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, scriptsDir };
}

test('BL-4: the runner records the Setup and baseline commands\' processes on the run, and a cold read keeps the run `running` meanwhile', async () => {
  const h = harness();
  const seen: { stage?: string; child?: { pid: number; procStartedAt: string }; command: string; cold: string }[] = [];
  let runner!: Runner;
  runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    setupText: () => '`bash setup.sh`',
    spawn: async () => {
      // While the session works, the baseline runs beside it: watch what the
      // run records, and read it cold the way another reader would.
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const state = runner.current();
        const check = state?.verifying?.['1'];
        if (check?.child && !seen.some((entry) => entry.child?.pid === check.child!.pid)) {
          seen.push({
            ...(check.stage ? { stage: check.stage } : {}), child: check.child, command: check.command,
            cold: readCold(h.root, state!.id).status,
          });
        }
        if (state?.phases['1']?.baseline) break;
        await new Promise((done) => setTimeout(done, 50));
      }
      writeFileSync(join(h.root, '.done-1'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verificationText: () => '`bash slow.sh`',
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  const setup = seen.find((entry) => entry.stage === 'setup');
  const command = seen.find((entry) => !entry.stage);
  assert.ok(setup, `the Setup command was recorded with its process: ${JSON.stringify(seen)}`);
  assert.equal(setup!.command, 'bash setup.sh');
  assert.ok(command, 'the baseline command was recorded with its process');
  assert.equal(command!.command, 'bash slow.sh');
  for (const entry of seen) {
    assert.ok(entry.child!.pid > 0 && Number.isFinite(Date.parse(entry.child!.procStartedAt)), 'a (pid, procStartedAt) pair');
    assert.equal(entry.cold, 'running', 'a cold read never painted the run interrupted');
  }
  assert.equal(state.phases['1']!.status, 'done');
  assert.equal(state.verifying, undefined, 'the entry is gone with the pass');
});
