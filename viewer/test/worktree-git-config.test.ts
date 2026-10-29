/**
 * WG-1..5 (one-pool phase 2, #272) — a git configuration a session plants in a
 * run tree is never run by the console's own git, and the lane that planted
 * it halts with the key named.
 *
 * Phase 141's attack (control-tower `turn-security-review.md`, F4): the common
 * runner in `runner/worktree.ts` inherited the repository's config, so a
 * session's `git config core.fsmonitor …` or `core.hooksPath …` ran as the
 * console on its next git call in that tree — outside every wall.
 *
 * WG-1  A planted `core.fsmonitor` and `core.hooksPath` run under NO console
 *       git call: the seam itself, the worktree runner's status read and its
 *       checkout, a commit — and a git spawned on the `shell` channel too.
 * WG-2  A planted credential helper (plain or URL-scoped) never runs; the
 *       operator's own global helper still does. `GIT_SSH_COMMAND` is pinned.
 * WG-3  A caller's own `GIT_CONFIG_COUNT` keys survive, ahead of ours.
 * WG-4  The reader: planted keys found in a tree's local config — through an
 *       include, a linked worktree's gitfile, a URL-scoped helper, a filter
 *       driver — and nothing reported for the keys that were there before.
 * WG-5  A lane whose session plants `core.hooksPath` halts `run-tree-config`,
 *       journalled with the key, before any verification — and the hook never
 *       ran.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configTreesOf, hardenedGitEnv, plantedSince, readTreeConfig, treeConfigBaseline } from '../server/git-guard.ts';
import { shell } from '../server/shell.ts';
import { ensureDetachedIntegration, uncommittedPaths } from '../server/runner/worktree.ts';
import { Runner } from '../server/runner/runner.ts';
import { journalFile } from '../server/runner/run-paths.ts';
import { PHASE_HALT_KINDS } from '../shared/recovery-model.js';
import { repo } from './fixtures/repo.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TRASH.push(dir);
  return dir;
}

/** The test's own git, as a person would run it — never the console's seam. */
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
});

/** A repository with one commit, and a script that leaves a marker when anything runs it. */
function plantedRepo(): { dir: string; marker: string; script: string } {
  const dir = repo({ dir: scratch('pc-wg-'), files: { 'f.txt': 'one\n' }, message: 'one' });
  sh(dir, 'config', '--unset', 'commit.gpgsign'); // the tests read the tree's own config keys: leave only the planted ones
  const marker = join(scratch('pc-wg-marker-'), 'ran');
  const script = join(scratch('pc-wg-script-'), 'planted.sh');
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 0\n`, { mode: 0o755 });
  return { dir, marker, script };
}

/** What a session does: plant a hooks directory and an fsmonitor command in the tree's own config. */
function plant(dir: string, script: string): void {
  const hooks = join(dir, '.git', 'planted-hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction', 'post-index-change']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\nexec '${script}' ${hook}\n`, { mode: 0o755 });
  }
  sh(dir, 'config', 'core.hooksPath', hooks);
  sh(dir, 'config', 'core.fsmonitor', script);
}

test('WG-1 (#272): a planted core.fsmonitor and core.hooksPath run under no console git call', async () => {
  const { dir, marker, script } = plantedRepo();
  // Red-proof: the plant really fires for git run the way the console ran it before.
  plant(dir, script);
  writeFileSync(join(dir, 'f.txt'), 'two\n');
  sh(dir, 'status', '--porcelain');
  assert.ok(existsSync(marker), 'the planted fsmonitor runs on a plain git status — the shape #272 names');
  rmSync(marker);

  const seam = await shell('git', ['status', '--porcelain'], { channel: 'git', intent: 'wg-1', cwd: dir });
  assert.equal(seam.ok, true, seam.stderr);
  const onShell = await shell('git', ['-C', dir, 'diff', '--stat'], { channel: 'shell', intent: 'wg-1', cwd: dir });
  assert.equal(onShell.ok, true, onShell.stderr);
  const paths = await uncommittedPaths(dir);
  assert.deepEqual(paths?.paths.map((p) => p.path), ['f.txt'], 'the worktree runner still reads the tree');
  const commit = await shell('git', ['commit', '-qam', 'two'], { channel: 'git', intent: 'wg-1', cwd: dir });
  assert.equal(commit.ok, true, commit.stderr);
  const head = sh(dir, 'rev-parse', 'HEAD').trim();
  const lane = join(scratch('pc-wg-lane-'), 'lane');
  const made = await ensureDetachedIntegration(dir, lane, head);
  assert.ok(existsSync(join(lane, 'f.txt')), `the checkout was made: ${JSON.stringify(made)}`);
  assert.equal(existsSync(marker), false,
    `nothing the session planted ran: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
});

test('WG-2 (#272): a planted credential helper never runs; the operator\'s own global helper still does', async () => {
  const { dir, marker, script } = plantedRepo();
  sh(dir, 'config', 'credential.helper', `!'${script}' local`);
  sh(dir, 'config', 'credential.https://x.example.invalid.helper', `!'${script}' url-scoped`);
  const global = join(scratch('pc-wg-global-'), 'gitconfig');
  const ours = join(scratch('pc-wg-ours-'), 'ran');
  const helper = join(scratch('pc-wg-helper-'), 'helper.sh');
  writeFileSync(helper, `#!/bin/sh\necho "$*" >> '${ours}'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(global, `[credential "https://x.example.invalid"]\n\thelper = !'${helper}'\n[core]\n\tsshCommand = ssh -o BatchMode=yes\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_TERMINAL_PROMPT: '0' };
  const hardened = hardenedGitEnv(env);
  assert.equal(hardened.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes', 'the operator\'s own ssh command, never the tree\'s');
  assert.equal(hardened.GIT_CONFIG_NOSYSTEM, '1');
  // `git credential fill` asks every helper in turn; with none answering it fails — what matters is who was asked.
  try {
    execFileSync('git', ['credential', 'fill'], {
      cwd: dir, env: hardened, input: 'protocol=https\nhost=x.example.invalid\n\n', stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch { /* no helper answered — expected */ }
  assert.equal(existsSync(marker), false, `a planted helper ran: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
  assert.ok(existsSync(ours), 'the operator\'s global helper was asked');
});

test('WG-3 (#272): a caller\'s own command-scope keys survive, ahead of the hardening', () => {
  const env = hardenedGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', HOME: '/nonexistent' });
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
  assert.equal(env.GIT_CONFIG_VALUE_0, '/dev/null');
  const keys = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]);
  for (const key of ['core.hooksPath', 'core.fsmonitor', 'core.pager', 'core.askPass', 'protocol.ext.allow', 'credential.helper',
    'commit.gpgSign', 'tag.gpgSign']) {
    assert.ok(keys.includes(key), `${key} is neutralised`);
  }
});

test('WG-4 (#272): the reader finds what was planted — through an include, a gitfile, a URL-scoped helper, a driver — and nothing that was there before', () => {
  const { dir, script } = plantedRepo();
  sh(dir, 'config', 'core.hooksPath', 'scripts/git-hooks');
  const before = treeConfigBaseline(configTreesOf(dir, []));
  assert.deepEqual(before.get(dir), ['core.hookspath=scripts/git-hooks'], 'a key the repository already had is the baseline');
  assert.deepEqual(plantedSince(before), [], 'nothing new, nothing planted');

  const extra = join(dir, '.git', 'extra.cfg');
  writeFileSync(extra, `[filter "x"]\n\tclean = ${script}\n[diff "y"]\n\ttextconv = ${script}\n`);
  sh(dir, 'config', 'include.path', 'extra.cfg');
  sh(dir, 'config', 'credential.https://x.example.invalid.helper', script);
  sh(dir, 'config', 'alias.st', '!sh -c true');
  const planted = plantedSince(before).map((p) => p.key).sort();
  assert.deepEqual(planted, ['alias.st', 'credential.https://x.example.invalid.helper', 'diff.y.textconv', 'filter.x.clean', 'include.path']);
  assert.ok(readTreeConfig(dir).includes('core.hookspath=scripts/git-hooks'));

  // A linked worktree reads its common directory's config through its gitfile.
  const lane = join(scratch('pc-wg-linked-'), 'lane');
  sh(dir, 'worktree', 'add', '-q', '--detach', lane);
  const linked = treeConfigBaseline([lane]);
  sh(dir, 'config', 'core.fsmonitor', script);
  assert.deepEqual(plantedSince(linked).map((p) => p.key), ['core.fsmonitor'], 'planted in the common config, seen from the lane');
  // A comment's trailing backslash does not continue it — the key on the next line is git's, so it is ours.
  const hidden = plantedRepo();
  const configFile = join(hidden.dir, '.git', 'config');
  writeFileSync(configFile, `${readFileSync(configFile, 'utf8')}[core]\n\t# a note \\\n\tfsmonitor = ${hidden.script}\n`);
  assert.equal(sh(hidden.dir, 'config', '--get', 'core.fsmonitor').trim(), hidden.script, 'git reads the key after the comment');
  assert.ok(readTreeConfig(hidden.dir).includes(`core.fsmonitor=${hidden.script}`), 'and so does the reader');
  // The other command-running keys.
  const more = treeConfigBaseline([hidden.dir]);
  for (const [key, value] of [['pager.status', script], ['commit.gpgSign', 'true'], ['hook.x.command', script],
    ['submodule.s.update', `!${script}`], ['gpg.ssh.defaultKeyCommand', script], ['core.alternateRefsCommand', script]]) {
    sh(hidden.dir, 'config', key!, value!);
  }
  assert.deepEqual(plantedSince(more).map((p) => p.key).sort(), ['commit.gpgsign', 'core.alternaterefscommand',
    'gpg.ssh.defaultkeycommand', 'hook.x.command', 'pager.status', 'submodule.s.update']);
  // `all` reads every submodule `.gitmodules` names; a path that leaves the root is not one.
  writeFileSync(join(dir, '.gitmodules'), '[submodule "a"]\n\tpath = sub/a\n[submodule "b"]\n\tpath = ../escape\n');
  assert.deepEqual(configTreesOf(dir, ['all']), [dir, join(dir, 'sub/a')]);
  assert.deepEqual(configTreesOf(dir, ['phased-execution']), [dir, join(dir, 'phased-execution')]);
});

test('WG-5 (#272): a lane whose session plants core.hooksPath halts run-tree-config, naming the key, before verification — and the hook never ran', async () => {
  assert.ok((PHASE_HALT_KINDS as readonly string[]).includes('run-tree-config'), 'a phase-level halt');
  const { dir: root, marker, script } = plantedRepo();
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
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
  let verified = 0;
  const runner = new Runner({
    scriptsDir,
    spawn: async () => {
      plant(root, script);
      writeFileSync(join(root, '.done-1'), '');
      return {
        signal: { subtype: 'success' as const, code: 0, text: 'done' },
        sessionId: 'sid-wg', costUsd: 0, turns: 1, resultText: 'done', durationMs: 1, argv: [],
      };
    },
    verify: async () => { verified += 1; return { ok: true, reason: 'green', notRun: [], ran: [] }; },
    verificationText: () => '`true`',
  } as never);
  const state = await runner.start({ slug: 'demo', root, autonomy: 'keep-going' });
  await runner.wait();

  const halt = state.phases['1']?.halt ?? state.halt;
  assert.equal(halt?.kind, 'run-tree-config', JSON.stringify({ halt: state.halt, record: state.phases['1'] }));
  assert.match(halt?.reason ?? '', /core\.hookspath/);
  assert.match(halt?.reason ?? '', /core\.fsmonitor/);
  assert.equal(verified, 0, 'no verification ran in a tree the console will not run git in');
  const lines = readFileSync(journalFile(root, state.slug, state.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const line = lines.find((l) => l.event === 'phase.run-tree-config');
  assert.ok(line, 'journalled');
  assert.deepEqual(line.data.keys, ['core.fsmonitor', 'core.hookspath']);
  assert.equal(existsSync(marker), false, `the planted hook ran: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`);
});
