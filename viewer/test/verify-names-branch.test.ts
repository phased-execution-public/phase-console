/**
 * Every verdict says what it compared (control-tower phase 40, #41 ask 3).
 *
 * The measured false reds read a sibling run's branch and said nothing about
 * it: "running box state ≠ repos" with no hint that "repos" meant another
 * plan's unmerged work. Every verification record now carries
 * `{repo, branch, head}` for the repository it ran in, every scoped one, every
 * one a command reached, and every other repository under the run's root —
 * and a verify-failed halt's FIRST line names them. A record stored before
 * this phase reads back without the fields and renders without them.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_SESSION_ID']) delete process.env[key];

const { Runner } = await import('../server/runner/runner.ts');
const { journalFile, loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { comparedClause, stampTrees, stampWords } = await import('../server/runner/tree-state.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type VerifySummary = import('../server/runner/state.ts').VerifySummary;

function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p40', GIT_AUTHOR_EMAIL: 'p40@example.invalid',
      GIT_COMMITTER_NAME: 'p40', GIT_COMMITTER_EMAIL: 'p40@example.invalid',
    },
  })).trim();
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repoAt(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', `${name} base`);
}

/** A superproject with `app` and `api` under it, and a one-phase stub board. */
function estate() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-verify-names-')));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), '# alpha\n');
  writeFileSync(join(stub, 'done'), '');
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${stub}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(root, '.gitmodules'),
    '[submodule "app"]\n\tpath = app\n\turl = ./app\n[submodule "api"]\n\tpath = api\n\turl = ./api\n');
  writeFileSync(join(root, '.gitignore'), '.stub/\napp/\napi/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  repoAt(join(root, 'app'), 'app');
  repoAt(join(root, 'api'), 'api');
  return { root, scripts, stub, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type Estate = ReturnType<typeof estate>;

/** A Runner whose session finishes phase 1 and whose verification is `verify`. */
function runner(e: Estate, text: string, verify: (cwd: string) => VerifySummary) {
  const spawn: SpawnFn = async () => {
    appendFileSync(join(e.stub, 'done'), '1\n');
    return {
      signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-1', costUsd: 0, turns: 1,
      resultText: 'done', durationMs: 1, argv: ['-p', '<prompt>'],
    } as never;
  };
  return new Runner({
    scriptsDir: e.scripts, spawn,
    verificationText: () => text,
    verifyIn: () => 'app',
    phaseScope: () => ['app'],
    verify: async (_text: string, opts: { cwd: string }) => verify(opts.cwd),
  } as never);
}

const GREEN: VerifySummary = {
  ok: true, reason: '2 commands green',
  ran: [
    { command: 'npm test', ok: true, code: 0, ms: 5, output: 'ok' },
    { command: 'cd ../api && git status --short', ok: true, code: 0, ms: 5, output: '' },
  ],
  notRun: [],
};

test('VN-1 — a verification record carries {repo, branch, head} for the repository it ran in, the scoped ones, the ones a command reached, and every other one under the root', async () => {
  const e = estate();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pc-verify-outside-')));
  repoAt(outside, 'outside');
  try {
    let cwd = '';
    const r = runner(e, `- \`npm test\`\n- \`cd ../api && git status --short\`\n- \`git -C ${outside} log -1\``, (at) => {
      cwd = at;
      return GREEN;
    });
    await r.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    await r.wait();
    const state = r.current()!;
    assert.equal(realpathSync(cwd), join(e.root, 'app'), 'the commands ran in the Verify in: repository');
    const verification = state.phases['1'].verification!;
    const byRepo = new Map((verification.trees ?? []).map((stamp) => [stamp.repo, stamp]));
    const appHead = git(join(e.root, 'app'), 'rev-parse', 'HEAD');
    assert.deepEqual(byRepo.get('app'), { repo: 'app', branch: 'main', head: appHead, role: 'verify-in' });
    assert.equal(byRepo.get('api')?.role, 'named', 'reached with cd');
    assert.equal(byRepo.get(outside)?.role, 'named', 'a repository outside the root, reached with git -C');
    assert.equal(byRepo.get(outside)?.branch, 'main');
    assert.equal(byRepo.get(basename(e.root))?.role, 'sibling', 'the superproject itself — a command can read it by path');
    assert.equal(verification.trees?.[0]?.role, 'verify-in', 'the repository it ran in comes first');
    for (const ran of verification.ran) {
      assert.deepEqual(ran.tree, { repo: 'app', branch: 'main', head: appHead }, `${ran.command} names what it ran against`);
    }
    const line = readFileSync(journalFile(e.root, 'alpha', state.id), 'utf8').trim().split('\n')
      .map((raw) => JSON.parse(raw) as { event: string; data: Record<string, unknown> })
      .find((entry) => entry.event === 'phase.verify');
    assert.ok(Array.isArray(line?.data.trees), 'the journal line says it too');
    assert.equal(GREEN.ran[0].tree, undefined, 'a summary the verifier returned is copied, never mutated');
  } finally {
    e.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('VN-2 — a verify-failed halt\'s first line names the branch and head it compared against', async () => {
  const e = estate();
  // The measured case: the Verify in: repository stands on another plan's branch.
  git(join(e.root, 'app'), 'checkout', '-q', '-b', 'pe/beta');
  try {
    const r = runner(e, '- `npm test`', () => {
      // The board moves under the verification — so it is a halt, not a note.
      writeFileSync(join(e.stub, 'done'), '');
      return {
        ok: false, reason: '`npm test` exited 1',
        ran: [{ command: 'npm test', ok: false, code: 1, ms: 5, output: '13 failing' }], notRun: [],
      };
    });
    await r.start({ slug: 'alpha', root: e.root, autonomy: 'keep-going' } as never);
    await r.wait();
    const state = r.current()!;
    const halt = state.phases['1'].halt ?? state.halt;
    assert.equal(halt?.kind, 'verify-failed', JSON.stringify(state.phases['1']));
    const first = halt!.reason.split('\n')[0];
    const head = git(join(e.root, 'app'), 'rev-parse', 'HEAD').slice(0, 10);
    assert.match(first, /^phase 1 did not verify/, 'the classifier\'s words stay where they were');
    assert.ok(first.includes(`compared against app@pe/beta ${head}`), first);
  } finally {
    e.cleanup();
  }
});

test('VN-3 — a record stored before stamps existed reads back without them and renders without them', async () => {
  const e = estate();
  try {
    const stored = newRun({ slug: 'alpha', root: e.root });
    const record = phaseRecord(stored, 1);
    record.status = 'failed';
    record.verification = {
      ok: false, reason: '`npm test` exited 1',
      ran: [{ command: 'npm test', ok: false, code: 1, ms: 40, output: '1 failing' }], notRun: [],
    };
    saveRun(stored);
    const back = loadRun(e.root, 'alpha', stored.id)!;
    assert.equal(back.phases['1'].verification?.trees, undefined);
    assert.equal(back.phases['1'].verification?.ran[0].tree, undefined);
    assert.equal(comparedClause(back.phases['1'].verification?.trees), '', 'no clause, and no empty parentheses');
    assert.equal(comparedClause([]), '');
  } finally {
    e.cleanup();
  }
});

test('the stamp words: repo@branch head, a detached HEAD named as such, the rest counted', async () => {
  assert.equal(stampWords({ repo: 'app', branch: 'pe/beta', head: '0b910f26aa11bb22' }), 'app@pe/beta 0b910f26aa');
  assert.equal(stampWords({ repo: 'app', branch: null, head: null }), 'app@detached (no commit)');
  const clause = comparedClause([
    { repo: 'hetzner', branch: 'pe/ai-builder', head: '0b910f2600', role: 'verify-in' },
    { repo: 'aws', branch: 'main', head: '26af361900', role: 'sibling' },
    { repo: 'trade', branch: 'main', head: '6c6c59a600', role: 'sibling' },
  ]);
  assert.equal(clause, ' (compared against hetzner@pe/ai-builder 0b910f2600 and 2 more repositories)');
  const e = estate();
  try {
    const stamps = await stampTrees({ root: e.root, cwd: join(e.root, 'api'), scope: ['app'] });
    assert.deepEqual(stamps.map((s) => `${s.repo}:${s.role}`), ['api:verify-in', 'app:scope', `${basename(e.root)}:sibling`]);
  } finally {
    e.cleanup();
  }
});
