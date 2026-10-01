/**
 * §Verification runs on the phase's own tree (control-tower phase 89, #103, #41).
 *
 * P61's session verified green on a `git archive` of its own commit; the
 * console's §Verification then ran in the shared run tree, where P62's 17
 * uncommitted files sat, and went red on P62's names — a red the fifth
 * amendment's re-open rule would have sent P61 down a fix rung for.
 *
 * EX-1  a working tree holding changes that are NOT the phase's own (another
 *       phase's uncommitted WIP) is set aside: the commands run in a clean
 *       checkout of the phase's HEAD in a temporary directory — the WIP absent,
 *       the dependencies borrowed — the verdict says so, and the checkout goes
 * EX-2  a clean tree, or one holding only the phase's own changes, verifies in
 *       place as before
 * EX-3  a red `&&` chain's members are judged alone, in the same checkout
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { VerifyOptions } from '../server/runner/verify.ts';
import { newRun, phaseRecord, saveRun, streakPhases, type RunState, type VerifySummary } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

const TEST = 'npm test';

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void };

/** A git repository with the engine stubbed: phase N is done once `.done-N` exists. */
function harness(phases: number[]): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vx-')));
  TRASH.push(root);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\nnode_modules/\n');
  // An installed dependency: never committed, borrowed by a clean checkout.
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
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
  gitIn(root, ['init', '-q']);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'base']);
  return { root, scriptsDir, done: (phase) => writeFileSync(join(root, `.done-${phase}`), '') };
}

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
}

type SpawnReq = { prompt?: string; name?: string };
const phaseOf = (req: SpawnReq): number => Number(/BOOT phase (\d+)/.exec(req.prompt ?? '')?.[1] ?? /\bp(\d+)\b/.exec(req.name ?? '')?.[1]);

/** Phase 2's one session, the day before — when its WIP was written. */
const SIBLING_WINDOW = { attempt: 1, startedAt: '2026-09-25T06:00:00.000Z', endedAt: '2026-09-25T06:55:00.000Z' };
const IN_SIBLING_WINDOW = new Date('2026-09-25T06:30:00.000Z');

/** A stored run in which phase 2 had its session in `SIBLING_WINDOW`; phase 1 is to board. */
function withSibling(h: Harness): RunState {
  h.done(2);
  const stored = newRun({ slug: 'demo', root: h.root });
  stored.status = 'paused';
  stored.stoppedBy = 'operator';
  const sibling = phaseRecord(stored, 2);
  sibling.status = 'done';
  sibling.attempts = 1;
  sibling.attemptWindows = [{ ...SIBLING_WINDOW }];
  phaseRecord(stored, 1).status = 'pending';
  saveRun(stored);
  return stored;
}

/** Phase 2's uncommitted file, written inside its session's window. */
function siblingWip(h: Harness): void {
  writeFileSync(join(h.root, 'wip.txt'), 'a sibling\'s half-done work\n');
  utimesSync(join(h.root, 'wip.txt'), IN_SIBLING_WINDOW, IN_SIBLING_WINDOW);
}

/** A session that commits its own work, optionally leaving an uncommitted file of its OWN. */
function committingSession(h: Harness, opts: { ownDirt?: boolean } = {}) {
  return async (req: SpawnReq) => {
    const phase = phaseOf(req);
    writeFileSync(join(h.root, 'src.txt'), `the work of phase ${phase}\n`);
    gitIn(h.root, ['add', 'src.txt']);
    gitIn(h.root, ['commit', '-q', '-m', `phase ${phase}`]);
    if (opts.ownDirt) writeFileSync(join(h.root, 'notes.txt'), 'still mine\n');
    h.done(phase);
    return {
      signal: { subtype: 'success' as const, code: 0, text: 'done' },
      sessionId: `sid-${phase}`, costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
    };
  };
}

type Seen = { purpose: string; cwd: string; wip: boolean; src: string; dep: boolean; depLinked: boolean };

/** A runner whose verifier records WHERE it ran and what that tree held, then answers. */
function runnerWith(h: Harness, spawn: (req: SpawnReq) => Promise<unknown>, answer: (seen: Seen, text: string) => VerifySummary, text = `\`${TEST}\``) {
  const seen: Seen[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn,
    verify: async (verifyText: string, opts: VerifyOptions) => {
      const dep = join(opts.cwd, 'node_modules', 'dep');
      const one: Seen = {
        purpose: opts.purpose ?? 'verify',
        cwd: opts.cwd,
        wip: existsSync(join(opts.cwd, 'wip.txt')),
        src: existsSync(join(opts.cwd, 'src.txt')) ? readFileSync(join(opts.cwd, 'src.txt'), 'utf8') : '',
        dep: existsSync(join(dep, 'index.js')),
        depLinked: existsSync(dep) && lstatSync(dep).isSymbolicLink(),
      };
      seen.push(one);
      return answer(one, verifyText);
    },
    verificationText: () => text,
  } as never);
  return { runner, seen };
}

const green = (command = TEST): VerifySummary => ({
  ok: true, reason: '1 command green', notRun: [], ran: [{ command, ok: true, code: 0, ms: 5, output: '' }],
});

function journal(root: string, state: RunState): { event: string; phase?: number; data: Record<string, unknown> }[] {
  const file = journalFile(root, state.slug, state.id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('EX-1: a tree holding another phase\'s uncommitted WIP is set aside — the commands run on a clean checkout of the phase\'s HEAD, the verdict says so, and the checkout goes', async () => {
  const h = harness([1, 2]);
  siblingWip(h);
  const stored = withSibling(h);
  // Red wherever phase 2's WIP is present (P61's red from P62's files), green on the phase's own commit.
  const { runner, seen } = runnerWith(h, committingSession(h), (one) => (one.wip
    ? { ok: false, reason: '`npm test` exited 1', notRun: [], ran: [{ command: TEST, ok: false, code: 1, ms: 5, output: 'not ok 1 - docs-parity' }] }
    : green()));
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();

  const record = state.phases['1'];
  assert.equal(record.status, 'done', `verified on its own tree (${record.note ?? ''})`);
  assert.equal(record.reopened, undefined);
  assert.deepEqual(streakPhases(state), []);
  const verdict = seen.find((one) => one.purpose === 'verify')!;
  assert.notEqual(verdict.cwd, h.root, 'not the working tree');
  assert.ok(verdict.cwd.startsWith(realpathSync(tmpdir())) || verdict.cwd.startsWith(tmpdir()), `a temporary directory: ${verdict.cwd}`);
  assert.equal(verdict.wip, false, 'phase 2\'s WIP is not in it');
  assert.equal(verdict.src, 'the work of phase 1\n', 'the phase\'s own commit is');
  assert.equal(verdict.dep, true, 'the installed dependencies are borrowed');
  assert.equal(verdict.depLinked, true, 'as links to the entries, never the directory itself');
  const exported = record.verification?.export;
  assert.equal(exported?.head, gitIn(h.root, ['rev-parse', 'HEAD']));
  assert.deepEqual(exported?.paths, ['wip.txt']);
  assert.deepEqual(exported?.owners, [2]);
  assert.match(exported?.reason ?? '', /not this phase's own \(phase 2's\)/);
  const line = journal(h.root, state).find((entry) => entry.event === 'phase.verify' && entry.phase === 1);
  assert.deepEqual((line?.data.export as { paths?: string[] } | undefined)?.paths, ['wip.txt'], 'the journal says where it ran');
  assert.equal(existsSync(verdict.cwd), false, 'the checkout is removed');
  assert.doesNotMatch(gitIn(h.root, ['worktree', 'list']), /pc-verify-export-/, 'and so is its registration');
  assert.equal(readFileSync(join(h.root, 'wip.txt'), 'utf8'), 'a sibling\'s half-done work\n', 'the sibling\'s WIP is untouched');
});

test('EX-2: a clean tree — or one holding only the phase\'s own changes — verifies in place, as before', async () => {
  for (const ownDirt of [false, true]) {
    const h = harness([1]);
    const { runner, seen } = runnerWith(h, committingSession(h, { ownDirt }), () => green());
    const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going' });
    await runner.wait();
    const record = state.phases['1'];
    assert.equal(record.status, 'done', record.note);
    assert.equal(seen.find((one) => one.purpose === 'verify')?.cwd, h.root, `in place (own dirt: ${ownDirt})`);
    assert.equal(record.verification?.export, undefined);
  }
});

test('EX-3: a red `&&` chain is judged member by member, each alone, in the same clean checkout', async () => {
  const h = harness([1, 2]);
  siblingWip(h);
  const stored = withSibling(h);
  const CHAIN = 'npm run lint && npm test';
  const { runner, seen } = runnerWith(h, committingSession(h), (one, text) => {
    if (one.purpose === 'attribution') {
      return {
        ok: false, reason: 'members', notRun: [],
        ran: [
          { command: 'npm run lint', ok: true, code: 0, ms: 5, output: '' },
          { command: 'npm test', ok: false, code: 1, ms: 5, output: 'not ok 1 - suite › own red', failures: ['suite › own red'] },
        ],
      };
    }
    return text.includes('&&')
      ? { ok: false, reason: 'chain exited 1', notRun: [], ran: [{ command: CHAIN, ok: false, code: 1, ms: 5, output: '' }] }
      : green();
  }, `\`${CHAIN}\``);
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id, autoRecover: false });
  await runner.wait();

  const verify = seen.find((one) => one.purpose === 'verify')!;
  const members = seen.find((one) => one.purpose === 'attribution');
  assert.ok(members, 'the chain\'s members were run alone');
  assert.equal(members!.cwd, verify.cwd, 'in the same checkout as the verdict');
  assert.notEqual(members!.cwd, h.root);
  assert.equal(members!.wip, false);
  assert.ok(state.phases['1'].verification?.export, 'the verdict says it ran on a clean checkout');
});
