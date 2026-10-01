/**
 * The console's own §Verification is a visible lane (control-tower phase 89,
 * #68's 2026-09-25 05:44Z comment).
 *
 * A shop plan's P56 session ended; the console ran `pnpm verify:local`
 * itself for 12+ minutes while holding P56's grant, five phases queued behind
 * it — and `/api/runs` showed the run `running` with `children: {}`, the Runs
 * page nothing working. An operator asked why phases "in progress" on the
 * board appeared nowhere.
 *
 * VL-1  while the console runs a phase's §Verification, the run carries a
 *       runner-owned `verifying` lane — phase, command i of n, when the pass
 *       started — and the lane is gone when the pass ends
 * VL-2  `/api/runs` and its slim projection carry the lanes of THIS console
 *       only: an entry a dead console left (another pid) is over, not live
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { VerifyOptions } from '../server/runner/verify.ts';
import { newRun, type VerifyingLane, type VerifySummary } from '../server/runner/state.ts';
import * as projection from '../server/runs-projection.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

test('VL-1: while the console verifies, the run carries its own lane — phase, command i of n, the pass\'s start — and it is gone after', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vl-')));
  TRASH.push(root);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done\n');
  writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) if [ -f "${root}/.done" ]; then echo "done: 56"; echo "ready: "; else echo "done: "; echo "ready: 56"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const LINES = ['pnpm lint', 'pnpm verify:local'];
  const seen: (VerifyingLane | undefined)[] = [];
  let slim: ReturnType<typeof projection.slimRun> | undefined;
  // eslint-disable-next-line prefer-const
  let runner: Runner;
  runner = new Runner({
    scriptsDir: scripts,
    spawn: async () => {
      writeFileSync(join(root, '.done'), '');
      return { signal: { subtype: 'success' as const, code: 0, text: 'done' }, sessionId: 'sid-56', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [] };
    },
    verify: async (_text: string, opts: VerifyOptions): Promise<VerifySummary> => {
      LINES.forEach((command, index) => {
        opts.onStart?.(command, index, LINES.length);
        seen.push(JSON.parse(JSON.stringify(runner.current()!.verifying?.['56'] ?? null)) ?? undefined);
      });
      slim = projection.slimRun(runner.current()!, []);
      return { ok: true, reason: '2 commands green', notRun: [], ran: LINES.map((command) => ({ command, ok: true, code: 0, ms: 5, output: '' })) };
    },
    verificationText: () => LINES.map((line) => `- \`${line}\``).join('\n'),
  } as never);
  const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going' });
  await runner.wait();

  assert.equal(state.phases['56'].status, 'done', state.phases['56'].note);
  assert.deepEqual(seen.map((lane) => lane && [lane.phase, lane.purpose, lane.command, lane.index, lane.total]), [
    [56, 'verify', 'pnpm lint', 1, 2],
    [56, 'verify', 'pnpm verify:local', 2, 2],
  ], 'command i of n, as each starts');
  assert.ok(seen[0]!.startedAt && seen[1]!.startedAt === seen[0]!.startedAt, 'the pass\'s start, kept across its commands');
  assert.equal(seen[1]!.pid, process.pid, 'owned by this console');
  assert.equal(slim?.verifying?.['56']?.command, 'pnpm verify:local', 'the slim projection carries it while it runs');
  assert.deepEqual(slim?.children, {}, 'beside no session — which is why it needs a lane of its own');
  assert.equal(state.verifying, undefined, 'gone when the pass ends');
});

test('VL-2: /api/runs carries only the lanes this console is running — one a dead console left is over', () => {
  const run = newRun({ slug: 'demo', root: '/tmp/none' });
  const lane = (phase: number, pid: number): VerifyingLane => ({
    phase, purpose: 'verify', command: 'pnpm verify:local', index: 3, total: 5,
    startedAt: '2026-09-25T05:32:00.000Z', commandStartedAt: '2026-09-25T05:40:00.000Z', pid,
  });
  run.verifying = { 56: lane(56, process.pid), 57: lane(57, process.pid + 100_000) };
  const live = (projection as unknown as { liveVerifying?: (r: typeof run) => Record<string, VerifyingLane> }).liveVerifying?.(run) ?? {};
  assert.deepEqual(Object.keys(live), ['56']);
  assert.deepEqual(Object.keys(projection.slimRun(run, []).verifying ?? {}), ['56']);
});
