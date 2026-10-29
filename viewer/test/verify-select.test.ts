/**
 * The phase tier's selection (measured-console phase 15): a heavy §Verification
 * line runs as its SELECTED form — the tests its diff maps to, the invariants,
 * a sample seeded by the boarding sha — and keeps its ORIGINAL text as its key;
 * the release (no selector) runs it as written. `scripts/verify-select.env` is
 * the one table, and the drift test below holds this reader to bash's.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldCommand, verifyPhase } from '../server/runner/verify.ts';
import {
  changedSince, parseSelectTable, readSelectTable, sampleOf, selectLine, selectTableFile,
} from '../server/runner/verify-select.ts';
import { appendLedger, readLedger, resolveVerifyLimit, reusableRun, type LedgerRow } from '../server/runner/verify-ledger.ts';
import { parsePlan, verificationTierFor } from '../server/parse/plan.ts';
import { repo as gitRepo } from './fixtures/repo.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const LINE = 'bash tests/run-tests.sh';

/** A repository with the table, a stub run-tests.sh that writes down what it was asked to run, and eight bats files. */
function stubRepo(): { dir: string; base: string; asked: string } {
  const dir = gitRepo();
  const asked = join(dir, '.asked');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'tests', 'unit'), { recursive: true });
  copyFileSync(selectTableFile(ROOT), selectTableFile(dir));
  writeFileSync(join(dir, 'scripts', 'foo.sh'), 'echo foo\n');
  writeFileSync(join(dir, 'scripts', 'bar.sh'), 'echo bar\n');
  writeFileSync(join(dir, 'tests', 'unit', 'foo.bats'), '@test "foo" { run scripts/foo.sh; }\n');
  writeFileSync(join(dir, 'tests', 'unit', 'bar.bats'), '@test "bar" { run scripts/bar.sh; }\n');
  for (let i = 1; i <= 6; i += 1) writeFileSync(join(dir, 'tests', 'unit', `other-${i}.bats`), `@test "o${i}" { true; }\n`);
  writeFileSync(join(dir, 'tests', 'run-tests.sh'), `#!/usr/bin/env bash\nprintf '%s|%s\\n' "\${RUN_TESTS_ONLY:-ALL}" "\${PE_VERIFY_TIER:-}" > '${asked}'\n`);
  chmodSync(join(dir, 'tests', 'run-tests.sh'), 0o755);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'base']);
  const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, base, asked };
}

test('VS-1: under impact, a phase that changed one script runs its bats files plus the sample and nothing else; the row keeps the original text', async () => {
  const { dir, base, asked } = stubRepo();
  writeFileSync(join(dir, 'scripts', 'foo.sh'), 'echo foo changed\n');
  const table = readSelectTable(dir)!;
  const changed = changedSince(dir, base)!;
  assert.deepEqual(changed, ['scripts/foo.sh']);
  const select = (command: string) => selectLine({ table, repoRoot: dir, folded: foldCommand(command), changed, base, seed: base });

  const summary = await verifyPhase(`- **Verification:**\n  - \`${LINE}\``, { cwd: dir, select });
  assert.equal(summary.ok, true, summary.reason);
  const [row] = summary.ran;
  assert.equal(row.command, LINE, 'the key is the line as the plan wrote it');
  assert.equal(row.tier, 'phase');
  assert.deepEqual(row.selected, ['tests/unit/foo.bats']);
  assert.equal(row.sample!.length, table.sample);
  assert.ok(!row.sample!.includes('tests/unit/foo.bats'));
  // What the stub was asked to run: exactly the selection and the sample, under the phase tier.
  const [files, tier] = readFileSync(asked, 'utf8').trim().split('|');
  assert.deepEqual(files.split(' ').sort(), ['tests/unit/foo.bats', ...row.sample!].sort());
  assert.equal(tier, 'phase');
  assert.equal(row.covered, (1 + table.sample) / 8);

  // Under `full` (no selector) the line runs as written.
  const full = await verifyPhase(`- **Verification:**\n  - \`${LINE}\``, { cwd: dir });
  assert.equal(full.ran[0].tier, undefined);
  assert.equal(readFileSync(asked, 'utf8').trim(), 'ALL|');
});

test('VS-2: the ledger keeps the original text as key with tier, selected, sample and covered — and never mixes the tiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-ledger-'));
  const file = join(dir, 'verifications.ndjson');
  const common = { type: 'verification' as const, slug: 's', phase: 1, run: 'r', kind: 'verify' as const, command: foldCommand(LINE), code: 0, ok: true, tree: 't', env: 'e', dir: '' };
  const rows: LedgerRow[] = [
    { ...common, at: new Date().toISOString(), ms: 1_200_000 },
    { ...common, at: new Date().toISOString(), ms: 30_000, tier: 'phase', ranAs: 'RUN_TESTS_ONLY=a bash tests/run-tests.sh', selected: ['a'], sample: ['b'], covered: 0.25 },
  ];
  appendLedger(file, rows);
  const read = readLedger(file, 's');
  assert.equal(read[1].command, LINE);
  assert.equal(read[1].tier, 'phase');
  assert.deepEqual([read[1].selected, read[1].sample, read[1].covered], [['a'], ['b'], 0.25]);
  // The full line's limit is measured from full runs alone, and the selected line's from selected ones.
  assert.equal(resolveVerifyLimit({ command: LINE, rows: read }).ms, 3 * 1_200_000);
  assert.equal(resolveVerifyLimit({ command: LINE, rows: read, tier: 'phase' }).source, 'default');
  // A baseline reuses a selection only for the same selection, and never the full line for one.
  const key = { command: LINE, tree: 't', env: 'e', dir: '' };
  assert.equal(reusableRun(read, key)?.tier, undefined);
  assert.equal(reusableRun(read, { ...key, tier: 'phase', ranAs: 'RUN_TESTS_ONLY=a bash tests/run-tests.sh' })?.tier, 'phase');
  assert.equal(reusableRun(read, { ...key, tier: 'phase', ranAs: 'RUN_TESTS_ONLY=z bash tests/run-tests.sh' }), undefined);
});

test('VS-3: a file in scope that no test names runs the line as written; a line not in the table is not selected', () => {
  const { dir, base } = stubRepo();
  writeFileSync(join(dir, 'scripts', 'unnamed.sh'), 'echo x\n');
  const table = readSelectTable(dir)!;
  const changed = changedSince(dir, base)!;
  const choice = selectLine({ table, repoRoot: dir, folded: LINE, changed, base, seed: base });
  assert.equal(choice?.tier, 'full');
  assert.match((choice as { reason: string }).reason, /scripts\/unnamed\.sh/);
  assert.equal(selectLine({ table, repoRoot: dir, folded: 'npm test', changed, base, seed: base }), undefined);
});

test('VS-4: the sample is seeded — the same sha draws the same files, another sha others', () => {
  const pool = Array.from({ length: 40 }, (_, i) => `tests/unit/f${i}.bats`);
  assert.deepEqual(sampleOf(pool, 'abc', 3), sampleOf([...pool].reverse(), 'abc', 3));
  assert.notDeepEqual(sampleOf(pool, 'abc', 3), sampleOf(pool, 'def', 3));
  assert.equal(sampleOf(pool, 'abc', 3).length, 3);
});

test('VS-5: the heavy lines this plan writes are the ones the table selects', () => {
  const table = readSelectTable(ROOT)!;
  const heavy = ['bash tests/run-tests.sh', 'npm --prefix viewer run test:client', 'npm --prefix viewer run test:e2e:dist',
    'npm --prefix viewer test', 'node --test --test-timeout=600000 --test-force-exit "viewer/test/*.test.ts"'];
  for (const line of heavy) assert.ok(table.rows.some((row) => row.line.test(foldCommand(line))), line);
  // A node line naming its own files is not the suite, and is run as written.
  assert.ok(!table.rows.some((row) => row.line.test('node --test viewer/test/verify-select.test.ts')));
});

test('VS-DRIFT: the TS reader reads verify-select.env exactly as bash sources it', () => {
  const file = selectTableFile(ROOT);
  const bash = spawnSync('bash', ['-c', `. '${file}'; printf '%s\\n--\\n%s\\n--\\n%s' "$VERIFY_SELECT_SAMPLE" "$VERIFY_SELECT_INVARIANTS" "$VERIFY_SELECT_ROWS"`], { encoding: 'utf8' });
  assert.equal(bash.status, 0, bash.stderr);
  const [sample, invariants, rows] = bash.stdout.split('\n--\n');
  const table = parseSelectTable(readFileSync(file, 'utf8'));
  assert.equal(table.sample, Number(sample));
  assert.deepEqual(table.invariants, invariants.split(/\s+/).filter(Boolean));
  assert.deepEqual(table.rows.map((row) => [row.id, row.source, row.kind, row.scope.join(' ')].join('\t')), rows.split('\n').filter(Boolean));
  for (const invariant of table.invariants) assert.ok(readSelectTable(ROOT) && invariant.startsWith('viewer/test/'), invariant);
});

test('VS-TIER: --verification-tier and verificationTierFor answer alike over the fixture', () => {
  const fixture = join(ROOT, 'tests', 'fixtures', 'plans', 'verification-tier.md');
  const plan = parsePlan(readFileSync(fixture, 'utf8'), 'verification-tier', fixture);
  const docs = mkdtempSync(join(tmpdir(), 'vs-tier-'));
  mkdirSync(join(docs, 'docs', 'plans'), { recursive: true });
  copyFileSync(fixture, join(docs, 'docs', 'plans', 'verification-tier.md'));
  for (const phase of [undefined, 1, 2, 3, 4]) {
    const args = [join(ROOT, 'scripts', 'phase-graph.sh'), 'verification-tier', '--verification-tier', ...(phase ? [String(phase)] : [])];
    const out = spawnSync('bash', args, { encoding: 'utf8', env: { ...process.env, DOCS_ROOT: docs } });
    const js = verificationTierFor(plan, phase);
    assert.equal(out.stdout.trim(), js ? `${js.tier}\t${js.source}` : '', `phase ${phase}`);
  }
});
