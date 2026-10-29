// `npm run typecheck:test` — the node suite's type gate (measured-console phase 15).
//
// `viewer/test` was typechecked by no gate: `server/tsconfig.json` excludes it,
// "whose fakes carry their own large backlog", so a stale test double surfaced
// only when its test ran. This checks every file under `test/` against the
// server's strict program (`test/tsconfig.json`) and holds the backlog to a
// RATCHET, `test/typecheck-ratchet.json`: each file may carry at most the
// errors it carried when the ratchet was written. A file not in it — every new
// test — must be clean; a file over its count fails, naming the errors; a file
// under it is reported, and `--write` lowers the ratchet to what was measured
// (it never raises a count, and drops a file that reached zero).
//
//   node scripts/typecheck-test.mjs [--write]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET = join(VIEWER, 'test', 'typecheck-ratchet.json');
const write = process.argv.includes('--write');

const tsc = spawnSync(
  process.execPath,
  [
    join(VIEWER, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    'test/tsconfig.json',
    '--noEmit',
    '--pretty',
    'false',
  ],
  { cwd: VIEWER, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const errors = new Map();
for (const line of `${tsc.stdout}\n${tsc.stderr}`.split('\n')) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
  if (!match) continue;
  const list = errors.get(match[1]) ?? [];
  list.push(line);
  errors.set(match[1], list);
}
if (tsc.status !== 0 && errors.size === 0) {
  console.error(`typecheck:test: tsc exited ${tsc.status} naming no error:\n${tsc.stdout}${tsc.stderr}`);
  process.exit(1);
}

function readRatchet() {
  try {
    return JSON.parse(readFileSync(RATCHET, 'utf8')).files ?? {};
  } catch {
    return {};
  }
}
const ratchet = readRatchet();

const over = [];
const under = [];
for (const [file, list] of errors) {
  const allowed = ratchet[file] ?? 0;
  if (list.length > allowed) over.push({ file, count: list.length, allowed, list });
  else if (list.length < allowed) under.push({ file, count: list.length, allowed });
}
for (const [file, allowed] of Object.entries(ratchet)) {
  if (!errors.has(file)) under.push({ file, count: 0, allowed });
}

const total = [...errors.values()].reduce((sum, list) => sum + list.length, 0);
const recorded = Object.values(ratchet).reduce((sum, n) => sum + n, 0);
for (const { file, count, allowed, list } of over) {
  console.error(`${file}: ${count} type error(s), the ratchet allows ${allowed}:`);
  for (const line of list.slice(0, 20)) console.error(`  ${line}`);
  if (list.length > 20) console.error(`  … and ${list.length - 20} more`);
}
if (under.length) {
  console.log(
    `typecheck:test: ${under.length} file(s) under the ratchet — ${write ? 'lowered' : 'run with --write to lower it'}:`,
  );
  for (const { file, count, allowed } of under) console.log(`  ${file}: ${allowed} → ${count}`);
}
if (write && !over.length) {
  const files = {};
  for (const [file, list] of [...errors].sort(([a], [b]) => a.localeCompare(b))) files[file] = list.length;
  writeFileSync(
    RATCHET,
    `${JSON.stringify({ note: 'type errors each viewer/test file may still carry — npm run typecheck:test; lowered by --write, never raised', total, files }, null, 2)}\n`,
  );
}
if (over.length) {
  console.error(
    `typecheck:test: ${over.length} file(s) over the ratchet (${total} errors now, ${recorded} recorded)`,
  );
  process.exit(1);
}
console.log(
  `typecheck:test: green — ${total} known error(s) in ${errors.size} file(s), none new (ratchet ${recorded})`,
);
