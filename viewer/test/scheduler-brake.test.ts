/**
 * The usage brake lands on the SESSION's account (one-pool phase 7, #287).
 *
 * A brake engaged on admin@ at "95 %" while admin@'s own buckets read 20 % and 43 %: the
 * readings came from sessions still live on mobin@, and a boundary switch had already moved
 * the run's `accountId` to admin@ — so `engageUsageBrake(state.accountId)` braked the account
 * with headroom, for mobin@'s weekly reset, and the release read the same wrong id.
 *
 * SB-1  a pending boundary switch plus a `limits` warning from the old session brakes only the
 *       old account — the new one stays free
 * SB-2  a reading from the old session under the warning releases the old account's brake,
 *       and never touches the new one's
 *
 * The harness is `usage-brake.test.ts`'s: a temporary repo with stub engine scripts, and only
 * the `claude` child faked.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runner } from '../server/runner/runner.ts';
import { Scheduler } from '../server/runner/scheduler.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';
import { stubRepo, FREE_LOCK_SH, VALIDATE_OK_SH } from './fixtures/repo.ts';
import { dateClock } from './fixtures/clock.ts';

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

/** A linear three-phase plan whose board is a `done` file the fake session appends to. */
function stubbedPlan(): Repo {
  const made = stubRepo({
    prefix: 'pc-usage-brake-',
    scripts: ({ state }) => ({
      'phase-graph.sh': `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""; w=""; found=0
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ] || [ -f "$S/parallel" ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`,
      'phase-lock.sh': FREE_LOCK_SH,
      'validate.sh': VALIDATE_OK_SH,
    }),
  });
  return made;
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

function runner(r: Repo, spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

/* ------------------------------------------------------------------ *
 * The live wall: act on the first burst when nothing can change (H6)
 * ------------------------------------------------------------------ */

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** A session held open with its event sink captured. */
function streamingSession(r: Repo, markDone = true) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    entered();
    await held;
    if (markDone) r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}


test('SB-1/SB-2 (#287): a reading from a session still live on the old account brakes and releases THAT account, never the one a boundary switch moved the run to', async () => {
  const r = stubbedPlan();
  const held = streamingSession(r);
  const clock = dateClock('2026-10-08T18:30:00Z');
  const scheduler = new Scheduler({ now: () => clock.now().getTime(), locks: () => [] });
  const { instance, events } = runner(r, held.spawn, {
    now: clock.now, scheduler, pickAccount: () => null, autoAccountSwitch: () => false,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'wait', accountId: 'mobin' });
    await held.inSession;
    // The supervisor's boundary switch: the run is on admin@ now, the live session still on mobin@.
    const moved = instance.switchAccount('admin', 'supervisor', { when: 'boundary' });
    assert.equal(moved.ok, true);
    assert.equal(instance.current()?.accountId, 'admin', 'the run moved');
    const reset = Date.parse('2026-10-10T00:00:00Z') / 1000;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'seven_day', utilization: 0.95, utilizationPct: 95, resetsAt: reset });

    assert.ok(scheduler.brakeOf('mobin'), 'the account the reading is about is braked');
    assert.equal(scheduler.brakeOf('admin'), null, 'the account the run moved to is NOT braked (#287)');
    assert.deepEqual(journalled(events, 'run.usage-brake').map((row) => row.accountId), ['mobin']);

    // SB-2: the old session reads the window under the warning — the old brake goes, and only it.
    clock.wind(10 * 60_000);
    held.say({ kind: 'limits', status: 'allowed', window: 'seven_day', utilization: 0.4, utilizationPct: 40, resetsAt: reset });
    assert.equal(scheduler.brakeOf('mobin'), null);
    assert.deepEqual(journalled(events, 'run.usage-brake-released').map((row) => [row.accountId, row.reason]), [['mobin', 'below-warn']]);
  } finally {
    held.release();
    await instance.wait();
    scheduler.close();
    r.cleanup();
  }
});
