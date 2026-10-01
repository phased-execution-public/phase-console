/**
 * `npm run test:e2e` — the tour, then the check that it left nothing running.
 *
 * Playwright runs as it always did; the fixture console appends its sandbox
 * directory to the file named by `PHASE_CONSOLE_E2E_ROOTS`, and once Playwright
 * has exited — its web servers stopped, the fixture's teardown done — any
 * process whose command line still names one of those directories is a leak,
 * and the run fails naming it (#90). The leak is ended either way: a failed
 * check must not become the next run's leftover.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leftovers, reap } from './fixture/reap.ts';

const scratch = mkdtempSync(join(tmpdir(), 'pc-e2e-roots-'));
const rootsFile = join(scratch, 'roots');
// The package's own Playwright, found without npm's PATH, so `node e2e/run.ts` works too.
const PLAYWRIGHT = fileURLToPath(new URL('../node_modules/.bin/playwright', import.meta.url));
const tour = spawnSync(PLAYWRIGHT, ['test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PHASE_CONSOLE_E2E_ROOTS: rootsFile },
});

let roots: string[] = [];
try {
  roots = readFileSync(rootsFile, 'utf8').split('\n').filter(Boolean);
} catch {
  /* the fixture never started: nothing to check */
}
rmSync(scratch, { recursive: true, force: true });

const survived = roots.flatMap((root) => leftovers(root));
if (survived.length) {
  process.stderr.write(
    `test:e2e: ${survived.length} process(es) naming the tour's temp directory outlived it:\n` +
      survived
        .map((left) => `  pid ${left.pid} (group ${left.pgid}) ${left.command.slice(0, 200)}`)
        .join('\n') +
      '\n',
  );
  for (const root of roots) await reap(root);
}
if (tour.error) process.stderr.write(`test:e2e: could not run playwright — ${tour.error.message}\n`);
process.exit(survived.length ? 1 : (tour.status ?? 1));
