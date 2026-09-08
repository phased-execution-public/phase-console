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
 * them, over the three places the plan names — `scripts/`, `.github/scripts/`
 * and `package.json` — and it runs in BOTH trees, because the free tree is the
 * one a stranger reads and is where a stray line would do the most damage.
 *
 * The second half is the split's own shape and is Pro-only: the free tree has
 * none of these scripts, which is the point of them.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

/** Every file directly under the given repo-relative directories, plus the named files. */
const surface = (): string[] => {
  const out: string[] = [];
  for (const dir of ['scripts', '.github/scripts']) {
    const abs = join(REPO, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (statSync(join(REPO, rel)).isFile()) out.push(rel);
    }
  }
  for (const rel of ['package.json', 'viewer/package.json']) {
    if (existsSync(join(REPO, rel))) out.push(rel);
  }
  return out;
};

describe('no registry, no tap — the channels this product withdrew', () => {
  it('names none of them in scripts/, .github/scripts/ or either package.json', () => {
    const found: string[] = [];
    for (const rel of surface()) {
      const body = read(rel);
      for (const [pattern, channel] of CHANNELS) {
        const m = body.match(pattern);
        if (!m) continue;
        const line = body.slice(0, m.index ?? 0).split('\n').length;
        found.push(`${rel}:${line} — ${channel} (${JSON.stringify(m[0])})`);
      }
    }
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
  });

  it('has no GitHub Actions at all', () => {
    // There is no CI: scripts/gates.sh and the pre-push hook are the gates.
    assert.equal(existsSync(join(REPO, '.github', 'workflows')), false, '.github/workflows is back');
  });
});

