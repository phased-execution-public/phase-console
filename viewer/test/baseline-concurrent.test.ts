/**
 * The session boards at once; the baseline runs beside it (control-tower
 * phase 105, #190 ask 2).
 *
 * The baseline ran every §Verification line BEFORE the session could start,
 * holding the lane with no session in it: on ai-builder-v7 P15 waited 27.4 min
 * and P3 24.5 min between `phase.admitted` and their first `phase.start`. A
 * serial plan paid that once per phase — hours in which nothing worked.
 *
 * BL-3  the session boards at once; the baseline runs beside it in a clean
 *       checkout of the boarding head (`exportForVerify`), niced, under the
 *       machine-load guard; its result reaches the session as a next-turn note;
 *       the verdict compares against it exactly as before, and a baseline still
 *       running when the session ends is awaited before the verdict — never
 *       dropped. A repository git will not export (a superproject) is measured
 *       before boarding, as it always was.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { verifyPhase, type VerifyOptions } from '../server/runner/verify.ts';
import type { RunState, VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { BASELINE_NICE } from '../server/runner/verify-ledger.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const TEST = 'npm test';
const A = 'suite › test A';

type Harness = { root: string; scriptsDir: string };

function harness(opts: { superproject?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pc-bl3-'));
  TRASH.push(root);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
  if (opts.superproject) writeFileSync(join(root, '.gitmodules'), '');
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

const gitOut = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const green = (): VerifySummary => ({
  ok: true, reason: '1 command green', notRun: [], ran: [{ command: TEST, ok: true, code: 0, ms: 5, output: '' }],
});
const redA = (): VerifySummary => ({
  ok: false, reason: `\`${TEST}\` exited 1`, notRun: [],
  ran: [{ command: TEST, ok: false, code: 1, ms: 5, output: `not ok 1 - ${A}`, failures: [A] }],
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type SpawnReq = { onHandle?: (handle: { pid?: number; send(text: string): boolean; open(): boolean; setFrozen(frozen: boolean): void }) => void };
const success = () => ({
  signal: { subtype: 'success' as const, code: 0, text: 'done' },
  sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
});

test('BL-3: the session boards while the baseline runs — in a clean checkout of the boarding head, which then goes', async () => {
  const h = harness();
  const boardingTree = gitOut(h.root, 'rev-parse', 'HEAD^{tree}');
  const boardingHead = gitOut(h.root, 'rev-parse', 'HEAD');
  const order: string[] = [];
  const sessionIn = deferred();
  let baselineCwd = '';
  let headInExport = '';
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async () => {
      order.push('session');
      sessionIn.resolve();
      // The session's own edit — which the baseline must never read.
      writeFileSync(join(h.root, 'src.txt'), 'the work, changed by the session\n');
      writeFileSync(join(h.root, '.done-1'), '');
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      if (opts.purpose !== 'baseline') { order.push('verify'); return green(); }
      order.push('baseline-start');
      baselineCwd = opts.cwd;
      headInExport = gitOut(opts.cwd, 'rev-parse', 'HEAD');
      await sessionIn.promise;
      order.push('baseline-end');
      return green();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.ok(order.indexOf('session') < order.indexOf('baseline-end'), `the session boarded before the baseline ended: ${order.join(' → ')}`);
  assert.ok(order.indexOf('baseline-end') < order.indexOf('verify'), 'the verdict came after the baseline');
  assert.notEqual(baselineCwd, h.root, 'the baseline ran in a checkout of its own, not the session\'s tree');
  assert.equal(headInExport, boardingHead, 'a checkout of the boarding head');
  assert.equal(existsSync(baselineCwd), false, 'the checkout is removed once the baseline is in');
  assert.equal(state.phases['1']!.baseline?.tree, boardingTree, 'the baseline describes the tree the phase boarded on');
  assert.equal(state.phases['1']!.status, 'done');
  const entry = journal(h.root, state).find((row) => row.event === 'phase.verify-baseline');
  assert.equal(entry?.data.concurrent, true, 'journalled as run beside the session');
});

test('BL-3: the baseline\'s result reaches the live session as a next-turn note — information, never an instruction', async () => {
  const h = harness();
  const sent: string[] = [];
  const baselineIn = deferred();
  const handleIn = deferred();
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async (req: SpawnReq) => {
      req.onHandle?.({ pid: undefined, open: () => true, send: (text) => { sent.push(text); baselineIn.resolve(); return true; }, setFrozen: () => {} });
      handleIn.resolve();
      await Promise.race([baselineIn.promise, new Promise((done) => setTimeout(done, 5_000))]);
      writeFileSync(join(h.root, '.done-1'), '');
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      // Measured while the session works: it lands on a session that can hear it.
      if (opts.purpose === 'baseline') await handleIn.promise;
      return redA();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.equal(sent.length, 1, 'one note');
  const note = sent[0]!;
  assert.match(note, /^\[\[baseline:[0-9a-f]+\]\]/, 'tagged like every console message');
  assert.match(note, /not an instruction/i);
  assert.match(note, /npm test/);
  assert.match(note, /red once \(not retried\)/);
  assert.match(note, new RegExp(A));
  const entry = journal(h.root, state).find((row) => row.event === 'phase.verify-baseline');
  assert.equal(entry?.data.told, true, 'the journal says the session was told');
  // …and the verdict compared against it, exactly as before: the red was there first.
  assert.equal(state.phases['1']!.status, 'done');
  assert.equal(state.phases['1']!.verification?.inherited?.length, 1, 'the red is inherited, never charged');
});

test('BL-3: a baseline that lands before the session can hear it is told the moment it can — never lost', async () => {
  const h = harness();
  const sent: string[] = [];
  const told = deferred();
  const baselineDone = deferred();
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async (req: SpawnReq) => {
      await baselineDone.promise;
      req.onHandle?.({ pid: undefined, open: () => true, send: (text) => { sent.push(text); told.resolve(); return true; }, setFrozen: () => {} });
      await Promise.race([told.promise, new Promise((done) => setTimeout(done, 5_000))]);
      writeFileSync(join(h.root, '.done-1'), '');
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      if (opts.purpose === 'baseline') setTimeout(() => baselineDone.resolve(), 50);
      return green();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.equal(sent.length, 1, 'held, then delivered on the session\'s first handle');
  assert.match(sent[0]!, /All 1 line\(s\) were green/);
  const entry = journal(h.root, state).find((row) => row.event === 'phase.verify-baseline');
  assert.equal(entry?.data.told, 'queued');
});

test('BL-3: a baseline still running when the session ends is AWAITED before the verdict — never dropped', async () => {
  const h = harness();
  const order: string[] = [];
  const sessionOver = deferred();
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async () => {
      order.push('session');
      writeFileSync(join(h.root, '.done-1'), '');
      sessionOver.resolve();
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      if (opts.purpose !== 'baseline') { order.push('verify'); return redA(); }
      await sessionOver.promise;
      // Still measuring well after the session has gone.
      await new Promise((done) => setTimeout(done, 300));
      order.push('baseline-end');
      return redA();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.deepEqual(order, ['session', 'baseline-end', 'verify'], 'the verdict waited for the baseline');
  const record = state.phases['1']!;
  assert.ok(record.baseline, 'the baseline was kept, not dropped');
  assert.equal(record.status, 'done', 'compared against the awaited baseline: the red was inherited');
  assert.ok(journal(h.root, state).some((row) => row.event === 'phase.verify' || row.event === 'phase.done'));
});

test('BL-3: the baseline runs niced and under the machine-load guard', async () => {
  const h = harness();
  let firstAsk: number | null = null;
  const seen: { nice?: number; waitedMs?: number } = {};
  const measured = deferred();
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    // Loaded for the first quarter second after the guard is first asked.
    machineLoad: () => {
      firstAsk ??= Date.now();
      return { holding: Date.now() - firstAsk < 250, reason: 'the machine is loaded' };
    },
    baselineLoadPollMs: 20,
    spawn: async () => {
      // A session still working: once the verdict waits on the baseline, the
      // guard stops holding it — so this one outlives the wait.
      await Promise.race([measured.promise, new Promise((done) => setTimeout(done, 5_000))]);
      writeFileSync(join(h.root, '.done-1'), '');
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      if (opts.purpose !== 'baseline') return green();
      seen.nice = opts.nice;
      const before = Date.now();
      await opts.gate?.(TEST);
      seen.waitedMs = Date.now() - before;
      measured.resolve();
      return green();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();

  assert.equal(seen.nice, BASELINE_NICE, 'the baseline asks for a lower priority');
  assert.ok((seen.waitedMs ?? 0) >= 150, `each command waits while the machine is loaded (${seen.waitedMs} ms)`);
  assert.ok((state.phases['1']!.baseline?.loadWaitMs ?? 0) >= 150, 'and the record says how long it waited');
});

test('BL-3: a niced command runs at the lower priority it was given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-bl3n-'));
  TRASH.push(dir);
  writeFileSync(join(dir, 'nice.sh'), 'ps -o nice= -p $$ > "$(dirname "$0")/nice.out"\n');
  const summary = await verifyPhase('`bash nice.sh`', { cwd: dir, purpose: 'baseline', nice: BASELINE_NICE, timeoutMs: 60_000 });
  assert.equal(summary.ok, true, summary.reason);
  // `nice -n` lowers the priority FROM the caller's own, so the suite's niceness
  // is the base: a gate run niced to spare a loaded machine starts above 0
  // (control-tower phase 117's gate ran at 5 and read 15). The floor is the
  // kernel's: 20 on macOS, 19 on Linux.
  const floor = process.platform === 'darwin' ? 20 : 19;
  const niced = Number(readFileSync(join(dir, 'nice.out'), 'utf8').trim());
  assert.equal(niced, Math.min(getPriority() + BASELINE_NICE, floor));
});

test('BL-3: a repository git will not export (a superproject) is measured BEFORE boarding, in place, as it always was', async () => {
  const h = harness({ superproject: true });
  const order: string[] = [];
  let baselineCwd = '';
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    verifyBaseline: () => true,
    spawn: async () => {
      order.push('session');
      writeFileSync(join(h.root, '.done-1'), '');
      return success();
    },
    verify: async (_text: string, opts: VerifyOptions) => {
      order.push(opts.purpose ?? 'verify');
      if (opts.purpose === 'baseline') baselineCwd = opts.cwd;
      return green();
    },
    verificationText: () => `\`${TEST}\``,
  } as never);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
  await runner.wait();
  assert.deepEqual(order, ['baseline', 'session', 'verify']);
  assert.equal(baselineCwd, h.root);
  const entry = journal(h.root, state).find((row) => row.event === 'phase.verify-baseline');
  assert.equal(entry?.data.concurrent, false);
});
