/**
 * A declared block with a watch is a wait, not a failure (control-tower phase 87, #122, #126).
 *
 * Measured on hub 4123 on 2026-09-25 (run 24fcba33): tfar P50 and P41 each finished their own work
 * and declared `blocked` on a sibling's WIP, each with a pollable watch on that sibling's handoff
 * (`cmd:grep -q '^status: complete' …/phase-43-….md`). The console classified both correctly —
 * `blocked-declared:external`, watching the ref — and recorded each phase `failed` anyway: the
 * runner had no vehicle of its own for the table's `poll-park` rung (only the healer's, on a stopped
 * run), so `closedBlocked` settled the phase `failed`, charged `declared-blocked` to the streak and
 * raised a `phase-blocked` halt. Two honest blocks were 2 of a 4-phase streak, cleared by hand.
 *
 * DB-1  a `blocked` declaration naming a pollable ref parks `waiting` through the runner's own
 *       `poll-park` — `phase.waiting`, never `failed`, no charge, no `phase-blocked` halt
 * DB-2  four honest blocks on one sibling's WIP halt nothing — the #122 replay
 * DB-3  the park is phase 45's budget and phase 50's window: a window past the budget is granted
 *       what is left and the declared window ends there; a spent budget is the budgets park
 * DB-4  a block with no ref and no errand still counts as before, and a watched block that
 *       reaches the charge anyway is `declared-wait`, which is not a merit failure
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import type { RunState } from '../server/runner/state.ts';
import { declaredWindowOf } from '../server/watch-refs.ts';
import { FAILURE_CAUSES, MERIT_FAILURE_CAUSES, isMeritFailure } from '../shared/run-lifecycle.js';

/* ------------------------------------------------------------------ *
 * The harness — independent phases, each done once its marker exists
 * ------------------------------------------------------------------ */

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void; stuck: (phase: number) => void; cleanup: () => void };

/** Each phase is ready until its `.done-<N>` marker exists — or `stuck` (a `blocked` handoff) under `.stuck-<N>`. */
function harness(phases: number[], opts: { budgetLine?: string } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-block-parks-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
S="${root}"
case "$2" in
  --memory-block)
    d=""; r=""; s=""
    for p in ${phases.join(' ')}; do
      if [ -f "$S/.done-$p" ]; then d="$d$p,"; elif [ -f "$S/.stuck-$p" ]; then s="$s$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: \${s%,}"; echo "ready: \${r%,}"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
  --wait-budget) printf ${JSON.stringify(opts.budgetLine ?? '')} ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return {
    root, scriptsDir,
    done: (phase) => writeFileSync(join(root, `.done-${phase}`), ''),
    stuck: (phase) => writeFileSync(join(root, `.stuck-${phase}`), ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type SpawnReq = { prompt?: string; name?: string; resume?: string; env?: Record<string, string> };

function phaseOf(req: SpawnReq): number {
  return Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1] ?? /\bp(\d+)\b/.exec(req.name ?? '')?.[1]);
}

const success = (sessionId: string) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

type Line = { event: string; phase?: number; data: Record<string, unknown> };

function journal(root: string, state: RunState): Line[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const HOUR = 3_600_000;

/** #122's watch, verbatim in shape: a sibling's handoff reaching `complete`. */
const SIBLING_REF = "cmd:grep -q '^status: complete' docs/handoffs/demo/phase-43-perf-ii-catalogs.md";

/** What P50's session wrote, as `phase-outcome.sh … blocked --needs external --watch …` writes it. */
function declareBlocked(req: SpawnReq, phase: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
    version: 1, slug: 'demo', phase, status: 'blocked', needs: 'external',
    reason: `P${phase} is built and its own code is green; the only red is P43's WIP commit 1c8164e9. Unblock = P43 lands.`,
    watch: [SIBLING_REF], written_at: new Date().toISOString(), session_id: `sid-${phase}`, ...extra,
  }));
}

/* ------------------------------------------------------------------ *
 * DB-1 — a declared block with a pollable ref is the runner's poll-park
 * ------------------------------------------------------------------ */

test('DB-1: a `blocked` declaration naming a pollable ref parks WAITING through the runner\'s own poll-park — never failed, never charged, never halted', async () => {
  const h = harness([1]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { declareBlocked(req, 1); return success('sid-1'); },
      verificationText: () => '`true`',
    } as never);
    // A ceiling of ONE: a single charge would halt the run on the streak.
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 } as never);
    await runner.wait();

    const record = state.phases['1'];
    assert.equal(record.status, 'waiting', 'waiting on its refs, not failed');
    assert.ok(record.parkedUntil && Date.parse(record.parkedUntil) > Date.now(), 'on a clock of its own (the default window)');
    assert.equal(record.halt, undefined, 'no phase-blocked halt');
    assert.equal(record.declared?.status, 'blocked', 'the testimony stands as the session gave it');
    assert.deepEqual(record.declared?.watch, [SIBLING_REF], 'with its refs, which the watch clock polls');
    assert.equal(record.declared?.needs, 'external');
    assert.equal(record.declared?.parked, 'poll-park', 'parked by the runner\'s poll-park');
    assert.ok(record.declared?.budget, 'judged against the phase\'s wait budget');
    assert.equal(record.resumeSessionId, 'sid-1', 'the session a landing resumes');
    assert.equal(record.undriven, undefined, 'not an undriven deferral card');
    assert.equal(state.consecutiveFailures, 0, 'a wait is not a failure — even at a ceiling of 1');
    assert.notEqual(state.halt?.kind, 'failure-streak');
    assert.notEqual(state.status, 'halted');
    assert.equal(state.recoveries?.['1']?.rungs?.length ?? 0, 0, 'the session\'s own wait spends no ladder rung');

    const lines = journal(h.root, state);
    const situation = lines.find((l) => l.event === 'phase.situation' && l.phase === 1);
    assert.equal(situation?.data.situation, 'blocked-declared:external', 'classified as #122 measured it');
    const waiting = lines.find((l) => l.event === 'phase.waiting' && l.phase === 1);
    assert.ok(waiting, 'phase.waiting is journalled');
    assert.equal(waiting!.data.rung, 'poll-park');
    assert.equal(waiting!.data.vehicle, 'runner', 'the RUNNER drove it — not a deferral to the healer');
    assert.equal(waiting!.data.declared, 'blocked');
    assert.deepEqual(waiting!.data.watch, [SIBLING_REF]);
    assert.equal(lines.filter((l) => l.event === 'run.failure-charged' || l.event === 'run.failure-streak-held').length, 0,
      'the streak is not even asked');
    assert.equal(lines.filter((l) => l.event === 'phase.halted').length, 0);
    assert.equal(lines.filter((l) => l.event === 'phase.ladder-deferred').length, 0, 'nothing deferred for a stop that never comes');
  } finally { h.cleanup(); }
});

test('DB-1: a block whose ref already LANDED, stuck again with no new word, is waited out — not parked on that ref again', async () => {
  const h = harness([1, 2]);
  try {
    let releasePhase2: () => void = () => {};
    const phase2 = new Promise<void>((resolve) => { releasePhase2 = resolve; });
    let runner!: Runner;
    runner = new Runner({
      scriptsDir: h.scriptsDir,
      rungDrivable: (_slug: string, rung: { vehicle: string }) => rung.vehicle === 'timed-park',
      spawn: async (req: SpawnReq) => {
        const phase = phaseOf(req);
        if (phase === 1 && !req.resume) { declareBlocked(req, 1); return success('sid-1'); }
        if (phase === 1) {
          // Resumed on the landing, it writes a `blocked` handoff and declares
          // nothing: the wait it declared is over, and something else stops it.
          h.stuck(1);
          return success('sid-1');
        }
        const state = runner.current()!;
        await new Promise((resolve) => setTimeout(resolve, 50));
        state.phases['1'].declared!.landed = { ref: SIBLING_REF, detail: 'exit 0', at: new Date().toISOString(), resumes: 1 };
        assert.equal(runner.landWatch(1, { ref: SIBLING_REF, detail: 'exit 0' }, { count: 1, sessionId: 'sid-1' }), true);
        await phase2;
        h.done(2);
        return success('sid-2');
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 3 } as never);
    setTimeout(() => releasePhase2(), 200);
    await runner.wait();

    const lines = journal(h.root, state);
    assert.equal(lines.filter((l) => l.event === 'phase.waiting' && l.phase === 1 && l.data.rung === 'poll-park').length, 1,
      'parked on the ref once — its landing ended that wait');
    assert.equal(state.phases['1'].status, 'failed', 'blocked on something no ref names: as before');
    const charged = lines.find((l) => l.event === 'run.failure-charged' && l.phase === 1);
    assert.equal(charged?.data.cause, 'declared-blocked', 'a merit block — the ref it named is no wait any more');
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * DB-2 — the #122 replay: four honest blocks halt nothing
 * ------------------------------------------------------------------ */

test('DB-2: four honest blocks on one sibling\'s WIP halt nothing — each waits, the streak reads 0 of 4', async () => {
  const h = harness([1, 2, 3, 4]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { const phase = phaseOf(req); declareBlocked(req, phase); return success(`sid-${phase}`); },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 4 } as never);
    await runner.wait();

    for (const phase of [1, 2, 3, 4]) {
      assert.equal(state.phases[String(phase)].status, 'waiting', `phase ${phase} waits`);
      assert.equal(state.phases[String(phase)].halt, undefined, `phase ${phase} is not halted`);
    }
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.failureStreak?.length ?? 0, 0);
    assert.notEqual(state.halt?.kind, 'failure-streak', 'the press-only halt #122 measured cannot form');
    assert.notEqual(state.status, 'halted');
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * DB-3 — phase 45's budget, phase 50's window
 * ------------------------------------------------------------------ */

test('DB-3: a declared window past the budget is granted what is left, and the declared window ends where the budget does', async () => {
  // P41's shape (#126): a twelve-hour window against a one-hour budget.
  const h = harness([1], { budgetLine: '60\tphase' });
  try {
    const asked = new Date(Date.now() + 12 * HOUR).toISOString();
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: async (req: SpawnReq) => { declareBlocked(req, 1, { resume_after: asked }); return success('sid-1'); },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' } as never);
    await runner.wait();

    const record = state.phases['1'];
    assert.equal(record.status, 'waiting');
    const until = Date.parse(record.parkedUntil ?? '');
    assert.ok(Math.abs(until - (Date.parse(record.declared!.at) + HOUR)) < 5_000,
      `granted the hour that was left, not the twelve asked (${record.parkedUntil})`);
    assert.equal(record.declared?.requested, asked, 'what was asked stays on the record');
    const waiting = journal(h.root, state).find((l) => l.event === 'phase.waiting');
    assert.equal(waiting?.data.capped, true, 'the cut is said, never silent');
    assert.equal(waiting?.data.budgetSource, 'phase');
    // Phase 50's window, read by the `cmd:` cadence, ends with the budget too.
    const window = declaredWindowOf(record);
    assert.ok(window, 'the park has a window');
    assert.equal(window!.until, until, 'the declared window is the clamped one — the card, the API and the cadence agree');
  } finally { h.cleanup(); }
});

test('DB-3: a block whose budget is already spent is the budgets park — waiting on its refs with no clock, never failed', async () => {
  const h = harness([1], { budgetLine: '1\tphase' });
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      waitFloorMs: 2 * 60_000,
      spawn: async (req: SpawnReq) => {
        declareBlocked(req, 1, { resume_after: new Date(Date.now() + 1.5 * HOUR).toISOString() });
        return success('sid-1');
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 } as never);
    await runner.wait();

    const record = state.phases['1'];
    assert.equal(record.status, 'waiting');
    assert.equal(record.parkedUntil, undefined, 'no clock of its own');
    assert.equal(record.declared?.status, 'blocked', 'still the session\'s block');
    assert.equal(record.declared?.budgetSpent?.ledger, 'budget');
    assert.deepEqual(record.declared?.watch, [SIBLING_REF], 'its refs still watched');
    assert.equal(state.recoveries?.['1']?.errand?.decisionKey, 'budgets');
    assert.equal(state.consecutiveFailures, 0);
    const lines = journal(h.root, state);
    assert.equal(lines.find((l) => l.event === 'phase.wait-budget-spent')?.data.parked, true);
    assert.equal(lines.filter((l) => l.event === 'run.failure-charged').length, 0);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * DB-4 — what still counts
 * ------------------------------------------------------------------ */

test('DB-4: a block with no ref and no errand still counts as before — failed, charged `declared-blocked`, halted phase-blocked', async () => {
  const h = harness([1]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      // The healer's availability, as the service answers it: `timed-park` is
      // drivable on a stopped run, so the loop defers rather than parking.
      rungDrivable: (_slug: string, rung: { vehicle: string }) => rung.vehicle === 'timed-park',
      spawn: async (req: SpawnReq) => { declareBlocked(req, 1, { watch: [], reason: 'the vendor API is down' }); return success('sid-1'); },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 3 } as never);
    await runner.wait();

    const record = state.phases['1'];
    assert.equal(record.status, 'failed', 'nothing can unblock it by itself');
    assert.equal(record.halt?.kind, 'phase-blocked');
    assert.equal(state.consecutiveFailures, 1);
    const charged = journal(h.root, state).find((l) => l.event === 'run.failure-charged');
    assert.equal(charged?.data.cause, 'declared-blocked');
  } finally { h.cleanup(); }
});

test('DB-4: `declared-wait` is a failure cause and not a merit one — a watched block that reaches the charge moves nothing', () => {
  assert.ok(FAILURE_CAUSES.includes('declared-wait' as never));
  assert.equal(MERIT_FAILURE_CAUSES.includes('declared-wait' as never), false);
  assert.equal(isMeritFailure('declared-wait'), false, 'a wait says nothing about the plan');
  assert.equal(isMeritFailure('declared-blocked'), true, 'a block nothing can end still does');
});
