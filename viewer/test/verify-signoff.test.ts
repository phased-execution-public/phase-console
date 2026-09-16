/**
 * "Nothing ran" is a question, not a verdict.
 *
 * A real run stopped on this, twice, and left nothing to press:
 *
 *   phase 10  failed  9 tries  $0.00   session exited with code 1
 *     nothing runnable in this phase's verification (1 fragment left for a human)
 *     1 step(s) a person must check
 *       those commands. — no command in the plan text — verify by hand
 *     [Retry] [Skip]
 *
 * Neither control fitted. Retry re-runs a session that was never at fault and
 * arrives at the same non-result; Skip discards a phase that may well have
 * succeeded. The missing option was the only one that made sense — a person
 * saying "I checked it" — so the runner had no way to be told, and the run sat
 * there with a `running` badge and nothing holding it.
 *
 * These cover the distinction the runner now makes: a command that ran and
 * failed is a verdict — recorded on the phase, never a card, and (since the
 * board-first rule) not a halt when the handoff already reads complete —
 * while a check nobody could run is a question, and questions get a card.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { Approvals } from '../server/runner/approvals.ts';
import type { VerifySummary } from '../server/runner/state.ts';

/**
 * An approvals broker that can be awaited rather than polled for.
 *
 * These tests used to spin on `pending()` for a fixed two seconds, which is not
 * an assertion about anything — it is a guess about how fast this machine is,
 * and it failed the first time the suite got busy enough to make the guess
 * wrong. The broker already announces a new card to a callback, so waiting on
 * that is both exact and immune to load.
 */
function watchedApprovals() {
  let announce: (approval: { id: string }) => void = () => {};
  const first = new Promise<{ id: string }>((resolve) => { announce = resolve; });
  const approvals = new Approvals((approval) => announce(approval));
  return { approvals, first };
}

/**
 * A scripts directory whose `phase-graph.sh` reports one ready phase that is
 * done the moment it is asked a second time, so the loop reaches verification
 * without a model anywhere near it.
 */
function harness(
  qa?: { mode: string; result: string; history?: string },
): { root: string; scriptsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-signoff-'));
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });

  // The board flips to done only after the phase has actually been handed out,
  // because the runner re-reads it afterwards and refuses to take the session's
  // word for the result. A stub that always says "ready" fails that check —
  // correctly — and would make every test here look like a runner bug.
  writeFileSync(join(scriptsDir, 'phase-graph.sh'), `#!/bin/bash
ran="${join(root, '.phase-served')}"
case "$2" in
  --memory-block)
    if [ -f "$ran" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1"; touch "$ran" ;;
  --qa-mode)      echo "${qa?.mode ?? ''}" ;;
  --qa-result)    echo "${qa?.result ?? ''}" ;;
  --qa-history)   printf '%b' ${JSON.stringify(qa?.history ?? '')} ;;
esac
exit 0
`, { mode: 0o755 });
  // A REAL `test-status.md`, because the round chooser reads the FILE — the one
  // authority both halves of the system share. Stubbing `--qa-history` used to
  // be enough and is not any more, which is the point: a test that seeds a stub
  // the product no longer consults is a test that has stopped asking anything.
  if (qa?.history) {
    const dir = join(root, 'docs', 'handoffs', 'demo');
    mkdirSync(dir, { recursive: true });
    const rows = qa.history.split('\n').filter(Boolean).map((line) => {
      const [round, verdict, report] = line.split('\t');
      return `| 1 | ${round} | ${verdict} | ${report} | 2026-09-01 |`;
    });
    writeFileSync(join(dir, 'test-status.md'), [
      '# QA / test status — demo', '', '## QA status', '',
      '| Phase | Result | Report | Round |', '|------:|--------|--------|------:|',
      '| 1 | pending | - | - |', '',
      '## QA rounds', '', '| Phase | Round | Result | Report | Recorded |',
      '|------:|------:|--------|--------|----------|', ...rows, '',
    ].join('\n'));
  }
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });

  return { root, scriptsDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A session that always succeeds without spending anything. */
const happySpawn = async () => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId: 'sid', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

function makeRunner(h: ReturnType<typeof harness>, verification: VerifySummary, approvals?: Approvals) {
  return new Runner({
    scriptsDir: h.scriptsDir,
    spawn: happySpawn,
    verify: async () => verification,
    verificationText: () => 'run those commands.',
    approvals,
    origin: 'http://127.0.0.1:4123',
  });
}

const NOTHING_RAN: VerifySummary = {
  ok: false,
  reason: "nothing runnable in this phase's verification (1 fragment left for a human)",
  ran: [],
  notRun: [{ text: 'those commands.', reason: 'no command in the plan text — verify by hand' }],
};

const A_COMMAND_FAILED: VerifySummary = {
  ok: false,
  reason: '1 command failed',
  ran: [{ command: 'npm test', ok: false, code: 1, ms: 10, output: '3 failing' }],
  notRun: [],
};

// The P15 incident shape: the first command exited red, so the extractor
// skipped the rest — and those skips are the machine's own doing, not a
// question the plan asked a person.
const RED_WITH_CASCADE: VerifySummary = {
  ok: false,
  reason: '`npm test` exited 1',
  ran: [{ command: 'npm test', ok: false, code: 1, ms: 10, output: '3 failing' }],
  notRun: [{ text: 'npm run typecheck', reason: 'skipped after an earlier command failed' }],
};

test('a command that ran and failed is a verdict on the record, never a card — and the board-vouched phase is not halted', async () => {
  // The halt this used to pin was the phantom class the board-first rule
  // retired: verification only runs after `closed()` has read the board done,
  // so every ran-and-failed red lands over a complete handoff — and the
  // measured incidents (eight urgent halts in one night, each dissolved by
  // reconcile sixty seconds later) were exactly that shape. The distinction
  // this suite exists for survives whole: ran-and-failed is a VERDICT, so it
  // is recorded and never asks a person; not-run is a QUESTION, so it raises
  // the card the next test pins.
  const h = harness();
  try {
    const approvals = new Approvals();
    const runner = makeRunner(h, A_COMMAND_FAILED, approvals);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.notEqual(state.status, 'halted', 'the board vouched for the phase; no halt');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.phases['1'].verification?.ok, false, 'the red verdict is not erased');
    assert.match(state.phases['1'].note ?? '', /Verification is red/, 'and it travels on the record');
    assert.equal(approvals.pending().length, 0, 'a verdict is not a question — no card');
  } finally { h.cleanup(); }
});

const ALL_GREEN: VerifySummary = {
  ok: true, reason: '1 command green',
  ran: [{ command: 'npm test', ok: true, code: 0, ms: 10, output: 'ok' }],
  notRun: [],
};

/** A spawn that records every request — the phase attempt, then whatever else. */
function recordingSpawn() {
  const spawns: Array<Record<string, unknown>> = [];
  const spawn = async (req: Record<string, unknown>) => {
    spawns.push(req);
    return {
      signal: { subtype: 'success' as const, code: 0, text: 'done' },
      sessionId: 'sid', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
    };
  };
  return { spawns, spawn };
}

test('a QA-on phase with no verdict is asked for one at finish, in its own session', async () => {
  // Measured: the qa-verdict rung fires only when the run PARKS, so a phase
  // built at 02:42 got its verdict chased at 09:03 — 6.3 hours later, cold —
  // while its dependents waited. The verdict is owed at finish, warm.
  const h = harness({ mode: 'on (phase directive: QA: on)', result: 'pending' });
  const { spawns, spawn } = recordingSpawn();
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: spawn as never,
      verify: async () => ALL_GREEN,
      verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(state.phases['1'].status, 'done');
    assert.equal(spawns.length, 2, 'the phase attempt, then the QA-verdict resume');
    assert.equal(spawns[1].resume, 'sid', "the phase's OWN session — the subagent it dispatches is the fresh context");
    assert.match(String(spawns[1].prompt), /qa-record\.sh/);
    assert.match(String(spawns[1].prompt), /--qa-prompt 1/);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * QA's own model, effort and rounds (issue #7)
 * ------------------------------------------------------------------ */

test("QA runs at its own model and effort, and defaults to the run's", async () => {
  // The review is a different job from the build and is regularly worth a
  // different tier in EITHER direction — "build with Fable, review with Opus",
  // or a cheap reviewer over a mechanical phase. Until `qaModel`/`qaEffort`
  // there was no line anyone could write that would say so: QA inherited
  // `record.model ?? state.model` with no way past it.
  const own = harness({ mode: 'on', result: 'pending' });
  try {
    const { spawns, spawn } = recordingSpawn();
    const runner = new Runner({
      scriptsDir: own.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    await runner.start({
      slug: 'demo', root: own.root, autonomy: 'keep-going',
      model: 'fable', effort: 'high', qaModel: 'opus', qaEffort: 'max',
    });
    await runner.wait();
    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].model, 'fable', 'the BUILD keeps the run\'s model');
    assert.equal(spawns[0].effort, 'high');
    assert.equal(spawns[1].model, 'opus', 'and the review gets its own');
    assert.equal(spawns[1].effort, 'max');
  } finally { own.cleanup(); }

  // Absent, they mean exactly what they meant before they existed.
  const inherited = harness({ mode: 'on', result: 'pending' });
  try {
    const { spawns, spawn } = recordingSpawn();
    const runner = new Runner({
      scriptsDir: inherited.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    await runner.start({
      slug: 'demo', root: inherited.root, autonomy: 'keep-going', model: 'fable', effort: 'high',
    });
    await runner.wait();
    assert.equal(spawns[1].model, 'fable', "no qaModel — the builder's, as always");
    assert.equal(spawns[1].effort, 'high');
  } finally { inherited.cleanup(); }
});

test('the QA round lands on the phase record — round, verdict, report and what it spent', async () => {
  // The gap issue #7 opens with: QA was spawned, it decided whether every
  // dependent could start, it cost real money, and the run record carried
  // cost, turns and one word in a journal line. No verdict, no report path, no
  // findings — `client/src/lib/api.ts` had no `qa` field at all.
  const h = harness({ mode: 'on', result: 'pending' });
  try {
    // The reviewer records round 1 while it runs, which is what the engine
    // reports back the second time the runner asks.
    writeFileSync(join(h.scriptsDir, 'phase-graph.sh'), `#!/bin/bash
ran="${join(h.root, '.phase-served')}"
seen="${join(h.root, '.qa-asked')}"
case "$2" in
  --memory-block)
    if [ -f "$ran" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1"; touch "$ran" ;;
  --qa-mode)      echo "on" ;;
  --qa-result)    if [ -f "$seen" ]; then echo "pass"; else echo "pending"; fi ;;
  --qa-history)   if [ -f "$seen" ]; then printf '1\\tpass\\treports/phase-01-qa.md\\t2026-09-02\\n'; fi ;;
esac
exit 0
`, { mode: 0o755 });

    // The reviewer records its verdict, which is what makes `--qa-result` flip
    // and what puts a row in the ledger. Doing it in the SPAWN rather than as a
    // side effect of the engine being asked is both truer and independent of
    // which engine calls the runner happens to make.
    const spawn = async (request: Record<string, unknown>) => {
      // The REVIEWER records the verdict — not the phase's own build session,
      // which uses this same stub. Keyed on the brief, because that is what
      // actually distinguishes them.
      if (/qa-record\.sh/.test(String(request.prompt))) writeFileSync(join(h.root, '.qa-asked'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid', costUsd: 1.25, turns: 7, resultText: 'done', durationMs: 1, argv: [],
      };
    };
    const runner = new Runner({
      scriptsDir: h.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    const rounds = state.phases['1'].qa ?? [];
    assert.equal(rounds.length, 1, `one round recorded: ${JSON.stringify(rounds)}`);
    assert.equal(rounds[0].round, 1);
    assert.equal(rounds[0].verdict, 'pass');
    assert.equal(rounds[0].reportPath, 'reports/phase-01-qa.md', 'the report is LINKED, not merely written');
    assert.equal(rounds[0].sessionId, 'sid');
    assert.equal(rounds[0].costUsd, 1.25, 'and what the review cost is attributable to the review');
    assert.equal(rounds[0].turns, 7);
    assert.ok(rounds[0].brief, 'the brief that was sent is recoverable');
  } finally { h.cleanup(); }
});

test('a reviewer that records BELOW the briefed round lands as the round it recorded, not a phantom', async () => {
  // QA round 5, F1. A report on disk that no row mentions makes the chooser
  // brief round 2; a reviewer that records at round 1 anyway (a pre-rounds
  // writer, a hand run) used to be dropped by a `round >= briefed` filter, and
  // the synthetic entry then put round 2 on the record — a round the ledger
  // does not hold, pointing at a file nobody wrote, which the budget counted.
  // What the file GAINED is the record, whatever number was briefed.
  const h = harness({ mode: 'on', result: 'pending' });
  try {
    const dir = join(h.root, 'docs', 'handoffs', 'demo');
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'reports', 'phase-01-qa.md'), '# written, never recorded');
    writeFileSync(join(h.scriptsDir, 'phase-graph.sh'), `#!/bin/bash
ran="${join(h.root, '.phase-served')}"
seen="${join(h.root, '.qa-asked')}"
case "$2" in
  --memory-block)
    if [ -f "$ran" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1"; touch "$ran" ;;
  --qa-mode)      echo "on" ;;
  --qa-result)    if [ -f "$seen" ]; then echo "pass"; else echo "pending"; fi ;;
  --qa-history)   if [ -f "$seen" ]; then printf '1\\tpass\\treports/phase-01-qa.md\\t2026-09-02\\n'; fi ;;
esac
exit 0
`, { mode: 0o755 });
    const briefs: string[] = [];
    const spawn = async (request: Record<string, unknown>) => {
      if (/qa-record\.sh/.test(String(request.prompt))) {
        briefs.push(String(request.prompt));
        writeFileSync(join(h.root, '.qa-asked'), '');
      }
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid', costUsd: 2, turns: 9, resultText: 'done', durationMs: 1, argv: [],
      };
    };
    const runner = new Runner({
      scriptsDir: h.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(briefs.length, 1, 'one review was spawned');
    assert.match(briefs[0], /--report reports\/phase-01-qa-round2\.md --round 2/, 'briefed PAST the unrecorded file');
    const rounds = state.phases['1'].qa ?? [];
    assert.deepEqual(rounds.map((r) => [r.round, r.verdict, r.reportPath]), [[1, 'pass', 'reports/phase-01-qa.md']],
      `the record holds what the FILE gained, not the briefed number: ${JSON.stringify(rounds)}`);
    assert.equal(rounds[0].costUsd, 2, 'and the spend is booked against it');
  } finally { h.cleanup(); }
});

test('nothing gained but a verdict flipped lands as the NEWEST round on file, never the briefed one', async () => {
  // QA round 6. A `pending` status row over a ledger of rounds 1–2 makes the
  // chooser brief round 3; a reviewer that re-records round 2's row unchanged
  // flips the status while the ledger gains nothing. The record carries round
  // 2 — the newest on file — never a phantom round 3 pointing at no file.
  const h = harness({
    mode: 'on', result: 'pending',
    history: '1\tfail\treports/phase-01-qa.md\n2\tpass\treports/phase-01-qa-round2.md',
  });
  try {
    writeFileSync(join(h.scriptsDir, 'phase-graph.sh'), `#!/bin/bash
ran="${join(h.root, '.phase-served')}"
seen="${join(h.root, '.qa-asked')}"
case "$2" in
  --memory-block)
    if [ -f "$ran" ]; then echo "ready: "; echo "done: 1"; echo "phase 1: done";
    else echo "ready: 1"; echo "done: "; echo "phase 1: ready"; fi ;;
  --gate-status)  echo "clear (no gate)" ;;
  --boot-prompt)  echo "do phase 1"; touch "$ran" ;;
  --qa-mode)      echo "on" ;;
  --qa-result)    if [ -f "$seen" ]; then echo "pass"; else echo "pending"; fi ;;
  --qa-history)   printf '1\\tfail\\treports/phase-01-qa.md\\t2026-09-01\\n2\\tpass\\treports/phase-01-qa-round2.md\\t2026-09-02\\n' ;;
esac
exit 0
`, { mode: 0o755 });
    const briefs: string[] = [];
    const spawn = async (request: Record<string, unknown>) => {
      if (/qa-record\.sh/.test(String(request.prompt))) {
        briefs.push(String(request.prompt));
        writeFileSync(join(h.root, '.qa-asked'), '');
      }
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid', costUsd: 1, turns: 3, resultText: 'done', durationMs: 1, argv: [],
      };
    };
    const runner = new Runner({
      scriptsDir: h.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(briefs.length, 1, 'one review was spawned');
    assert.match(briefs[0], /--round 3/, 'briefed round 3 over a ledger of two');
    const rounds = state.phases['1'].qa ?? [];
    assert.deepEqual(rounds.map((r) => [r.round, r.verdict, r.reportPath]), [[2, 'pass', 'reports/phase-01-qa-round2.md']],
      `the newest round on file, not the briefed number: ${JSON.stringify(rounds)}`);
  } finally { h.cleanup(); }
});

test('a second review is briefed to write its OWN report, never over the first', async () => {
  // The convention was the sessions' own invention and nothing enforced it, so
  // a reviewer told `phase-NN-qa.md` twice destroyed the earlier report. On the
  // run issue #7 was written from there were 22 such files across 12 phases,
  // one phase five rounds deep, and `test-status.md` pointed at the last.
  const h = harness({
    mode: 'on', result: 'pending',
    history: '1\tfail\treports/phase-01-qa.md',
  });
  try {
    const { spawns, spawn } = recordingSpawn();
    const runner = new Runner({
      scriptsDir: h.scriptsDir, spawn: spawn as never,
      verify: async () => ALL_GREEN, verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    const prompt = String(spawns[1].prompt);
    assert.match(prompt, /reports\/phase-01-qa-round2\.md/, 'round 2 writes its own file');
    assert.match(prompt, /--round 2/);
    assert.doesNotMatch(prompt, /--report reports\/phase-01-qa\.md/, "never round 1's name again");
  } finally { h.cleanup(); }
});

test('a recorded verdict dispatches nothing at finish', async () => {
  const h = harness({ mode: 'on (phase directive: QA: on)', result: 'pass' });
  const { spawns, spawn } = recordingSpawn();
  try {
    const runner = new Runner({
      scriptsDir: h.scriptsDir,
      spawn: spawn as never,
      verify: async () => ALL_GREEN,
      verificationText: () => 'run those commands.',
      origin: 'http://127.0.0.1:4123',
    });
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(spawns.length, 1, 'a verdict exists — nothing to chase');
  } finally { h.cleanup(); }
});

test('a cascade skip behind a real red raises no card — the overtaken settle carries it', async () => {
  // Measured: one of these parked a whole run for 3h52m awaiting a human,
  // over a phase the board already vouched for — the skipped command was a
  // CONSEQUENCE of the red, manufactured at verify time, not a fragment the
  // plan left for a person.
  const h = harness();
  const { approvals, first } = watchedApprovals();
  const runner = makeRunner(h, RED_WITH_CASCADE, approvals);
  try {
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await Promise.race([
      runner.wait(),
      first.then(() => { throw new Error('a cascade skip is not a question — no card may be raised'); }),
    ]);

    assert.notEqual(state.status, 'halted', 'the board vouched for the phase; no halt');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.phases['1'].verification?.ok, false, 'the red verdict is not erased');
    assert.match(state.phases['1'].note ?? '', /Verification is red/, 'and it travels on the record');
    assert.equal(approvals.pending().length, 0);
  } finally {
    for (const card of approvals.pending()) approvals.settle(card.id, 'allow', 'cleanup', '');
    await runner.wait().catch(() => {});
    h.cleanup();
  }
});

// The live incident, 2026-08-28: every phase of a trusted keep-going run held
// `docker compose up -d …` + `sleep 8` in its §Verification PREAMBLE. The
// suite ran (red travelling on the record, board vouching for the handoff) —
// and the card still went up, "2 checks only you can make", one of which
// waited ~6 hours overnight for a person to vouch for a pause.
const RED_WITH_QUESTION: VerifySummary = {
  ok: false,
  reason: '`npm test` exited 1',
  ran: [{ command: 'npm test', ok: false, code: 1, ms: 10, output: '3 failing' }],
  notRun: [{
    text: 'docker compose up -d db',
    reason: '`docker compose up -d db` is not one of the read-only docker subcommands — a person should run this, not an unattended runner',
  }],
};

test('a genuine fragment behind measured, board-vouched work raises no card on keep-going', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  const runner = makeRunner(h, RED_WITH_QUESTION, approvals);
  try {
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await Promise.race([
      runner.wait(),
      first.then(() => { throw new Error('the board vouched for measured work — no card may be raised'); }),
    ]);

    assert.notEqual(state.status, 'halted', 'the board vouched for the phase; no halt');
    assert.equal(state.phases['1'].status, 'done');
    assert.equal(state.phases['1'].verification?.ok, false, 'the red verdict is not erased');
    assert.equal(state.phases['1'].verification?.notRun.length, 1, 'the fragment stays on the record');
    assert.equal(approvals.pending().length, 0);
  } finally {
    for (const card of approvals.pending()) approvals.settle(card.id, 'allow', 'cleanup', '');
    await runner.wait().catch(() => {});
    h.cleanup();
  }
});

test('halt-on-everything still asks — and confirming the fragments does not repaint a measured red', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const runner = makeRunner(h, RED_WITH_QUESTION, approvals);
    void runner.start({ slug: 'demo', root: h.root, autonomy: 'halt-on-everything' });

    await first;
    const card = approvals.pending()[0];
    assert.equal(card.kind, 'verify', 'the cautious autonomy keeps its card');

    approvals.settle(card.id, 'allow', 'a reviewer', 'compose stack is up');
    await runner.wait();

    const record = runner.current()!.phases['1'];
    assert.equal(record.status, 'done');
    assert.equal(record.verification?.ok, false,
      'a tap on "the docker line is fine" must not erase a command that ran and exited red');
    assert.match(record.verification?.reason ?? '', /exited 1/, 'the red verdict stays named');
    assert.match(record.verification?.reason ?? '', /confirmed by a reviewer/,
      'and so does who confirmed the manual checks');
  } finally { h.cleanup(); }
});

test('a verification that ran nothing raises a card instead of failing the phase', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const runner = makeRunner(h, NOTHING_RAN, approvals);
    void runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });

    // The loop parks here, waiting on a person, rather than marking it failed.
    await first;
    const pending = approvals.pending();

    assert.equal(pending.length, 1, 'the unrunnable checks should become one card');
    const card = pending[0];
    assert.equal(card.kind, 'verify');
    assert.equal(card.phase, 1);
    assert.match(card.title, /only you can make/);
    assert.ok(
      card.evidence.some((e) => e.body.includes('those commands.')),
      "the card must carry the plan's own words — a bare yes/no is a rubber stamp",
    );
    assert.ok(
      Date.parse(card.expiresAt) - Date.now() > 60 * 60 * 1000,
      'a human check has no hook waiting on it and must not expire in minutes',
    );

    // And the phase says so, rather than reading `failed`.
    assert.equal(runner.current()?.phases['1'].status, 'awaiting-verification');

    approvals.settle(card.id, 'allow', 'a reviewer', 'checked the gate stack in the browser');
    await runner.wait();

    const state = runner.current()!;
    assert.equal(state.phases['1'].status, 'done', 'a confirmed check should let the phase finish');
    assert.equal(state.phases['1'].verification?.ok, true);
    assert.match(state.phases['1'].verification?.reason ?? '', /confirmed by a reviewer/,
      'who confirmed it belongs on the record');
  } finally { h.cleanup(); }
});

test('a stop during confirm leaves the phase interrupted, not done', async () => {
  // The 00:22Z incident: the shutdown aborted verification, verifyPhase
  // answered a vacuous green over zero ran commands, and confirm() settled the
  // phase done mid-teardown. Whatever the summary claims, a stopping console
  // proves nothing — the record stays in flight and teardown writes the truth.
  const h = harness();
  let runner: InstanceType<typeof Runner>;
  runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: happySpawn,
    verify: async () => {
      void runner.stop(); // sets stopRequested + aborts synchronously, then drains
      return {
        ok: true, reason: '0 commands green', ran: [],
        notRun: [{ text: 'npm test', reason: 'the run was stopped before this command' }],
      };
    },
    verificationText: () => 'run those commands.',
    origin: 'http://127.0.0.1:4123',
  });
  try {
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    assert.notEqual(state.phases['1'].status, 'done', 'a stopped verify settles nothing');
    assert.equal(state.phases['1'].status, 'interrupted', 'teardown writes the honest word');
  } finally {
    await runner.wait().catch(() => {});
    h.cleanup();
  }
});

test('saying the manual check failed halts, and says who said so', async () => {
  const h = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const runner = makeRunner(h, NOTHING_RAN, approvals);
    void runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });

    await first;
    const pending = approvals.pending();
    assert.equal(pending.length, 1);

    approvals.settle(pending[0].id, 'deny', 'a reviewer', 'the gate box never rendered');
    await runner.wait();

    const state = runner.current()!;
    // `verify-failed` is PHASE-level: the phase carries its own ending and the
    // run parks with nothing left to run rather than draining its siblings.
    assert.equal(state.phases['1'].status, 'failed');
    assert.match(state.phases['1'].halt?.reason ?? '', /the gate box never rendered/);
    assert.equal(state.status, 'parked', `run status; phases=${JSON.stringify(Object.values(state.phases).map((r) => [r.phase, r.status, r.halt?.kind]))}`);
    // …and the run does not report "every phase is done" over it. The sentence
    // names the phase it is quoting, so an operator who reads only this line
    // opens the right phase page.
    assert.match(state.finishedReason ?? '', /^phase 1 did not finish cleanly — phase 1: /);
    assert.doesNotMatch(state.finishedReason ?? '', /is done\./);
  } finally { h.cleanup(); }
});

test('ZTD-6: `Person-check: allow` records the prose checks waived by policy and raises no card; an owner is named on the card; a card\'s `by` is the answerer, never console', async () => {
  const allowed = harness();
  try {
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    const runner = new Runner({
      scriptsDir: allowed.scriptsDir, spawn: happySpawn, verify: async () => NOTHING_RAN,
      verificationText: () => 'run those commands.', approvals: watchedApprovals().approvals,
      origin: 'http://127.0.0.1:4123', personCheck: () => 'allow',
      onEvent: (event, data) => { if (event === 'run:journal') lines.push(data as { event: string; data: Record<string, unknown> }); },
    });
    const events = lines;
    await runner.start({ slug: 'demo', root: allowed.root, autonomy: 'keep-going' });
    await runner.wait();
    const state = runner.current()!;
    assert.equal(state.phases['1'].status, 'done');
    assert.match(state.phases['1'].verification?.reason ?? '', /1 manual check\(s\) waived by policy \(Person-check: allow, from the plan\)/);
    const waived = events.find((e) => e.event === 'phase.verify-waived')!;
    assert.deepEqual([waived.data.stage, waived.data.by, waived.data.decisionKey, waived.data.source], ['verify', 'policy', 'verification.person-check', 'plan']);
    assert.ok(!events.some((e) => e.event === 'phase.awaiting-verification'), 'no card was raised');
    assert.equal(events.find((e) => e.event === 'phase.policy-answered')?.data.answer, 'allow');
  } finally { allowed.cleanup(); }

  const owned = harness();
  const { approvals, first } = watchedApprovals();
  try {
    const lines: { event: string; data: Record<string, unknown> }[] = [];
    const runner = new Runner({
      scriptsDir: owned.scriptsDir, spawn: happySpawn, verify: async () => NOTHING_RAN,
      verificationText: () => 'run those commands.', approvals, origin: 'http://127.0.0.1:4123',
      personCheck: () => 'dev-lead',
      onEvent: (event, data) => { if (event === 'run:journal') lines.push(data as { event: string; data: Record<string, unknown> }); },
    });
    const events = lines;
    void runner.start({ slug: 'demo', root: owned.root, autonomy: 'keep-going' });
    await first;
    const [card] = approvals.pending();
    assert.match(card.title, /only you can make \(Person-check: dev-lead\)/);
    // The answerer's own word rides the decision — the route hands the broker the
    // request's actor (`operator`, a login, a name), and `console` never.
    approvals.settle(card.id, 'allow', 'dev-lead', 'looked at it');
    await runner.wait();
    const verified = events.find((e) => e.event === 'phase.human-verified')!;
    assert.equal(verified.data.by, 'dev-lead');
    assert.notEqual(verified.data.by, 'console');
    assert.match(runner.current()!.phases['1'].verification?.reason ?? '', /confirmed by dev-lead/);
  } finally { owned.cleanup(); }
});

test('with no way to ask, it halts saying exactly that', async () => {
  const h = harness();
  try {
    // No approvals broker: the honest outcome is to stop and say why, not to
    // wait forever on a question nobody can be shown.
    const runner = makeRunner(h, NOTHING_RAN, undefined);
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();

    assert.equal(state.status, 'parked');
    assert.match(state.phases['1'].halt?.reason ?? '', /no way to ask/);
  } finally { h.cleanup(); }
});
