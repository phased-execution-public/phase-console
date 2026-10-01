/**
 * Work evidence is asked where the work is (control-tower phase 45, #60).
 *
 * The measured case: a plan whose Repos cell read
 * `shop/shop-api, shop/shop-web`. The runner's `scopeDirs` took
 * the NAME view of that cell, which truncates every token to its first
 * segment, and asked `shop` — a superproject whose own status ignores its
 * submodules and whose own log carries none of their commits. Five commits
 * had landed in the two nested repositories during the session; the halt said
 * "the session changed nothing on disk (shop: clean tree, 0 commits)". No
 * closeout was offered, the no-handoff ending charged the streak, and the
 * phase was later re-boarded from scratch as "never started" ($38, 5 h).
 *
 * WE-1  `workEvidence` counts a scope directory's nested submodules
 * WE-2  `scopeDirs` reads the FULL scope paths; `splitRepos` keeps its name view
 * WE-3  such a phase reads `producedWork`: a closeout is offered, the ending is
 *       not a merit failure, and the classifier never calls it never-started
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { classifySituation, gitIn, nestedSubmodules, workEvidence, type PhaseEvidence } from '../server/runner/situation.ts';
import { newRun, type RunState } from '../server/runner/state.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { splitRepos } from '../server/analysis/stats.ts';
import { scopeOfRow } from '../shared/scope.js';

/** Setup commits are dated long before the phase; the work after it. */
const SETUP_DATE = '2026-01-01T00:00:00Z';
const PHASE_STARTED = '2026-06-01T00:00:00Z';
const WORK_DATE = '2026-06-02T00:00:00Z';

function git(cwd: string, args: string[], date = SETUP_DATE): void {
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], {
    cwd, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function repo(dir: string, file = 'README.md'): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, file), `# ${file}\n`);
  git(dir, ['add', file]);
  git(dir, ['commit', '-qm', 'seed']);
}

/**
 * `<root>/shop` — a repository holding two submodules, `shop-api` and
 * `shop-web`, cloned from sources outside the tree. Nothing committed
 * after `PHASE_STARTED` until a test says so.
 */
function superproject(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-nested-'));
  const sources = join(root, '.sources');
  repo(join(sources, 'backend'));
  repo(join(sources, 'frontend'));
  repo(join(root, 'shop'));
  git(join(root, 'shop'), ['submodule', 'add', '-q', join(sources, 'backend'), 'shop-api']);
  git(join(root, 'shop'), ['submodule', 'add', '-q', join(sources, 'frontend'), 'shop-web']);
  git(join(root, 'shop'), ['commit', '-qm', 'the two submodules']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A commit inside a nested submodule, dated inside the phase. */
function workIn(dir: string, file: string): void {
  writeFileSync(join(dir, file), 'the phase\'s work\n');
  git(dir, ['add', file], WORK_DATE);
  git(dir, ['commit', '-qm', 'phase work'], WORK_DATE);
}

test('WE-1: a scope directory\'s nested submodules are asked too — commits there are work', async () => {
  const { root, cleanup } = superproject();
  try {
    const ask = gitIn(root);
    assert.deepEqual((await nestedSubmodules(ask, 'shop')).sort(), ['shop/shop-api', 'shop/shop-web']);

    const before = await workEvidence(ask, PHASE_STARTED, ['shop']);
    assert.equal(before.did, false, 'nothing yet: a clean superproject and clean submodules');

    workIn(join(root, 'shop', 'shop-web'), 'cart.ts');
    workIn(join(root, 'shop', 'shop-api'), 'orders.ts');
    const after = await workEvidence(ask, PHASE_STARTED, ['shop']);
    assert.equal(after.did, true, 'the tfar P18 shape: every commit inside the nested repositories');
    assert.equal(after.commits, 2);
    assert.match(after.why, /shop\/shop-web: clean tree, 1 commit since the phase started/);
    assert.match(after.why, /shop: clean tree, 0 commits/, 'the superproject itself is still reported for what it is');

    // An uncommitted edit in a nested repository counts as well.
    writeFileSync(join(root, 'shop', 'shop-api', 'draft.ts'), 'wip\n');
    const dirty = await workEvidence(ask, PHASE_STARTED, ['shop']);
    assert.equal(dirty.dirty, 1);

    // The root is NOT recursed: a docs hub's submodules are every plan's repositories.
    const rootOnly = await workEvidence(gitIn(join(root, 'shop')), PHASE_STARTED, ['.']);
    assert.equal(rootOnly.commits, 0, 'at the root, only the root\'s own tree and log');
  } finally { cleanup(); }
});

test('WE-1: an uninitialized submodule has no tree to ask, and a directory git cannot read has none at all', async () => {
  const { root, cleanup } = superproject();
  try {
    // A fresh clone of `shop` whose submodules were never initialized.
    execFileSync('git', ['clone', '-q', join(root, 'shop'), join(root, 'clone')], { stdio: 'ignore' });
    assert.deepEqual(await nestedSubmodules(gitIn(root), 'clone'), []);
    assert.deepEqual(await nestedSubmodules(gitIn(root), 'not-a-repo'), []);
  } finally { cleanup(); }
});

test('WE-2: scopeDirs reads the FULL scope paths — and splitRepos keeps its name view for the hint and the analysis', async () => {
  const { root, cleanup } = superproject();
  try {
    const cell = 'shop/shop-api, shop/shop-web';
    assert.deepEqual(splitRepos(cell), ['shop'], 'the NAME view is unchanged — it never picks a directory');
    assert.deepEqual(scopeOfRow(cell), ['shop/shop-api', 'shop/shop-web'], 'what the service hands phaseRepoDirs');

    const scopeDirsOf = async (deps: Record<string, unknown>) => {
      const runner = new Runner({ scriptsDir: join(root, 'scripts'), spawn: async () => ({}) as never, ...deps } as never);
      (runner as unknown as { state: RunState }).state = newRun({ slug: 'demo', root });
      return (runner as unknown as { scopeDirs: (p: number) => Promise<string[]> }).scopeDirs(1);
    };
    assert.deepEqual(
      await scopeDirsOf({ phaseRepos: () => splitRepos(cell), phaseRepoDirs: () => scopeOfRow(cell) }),
      ['shop/shop-api', 'shop/shop-web'],
      'the directories the phase worked in, not their parent',
    );
    assert.deepEqual(await scopeDirsOf({ phaseRepos: () => splitRepos(cell) }), ['shop'], 'absent the full paths, the old reading');
    assert.deepEqual(await scopeDirsOf({ phaseRepoDirs: () => ['all'] }), ['.']);
    assert.deepEqual(await scopeDirsOf({ phaseRepoDirs: () => ['nowhere/here'] }), ['.'], 'a path that is not here falls back to the root');
  } finally { cleanup(); }
});

test('WE-3: a phase whose only commits are in a nested submodule reads producedWork — a closeout, no merit charge, never "never started"', async () => {
  const { root, cleanup } = superproject();
  try {
    const scripts = join(root, 'scripts');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
    // The board never sees a handoff: the session works and writes none.
    writeFileSync(join(scripts, 'phase-graph.sh'), `#!/bin/bash
case "$2" in
  --memory-block) echo "done: "; echo "in-progress: "; echo "stuck: "; echo "ready: 1"; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $3 of $1" ;;
  --size) echo M ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(scripts, 'phase-lock.sh'), '#!/bin/bash\necho free\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(scripts, 'validate.sh'), '#!/bin/bash\necho ok\nexit 0\n', { mode: 0o755 });

    const modes: string[] = [];
    const runner = new Runner({
      scriptsDir: scripts,
      phaseRepos: () => splitRepos('shop/shop-api, shop/shop-web'),
      phaseRepoDirs: () => scopeOfRow('shop/shop-api, shop/shop-web'),
      spawn: async (req: { prompt?: string; name?: string }) => {
        const closeout = /closeout/.test(req.name ?? '');
        modes.push(closeout ? 'closeout' : 'phase');
        // The phase session commits in the nested repository — with a date
        // inside the phase — and writes no handoff; the closeout writes none either.
        if (!closeout) {
          const dir = join(root, 'shop', 'shop-web');
          // A minute ahead, so a second-granular `--since` cannot miss it.
          const inside = new Date(Date.now() + 60_000).toISOString();
          writeFileSync(join(dir, 'cart.ts'), 'the phase\'s work\n');
          git(dir, ['add', 'cart.ts'], inside);
          git(dir, ['commit', '-qm', 'phase work'], inside);
        }
        return {
          signal: { subtype: 'success' as const, code: 0, text: 'done' },
          sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
        };
      },
      verificationText: () => '`true`',
    } as never);
    const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going', maxConsecutiveFailures: 1 } as never);
    await runner.wait();

    assert.deepEqual(modes, ['phase', 'closeout'], 'the work was SEEN: its own session was asked to close it out');
    const record = state.phases['1'];
    assert.equal(record.halt?.kind, 'no-handoff');
    assert.doesNotMatch(record.halt?.reason ?? '', /changed nothing on disk/);
    assert.equal(state.consecutiveFailures, 0, 'unfinished paperwork is not a broken plan — even at a maximum of 1');
    assert.notEqual(state.halt?.kind, 'failure-streak');
    const lines = readFileSync(journalFile(root, 'demo', state.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const held = lines.find((l: { event: string }) => l.event === 'run.failure-streak-held');
    assert.equal(held?.data.cause, 'no-handoff-worked');

    // …and the classifier, asked the same tree, reads work in progress.
    const work = await workEvidence(gitIn(root), record.startedAt, scopeOfRow('shop/shop-api, shop/shop-web'));
    assert.equal(work.did, true);
    const evidence: PhaseEvidence = {
      slug: 'demo', phase: 1, board: 'ready', handoff: { exists: false },
      record: {
        status: 'interrupted', attempts: 1, sessionId: 'sid-1', resumable: true,
        startedAt: record.startedAt ?? null, endedAt: null, verification: null, closeout: null,
        note: 'stopped', said: '', gate: { clear: true, kind: 'clear' }, costUsd: 0, turns: 1,
      },
      run: {
        status: 'parked', halt: { reason: 'nothing left to run on its own — phase 1 is interrupted (stopped)', phase: 1 },
        waitUntil: null, resolved: false,
      },
      lock: null, declared: null, gate: null, mcp: null, health: [], registry: null, qa: { mode: 'off' }, auth: null,
      work, at: new Date().toISOString(),
    } as unknown as PhaseEvidence;
    assert.notEqual(classifySituation(evidence).id, 'never-started', 'work on disk is never "never started"');
    assert.equal(classifySituation({ ...evidence, work: { did: false, why: 'shop: clean tree, 0 commits', dirty: 0, commits: 0 } }).id,
      'never-started', 'the misread the old truncated scope produced — for contrast');
    assert.ok(existsSync(join(root, 'shop', 'shop-web', 'cart.ts')));
  } finally { cleanup(); }
});
