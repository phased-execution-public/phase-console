/**
 * The plugin, light (measured-console phase 10, the audit's A11).
 *
 * `scripts/build-plugin-tree.mjs` materializes the skill — SKILL.md,
 * references/, scripts/, templates/, hooks/hooks.json, the one console module
 * the scripts reach for, a plugin.json and a one-entry marketplace.json — from
 * one revision, at most 5 MB, stamped with the revision and PE_API; the
 * repository root keeps no plugin.json. `server/plugin-tree.ts` builds it under
 * the instance's state at boot and prunes the old ones.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const { MAX_BYTES, buildPluginTree, firstParagraph } = await import('../../scripts/build-plugin-tree.mjs');
const { ensurePluginTree, pluginDirFor, pluginTreesDir } = await import('../server/plugin-tree.ts');

function put(root: string, rel: string, body: string | Buffer, mode?: number): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  if (mode) chmodSync(join(root, rel), mode);
}

/** Every file under a tree, relative, sorted. */
function walk(root: string, sub = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, sub)).sort()) {
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel)); else out.push(rel);
  }
  return out;
}

/** A small repository shaped like this one, committed — what `--rev` reads. */
function fixtureRepo(): { root: string; rev: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-ptree-'));
  put(root, 'SKILL.md', '---\nname: phased-execution\ndescription: "the skill"\n---\n# skill\n');
  put(root, 'references/mode-plan.md', '# plan\n');
  put(root, 'scripts/skill-api.env', 'PE_API=3\nPE_API_MIN=2\n');
  put(root, 'scripts/phase-graph.sh', '#!/usr/bin/env bash\necho board\n', 0o755);
  put(root, 'scripts/.DS_Store', 'junk');
  put(root, 'templates/plan.md', '# template\n');
  put(root, 'hooks/hooks.json', readFileSync(join(REPO, 'hooks', 'hooks.json')));
  put(root, 'LICENSE', 'MIT\n');
  put(root, 'viewer/shared/instances.mjs', "import { A } from './dep.js';\nexport const B = A;\n");
  put(root, 'viewer/shared/dep.js', 'export const A = 1;\n');
  put(root, 'viewer/shared/unrelated.js', 'export const C = 2;\n');
  put(root, 'viewer/server/huge.ts', 'console;\n');
  put(root, 'assets/console.gif', 'GIF89a');
  put(root, '.claude-plugin/marketplace.json', readFileSync(join(REPO, '.claude-plugin', 'marketplace.json')));
  put(root, 'package.json', '{"version":"9.9.9"}\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return { root, rev: git('rev-parse', 'HEAD'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the tree from a revision carries the skill and only the skill, stamped with the revision and PE_API', () => {
  const repo = fixtureRepo();
  const out = join(repo.root, '..', `${relative(tmpdir(), repo.root)}-out`);
  const summary = buildPluginTree({ out, root: repo.root, rev: 'HEAD' });
  assert.equal(summary.rev, repo.rev);
  assert.deepEqual(walk(out), [
    '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.plugin-tree', 'LICENSE', 'SKILL.md',
    'hooks/hooks.json', 'plugin-stamp.json', 'references/mode-plan.md', 'scripts/phase-graph.sh', 'scripts/skill-api.env',
    'templates/plan.md', 'viewer/shared/dep.js', 'viewer/shared/instances.mjs',
  ], 'no console, no GIF, no unrelated shared module — the imports of instances.mjs only');
  assert.equal(statSync(join(out, 'scripts', 'phase-graph.sh')).mode & 0o111, 0o111, 'an executable script stays executable');
  const stamp = JSON.parse(readFileSync(join(out, 'plugin-stamp.json'), 'utf8'));
  assert.deepEqual({ rev: stamp.rev, version: stamp.version, peApi: stamp.peApi, peApiMin: stamp.peApiMin },
    { rev: repo.rev, version: '9.9.9', peApi: 3, peApiMin: 2 });
  const manifest = JSON.parse(readFileSync(join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'phased-execution');
  assert.equal(manifest.version, repo.rev.slice(0, 12), 'the version Claude Code caches under moves with the revision');
  assert.equal(manifest.hooks, undefined, 'hooks/hooks.json loads by its place; naming it again would load every hook twice');
  assert.ok(manifest.description.length > 0 && manifest.description.length <= 1536);
  const market = JSON.parse(readFileSync(join(out, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(market.name, 'phased-execution-public');
  assert.deepEqual(market.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [['phased-execution', './']]);
  rmSync(out, { recursive: true, force: true });
  repo.cleanup();
});

test('the tree is deterministic: the same revision gives the same bytes', () => {
  const repo = fixtureRepo();
  const a = mkdtempSync(join(tmpdir(), 'pc-ptree-a-'));
  const b = mkdtempSync(join(tmpdir(), 'pc-ptree-b-'));
  buildPluginTree({ out: join(a, 't'), root: repo.root, rev: repo.rev });
  buildPluginTree({ out: join(b, 't'), root: repo.root, rev: repo.rev });
  const files = walk(join(a, 't'));
  assert.deepEqual(walk(join(b, 't')), files);
  for (const rel of files) assert.ok(readFileSync(join(a, 't', rel)).equals(readFileSync(join(b, 't', rel))), rel);
  for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true });
  repo.cleanup();
});

test('a tree over 5 MB is refused, and so is an --out that holds something else', () => {
  const repo = fixtureRepo();
  put(repo.root, 'references/huge.bin', Buffer.alloc(MAX_BYTES + 1));
  const dir = mkdtempSync(join(tmpdir(), 'pc-ptree-big-'));
  assert.throws(() => buildPluginTree({ out: join(dir, 't'), root: repo.root, rev: null }), /over the 5242880-byte ceiling/);
  assert.equal(existsSync(join(dir, 't')), false, 'nothing is left behind');
  put(dir, 'mine/notes.txt', 'a person\'s file');
  assert.throws(() => buildPluginTree({ out: join(dir, 'mine'), root: repo.root, rev: 'HEAD' }), /not a plugin tree/);
  assert.equal(readFileSync(join(dir, 'mine', 'notes.txt'), 'utf8'), 'a person\'s file');
  rmSync(dir, { recursive: true, force: true });
  repo.cleanup();
});

test('this repository\'s own tree is at most 5 MB with hooks/hooks.json and a plugin.json — and the repository root has no plugin.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-ptree-repo-'));
  const summary = buildPluginTree({ out: join(dir, 't'), root: REPO, rev: null });
  assert.ok(summary.bytes <= MAX_BYTES, `${summary.bytes} bytes`);
  for (const rel of ['SKILL.md', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json',
    'scripts/session-hook.sh', 'scripts/instance.sh', 'scripts/skill-api.env', 'viewer/shared/instances.mjs', 'references/scripts.md']) {
    assert.ok(existsSync(join(dir, 't', rel)), rel);
  }
  assert.equal(existsSync(join(dir, 't', 'viewer', 'server')), false);
  assert.equal(existsSync(join(REPO, '.claude-plugin', 'plugin.json')), false, 'the root stays a bare skill (its CLAUDE.md)');
  assert.equal(existsSync(join(REPO, 'assets', 'console.gif')), false, 'the 33 MB screencast has left the tree');
  rmSync(dir, { recursive: true, force: true });
});

test('the description is cut to its first paragraph, under the listing\'s 1,536-character entry cap', () => {
  assert.equal(firstParagraph('one two.\n\nsecond paragraph'), 'one two.');
  const long = firstParagraph('word '.repeat(600));
  assert.ok(long.length <= 1536 && long.endsWith('…'));
});

test('the console builds its revision\'s tree under the instance state once, answers pluginDirFor, and prunes old revisions to two', async () => {
  const repo = fixtureRepo();
  const state = mkdtempSync(join(tmpdir(), 'pc-ptree-state-'));
  const first = await ensurePluginTree({ root: repo.root, stateDir: state });
  assert.ok(first, 'built');
  assert.equal(first.rev, repo.rev);
  assert.equal(first.built, true);
  assert.equal(first.dir, join(pluginTreesDir(state), repo.rev));
  assert.equal(pluginDirFor(repo.rev, state), first.dir);
  const again = await ensurePluginTree({ root: repo.root, stateDir: state });
  assert.equal(again?.built, false, 'a tree of this revision is left alone');

  // Three older trees, one of them not the builder's: two are kept in all, the stranger never touched.
  const base = pluginTreesDir(state);
  for (const [i, name] of ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].entries()) {
    put(base, `${name}/.plugin-tree`, '');
    put(base, `${name}/plugin-stamp.json`, `{"rev":"${name}"}`);
    const t = Date.now() / 1000 - 100 * (i + 1);
    utimesSync(join(base, name), t, t);
  }
  put(base, 'someone-else/file', 'x');
  const pruned = await ensurePluginTree({ root: repo.root, stateDir: state });
  assert.deepEqual(pruned?.pruned.sort(), ['b'.repeat(40), 'c'.repeat(40)]);
  assert.ok(existsSync(join(base, 'a'.repeat(40))), 'the newest older tree stays — a session may still run from it');
  assert.ok(existsSync(join(base, 'someone-else', 'file')));
  assert.equal(pluginDirFor('d'.repeat(40), state), null);
  rmSync(state, { recursive: true, force: true });
  repo.cleanup();
});

test('a checkout git cannot read builds from its files, and a build that fails answers null rather than throwing', async () => {
  const repo = fixtureRepo();
  rmSync(join(repo.root, '.git'), { recursive: true, force: true });
  const state = mkdtempSync(join(tmpdir(), 'pc-ptree-pkg-'));
  const built = await ensurePluginTree({ root: repo.root, stateDir: state });
  assert.equal(built?.rev, null);
  assert.equal(built?.dir, join(pluginTreesDir(state), 'worktree-9.9.9'));
  rmSync(join(repo.root, 'SKILL.md'));
  rmSync(join(pluginTreesDir(state)), { recursive: true, force: true });
  assert.equal(await ensurePluginTree({ root: repo.root, stateDir: state }), null);
  rmSync(state, { recursive: true, force: true });
  repo.cleanup();
});
