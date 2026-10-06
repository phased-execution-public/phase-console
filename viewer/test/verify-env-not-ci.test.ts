/**
 * A §Verification line runs in the session's environment (control-tower
 * phase 106, #195).
 *
 * `runOne` added `CI: '1'` to every line's environment. Suites read `CI` as
 * "this is the CI infrastructure", not as "be non-interactive":
 * app-backend's preview-store tests skip on a laptop whose Redis wants a
 * password and ERROR under `CI`, and two of its perf suites scale their bounds
 * 3× on it. A line green in the session's own shell was therefore red every
 * time the console ran it — at the baseline ("red before you started", for a
 * line that was not) and at a verdict, where it re-opened a green phase.
 *
 * VE-1  the verify environment sets no `CI`: non-interactivity comes from
 *       `NO_COLOR`, `TERM=dumb` and a closed stdin; a `CI` the console itself
 *       inherited passes through unchanged (and stays in the reuse key); a red
 *       line keeps its failing ids and an output tail for a BASELINE as for a
 *       verdict — on the record, in the ledger, and in the session's note
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
import { frameBaselineNote } from '../server/runner/runner-attempt.ts';
import { verifyEnvDigest, verifyPhase, type VerifyOptions } from '../server/runner/verify.ts';
import type { VerifySummary } from '../server/runner/state.ts';
import { verificationsFile } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix = 'pc-ve1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** The console's own environment as a session's shell has it: no `CI`. */
function withoutCi(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CI;
  return env;
}

/** A suite whose branch flips on `CI`, as app-backend's `test_preview_store.py` does. */
function ciBranchingSuite(dir: string): string {
  writeFileSync(join(dir, 'suite.sh'), [
    'if [ -n "${CI:-}" ]; then',
    '  echo "not ok 1 - preview store › round-trip (CI=$CI: CI\'s Redis is passwordless)"',
    '  exit 1',
    'fi',
    'echo "ok 1 - preview store › round-trip # SKIP the laptop\'s Redis wants a password"',
    'exit 0',
    '',
  ].join('\n'));
  return 'bash suite.sh';
}

test('VE-1: a line whose suite branches on CI is green when the console runs it — as it was in the session', async () => {
  const dir = scratch();
  const command = ciBranchingSuite(dir);
  const summary = await verifyPhase(`\`${command}\``, { cwd: dir, env: withoutCi(), timeoutMs: 60_000 });
  assert.equal(summary.ok, true, summary.reason);
  assert.equal(summary.ran.length, 1, 'green the first time — no retry was needed');
});

test('VE-1: the environment says non-interactive without saying CI — NO_COLOR, TERM=dumb, a closed stdin', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'env.sh'), [
    'echo "CI=[${CI-unset}] NO_COLOR=[${NO_COLOR-}] TERM=[${TERM-}]"',
    'if read -r line; then echo "stdin=open"; else echo "stdin=closed"; fi',
    '',
  ].join('\n'));
  const summary = await verifyPhase('`bash env.sh`', { cwd: dir, env: withoutCi(), timeoutMs: 60_000 });
  const out = summary.ran[0]!.output;
  assert.match(out, /CI=\[unset\]/, 'the console no longer tells the suite it is in CI');
  assert.match(out, /NO_COLOR=\[1\]/);
  assert.match(out, /TERM=\[dumb\]/);
  assert.match(out, /stdin=closed/, 'nothing can wait on a prompt');
});

test('VE-1: a CI the console itself inherited is passed through unchanged — never forced to 1', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'env.sh'), 'echo "CI=[${CI-unset}]"\n');
  const summary = await verifyPhase('`bash env.sh`', { cwd: dir, env: { ...withoutCi(), CI: 'true' }, timeoutMs: 60_000 });
  assert.match(summary.ran[0]!.output, /CI=\[true\]/);
});

test('VE-1: the Setup preamble runs in the same environment as the lines it brings up', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'setup.sh'), 'if [ -n "${CI:-}" ]; then echo "setup saw CI=$CI"; exit 3; fi\n');
  const command = ciBranchingSuite(dir);
  const summary = await verifyPhase(`\`${command}\``, {
    cwd: dir, env: withoutCi(), timeoutMs: 60_000, setupText: '`bash setup.sh`',
  });
  assert.equal(summary.setup, undefined, `the Setup ran green: ${summary.setup?.output ?? ''}`);
  assert.equal(summary.ok, true);
});

test('VE-1: the reuse key still reads CI — an inherited CI is a different environment from none', () => {
  assert.notEqual(
    verifyEnvDigest({ env: withoutCi() }),
    verifyEnvDigest({ env: { ...withoutCi(), CI: 'true' } }),
    'a measurement under the console\'s inherited CI never stands in for one without it',
  );
});

/* ------------------------------------------------------------------ *
 * A red keeps what it said — for a baseline as for a verdict
 * ------------------------------------------------------------------ */

function harness(): { root: string; scriptsDir: string } {
  const root = scratch('pc-ve1r-');
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

/** A suite's red output: a long middle, the failing test near the end. */
const RED_OUTPUT = `${'ok - a passing test\n'.repeat(400)}not ok 1 - preview store › round-trip\n# AuthenticationError: invalid password\n# fail 1`;

test('VE-1: a red BASELINE line keeps its failing ids and an output tail — on the record and in the ledger', async () => {
  const h = harness();
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
      if (opts.purpose === 'baseline') {
        return {
          ok: false, reason: '`npm test` exited 1', notRun: [],
          ran: [{ command: 'npm test', ok: false, code: 1, ms: 5, output: RED_OUTPUT, failures: ['preview store › round-trip'] }],
        };
      }
      return { ok: true, reason: '1 command green', notRun: [], ran: [{ command: 'npm test', ok: true, code: 0, ms: 5, output: '' }] };
    },
    verificationText: () => '`npm test`',
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  const line = state.phases['1']!.baseline?.commands[0];
  assert.ok(line, 'the baseline was recorded');
  assert.deepEqual(line!.failures, ['preview store › round-trip']);
  assert.match(line!.tail ?? '', /not ok 1 - preview store › round-trip/, 'the output tail is on the record');
  assert.match(line!.tail ?? '', /AuthenticationError/);
  assert.ok((line!.tail ?? '').length <= 2_000, 'a tail, never the whole log');

  const file = verificationsFile(h.root, 'demo');
  assert.ok(existsSync(file));
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row) as Record<string, unknown>);
  const baseline = rows.find((row) => row.kind === 'baseline' && row.command === 'npm test');
  assert.ok(baseline, 'the ledger holds the baseline row');
  assert.match(String(baseline!.tail ?? ''), /AuthenticationError/, 'the ledger keeps what a red said, not only its code');
});

test('VE-1: the session\'s baseline note carries a red line\'s tail, as the verdict\'s red does', () => {
  const note = frameBaselineNote({
    at: '2026-10-03T12:00:00.000Z', tree: 'a'.repeat(40), head: 'b'.repeat(40), concurrent: true,
    commands: [{
      command: 'npm test', ok: false, code: 1, from: 'measured', once: true,
      failures: ['preview store › round-trip'], tail: '# AuthenticationError: invalid password\n# fail 1',
    }],
  }, '[[baseline:abc]]');
  assert.match(note, /preview store › round-trip/);
  assert.match(note, /AuthenticationError: invalid password/, 'the tail reaches the session');
});
