/**
 * A wrap-up keeps its lane (control-tower phase 109, #192, RS-7).
 *
 * Measured on hub 0598886e, which carries #128's seniority fix: ai-builder-v7
 * P7 wrapped up at the 0.6× notice, declared `partial / context` with red WIP
 * uncommitted in the shared tree — and the graph-ready sibling P13, whose scope
 * named that repository, was admitted ONE SECOND later:
 *
 *   22:43:41 P7  phase.resume-automatic {trigger: outcome, path: wrapup}
 *   22:43:42 P7  phase.undriven  "hinted reboard-resume-brief … no candidate pass takes it"
 *   22:43:42 P13 phase.admitted
 *   22:43:43 P7  phase.serial-behind {behind: 13}
 *
 * The lane's teardown released its grant and woke the loop (`noteLaneFreed`)
 * before its attempt returned, so in that pass P7 was in flight — no candidate
 * — and its scope looked free.
 *
 *   RS-7  a phase that hands off `partial` with its own WIP uncommitted in a
 *         shared tree re-boards ahead of every sibling whose scope meets its
 *         own, in the same pass that released it: the sibling is serial behind
 *         it, never admitted past it, and the supervisor's `hinted-not-queued`
 *         has nothing to see;
 *   RS-7  `keepsLane` ranks right after a person's re-board in `boardingOrder`,
 *         and it is spent the moment the phase boards;
 *   RS-7  a wrap-up whose work is all committed keeps no lane — its siblings
 *         board by seniority as before.
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

/**
 * Two phases of `demo` in ONE git tree, both scoped to `trade`: phase 7 sits
 * in progress with a hint (it boards first), phase 13 is graph-ready. Phase 7's
 * first session leaves `wip` in the tree — uncommitted, or committed — is told
 * to wrap up and declares `partial --reason context`; every later session marks
 * its phase done.
 */
async function wrapupRace(opts: { wip: 'uncommitted' | 'committed' }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-rs7-')));
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
  // eslint-disable-next-line prefer-const
  let runner: InstanceType<typeof Runner>;
  const spawn = async (req: { prompt: string; env?: Record<string, string> }) => {
    const phase = Number(/BOOT phase (\d+)/.exec(req.prompt)?.[1] ?? 0);
    spawned.push(phase);
    const record = runner.current()!.phases[String(phase)]!;
    if (phase === 7 && spawned.filter((p) => p === 7).length === 1) {
      writeFileSync(join(root, 'ledger.py'), 'half of the ledger rewrite (replay_prompt still red)\n');
      if (opts.wip === 'committed') {
        gitIn(root, ['add', 'ledger.py']);
        gitIn(root, ['commit', '-q', '-m', 'wip: ledger']);
      }
      record.contextWrapup = { sessionId: 'sid-7a', at: new Date().toISOString(), context: 610_000, window: 1_000_000, delivered: true, attempts: 1 };
      const file = req.env?.PE_OUTCOME_FILE;
      assert.ok(file, 'the session was handed its outcome file');
      mkdirSync(dirname(file!), { recursive: true });
      writeFileSync(file!, JSON.stringify({ version: 1, slug: 'demo', phase: 7, status: 'partial', reason: 'context', written_at: new Date().toISOString(), session_id: 'sid-7a' }));
      return { signal: { subtype: 'success' as const, code: 0, text: 'wrapped up' }, sessionId: 'sid-7a', costUsd: 0, turns: 1, resultText: 'wrapped up', durationMs: 1, argv: [] };
    }
    done.push(phase);
    board(done);
    return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: `sid-${phase}-${spawned.length}`, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
  };
  /**
   * The console's own wake at the lane's teardown, every time: on the live
   * console `noteLaneFreed` resolves the loop's wake whenever the ladder has
   * seen a phase, and the docs watcher wakes it for the lock file the release
   * rewrote — #192's pass ran in exactly that window.
   */
  class Console extends Runner {
    protected override noteLaneFreed(phase: number, scope: readonly string[]): void {
      super.noteLaneFreed(phase, scope);
      (this as unknown as { wake: { resolve(): void } }).wake.resolve();
    }
  }
  runner = new Console({
    scriptsDir: scripts,
    spawn,
    scheduler,
    phaseScope: () => ['trade'],
    verificationText: () => '- `true`',
    verify: async () => ({ ok: true, reason: 'green', notRun: [], ran: [] }),
    onEvent: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never);
  const stored: RunState = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
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
  }
  const journalled = (name: string) => events
    .filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => ({ ...((e.data.data ?? {}) as Record<string, unknown>), phase: e.data.phase as number }));
  return { spawned, journalled, state: runner.current()! };
}

test('RS-7: a wrap-up `partial` with its WIP uncommitted re-boards before the scope-intersecting sibling — in the pass that released it', async () => {
  const { spawned, journalled, state } = await wrapupRace({ wip: 'uncommitted' });
  assert.deepEqual(spawned, [7, 7, 13], 'the wrapped phase is admitted first; the sibling waits for it, not the other way round');
  const kept = journalled('phase.lane-kept');
  assert.equal(kept.length, 1, 'the wrap-up kept its lane, once');
  assert.equal(kept[0]!.phase, 7);
  assert.equal(kept[0]!.paths, 1, 'the one uncommitted file is its own');
  assert.equal(kept[0]!.reason, 'context');
  const serial = journalled('phase.serial-behind').filter((line) => line.phase === 13);
  assert.ok(serial.length >= 1, 'the sibling read serial behind it');
  assert.ok(serial.every((line) => line.behind === 7), `behind phase 7, every time: ${JSON.stringify(serial)}`);
  assert.deepEqual(journalled('phase.serial-behind').filter((line) => line.phase === 7), [], 'the wrapped phase is never behind its sibling');
  assert.deepEqual(journalled('phase.undriven').filter((line) => line.phase === 7), [], 'a lane still settling is driven — nothing to strand');
  const admitted13 = events13(journalled);
  const reboard7 = journalled('phase.start').filter((line) => line.phase === 7)[1];
  assert.ok(reboard7, 'phase 7 boarded a second time');
  assert.ok(admitted13 === null || admitted13 >= 2, 'phase 13 started only after phase 7\'s second boarding');
  assert.equal(state.phases['7']!.keepsLane, undefined, 'spent at boarding');
  assert.equal(state.phases['7']!.status, 'done');
  assert.equal(state.phases['13']!.status, 'done');
});

/** Phase 13's position among the `phase.start` lines, or null. */
function events13(journalled: (name: string) => Record<string, unknown>[]): number | null {
  const starts = journalled('phase.start');
  const at = starts.findIndex((line) => line.phase === 13);
  return at < 0 ? null : at;
}

test('RS-7: a wrap-up whose work is all committed keeps no lane — the shared tree holds nothing of it', async () => {
  const { journalled } = await wrapupRace({ wip: 'committed' });
  assert.deepEqual(journalled('phase.lane-kept'), [], 'nothing uncommitted, no lane kept');
});

test('RS-7: `keepsLane` boards right after a person\'s re-board — ahead of a pin, a red WIP and every seniority clock', async () => {
  const h = { root: realpathSync(mkdtempSync(join(tmpdir(), 'pc-rs7-order-'))) };
  TRASH.push(h.root);
  const runner = new Runner({ scriptsDir: '/nonexistent', spawn: async () => { throw new Error('no spawn'); }, verificationText: () => '' } as never);
  const handle = runner as never as Record<string, unknown>;
  const state = newRun({ slug: 'demo', root: h.root } as never);
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  Object.assign(phaseRecord(state, 1), { status: 'pending', queueSince: old });
  Object.assign(phaseRecord(state, 2), { status: 'pending', wipRed: { sha: 'abc', at: old } });
  Object.assign(phaseRecord(state, 3), { status: 'pending', keepsLane: { at: now, reason: 'context', sessionId: 's', paths: 3 } });
  Object.assign(phaseRecord(state, 4), { status: 'pending', boardingHint: { situation: 'work-in-progress', rung: 'resume-own-session', brief: 'resume', at: now, by: 'operator' } });
  Object.assign(phaseRecord(state, 5), { status: 'pending', queueControl: { pin: { at: old, by: 'operator' } } });
  handle.state = state;
  handle.record = () => {};
  const order = (handle.boardingOrder as (phases: number[]) => number[]).call(runner, [1, 2, 3, 4, 5]);
  assert.deepEqual(order, [4, 3, 5, 2, 1], 'a person\'s re-board, then the kept lane, then a pin, a red WIP, the oldest queue');
});
