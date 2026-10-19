/**
 * `Verify in: .` is the plan's root tree, never a mirror's bare directory, and
 * a `! grep` over a missing target is red (one-pool phase 20, #311).
 *
 * Measured: website-no-broker-name run `cb9907b03359` (2026-10-10), and again
 * run `502cda348e07` (2026-10-13). The mirror mounted only `website/`;
 * `verifyDirOf` resolved `Verify in: .` to the mirror ROOT, which is no git
 * tree. Setup's `yarn install --immutable` left an empty `yarn.lock` there,
 * every positive line failed, and every `! grep` line passed vacuously — the
 * phase's main proof, `! grep -rniI <broker-name> apps/next`, on the UNFIXED
 * tree. The reds matched the baseline's and read as inherited: the phase would
 * have settled green having verified nothing.
 *
 *  - VR-1 at a bare mirror root with exactly one mount, `.` (or no `Verify
 *    in:`) resolves to that mount, and the session is told the same directory;
 *    with several mounts, or the root mounted, it stays the root; a named
 *    `Verify in:` is the plan's word;
 *  - VR-2 a negated grep whose target is missing is red, by name, and never
 *    run; one over a target that exists runs as before.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { vacuousNegations, verifyPhase } from '../server/runner/verify.ts';

const TRASH: string[] = [];
process.on('exit', () => { for (const dir of TRASH) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pc-vroot-')));
  TRASH.push(dir);
  return dir;
}

/** A mirror directory holding `mounts`, each a git tree; `rootMounted` makes the mirror root a tree too. */
function mirror(mounts: string[], rootMounted = false): { shared: string; integration: string } {
  const base = scratch();
  const shared = join(base, 'hub');
  mkdirSync(shared);
  const integration = join(base, 'runs', 'demo', 'cb9907b03359', 'integration');
  mkdirSync(integration, { recursive: true });
  if (rootMounted) execFileSync('git', ['init', '-q', integration]);
  for (const rel of mounts) {
    mkdirSync(join(integration, rel), { recursive: true });
    execFileSync('git', ['init', '-q', join(integration, rel)]);
  }
  return { shared, integration };
}

async function dirOf(opts: { mounts: string[]; rootMounted?: boolean; verifyIn?: string; lines?: string }) {
  const { shared, integration } = mirror(opts.mounts, opts.rootMounted);
  const runner = new Runner({
    scriptsDir: shared, verifyIn: async () => opts.verifyIn ?? '',
    verificationText: async () => opts.lines ?? '- `! grep -rniI broker-name apps/next`',
  } as never);
  const internals = runner as never as {
    state: unknown; verifyDirOf: (phase: number) => Promise<{ dir: string; mount?: string; docsRoot?: string }>;
    proofEnv: (phase: number) => Promise<Record<string, string>>;
  };
  internals.state = {
    id: 'cb9907b03359', slug: 'demo', root: shared, workRoot: integration, checkout: 'worktree',
    mountedRepos: [...(opts.rootMounted ? [''] : []), ...opts.mounts], phases: {},
  };
  return { shared, integration, at: await internals.verifyDirOf(1), env: await internals.proofEnv(1) };
}

test('VR-1 (#311): `Verify in: .` at a bare mirror with one mount resolves to that mount — and the session is told so', async () => {
  for (const verifyIn of ['.', '']) {
    const { integration, shared, at, env } = await dirOf({ mounts: ['website'], verifyIn });
    assert.equal(at.dir, join(integration, 'website'), `Verify in: ${JSON.stringify(verifyIn)}`);
    assert.equal(at.mount, 'website');
    assert.equal(at.docsRoot, shared, 'a docs-only line still runs where the docs are');
    assert.equal(env.PE_VERIFY_DIR, join(integration, 'website'), 'the session keys its proofs where the line is judged');
  }
});

test('VR-1 (#311): several mounts, a mounted root, or a named Verify in keep their own reading', async () => {
  const several = await dirOf({ mounts: ['web', 'api'], verifyIn: '.' });
  assert.equal(several.at.dir, several.integration, 'the lines cd into their own mounts');
  assert.equal(several.at.mount, undefined);
  assert.equal(several.at.docsRoot, several.shared);
  const rooted = await dirOf({ mounts: ['web'], rootMounted: true, verifyIn: '.' });
  assert.equal(rooted.at.dir, rooted.integration, 'a mirror whose root is mounted IS the plan\'s tree');
  assert.equal(rooted.at.mount, undefined);
  assert.equal(rooted.at.docsRoot, undefined, 'and its docs/ is the run branch\'s own — judged there');
  // One mount, and lines that already speak from the root: left where they work.
  const cds = await dirOf({ mounts: ['website'], verifyIn: '.', lines: '- `cd website && yarn test`\n- `! grep -rn x website/apps`' });
  assert.equal(cds.at.dir, cds.integration, 'a line that cds into the mount is not moved into it');
  assert.equal(cds.at.mount, undefined);
  const named = await dirOf({ mounts: ['website'], verifyIn: 'website' });
  assert.equal(named.at.dir, join(named.integration, 'website'));
  assert.equal(named.at.docsRoot, undefined, 'a named Verify in is the plan\'s word, docs/ included');
});

test('VR-2 (#311): `! grep` over a missing target is red, by name, never run; over a real one it runs', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'apps', 'next'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'next', 'page.tsx'), 'export const brand = "the platform";\n');
  const LINE = '! grep -rniI broker-name apps/next';
  assert.deepEqual(vacuousNegations(LINE, join(dir, 'apps')), ['apps/next'], 'the mirror-root shape: no apps/ here');
  assert.deepEqual(vacuousNegations(LINE, dir), []);
  const vacuous = await verifyPhase(`- \`${LINE}\``, { cwd: join(dir, 'apps') });
  assert.equal(vacuous.ok, false, '7.1 read this green on the unfixed tree');
  assert.equal(vacuous.ran[0]!.code, 2);
  assert.equal(vacuous.ran[0]!.ms, 0, 'never run');
  assert.deepEqual(vacuous.ran[0]!.unreached, ['apps/next']);
  assert.match(vacuous.ran[0]!.output, /negated search of nothing/);
  const real = await verifyPhase(`- \`${LINE}\``, { cwd: dir });
  assert.equal(real.ok, true, real.reason);
  writeFileSync(join(dir, 'apps', 'next', 'page.tsx'), 'export const brand = "broker-name";\n');
  const found = await verifyPhase(`- \`${LINE}\``, { cwd: dir });
  assert.equal(found.ok, false, 'the proof still catches the name');
  // Valued options and a cd inside the chain are read as the shell reads them.
  assert.deepEqual(vacuousNegations("! grep -rn --include '*.ts' foo apps", dir), [], 'a value is not a file');
  assert.deepEqual(vacuousNegations('(cd apps && ! grep -rn broker-name next)', dir), [], 'the cd inside the parens is followed');
  assert.deepEqual(vacuousNegations('true && cd apps && ! grep -rn broker-name gone', dir), ['apps/gone']);
  assert.deepEqual(vacuousNegations('cd $APP && ! grep -rn x gone', dir), [], 'past a cd it cannot follow, nothing is judged');
  assert.deepEqual(vacuousNegations('! grep -rn x apps gone', dir), [], 'a part that reads one real path read something');
  // A positive grep over a missing file is red on its own — and marked unreached.
  const positive = await verifyPhase('- `grep -q x apps/none.txt`', { cwd: dir });
  assert.equal(positive.ok, false);
  assert.deepEqual(positive.ran.at(-1)!.unreached, ['apps/none.txt']);
});
