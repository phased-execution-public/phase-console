/**
 * The one seam every child process the console runs goes through.
 *
 * Before this there were nine git helpers in six files, each with its own error
 * semantics and its own inline env literal, and not one of them wrote down what
 * it ran. "Which git command did the console run, in which tree, and what did
 * it say" was unanswerable from any record the console kept — so a merge that
 * went wrong could be reconstructed only by re-running it by hand and hoping
 * the tree was still in the same state.
 *
 * Three properties matter enough to pin.
 *
 * **It never throws.** Every caller of the old helpers treated a spawn failure
 * as a value (`''`, `null`, `{ok:false}`); a seam that threw would turn a
 * missing binary into a crashed drive.
 *
 * **Capture is bounded at both ends.** A `git log` of a large repository is
 * megabytes, and a log line that carried it would be the thing that filled the
 * disk. The head says what the command started to say and the tail says how it
 * ended — a head-only truncation loses the error message, which is always last.
 *
 * **A failure nobody expected is louder than one somebody did.** Plenty of git
 * commands are asked speculatively (`rev-parse` on a ref that may not exist)
 * and their non-zero exit is the answer, not a fault. Those declare
 * `expectFailure`; everything else gets a line at the default level, because a
 * git command failing unexpectedly is the single most useful thing this log can
 * tell anyone.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { type Entry, configureLog, revertLevel } from '../server/log.ts';
import { shell, shellNote } from '../server/shell.ts';
import { enter, runTraceId } from '../server/trace.ts';

const dir = mkdtempSync(join(tmpdir(), 'phase-console-shell-seam-'));
let logFile = '';

/** Point the log at a fresh file with the named debug channels admitted. */
function capture(channels = '*'): () => Entry[] {
  revertLevel();
  process.env.PHASE_CONSOLE_DEBUG = channels;
  logFile = join(dir, `log-${Math.random().toString(36).slice(2)}.ndjson`);
  configureLog(logFile);
  return () => {
    let raw: string;
    try { raw = readFileSync(logFile, 'utf8'); } catch { return []; }
    return raw.trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);
  };
}

test.after(() => {
  delete process.env.PHASE_CONSOLE_DEBUG;
  revertLevel();
  configureLog(null);
  rmSync(dir, { recursive: true, force: true });
});

test('a command that succeeds returns its output and how long it took', async () => {
  capture();
  const run = await shell('node', ['-e', 'process.stdout.write("hello")'], { channel: 'shell', intent: 'probe' });

  assert.equal(run.ok, true);
  assert.equal(run.code, 0);
  assert.equal(run.stdout, 'hello');
  assert.equal(run.stderr, '');
  assert.equal(run.signal, null);
  assert.equal(run.timedOut, false);
  assert.equal(run.truncatedBytes, 0);
  assert.ok(run.ms >= 0 && Number.isFinite(run.ms));
});

test('a non-zero exit is a VALUE, with both streams kept', async () => {
  capture();
  const run = await shell(
    'node',
    ['-e', 'process.stderr.write("nope"); process.exit(3)'],
    { channel: 'shell', intent: 'probe' },
  );

  assert.equal(run.ok, false);
  assert.equal(run.code, 3);
  assert.equal(run.stderr, 'nope');
  assert.equal(run.error, undefined, 'a clean non-zero exit is not an error');
});

test('a binary that does not exist is a value too — the seam never throws', async () => {
  capture();
  const run = await shell('phase-console-no-such-binary', ['--version'], { channel: 'shell', intent: 'probe' });

  assert.equal(run.ok, false);
  assert.equal(run.code, null, 'a process that never started has no exit code');
  assert.ok(run.error, 'but it does have an error, so a caller can tell the two apart');
});

test('capture is bounded, and keeps BOTH ends — the error message is always last', async () => {
  capture();
  const script = 'const line = "x".repeat(99) + "\\n"; process.stdout.write("HEAD\\n"); for (let i=0;i<4000;i++) process.stdout.write(line); process.stdout.write("TAIL-ERROR\\n");';
  const run = await shell('node', ['-e', script], { channel: 'shell', intent: 'probe', capture: { keep: 2048 } });

  assert.equal(run.ok, true);
  assert.ok(run.truncatedBytes > 300_000, `expected most of it elided, got ${run.truncatedBytes}`);
  assert.ok(run.stdout.length < 8192, `kept ${run.stdout.length} bytes for a 2048-byte budget`);
  assert.match(run.stdout, /^HEAD\n/, 'the head says what it started to say');
  assert.match(run.stdout, /TAIL-ERROR\n$/, 'the tail says how it ended');
  assert.match(run.stdout, /elided/, 'and the gap says so rather than pretending to be the whole output');
});

test('a command that overruns its timeout is killed and says so', async () => {
  capture();
  const run = await shell('node', ['-e', 'setTimeout(() => {}, 60000)'], {
    channel: 'shell',
    intent: 'probe',
    timeout: 250,
  });

  assert.equal(run.ok, false);
  assert.equal(run.timedOut, true);
  assert.ok(run.ms >= 200, `should have waited for the timeout, waited ${run.ms}ms`);
});

test('every run writes one line on its channel, with argv, cwd, ms and code', async () => {
  const read = capture('git');
  await shell('git', ['--version'], { channel: 'git', cwd: dir, intent: 'version' });

  const lines = read().filter((e) => e.event === 'git.command');
  assert.equal(lines.length, 1, 'one line per command — not one per stream, not one per retry');

  const [line] = lines;
  assert.equal(line.level, 'debug');
  assert.deepEqual(line.data?.argv, ['git', '--version']);
  assert.equal(line.data?.cwd, dir);
  assert.equal(line.data?.code, 0);
  assert.equal(line.data?.intent, 'version');
  assert.equal(typeof line.data?.ms, 'number');
});

test('the channel decides the event name, so one debug switch admits one family', async () => {
  const read = capture('engine');
  await shell('node', ['-e', ''], { channel: 'engine', intent: 'script' });
  await shell('node', ['-e', ''], { channel: 'git', intent: 'probe' });

  assert.deepEqual(read().map((e) => e.event), ['engine.command']);
});

test('an UNEXPECTED failure is written at the default level; an expected one is not', async () => {
  const loud = capture('');
  await shell('node', ['-e', 'process.exit(2)'], { channel: 'git', intent: 'rev-parse' });
  const surfaced = loud().filter((e) => e.event === 'git.command');
  assert.equal(surfaced.length, 1, 'with no debug channel on, a failing command still surfaces');
  assert.equal(surfaced[0].level, 'info');
  assert.equal(surfaced[0].data?.code, 2);

  const quiet = capture('');
  await shell('node', ['-e', 'process.exit(2)'], { channel: 'git', intent: 'rev-parse', expectFailure: true });
  assert.deepEqual(quiet().filter((e) => e.event === 'git.command'), [],
    'a failure the caller declared ordinary stays at debug');
});

test('the output tail rides the line, bounded well below the log line budget', async () => {
  const read = capture('git');
  await shell('node', ['-e', 'process.stderr.write("y".repeat(20000)); process.exit(1)'], {
    channel: 'git',
    intent: 'probe',
  });

  const [line] = read().filter((e) => e.event === 'git.command');
  const tail = String(line.data?.tail ?? '');
  assert.ok(tail.length > 0, 'a failing command must say what it said');
  assert.ok(tail.length <= 2048, `the log line's tail is bounded, got ${tail.length}`);
});

test('the child joins the caller\'s trace, and the line is stamped with it', async () => {
  const read = capture('shell');
  const traceId = runTraceId('inst', 'slug', 'run-shell');

  const run = await enter({ traceId, name: 'phase.verify' }, () =>
    shell('node', ['-e', 'process.stdout.write(String(process.env.PE_TRACE_ID))'], {
      channel: 'shell',
      intent: 'probe',
    }),
  );

  assert.equal(run.stdout, traceId, 'the child can read the trace it belongs to');
  const [line] = read().filter((e) => e.event === 'shell.command');
  assert.equal(line.traceId, traceId, 'and the line recording it carries the same id');
});

test('a caller may pass env, and the carrier still reaches the child', async () => {
  capture();
  const traceId = runTraceId('inst', 'slug', 'run-env');
  const run = await enter({ traceId, name: 'x' }, () =>
    shell('node', ['-e', 'process.stdout.write(`${process.env.MINE}:${process.env.PE_TRACE_ID}`)'], {
      channel: 'shell',
      intent: 'probe',
      env: { ...process.env, MINE: 'yes' },
    }),
  );

  assert.equal(run.stdout, `yes:${traceId}`);
});

test('a parser asks for head-only truncation, because an elision marker mid-stream is a lie', async () => {
  capture();
  const script = 'process.stdout.write("A".repeat(3000)); process.stdout.write("Z".repeat(3000));';
  const run = await shell('node', ['-e', script], {
    channel: 'git',
    intent: 'diff',
    capture: { keep: 1000, mode: 'head' },
  });

  assert.equal(run.stdout, 'A'.repeat(1000), 'exactly the prefix — what the old maxBuffer delivered');
  assert.equal(run.truncatedBytes, 5000);
  assert.doesNotMatch(run.stdout, /elided/, 'nothing is injected into text something is going to parse');
});

test('the adapters are real: gitPorcelain over a repository writes one git.command line', async () => {
  const read = capture('git');
  const repo = mkdtempSync(join(dir, 'repo-'));

  await shell('git', ['init', '--quiet'], { channel: 'git', intent: 'fixture', cwd: repo });
  const before = read().filter((e) => e.event === 'git.command').length;

  const { gitPorcelain } = await import('../server/service-core.ts');
  const porcelain = await gitPorcelain(repo);

  assert.equal(porcelain, '', 'a fresh repository is clean');
  const lines = read().filter((e) => e.event === 'git.command');
  assert.equal(lines.length, before + 1, 'the helper went through the seam, not around it');
  assert.deepEqual(lines.at(-1)?.data?.argv, ['git', 'status', '--porcelain']);
  assert.equal(lines.at(-1)?.data?.cwd, repo);
});

test('shellNote records a command the seam did not run itself', () => {
  const read = capture('shell');

  shellNote({ channel: 'shell', intent: 'verify', argv: ['bash', '-c', 'npm test'], cwd: dir, ms: 1234, code: 0 });

  const [line] = read().filter((e) => e.event === 'shell.command');
  assert.deepEqual(line.data?.argv, ['bash', '-c', 'npm test']);
  assert.equal(line.data?.ms, 1234);
  assert.equal(line.data?.code, 0);
  assert.equal(line.data?.streamed, true, 'and says it was streamed, so nobody looks for a tail that cannot exist');
});
