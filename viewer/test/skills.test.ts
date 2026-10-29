/**
 * Finding the skills a phase could invoke.
 *
 * Every case here is one that a real machine turned up rather than one that
 * looked plausible: skills nested under a plugin's own `.claude/skills`, a
 * plugin whose entry point is a `commands/*.md` file with no name in its front
 * matter at all, several installed versions of the same plugin sitting side by
 * side in the cache, and descriptions written as YAML block scalars.
 */

import '../e2e/fixture/steady-load.mjs';
import './signed-in.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';
// Sandbox BOTH homes before anything under ../server resolves them — the
// belt in shared/instances.mjs throws on a test reaching the real dirs.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-sbx-'));
process.env.XDG_CONFIG_HOME = join(process.env.XDG_STATE_HOME, 'config');

const {
  listSkills, forgetSkills, skillDirective, claudeHome, installedPlugins, qualifySkill,
  knowledgeGraphDirective, graphFreshness, freshGraphs,
} = await import('../server/skills.ts');
const { refreshGraphs } = await import('../server/runner/graph-refresh.ts');

function file(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

function skill(path: string, name: string, description = `about ${name}`): void {
  file(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

type World = { home: string; root: string; env: NodeJS.ProcessEnv; cleanup: () => void };

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'pc-skills-'));
  const home = join(dir, 'home');
  const root = join(dir, 'repo');

  skill(join(home, 'skills', 'investigate'), 'investigate', 'systematic debugging');
  skill(join(root, '.claude', 'skills', 'db-context'), 'db-context');

  // A folded block scalar, which is how a paragraph-long description is
  // actually written — and which naive parsing reduces to the character ">".
  file(join(root, '.claude', 'skills', 'wordy', 'SKILL.md'),
    '---\nname: wordy\ndescription: >\n  A long description that runs\n  across several lines.\n---\n\n# wordy\n');

  // Two installs of one plugin: only the recorded one is what a session loads.
  const installed = join(home, 'plugins', 'cache', 'market', 'toolkit', '2.0.0');
  const stale = join(home, 'plugins', 'cache', 'market', 'toolkit', '1.0.0');
  skill(join(installed, 'skills', 'deploy'), 'deploy', 'ship it');
  skill(join(stale, 'skills', 'ghost'), 'ghost', 'an old version nobody loads');

  // Skills nested under the plugin's own `.claude/skills` — a real layout that
  // a blanket dotfile skip made completely invisible.
  const nested = join(home, 'plugins', 'cache', 'market', 'nested', '1.2.3');
  skill(join(nested, '.claude', 'skills', 'design'), 'design', 'visual work');

  // A plugin whose entry point is a command: the name comes from the FILENAME,
  // because a command's front matter carries a description and no name.
  const commanded = join(home, 'plugins', 'cache', 'market', 'feature-dev', 'unknown');
  file(join(commanded, 'commands', 'feature-dev.md'),
    '---\ndescription: Guided feature development\n---\n\nDo the thing.\n');

  file(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'toolkit@market': [
        { scope: 'user', installPath: stale, lastUpdated: '2026-01-01T00:00:00.000Z' },
        { scope: 'user', installPath: installed, lastUpdated: '2026-08-01T00:00:00.000Z' },
      ],
      'nested@market': [{ scope: 'user', installPath: nested, lastUpdated: '2026-08-01T00:00:00.000Z' }],
      'feature-dev@market': [{ scope: 'user', installPath: commanded, lastUpdated: '2026-08-01T00:00:00.000Z' }],
      'uninstalled@market': [{ scope: 'user', installPath: join(dir, 'gone'), lastUpdated: '2026-08-01T00:00:00.000Z' }],
    },
  }));

  forgetSkills();
  return {
    home,
    root,
    env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    cleanup: () => { forgetSkills(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ids = (w: World) => listSkills(w.root, w.env).map((s) => s.id);

test('personal, project and plugin skills are all found, and named as they are invoked', () => {
  const w = world();
  const found = ids(w);
  assert.ok(found.includes('investigate'), 'a personal skill');
  assert.ok(found.includes('db-context'), 'a project skill');
  assert.ok(found.includes('toolkit:deploy'), 'a plugin skill is namespaced by its plugin');
  w.cleanup();
});

test('a plugin that keeps its skills under .claude is not invisible', () => {
  const w = world();
  // Skipping every dot-directory hid an entire real plugin's skills.
  assert.ok(ids(w).includes('nested:design'));
  w.cleanup();
});

test('a plugin whose entry point is a command is found, named after the file', () => {
  const w = world();
  const found = listSkills(w.root, w.env).find((s) => s.id === 'feature-dev:feature-dev');
  assert.ok(found, 'commands are invoked exactly like skills');
  assert.equal(found.description, 'Guided feature development');
  w.cleanup();
});

test('only the installed version of a plugin is offered', () => {
  const w = world();
  const found = ids(w);
  assert.ok(found.includes('toolkit:deploy'));
  assert.ok(!found.includes('toolkit:ghost'), 'an older version in the cache is not loadable');
  w.cleanup();
});

test('a plugin recorded as installed but no longer on disk is skipped', () => {
  const w = world();
  assert.deepEqual(installedPlugins(w.home).filter((p) => p.plugin === 'uninstalled'), []);
  w.cleanup();
});

test('a block-scalar description is read as the paragraph it is', () => {
  const w = world();
  const found = listSkills(w.root, w.env).find((s) => s.id === 'wordy');
  assert.equal(found.description, 'A long description that runs across several lines.');
  w.cleanup();
});

test('the home a session will use decides what is on offer', () => {
  const w = world();
  assert.equal(claudeHome(w.env), w.home);
  // With no project there are no project skills, and nothing throws.
  const noProject = listSkills(undefined, w.env).map((s) => s.id);
  assert.ok(!noProject.includes('db-context'));
  assert.ok(noProject.includes('investigate'));
  w.cleanup();
});

test('a missing home is empty, not an error', () => {
  forgetSkills();
  const found = listSkills(undefined, { ...process.env, CLAUDE_CONFIG_DIR: '/nowhere-at-all' });
  assert.deepEqual(found, []);
  forgetSkills();
});

test('the directive is additive, deduped, a Skill-tool call per skill, and silent when nothing was chosen', () => {
  assert.equal(skillDirective([]), '');
  assert.equal(skillDirective(['', '']), '');
  const text = skillDirective(['investigate', 'toolkit:deploy', 'investigate']);
  // The engine's line's shape (measured-console phase 11): one call per skill, by the name the tool takes.
  assert.match(text, /Call the Skill tool with "investigate"\. Call the Skill tool with "toolkit:deploy"\./);
  assert.doesNotMatch(text, /"investigate"[\s\S]*"investigate"/, 'named once, however many times it was asked for');
  // It must read as an addition. The plan's own skills line comes from the
  // engine, and nothing here may look like it replaced it.
  assert.match(text, /in addition to any the plan names/);
  // A bare name the console's set carries once is qualified by its plugin; two carriers leave it bare.
  assert.match(skillDirective(['tdd'], { loaded: ['mattpocock-skills:tdd', 'superpowers:brainstorming'] }), /"mattpocock-skills:tdd"/);
  assert.match(skillDirective(['tdd'], { loaded: ['a:tdd', 'b:tdd!'] }), /"tdd"/);
  assert.equal(qualifySkill('x:y', ['z:y']), 'x:y', 'a qualified name is the caller\'s');
});

test('the knowledge-graph directive is no longer hung off a list of skills: it names the fresh graphs, and no tool', () => {
  assert.doesNotMatch(skillDirective(['some-graph-skill']), /knowledge graph/i);
  assert.equal(knowledgeGraphDirective([]), '');
  const text = knowledgeGraphDirective(['phased-execution', 'phased-execution']);
  assert.match(text, /knowledge graph newer than the last landing is kept in `phased-execution`:/);
  assert.equal(text.match(/phased-execution/g)?.length, 1, 'each repository once');
  assert.match(text, /session START/, 'query it when not knowing costs the most');
  assert.match(text, /before your handoff/, 'refresh it while what changed is still known');
  assert.match(text, /from inside that repository/, 'a query from the wrong tree answers about the wrong tree');
  assert.doesNotMatch(text, /kgtool|-out\b/, 'the directive names the repositories, never a tool');
});

/** The stub knowledge-graph tool these tests name — the repository names no real one (scrub.sh). */
const TOOL = 'kgtool';

/** A git repository with one commit at `committedAt` (seconds) and, when asked, a graph written at `graphAt`. */
function graphRepo(committedAt: number, graphAt?: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-graph-'));
  const env = { ...process.env, GIT_AUTHOR_DATE: `${committedAt} +0000`, GIT_COMMITTER_DATE: `${committedAt} +0000` };
  execFileSync('git', ['init', '-q', dir], { env });
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', dir, 'add', 'a.txt'], { env });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'a'], { env });
  if (graphAt !== undefined) {
    mkdirSync(join(dir, `${TOOL}-out`), { recursive: true });
    writeFileSync(join(dir, `${TOOL}-out`, 'graph.json'), '{}');
    utimesSync(join(dir, `${TOOL}-out`, 'graph.json'), graphAt, graphAt);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the graph directive\'s freshness rule: absent when the graph is older than the last landing, present when newer, absent with no graph or no tool named', () => {
  const landed = 1_800_000_000;
  const stale = graphRepo(landed, landed - 3600);
  const fresh = graphRepo(landed, landed + 3600);
  const none = graphRepo(landed);
  try {
    assert.equal(graphFreshness(stale.dir, TOOL).fresh, false);
    assert.equal(graphFreshness(stale.dir, TOOL).landedAtMs, landed * 1000);
    assert.equal(graphFreshness(fresh.dir, TOOL).fresh, true);
    assert.equal(graphFreshness(none.dir, TOOL).fresh, false);
    assert.deepEqual(freshGraphs([stale.dir, fresh.dir, none.dir, fresh.dir], TOOL), [fresh.dir]);
    assert.equal(knowledgeGraphDirective(freshGraphs([stale.dir, none.dir], TOOL)), '', 'no fresh graph, no directive');
    // The setting off (the shipped default) or not a command name: nothing is fresh, so nothing is said.
    assert.deepEqual(freshGraphs([fresh.dir], ''), []);
    assert.deepEqual(freshGraphs([fresh.dir], '../kgtool'), []);
  } finally { stale.cleanup(); fresh.cleanup(); none.cleanup(); }
});

test('a landing runs `<tool> update .` (a stub tool) only where a graph is kept — after it, the graph is fresh again; no tool on PATH, no tool named or a failure is never a throw', async () => {
  const landed = Math.floor(Date.now() / 1000) - 60;
  const kept = graphRepo(landed, landed - 3600);
  const bare = graphRepo(landed);
  const bin = mkdtempSync(join(tmpdir(), 'pc-kgtool-bin-'));
  try {
    // A tool that does what an `update` does to the file: rewrites graph.json, from inside the repository.
    writeFileSync(join(bin, TOOL), `#!/usr/bin/env bash\n[ "$1" = update ] || exit 9\necho "$PWD $*" >> "$KG_LOG"\n: > ${TOOL}-out/graph.json\n`, { mode: 0o755 });
    const log = join(bin, 'calls.log');
    assert.equal(graphFreshness(kept.dir, TOOL).fresh, false, 'stale before the landing');
    const ran = await refreshGraphs([kept.dir, bare.dir], { tool: TOOL, env: { PATH: `${bin}:/usr/bin:/bin`, KG_LOG: log } });
    assert.deepEqual(ran.map((one) => [one.repo === kept.dir ? 'kept' : 'bare', one.result]), [['bare', 'no-graph'], ['kept', 'updated']]);
    assert.match(readFileSync(log, 'utf8'), /update \./, 'the tool\'s own update verb, from inside the repository');
    assert.ok(!readFileSync(log, 'utf8').includes(bare.dir), 'a repository with no graph is never given one');
    assert.equal(graphFreshness(kept.dir, TOOL).fresh, true, 'fresh after the landing refreshed it');
    assert.deepEqual(await refreshGraphs([kept.dir], { tool: '' }), [], 'no tool named: nothing at all');
    assert.deepEqual((await refreshGraphs([kept.dir], { tool: TOOL, env: { PATH: '/nowhere' } })).map((one) => one.result), ['no-tool']);
    const failed = await refreshGraphs([kept.dir], { tool: TOOL, env: { PATH: bin }, run: async () => ({ code: 3, timedOut: false, stderr: 'boom\n' }) });
    assert.deepEqual(failed.map((one) => [one.result, one.detail]), [['failed', 'boom']]);
    const slow = await refreshGraphs([kept.dir], { tool: TOOL, env: { PATH: bin }, run: async () => ({ code: null, timedOut: true, stderr: '' }) });
    assert.equal(slow[0]!.result, 'timed-out');
  } finally { kept.cleanup(); bare.cleanup(); rmSync(bin, { recursive: true, force: true }); }
});

test('one reader of installed_plugins.json: skills.ts and skill-copy.ts agree on a version-1 and a version-2 registry', async () => {
  // measured-console phase 10 (EI-26): the two readers had two ideas of the
  // file's shape — skills.ts read only version 2's list, so a version-1
  // registry listed no plugin skills at all. Both now read through
  // shared/installed-plugins.js; one fixture per shape, both readers asked.
  const { readSkillCopy } = await import('../server/skill-copy.ts');
  const { parseInstalledPlugins } = await import('../shared/installed-plugins.js');
  const dir = mkdtempSync(join(tmpdir(), 'pc-reader-'));
  const sha = 'a'.repeat(40);
  for (const shape of [1, 2] as const) {
    const home = join(dir, `v${shape}`);
    const install = join(home, 'plugins', 'cache', 'phased-execution-public', 'phased-execution', sha.slice(0, 12));
    skill(install, 'phased-execution', 'the skill itself');
    const record = { scope: 'user', installPath: install, version: sha.slice(0, 12), gitCommitSha: sha, lastUpdated: '2026-10-25T00:00:00.000Z' };
    file(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: shape,
      plugins: { 'phased-execution@phased-execution-public': shape === 1 ? record : [record] },
    }));
    const listed = installedPlugins(home);
    assert.deepEqual(listed, [{ plugin: 'phased-execution', path: install }], `skills.ts reads the version-${shape} registry`);
    const copy = readSkillCopy(home);
    assert.equal(copy.install?.installPath, install, `skill-copy.ts reads the version-${shape} registry`);
    assert.equal(copy.install?.commit, sha);
    assert.equal(parseInstalledPlugins(JSON.stringify({ version: shape, plugins: {} })).fileVersion, shape);
  }
  assert.match(parseInstalledPlugins('{').parseError ?? '', /./, 'a file that does not parse is said, never thrown');
  rmSync(dir, { recursive: true, force: true });
});
