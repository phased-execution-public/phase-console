/**
 * Each attempt's liveness is its own (control-tower phase 80, #99).
 *
 * Measured: observability-plane P26 attempt 5 booted at 11:32:23Z, and two
 * minutes later its lane read `lastOutputAt 09:51:26Z` — "no output for 102
 * min" — with the previous attempt's tokens still on it. The lane's signals
 * were made once per LANE (`runner-loop.ts`, `newLaneSignals`), so an attempt
 * the loop started in place (a spent cap, a wait, an outage) inherited the dead
 * session's clocks until the new one wrote. A watchdog flagged the fresh
 * session as hung.
 *
 * AL-1: every attempt resets the lane's liveness, stamped with the attempt
 * number and the new process's `procStartedAt` (the same stamp the child
 * record carries), keeping only the facts that belong to the phase.
 * AL-2: the stall detector therefore judges the live process: a new attempt
 * whose predecessor went quiet 102 minutes ago is not silent, and a stall the
 * dead session left is cleared, not inherited.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import type { SpawnFn, SpawnOutcome, StreamEvent } from '../server/runner/spawn.ts';
import type { LaneLiveness } from '../server/runner/liveness.ts';

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-attempt-liveness-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
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
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(stub, 'done'), `${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-A', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: [], injected: 0, ...partial,
  };
}

/** The CLI's own ending for a spent turn cap: the loop resumes the SAME session in place, at once. */
const TURN_CAP = { subtype: 'error_max_turns', code: 1, text: '' } as SpawnOutcome['signal'];

/** One API call's usage, folded — what puts `tokens` on a lane. */
function usage(context: number): StreamEvent {
  return {
    kind: 'usage',
    call: { input: 10, cacheWrite: 0, cacheRead: context - 10, output: 200, context },
    rebuild: false,
    totals: {
      calls: 3, firstContext: 40_000, lastContext: context, peakContext: context,
      input: 30, cacheWrite: 0, cacheRead: context * 3, output: 600, rebuilds: 0,
    },
  } as unknown as StreamEvent;
}

const T0 = Date.parse('2026-09-24T09:51:26.000Z');
const GAP_MS = 102 * 60_000;

function harness(r: Repo, spawn: (instance: Runner, clock: { ms: number }) => SpawnFn) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const clock = { ms: T0 };
  let instance!: Runner;
  instance = new Runner({
    scriptsDir: r.scripts,
    spawn: (request) => spawn(instance, clock)(request),
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    now: () => new Date(clock.ms),
  });
  return { instance, events, clock };
}

test('AL-1: each attempt starts its own liveness — the dead session\'s clocks and tokens are gone, and the lane is stamped with the attempt and its procStartedAt', async () => {
  const r = repo();
  const seen: { live: LaneLiveness; child?: string }[] = [];
  let calls = 0;
  const { instance } = harness(r, (runner, clock) => async (request) => {
    calls += 1;
    request.onPid?.(90_000 + calls);
    const live = runner.liveness().find((lane) => lane.phase === 1)!;
    seen.push({ live, child: runner.current()?.children?.['1']?.procStartedAt });
    if (calls === 1) {
      request.onEvent?.({ kind: 'text', text: 'Wrote the parser; the suite is next.' } as StreamEvent);
      request.onEvent?.(usage(180_000));
      // The 102 minutes of #99 pass before the loop boots the next attempt.
      clock.ms += GAP_MS;
      return ok({ signal: TURN_CAP, turns: 40 });
    }
    r.markDone(1);
    return ok();
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.equal(calls, 2, 'the spent cap resumed the phase in place — one lane, two attempts');
  assert.equal(instance.current()!.phases['1'].status, 'done');
  const [first, second] = seen;
  assert.equal(first.live.attempt, 1, 'the first attempt is stamped 1');
  assert.equal(second.live.attempt, 2, 'the second attempt is stamped 2');
  assert.ok(second.live.procStartedAt, 'the second attempt carries its process\'s start');
  assert.equal(second.live.procStartedAt, second.child, 'the stamp is the child record\'s own procStartedAt');
  assert.equal(
    second.live.lastOutputAt, new Date(T0 + GAP_MS).toISOString(),
    'the new attempt\'s clock starts at its own boot, not at the dead session\'s last output',
  );
  assert.equal(second.live.tokens, undefined, 'the dead session\'s context is not the live one\'s');
  assert.equal(second.live.turnsSinceLastTool, 0);
  assert.equal(second.live.retries, undefined);
  r.cleanup();
});

test('AL-1: the reset keeps what belongs to the PHASE — the stalemate count and the tree — and the record\'s own snapshot moves with it', async () => {
  const r = repo();
  let calls = 0;
  let recordAtBoot: LaneLiveness | undefined;
  const { instance } = harness(r, (runner, clock) => async (request) => {
    calls += 1;
    request.onPid?.(91_000 + calls);
    if (calls === 1) {
      request.onEvent?.({ kind: 'text', text: 'Halfway through the migration.' } as StreamEvent);
      request.onEvent?.(usage(150_000));
      // The record's copy is what a checkpoint and a watchdog read (#99 read it).
      await runner.tickLiveness();
      clock.ms += GAP_MS;
      return ok({ signal: TURN_CAP, turns: 30 });
    }
    recordAtBoot = runner.current()!.phases['1'].liveness;
    r.markDone(1);
    return ok();
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.ok(recordAtBoot, 'the record carries a liveness snapshot at the second boot');
  assert.equal(recordAtBoot!.attempt, 2);
  assert.equal(recordAtBoot!.lastOutputAt, new Date(T0 + GAP_MS).toISOString(),
    'the record\'s snapshot is reset with the lane, not left for the next tick');
  assert.equal(recordAtBoot!.tokens, undefined);
  r.cleanup();
});

test('AL-2: a new attempt booted 102 minutes after the last output is not silent, and the dead session\'s stall is cleared rather than inherited', async () => {
  const r = repo();
  let calls = 0;
  const stallAt: { attempt: number; signal: string | null }[] = [];
  const { instance, events } = harness(r, (runner, clock) => async (request) => {
    calls += 1;
    request.onPid?.(92_000 + calls);
    if (calls === 1) {
      request.onEvent?.({ kind: 'text', text: 'Starting the long build.' } as StreamEvent);
      // The session goes quiet for 102 minutes: the detector is right to say so.
      clock.ms += GAP_MS;
      await runner.tickLiveness();
      stallAt.push({ attempt: 1, signal: runner.current()!.phases['1'].stall?.signal ?? null });
      return ok({ signal: TURN_CAP, turns: 12 });
    }
    // The next attempt has just booted. One minute in, it has said nothing yet.
    clock.ms += 60_000;
    await runner.tickLiveness();
    stallAt.push({ attempt: 2, signal: runner.current()!.phases['1'].stall?.signal ?? null });
    r.markDone(1);
    return ok();
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  await instance.wait();

  assert.deepEqual(stallAt[0], { attempt: 1, signal: 'silent' }, 'the quiet session was silent — the detector works');
  assert.deepEqual(stallAt[1], { attempt: 2, signal: null }, 'the live process is one minute old, not 103 minutes silent');
  const silentStalls = journalled(events, 'phase.stall').filter((line) => line.signal === 'silent');
  assert.equal(silentStalls.length, 1, 'one episode, on the attempt that earned it');
  assert.equal(silentStalls[0].attempt, 1);
  const cleared = journalled(events, 'phase.liveness').find((line) => line.reason === 'new-attempt');
  assert.ok(cleared, 'the episode ends with the attempt that had it');
  assert.equal(cleared!.cleared, 'silent');
  assert.equal(cleared!.attempt, 2);
  r.cleanup();
});
