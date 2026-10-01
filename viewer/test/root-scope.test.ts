/**
 * The docs root is declared scope (control-tower phase 63, #88).
 *
 * Every phase of every plan commits its handoff and its lock into ONE root
 * index, and 142 of 180 lanes over a week never said so — the scheduler, told
 * nothing, admitted lanes it considered disjoint to write that one index at
 * once. The fix has two halves, and these tests hold both:
 *
 *   RS-1  the per-slug path token, `docs/handoffs/<slug>`, is one word in two
 *         languages — `rootScopeToken` (shared/scope.js) and `scope_root_token`
 *         (scripts/scope.sh) — and it names the root's docs and nothing else;
 *   RS-2  it is DECLARED, never admitted on: the boot prompt names it, the
 *         drift credit counts a write inside it as the phase's own, and the
 *         claim a session is told to make carries only its Repos cell — so a
 *         plan's own lanes on disjoint repositories stay parallel;
 *   RS-3  what orders the writes instead is the docs root's critical section in
 *         `phase-lock.sh`, around every commit and every rebase it makes there
 *         and nothing longer: two mirrors at once both land, one path each, and
 *         a held section makes a writer wait, then step aside.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatScope, rootScopeToken, scopesIntersect, tokensIntersect } from '../shared/scope.js';
import { declaredScope } from '../server/runner/scope-drift.ts';

const SCRIPTS = fileURLToPath(new URL('../../scripts/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/plans/', import.meta.url));

/** A child env with no session channel in it — the console's own PE_* must not leak into a script under test. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PE_') || key === 'DOCS_ROOT' || key === 'TRACEPARENT') continue;
    env[key] = value;
  }
  return { ...env, PHASE_OUTCOME_PROBE: '0', ...extra };
}

function bash(script: string, args: string[], env: NodeJS.ProcessEnv): { code: number; out: string } {
  const run = spawnSync('/bin/bash', [join(SCRIPTS, script), ...args], { env, encoding: 'utf8' });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** A docs root with one fixture plan (two slugs of it) and, optionally, a git repository with one commit. */
function docsRoot(opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'root-scope-'));
  for (const slug of ['alpha', 'beta']) {
    mkdirSync(join(root, 'docs', 'handoffs', slug), { recursive: true });
    cpSync(join(FIXTURES, 'linear.md'), join(root, 'docs', 'plans', `${slug}.md`));
  }
  if (opts.git) {
    git(root, 'init', '-q', '-b', 'main', '.');
    git(root, 'config', 'user.email', 't@t.t');
    git(root, 'config', 'user.name', 't');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'init');
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * RS-1 — the token, in both languages
 * ------------------------------------------------------------------ */

test('RS-1: rootScopeToken names the plan\'s own handoff folder, folded — and nothing for a slug that is not one token', () => {
  assert.equal(rootScopeToken('control-tower'), 'docs/handoffs/control-tower');
  assert.equal(rootScopeToken('Control-Tower'), 'docs/handoffs/control-tower');
  assert.equal(rootScopeToken('`many-plans-one-repo`'), 'docs/handoffs/many-plans-one-repo');
  assert.equal(rootScopeToken(''), '');
  assert.equal(rootScopeToken('two words'), '');
  assert.equal(rootScopeToken('a, b'), '');
});

test('RS-1: the bash twin answers exactly what the JS one does, slug for slug', () => {
  const slugs = ['control-tower', 'Control-Tower', 'phase-console-commerce', 'zero-touch-console', 'a', 'two words', '', 'x.y'];
  const script = `. "${join(SCRIPTS, 'scope.sh')}"; for s in "$@"; do printf '%s\\n' "$(scope_root_token "$s")"; done`;
  const run = spawnSync('/bin/bash', ['-c', script, 'bash', ...slugs], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const bashSays = run.stdout.split('\n').slice(0, slugs.length);
  assert.deepEqual(bashSays, slugs.map((slug) => rootScopeToken(slug)));
});

test('RS-1: the token meets the root\'s docs and never another plan\'s token, a longer slug, or a submodule', () => {
  const alpha = rootScopeToken('alpha');
  assert.ok(tokensIntersect(alpha, 'docs'));
  assert.ok(tokensIntersect(alpha, 'docs/handoffs'));
  assert.ok(tokensIntersect(alpha, 'docs/handoffs/alpha/.locks/phase-01.lock'));
  assert.ok(!tokensIntersect(alpha, rootScopeToken('beta')));
  assert.ok(!tokensIntersect(alpha, rootScopeToken('alpha-two')));
  assert.ok(!tokensIntersect(alpha, 'phased-execution'));
  assert.ok(!tokensIntersect(alpha, 'docs/plans'));
});

/* ------------------------------------------------------------------ *
 * RS-2 — declared, never admitted on
 * ------------------------------------------------------------------ */

test('RS-2: the declared scope adds the token once; the claim form (formatScope of the Repos cell) never carries it', () => {
  assert.deepEqual(declaredScope(['phased-execution'], 'control-tower'), ['phased-execution', 'docs/handoffs/control-tower']);
  assert.deepEqual(declaredScope(['phased-execution', 'docs/handoffs/control-tower'], 'control-tower'),
    ['phased-execution', 'docs/handoffs/control-tower']);
  assert.equal(formatScope(['phased-execution']), 'phased-execution');
  // Two lanes of one plan on disjoint repositories: their DECLARED scopes meet
  // on the token — which is exactly why admission must never carve on it.
  const a = ['api-server'];
  const b = ['web-app'];
  assert.ok(!scopesIntersect(a, b), 'the Repos cells are disjoint, so the lanes run side by side');
  assert.ok(scopesIntersect(declaredScope(a, 'alpha'), declaredScope(b, 'alpha')),
    'carving on the declared scope would serialise every phase of the plan');
});

test('RS-2: an autopilot boot prompt names the token and claims file-only on the Repos cell alone', () => {
  const root = docsRoot();
  try {
    const prompt = bash('phase-graph.sh', ['alpha', '--boot-prompt', '1'], cleanEnv({ DOCS_ROOT: root, PE_LOCK_MIRROR: 'console' }));
    assert.equal(prompt.code, 0, prompt.out);
    assert.match(prompt.out, /plus, in the docs root, `docs\/handoffs\/alpha` — your handoff and lock writes/);
    const lockLines = prompt.out.split('\n').filter((line) => line.includes('phase-lock.sh alpha '));
    assert.equal(lockLines.length, 2, prompt.out);
    for (const line of lockLines) {
      assert.doesNotMatch(line, /--git/, 'the console mirrors the lock; the session never passes --git');
      assert.doesNotMatch(line, /docs\/handoffs/, 'the token is declared, never claimed');
    }
    assert.match(prompt.out, /FILE-ONLY under this autopilot/);
    // A person reading the copyable prompt still mirrors by hand.
    const hand = bash('phase-graph.sh', ['alpha', '--boot-prompt', '1'], cleanEnv({ DOCS_ROOT: root }));
    assert.equal(hand.out.split('\n').filter((line) => line.includes('phase-lock.sh alpha ') && line.includes('--git')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RS-2: a lock claimed under the console carries no root token, and a plan\'s lanes on disjoint repos do not collide', () => {
  const root = docsRoot();
  try {
    const env = cleanEnv({ DOCS_ROOT: root, PE_LOCK_MIRROR: 'console' });
    const a = bash('phase-lock.sh', ['alpha', 'claim', '1', '--owner', 'autopilot/r1', '--scope', 'api-server'], env);
    assert.equal(a.code, 0, a.out);
    const b = bash('phase-lock.sh', ['alpha', 'conflicts', '2', '--owner', 'autopilot/r1-b', '--scope', 'web-app'], env);
    assert.equal(b.code, 0, b.out);
    const lock = spawnSync('cat', [join(root, 'docs', 'handoffs', 'alpha', '.locks', 'phase-01.lock')], { encoding: 'utf8' }).stdout;
    assert.match(lock, /^scope=api-server$/m);
    assert.doesNotMatch(lock, /docs\/handoffs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * RS-3 — the critical section orders the root's commits and merges
 * ------------------------------------------------------------------ */

function runAsync(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [join(SCRIPTS, script), ...args], { env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

test('RS-3: two plans mirroring at once both land — one commit each, one path each, and no section left behind', async () => {
  const root = docsRoot({ git: true });
  try {
    const env = cleanEnv({ DOCS_ROOT: root, PE_LOCK_MIRROR: 'console' });
    assert.equal(bash('phase-lock.sh', ['alpha', 'claim', '1', '--owner', 'autopilot/a', '--scope', 'api'], env).code, 0);
    assert.equal(bash('phase-lock.sh', ['beta', 'claim', '2', '--owner', 'autopilot/b', '--scope', 'web'], env).code, 0);
    const [left, right] = await Promise.all([
      runAsync('phase-lock.sh', ['alpha', 'mirror', '1'], env),
      runAsync('phase-lock.sh', ['beta', 'mirror', '2'], env),
    ]);
    assert.match(left.out, /phase 1: mirrored \(claim\)/, left.out);
    assert.match(right.out, /phase 2: mirrored \(claim\)/, right.out);
    const subjects = git(root, 'log', '--format=%s', '-2').split('\n').sort();
    assert.deepEqual(subjects, [
      'phase-lock: claim phase 1 (alpha) by autopilot/a',
      'phase-lock: claim phase 2 (beta) by autopilot/b',
    ]);
    for (const rev of ['HEAD', 'HEAD~1']) {
      assert.equal(git(root, 'show', '--name-only', '--format=', rev).split('\n').length, 1, `${rev} carries exactly one path`);
    }
    assert.ok(!existsSync(join(root, '.git', 'pe-root-section')), 'the section is released with its writer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RS-3: a held section makes the mirror wait, then step aside UNMIRRORED — and the next mirror commits it', () => {
  const root = docsRoot({ git: true });
  try {
    const env = cleanEnv({ DOCS_ROOT: root, PE_LOCK_MIRROR: 'console' });
    assert.equal(bash('phase-lock.sh', ['alpha', 'claim', '1', '--owner', 'autopilot/a', '--scope', 'api'], env).code, 0);
    const section = join(root, '.git', 'pe-root-section');
    mkdirSync(section);
    writeFileSync(join(section, 'at'), `${Math.floor(Date.now() / 1000)}\n`);
    const held = bash('phase-lock.sh', ['alpha', 'mirror', '1'], { ...env, PE_ROOT_SECTION_WAIT: '1' });
    assert.equal(held.code, 0, 'never fatal');
    assert.match(held.out, /UNMIRRORED: phase 1/);
    assert.equal(git(root, 'rev-list', '--count', 'HEAD'), '1', 'nothing committed while another writer held the root');
    assert.ok(existsSync(section), 'somebody else\'s section is theirs to remove');
    rmSync(section, { recursive: true, force: true });
    const next = bash('phase-lock.sh', ['alpha', 'mirror', '1'], env);
    assert.match(next.out, /phase 1: mirrored \(claim\)/, next.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RS-3: the rebase — the root\'s merge — is inside the section too: a hand session\'s pull steps aside while it is held', () => {
  const root = docsRoot({ git: true });
  try {
    const section = join(root, '.git', 'pe-root-section');
    mkdirSync(section);
    writeFileSync(join(section, 'at'), `${Math.floor(Date.now() / 1000)}\n`);
    const pulled = bash('phase-lock.sh', ['alpha', 'conflicts', '1', '--scope', 'api', '--git'],
      cleanEnv({ DOCS_ROOT: root, PE_ROOT_SECTION_WAIT: '1', PE_GIT_RETRIES: '1', PE_GIT_RETRY_DELAY: '0' }));
    assert.match(pulled.out, /critical section stayed held for 1s — pull skipped/, pulled.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
