/**
 * One root cause is charged once (control-tower phase 87, #122).
 *
 * #122's third comment: seq 4854 (P50, 1 of 4) and seq 4962 (P41, 2 of 4) on hub run 24fcba33 were
 * ONE root cause — P43's WIP commit `1c8164e9` — and `chargeFailure` deduped per phase only, so each
 * honest sibling added a charge; four declarations about two causes would have halted the run
 * press-only. The streak now counts ROOT CAUSES: a charge names what it is blamed on — the blamed
 * commit (a sibling's red WIP, phase 89's `wipRed`), else the refs the block watched — and a second
 * charge on a cause already counted is held.
 *
 * SR-1  a second block on the same cause is not a second charge — keyed by the blamed commit, else
 *       by the watch ref; a different cause still counts
 * SR-2  the halt names the cause
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
import {
  failureRootOf, newRun, pruneStreak, resetStreak, streakSentence, type FailureRoot, type PhaseRecord, type RunState,
} from '../server/runner/state.ts';

type Line = { event: string; phase?: number; data: Record<string, unknown> };

function journal(root: string, state: RunState): Line[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function harness(phases: number[]): { root: string; scriptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-streak-root-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block)
    echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: ${phases.join(',')}"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  return { root, scriptsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const success = (sessionId: string) => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

type SpawnReq = { prompt?: string; env?: Record<string, string> };
const phaseOf = (req: SpawnReq): number => Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1]);

/** A runner holding a run it is not driving — `chargeFailure` asked directly. */
function charger(max = 5) {
  const h = harness([1]);
  const runner = new Runner({ scriptsDir: h.scriptsDir, spawn: async () => success('x') } as never);
  const state = newRun({ slug: 'demo', root: h.root });
  state.maxConsecutiveFailures = max;
  (runner as unknown as { state: RunState }).state = state;
  // No loop, so no journal of its own: the lines it would write, as written.
  const lines: Line[] = [];
  (runner as unknown as { record: (event: string, data: Record<string, unknown>, phase?: number) => void }).record =
    (event, data, phase) => { lines.push({ event, data, phase }); };
  const charge = (phase: number, cause: string, root?: FailureRoot | null) =>
    (runner as unknown as { chargeFailure: (p: number, c: string, r?: string, root?: FailureRoot | null) => number })
      .chargeFailure(phase, cause, 'test', root);
  return { state, charge, lines, cleanup: h.cleanup };
}

/** Refs nothing polls, so a block on them is still charged — the case the key exists for. */
const BUILD_9 = 'url:https://ci.example.com/build/9';
const BUILD_10 = 'url:https://ci.example.com/build/10';

/* ------------------------------------------------------------------ *
 * SR-1 — one cause, one charge
 * ------------------------------------------------------------------ */

test('SR-1: the root is the blamed commit, else the watched refs — one key per cause, whatever order the refs came in', () => {
  const byCommit = failureRootOf({ commit: '1c8164e9aa77', refs: [BUILD_9] });
  assert.equal(byCommit?.key, 'commit:1c8164e9aa77', 'the blamed commit wins over the refs');
  assert.match(byCommit!.label, /1c8164e9/);
  const byRefs = failureRootOf({ refs: [BUILD_10, BUILD_9, BUILD_9] });
  assert.deepEqual(byRefs, failureRootOf({ refs: [BUILD_9, BUILD_10] }), 'sorted and deduped — the same wait is one cause');
  assert.equal(failureRootOf({ refs: [] }), null, 'nothing named: the charge is the phase\'s own, as before');
  assert.equal(failureRootOf({}), null);
});

test('SR-1: a second charge on a cause already counted is HELD, and says which phase carries it; another cause still counts', () => {
  const { state, charge, lines, cleanup } = charger();
  try {
    const wip = failureRootOf({ commit: '1c8164e9' });
    assert.equal(charge(50, 'declared-blocked', wip), 1, 'P50 blocked on P43\'s WIP');
    assert.equal(charge(41, 'declared-blocked', wip), 1, 'P41 on the SAME WIP is not a second failure');
    assert.deepEqual(state.failureStreak, [50]);
    assert.equal(charge(57, 'declared-blocked', failureRootOf({ refs: [BUILD_9] })), 2, 'a different cause counts');
    assert.equal(charge(60, 'verify-red'), 3, 'and a charge that names no cause counts per phase, as before');
    const held = lines.find((l) => l.event === 'run.failure-streak-held' && l.phase === 41);
    assert.match(String(held?.data.why), /same root cause/);
    assert.equal(held?.data.root, 'commit:1c8164e9');
    assert.equal(held?.data.sameAs, 50);
    const charged = lines.find((l) => l.event === 'run.failure-charged' && l.phase === 50);
    assert.equal(charged?.data.root, 'commit:1c8164e9');
  } finally { cleanup(); }
});

test('SR-1: the causes leave with their phases — a reset forgets them, a prune drops the pruned phase\'s', () => {
  const { state, charge, cleanup } = charger();
  try {
    charge(1, 'declared-blocked', failureRootOf({ refs: [BUILD_9] }));
    charge(2, 'declared-blocked', failureRootOf({ refs: [BUILD_10] }));
    assert.deepEqual(pruneStreak(state, [1]), [1]);
    assert.deepEqual(state.failureRoots?.map((r) => r.phase), [2]);
    // The cause phase 1 carried is free again: a new block on it is a new failure.
    assert.equal(charge(3, 'declared-blocked', failureRootOf({ refs: [BUILD_9] })), 2);
    resetStreak(state);
    assert.equal(state.failureRoots, undefined);
  } finally { cleanup(); }
});

test('SR-1: two phases blocked on ONE unpollable ref charge once — the run keeps driving at a ceiling of 2', async () => {
  const h = harness([1, 2]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      // The healer's availability, as the service answers it — the loop defers.
      rungDrivable: (_slug: string, rung: { vehicle: string }) => rung.vehicle === 'timed-park',
      spawn: async (req: SpawnReq) => {
        const phase = phaseOf(req);
        writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
          version: 1, slug: 'demo', phase, status: 'blocked', needs: 'external', reason: 'build 9 is red',
          watch: [BUILD_9], written_at: new Date().toISOString(), session_id: `sid-${phase}`,
        }));
        return success(`sid-${phase}`);
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 2 } as never);
    await runner.wait();

    assert.equal(state.phases['1'].status, 'failed');
    assert.equal(state.phases['2'].status, 'failed');
    assert.equal(state.consecutiveFailures, 1, 'one cause, one charge');
    assert.notEqual(state.halt?.kind, 'failure-streak');
    const held = journal(h.root, state).find((l) => l.event === 'run.failure-streak-held' && l.phase === 2);
    assert.equal(held?.data.root, `ref:${BUILD_9}`);
  } finally { h.cleanup(); }
});

test('SR-1: a block naming a sibling whose committed WIP is red is keyed by that commit (phase 89\'s `wipRed`)', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever' });
  state.phases['43'] = { phase: 43, status: 'waiting', attempts: 1, wipRed: { sha: '1c8164e9aa77', files: ['src/catalog.ts'] } } as PhaseRecord;
  const root = failureRootOf({ state, refs: ['phase:demo/43'] });
  assert.equal(root?.key, 'commit:1c8164e9aa77', 'the sibling\'s red commit is the cause');
  assert.equal(failureRootOf({ state, refs: ['phase:demo/44'] })?.key, 'ref:phase:demo/44', 'a sibling with no red WIP: the ref');
  assert.equal(failureRootOf({ state, refs: ['phase:other/43'] })?.key, 'ref:phase:other/43', 'another plan\'s phase is not this run\'s record');
});

/* ------------------------------------------------------------------ *
 * SR-2 — the halt names the cause
 * ------------------------------------------------------------------ */

test('SR-2: the streak halt names each counted phase\'s cause', async () => {
  const h = harness([1, 2]);
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      rungDrivable: (_slug: string, rung: { vehicle: string }) => rung.vehicle === 'timed-park',
      spawn: async (req: SpawnReq) => {
        const phase = phaseOf(req);
        writeFileSync(req.env!.PE_OUTCOME_FILE, JSON.stringify({
          version: 1, slug: 'demo', phase, status: 'blocked', needs: 'external', reason: 'a red build',
          watch: [phase === 1 ? BUILD_9 : BUILD_10], written_at: new Date().toISOString(), session_id: `sid-${phase}`,
        }));
        return success(`sid-${phase}`);
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', maxConsecutiveFailures: 2 } as never);
    await runner.wait();

    assert.equal(state.halt?.kind, 'failure-streak', 'two causes, two charges, the ceiling');
    assert.equal(state.halt?.reason, `2 phases failed in a row: phase 1 (on ${BUILD_9}), then phase 2 (on ${BUILD_10})`);
  } finally { h.cleanup(); }
});

test('SR-2: the sentence names a cause only where one was charged — an unnamed count stays the number', () => {
  const state = newRun({ slug: 'demo', root: '/tmp/whatever' });
  state.consecutiveFailures = 2;
  state.failureStreak = [3, 5];
  state.failureRoots = [{ phase: 5, key: 'commit:1c8164e9', label: 'commit 1c8164e9' }];
  assert.equal(streakSentence(state), '2 phases failed in a row: phase 3, then phase 5 (on commit 1c8164e9)');
});
