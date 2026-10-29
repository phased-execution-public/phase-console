// `npm run test:mutation [-- <base>]` — the nightly mutation run (measured-console
// phase 15). Never a gate: it spends minutes per module and its findings are a
// module owner's reading, not a verdict. It mutates only the server and shared
// modules changed since <base> (default origin/main), runs the node tests that
// name each one (the phase tier's own map, runner/verify-select.ts), and keeps
// Stryker's incremental file so a night re-tests only what moved.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedSince, plannedFiles, testsNaming } from '../server/runner/verify-select.ts';

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(VIEWER, '..');
const base = process.argv[2] ?? 'origin/main';
const changed = changedSince(ROOT, base);
if (!changed) {
  console.error(`test:mutation: git cannot diff against ${base}`);
  process.exit(2);
}
const modules = changed.filter(
  (path) => /^viewer\/(server|shared)\/.+\.(ts|js|mjs)$/.test(path) && !path.endsWith('.d.ts'),
);
if (!modules.length) {
  console.log(`test:mutation: no server or shared module changed since ${base} — nothing to mutate`);
  process.exit(0);
}
const planned = plannedFiles(ROOT, 'node');
const tests = [...new Set(modules.flatMap((path) => testsNaming(ROOT, planned, path) ?? []))].sort();
if (!tests.length) {
  console.log(
    `test:mutation: no test names ${modules.join(', ')} — every mutant would survive; write the test first`,
  );
  process.exit(0);
}
const command = `node --test --test-force-exit --test-concurrency=1 ${tests.map((t) => t.replace(/^viewer\//, '')).join(' ')}`;
console.log(`test:mutation: ${modules.length} module(s), ${tests.length} test file(s)`);
const run = spawnSync(
  'npx',
  [
    '--yes',
    '@stryker-mutator/core@9',
    'run',
    'stryker.config.mjs',
    '--mutate',
    modules.map((m) => m.replace(/^viewer\//, '')).join(','),
  ],
  { cwd: VIEWER, stdio: 'inherit', env: { ...process.env, STRYKER_TEST_COMMAND: command } },
);
process.exit(run.status ?? 1);
