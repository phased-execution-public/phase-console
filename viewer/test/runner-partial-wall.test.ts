/**
 * A partial's retry walled mid-session keeps its lane again (measured-console
 * phase 13, #417 — a regression of #354).
 *
 * #354 made any `partial` that leaves its own WIP uncommitted in a shared tree
 * keep its lane (`keepsLane`), spent when the phase boards again. #417 is the
 * path that spent it and never wrote it back: hub run 29fb3925d4d9, phase 12
 * declared `partial --reason context` with 39 staged paths, re-boarded (the
 * keep spent), and attempt 2 was rate limited mid-session — the live wall
 * checkpointed the child and parked the phase `waiting` on the window. A
 * session the console ends from outside declares no outcome, so no outcome arm
 * re-kept the lane; phase 13 of the same run, same scope, boarded into the
 * staged work at the run's next pass.
 *
 *   PW-1  the walled retry keeps the lane again (`phase.lane-kept`, reason
 *         `usage-wall`, the one uncommitted file), the phase `waiting` on the
 *         window with `keepsLane` on the record;
 *   PW-2  the pass the walled lane's release wakes (where, before the fix,
 *         sibling 13 boarded at once), and the run's next drive with phase 7
 *         still waiting on its window, both hold sibling 13 (`run.lane-held`,
 *         holder 7): it never boards into phase 7's uncommitted work, and the
 *         run waits instead.
 *
 * The harness is `lane-keeps.test.ts`'s: two phases of `demo` in ONE git tree,
 * both scoped to `trade`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;
type StreamEvent = import('../server/runner/spawn.ts').StreamEvent;

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

/** The CLI's own retry on a 429, with the hour it asks the session to stay away — a reset past the action cooldown. */
const rateLimited = (attempt: number): StreamEvent =>
  ({ kind: 'retry', category: 'rate_limit', attempt, detail: 'API Error: 429', retryDelayMs: 3_600_000 } as StreamEvent);

async function walledRetry() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-pw-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'ledger.py'), 'the base\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.board\n');
  const board = (done: number[]) => {
    const open = [7, 13].filter((p) => !done.includes(p));
    writeFileSync(join(root, '.board'), [
      `done: ${done.join(',')}`, `in-progress: ${open.includes(7) ? '7' : ''}`, 'stuck: ',
      `ready: ${open.includes(13) ? '13' : ''}`, 'waiting: ',
    ].join('\n') + '\n');
  };
  board([]);
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) cat "${root}/.board" ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  gitIn(root, ['init', '-q']);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'base']);

  const done: number[] = [];
  const spawned: number[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const spawn = async (req: { prompt: string; env?: Record<string, string>; onEvent?: (event: StreamEvent) => void }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push(phase);
    const nth = spawned.filter((p) => p === 7).length;
    if (phase === 7 && nth === 1) {
      // Attempt 1: half a rewrite, uncommitted, and a context partial no
      // wrap-up notice asked for — #354's keep.
      writeFileSync(join(root, 'ledger.py'), 'half of the ledger rewrite (replay_prompt still red)\n');
      const file = req.env?.PE_OUTCOME_FILE;
      assert.ok(file, 'the session was handed its outcome file');
      mkdirSync(dirname(file!), { recursive: true });
      writeFileSync(file!, JSON.stringify({
        version: 1, slug: 'demo', phase: 7, status: 'partial', reason: 'context', written_at: new Date().toISOString(), session_id: 'sid-7a',
      }));
      return { signal: { subtype: 'success' as const, code: 0, text: 'handed off' }, sessionId: 'sid-7a', costUsd: 0, turns: 1, resultText: 'handed off', durationMs: 1, argv: [] };
    }
    if (phase === 7 && nth === 2) {
      // Attempt 2: rate limited MID-SESSION — the CLI's retry watchdog, three
      // 429s with no work between them. The live wall checkpoints the child and
      // parks the phase on the window; the child then dies of the checkpoint.
      // Nothing is declared: no outcome file is written.
      for (let i = 1; i <= 3; i += 1) req.onEvent?.(rateLimited(i));
      return { signal: { subtype: 'error' as const, code: 143, text: 'terminated' }, sessionId: 'sid-7a', costUsd: 0, turns: 1, resultText: '', durationMs: 1, argv: [] };
    }
    done.push(phase);
    board(done);
    return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: `sid-${phase}-${spawned.length}`, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
  };
  /** The console's own wake at the lane's teardown, every time — #192's window. */
  class Console extends Runner {
    protected override noteLaneFreed(phase: number, scope: readonly string[]): void {
      super.noteLaneFreed(phase, scope);
      (this as unknown as { wake: { resolve(): void } }).wake.resolve();
    }
  }
  const drive = async (runId: string) => {
    const scheduler = new Scheduler({ max: 4, locks: () => [] });
    const runner = new Console({
      scriptsDir: scripts,
      spawn,
      scheduler,
      phaseScope: () => ['trade'],
      verificationText: () => '- `true`',
      verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
      // No other account to move to: the wall waits on its window.
      autoAccountSwitch: () => false,
      pickAccount: () => null,
      onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
    } as never);
    try {
      await runner.start({ slug: 'demo', root, resumeRunId: runId, maxParallel: 2 } as never);
      await runner.wait();
    } finally {
      scheduler.close();
      runner.stop?.();
    }
    return runner.current()!;
  };

  const stored: RunState = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: true, onLimit: 'wait' } as never);
  stored.status = 'parked';
  Object.assign(phaseRecord(stored, 7), {
    status: 'pending', attempts: 1,
    boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: new Date(Date.now() - 60_000).toISOString(), by: 'console' },
  });
  saveRun(stored);

  // The first drive: the partial, its re-board, the wall — and the pass the
  // walled lane's release wakes, in which #417's sibling boarded.
  const walled = await drive(stored.id);
  const afterWall = { spawned: [...spawned], state: structuredClone(walled) };
  // The run's next drive (the window's clock, a Continue), with phase 7 still
  // waiting on its window: the keep is on the stored record, so it holds there too.
  const next = await drive(stored.id);
  const journalled = (name: string) => events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number }));
  return { afterWall, spawned, journalled, state: next, root };
}

test('PW-1 + PW-2 (#417): a partial whose retry is walled mid-session keeps its lane again, and its sibling never boards into its uncommitted work', async () => {
  const { afterWall, spawned, journalled, state, root } = await walledRetry();

  // The path #417 took: the partial kept its lane, re-boarded (the keep
  // spent), and its retry met the wall on the stream and was parked waiting.
  // Before the fix the walled lane's release boarded the sibling in the same
  // drive: [7, 7, 13].
  assert.deepEqual(afterWall.spawned, [7, 7], `phase 13 never boards into phase 7's uncommitted work once the wall frees the lane: ${JSON.stringify(afterWall.spawned)}`);
  const walls = journalled('phase.live-wall');
  assert.equal(walls.length, 1, `one live wall: ${JSON.stringify(walls)}`);
  assert.equal(walls[0]!.action, 'wait');
  const record = afterWall.state.phases['7']!;
  assert.equal(record.status, 'waiting', 'the walled retry waits on the window');
  assert.ok(record.usageWall, 'parked on the usage wall');

  // PW-1: the walled retry kept the lane again.
  const kept = journalled('phase.lane-kept');
  assert.equal(kept.length, 2, `kept at the partial, and again at the wall: ${JSON.stringify(kept)}`);
  assert.equal(kept[0]!.reason, 'context');
  assert.equal(kept[1]!.phase, 7);
  assert.equal(kept[1]!.reason, 'usage-wall');
  assert.equal(kept[1]!.paths, 1, 'the one uncommitted file is its own');
  assert.ok(record.keepsLane, 'the waiting phase keeps its lane on the record');

  // PW-2: the pass the wall frees, and the run's next drive, hold the sibling
  // — it never boards over the WIP.
  assert.ok(!spawned.includes(13), `phase 13 never boards into phase 7's uncommitted work: ${JSON.stringify(spawned)}`);
  const held = journalled('run.lane-held');
  assert.ok(held.length >= 1, `the sibling is held: ${JSON.stringify(held)}`);
  assert.equal(held[0]!.phase, 13);
  assert.equal(held[0]!.holder, 7);
  assert.equal(held[0]!.reason, 'usage-wall');
  assert.notEqual(state.phases['13']!.status, 'running');
  assert.equal(readFileSync(join(root, 'ledger.py'), 'utf8'), 'half of the ledger rewrite (replay_prompt still red)\n', 'the WIP is untouched');
});
