/**
 * Packaging invariants — the facts about how this tree SHIPS, which no other
 * gate checks and which fail silently when they drift.
 *
 * Three of them, each with its own way of going wrong quietly:
 *
 *   - **There is deliberately no `plugin.json`.** One tree installs both as a
 *     plain skill (cloned into `~/.claude/skills/`) and as a plugin, and it is
 *     the marketplace entry that carries the plugin metadata. Adding the file
 *     "for completeness" would stop the folder being a valid bare skill.
 *   - **The marketplace description is the largest user-facing prose surface
 *     here**, it is what every plugin user reads, and `docs/releasing.md` says
 *     in as many words that nothing checks it. It ended at "v2.3.0" while the
 *     tree was at 3.1.2 — a whole major release the listing never mentioned.
 *   - **`SKILL.md`'s frontmatter is the only part of the skill always in
 *     context.** A YAML slip there does not fail a build; it fails the skill's
 *     ability to be found, on somebody else's machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const json = (rel: string) => JSON.parse(read(rel));

test('there is no plugin.json — the marketplace entry carries the metadata', () => {
  for (const candidate of ['plugin.json', '.claude-plugin/plugin.json']) {
    assert.equal(existsSync(join(REPO, candidate)), false,
      `${candidate} must not exist: it would stop this folder being a valid bare skill`);
  }
  // And the entry that stands in for it says so.
  const marketplace = json('.claude-plugin/marketplace.json');
  assert.equal(marketplace.plugins.length, 1, 'one plugin in this marketplace');
  assert.equal(marketplace.plugins[0].strict, false,
    'strict:false is what lets the entry carry the metadata a plugin.json would');
});

test('the marketplace entry has the shape a listing needs', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  assert.equal(typeof marketplace.name, 'string');
  assert.ok(marketplace.owner?.name, 'the marketplace names an owner');

  const plugin = marketplace.plugins[0];
  assert.equal(plugin.name, 'phased-execution');
  assert.equal(plugin.source, './', 'the plugin IS this repository');
  for (const field of ['description', 'homepage', 'repository', 'license', 'category'] as const) {
    assert.ok(typeof plugin[field] === 'string' && plugin[field].length > 0, `plugin.${field}`);
  }
  assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.length > 0, 'plugin.keywords');
  assert.ok(Array.isArray(plugin.tags) && plugin.tags.length > 0, 'plugin.tags');
});

test('the plugin listing is not a release behind — its description names the current series', () => {
  // The rule: the highest version the description names must be at least the
  // tree's own MAJOR.MINOR. A patch may ship without touching this prose; a
  // minor may not, because a minor is where user-visible behaviour changed and
  // this listing is how a user learns about it. That is exactly the drift that
  // left "v2.3.0" as the newest thing the listing knew about at 3.1.2.
  const { version } = json('package.json');
  const [major, minor] = version.split('.').map(Number);

  const { description } = json('.claude-plugin/marketplace.json').plugins[0];
  const named = [...description.matchAll(/\bv(\d+)\.(\d+)(?:\.\d+)?\b/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  assert.ok(named.length > 0, 'the description names at least one version');

  const newest = named.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a));
  const behind = newest[0] < major || (newest[0] === major && newest[1] < minor);
  assert.equal(behind, false,
    `the marketplace description's newest version is v${newest[0]}.${newest[1]}, but this tree is `
    + `${version} — rewrite .claude-plugin/marketplace.json's description tail for the current series`);
});

test('SKILL.md frontmatter parses, and carries the two fields always in context', () => {
  const skill = read('SKILL.md');
  const match = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'SKILL.md opens with a YAML frontmatter block');

  // A deliberately small parser: top-level scalars, one list (`allowed-tools`)
  // and one nested mapping (`metadata`). Anything richer than that, in a file
  // whose whole job is to be cheap to load, is itself worth failing on.
  const fields = new Map<string, string>();
  const nested = new Map<string, Map<string, string>>();
  let block: string | null = null;
  for (const line of match[1].split('\n')) {
    if (/^\s*$/.test(line)) continue;
    if (/^\s+-\s+\S/.test(line)) {
      assert.ok(block, `list item outside any key: ${line}`);
      continue;
    }
    const child = line.match(/^\s+([a-z][\w-]*):\s*(.+)$/);
    if (child) {
      assert.ok(block, `nested field outside any key: ${line}`);
      if (!nested.has(block)) nested.set(block, new Map());
      nested.get(block)!.set(child[1], child[2]);
      continue;
    }
    const pair = line.match(/^([a-z][\w-]*):\s*(.*)$/);
    assert.ok(pair, `unparseable frontmatter line: ${line}`);
    block = pair[2] === '' ? pair[1] : null;
    if (pair[2] !== '') fields.set(pair[1], pair[2]);
  }
  assert.ok(nested.get('metadata')?.get('version'), 'the skill declares its own metadata.version');

  for (const required of ['name', 'description']) {
    assert.ok(fields.get(required), `SKILL.md frontmatter has ${required}`);
  }
  assert.equal(fields.get('name'), 'phased-execution');
  // Quoted because it contains a colon; unquoting it is a silent YAML break.
  assert.match(fields.get('description')!, /^"/, 'the description stays quoted');
  assert.match(fields.get('description')!, /"$/, 'the description stays quoted');
});

test('the console has no runtime dependency — the map libraries are build-time, like React itself', () => {
  // `viewer/package.json` keeps every client library under `devDependencies`:
  // the client is BUILT output, and the server runs on Node alone (node-pty and
  // ws are optional, with honest degradation). many-plans-one-repo phase 14
  // added React Flow and d3-dag for the repository map; they belong beside
  // React, never in a `dependencies` block that would make an install fetch
  // 3.5 MB of map library for a server that never imports it.
  const pkg = json('viewer/package.json') as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'viewer/package.json must carry no `dependencies`');
  for (const dep of ['react', '@xyflow/react', 'd3-dag', 'qrcode']) {
    assert.ok(pkg.devDependencies?.[dep], `${dep} is a devDependency`);
  }
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}).sort(), ['node-pty', 'ws']);
});

test('the npm allowlist ships the report template, not the 34 MB screencast', () => {
  // `assets/` shipped the whole directory, and console.gif is 34 MB that every
  // install and every Homebrew bottle paid to put on disk unread. The tarball
  // assertions prove the result; this proves the intent, without a pack.
  const { files } = json('package.json');
  assert.ok(!files.includes('assets/'), 'the bare assets/ directory is not shipped');
  assert.ok(files.includes('assets/report-template.md'), 'the report template still ships');

  // And the README must not point at a path the tarball no longer carries —
  // npmjs.com renders it from the tarball, so a relative link would 404 there.
  const readme = read('README.md');
  assert.ok(!/\]\(assets\/console\.gif\)/.test(readme),
    'README links a hosted copy of the screencast, not the unshipped path');
});
