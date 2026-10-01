/**
 * A failure is a failed phase (control-tower phase 45, #45, #59).
 *
 * The failure streak is the run's single "this plan is broken, stop" bound,
 * and `failure-streak` is a halt only a person's press relaunches. Over one
 * measured week it counted ENDINGS, not failed phases:
 *
 *   - all 6 verify-failed halts were commands rescued on their retry — the
 *     verdict said `ok: true` and the runner halted on the rescued first row
 *     in the same second (#45);
 *   - 3 of the 6 streak halts counted one phase twice, or a wait the budget
 *     refused — "2 phases failed in a row" over ONE phase (#59);
 *   - a refused wait consumed the declaration with its refs, so nothing
 *     watched the build it was waiting on, which finished minutes later.
 *
 * FS-1..2   one verdict: a rescued command is green, and `ok` and the halt agree
 * FS-3..6   the streak is the ordered set of DISTINCT phases with a merit failure
 * FS-7..8   a spent wait budget is a budget: a park on the refs, never a failure
 * FS-9      a resumed session's working time is not charged to the wait budget
 * (FS-10, Recover over a superseded halt, is in `recovery-plan.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { verificationVerdict, verifyPhase } from '../server/runner/verify.ts';
import {
  newRun, phaseRecord, pruneStreak, reconcileRecordsAgainstBoard, resetStreak, streakPhases, streakSentence,
  type PhaseRecord, type RunState, type VerifyRun, type VerifySummary,
} from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import {
  evaluateWait, openWaitEntry, parkedMsOf, DEFAULT_WAIT_BUDGET_MS, type WaitBudget,
} from '../server/runner/wait-budget.ts';
import { WatchScheduler } from '../server/watch-scheduler.ts';
import { FAILURE_CAUSES, MERIT_FAILURE_CAUSES } from '../shared/run-lifecycle.js';

/* ------------------------------------------------------------------ *
 * The harness — independent phases, each done once its marker exists
 * ------------------------------------------------------------------ */

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void; undo: (phase: number) => void; cleanup: () => void };

/**
 * A scripts directory whose board lists every phase in `phases` as ready
 * until its `.done-<N>` marker exists. The phases depend on nothing, so a
 * `keep-going` run moves from one to the next; `--wait-budget` answers
 * `budgetLine` for every phase (the engine's own `minutes<TAB>source`).
 */
function harness(phases: number[], opts: { budgetLine?: string; wakeRefs?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-streak-'));
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
  --wait-budget) printf ${JSON.stringify(opts.budgetLine ?? '')} ;;
  --waits-on) printf '%s' ${JSON.stringify(opts.wakeRefs ?? '')} ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return {
    root, scriptsDir,
    done: (phase) => writeFileSync(join(root, `.done-${phase}`), ''),
    undo: (phase) => rmSync(join(root, `.done-${phase}`), { force: true }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type SpawnReq = { prompt?: string; name?: string; resume?: string; env?: Record<string, string> };

/** The phase a spawn is for — the boot prompt names it, a resume's session name does. */
function phaseOf(req: SpawnReq): number {
  return Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1] ?? /\bp(\d+)\b/.exec(req.name ?? '')?.[1]);
}

const success = (sessionId: string) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const red = (command: string, code = 1): VerifyRun => ({ command, ok: false, code, ms: 5, output: 'failing' });
const green = (command: string): VerifyRun => ({ command, ok: true, code: 0, ms: 5, output: 'ok' });
const retried = (run: VerifyRun): VerifyRun => ({ ...run, retry: true });

/* ------------------------------------------------------------------ *
 * FS-1..2 — one verdict
 * ------------------------------------------------------------------ */

test('FS-1: the #45 journal replayed — a command green on its retry settles the phase done and the streak does not move', async () => {
  // The rows the REAL verifier writes for a flake: red, then a green retry of
  // the same command, and `ok: true` — measured on four phases, each of which
  // then halted `verify-failed` "1 of N command(s) failed" in the same second.
  const scratch = mkdtempSync(join(tmpdir(), 'pc-streak-flake-'));
  const h = harness([1]);
  try {
    const flake = 'node -e "const fs=require(\'fs\'); if (fs.existsSync(\'m\')) process.exit(0); fs.writeFileSync(\'m\', \'\'); process.exit(1);"';
    const rescued = await verifyPhase('`true` and `' + flake + '`', { cwd: scratch });
    assert.equal(rescued.ok, true, 'the verifier calls it green');
    assert.equal(rescued.ran.length, 3, 'one green command, then the flake twice');
    assert.match(rescued.reason, /green on retry \(first exited 1\)/);

    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success('sid-1'); },
      verify: async () => rescued,
      verificationText: () => 'the plan\'s commands',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(state.phases['1'].status, 'done', 'the phase settles done');
    assert.equal(state.phases['1'].halt, undefined, 'and is never halted');
    assert.equal(state.consecutiveFailures, 0, 'the streak does not move');
    assert.deepEqual(streakPhases(state), []);
    const lines = journal(h.root, state);
    assert.equal(lines.filter((l) => l.event === 'phase.halted').length, 0, 'no verify-failed halt');
    assert.equal(lines.filter((l) => l.event === 'run.failure-charged').length, 0, 'nothing charged');
    const verify = lines.find((l) => l.event === 'phase.verify')!;
    assert.equal(verify.data.ok, true);
    const rows = verify.data.ran as { command: string; code: number; retry?: boolean }[];
    assert.deepEqual(rows.map((r) => [r.code, r.retry ?? false]), [[0, false], [1, false], [0, true]],
      'the journal tells the rescued command\'s two attempts from two commands');
    assert.ok(lines.some((l) => l.event === 'phase.done'), 'phase.done, where the halt used to be');
  } finally {
    h.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('FS-2: the verdict — a command\'s LAST attempt decides, and the verifier and the runner read the same function', async () => {
  // Table: rows as the verifier writes them → the verdict.
  const cases: { rows: VerifyRun[]; ok: boolean; broke: number; rescued: number; what: string }[] = [
    { rows: [green('a'), green('b')], ok: true, broke: 0, rescued: 0, what: 'all green' },
    { rows: [red('a'), retried(green('a'))], ok: true, broke: 0, rescued: 1, what: 'rescued' },
    { rows: [green('a'), red('b'), retried(green('b')), green('c')], ok: true, broke: 0, rescued: 1, what: 'rescued mid-list' },
    { rows: [red('a'), retried(red('a'))], ok: false, broke: 1, rescued: 0, what: 'red twice — the retry is the verdict' },
    { rows: [red('a', 124)], ok: false, broke: 1, rescued: 0, what: 'a timeout is never retried' },
    { rows: [red('a', 127)], ok: false, broke: 1, rescued: 0, what: 'a missing binary is never retried' },
    { rows: [red('a'), retried(green('a')), red('b'), retried(red('b'))], ok: false, broke: 1, rescued: 1, what: 'one rescued, one red' },
    // A retry row that names ANOTHER command does not rescue this one.
    { rows: [red('a'), retried(green('b'))], ok: false, broke: 1, rescued: 0, what: 'a retry of a different command' },
    { rows: [], ok: true, broke: 0, rescued: 0, what: 'nothing ran (a waived verification)' },
  ];
  for (const c of cases) {
    const verdict = verificationVerdict(c.rows);
    assert.equal(verdict.ok, c.ok, c.what);
    assert.equal(verdict.broke.length, c.broke, `${c.what}: broke`);
    assert.equal(verdict.rescued.length, c.rescued, `${c.what}: rescued`);
    // The halt's list is the rows that ARE a verdict — never a rescued row.
    for (const row of verdict.broke) assert.equal(row.ok, false);
  }

  // …and the real verifier's `ok` IS that verdict, on every shape it can write.
  const scratch = mkdtempSync(join(tmpdir(), 'pc-streak-verdict-'));
  try {
    const flake = 'node -e "const fs=require(\'fs\'); if (fs.existsSync(\'n\')) process.exit(0); fs.writeFileSync(\'n\', \'\'); process.exit(1);"';
    for (const text of ['`true`', '`' + flake + '`', '`false`', '`true` and `false` and `echo never`']) {
      const summary = await verifyPhase(text, { cwd: scratch });
      assert.equal(summary.ok, verificationVerdict(summary.ran).ok, `${text}: the summary and the verdict agree`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('FS-2: `ok` and the halt can never disagree — a red verdict over a board that does not vouch halts, a green one never does', async () => {
  const shapes: { summary: VerifySummary; what: string }[] = [
    { what: 'rescued', summary: { ok: true, reason: '1 command green; `npm test` green on retry (first exited 1)', ran: [red('npm test'), retried(green('npm test'))], notRun: [] } },
    { what: 'red twice', summary: { ok: false, reason: '`npm test` exited 1', ran: [red('npm test'), retried(red('npm test'))], notRun: [] } },
  ];
  for (const { summary, what } of shapes) {
    const h = harness([1]);
    try {
      const runner = new Runner({
        scriptsDir: h.scriptsDir,
        spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success('sid-1'); },
        // The board stops vouching the moment verification returns, so a red
        // verdict has nothing to be overtaken by: only the verdict decides.
        verify: async () => { h.undo(1); return summary; },
        verificationText: () => 'the plan\'s commands',
      } as never);
      const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
      await runner.wait();
      const halted = state.phases['1'].halt?.kind === 'verify-failed';
      assert.equal(halted, !summary.ok, `${what}: halted exactly when the verdict is red`);
      assert.equal(state.phases['1'].status, summary.ok ? 'done' : 'failed', what);
      assert.equal(state.consecutiveFailures, summary.ok ? 0 : 1, `${what}: the streak counts only the red one`);
    } finally { h.cleanup(); }
  }
});

/* ------------------------------------------------------------------ *
 * FS-3..6 — the streak is the ordered set of distinct merit failures
 * ------------------------------------------------------------------ */

/** A runner holding a run it is not driving — `chargeFailure` asked directly. */
function charger(max = 3) {
  const h = harness([1]);
  const runner = new Runner({ scriptsDir: h.scriptsDir, spawn: async () => success('x') } as never);
  const state = newRun({ slug: 'demo', root: h.root });
  state.maxConsecutiveFailures = max;
  (runner as unknown as { state: RunState }).state = state;
  const charge = (phase: number, cause: string) =>
    (runner as unknown as { chargeFailure: (p: number, c: string, r?: string) => number }).chargeFailure(phase, cause, 'test');
  return { state, charge, cleanup: h.cleanup };
}

test('FS-3: a second ending of a phase already in the streak charges nothing — one phase is one failure', () => {
  const { state, charge, cleanup } = charger();
  try {
    assert.equal(charge(19, 'declared-blocked'), 1);
    // The mql P19/P20 shape: the same phase ending again read "2 phases failed in a row".
    assert.equal(charge(19, 'declared-blocked'), 1, 'the same phase blocked again');
    assert.equal(charge(19, 'no-handoff'), 1, 'or ending another way');
    assert.deepEqual(streakPhases(state), [19]);
    assert.equal(charge(20, 'verify-red'), 2, 'a DISTINCT phase counts');
    assert.deepEqual(state.failureStreak, [19, 20], 'in completion order');
    assert.equal(state.consecutiveFailures, 2, 'and the wire number is the set\'s size');
  } finally { cleanup(); }
});

test('FS-4: only a MERIT failure counts — work left on disk and the weather say nothing about the plan', () => {
  const { state, charge, cleanup } = charger(10);
  try {
    assert.equal(charge(4, 'no-handoff-worked'), 0, 'a session that committed and wrote no handoff');
    assert.equal(charge(5, 'connectivity'), 0, 'the network, however long');
    // A declared block the watch clock can end is a wait (control-tower phase
    // 87, #122): the runner parks it, and one that reaches the charge anyway
    // is held — it says nothing about the plan either.
    assert.equal(charge(6, 'declared-wait'), 0, 'a block naming a pollable ref');
    assert.deepEqual(streakPhases(state), []);
    let n = 0;
    for (const cause of MERIT_FAILURE_CAUSES) assert.equal(charge(100 + n, cause), ++n, `${cause} is a merit failure`);
    // The partition is the vocabulary's, not this test's.
    assert.deepEqual(
      FAILURE_CAUSES.filter((c) => !(MERIT_FAILURE_CAUSES as readonly string[]).includes(c)).sort(),
      ['connectivity', 'declared-wait', 'no-handoff-worked'],
    );
  } finally { cleanup(); }
});

test('FS-5: the halt names the phases it counts — two distinct red phases halt the run, in order', async () => {
  const h = harness([1, 2]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success(`sid-${phaseOf(req)}`); },
      // Each verification is red over a board that has stopped vouching.
      verify: async () => {
        h.undo(1); h.undo(2);
        return { ok: false, reason: '`npm test` exited 1', ran: [red('npm test'), retried(red('npm test'))], notRun: [] } satisfies VerifySummary;
      },
      verificationText: () => 'the plan\'s commands',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 2 } as never);
    await runner.wait();
    assert.equal(state.status, 'halted');
    assert.equal(state.halt?.kind, 'failure-streak');
    assert.equal(state.halt?.reason, '2 phases failed in a row: phase 1, then phase 2');
    assert.deepEqual(state.failureStreak, [1, 2]);
    assert.equal(state.consecutiveFailures, 2);
    const charged = journal(h.root, state).filter((l) => l.event === 'run.failure-charged');
    assert.deepEqual(charged.map((l) => [l.phase, l.data.cause]), [[1, 'verify-red'], [2, 'verify-red']]);
  } finally { h.cleanup(); }
});

test('FS-5: the sentence and the set — a count the set cannot name is said, never invented', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever' });
  state.consecutiveFailures = 3;
  state.failureStreak = [2, 7, 9];
  assert.equal(streakSentence(state), '3 phases failed in a row: phase 2, phase 7, then phase 9');
  state.consecutiveFailures = 1;
  state.failureStreak = [4];
  assert.equal(streakSentence(state), '1 phase failed in a row: phase 4');
  // A run written before the set: the number alone.
  delete state.failureStreak;
  state.consecutiveFailures = 2;
  assert.equal(streakSentence(state), '2 phases failed in a row');
  assert.deepEqual(streakPhases(state), []);
  // A zeroed count zeroes the set, whatever is stored.
  state.consecutiveFailures = 0;
  state.failureStreak = [5];
  assert.deepEqual(streakPhases(state), []);
  state.consecutiveFailures = 2;
  state.failureStreak = [5, 6];
  assert.equal(resetStreak(state), 2);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.failureStreak, undefined);
});

test('FS-5: a legacy count is carried ahead of the set it starts, never dropped', () => {
  const { state, charge, cleanup } = charger(5);
  try {
    state.consecutiveFailures = 1; // written by a console before the set existed
    assert.equal(charge(8, 'crash'), 2, 'the unnamed failure still counts');
    assert.deepEqual(state.failureStreak, [8]);
    assert.equal(streakSentence(state), '2 phases failed in a row: phase 8');
  } finally { cleanup(); }
});

test('FS-6: an ending the board contradicts leaves the streak — reconcile prunes the phase it closes, and only it', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever' });
  state.consecutiveFailures = 2;
  state.failureStreak = [3, 5];
  for (const phase of [3, 5]) {
    const record = phaseRecord(state, phase);
    record.status = 'failed';
    record.attempts = 1;
    record.halt = { at: new Date().toISOString(), reason: 'no handoff', phase, kind: 'no-handoff' };
  }
  const { closed } = reconcileRecordsAgainstBoard(state, { 3: 'done', 5: 'ready' });
  assert.deepEqual(closed, [3]);
  assert.deepEqual(state.failureStreak, [5], 'phase 3 left the set; phase 5\'s failure stands');
  assert.equal(state.consecutiveFailures, 1);
  assert.deepEqual(pruneStreak(state, [5]), [5]);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.failureStreak, undefined, 'an emptied set is no set');
});

test('FS-6: the stored #45 contradiction — a verify-failed halt over a GREEN verification — is not an adjudication, and closes', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever' });
  state.status = 'halted';
  state.consecutiveFailures = 2;
  state.failureStreak = [9, 1];
  state.halt = { at: new Date().toISOString(), reason: '2 phases failed in a row', phase: 1, kind: 'failure-streak' };
  const rescued = phaseRecord(state, 1);
  rescued.status = 'failed';
  rescued.attempts = 1;
  rescued.halt = { at: new Date().toISOString(), reason: 'phase 1 did not verify: 1 of 5 command(s) failed', phase: 1, kind: 'verify-failed' };
  rescued.verification = { ok: true, reason: '4 commands green; `pnpm verify:local` green on retry (first exited 1)', ran: [red('pnpm verify:local'), retried(green('pnpm verify:local'))], notRun: [] };
  // A REAL red this run adjudicated stays held — the D27 rule is untouched.
  const adjudicated = phaseRecord(state, 9);
  adjudicated.status = 'failed';
  adjudicated.attempts = 1;
  adjudicated.halt = { at: new Date().toISOString(), reason: 'phase 9 did not verify', phase: 9, kind: 'verify-failed' };
  adjudicated.verification = { ok: false, reason: '`npm test` exited 1', ran: [red('npm test'), retried(red('npm test'))], notRun: [] };

  const { closed } = reconcileRecordsAgainstBoard(state, { 1: 'done', 9: 'done' });
  assert.deepEqual(closed, [1], 'the rescued record closes; the adjudicated one does not');
  assert.equal(state.phases['1'].status, 'done');
  assert.equal(state.phases['9'].status, 'failed');
  assert.equal(state.halt, null, 'the streak halt anchored on the closed phase dissolves');
  assert.deepEqual(state.failureStreak, [9]);
  assert.equal(state.consecutiveFailures, 1);
});

/* ------------------------------------------------------------------ *
 * FS-7..8 — a spent wait budget is a budget
 * ------------------------------------------------------------------ */

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-21T09:07:57Z');
const PLAN_HOUR: WaitBudget = { budgetMs: HOUR, source: 'phase', countersignedUntil: null, refs: [] };

test('FS-7: rule 7 grants min(asked, remaining) when the declaration names a pollable ref — and refuses a window nothing can end', () => {
  // The mql P19 arithmetic: a 1.0 h budget, 0.7 h already parked, a 1.5 h ask.
  const ask = { now: NOW, requestedUntil: NOW + 1.5 * HOUR, parkedMs: 0.7 * HOUR, waits: 1, budget: PLAN_HOUR, ledger: 'session' as const };
  const granted = evaluateWait({ ...ask, pollable: true });
  assert.ok(granted.verdict === 'park', 'a ref the clock can poll ends the wait — the window is only an upper bound');
  assert.equal(granted.granted, 0.3 * HOUR, 'what is left, not what was asked');
  assert.equal(granted.until, NOW + 0.3 * HOUR);
  assert.equal(granted.capped, true);
  assert.equal(granted.requested, NOW + 1.5 * HOUR, 'the ask stays on the record');

  const refused = evaluateWait(ask);
  assert.ok(refused.verdict === 'timeout', 'with nothing pollable, a declared window is still never cut in silence');
  assert.match(refused.reason, /does not cut a declared window short/);

  const spent = evaluateWait({ ...ask, parkedMs: HOUR, pollable: true });
  assert.ok(spent.verdict === 'timeout' && spent.ledger === 'budget', 'nothing left is a spent budget');
  assert.match(spent.reason, /budget is spent, so the phase waits on its refs/);
});

test('FS-7: a spent budget parks the phase WAITING with a `budgets` errand — no failed, no streak, no halt, no rung', async () => {
  // A one-minute budget and a floor of two: the declaration names a ref the
  // clock can poll and still cannot be granted anything.
  const h = harness([1], { budgetLine: '1\tphase' });
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      waitFloorMs: 2 * 60_000,
      spawn: async (req: SpawnReq) => {
        writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
          version: 1, slug: 'demo', phase: 1, status: 'waiting-external', reason: 'the image build',
          watch: ['gh:acme/app#run/35581228664'], resume_after: new Date(Date.now() + 1.5 * HOUR).toISOString(),
          written_at: new Date().toISOString(), session_id: 'sid-1',
        }));
        return success('sid-1');
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 } as never);
    await runner.wait();

    const record = state.phases['1'];
    assert.equal(record.status, 'waiting', 'waiting, not failed');
    assert.equal(record.parkedUntil, undefined, 'with no clock of its own');
    assert.equal(record.halt, undefined, 'and no halt');
    assert.equal(record.declared?.status, 'waiting-external', 'the declaration stands');
    assert.deepEqual(record.declared?.watch, ['gh:acme/app#run/35581228664'], 'with its refs');
    assert.equal(record.declared?.budgetSpent?.ledger, 'budget');
    assert.equal(record.resumeSessionId, 'sid-1', 'the session a landing resumes');
    assert.equal(state.consecutiveFailures, 0, 'a budget is not a failure — even at a maximum of 1');
    assert.notEqual(state.halt?.kind, 'failure-streak');
    assert.notEqual(state.status, 'halted');
    const errand = state.recoveries?.['1']?.errand;
    assert.equal(errand?.decisionKey, 'budgets');
    assert.match(errand?.need ?? '', /more wait budget for phase 1/);
    assert.match(errand?.how ?? '', /resumes its own session the moment one lands/);
    assert.equal(state.recoveries?.['1']?.rungs?.length ?? 0, 0, 'no rung');
    const lines = journal(h.root, state);
    const spent = lines.find((l) => l.event === 'phase.wait-budget-spent');
    assert.equal(spent?.data.parked, true);
    assert.equal(lines.filter((l) => l.event === 'phase.halted').length, 0);
    assert.equal(lines.filter((l) => l.event === 'run.failure-charged' || l.event === 'run.failure-streak-held').length, 0,
      'the streak is not even asked');
    // The run parks naming the errand, since nothing else is left to drive.
    assert.match(state.finishedReason ?? '', /more wait budget/);
  } finally { h.cleanup(); }
});

/** A run holding phase 1 waiting on a spent budget, as `spentBudgetPark` leaves it. */
function spentPark(refs: string[]): RunState {
  const at = new Date(NOW).toISOString();
  const state = newRun({ slug: 'alpha', root: '/tmp/whatever' });
  state.status = 'parked';
  state.phases['1'] = {
    phase: 1, status: 'waiting', attempts: 1,
    declared: {
      status: 'waiting-external', reason: 'the image build', watch: refs, at,
      budget: { ms: HOUR, source: 'phase' }, budgetSpent: { at, ledger: 'budget' },
    },
  } as PhaseRecord;
  return state;
}

class FakeClock {
  time = NOW;
  now = (): number => this.time;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers = this.timers.filter((t) => t.id !== handle); };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('FS-8: the refs of a spent-budget park keep being watched, and a landing is delivered', async () => {
  const state = spentPark(['lock:other/3']);
  const landed: string[] = [];
  const scheduler = new WatchScheduler({
    runs: () => [{ slug: 'alpha', state }],
    lockFree: () => true,
    onLanded: (_slug, _state, _phase, l) => { landed.push(l.ref); return 'done' as const; },
  });
  try {
    scheduler.open();
    await scheduler.tick();
    assert.deepEqual(landed, ['lock:other/3'], 'the landing reaches the healer, which resumes the session');
  } finally { scheduler.close(); }
});

test('FS-8: a `cmd:` ref of a spent-budget park runs past the budget\'s end — nothing else can end that wait', async () => {
  const clock = new FakeClock();
  const state = spentPark(['cmd:"gh run view 35581228664 --json status"']);
  let runs = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { runs += 1; return { ref: t.ref, state: 'pending', detail: 'exit 1' }; },
  });
  try {
    scheduler.open();
    // A day past a one-hour budget that was already spent when the park began.
    await clock.advance(24 * HOUR);
    assert.ok(runs > 3, `still watching (${runs} runs)`);
    const row = state.phases['1'].watchState!.refs[0];
    assert.equal(row.state, 'pending', 'never refused on the budget');
    assert.equal(state.phases['1'].watchRetired, undefined);
  } finally { scheduler.close(); }
});

test('FS-8: a landing resumes the phase\'s own session through the budget — the ref decides, not the spent window', async () => {
  const h = harness([1, 2], { budgetLine: '1\tphase' });
  try {
    let releasePhase2: () => void = () => {};
    const phase2 = new Promise<void>((resolve) => { releasePhase2 = resolve; });
    const spawns: SpawnReq[] = [];
    let runner!: Runner;
    runner = new Runner({
      scriptsDir: h.scriptsDir,
      waitFloorMs: 2 * 60_000,
      spawn: async (req: SpawnReq) => {
        spawns.push(req);
        const phase = phaseOf(req);
        if (phase === 1 && !req.resume) {
          writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
            version: 1, slug: 'demo', phase: 1, status: 'waiting-external', reason: 'the image build',
            watch: ['gh:acme/app#run/42'], written_at: new Date().toISOString(), session_id: 'sid-1',
          }));
          return success('sid-1');
        }
        if (phase === 2) {
          // While phase 2 works, the build phase 1 waits on lands — the
          // healer's two writes, then the live lane's door.
          const state = runner.current()!;
          await new Promise((resolve) => setTimeout(resolve, 50));
          state.phases['1'].declared!.landed = { ref: 'gh:acme/app#run/42', at: new Date().toISOString(), resumes: 1 };
          assert.equal(runner.landWatch(1, { ref: 'gh:acme/app#run/42' }, { count: 1, sessionId: 'sid-1' }), true,
            'the live lane accepts the landing on a spent-budget park');
          await phase2;
        }
        h.done(phase);
        return success(`sid-${phase}`);
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    // Phase 2 is in flight holding the one lane; let it finish.
    setTimeout(() => releasePhase2(), 200);
    await runner.wait();

    const parked = journal(h.root, state).find((l) => l.event === 'phase.wait-budget-spent');
    assert.equal(parked?.phase, 1, 'phase 1 parked on its SPENT budget first — the path under test');
    const resumed = spawns.find((s) => phaseOf(s) === 1 && s.resume);
    assert.ok(resumed, 'phase 1 was resumed');
    assert.equal(resumed!.resume, 'sid-1', 'its OWN session');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.phases['1'].declared?.budgetSpent, undefined, 'the spent-budget stamp retired');
    assert.equal(state.recoveries?.['1']?.errand, undefined, 'and the budgets errand answered');
    assert.equal(state.consecutiveFailures, 0);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * FS-9 — a resumed session's working time is not a wait
 * ------------------------------------------------------------------ */

test('FS-9: resumeWithInstruction closes the open wait entry — the session\'s working time is never charged to the wait budget', async () => {
  const h = harness([1]);
  try {
    let resumedAt = 0;
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async () => { resumedAt = Date.now(); h.done(1); return success('sid-1'); },
      verificationText: () => '`true`',
    } as never);
    const state = newRun({ slug: 'demo', root: h.root });
    const record = phaseRecord(state, 1);
    const parkedFrom = Date.now() - 30 * 60_000;
    record.status = 'waiting';
    record.attempts = 1;
    record.sessionId = 'sid-1';
    record.parkedUntil = new Date(Date.now() + 4 * HOUR).toISOString();
    record.declared = { status: 'waiting-external', watch: ['gh:acme/app#run/7'], at: new Date(parkedFrom).toISOString() };
    openWaitEntry(record, { parkedFrom: new Date(parkedFrom).toISOString(), parkedUntil: record.parkedUntil, by: 'session' }, parkedFrom);
    (runner as unknown as { state: RunState }).state = state;

    await (runner as unknown as { resumeWithInstruction: (p: number, i: string) => Promise<unknown> })
      .resumeWithInstruction(1, 'The build you waited on has landed — carry on.');

    const entry = record.waitHistory!.at(-1)!;
    assert.ok(entry.resumedAt, 'the park is closed on its own stamp');
    assert.ok(Date.parse(entry.resumedAt!) <= resumedAt, 'at the resume, before the session worked');
    assert.equal(record.parkedUntil, undefined, 'and its clock is cleared');
    // Four hours later the session has worked for four hours — none of it parked.
    const later = Date.now() + 4 * HOUR;
    const parked = parkedMsOf(record, later);
    assert.ok(parked < 31 * 60_000, `only the thirty minutes it really waited count (${Math.round(parked / 60_000)} min)`);
    assert.ok(parked <= DEFAULT_WAIT_BUDGET_MS);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * FS-11 — a verification's clock is not a merit failure (control-tower phase 83, #95)
 * ------------------------------------------------------------------ */

test('FS-11: a phase whose §Verification timed out is never a link in the streak — only the red beside it is charged', async () => {
  // Phase 1 fails on the merits; phase 2's suite runs past its clock twice.
  // The old verdict called the 124 a red, so this was "2 phases failed in a
  // row" — a halt only a person's press relaunches, over a suite that was
  // merely slow (P47: killed at 2043 s, green at 850 s on the same head).
  const h = harness([1, 2]);
  try {
    let asked = 0;
    const cut = (retry: boolean): VerifyRun => ({
      command: 'bash tests/run-tests.sh', ok: false, code: 124, ms: 1_800_000, output: '[timed out or cancelled]',
      timedOut: true, ...(retry ? { retry: true } : {}),
    });
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { h.done(phaseOf(req)); return success(`sid-${phaseOf(req)}`); },
      verificationText: (_slug: string, phase: number) => { asked = phase; return '`npm test` and `bash tests/run-tests.sh`'; },
      verify: async (): Promise<VerifySummary> => (asked === 1
        ? { ok: false, reason: '`npm test` exited 1', notRun: [], ran: [red('npm test'), retried(red('npm test'))] }
        : { ok: false, reason: 'timed out', notRun: [], timedOut: ['bash tests/run-tests.sh'], ran: [cut(false), cut(true)] }),
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    const charged = journal(h.root, state).filter((line) => line.event === 'run.failure-charged');
    assert.deepEqual(charged.map((line) => line.phase), [1], 'the red is charged; the timeout is not');
    assert.equal(state.phases['2'].status, 'parked');
    assert.equal(state.halt?.kind, 'verify-timeout', 'the run waits for a person over the timeout, it did not halt on a streak');
    assert.notEqual(state.halt?.kind, 'failure-streak');
  } finally { h.cleanup(); }
});
