/**
 * The verification, reported WHILE it runs (issue #9, part 3).
 *
 * `onStart` was the only hook, so a command's outcome could only be inferred
 * when the next one started and the last command's outcome never reached the
 * live stream at all. What an operator actually saw was one line —
 * `[1/2] npm --prefix viewer test` — and then silence for forty minutes: no
 * running indicator, no elapsed time, no exit code, no `[2/2]`. Everything
 * needed existed server-side the moment each command returned; it simply
 * reached the client afterwards, in the attempt-comparison view.
 *
 * Three properties, and the third is the one a naive implementation gets wrong:
 * a command rescued on retry must report ONCE, green — the verdict's answer,
 * not the flake's.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { boundedOutput, KEEP_OUTPUT, verifyLogDir, verifyPhase } = await import('../server/runner/verify.ts');
import type { VerifyRun, VerifySkip } from '../server/runner/state.ts';

const cwd = mkdtempSync(join(tmpdir(), 'pc-verify-stream-'));

type Seen = { started: string[]; done: { command: string; ok: boolean; code: number }[] };

function hooks(): Seen & { opts: Record<string, unknown> } {
  const seen: Seen = { started: [], done: [] };
  return {
    ...seen,
    opts: {
      cwd,
      onStart: (command: string) => seen.started.push(command),
      onDone: (result: VerifyRun) =>
        seen.done.push({ command: result.command, ok: result.ok, code: result.code }),
    },
    get started() { return seen.started; },
    get done() { return seen.done; },
  } as Seen & { opts: Record<string, unknown> };
}

test('every command that runs is announced twice — once starting, once settled', async () => {
  const h = hooks();
  const result = await verifyPhase('- `true`\n- `printf ok`', h.opts as never);

  assert.equal(result.ok, true);
  assert.deepEqual(h.started, ['true', 'printf ok']);
  assert.deepEqual(
    h.done.map((d) => [d.command, d.ok]),
    [['true', true], ['printf ok', true]],
    'the LAST command has an outcome on the stream too — the old shape never reported it',
  );
});

test('a red command reports its exit code, and the cascade is not announced as run', async () => {
  const h = hooks();
  // `test -e` on a path that does not exist: exit 1, no side effect, and a lead
  // the extractor accepts (`sh -c "exit 3"` is refused — it recurses into the
  // inner command and `exit` is not a recognised one).
  const result = await verifyPhase('- `test -e /nonexistent-path-xyz`\n- `true`', h.opts as never);

  assert.equal(result.ok, false);
  // Started twice (the one recorded retry), settled ONCE: the stream reports
  // the result the verdict is judged on, not both attempts.
  assert.equal(h.done.length, 1, 'one settled report for one command');
  assert.equal(h.done[0]!.ok, false);
  assert.equal(h.done[0]!.code, 1, 'the exit code, which the live pane never had');
  assert.equal(
    h.started.filter((c) => c === 'true').length,
    0,
    'a command skipped by the cascade never started, so it is never announced',
  );
});

test('a command rescued on retry is announced once, green', async () => {
  // Red on the first attempt, green on the second: a real flake's shape.
  const script = join(cwd, 'flake.sh');
  const stamp = join(cwd, 'flake.stamp');
  writeFileSync(script, `#!/usr/bin/env bash\nif [ -e "${stamp}" ]; then exit 0; fi\n: > "${stamp}"\nexit 1\n`);
  const h = hooks();
  const result = await verifyPhase(`- \`bash ${script}\``, h.opts as never);

  assert.equal(result.ok, true, 'the retry rescued it');
  assert.equal(h.done.length, 1, 'one command, one settled report');
  assert.equal(h.done[0]!.ok, true, 'the verdict is the second attempt’s, and so is the stream');
  assert.equal(result.ran.length, 2, 'both attempts stay on the RECORD, as they always did');
});

test('the skips are announced before anything runs — not discovered as a park', async () => {
  const skips: VerifySkip[][] = [];
  const started: string[] = [];
  const result = await verifyPhase('- `rg --version`\n- `true`', {
    cwd,
    // The measured shape of F17: `rg` is a shell function on the operator's
    // machine and no binary at all on the verification PATH.
    canExecute: (lead: string) => lead !== 'rg',
    onSkip: (skipped: readonly VerifySkip[]) => skips.push([...skipped]),
    onStart: (command: string) => started.push(command),
  } as never);

  assert.equal(skips.length, 1, 'announced once, as a set');
  assert.equal(skips[0]![0]!.lead, 'rg');
  assert.deepEqual(started, ['true'], 'the runnable one still runs — a skip is not a failure');
  assert.equal(result.ok, true);
});

test('a verification with nothing runnable still announces its skips', async () => {
  const skips: VerifySkip[][] = [];
  const result = await verifyPhase('- `rg --version`', {
    cwd,
    canExecute: (lead: string) => lead !== 'rg',
    onSkip: (skipped: readonly VerifySkip[]) => skips.push([...skipped]),
  } as never);

  // This is the case that PARKS the phase. It used to unfold entirely off
  // screen and the operator met it only as a parked phase with a note.
  assert.equal(skips.length, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrunnable here/);
});

test('the hooks are optional — a caller that passes none still verifies', async () => {
  const result = await verifyPhase('- `true`', { cwd } as never);
  assert.equal(result.ok, true);
});

/*
 * The bound (measured-console phase 6, the audit's A4): what a session is
 * shown of a red line is its last `KEEP_OUTPUT` characters — 8,000 — with the
 * path of the log that holds the whole of it, and the ids are still read off
 * the whole stream.
 */
test('a red line\'s output is tailed to 8,000 characters and names the log that holds all of it', async () => {
  const script = join(cwd, 'loud-red.sh');
  // The failing id first, then 30,000 characters after it: no tail of 8,000
  // reaches back to it, and the record must still name it.
  writeFileSync(script, '#!/usr/bin/env bash\necho "not ok 1 - the early one"\n'
    + 'for i in $(seq 1 600); do printf "%049d\\n" "$i"; done\nexit 1\n');
  const result = await verifyPhase(`- \`bash ${script}\``, { cwd } as never);

  assert.equal(result.ok, false);
  const run = result.ran.at(-1)!;
  assert.equal(KEEP_OUTPUT, 8_000);
  assert.ok(run.output.length <= KEEP_OUTPUT, `the tail is bounded — ${run.output.length} characters`);
  assert.ok(run.output.length > KEEP_OUTPUT - 400, 'and is a real tail, not a stub');
  const note = /\[the whole output \((\d+) characters\): (\S+\.log)\]$/.exec(run.output);
  assert.ok(note, `the last line names the log: …${run.output.slice(-200)}`);
  const logPath = note![2]!;
  assert.ok(logPath.startsWith(verifyLogDir()), 'under the machine\'s temporary directory, never the repository');
  assert.ok(existsSync(logPath), 'the log a red line names is there to read');
  const whole = readFileSync(logPath, 'utf8');
  assert.equal(whole.length, Number(note![1]), 'the note counts the whole output');
  assert.ok(whole.length > 30_000);
  assert.match(whole, /^not ok 1 - the early one$/m, 'the log holds what the tail lost');
  assert.doesNotMatch(run.output, /the early one/, 'the tail alone could not have named it');
  assert.deepEqual(run.failures, ['the early one'], 'the ids are read off the whole stream, not the tail');
  for (const r of result.ran) {
    const path = /: (\S+\.log)\]$/.exec(r.output)?.[1];
    if (path) rmSync(path, { force: true });
  }
});

test('a green line keeps no log, a silent red names none, and a red that fits is whole with its log named', async () => {
  const marker = `green-marker-${process.pid}-${Date.now()}`;
  const green = await verifyPhase(`- \`printf ${marker}\``, { cwd } as never);
  assert.equal(green.ok, true);
  assert.equal(green.ran[0]!.output, marker, 'a green line is untouched');
  const left = existsSync(verifyLogDir())
    ? readdirSync(verifyLogDir()).filter((name) => {
      try { return readFileSync(join(verifyLogDir(), name), 'utf8').includes(marker); } catch { return false; }
    })
    : [];
  assert.deepEqual(left, [], 'a green line\'s log is deleted');

  const quiet = await verifyPhase('- `test -e /nonexistent-path-xyz`', { cwd } as never);
  assert.equal(quiet.ok, false);
  assert.equal(quiet.ran.at(-1)!.output, '', 'a red line that printed nothing names no log');

  const script = join(cwd, 'small-red.sh');
  writeFileSync(script, '#!/usr/bin/env bash\necho "not ok 1 - small"\nexit 1\n');
  const small = await verifyPhase(`- \`bash ${script}\``, { cwd } as never);
  const output = small.ran.at(-1)!.output;
  assert.match(output, /^not ok 1 - small\n\[the whole output \(17 characters\): \S+\.log\]$/, output);
  for (const r of small.ran) rmSync(/: (\S+\.log)\]$/.exec(r.output)![1]!, { force: true });
});

test('boundedOutput holds the bound whatever the path\'s length', () => {
  const long = `/tmp/${'d'.repeat(9_000)}/x.log`;
  assert.ok(boundedOutput('x'.repeat(20_000), long, 20_000).length <= KEEP_OUTPUT);
  assert.equal(boundedOutput('short', null), 'short');
  assert.equal(boundedOutput('y'.repeat(9_000), null).length, KEEP_OUTPUT);
  assert.match(boundedOutput('short', '/tmp/a.log', 5), /^short\n\[the whole output \(5 characters\): \/tmp\/a\.log\]$/);
});

process.on('exit', () => rmSync(cwd, { recursive: true, force: true }));
