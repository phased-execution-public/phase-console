/**
 * A session's proof is keyed where the console will judge the line — not
 * wherever the session's shell happened to stand (control-tower phase 106,
 * #196).
 *
 * ai-builder-v7 P14's session recorded all five §Verification lines green with
 * `phase-outcome.sh … verified --command "cd app/app-frontend && …" --exit
 * 0 --in .` — from a shell standing INSIDE app/app-frontend, so `--in .`
 * meant that submodule and the proof was keyed by its tree. The console judges
 * those lines at the plan root, where the lines `cd` themselves, against the
 * SUPERPROJECT's tree: five × "the proven tree is not an object of this
 * repository", ~15 minutes of re-run with the lane held, and nothing told the
 * session at record time. P13 recorded the same shapes from the mirror root and
 * all nine were accepted: the outcome depended on a cwd the line never states.
 *
 * VE-5  `verified` resolves `--in` against the run root, never `$PWD`, and with
 *       no `--in` keys the proof where the console judges the phase
 *       (`PE_VERIFY_DIR`, which the runner now injects); a proof whose tree the
 *       judging repository does not hold is refused when it is RECORDED,
 *       naming both trees — never silently at the verdict.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeProofs } from '../server/runner/proofs.ts';
import { workingTreeOf } from '../server/runner/worktree.ts';
import { Runner } from '../server/runner/runner.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTCOME = join(REPO_ROOT, 'scripts', 'phase-outcome.sh');

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

function repo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

/** A superproject mounting `sub` — the mirror's shape. */
function superproject(): { root: string; sub: string; ledger: string } {
  const base = scratch('pc-vp5-');
  const origin = repo(join(base, 'origin'), { 'app.txt': 'the frontend\n' });
  const root = repo(join(base, 'root'), { 'README.md': '# root\n' });
  git(root, 'submodule', 'add', '-q', origin, 'sub');
  git(root, 'commit', '-q', '-m', 'mount');
  return { root, sub: join(root, 'sub'), ledger: join(base, 'proofs.ndjson') };
}

/** The session's environment: the console's claim variables, and nothing of THIS suite's own session. */
function sessionEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['PE_WORKTREE', 'PE_VERIFY_DIR', 'PE_RUN_ROOT', 'PE_PROOFS_FILE', 'DOCS_ROOT']) delete env[key];
  return { ...env, PE_NOW: '2026-10-03T10:00:00Z', ...extra };
}

const LINE = 'cd sub && npm test';

test('VE-5: `--in .` from INSIDE the submodule means the run root — the verdict accepts the proof', async () => {
  const f = superproject();
  execFileSync('bash', [OUTCOME, 'demo', '1', 'verified', '--command', LINE, '--exit', '0', '--in', '.'], {
    cwd: f.sub,   // where the session's shell happened to stand
    env: sessionEnv({ PE_PROOFS_FILE: f.ledger, PE_RUN_ROOT: f.root, PE_VERIFY_DIR: f.root }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 1, cwd: f.root });
  assert.deepEqual([...judged.proven.keys()], [LINE], `refused: ${JSON.stringify(judged.refused)}`);
});

test('VE-5: with no `--in`, the proof is keyed where the console judges the phase — whatever the shell\'s cwd', async () => {
  const f = superproject();
  execFileSync('bash', [OUTCOME, 'demo', '1', 'verified', '--command', LINE, '--exit', '0'], {
    cwd: f.sub,
    env: sessionEnv({ PE_PROOFS_FILE: f.ledger, PE_RUN_ROOT: f.root, PE_VERIFY_DIR: f.root }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 1, cwd: f.root });
  assert.deepEqual([...judged.proven.keys()], [LINE], `refused: ${JSON.stringify(judged.refused)}`);
});

test('VE-5: a proof whose tree the judging repository does not hold is refused when RECORDED — naming both trees', async () => {
  const f = superproject();
  const subTree = (await workingTreeOf(f.sub))!.tree;
  const rootTree = (await workingTreeOf(f.root))!.tree;
  const result = spawnSync('bash', [OUTCOME, 'demo', '1', 'verified', '--command', LINE, '--exit', '0', '--in', 'sub'], {
    cwd: f.root,
    env: sessionEnv({ PE_PROOFS_FILE: f.ledger, PE_RUN_ROOT: f.root, PE_VERIFY_DIR: f.root }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, `refused at record time: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /not recorded/);
  assert.ok(result.stderr.includes(subTree.slice(0, 12)), `the proof's tree is named: ${result.stderr}`);
  assert.ok(result.stderr.includes(rootTree.slice(0, 12)), `and the judging repository's: ${result.stderr}`);
  assert.equal(existsSync(f.ledger), false, 'nothing was written for the verdict to refuse later');
});

test('VE-5: a line judged IN the submodule (`Verify in: sub`) is recorded there, whatever `--in .` stood on', async () => {
  const f = superproject();
  execFileSync('bash', [OUTCOME, 'demo', '1', 'verified', '--command', 'npm test', '--exit', '0', '--in', 'sub'], {
    cwd: f.root,
    env: sessionEnv({ PE_PROOFS_FILE: f.ledger, PE_RUN_ROOT: f.root, PE_VERIFY_DIR: f.sub }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 1, cwd: f.sub });
  assert.deepEqual([...judged.proven.keys()], ['npm test'], `refused: ${JSON.stringify(judged.refused)}`);
});

test('VE-5: an absolute `--in` is taken as written, as before', async () => {
  const f = superproject();
  execFileSync('bash', [OUTCOME, 'demo', '1', 'verified', '--command', 'npm test', '--exit', '0', '--in', f.sub], {
    cwd: tmpdir(),
    env: sessionEnv({ PE_PROOFS_FILE: f.ledger }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const judged = await judgeProofs({ file: f.ledger, slug: 'demo', phase: 1, cwd: f.sub });
  assert.deepEqual([...judged.proven.keys()], ['npm test']);
});

/* ------------------------------------------------------------------ *
 * The console tells the session where it will judge
 * ------------------------------------------------------------------ */

test('VE-5: every session the runner spawns for a phase is told where its lines are judged (PE_VERIFY_DIR) and the run root (PE_RUN_ROOT)', async () => {
  const root = scratch('pc-vp5r-');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(root, 'pkg', 'src.txt'), 'the work\n');
  writeFileSync(join(root, '.gitignore'), 'scripts/\n.done-*\n');
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
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');

  const envs: Record<string, string | undefined>[] = [];
  const runner = new Runner({
    scriptsDir,
    verifyIn: () => 'pkg',
    spawn: async (req: { env?: Record<string, string | undefined> }) => {
      envs.push(req.env ?? {});
      writeFileSync(join(root, '.done-1'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-1', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verify: async () => ({ ok: true, reason: '1 command green', notRun: [], ran: [{ command: 'npm test', ok: true, code: 0, ms: 5, output: '' }] }),
    verificationText: () => '`npm test`',
  } as never);
  await runner.start({ slug: 'demo', root, autonomy: 'keep-going' });
  await runner.wait();

  assert.ok(envs.length >= 1, 'the phase\'s session was spawned');
  assert.equal(envs[0]!.PE_VERIFY_DIR, join(root, 'pkg'), 'the directory the console runs this phase\'s §Verification in');
  assert.equal(envs[0]!.PE_RUN_ROOT, root, 'the root a relative --in is resolved against');
  assert.ok(envs[0]!.PE_PROOFS_FILE, 'beside the ledger it already named');
});
