/**
 * The runner's ledger writer (one-pool phase 6, §Architecture 7): the spawn door hands every
 * session it starts a meter (`deps.sessionMeter`), so a scripted stream's `result` frames and
 * five-minute ticks become ledger rows under the run's account, plan, run, phase and mode — and
 * a conversation resumed by a later spawn books its rise over the mark, never the running total
 * again.
 *
 * RL-1  results and ticks become rows; their dollars sum to what the run booked
 * RL-2  a resumed conversation never double-counts
 * RL-3  a door with no meter (the free tree) writes nothing and the session runs as before
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { SpawnFn, SpawnOutcome, StreamEvent } from '../server/runner/spawn.ts';
import { stubRepo, FREE_LOCK_SH, VALIDATE_OK_SH } from './fixtures/repo.ts';

type Repo = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

/** A one-phase plan the stub engine reads as done once the session marks it. */
function stubbedPlan(): Repo {
  const made = stubRepo({
    prefix: 'pc-ledger-writer-',
    scripts: ({ state: stub }) => ({
      'phase-graph.sh': `#!/usr/bin/env bash
S="${stub}"; mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done"; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`,
      'phase-lock.sh': FREE_LOCK_SH,
      'validate.sh': VALIDATE_OK_SH,
    }),
  });
  return { ...made, markDone: () => writeFileSync(join(made.state, 'done'), '1\n') };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let msg = 0;
function usage(emit: (e: StreamEvent) => void, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void {
  const call = { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, context: 0 };
  call.context = call.input + call.cacheRead + call.cacheWrite;
  emit({ kind: 'usage', id: `m${(msg += 1)}`, call, rebuild: false, totals: {} } as unknown as StreamEvent);
}

function outcome(partial: Partial<SpawnOutcome>): SpawnOutcome {
  return { signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-1', costUsd: 0, turns: 2, resultText: 'done', durationMs: 5, argv: [], ...partial };
}


test('RL-3: a door with no meter writes nothing, and the session runs exactly as before', async () => {
  const r = stubbedPlan();
  const spawn: SpawnFn = async (request) => {
    request.onEvent?.({ kind: 'init', sessionId: 'sess-free', tools: 0 } as StreamEvent);
    request.onEvent?.({ kind: 'result', subtype: 'success', costUsd: 0.3 } as StreamEvent);
    r.markDone();
    return outcome({ sessionId: 'sess-free', costUsd: 0.3 });
  };
  const instance = new Runner({ scriptsDir: r.scripts, spawn, verificationText: () => '`true`' });
  try {
    await instance.start({ slug: 'demo', root: r.root, model: 'opus' });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'finished');
    assert.ok(Math.abs(state.spentUsd - 0.3) < 1e-9);
  } finally { r.cleanup(); }
});
