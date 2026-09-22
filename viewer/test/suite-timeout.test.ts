/**
 * The server suite ends a hung test instead of waiting for it for ever
 * (autopilot-token-drain phase 7, deferral `c944c97a5893`).
 *
 * `node --test` has no per-test timeout by default. Phase 6 changed a runner
 * behaviour that stranded one test's `await`, and `npm --prefix viewer test`
 * sat silent for 88 minutes — no failure, no name, nothing to read. A timeout
 * alone is not the answer either, which was measured here (Node 24.13.1): with
 * `--test-timeout` the hung test is failed on time, but a live handle (a timer,
 * a server, a child) keeps that file's process alive, so the run still never
 * ends. `--test-force-exit` is the other half: the file exits once its known
 * tests are done. The suite and every `node --test` the release gate runs carry
 * both.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const TIMEOUT_FLAG = /--test-timeout=(\d+)/;

/** The suite's own `test` script — the command `npm --prefix viewer test` runs. */
const suiteScript = (): string =>
  String(JSON.parse(readFileSync(join(SKILL_DIR, 'viewer', 'package.json'), 'utf8')).scripts.test);

test('the suite script bounds every test and exits once its tests are done', () => {
  const script = suiteScript();
  const timeout = TIMEOUT_FLAG.exec(script);
  assert.ok(timeout, `\`${script}\` sets no --test-timeout, so a hung test hangs the whole run`);
  assert.ok(Number(timeout[1]) > 0, 'a zero timeout is no bound at all');
  assert.match(script, /--test-force-exit/, 'without --test-force-exit a live handle keeps a timed-out file running');
});

test('with those two flags a test that never settles ends the run, and is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-suite-timeout-'));
  TRASH.push(dir);
  // The shape that cost 88 minutes: an await nothing will ever resolve, beside a
  // handle that keeps the event loop alive once the test has been given up on.
  writeFileSync(join(dir, 'hangs.test.mjs'), [
    "import { test } from 'node:test';",
    // The fixture's own end, past the 60 s this test kills the run at — so a
    // regression still reads as a hang — but not never: in a race the child
    // outlived the runner that timed it out and spun for 18 hours (2026-09-18).
    'setTimeout(() => process.exit(3), 90_000).unref();',
    "test('never settles', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });",
    "test('runs after it', () => {});",
    '',
  ].join('\n'));
  // The suite's own flags, with its timeout shortened so this test is quick —
  // what is under test is that the PAIR ends the run, not how long the bound is.
  const flags = suiteScript().split(/\s+/)
    .filter((word) => word.startsWith('--test-') && !word.startsWith('--test-concurrency'))
    .map((word) => (TIMEOUT_FLAG.test(word) ? '--test-timeout=1500' : word));
  // A `node --test` started inside a test inherits NODE_TEST_CONTEXT and reports
  // to a parent that is not listening — it exits 0 at once, having run nothing.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  // SIGKILL, because the test runner turns a SIGTERM into an orderly exit 1 and
  // a run that had to be killed would read as one that failed on time.
  const run = spawnSync(process.execPath, ['--test', ...flags, 'hangs.test.mjs'], {
    cwd: dir, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env,
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.signal, null, `the run never ended by itself — killed after ${Date.now() - started} ms:\n${output}`);
  assert.equal(run.status, 1, 'a timed-out test fails the run');
  assert.match(output, /never settles/);
  assert.match(output, /timed out after 1500ms/);
});

test('every node --test the release gate runs carries the same bound as the suite', () => {
  const gates = readFileSync(join(SKILL_DIR, 'scripts', 'gates.sh'), 'utf8');
  const bound = /^NODE_TEST_BOUND=\((.*)\)$/m.exec(gates);
  assert.ok(bound, 'scripts/gates.sh defines NODE_TEST_BOUND');
  const words = bound[1].trim().split(/\s+/);
  assert.equal(TIMEOUT_FLAG.exec(words.join(' '))?.[1], TIMEOUT_FLAG.exec(suiteScript())?.[1],
    'the gate and `npm test` give a test the same time');
  assert.ok(words.includes('--test-force-exit'));
  const runs = gates.split('\n').filter((line) => /\bnode --test\b/.test(line) && !/^\s*#/.test(line));
  assert.ok(runs.length >= 3, 'the gate runs the parity file, the serial suite and the retried files');
  for (const line of runs) {
    assert.match(line, /node --test "\$\{NODE_TEST_BOUND\[@\]\}"/, `unbounded: ${line.trim()}`);
  }
});
