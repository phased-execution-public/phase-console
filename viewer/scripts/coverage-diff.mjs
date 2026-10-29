// `npm run coverage:diff [-- <base>] [--write]` — the coverage of the lines a
// diff changed (measured-console phase 15), nightly and never a gate. It runs
// the node tests that name the changed server/shared modules under node's own
// coverage (lcov), reads which CHANGED lines (git diff -U0 <base>) ran, and
// holds the share to the ratchet row in test/coverage-ratchet.json: under the
// floor exits 1; `--write` raises the floor to what was measured, never lowers it.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedSince, plannedFiles, testsNaming } from '../server/runner/verify-select.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(VIEWER, '..');
const RATCHET = join(VIEWER, 'test', 'coverage-ratchet.json');
const args = process.argv.slice(2);
const write = args.includes('--write');
const base = args.find((arg) => !arg.startsWith('--')) ?? 'origin/main';

const changed = (changedSince(ROOT, base) ?? []).filter((path) =>
  /^viewer\/(server|shared)\/.+\.(ts|js|mjs)$/.test(path),
);
if (!changed.length) {
  console.log(`coverage:diff: no server or shared line changed since ${base}`);
  process.exit(0);
}
// The changed lines, per file, from a zero-context diff.
const lines = new Map();
for (const path of changed) {
  const diff = spawnSync('git', ['-C', ROOT, 'diff', '-U0', base, '--', path], { encoding: 'utf8' }).stdout;
  const set = new Set();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i += 1) set.add(start + i);
  }
  if (set.size) lines.set(path, set);
}
const planned = plannedFiles(ROOT, 'node');
const tests = [...new Set(changed.flatMap((path) => testsNaming(ROOT, planned, path) ?? []))].sort();
const lcov = join(VIEWER, '.cache', 'coverage-diff.lcov');
spawnSync(
  process.execPath,
  [
    '--test',
    '--test-force-exit',
    '--experimental-test-coverage',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcov}`,
    ...tests.map((t) => t.replace(/^viewer\//, '')),
  ],
  { cwd: VIEWER, stdio: 'ignore' },
);
// lcov: SF:<abs path>, then DA:<line>,<hits>.
const hit = new Map();
let file = '';
for (const line of readFileSync(lcov, 'utf8').split('\n')) {
  if (line.startsWith('SF:')) file = relative(ROOT, line.slice(3));
  else if (line.startsWith('DA:')) {
    const [n, hits] = line.slice(3).split(',').map(Number);
    if (!hit.has(file)) hit.set(file, new Map());
    hit.get(file).set(n, hits);
  }
}
let executable = 0;
let covered = 0;
for (const [path, set] of lines) {
  const known = hit.get(path) ?? new Map();
  for (const n of set) {
    if (!known.has(n)) continue; // a comment, a type, a blank: not executable
    executable += 1;
    if (known.get(n) > 0) covered += 1;
  }
}
const share = executable ? covered / executable : 1;
const ratchet = JSON.parse(readFileSync(RATCHET, 'utf8'));
console.log(
  `coverage:diff: ${covered}/${executable} changed executable lines ran (${(share * 100).toFixed(1)} %), floor ${(ratchet.floor * 100).toFixed(1)} %`,
);
if (write && share > ratchet.floor) {
  writeFileSync(
    RATCHET,
    `${JSON.stringify({ ...ratchet, floor: Math.floor(share * 1000) / 1000 }, null, 2)}\n`,
  );
}
process.exit(share + 1e-9 < ratchet.floor ? 1 : 0);
