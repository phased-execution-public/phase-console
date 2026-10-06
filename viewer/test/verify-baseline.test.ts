/**
 * §Verification tells a red from an inherited one (control-tower phase 83, #103).
 *
 * control-tower P45's node batch failed with 8 reds and every one of them came
 * from OTHER phases' unfinished work on the shared `pe/control-tower` branch —
 * the same 8 failed at the commit before P45's last one. The console put P45
 * on attempt 2 while the three phases that owned the reds sat queued behind
 * P45's grant, so a re-attempt could not fix what it was being failed for.
 *
 * VB-1  a red already present in the phase's baseline is INHERITED: recorded
 *       with the phase that owns it, never charged, and the phase settles
 * VB-2  a red absent from the baseline is the phase's own and fails it as before
 * VB-3  the baseline is taken at boarding — reusing the last run of each line
 *       on the base tree when there is one, measuring it when there is not
 *
 * The fifth amendment (#103's 2026-09-25 comments):
 * VB-5  a red whose introducing change is a sibling's UNCOMMITTED WIP in the
 *       shared tree is that sibling's — inherited, owned by the phase whose
 *       session wrote those paths, the dirty paths named — never the
 *       verifying phase's (P61's red from P62's 17 uncommitted files)
 * VB-6  a red ABSENT from the baseline is attributed by its introducing commit
 *       when a sibling's commit landed between this phase's attempts, and an
 *       inherited red is recorded as OWED on its owner's record
 * VB-7  a chained gate's sub-checks are attributed one by one — each `&&`
 *       member run alone — so a red the first member hid has its own owner
 * (the failure identities and the owner rule are pinned beside them)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { chainMembers, failureIds, foldCommand, verifyEnvDigest, type VerifyOptions } from '../server/runner/verify.ts';
import {
  newRun, phaseRecord, saveRun, streakPhases, type PhaseRecord, type RunState, type VerifyRun, type VerifySummary,
} from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { proofsFile } from '../server/runner/proofs.ts';
import { workingTreeOf } from '../server/runner/worktree.ts';
import {
  appendLedger, ownerByCommits, ownerFromLedger, readLedger, splitReds, verificationsFile, type LedgerRow,
} from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const TEST = 'npm test';
const A = 'suite › test A';
const B = 'suite › test B';

/* ------------------------------------------------------------------ *
 * The harness — a git repository, one phase, done once its marker exists
 * ------------------------------------------------------------------ */

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void };

function harness(phases: number[]): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-vb-'));
  TRASH.push(root);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
  // The console's own scaffolding is not the tree under test.
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
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
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(scriptsDir, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
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

/** A command's two red attempts with these failing tests — what the real verifier writes. */
function redRows(failures: string[], command = TEST): VerifyRun[] {
  const run = (retry: boolean): VerifyRun => ({
    command, ok: false, code: 1, ms: 5, output: failures.map((f, i) => `not ok ${i + 1} - ${f}`).join('\n'),
    failures, ...(retry ? { retry: true } : {}),
  });
  return [run(false), run(true)];
}
function redWith(failures: string[], command = TEST): VerifySummary {
  return { ok: false, reason: `\`${command}\` exited 1`, notRun: [], ran: redRows(failures, command) };
}
/** Several commands at once: a red (its failing tests) or a green (null). */
function runOf(lines: [string, string[] | null][]): VerifySummary {
  const ran = lines.flatMap(([command, failures]): VerifyRun[] =>
    (failures ? redRows(failures, command) : [{ command, ok: true, code: 0, ms: 5, output: '' }]));
  const ok = lines.every(([, failures]) => !failures);
  return { ok, reason: ok ? `${lines.length} command(s) green` : 'a command exited 1', notRun: [], ran };
}

/** git in the harness, as a person would commit — optionally at a given moment. */
function gitIn(root: string, args: string[], at?: string): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}) },
  }).trim();
}

/** Phase 2's one session, the day before — when a sibling's WIP was written, or its commit made. */
const SIBLING_WINDOW = { attempt: 1, startedAt: '2026-09-25T06:00:00.000Z', endedAt: '2026-09-25T06:55:00.000Z' };
const IN_SIBLING_WINDOW = '2026-09-25T06:30:00.000Z';

/**
 * A stored run in which phase 2 — done on the board — already had its session,
 * in `SIBLING_WINDOW`; phase 1 is still to board (or to board again).
 */
function withSibling(h: Harness, phase1?: (record: PhaseRecord) => void): RunState {
  h.done(2);
  const stored = newRun({ slug: 'demo', root: h.root });
  stored.status = 'paused';
  stored.stoppedBy = 'operator';
  const sibling = phaseRecord(stored, 2);
  sibling.status = 'done';
  sibling.attempts = 1;
  sibling.attemptWindows = [{ ...SIBLING_WINDOW }];
  const record = phaseRecord(stored, 1);
  record.status = 'pending';
  phase1?.(record);
  saveRun(stored);
  return stored;
}

/**
 * A superproject: its `.gitmodules` committed with the base. Since control-tower
 * phase 89 a tree holding a sibling's WIP is verified on a clean checkout of the
 * phase's HEAD (`verify-export.test.ts`), where that WIP is simply absent; a
 * superproject is the case a checkout is refused (it would hold none of its
 * submodules), so the verdict runs in place and the WIP attribution below is
 * what keeps a sibling's red off the verifying phase.
 */
function refuseExport(h: Harness): void {
  writeFileSync(join(h.root, '.gitmodules'), '');
  gitIn(h.root, ['add', '.gitmodules']);
  gitIn(h.root, ['commit', '-q', '-m', 'a superproject']);
}

/** A sibling's uncommitted file, written in its session's window. */
function siblingWip(h: Harness, name = 'wip.txt'): void {
  const file = join(h.root, name);
  writeFileSync(file, 'a sibling\'s half-done work\n');
  const at = new Date(IN_SIBLING_WINDOW);
  utimesSync(file, at, at);
}

/**
 * A session that commits its own work and — like P61's — proves its line green
 * on a clean export of its own commit (a proof at `HEAD^{tree}`).
 */
function committingSession(h: Harness, opts: { prove?: boolean; after?: () => void } = {}) {
  return async (req: SpawnReq) => {
    const phase = phaseOf(req);
    writeFileSync(join(h.root, 'src.txt'), `the work of phase ${phase}\n`);
    gitIn(h.root, ['add', 'src.txt']);
    gitIn(h.root, ['commit', '-q', '-m', `phase ${phase}`]);
    if (opts.prove) {
      const file = proofsFile(h.root, 'demo');
      mkdirSync(dirname(file), { recursive: true });
      const tree = gitIn(h.root, ['rev-parse', 'HEAD^{tree}']);
      appendFileSync(file, `${JSON.stringify({ type: 'proof', slug: 'demo', phase, command: TEST, code: 0, tree, at: new Date().toISOString() })}\n`);
    }
    opts.after?.();
    h.done(phase);
    return success(`sid-${phase}`);
  };
}

/** A runner with the baseline on, a session of the test's making, and a verifier answering per purpose. */
function runnerWith(
  h: Harness, spawn: (req: SpawnReq) => Promise<unknown>,
  answer: (purpose: string, text: string) => VerifySummary, text = `\`${TEST}\``,
) {
  const calls: string[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn,
    verify: async (verifyText: string, opts: VerifyOptions) => {
      calls.push(opts.purpose ?? 'verify');
      return answer(opts.purpose ?? 'verify', verifyText);
    },
    verificationText: () => text,
  } as never);
  return { runner, calls };
}
const greenRun = (): VerifySummary => ({
  ok: true, reason: '1 command green', notRun: [], ran: [{ command: TEST, ok: true, code: 0, ms: 5, output: '' }],
});

const ledgerRow = (fields: Partial<LedgerRow>): LedgerRow => ({
  type: 'verification', slug: 'demo', phase: 7, run: 'earlier', at: '2026-09-24T10:00:00.000Z', kind: 'verify',
  command: foldCommand(TEST), code: 0, ms: 5, ok: true, ...fields,
});

/**
 * A runner with the baseline on, whose verifier answers `baseline` when asked
 * at boarding and `final` at the phase's end; `calls` records the order.
 */
function runnerFor(h: Harness, answers: { baseline?: VerifySummary; final: VerifySummary }) {
  const calls: string[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async (req: SpawnReq) => {
      calls.push('session');
      writeFileSync(join(h.root, 'src.txt'), 'the work, changed by the session\n');
      h.done(phaseOf(req));
      return success('sid-1');
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      calls.push(opts.purpose ?? 'verify');
      if (opts.purpose === 'baseline') {
        assert.ok(answers.baseline, 'the baseline was measured, but this test expected it reused');
        return answers.baseline;
      }
      return answers.final;
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  return { runner, calls };
}

/* ------------------------------------------------------------------ *
 * VB-3 — the baseline, at boarding
 * ------------------------------------------------------------------ */

test('VB-3: a line already run on the base tree is reused as the baseline — nothing runs at boarding', async () => {
  const h = harness([1]);
  const base = await workingTreeOf(h.root);
  assert.ok(base, 'the harness is a repository');
  // As the console writes a row since control-tower phase 105 (BL-2): the
  // environment digest and the directory are half of what makes it reusable.
  appendLedger(verificationsFile(h.root, 'demo'), [ledgerRow({
    tree: base!.tree, head: base!.head, env: verifyEnvDigest({}), dir: '', at: new Date().toISOString(),
  })]);
  const { runner, calls } = runnerFor(h, { final: greenRun() });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.deepEqual(calls, ['session', 'verify'], 'no baseline command ran: the run on the base tree stood in');
  const baseline = state.phases['1'].baseline;
  assert.equal(baseline?.tree, base!.tree);
  assert.deepEqual(baseline?.commands.map((entry) => [entry.command, entry.from, entry.ok]), [[TEST, 'reused', true]]);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.verify-baseline');
  assert.ok(line, 'the baseline is journalled');
  assert.equal(line!.data.reused, 1);
  assert.equal(line!.data.measured, 0);
  assert.equal(state.phases['1'].status, 'done');
});

test('VB-3: with nothing to reuse the baseline is MEASURED on the tree the phase boarded on — never the session\'s edits — and ledgered', async () => {
  const h = harness([1]);
  const boarded = await workingTreeOf(h.root);
  const { runner, calls } = runnerFor(h, { baseline: greenRun(), final: greenRun() });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  // Since control-tower phase 105 (BL-3) it runs BESIDE the session, in a clean
  // checkout of the boarding head, and the verdict waits for it.
  assert.deepEqual([...calls].sort(), ['baseline', 'session', 'verify']);
  assert.ok(calls.indexOf('baseline') < calls.indexOf('verify'), 'the baseline was in before the verdict');
  assert.equal(state.phases['1'].baseline?.tree, boarded!.tree, 'the boarding tree, though the session changed src.txt');
  assert.deepEqual(state.phases['1'].baseline?.commands.map((entry) => entry.from), ['measured']);
  const kinds = readLedger(verificationsFile(h.root, 'demo'), 'demo').map((entry) => [entry.phase, entry.kind]);
  assert.deepEqual(kinds, [[1, 'baseline'], [1, 'verify']], 'the measured baseline is a run of the line like any other');
});

test('VB-3: a phase boarded again keeps its FIRST baseline — its own work is never its baseline', async () => {
  const h = harness([1]);
  // A stored run whose phase 1 already boarded once, took its baseline, and
  // stopped part-way: the tree now holds that attempt's work.
  const stored = newRun({ slug: 'demo', root: h.root });
  stored.status = 'paused';
  stored.stoppedBy = 'operator';
  const record = phaseRecord(stored, 1);
  record.status = 'pending';
  record.attempts = 1;
  record.baseline = {
    at: '2026-09-26T08:00:00.000Z', tree: 'e'.repeat(40), head: null,
    commands: [{ command: TEST, ok: true, code: 0, from: 'measured' }],
  };
  saveRun(stored);
  writeFileSync(join(h.root, 'src.txt'), 'the first attempt\'s half-done work\n');
  const { runner, calls } = runnerFor(h, { final: greenRun() });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();
  assert.deepEqual(calls, ['session', 'verify'], 'no second baseline over the phase\'s own half-done work');
  assert.equal(state.phases['1'].baseline?.tree, 'e'.repeat(40), 'the first boarding\'s baseline stands');
  assert.equal(state.phases['1'].status, 'done');
});

/* ------------------------------------------------------------------ *
 * VB-1 — a red present in the baseline is inherited
 * ------------------------------------------------------------------ */

test('VB-1: a red already in the baseline is inherited — recorded with its owner, never charged, and the phase settles', async () => {
  const h = harness([1]);
  // Phase 7 was charged with test A when it introduced it: A is phase 7's.
  appendLedger(verificationsFile(h.root, 'demo'), [
    ledgerRow({ tree: 'f'.repeat(40), code: 1, ok: false, failures: [A], own: [A] }),
  ]);
  const { runner, calls } = runnerFor(h, { baseline: redWith([A]), final: redWith([A]) });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.deepEqual(calls, ['baseline', 'session', 'verify']);
  const record = state.phases['1'];
  assert.equal(record.status, 'done', `the phase settles on its own work (${record.note ?? ''})`);
  assert.equal(record.reopened, undefined, 'nothing to re-open: the red is not this phase\'s');
  assert.deepEqual(streakPhases(state), [], 'and nothing is charged');
  assert.deepEqual(record.verification?.inherited, [{ command: TEST, failures: [A], owner: 7, how: 'charged' }]);
  assert.match(record.note ?? '', /inherited/);
  const lines = journal(h.root, state);
  const inherited = lines.find((line) => line.event === 'phase.verify-inherited');
  assert.ok(inherited, 'journalled');
  assert.deepEqual(inherited!.data.inherited, [{ command: TEST, failures: [A], owner: 7, how: 'charged' }]);
  assert.equal(lines.some((line) => line.event === 'run.failure-charged'), false);
  assert.equal(lines.some((line) => line.event === 'phase.verification-failed'), false);
  // The ledger says so too, so the owner rule reads it next time.
  const last = readLedger(verificationsFile(h.root, 'demo'), 'demo').at(-1)!;
  assert.deepEqual([last.phase, last.kind, last.failures, last.own], [1, 'verify', [A], []]);
});

/* ------------------------------------------------------------------ *
 * VB-2 — a red absent from the baseline is the phase's own
 * ------------------------------------------------------------------ */

test('VB-2: a red absent from the baseline is the phase\'s own — it re-opens the phase and is charged', async () => {
  const h = harness([1]);
  const { runner } = runnerFor(h, { baseline: greenRun(), final: redWith([B]) });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  const record = state.phases['1'];
  assert.ok(record.reopened, 'a red over a complete handoff re-opens, as it did before');
  assert.deepEqual(record.reopened!.failed, [TEST]);
  assert.deepEqual(streakPhases(state), [1], 'and is charged to the phase');
  const last = readLedger(verificationsFile(h.root, 'demo'), 'demo').at(-1)!;
  assert.deepEqual(last.own, [B], 'the ledger records B as this phase\'s — the owner rule reads it next time');
});

test('VB-2: an own red beside inherited ones in the same command fails the phase, and the record says which is which', async () => {
  const h = harness([1]);
  const { runner } = runnerFor(h, { baseline: redWith([A]), final: redWith([A, B]) });
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.ok(state.phases['1'].reopened, 'B is new: the phase is not done');
  assert.deepEqual(streakPhases(state), [1]);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.verify-inherited');
  assert.ok(line, 'the split is journalled even when the phase fails');
  assert.deepEqual(line!.data.own, [{ command: TEST, failures: [B] }]);
  assert.deepEqual((line!.data.inherited as { failures: string[] }[]).map((entry) => entry.failures), [[A]]);
});

/* ------------------------------------------------------------------ *
 * VB-5 — a red a sibling's uncommitted WIP introduced is the sibling's
 * ------------------------------------------------------------------ */

test('VB-5: a red in the baseline that a sibling\'s UNCOMMITTED WIP introduced is the sibling\'s — owned by who wrote it, the dirty paths named', async () => {
  const h = harness([1, 2]);
  refuseExport(h);
  // Phase 2 left wip.txt in the shared tree — written in its session, never
  // committed — before phase 1 boarded: the baseline is red with it.
  siblingWip(h);
  const stored = withSibling(h);
  const { runner } = runnerWith(h, committingSession(h, { prove: true }), () => redWith([A]));
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();

  const record = state.phases['1'];
  assert.equal(record.status, 'done', `the phase settles on its own work (${record.note ?? ''})`);
  assert.deepEqual(streakPhases(state), [], 'nothing is charged to the verifying phase');
  // Green on a clean export of its own commit, red in the shared tree: the
  // only difference is wip.txt, and phase 2's session wrote it.
  assert.deepEqual(record.verification?.inherited, [{ command: TEST, failures: [A], owner: 2, how: 'wip', paths: ['wip.txt'] }]);
  assert.match(record.note ?? '', /owned by phase 2/);
  assert.deepEqual(state.phases['2'].owed?.map((red) => [red.command, red.failures, red.by, red.how, red.paths]),
    [[TEST, [A], 1, 'wip', ['wip.txt']]], 'and the sibling OWES it');
  assert.ok(journal(h.root, state).some((entry) => entry.event === 'phase.verify-in-place'),
    'the clean checkout was refused — a superproject — and the verdict says it ran in place');
});

test('VB-5: a red ABSENT from the baseline that a sibling\'s WIP brought in after the boarding is never the verifying phase\'s', async () => {
  const h = harness([1, 2]);
  refuseExport(h);
  const stored = withSibling(h);
  const { runner } = runnerWith(h, committingSession(h, {
    prove: true,
    // Between phase 1's boarding and its verification, phase 2's WIP reached the tree.
    after: () => siblingWip(h),
  }), (purpose) => (purpose === 'baseline' ? greenRun() : redWith([B])));
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();

  const record = state.phases['1'];
  assert.equal(record.status, 'done', `not re-opened for a red that is not its own (${record.note ?? ''})`);
  assert.equal(record.reopened, undefined);
  assert.deepEqual(streakPhases(state), []);
  assert.deepEqual(record.verification?.inherited, [{ command: TEST, failures: [B], owner: 2, how: 'wip', paths: ['wip.txt'] }]);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.verify-inherited');
  assert.deepEqual(line?.data.own, [], 'nothing is left the phase\'s own');
});

/* ------------------------------------------------------------------ *
 * VB-6 — a red absent from the baseline is attributed by its commit
 * ------------------------------------------------------------------ */

/**
 * Phase 1's FIRST attempt boarded on the base commit (its baseline green,
 * ledgered) and stopped; phase 2 then committed lib.txt in its session; phase
 * 1 boards again. `commits` says whether its second session commits as well.
 */
async function secondAttempt(commits: boolean) {
  const h = harness([1, 2]);
  const base = await workingTreeOf(h.root);
  assert.ok(base);
  appendLedger(verificationsFile(h.root, 'demo'), [
    ledgerRow({ phase: 1, kind: 'baseline', run: 'this', tree: base!.tree, head: base!.head }),
  ]);
  writeFileSync(join(h.root, 'lib.txt'), 'the sibling\'s change\n');
  gitIn(h.root, ['add', 'lib.txt']);
  gitIn(h.root, ['commit', '-q', '-m', 'phase 2'], IN_SIBLING_WINDOW);
  const stored = withSibling(h, (record) => {
    record.attempts = 1;
    record.attemptWindows = [{ attempt: 1, startedAt: '2026-09-25T05:00:00.000Z', endedAt: '2026-09-25T05:40:00.000Z' }];
    record.baseline = {
      at: '2026-09-25T05:00:00.000Z', tree: base!.tree, head: base!.head,
      commands: [{ command: TEST, ok: true, code: 0, from: 'measured' }],
    };
  });
  const spawn = commits
    ? committingSession(h)
    // It only writes its handoff: nothing of its own reaches the tree.
    : async (req: SpawnReq) => { h.done(phaseOf(req)); return success('sid-1'); };
  const { runner, calls } = runnerWith(h, spawn, () => redWith([B]));
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();
  return { h, state, calls };
}

test('VB-6: a red absent from the baseline is attributed by its introducing commit — a sibling\'s, landed between this phase\'s attempts — and OWED on its record', async () => {
  const { h, state, calls } = await secondAttempt(false);
  assert.deepEqual(calls, ['verify'], 'the first boarding\'s baseline stands; no second one');
  const record = state.phases['1'];
  assert.equal(record.status, 'done', `B is phase 2's: the phase settles (${record.note ?? ''})`);
  assert.equal(record.reopened, undefined);
  assert.deepEqual(streakPhases(state), [], 'and nothing is charged here');
  assert.deepEqual(record.verification?.inherited, [{ command: TEST, failures: [B], owner: 2, how: 'commit' }]);
  assert.deepEqual(state.phases['2'].owed?.map((red) => [red.command, red.failures, red.by, red.how]),
    [[TEST, [B], 1, 'commit']], 'the owner\'s record says what it owes');
  const owed = journal(h.root, state).find((entry) => entry.event === 'phase.verify-owed');
  assert.ok(owed, 'journalled against the owner');
  assert.equal(owed!.phase, 2);
  assert.equal(owed!.data.by, 1);
});

test('VB-6: when the phase itself also committed in that range, the owner cannot be told — the red stays its own', async () => {
  const { state } = await secondAttempt(true);
  const record = state.phases['1'];
  assert.ok(record.reopened, 'its own commit may be the one: it is re-opened, as before');
  assert.deepEqual(streakPhases(state), [1]);
  assert.equal(state.phases['2'].owed, undefined, 'and nothing is owed on a guess');
});

/* ------------------------------------------------------------------ *
 * VB-7 — a chained gate's sub-checks, one by one
 * ------------------------------------------------------------------ */

const FIRST = 'npm run a';
const SECOND = 'npm run b';
const CHAIN = `${FIRST} && ${SECOND}`;

test('VB-7: a red && chain is attributed member by member — each run alone — so the red its first member hid has its own verdict', async () => {
  const h = harness([1]);
  // Phase 7 was charged with A on the chain's first member.
  appendLedger(verificationsFile(h.root, 'demo'), [
    ledgerRow({ command: foldCommand(FIRST), code: 1, ok: false, failures: [A], own: [A], tree: 'f'.repeat(40) }),
  ]);
  const texts: [string, string][] = [];
  const { runner } = runnerWith(h, async (req) => { h.done(phaseOf(req)); return success('sid-1'); }, (purpose, text) => {
    texts.push([purpose, text]);
    // The chain stops at its first red member, so the second never runs in it.
    if (text.includes('&&')) return redWith([A], CHAIN);
    // Alone: the first is red with phase 7's A at boarding and now; the
    // second was green at boarding and is red with B now.
    return runOf([[FIRST, [A]], [SECOND, purpose === 'baseline' ? null : [B]]]);
  }, `\`${CHAIN}\``);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.deepEqual(texts.map(([purpose, text]) => [purpose, text.includes('&&')]), [
    ['baseline', true], ['baseline', false], ['verify', true], ['attribution', false],
  ], 'a red chain is broken into its members at boarding and at verification');
  const record = state.phases['1'];
  assert.ok(record.reopened, 'B is new: the phase is not done — the chain\'s inherited first red no longer hides it');
  assert.deepEqual(streakPhases(state), [1]);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.verify-inherited');
  assert.ok(line);
  assert.deepEqual(line!.data.inherited, [{ command: FIRST, chain: CHAIN, failures: [A], owner: 7, how: 'charged' }]);
  assert.deepEqual(line!.data.own, [{ command: SECOND, chain: CHAIN, failures: [B] }]);
  // Each member is a line of the ledger in its own right, named with its chain.
  const members = readLedger(verificationsFile(h.root, 'demo'), 'demo').filter((row) => row.phase === 1 && row.chain);
  assert.deepEqual(members.map((row) => [row.kind, row.command, row.ok, row.own ?? null]), [
    ['baseline', FIRST, false, null], ['baseline', SECOND, true, null],
    ['verify', FIRST, false, []], ['verify', SECOND, false, [B]],
  ]);
});

/* ------------------------------------------------------------------ *
 * The pieces: failure identities, the split, the owner by commit
 * ------------------------------------------------------------------ */

test('chain members: top-level && only, quotes respected, a cd or export carried into every member after it', () => {
  assert.deepEqual(chainMembers(CHAIN), [FIRST, SECOND]);
  assert.deepEqual(chainMembers('cd viewer && npm test && npm run lint'), ['cd viewer && npm test', 'cd viewer && npm run lint']);
  assert.deepEqual(chainMembers('export CI=1 && npm test && node ratchet.mjs'), ['export CI=1 && npm test', 'export CI=1 && node ratchet.mjs']);
  assert.deepEqual(chainMembers('bash -c "a && b" && npm test'), ['bash -c "a && b"', 'npm test']);
  assert.deepEqual(chainMembers('npm test || true && npm run lint'), ['npm test || true', 'npm run lint']);
  assert.equal(chainMembers('npm test'), null, 'one member is not a chain');
  assert.equal(chainMembers('cd viewer && npm test'), null, 'one check behind a cd is not a chain either');
  assert.equal(chainMembers('echo "unbalanced && npm test'), null);
});

test('the charged owner: a later clean run of the line retires an old charge', () => {
  const rows = [
    ledgerRow({ phase: 7, code: 1, ok: false, failures: [A], own: [A], at: '2026-09-24T10:00:00.000Z' }),
    ledgerRow({ phase: 9, kind: 'baseline', code: 1, ok: false, failures: [A], at: '2026-09-24T11:00:00.000Z' }),
  ];
  assert.equal(ownerFromLedger(rows, TEST, A, 1), 7, 'still red since: phase 7 owns it');
  const fixed = [...rows, ledgerRow({ phase: 9, ok: true, at: '2026-09-24T12:00:00.000Z' })];
  assert.equal(ownerFromLedger(fixed, TEST, A, 1), undefined, 'green since: a red now is a new one, not phase 7\'s');
});

test('failure identities: node\'s spec reporter, TAP from node and from bats — each failing test once, TODOs not', () => {
  const spec = [
    '✔ alpha passes (0.1ms)',
    '✖ beta fails (0.05ms)',
    '▶ group',
    '  ✖ inner fails (0.05ms)',
    '✖ group (0.17ms)',
    'ℹ tests 4',
    '✖ failing tests:',
    '',
    'test at a.test.mjs:3:1',
    '✖ beta fails (0.05ms)',
    '  Error: boom',
  ].join('\n');
  assert.deepEqual(failureIds(spec), ['beta fails', 'inner fails', 'group']);
  const tap = [
    '# Subtest: beta fails', 'not ok 2 - beta fails', '    not ok 1 - inner fails', 'not ok 3 - group',
    'not ok 4 - pending thing # TODO later', 'ok 5 - fine',
  ].join('\n');
  assert.deepEqual(failureIds(tap), ['beta fails', 'inner fails', 'group']);
  const bats = ['1..3', 'ok 1 bats one passes', 'not ok 2 bats two fails', '# (in test file t.bats, line 2)'].join('\n');
  assert.deepEqual(failureIds(bats), ['bats two fails']);
  assert.deepEqual(failureIds('Error: cannot find module\n'), [], 'a crash names no test');
});

test('the split: set difference per command, command-level when either side names no test', () => {
  const baseline = [
    { command: TEST, ok: false, code: 1, failures: [A] },
    { command: 'bash tests/run-tests.sh', ok: false, code: 2 },
    { command: 'npm run lint', ok: true, code: 0 },
  ];
  const run = (command: string, failures?: string[]): VerifyRun => ({ command, ok: false, code: 1, ms: 1, output: '', ...(failures ? { failures } : {}) });
  const split = splitReds([run(TEST, [A, B]), run('bash tests/run-tests.sh', ['x']), run('npm run lint', ['y']), run('npm run build')], baseline);
  assert.deepEqual(split.own.map((entry) => [entry.command, entry.failures]), [
    [TEST, [B]], ['npm run lint', ['y']], ['npm run build', []],
  ]);
  assert.deepEqual(split.inherited.map((entry) => [entry.command, entry.failures]), [
    [TEST, [A]], ['bash tests/run-tests.sh', ['x']],
  ]);
});

test('the owner by commit: the one phase whose session windows hold the commits between the last green and the base', () => {
  const windows = [
    { phase: 46, startedAt: '2026-09-24T10:00:00.000Z', endedAt: '2026-09-24T11:00:00.000Z' },
    { phase: 53, startedAt: '2026-09-24T12:00:00.000Z', endedAt: '2026-09-24T13:00:00.000Z' },
    { phase: 45, startedAt: '2026-09-24T14:00:00.000Z' },
  ];
  const at = (iso: string) => ({ sha: iso.slice(11, 19), at: iso });
  assert.deepEqual(ownerByCommits([at('2026-09-24T10:30:00.000Z')], windows, 45), { owner: 46 });
  assert.deepEqual(ownerByCommits([at('2026-09-24T10:30:00.000Z'), at('2026-09-24T12:30:00.000Z')], windows, 45),
    { candidates: [46, 53] }, 'two phases committed in the range: both are named, neither is guessed');
  assert.deepEqual(ownerByCommits([at('2026-09-24T09:00:00.000Z')], windows, 45), {}, 'a commit no session made has no owner here');
  assert.deepEqual(ownerByCommits([at('2026-09-24T14:30:00.000Z')], windows, 45), {}, 'the phase itself is never its own inheritance');
});
