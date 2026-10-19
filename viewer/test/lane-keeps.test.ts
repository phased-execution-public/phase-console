/**
 * The lane holder (one-pool phase 21, #354 #295).
 *
 * #192 kept a wrap-up's lane — but only the wrap-up the console's notice asked
 * for, and only while its attempt settled or it was itself a candidate. Two
 * holes stayed open:
 *
 *   #354  a `partial --reason context` the notice did not ask for climbed the
 *         ladder instead, kept nothing, and phase 13 of the SAME run boarded
 *         into phase 7's sixteen uncommitted files;
 *   #295  phase 30 declared `waiting-external` on its own detached verify (a
 *         `cmd:` file probe) and its sibling phase 27 was admitted into the
 *         tree that verify was measuring.
 *
 *   LK-1  any `partial` that leaves its own WIP uncommitted in a shared tree
 *         keeps its lane: it re-boards before the scope-intersecting sibling,
 *         `phase.lane-kept` once, spent at boarding;
 *   LK-2  a `waiting-external` on a `cmd:` probe keeps the tree for its job:
 *         the sibling is held (`run.lane-held`, holder 7, `detached-verify`)
 *         and never boards while phase 7 waits — the run waits instead;
 *   LK-3  a wait on somebody else's clock (`gh:`) with nothing uncommitted
 *         keeps nothing — the sibling boards as before;
 *   LK-4  a lane in a worktree of its own keeps nothing: no sibling boards
 *         into it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { Scheduler } = await import('../server/runner/scheduler.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

type FirstOutcome =
  | { kind: 'partial' }
  | { kind: 'wait'; watch: string; wip: boolean };

/**
 * Two phases of `demo` in ONE git tree, both scoped to `trade`: phase 7 sits
 * in progress with a hint (it boards first), phase 13 is graph-ready. Phase 7's
 * first session declares `first` — with NO wrap-up notice behind it — and every
 * later session marks its phase done.
 */
async function race(first: FirstOutcome) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-lk-')));
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
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  const spawn = async (req: { prompt: string; env?: Record<string, string> }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push(phase);
    if (phase === 7 && spawned.filter((p) => p === 7).length === 1) {
      const wip = first.kind === 'partial' || first.wip;
      if (wip) writeFileSync(join(root, 'ledger.py'), 'half of the ledger rewrite (replay_prompt still red)\n');
      const file = req.env?.PE_OUTCOME_FILE;
      assert.ok(file, 'the session was handed its outcome file');
      mkdirSync(dirname(file!), { recursive: true });
      const outcome = first.kind === 'partial'
        ? { status: 'partial', reason: 'context' }
        : { status: 'waiting-external', reason: 'the detached verify', watch: [first.watch], resume_after: new Date(Date.now() + 3_600_000).toISOString() };
      writeFileSync(file!, JSON.stringify({ version: 1, slug: 'demo', phase: 7, ...outcome, written_at: new Date().toISOString(), session_id: 'sid-7a' }));
      return { signal: { subtype: 'success' as const, code: 0, text: 'handed off' }, sessionId: 'sid-7a', costUsd: 0, turns: 1, resultText: 'handed off', durationMs: 1, argv: [] };
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
  const runner = new Console({
    scriptsDir: scripts,
    spawn,
    scheduler,
    phaseScope: () => ['trade'],
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  const stored: RunState = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: true } as never);
  stored.status = 'parked';
  Object.assign(phaseRecord(stored, 7), {
    status: 'pending', attempts: 1,
    boardingHint: { situation: 'work-in-progress', rung: 'reboard-resume-brief', brief: 'resume', at: new Date(Date.now() - 60_000).toISOString(), by: 'console' },
  });
  saveRun(stored);
  try {
    await runner.start({ slug: 'demo', root, resumeRunId: stored.id, maxParallel: 2 } as never);
    await runner.wait();
  } finally {
    scheduler.close();
    runner.stop?.();
  }
  const journalled = (name: string) => events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number }));
  return { spawned, journalled, state: runner.current()! };
}

test('LK-1 (#354): a context `partial` the wrap-up notice did not ask for keeps its lane over its uncommitted WIP', async () => {
  const { spawned, journalled, state } = await race({ kind: 'partial' });
  const kept = journalled('phase.lane-kept');
  assert.equal(kept.length, 1, `the partial kept its lane, once: ${JSON.stringify(kept)}`);
  assert.equal(kept[0]!.phase, 7);
  assert.equal(kept[0]!.reason, 'context');
  assert.equal(kept[0]!.paths, 1, 'the one uncommitted file is its own');
  assert.deepEqual(spawned.slice(0, 2), [7, 7], `phase 7 re-boards before phase 13 touches its tree: ${JSON.stringify(spawned)}`);
  assert.ok(journalled('phase.serial-behind').filter((line) => line.phase === 7).length === 0, 'the partial is never behind its sibling');
  assert.equal(state.phases['7']!.keepsLane, undefined, 'spent at boarding');
  assert.equal(state.phases['7']!.status, 'done');
});

test('LK-2 (#295): a wait on the session\'s own detached verify keeps its tree — the sibling is held, the run waits', async () => {
  const { spawned, journalled, state } = await race({ kind: 'wait', watch: 'cmd:test -f /tmp/pc-lk-never/verify.exit', wip: false });
  const kept = journalled('phase.lane-kept');
  assert.equal(kept.length, 1, `the wait kept its lane: ${JSON.stringify(kept)}`);
  assert.equal(kept[0]!.reason, 'detached-verify');
  assert.equal(kept[0]!.paths, 0);
  assert.equal(kept[0]!.watch, 'cmd:test -f /tmp/pc-lk-never/verify.exit');
  assert.deepEqual(spawned, [7], `phase 13 never boards into the tree under test: ${JSON.stringify(spawned)}`);
  const held = journalled('run.lane-held');
  assert.equal(held.length, 1, `held once: ${JSON.stringify(held)}`);
  assert.equal(held[0]!.phase, 13);
  assert.equal(held[0]!.holder, 7);
  assert.equal(held[0]!.reason, 'detached-verify');
  assert.equal(state.phases['7']!.status, 'waiting');
  assert.ok(state.phases['7']!.keepsLane, 'kept until it boards again');
  assert.notEqual(state.phases['13']!.status, 'running');
});

test('LK-3: a wait on somebody else\'s clock with nothing uncommitted keeps nothing — the sibling boards', async () => {
  const { spawned, journalled } = await race({ kind: 'wait', watch: 'gh:acme/app#run/42', wip: false });
  assert.deepEqual(journalled('phase.lane-kept'), [], 'nothing of phase 7 is in the tree');
  assert.deepEqual(journalled('run.lane-held'), []);
  assert.ok(spawned.includes(13), `the sibling boards: ${JSON.stringify(spawned)}`);
});

test('LK-4: a lane in a worktree of its own keeps nothing', async () => {
  const runner = new Runner({ scriptsDir: '/nonexistent', spawn: async () => { throw new Error('no spawn'); }, verificationText: () => '' } as never);
  const handle = runner as never as Record<string, unknown>;
  const state = newRun({ slug: 'demo', root: tmpdir() } as never);
  handle.state = state;
  handle.record = () => {};
  (handle.lanes as Map<number, unknown>).set(7, { phase: 7, worktree: { dir: '/elsewhere' } });
  const record = phaseRecord(state, 7);
  const keep = handle.keepLaneIfOwed as (phase: number, record: unknown, reason: string, at?: string, watch?: string[]) => Promise<boolean>;
  assert.equal(await keep.call(runner, 7, record, 'waiting-external', undefined, ['cmd:test -f /tmp/x']), false);
  assert.equal(record.keepsLane, undefined);
});
