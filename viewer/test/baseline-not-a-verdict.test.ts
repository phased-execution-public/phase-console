/**
 * A baseline is a measurement, never a verdict (control-tower phase 105, #190
 * ask 1).
 *
 * The one recorded retry in `verifyPhase` was written for the VERDICT: a red
 * there re-opens a phase, and three spurious full-suite reds in one night were
 * green on a second run. The boarding baseline went through the same loop, so
 * every red baseline line ran twice — on ai-builder-v7 a red `task
 * verify:local` (702 s) was run again before the session could board, to
 * confirm a red that decides nothing: the baseline only names what was red
 * before the phase touched the tree.
 *
 * BL-1  a red BASELINE line is run once and recorded `red once (not retried)`;
 *       the verdict keeps its one recorded retry
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { verifyPhase, type VerifyOptions } from '../server/runner/verify.ts';
import type { RunState, VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { baselineLineWords } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** A red line that counts how many times it ran. */
function countingRed(dir: string): string {
  writeFileSync(join(dir, 'red.sh'), 'echo ran >> "$(dirname "$0")/runs.txt"\necho "not ok 1 - suite › red"\nexit 1\n');
  return 'bash red.sh';
}
const runsOf = (dir: string): number =>
  (existsSync(join(dir, 'runs.txt')) ? readFileSync(join(dir, 'runs.txt'), 'utf8').split('\n').filter(Boolean).length : 0);

test('BL-1: a red baseline line runs ONCE — no retry row, the command not re-run', async () => {
  const dir = scratch('pc-bl1-');
  const command = countingRed(dir);
  const summary = await verifyPhase(`\`${command}\``, { cwd: dir, purpose: 'baseline', cascade: false, timeoutMs: 60_000 });
  assert.equal(runsOf(dir), 1, 'the baseline measured the red line once');
  assert.equal(summary.ran.length, 1);
  assert.equal(summary.ran[0]!.ok, false);
  assert.equal(summary.ran.some((row) => row.retry), false, 'no retry row: the retry is the verdict\'s alone');
});

test('BL-1: the VERDICT keeps its one recorded retry for the same red line', async () => {
  const dir = scratch('pc-bl1v-');
  const command = countingRed(dir);
  const summary = await verifyPhase(`\`${command}\``, { cwd: dir, timeoutMs: 60_000 });
  assert.equal(runsOf(dir), 2, 'a red verdict line is run a second time, as before');
  assert.deepEqual(summary.ran.map((row) => Boolean(row.retry)), [false, true]);
});

/* ------------------------------------------------------------------ *
 * Through the runner: the record and the journal say it
 * ------------------------------------------------------------------ */

function harness(): { root: string; scriptsDir: string } {
  const root = scratch('pc-bl1r-');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
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

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('BL-1: the runner records a measured red baseline line as `red once (not retried)` — on the record and in the journal', async () => {
  const h = harness();
  const purposes: string[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async () => {
      writeFileSync(join(h.root, '.done-1'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verify: async (_text: string, opts: VerifyOptions): Promise<VerifySummary> => {
      purposes.push(opts.purpose ?? 'verify');
      if (opts.purpose === 'baseline') {
        // What the real verifier now answers for a red baseline line: one row.
        return {
          ok: false, reason: '`npm test` exited 1', notRun: [],
          ran: [{ command: 'npm test', ok: false, code: 1, ms: 5, output: 'not ok 1 - suite › A', failures: ['suite › A'] }],
        };
      }
      return { ok: true, reason: '1 command green', notRun: [], ran: [{ command: 'npm test', ok: true, code: 0, ms: 5, output: '' }] };
    },
    verificationText: () => '`npm test`',
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.equal(purposes.filter((purpose) => purpose === 'baseline').length, 1, 'the baseline asked the verifier once');
  const line = state.phases['1']!.baseline?.commands[0];
  assert.ok(line, 'the baseline was recorded');
  assert.equal(line!.ok, false);
  assert.equal(line!.once, true, 'a measured red is marked as run once');
  assert.equal(baselineLineWords(line!), 'red once (not retried)');
  const entry = journal(h.root, state).find((row) => row.event === 'phase.verify-baseline');
  assert.ok(entry, 'the baseline is journalled');
  assert.deepEqual(entry!.data.redOnce, ['npm test'], 'the journal names the line measured red once');
});
