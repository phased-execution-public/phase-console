/**
 * One harness for the thin read routes (quiet-console phase 25): a console
 * with no source directory open, or one over a scratch library, and a request
 * through the REAL `handleApi` (`verb-harness.ts`'s `call`). Each route's own
 * file (`*-route.test.ts`, `prefs-schema.test.ts`) proves its shape against a
 * real `Service` and its seams, never a fake that re-states it.
 *
 * The consoles hold no capability flag: every route here is a read, and a
 * console over stored runs with `--allow-run` would adopt them.
 *
 * Import it AFTER `./state-sandbox.ts`, like everything that reaches `server/`.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';

export { call, scratch, tempDir, type Captured } from './verb-harness.ts';

/** A console with no source directory open — the state an "above the wall" route must answer in. */
export async function bareService() {
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  return svc;
}

/** A console over `root`, its source directory open. */
export async function service(root: string) {
  const svc = await bareService();
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** The body as JSON says it — what a typed value looks like once it has crossed the wire. */
export const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;
