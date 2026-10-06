/**
 * An export carries the sibling repositories a superproject line reads
 * (control-tower phase 106, #191).
 *
 * ai-builder-v7 verified `task verify:local` in app-backend's clean export —
 * a directory holding app-backend ALONE. Its required `cross-repo-parity`
 * gate reads `../app-frontend`, which the run's mirror mounts and the export
 * did not, so every console run of that line in an export was red by
 * construction (each baseline ~25 min, red, then retried) while the session's
 * own runs in the mirror were green. And what made it export in the first
 * place was the plan's OWN `Setup:` output (a `data` symlink) and a compile
 * cache no phase wrote.
 *
 * VE-2  an export of a repository inside a superproject reproduces the
 *       superproject's layout around it — the other mounted repositories (and
 *       the root's own files) linked at their relative paths, the export alone
 *       clean — and taking it away never touches what it linked; untracked
 *       paths no phase owns, a `Setup:` output and a dependency directory
 *       never send a verdict to an export; a sibling the export cannot provide
 *       is `environment`, never red.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { exportCheckout } from '../server/runner/worktree.ts';
import { verifyPhase, type VerifyOptions } from '../server/runner/verify.ts';
import { Runner } from '../server/runner/runner.ts';
import { newRun, phaseRecord, saveRun, type RunState, type VerifySummary } from '../server/runner/state.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TRASH.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', '-c', 'init.defaultBranch=main', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with one commit holding `files`. */
function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/**
 * The mirror's shape: a superproject whose `trade/backend` line reads its
 * sibling `trade/frontend`, the root's own `docs/` beside them.
 */
function superproject(): { root: string; backend: string; frontend: string } {
  const base = scratch('pc-vxs-');
  const backendOrigin = repo(join(base, 'origins', 'backend'), {
    'parity.sh': 'cat ../frontend/VERSION\n',
    'src.txt': 'backend\n',
  });
  const frontendOrigin = repo(join(base, 'origins', 'frontend'), { VERSION: '1.2.3\n' });
  const root = repo(join(base, 'root'), { 'docs/notes.md': '# the root\n' });
  git(root, 'submodule', 'add', '-q', backendOrigin, 'trade/backend');
  git(root, 'submodule', 'add', '-q', frontendOrigin, 'trade/frontend');
  git(root, 'commit', '-q', '-m', 'mount');
  return { root, backend: join(root, 'trade', 'backend'), frontend: join(root, 'trade', 'frontend') };
}

test('VE-2: an export of a superproject\'s repository stands where it stood — its siblings and the root\'s files linked around it, itself clean', async () => {
  const f = superproject();
  // Work in progress in the exported repository, which the export must not carry.
  writeFileSync(join(f.backend, 'src.txt'), 'half-done\n');
  const head = git(f.backend, 'rev-parse', 'HEAD');
  const made = await exportCheckout(f.backend, head);
  assert.ok(!('refused' in made), `exported: ${'refused' in made ? made.refused : ''}`);
  if ('refused' in made) return;
  try {
    assert.equal(basename(made.dir), 'backend');
    assert.equal(basename(dirname(made.dir)), 'trade', 'at its own relative path');
    assert.equal(readFileSync(join(made.dir, 'src.txt'), 'utf8'), 'backend\n', 'the export holds the commit, not the WIP');
    assert.equal(readFileSync(join(made.dir, '..', 'frontend', 'VERSION'), 'utf8'), '1.2.3\n', 'its sibling is there');
    assert.ok(lstatSync(join(made.dir, '..', 'frontend')).isSymbolicLink(), 'linked, never copied');
    assert.equal(realpathSync(join(made.dir, '..', 'frontend')), realpathSync(f.frontend));
    assert.equal(readFileSync(join(made.dir, '..', '..', 'docs', 'notes.md'), 'utf8'), '# the root\n', 'and the root\'s own files');
    assert.equal(existsSync(join(made.dir, '..', '..', '.git')), false, 'never the superproject\'s git directory');

    const summary = await verifyPhase('`bash parity.sh`', { cwd: made.dir, timeoutMs: 60_000 });
    assert.equal(summary.ok, true, `the cross-repo line passes in the export: ${summary.reason}`);
  } finally {
    await made.remove();
  }
  assert.equal(existsSync(made.dir), false, 'the export is gone');
  assert.equal(readFileSync(join(f.frontend, 'VERSION'), 'utf8'), '1.2.3\n', 'and what it linked is untouched');
  assert.equal(readFileSync(join(f.root, 'docs', 'notes.md'), 'utf8'), '# the root\n');
  assert.equal(readFileSync(join(f.backend, 'src.txt'), 'utf8'), 'half-done\n', 'the WIP it set aside too');
  assert.doesNotMatch(git(f.backend, 'worktree', 'list'), /pc-verify-export-/, 'its registration is gone');
});

test('VE-2: a sibling the export cannot provide is `environment` — named, never a red', async () => {
  // A repository with no superproject, whose working tree has `../shared` on disk.
  const base = scratch('pc-vxe-');
  const lone = repo(join(base, 'lone'), { 'reads-sibling.sh': 'cat ../shared/VERSION\n' });
  mkdirSync(join(base, 'shared'));
  writeFileSync(join(base, 'shared', 'VERSION'), '9.9.9\n');
  const made = await exportCheckout(lone, git(lone, 'rev-parse', 'HEAD'));
  assert.ok(!('refused' in made));
  if ('refused' in made) return;
  try {
    // The line names the sibling itself: judged before it runs.
    const named = await verifyPhase('`cat ../shared/VERSION`', { cwd: made.dir, inPlace: lone, timeoutMs: 60_000 } as VerifyOptions);
    assert.match(named.ran[0]!.environment ?? '', /cannot provide `\.\.\/shared`/, `got: ${named.ran[0]!.environment ?? 'a red'}`);
    assert.deepEqual(named.unproven?.map((entry) => entry.command), ['cat ../shared/VERSION'], 'unproven, never red');
    // The line's script reads it: the red's own output names it.
    const read = await verifyPhase('`bash reads-sibling.sh`', { cwd: made.dir, inPlace: lone, timeoutMs: 60_000 } as VerifyOptions);
    assert.equal(read.ran.length, 1, 'not retried');
    assert.match(read.ran[0]!.environment ?? '', /cannot provide `\.\.\/shared`/, `got: ${read.ran[0]!.environment ?? 'a red'}`);
    // In place the same line is simply green — the sibling is there.
    const inPlace = await verifyPhase('`bash reads-sibling.sh`', { cwd: lone, timeoutMs: 60_000 });
    assert.equal(inPlace.ok, true);
  } finally {
    await made.remove();
  }
  assert.equal(readFileSync(join(base, 'shared', 'VERSION'), 'utf8'), '9.9.9\n');
});

/* ------------------------------------------------------------------ *
 * In place when only untracked, unowned paths differ (#191 asks 1–2)
 * ------------------------------------------------------------------ */

type Harness = { root: string; scriptsDir: string; done: (phase: number) => void };

function harness(phases: number[]): Harness {
  const root = scratch('pc-vxh-');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'src.txt'), 'the work\n');
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
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, scriptsDir, done: (phase) => writeFileSync(join(root, `.done-${phase}`), '') };
}

const SIBLING_WINDOW = { attempt: 1, startedAt: '2026-09-25T06:00:00.000Z', endedAt: '2026-09-25T06:55:00.000Z' };
const IN_SIBLING_WINDOW = new Date('2026-09-25T06:30:00.000Z');
const NOBODYS = new Date('2026-09-20T03:00:00.000Z');

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

function touch(path: string, at: Date): void {
  utimesSync(path, at, at);
}

test('VE-2: untracked paths no phase owns, the plan\'s own Setup outputs and dependency directories never send a verdict to an export', async () => {
  const h = harness([1, 2]);
  const stored = withSibling(h);
  // The plan's own Setup made `data` — written in phase 2's session, which re-ran it.
  symlinkSync(join(h.root, 'docs'), join(h.root, 'data'));
  // A virtualenv nobody ignored, written in phase 2's session too.
  mkdirSync(join(h.root, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(h.root, '.venv', 'bin', 'python'), '');
  touch(join(h.root, '.venv', 'bin', 'python'), IN_SIBLING_WINDOW);
  // A compile cache no session wrote.
  mkdirSync(join(h.root, '.statepath_cache'));
  writeFileSync(join(h.root, '.statepath_cache', 'mod.py'), 'cache\n');
  touch(join(h.root, '.statepath_cache', 'mod.py'), NOBODYS);

  const seen: { purpose: string; cwd: string }[] = [];
  const runner = new Runner({
    scriptsDir: h.scriptsDir,
    spawn: async () => {
      writeFileSync(join(h.root, 'src.txt'), 'the work of phase 1\n');
      git(h.root, 'add', 'src.txt');
      git(h.root, 'commit', '-q', '-m', 'phase 1');
      h.done(1);
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verify: async (_text: string, opts: VerifyOptions): Promise<VerifySummary> => {
      seen.push({ purpose: opts.purpose ?? 'verify', cwd: opts.cwd });
      return { ok: true, reason: '1 command green', notRun: [], ran: [{ command: 'npm test', ok: true, code: 0, ms: 5, output: '' }] };
    },
    verificationText: () => '`npm test`',
    setupText: () => '`ln -s ../shared/data data`',
  } as never);
  // The link's OWN time (`lstat`), inside phase 2's window: `touch -h`, read in UTC.
  try {
    execFileSync('touch', ['-h', '-t', '202609250630', join(h.root, 'data')], { env: { ...process.env, TZ: 'UTC' } });
  } catch { /* no `touch -h` here: the link keeps its own time, and is nobody's — still not foreign */ }
  const state = await runner.start({ slug: 'demo', root: h.root, autonomy: 'keep-going', resumeRunId: stored.id });
  await runner.wait();

  const record = state.phases['1']!;
  assert.equal(record.status, 'done', record.note);
  assert.equal(seen.find((one) => one.purpose === 'verify')?.cwd, h.root, 'verified in place');
  assert.equal(record.verification?.export, undefined, 'no export, and none to explain');
});
