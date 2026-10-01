/**
 * §Verification tells a timeout from a red (control-tower phase 83, #95).
 *
 * Every command used to get one fixed `VERIFY_TIMEOUT_MS` of 30 minutes, and a
 * command that ran past it was killed with exit 124 and recorded as
 * `verify-failed`: a red verdict, a streak charge, a re-opened phase. The
 * measured case was control-tower's `bash tests/run-tests.sh` — 14 min on a
 * quiet machine, 34 min under the load the autopilot itself makes — killed at
 * 2043 s, and green (1030 ok, 850 s) on a re-run of the same head.
 *
 * VT-1  a command its clock cut is retried ONCE, at twice the limit, by the
 *       console — no session — and a second cut is `verify-timeout`, never a red
 * VT-2  a verification whose final word is a timeout parks the phase
 *       `verify-timeout`: not failed, not re-opened, never a streak charge
 * VT-3  the limit is the plan's to set — `- **Verify timeout:**` on the phase,
 *       `**Verify timeout:**` for the plan — read by bash and by its JS twin
 * VT-4  otherwise the limit scales with the line's own measured history
 * (VT-5, the restart drain reading the same limit, is in `restart-drain.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { foldCommand, verificationVerdict, verifyPhase, type VerifyOptions } from '../server/runner/verify.ts';
import { streakPhases, type RunState, type VerifyRun, type VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { VERIFY_TIMEOUT_MS } from '../server/runner/runner-core.ts';
import {
  VERIFY_HISTORY_FACTOR, VERIFY_TIMEOUT_CEILING_MS, appendLedger, readLedger, resolveVerifyLimit, verificationsFile,
  type LedgerRow,
} from '../server/runner/verify-ledger.ts';
import { parsePlan, verifyTimeoutFor } from '../server/parse/plan.ts';
import { readVerifyTimeout } from '../server/engine.ts';

const { SKILL_DIR } = await import('../server/config.ts');

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const MIN = 60_000;
const SUITE = 'bash tests/run-tests.sh';

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ *
 * The harness — one phase, done once its marker exists
 * ------------------------------------------------------------------ */

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void };

/**
 * A scripts directory whose board lists `phases` as ready until each one's
 * `.done-<N>` marker exists; `--verify-timeout` answers `verifyTimeout` (the
 * engine's own `minutes<TAB>source`, or silence).
 */
function harness(phases: number[], opts: { verifyTimeout?: string } = {}): Harness {
  const root = scratch('pc-vt-');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
S="${root}"
case "$2" in
  --memory-block)
    d=""; r=""
    for p in ${phases.join(' ')}; do if [ -f "$S/.done-$p" ]; then d="$d$p,"; else r="$r$p,"; fi; done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "; echo "ready: \${r%,}"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
  --verify-timeout) printf ${JSON.stringify(opts.verifyTimeout ?? '')} ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { root, scriptsDir, done: (phase) => writeFileSync(join(root, `.done-${phase}`), '') };
}

type SpawnReq = { prompt?: string; name?: string };
const phaseOf = (req: SpawnReq): number => Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1] ?? /\bp(\d+)\b/.exec(req.name ?? '')?.[1]);
const success = (sessionId: string) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** What the real verifier writes for a suite its clock cut twice: the cut, then the longer retry cut again. */
function cutTwice(command: string, limitMs: number): VerifySummary {
  const cut = (retry: boolean): VerifyRun => ({
    command, ok: false, code: 124, ms: retry ? 2 * limitMs : limitMs, output: '[timed out or cancelled]',
    timedOut: true, limitMs: retry ? 2 * limitMs : limitMs, ...(retry ? { retry: true } : {}),
  });
  return {
    ok: false, reason: `\`${command}\` timed out`, notRun: [], timedOut: [command], ran: [cut(false), cut(true)],
  };
}

/* ------------------------------------------------------------------ *
 * VT-1 — a cut is retried once, and a second cut is a timeout
 * ------------------------------------------------------------------ */

test('VT-1: a command its clock cuts is retried once, at twice the limit, and a second cut is a timeout — never a red', async () => {
  const dir = scratch('pc-vt-cut-');
  const summary = await verifyPhase('`sleep 5`', { cwd: dir, timeoutFor: () => 400 });
  assert.equal(summary.ran.length, 2, 'the cut, then ONE retry');
  const [first, second] = summary.ran;
  assert.equal(first.timedOut, true, 'the clock cut the first attempt');
  assert.equal(first.limitMs, 400);
  assert.equal(second.retry, true, 'the second row is the retry');
  assert.equal(second.limitMs, 800, 'and it ran at twice the limit');
  assert.equal(second.timedOut, true, 'and was cut again');
  const verdict = verificationVerdict(summary.ran);
  assert.deepEqual(verdict.broke, [], 'a timeout is not a red');
  assert.deepEqual(verdict.timedOut.map((row) => row.command), ['sleep 5']);
  assert.equal(verdict.ok, false, 'nor is it a green');
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.timedOut, ['sleep 5']);
  assert.match(summary.reason, /timed out/);
  assert.doesNotMatch(summary.reason, /exited 124/, 'the reason never calls a cut an exit code');
});

test('VT-1: the longer retry rescues a command that was merely slow', async () => {
  const dir = scratch('pc-vt-slow-');
  // Past the first limit, well inside the second: the shape of a suite that
  // takes 34 minutes under load against a 30-minute clock.
  const summary = await verifyPhase('`sleep 1.5`', { cwd: dir, timeoutFor: () => 1_000 });
  assert.equal(summary.ok, true, `rescued by its retry: ${summary.reason}`);
  assert.equal(summary.ran.length, 2);
  assert.equal(summary.ran[0].timedOut, true);
  assert.equal(summary.ran[1].retry, true);
  assert.equal(summary.ran[1].ok, true);
  assert.equal(summary.timedOut, undefined, 'nothing timed out in the end');
  assert.match(summary.reason, /green on retry \(first timed out after/);
});

test('VT-1: a command that EXITS 124 by itself is a red, retried as any red is — only the clock makes a timeout', async () => {
  const dir = scratch('pc-vt-124-');
  const summary = await verifyPhase('`node -e "process.exit(124)"`', { cwd: dir, timeoutFor: () => 60_000 });
  assert.equal(summary.ran.length, 2, 'a red is retried once');
  assert.ok(summary.ran.every((row) => row.code === 124 && !row.timedOut), 'exit 124 with no cut is not a timeout');
  const verdict = verificationVerdict(summary.ran);
  assert.equal(verdict.broke.length, 1, 'it is a red');
  assert.deepEqual(verdict.timedOut, []);
  assert.equal(summary.timedOut, undefined);
});

test('VT-1: the verdict reads a stored timeout row even with no flag on the retry — the LAST attempt decides', () => {
  const cut: VerifyRun = { command: SUITE, ok: false, code: 124, ms: 5, output: '', timedOut: true };
  const red: VerifyRun = { command: SUITE, ok: false, code: 1, ms: 5, output: '', retry: true };
  const green: VerifyRun = { command: SUITE, ok: true, code: 0, ms: 5, output: '', retry: true };
  assert.deepEqual(verificationVerdict([cut, red]).broke, [red], 'a cut then a red is a red');
  assert.deepEqual(verificationVerdict([cut, red]).timedOut, []);
  assert.deepEqual(verificationVerdict([cut, green]).rescued, [cut], 'a cut then a green is rescued');
  assert.equal(verificationVerdict([cut, green]).ok, true);
  assert.deepEqual(verificationVerdict([cut]).timedOut, [cut], 'an unretried cut (a stored record) is a timeout');
});

/* ------------------------------------------------------------------ *
 * VT-2 — the runner: a timeout parks, and is never charged
 * ------------------------------------------------------------------ */

test('VT-2: a verification that times out twice parks the phase `verify-timeout` — no red, no re-open, no streak charge, no session for the retry', async () => {
  const h = harness([1]);
  let spawns = 0;
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: async (req: SpawnReq) => { spawns += 1; h.done(phaseOf(req)); return success('sid-1'); },
    verify: async () => cutTwice(SUITE, 30 * MIN),
    verificationText: () => `\`${SUITE}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  const record = state.phases['1'];
  assert.equal(spawns, 1, 'the retry was the console\'s own — no session was spawned for it');
  assert.equal(record.status, 'parked', 'the phase waits for a person, it did not fail');
  assert.equal(record.reopened, undefined, 'a timeout is not a red verdict, so nothing is re-opened');
  assert.equal(state.halt?.kind, 'verify-timeout');
  assert.equal(state.status, 'parked');
  assert.match(state.halt?.reason ?? '', /timed out/);
  assert.match(record.note ?? '', /Verify timeout/, 'the errand names the directive that raises the limit');
  assert.equal(state.consecutiveFailures, 0, 'never a streak charge');
  assert.deepEqual(streakPhases(state), []);
  assert.deepEqual(record.verification?.timedOut, [SUITE]);

  const lines = journal(h.root, state);
  const timeout = lines.find((line) => line.event === 'phase.verify-timeout');
  assert.ok(timeout, 'the outcome has its own journal line');
  assert.deepEqual(timeout!.data.commands, [SUITE]);
  assert.equal(lines.some((line) => line.event === 'run.failure-charged'), false);
  assert.equal(lines.some((line) => line.event === 'phase.verification-failed'), false);
  assert.equal(lines.some((line) => line.event === 'run.halted' && /verify-failed/.test(JSON.stringify(line.data))), false);
});

test('VT-2: an OWN red beside a timeout in the same verdict is still a red — the timeout does not launder it', async () => {
  const h = harness([1]);
  const summary: VerifySummary = {
    ok: false, reason: 'mixed', notRun: [], timedOut: [SUITE],
    ran: [
      { command: 'npm test', ok: false, code: 1, ms: 5, output: 'not ok 1 - a real failure' },
      { command: 'npm test', ok: false, code: 1, ms: 5, output: 'not ok 1 - a real failure', retry: true },
      ...cutTwice(SUITE, 30 * MIN).ran,
    ],
  };
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success('sid-1'); },
    verify: async () => summary,
    verificationText: () => `\`npm test\` and \`${SUITE}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.notEqual(state.halt?.kind, 'verify-timeout');
  assert.ok(state.phases['1'].reopened || state.phases['1'].status === 'failed', 'the red keeps its verdict');
  assert.deepEqual(streakPhases(state), [1], 'and its charge');
});

/* ------------------------------------------------------------------ *
 * VT-3 — the plan sets the limit; bash and the JS twin agree
 * ------------------------------------------------------------------ */

test('VT-3: the JS twin reads `Verify timeout` exactly as `--verify-timeout` does — phase bullet over plan line', () => {
  const text = readFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'plans', 'verify-timeout.md'), 'utf8');
  const plan = parsePlan(text, 'verify-timeout', 'docs/plans/verify-timeout.md');
  assert.deepEqual(verifyTimeoutFor(plan, 1), { minutes: 45, source: 'plan' });
  assert.deepEqual(verifyTimeoutFor(plan, 2), { minutes: 90, source: 'phase' });
  assert.deepEqual(verifyTimeoutFor(plan, 3), { minutes: 120, source: 'phase' });
  assert.deepEqual(verifyTimeoutFor(plan, 4), { minutes: 45, source: 'plan' }, 'an unreadable bullet falls through');
  assert.deepEqual(verifyTimeoutFor(plan), { minutes: 45, source: 'plan' }, 'the bare form is the plan line');
  const silent = parsePlan('# x\n\n## Session budget\n\n> **Budget:** ~200K\n', 'x', 'docs/plans/x.md');
  assert.equal(verifyTimeoutFor(silent, 1), undefined);
  // The engine's line, read the way the runner reads it.
  const result = (stdout: string) => ({ code: 0, stdout, stderr: '', ms: 0, timedOut: false });
  assert.deepEqual(readVerifyTimeout(result('90\tphase\n')), { minutes: 90, source: 'phase' });
  assert.equal(readVerifyTimeout(result('')), undefined);
  assert.equal(readVerifyTimeout(result('soon\tphase')), undefined);
});

test('VT-3: the runner gives every command the plan\'s limit and records which level said it', async () => {
  const h = harness([1], { verifyTimeout: '90\tphase' });
  const seen: VerifyOptions[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success('sid-1'); },
    verify: async (_text: string, opts: VerifyOptions) => {
      seen.push(opts);
      return { ok: true, reason: '1 command green', notRun: [], ran: [{ command: SUITE, ok: true, code: 0, ms: 5, output: '' }] };
    },
    verificationText: () => `\`${SUITE}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.equal(state.phases['1'].status, 'done');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeoutFor?.(SUITE), 90 * MIN, 'the phase bullet is the limit');
  assert.deepEqual(state.phases['1'].verifyLimit, { ms: 90 * MIN, source: 'phase', commands: [{ command: SUITE, ms: 90 * MIN, source: 'phase' }] });
});

/* ------------------------------------------------------------------ *
 * VT-4 — otherwise the line's own measured history scales it
 * ------------------------------------------------------------------ */

const row = (command: string, ms: number, fields: Partial<LedgerRow> = {}): LedgerRow => ({
  type: 'verification', slug: 'demo', phase: 1, run: 'r1', at: '2026-09-24T10:00:00.000Z', kind: 'verify',
  command: foldCommand(command), code: 0, ms, ok: true, ...fields,
});

test('VT-4: with no directive the limit is 3x the longest recent run of THAT line, floored at the default and capped', () => {
  assert.equal(VERIFY_HISTORY_FACTOR, 3);
  // The measured week: 850 s, 795 s, 735 s on a quiet-ish machine.
  const rows = [row(SUITE, 850_000), row(SUITE, 795_000), row(SUITE, 735_000), row('npm test', 50 * MIN)];
  assert.deepEqual(resolveVerifyLimit({ command: SUITE, rows }), { ms: 3 * 850_000, source: 'history', samples: 3 });
  // A fast line keeps the default: history never LOWERS the floor.
  assert.deepEqual(resolveVerifyLimit({ command: 'true', rows: [row('true', 200)] }), { ms: VERIFY_TIMEOUT_MS, source: 'default', samples: 1 });
  // Nothing measured: the default.
  assert.deepEqual(resolveVerifyLimit({ command: 'npm run lint', rows }), { ms: VERIFY_TIMEOUT_MS, source: 'default' });
  // Capped: 3 x 100 min is past the ceiling.
  assert.deepEqual(resolveVerifyLimit({ command: 'npm test', rows: [row('npm test', 100 * MIN)] }), { ms: VERIFY_TIMEOUT_CEILING_MS, source: 'history', samples: 1 });
  // A cut is not a measurement — it only says "longer than the limit" — and
  // counting it would ratchet the limit up by the factor on every timeout.
  const cut = row(SUITE, 99 * MIN, { ok: false, code: 124, timedOut: true });
  assert.deepEqual(resolveVerifyLimit({ command: SUITE, rows: [cut] }), { ms: VERIFY_TIMEOUT_MS, source: 'default' });
  // Only the last ten runs of the line count.
  const old = [row(SUITE, 80 * MIN), ...Array.from({ length: 10 }, () => row(SUITE, 12 * MIN))];
  assert.deepEqual(resolveVerifyLimit({ command: SUITE, rows: old }), { ms: 36 * MIN, source: 'history', samples: 10 });
  // The plan's word beats any history.
  assert.deepEqual(resolveVerifyLimit({ command: SUITE, rows, directive: { minutes: 20, source: 'plan' } }), { ms: 20 * MIN, source: 'plan' });
});

test('VT-4: the runner writes each run of a line to the plan\'s ledger, and the next verification of it is limited by that history', async () => {
  const h = harness([1, 2]);
  const seen: VerifyOptions[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success(`sid-${phaseOf(req)}`); },
    verify: async (_text: string, opts: VerifyOptions) => {
      seen.push(opts);
      return { ok: true, reason: '1 command green', notRun: [], ran: [{ command: SUITE, ok: true, code: 0, ms: 20 * MIN, output: '' }] };
    },
    verificationText: () => `\`${SUITE}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.deepEqual([state.phases['1'].status, state.phases['2'].status], ['done', 'done']);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].timeoutFor?.(SUITE), VERIFY_TIMEOUT_MS, 'the first run of the line has no history');
  assert.equal(seen[1].timeoutFor?.(SUITE), 60 * MIN, 'the second is 3x the first run\'s 20 minutes');
  assert.equal(state.phases['2'].verifyLimit?.source, 'history');

  const ledger = readLedger(verificationsFile(h.root, 'demo'), 'demo');
  assert.deepEqual(ledger.map((entry) => [entry.phase, entry.kind, entry.command, entry.ms, entry.code]),
    [[1, 'verify', SUITE, 20 * MIN, 0], [2, 'verify', SUITE, 20 * MIN, 0]]);
  assert.equal(ledger[0].run, state.id);
});

test('VT-4: the ledger is append-only NDJSON that skips what it cannot read and another plan\'s rows', () => {
  const dir = scratch('pc-vt-ledger-');
  const file = join(dir, 'verifications.ndjson');
  appendLedger(file, [row(SUITE, 5)]);
  writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n${JSON.stringify({ ...row(SUITE, 7), slug: 'other' })}\n`);
  appendLedger(file, [row('npm test', 9)]);
  assert.deepEqual(readLedger(file, 'demo').map((entry) => [entry.command, entry.ms]), [[SUITE, 5], ['npm test', 9]]);
  assert.deepEqual(readLedger(join(dir, 'missing.ndjson'), 'demo'), []);
});
