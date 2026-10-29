/**
 * The ratchets of measured-console phase 15: the reds a release carries
 * (`known-reds.json`, `scripts/reds-ratchet.mjs`) and the quarantine
 * (`scripts/quarantine.env`, `shared/quarantine-model.js`). A new red fails;
 * a fixed one lowers the ratchet; an expired quarantine row fails the gate.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_REDS, judgeReds, readKnownReds } from '../scripts/reds-ratchet.mjs';
import { isExpired, parseQuarantine, quarantinedPaths, QUARANTINE_SUITES } from '../shared/quarantine-model.js';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(VIEWER, '..');

const KNOWN = [
  { id: 'a.test.ts > one', stage: 'server-suite', issue: '#1', since: '2026-10-26' },
  { id: 'a.test.ts > two', stage: 'server-suite', issue: '#2', since: '2026-10-26' },
  { id: 'x.bats > three', stage: 'bash-engine', issue: '#3', since: '2026-10-26' },
];

test('RR-1: a new red not in known-reds.json fails the ratchet', () => {
  const verdict = judgeReds(KNOWN, 'server-suite', ['a.test.ts > one', 'b.test.ts > new']);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.fresh, ['b.test.ts > new']);
  // A known red of ANOTHER stage is no cover.
  assert.equal(judgeReds(KNOWN, 'server-suite', ['x.bats > three']).ok, false);
});

test('RR-2: a fixed red lowers the ratchet — and only its own stage\'s', () => {
  const verdict = judgeReds(KNOWN, 'server-suite', ['a.test.ts > one']);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.carried, ['a.test.ts > one']);
  assert.deepEqual(verdict.fixed, ['a.test.ts > two']);
  assert.deepEqual(verdict.next.map((red: { id: string }) => red.id), ['a.test.ts > one', 'x.bats > three']);
  assert.ok(verdict.next.length < KNOWN.length, 'the ratchet only moves down');
});

test('RR-3: the CLI gate fails a stage log naming a red it does not know', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rr-'));
  const log = join(dir, 'stage.log');
  // node's spec reporter: a failing test is named on a ✖ line.
  writeFileSync(log, '✖ a brand new red (3.1ms)\n');
  const script = join(VIEWER, 'scripts', 'reds-ratchet.mjs');
  const gate = spawnSync(process.execPath, [script, 'gate', 'server-suite', log], { encoding: 'utf8' });
  assert.equal(gate.status, 1, gate.stdout + gate.stderr);
});

test('RR-4: known-reds.json is well-formed — every red names its stage, its issue and its day', () => {
  const { reds } = readKnownReds(KNOWN_REDS);
  assert.ok(Array.isArray(reds));
  const stages = spawnSync('bash', [join(ROOT, 'scripts', 'gates.sh'), '--list'], { encoding: 'utf8' }).stdout.split('\n');
  for (const red of reds) assert.ok(stages.includes(red.stage), `${red.id}: ${red.stage} is not a gate stage`);
  assert.equal(JSON.parse(readFileSync(KNOWN_REDS, 'utf8')).reds.length, reds.length);
});

test('QR-1: a quarantine row is set aside until its day ends, and an expired one fails gates.sh\'s stage', () => {
  const text = "QUARANTINE_ROWS='node:viewer/test/x.test.ts\tmeasured-console/26\t2026-10-31\tsegfaults under load\nvitest:viewer/client/src/y.test.tsx\t#9\t2026-10-01\tflaky\nbad\t\t\t'";
  const rows = parseQuarantine(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].problem !== undefined, true);
  const oct30 = Date.parse('2026-10-30T23:00:00Z');
  const nov1 = Date.parse('2026-11-01T00:00:01Z');
  assert.equal(isExpired(rows[0], Date.parse('2026-10-31T23:59:59Z')), false, 'the expiry is the last day it stands');
  assert.equal(isExpired(rows[0], nov1), true);
  assert.deepEqual(quarantinedPaths(rows, 'node', oct30), ['viewer/test/x.test.ts']);
  assert.deepEqual(quarantinedPaths(rows, 'vitest', oct30), [], 'an expired row sets nothing aside');
  assert.deepEqual([...QUARANTINE_SUITES], ['node', 'bats', 'vitest', 'playwright']);
});

test('QR-2: the shipped quarantine.env parses, and the TS reader agrees with bash on its rows', () => {
  const file = join(ROOT, 'scripts', 'quarantine.env');
  const rows = parseQuarantine(readFileSync(file, 'utf8'));
  for (const row of rows) assert.equal(row.problem, undefined, `${row.id}: ${row.problem}`);
  const bash = spawnSync('bash', ['-c', `. '${file}'; printf '%s' "$QUARANTINE_ROWS"`], { encoding: 'utf8' });
  assert.equal(bash.stdout.split('\n').filter((line) => line.trim()).length, rows.length);
});
