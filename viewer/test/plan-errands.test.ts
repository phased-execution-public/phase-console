/**
 * The plan's `## Operator errands` TABLE (turn-by-turn phase 2) — read by the
 * console, bound to its bullets by the "(E-N…)" their text ends with. Every
 * table here is synthetic, in the SHAPE real plans write: an Id, a free second
 * column, what only the owner can do, the exact steps, what to expect and how
 * the agent verifies it.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errandSteps, parseErrandsTable, tableCells } from '../server/parse/errands.ts';
import { humanStepsFor, parsePlan } from '../server/parse/plan.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'plans', 'guided.md');

const table = (second: string, rows: string[]) => [
  'Every `!` line runs from `~/work/acme`.',
  '',
  `| Id | ${second} | What only the owner can do | Exact steps | Expected | How the agent verifies |`,
  '|---|---|---|---|---|---|',
  ...rows,
  '',
  'Text after the table.',
].join('\n');

test('both second-column headers read, the column kept verbatim; the preamble\'s "runs from" is kept', () => {
  for (const second of ['Phase · issues', 'Phase · why']) {
    const read = parseErrandsTable(table(second, ['| E-1 | 3 · secret | store the key | put it in the keychain | it is there | the probe |']), ['E-1'])!;
    assert.equal(read.secondHeader, second);
    assert.equal(read.runsFrom, '~/work/acme');
    assert.deepEqual(read.rows, [{
      id: 'E-1', phase: '3 · secret', what: 'store the key', steps: [{ text: 'put it in the keychain' }],
      expected: 'it is there', verifies: 'the probe', bound: true,
    }]);
    assert.deepEqual(read.unbound, []);
  }
});

test('headers are matched by name, in any order, tolerantly; no Id or no "what" column is no table', () => {
  const read = parseErrandsTable([
    '| **Ref** | Steps | What | Verify |',
    '|:--|:--|:--|:--|',
    '| E-7 | `! make check` | run the check | `! make check` |',
  ].join('\n'))!;
  assert.deepEqual(read.rows.map((row) => [row.id, row.what, row.steps, row.verifyCommand, row.phase]),
    [['E-7', 'run the check', [{ text: 'Run this command.', command: 'make check' }], 'make check', undefined]]);
  assert.equal(parseErrandsTable('| Name | Notes |\n|---|---|\n| E-1 | x |'), undefined);
  assert.equal(parseErrandsTable('no table at all'), undefined);
});

test('`! cmd` markers are command steps, led by the prose before them; prose after the last is a step; a cell with none is ONE step', () => {
  assert.deepEqual(
    errandSteps('`! bash scripts/box.sh --check` then `! bash scripts/box.sh restart`; then comment `restarted` on acme #14'),
    [
      { text: 'Run this command.', command: 'bash scripts/box.sh --check' },
      { text: 'Run this command.', command: 'bash scripts/box.sh restart' },
      { text: 'comment `restarted` on acme #14' },
    ],
  );
  assert.deepEqual(errandSteps('open the dashboard, go to Keys, press Rotate, then copy the new key into the vault'),
    [{ text: 'open the dashboard, go to Keys, press Rotate, then copy the new key into the vault' }],
    'sentences are never split into invented steps');
  assert.deepEqual(errandSteps('first stop the box: `! bash stop.sh`'), [{ text: 'first stop the box', command: 'bash stop.sh' }]);
  assert.deepEqual(errandSteps('a plain `code span` is prose, not a command'), [{ text: 'a plain `code span` is prose, not a command' }]);
  assert.deepEqual(errandSteps(''), []);
});

test('a <placeholder> command is marked template', () => {
  assert.deepEqual(errandSteps('`! git -C <repo> branch -d pe/demo` per repo'), [
    { text: 'Run this command.', command: 'git -C <repo> branch -d pe/demo', template: true },
    { text: 'per repo' },
  ]);
});

test('escaped and backticked pipes stay inside their cell; a row whose closing pipe is missing still reads', () => {
  assert.deepEqual(tableCells('| E-4 | `! git tag \\| wc -l` before | the count falls | `a | b` |'),
    ['E-4', '`! git tag | wc -l` before', 'the count falls', '`a | b`']);
  const read = parseErrandsTable(table('Phase · issues', [
    '| E-4 | 3 | count the tags | `! git tag \\| wc -l` before and after | the count falls | `git tag \\| wc -l`',
  ]), [])!;
  assert.deepEqual(read.rows[0]!.steps, [
    { text: 'Run this command.', command: 'git tag | wc -l' }, { text: 'before and after' },
  ]);
  assert.equal(read.rows[0]!.verifies, '`git tag | wc -l`');
  assert.equal(read.rows[0]!.verifyCommand, undefined, 'no `!` marker, no command');
});

test('the fixture: every bullet binds its row — "(E-4, hub #105)" included — and the row no bullet names is listed unbound', () => {
  const plan = parsePlan(readFileSync(FIXTURE, 'utf8'), 'guided', FIXTURE);
  const read = plan.errandsTable!;
  assert.deepEqual(read.rows.map((row) => [row.id, row.bound]), [['E-1', true], ['E-2', true], ['E-3', true], ['E-4', true], ['E-5', false]]);
  assert.deepEqual(read.unbound, ['E-5']);
  assert.deepEqual([...humanStepsFor(plan, 0), ...humanStepsFor(plan, 1), ...humanStepsFor(plan, 3)].map((s) => s.eref), ['E-2', 'E-4', 'E-1', 'E-3']);
  assert.equal(humanStepsFor(plan, 2)[0]!.eref, undefined, 'a bullet with no (E-N) binds nothing');
  const e2 = read.rows.find((row) => row.id === 'E-2')!;
  assert.deepEqual(e2.steps.map((s) => s.command ?? s.text), ['bash scripts/box.sh --check', 'bash scripts/box.sh restart', 'comment `restarted` on acme #14']);
  assert.equal(e2.verifyCommand, 'bash scripts/box.sh --check');
  assert.equal(read.rows.find((row) => row.id === 'E-3')!.steps[0]!.template, true);
  // The decision's options, the recommended one and the deadline, read alike by the console.
  const [decision] = humanStepsFor(plan, 1);
  assert.deepEqual([decision!.options?.map((o) => o.id), decision!.recommended, decision!.deadline], [['box', 'cloud', 'skip'], 'box', '2026-10-20T17:00Z']);
});
