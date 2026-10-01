/**
 * A console's node arguments, and its launchd unit's (control-tower #71).
 *
 * `nodeArgsFor(profile)` — the heap size, and the near-limit snapshot when it
 * is asked for — reached a launchd unit only when `agent.sh install` rendered
 * one. `update` and `restart` exited and let launchd bring the console back
 * through the definition it already had loaded, so a unit rendered before the
 * heap argument existed never got it, and one console ran on V8's default heap
 * while nothing anywhere said so.
 *
 *  - UA-1  a unit whose ProgramArguments lack the profile's node arguments
 *          reads as drifted; one that carries them reads clean.
 *  - UA-2  a restart re-renders a drifted unit in place — the profile's node
 *          arguments between the binary and the script, every other argument
 *          and key unchanged — and asks launchd to reload it, through an
 *          injected spawner, with the launchctl argv `agent.sh install` uses.
 *          The console's own restart hands that reload to its restarter, and
 *          the restart an update ends in judges the unit by the node
 *          arguments the update shipped.
 *  - UA-3  a unit that cannot be re-rendered refuses the restart, naming the
 *          command a person runs — at the door, before an update is spent.
 *  - UA-4  `/api/state` reports `process.execArgv`, and the unit's arguments.
 *
 * Every unit here lives in a temporary directory, every launchctl is a fake
 * that records its argv, and the one real shell spawned is handed that fake by
 * absolute path — nothing in this file can reach the machine's own launchd.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';

const TRASH: string[] = [];
process.on('exit', () => {
  for (const dir of TRASH) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pc-unit-args-${label}-`));
  TRASH.push(dir);
  return dir;
}

/** A Service over a throwaway library, the way the restart tests build one. */
function serviceOver(root: string) {
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/* ------------------------------------------------------------------ *
 * UA-4 — what /api/state says about this process
 * ------------------------------------------------------------------ */

test('UA-4 — /api/state reports process.execArgv, the half process.argv never carries', () => {
  const svc = serviceOver(tempDir('state'));
  try {
    const state = svc.state() as unknown as { execArgv?: unknown };
    assert.ok(Array.isArray(state.execArgv), `state() carries no execArgv: ${JSON.stringify(state.execArgv)}`);
    assert.deepEqual(state.execArgv, process.execArgv, 'it is THIS process’s node arguments, verbatim');
  } finally {
    svc.close();
  }
});

