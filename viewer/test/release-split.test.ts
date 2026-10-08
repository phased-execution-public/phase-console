/**
 * The release split, held to what it claims.
 *
 * Two repositories, two scripts, and **no registry anywhere**. npm, GitHub
 * Packages and the Homebrew tap were all withdrawn on 2026-09-03; what replaced
 * them is a git push and a GitHub Release, cut by hand on the machine that
 * pushes. That is a claim the documentation makes in several places, and prose
 * cannot hold it: the failure mode is a `publish` step reintroduced years later
 * by somebody copying a workflow from another project, in a repository whose
 * whole point is that nothing publishes on its own.
 *
 * So the first half of this file greps for the channels rather than describing
 * them, over the three places the plan names — `scripts/` and `.github/scripts/`
 * all the way down, and both `package.json`s — and it runs in BOTH trees,
 * because the free tree is the one a stranger reads and is where a stray line
 * would do the most damage.
 *
 * One exception, and only in the Pro tree (control-tower phase 68): the Pro
 * package IS published to a registry and a tap. The words may stand in the two
 * scripts that pack and publish it and in the tap's formula template — each a
 * proPath carrying the canary — and nowhere else. The allowance is written
 * inside Pro markers, so the free copy of this file allows none at all.
 *
 * The second half is the split's own shape and is Pro-only: the free tree has
 * none of these scripts, which is the point of them.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/**
 * A channel, and the string that would give it away. Each pattern names a way of
 * DISTRIBUTING this product — never a mention of the tool: `scripts/gates.sh`
 * says "brew install bats-core" to a maintainer with no bats, and
 * `session-hook.sh` looks for node under `/opt/homebrew/bin`. Both are correct,
 * and a rule that could not tell them from `brew tap` would be switched off
 * within a week.
 */
const CHANNELS: Array<[RegExp, string]> = [
  [/registry\.npmjs\.org/, 'the npm registry'],
  [/npm\.pkg\.github\.com/, 'GitHub Packages'],
  [/\bnpm\s+publish\b/, 'npm publish'],
  [/\bbrew\s+tap\b/, 'a Homebrew tap'],
  [/homebrew-[a-z]/i, 'a Homebrew tap repository'],
  [/\bbrew\s+--prefix\s+phase-console\b/, 'a Homebrew install of this product'],
  [/(^|[\s"'`(])Formula\//m, 'a Homebrew formula'],
];

/**
 * Where a channel's words may stand. None in the free tree. In the Pro tree, the
 * Pro package's own publishing path and nothing else.
 */
const ALLOWED: string[] = [];

/**
 * A channel's words a file holds for a reason other than publishing: the file
 * and that ONE channel, never the whole file.
 */
const WALLED: Array<[string, string]> = [];

/** Every file under `scripts/` and `.github/scripts/`, all the way down, plus both package.json files. */
const surface = (root = REPO): string[] => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = `${rel}/${name}`;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  for (const dir of ['scripts', '.github/scripts']) {
    if (existsSync(join(root, dir))) walk(dir);
  }
  for (const rel of ['package.json', 'viewer/package.json']) {
    if (existsSync(join(root, rel))) out.push(rel);
  }
  return out;
};

/** Each channel word on the surface of `root`, outside the allowed files, as `file:line — channel`. */
const channelsIn = (root = REPO, allowed = ALLOWED): string[] => {
  const found: string[] = [];
  for (const rel of surface(root)) {
    if (allowed.includes(rel)) continue;
    const body = readFileSync(join(root, rel), 'utf8');
    for (const [pattern, channel] of CHANNELS) {
      if (WALLED.some(([file, words]) => file === rel && words === channel)) continue;
      const m = body.match(pattern);
      if (!m) continue;
      const line = body.slice(0, m.index ?? 0).split('\n').length;
      found.push(`${rel}:${line} — ${channel} (${JSON.stringify(m[0])})`);
    }
  }
  return found;
};

describe('no registry, no tap — the channels this product withdrew', () => {
  it('names none of them in scripts/, .github/scripts/ or either package.json', () => {
    const found = channelsIn();
    assert.deepEqual(
      found,
      [],
      'the repositories ARE the channels; nothing here may publish elsewhere:\n  ' + found.join('\n  '),
    );
  });

  it('reads a surface big enough to be worth reading', () => {
    // A walker that silently found nothing would pass the case above forever.
    const files = surface();
    assert.ok(files.length >= 10, `only ${files.length} files scanned — the walk is broken`);
    assert.ok(files.includes('package.json'));
    assert.ok(files.some((f) => f.startsWith('scripts/git-hooks/')), 'the walk goes below scripts/');
  });

  it('fails on a channel word planted anywhere on the surface — at any depth, in either package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-split-'));
    try {
      const plants: Array<[string, string]> = [
        ['scripts/ship.sh', 'npm publish --access public\n'],
        ['scripts/deeper/still.sh', 'brew tap somebody/tools\n'],
        ['.github/scripts/fetch.sh', 'curl https://registry.npmjs.org/x\n'],
        ['package.json', '{"homepage": "https://github.com/x/homebrew-tools"}\n'],
        ['viewer/package.json', '{"notes": "see Formula/x.rb"}\n'],
      ];
      for (const [rel, text] of plants) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
      const found = channelsIn(root);
      for (const [rel] of plants) {
        assert.ok(found.some((line) => line.startsWith(`${rel}:`)), `a word planted in ${rel} was not found:\n  ${found.join('\n  ')}`);
      }
      // And an allowance is a file name, never a directory: a plant BESIDE an
      // allowed file is found like any other.
      for (const rel of ALLOWED) {
        const beside = join(dirname(rel), 'beside.sh');
        mkdirSync(dirname(join(root, beside)), { recursive: true });
        writeFileSync(join(root, beside), 'npm publish\n');
        assert.ok(channelsIn(root).some((line) => line.startsWith(`${beside}:`)), `${beside} rode on the allowance of ${rel}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('has no GitHub Actions at all', () => {
    // There is no CI: scripts/gates.sh and the pre-push hook are the gates.
    assert.equal(existsSync(join(REPO, '.github', 'workflows')), false, '.github/workflows is back');
  });
});

