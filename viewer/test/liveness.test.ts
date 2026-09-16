/**
 * The pure half of stall detection: fold the stream, then decide.
 *
 * Everything here is arithmetic on numbers that are passed in — no clock, no
 * filesystem, no runner — which is the whole reason `runner/liveness.ts` was
 * split out. The runner-side behaviour (the 60-second ticker, `git`, the
 * journal, the announcement, the once-per-episode rule) is driven by a fake
 * clock in `runner.test.ts`; this file pins what those are driving.
 */

// Redirects XDG_STATE_HOME before anything under `server/` resolves it. Static
// imports evaluate in source order, so this has to stay first.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEvent, evaluateStall, livenessOf, newLaneSignals, noteWaitDenied, oldestOpenTool, stallThresholds,
  type LaneSignals,
  mintWatchRef, WATCH_ONESHOT_LEADS, waitScope,
} from '../server/runner/liveness.ts';
import { VERIFY_ENV_FALLBACK } from '../server/runner/verify-env.ts';
import { STALL_DEFAULTS, STALL_LOCAL_JOB_MS, STALL_SIGNALS } from '../shared/attention-model.js';
import type { StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

/** Fold a list of `[event, at]` pairs into a fresh accumulator. */
function fold(events: [StreamEvent, number][], start = T0): LaneSignals {
  const signals = newLaneSignals(start);
  for (const [event, at] of events) applyEvent(signals, event, at);
  return signals;
}

const step = (tools: number): StreamEvent => ({ kind: 'step', tools });
const tool = (id: string, name = 'Bash'): StreamEvent => ({ kind: 'tool', id, name, summary: name });
const result = (id: string): StreamEvent => ({ kind: 'tool-result', id, ok: true });

/* ------------------------------------------------------------------ *
 * The thresholds
 * ------------------------------------------------------------------ */

test('the shipped thresholds are the shared ones, and nonsense falls back to them', () => {
  // `STALL_DEFAULTS` is a bijection with the SIGNALS — one detector threshold
  // each — so the second clock on `external-wait` lives beside it, exactly
  // where `STALL_ESCALATE_MS` does. `stallThresholds()` is the one place the
  // two are merged, which is why the spread is here and not in the object.
  const SHIPPED = { ...STALL_DEFAULTS, stallLocalJobMs: STALL_LOCAL_JOB_MS };
  assert.deepEqual(stallThresholds(), SHIPPED);
  assert.deepEqual(stallThresholds(null), SHIPPED);
  assert.equal(stallThresholds({ stallLocalJobMs: 90_000 }).stallLocalJobMs, 90_000);
  assert.equal(stallThresholds({ stallLocalJobMs: 0 }).stallLocalJobMs, STALL_LOCAL_JOB_MS);
  assert.equal(stallThresholds({ stallSilentMs: 90_000 }).stallSilentMs, 90_000);
  // Zero is not "off" here — it would flag every lane on its first tick.
  assert.equal(stallThresholds({ stallSilentMs: 0 }).stallSilentMs, STALL_DEFAULTS.stallSilentMs);
  assert.equal(stallThresholds({ stallSpinTurns: -1 }).stallSpinTurns, STALL_DEFAULTS.stallSpinTurns);
  assert.equal(
    stallThresholds({ stallStalemateAttempts: Number.NaN }).stallStalemateAttempts,
    STALL_DEFAULTS.stallStalemateAttempts,
  );
  assert.equal(stallThresholds({ stallRetryBurst: 2 }).stallRetryBurst, 2);
  assert.equal(stallThresholds({ stallRetryBurst: 0 }).stallRetryBurst, STALL_DEFAULTS.stallRetryBurst);
  assert.equal(stallThresholds({ stallExternalWaitMs: 90_000 }).stallExternalWaitMs, 90_000);
  // The one detector threshold where zero IS a setting: "never call a lane
  // waiting" — what Settings has always promised ("0 never parks a lane for
  // waiting") while `positive` quietly turned it back into five minutes
  // (SLF-9, KNOWN-SINCE). Nonsense still falls back.
  assert.equal(stallThresholds({ stallExternalWaitMs: 0 }).stallExternalWaitMs, 0);
  assert.equal(stallThresholds({ stallExternalWaitMs: -1 }).stallExternalWaitMs, STALL_DEFAULTS.stallExternalWaitMs);
  assert.equal(
    stallThresholds({ stallExternalWaitMs: Number.NaN }).stallExternalWaitMs,
    STALL_DEFAULTS.stallExternalWaitMs,
  );
});

test('the external-wait clock is shorter than the silence clock, or it can never fire first', () => {
  // Not a style preference. Both are measured from roughly the same instant
  // (the call goes out, nothing comes back), `evaluateStall` returns the first
  // signal that holds, and `external-wait` outranks `silent` — so if its clock
  // were the longer of the two, the rank would never be reached and the whole
  // detector would be dead code that still passed its own unit tests.
  assert.ok(STALL_DEFAULTS.stallExternalWaitMs < STALL_DEFAULTS.stallSilentMs);
});

/* ------------------------------------------------------------------ *
 * Folding the stream
 * ------------------------------------------------------------------ */

test('every event is output, so a lane that only ever wrote to stderr is not silent', () => {
  const signals = fold([[{ kind: 'stderr', text: 'npm warn' }, T0 + MINUTE]]);
  assert.equal(signals.lastOutputAt, T0 + MINUTE);
});

test('a turn with tool calls resets the spin counter; a turn without one advances it', () => {
  const signals = fold([
    [step(0), T0 + 1], [step(0), T0 + 2], [step(0), T0 + 3],
  ]);
  assert.equal(signals.turnsSinceLastTool, 3);

  applyEvent(signals, step(2), T0 + 4);
  assert.equal(signals.turnsSinceLastTool, 0, 'a turn that called something is not spinning');
});

test('a tool call opens, a result closes, and the OLDEST unanswered one is the one named', () => {
  const signals = fold([
    [tool('a', 'Bash'), T0 + MINUTE],
    [tool('b', 'Read'), T0 + 2 * MINUTE],
  ]);
  assert.equal(oldestOpenTool(signals)?.name, 'Bash');
  assert.equal(signals.lastToolUseAt, T0 + 2 * MINUTE);

  applyEvent(signals, result('a'), T0 + 3 * MINUTE);
  assert.equal(oldestOpenTool(signals)?.name, 'Read', 'closing the oldest promotes the next');

  applyEvent(signals, result('b'), T0 + 4 * MINUTE);
  assert.equal(oldestOpenTool(signals), undefined);
});

test("a subagent's calls are its own — they never reset the phase's spin counter", () => {
  // The measured shape: a delegating turn calls `Task`, then the phase's own
  // conversation stops while the subagent works. Counting the subagent's tool
  // traffic as the phase's would make the lane look busy at exactly the moment
  // it is worth asking whether the delegation is coming back.
  const signals = fold([[step(0), T0 + 1], [step(0), T0 + 2]]);
  applyEvent(signals, { kind: 'tool', id: 'x', name: 'Grep', summary: 'g', parent: 'call-1' }, T0 + 3);
  assert.equal(signals.turnsSinceLastTool, 2, "a subagent's call is not the phase acting");
  assert.equal(signals.lastToolUseAt, undefined);
  assert.equal(oldestOpenTool(signals), undefined, 'and it opens no call on this lane');
});

test('an operator steering the session buys it a fair hearing', () => {
  const signals = fold([[step(0), T0 + 1], [step(0), T0 + 2], [step(0), T0 + 3]]);
  applyEvent(signals, { kind: 'injected', text: 'try the other route', mark: 'm1' }, T0 + 4);
  assert.equal(signals.turnsSinceLastTool, 0, 'a nudge must not trip the same card on the next turn');
});

test('the open-call list is bounded, so a session that leaks ids costs bounded memory', () => {
  const signals = newLaneSignals(T0);
  for (let i = 0; i < 200; i++) applyEvent(signals, tool(`id-${i}`), T0 + i);
  assert.ok(signals.openTools.length <= 64, `bounded, got ${signals.openTools.length}`);
});

/* ------------------------------------------------------------------ *
 * Deciding
 * ------------------------------------------------------------------ */

test('a lane that has just spoken is not stalled', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 2 * MINUTE), null);
});

test('silence past the threshold is `silent`, and it names the call open longest', () => {
  const signals = fold([[tool('a', 'Bash'), T0 + MINUTE]]);
  const now = T0 + MINUTE + 14 * MINUTE;
  const stall = evaluateStall(signals, stallThresholds(), now);
  assert.equal(stall?.signal, 'silent');
  assert.match(stall!.detail, /no output for 14 min/);
  assert.match(stall!.detail, /oldest open tool call is Bash/);
  // The episode starts when the silence began, NOT when the tick noticed it —
  // otherwise the card's clock restarts every minute and never ages.
  assert.equal(stall!.since, new Date(T0 + MINUTE).toISOString());
});

test('with nothing open, `silent` says so rather than naming a call it does not have', () => {
  const signals = fold([[step(1), T0]]);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 11 * MINUTE);
  assert.match(stall!.detail, /no tool call is open/);
});

test('turns without a tool call past the threshold are `spinning`', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 6; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  const stall = evaluateStall(signals, stallThresholds(), T0 + 7_000);
  assert.equal(stall?.signal, 'spinning');
  assert.match(stall!.detail, /6 turns with no tool call/);
});

test('idle attempts past the threshold are `stalemate`, the strongest of the four', () => {
  const signals = newLaneSignals(T0, { idleAttempts: 3 });
  const stall = evaluateStall(signals, stallThresholds(), T0 + 1_000);
  assert.equal(stall?.signal, 'stalemate');
  assert.match(stall!.detail, /3 attempts in a row/);
});

test('worst-first: a lane that is both silent and spinning reports the newer, harder fact', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 8; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  // Spinning holds already...
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 9_000)?.signal, 'spinning');
  // ...and then it goes quiet, which is a stronger statement about the same lane.
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 20 * MINUTE)?.signal, 'silent');
  // A stalemate outranks both.
  signals.idleAttempts = 3;
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 20 * MINUTE)?.signal, 'stalemate');
  // ...and the order it reports in is the vocabulary's own.
  assert.deepEqual([...STALL_SIGNALS], ['stalemate', 'retrying', 'external-wait', 'silent', 'spinning']);
});

/* ------------------------------------------------------------------ *
 * The retry storm — the wall that never exits
 * ------------------------------------------------------------------ */

test('a retry is output but NOT progress: it never refreshes the silence clock', () => {
  // The measured failure. A session hit the five-hour wall and entered the
  // CLI's own retry watchdog, which retried every thirty seconds for three and
  // a half hours. `applyEvent` stamped `lastOutputAt` for every event
  // including `retry`, so the retry cadence held the lane's own silence clock
  // permanently below threshold and every stall watchdog was blinded at once.
  const signals = newLaneSignals(T0);
  applyEvent(signals, step(1), T0 + MINUTE);
  for (let i = 1; i <= 40; i++) {
    applyEvent(signals, { kind: 'retry', category: 'rate_limit', attempt: i }, T0 + MINUTE + i * 30_000);
  }
  const now = T0 + MINUTE + 40 * 30_000;

  // Heard from constantly...
  assert.equal(signals.lastOutputAt, now, 'the console DID hear from it');
  // ...and producing nothing since the last real turn.
  assert.equal(signals.lastProductiveAt, T0 + MINUTE, 'and it has produced nothing since');
  assert.ok(now - signals.lastProductiveAt > STALL_DEFAULTS.stallSilentMs,
    'twenty minutes of retries is well past the silence threshold');

  // With `retrying` switched off by a very high threshold, the storm still
  // reads as `silent` — the clock split alone fixes the blinding.
  const quiet = evaluateStall(signals, stallThresholds({ stallRetryBurst: 10_000 }), now);
  assert.equal(quiet?.signal, 'silent');
  assert.equal(quiet!.since, new Date(T0 + MINUTE).toISOString(),
    'and the episode is dated from the last real output, not the last retry');
});

test('N retries with nothing between them is `retrying`, and it outranks `silent`', () => {
  const signals = newLaneSignals(T0);
  applyEvent(signals, step(1), T0 + MINUTE);
  for (let i = 1; i <= STALL_DEFAULTS.stallRetryBurst; i++) {
    applyEvent(signals, { kind: 'retry', category: 'rate_limit', attempt: i }, T0 + MINUTE + i * 30_000);
  }
  const now = T0 + 30 * MINUTE;
  const stall = evaluateStall(signals, stallThresholds(), now);
  assert.equal(stall?.signal, 'retrying', 'the same fact as `silent`, with its cause attached');
  assert.match(stall!.detail, /5 API retries in a row/);
  assert.match(stall!.detail, /rate_limit/);
  // Dated from the FIRST retry of the burst, not the fifth — the episode is
  // the storm, and a card whose clock starts when the tick noticed never ages.
  assert.equal(stall!.since, new Date(T0 + MINUTE + 30_000).toISOString());
});

test('one real event between retries ends the burst — an absorbed blip is not a storm', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 4; i++) {
    applyEvent(signals, { kind: 'retry', category: 'rate_limit' }, T0 + i * 1_000);
  }
  assert.equal(signals.retriesSinceProgress, 4);
  // ...and the watchdog gets through.
  applyEvent(signals, step(1), T0 + 5_000);
  assert.equal(signals.retriesSinceProgress, 0, 'consecutive means consecutive');
  assert.equal(signals.retryBurstSince, undefined);
  assert.equal(signals.lastProductiveAt, T0 + 5_000);

  for (let i = 1; i <= 4; i++) {
    applyEvent(signals, { kind: 'retry', category: 'rate_limit' }, T0 + 5_000 + i * 1_000);
  }
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 10_000), null,
    'four is under the shipped five, so nothing holds');
});

test('a rate-limit heartbeat is not the session working either', () => {
  // `limits` is the account's usage window arriving out of band. Counting it
  // as productive output would let a warning heartbeat mask a silent session —
  // the same defect as `retry`, from the other direction.
  const signals = newLaneSignals(T0);
  applyEvent(signals, { kind: 'limits', status: 'allowed_warning', utilization: 0.97 }, T0 + 12 * MINUTE);
  assert.equal(signals.lastOutputAt, T0 + 12 * MINUTE);
  assert.equal(signals.lastProductiveAt, T0);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 12 * MINUTE)?.signal, 'silent');
});

test('`retrying` has its own knob, and it is a count rather than a clock', () => {
  const signals = newLaneSignals(T0);
  for (let i = 1; i <= 2; i++) applyEvent(signals, { kind: 'retry', category: 'rate_limit' }, T0 + i * 1_000);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 3_000), null);
  assert.equal(
    evaluateStall(signals, stallThresholds({ stallRetryBurst: 2 }), T0 + 3_000)?.signal,
    'retrying',
    'two retries is a storm to a console that says two is',
  );
});

test('`verifying` suppresses every signal — a build is silent and fine', () => {
  const signals = newLaneSignals(T0, { idleAttempts: 9 });
  for (let i = 1; i <= 20; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  const now = T0 + 3 * 60 * MINUTE;
  assert.ok(evaluateStall(signals, stallThresholds(), now), 'all three would otherwise hold');
  signals.verifying = true;
  assert.equal(evaluateStall(signals, stallThresholds(), now), null);
});

/**
 * D15 — `frozen` suppresses every signal, exactly as `verifying` does.
 *
 * A SIGSTOPped session produces nothing, so all three detectors hold on it
 * within minutes. Pressing Freeze therefore answered the operator with a stall
 * card about the thing they had just deliberately done. A deliberate act must
 * never be reported as a failure.
 */
test('`frozen` suppresses every signal — the operator stopped it on purpose', () => {
  const signals = newLaneSignals(T0, { idleAttempts: 9 });
  for (let i = 1; i <= 20; i++) applyEvent(signals, step(0), T0 + i * 1_000);
  const now = T0 + 3 * 60 * MINUTE;
  assert.ok(evaluateStall(signals, stallThresholds(), now), 'all three would otherwise hold');
  signals.frozen = true;
  assert.equal(evaluateStall(signals, stallThresholds(), now), null);
  // And the suppression LIFTS with the thaw — a lane that goes on being silent
  // after it is thawed is one the console should still speak up about.
  signals.frozen = false;
  assert.ok(evaluateStall(signals, stallThresholds(), now), 'thawing restores the detector');
});

test('a shorter threshold fires sooner — the knob is the knob', () => {
  const signals = fold([[step(1), T0]]);
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 2 * MINUTE), null);
  assert.equal(
    evaluateStall(signals, stallThresholds({ stallSilentMs: MINUTE }), T0 + 2 * MINUTE)?.signal,
    'silent',
  );
});

/* ------------------------------------------------------------------ *
 * The wire view
 * ------------------------------------------------------------------ */

test('the wire view carries every field the run payload promises, and omits what it has not got', () => {
  const signals = fold([[step(0), T0 + MINUTE]]);
  const bare = livenessOf(4, signals);
  assert.deepEqual(bare, {
    phase: 4,
    lastOutputAt: new Date(T0 + MINUTE).toISOString(),
    turnsSinceLastTool: 1,
    commitsSinceStart: 0,
    treeDirty: false,
  });
  assert.ok(!('lastToolUseAt' in bare), 'a lane that has called nothing has no last-call time');
  assert.ok(!('openTool' in bare) && !('stall' in bare));
  assert.ok(!('retries' in bare), 'a `retries: 0` on every lane row is noise, not information');

  applyEvent(signals, tool('a', 'Edit'), T0 + 2 * MINUTE);
  signals.commitsSinceStart = 2;
  signals.treeDirty = true;
  signals.stall = { signal: 'silent', since: 'x', detail: 'y' };
  const full = livenessOf(4, signals);
  assert.equal(full.lastToolUseAt, new Date(T0 + 2 * MINUTE).toISOString());
  assert.equal(full.openTool?.name, 'Edit');
  assert.equal(full.commitsSinceStart, 2);
  assert.equal(full.treeDirty, true);
  assert.equal(full.stall?.signal, 'silent');
});

test('a retry burst reaches the wire before it is a stall (D22)', () => {
  // 450 `phase.api-retry` events were journalled and read by NOTHING: a lane
  // retrying every ~16 minutes was indistinguishable from a lane thinking, and
  // one run died to a quota climb with no stall ever raised. The count on the
  // wire is what makes the difference visible while it is still under
  // `stallRetryBurst` — and it is the SAME counter the stall is judged on, so
  // the chip and the stall cannot disagree.
  const signals = fold([[step(0), T0 + MINUTE]]);
  for (let i = 1; i <= 2; i++) {
    applyEvent(signals, { kind: 'retry', category: 'rate_limit' }, T0 + MINUTE + i * 30_000);
  }
  const view = livenessOf(4, signals);
  assert.equal(view.retries?.count, 2);
  assert.equal(view.retries?.count, signals.retriesSinceProgress);
  assert.equal(view.retries?.since, new Date(signals.retryBurstSince!).toISOString());
  assert.ok(!('stall' in view), 'two retries is not yet a stall — that is the point of showing it');

  // Productive work clears the burst, and with it the chip: a lane that got
  // through must not keep wearing the badge of the wall it got past.
  applyEvent(signals, step(1), T0 + 3 * MINUTE);
  assert.ok(!('retries' in livenessOf(4, signals)));
});

/* ------------------------------------------------------------------ *
 * The external wait — squatting a lock on somebody else's clock
 * ------------------------------------------------------------------ */

/** The shared vocabulary, as the detector now takes it — the whole loaded env. */
const EXTERNAL_WAIT = VERIFY_ENV_FALLBACK;

/** A `Bash` call carrying a real command, the shape `summarise` produces. */
const bash = (id: string, command: string): StreamEvent =>
  ({ kind: 'tool', id, name: 'Bash', summary: command.replace(/\s+/g, ' ') });

const waited = (signals: LaneSignals, at: number) =>
  evaluateStall(signals, stallThresholds(), at, { verifyEnv: EXTERNAL_WAIT });

test('a poll loop open past the threshold is a wait, not a silence', () => {
  // The measured incident, in miniature: `local-ci-fast-feedback` phase 6 sat
  // 35+ minutes inside two concurrent `until … sleep` loops waiting on a
  // GitHub Actions build, while holding `scope=all` — an exclusive claim on
  // the whole tree. Nothing could see it: no event arrives while a Bash call
  // is open, and the lock's own keepalive kept the claim looking healthy.
  const signals = fold([[
    bash('a', 'until [ "$(gh run view 123 -q .status)" = completed ]; do sleep 45; done'),
    T0 + MINUTE,
  ]]);

  // Under the clock it is a call in flight like any other.
  assert.equal(waited(signals, T0 + 3 * MINUTE), null);

  const stall = waited(signals, T0 + 8 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  // The episode dates from when the CALL went out, not from the tick that
  // noticed — otherwise the card's clock restarts every minute.
  assert.equal(stall?.since, new Date(T0 + MINUTE).toISOString());
  // The detail names the fragment of the vocabulary that matched, because
  // "this lane is waiting" without saying on what is not actionable.
  assert.match(stall!.detail, /until .*; do/);
  assert.match(stall!.detail, /7 min/);
});

test('it beats `silent`, which would otherwise describe the same lane with the cause missing', () => {
  const signals = fold([[bash('a', 'gh run watch 456'), T0]]);
  // Well past the silence clock too — both hold, and the ranked one wins.
  const at = T0 + 40 * MINUTE;
  assert.equal(evaluateStall(signals, stallThresholds(), at)?.signal, 'silent',
    'without the vocabulary this is all the console can say');
  assert.equal(waited(signals, at)?.signal, 'external-wait',
    'with it, the console can say what the lane is waiting on');
});

test('no vocabulary means no signal — a missing list must lose the detector, never invent one', () => {
  const signals = fold([[bash('a', 'gh run watch 456'), T0]]);
  // No `verifyEnv` in the context at all: the console is driving a scripts
  // directory that predates the shared list, or a test is not asking. Past the
  // external-wait clock and still inside the silence clock, the honest answer
  // is nothing — the detector is simply absent, not replaced by a guess.
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 8 * MINUTE), null);
  // And past the silence clock it degrades to exactly what it said before this
  // signal existed.
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + 20 * MINUTE)?.signal, 'silent');
});

test('an ordinary long command is not a wait, however long it is open', () => {
  // The false positive that would matter: this ends a LIVE session and parks
  // the phase, so a build, a test suite and a migration must all be untouched.
  for (const command of [
    'npm test', 'pnpm verify:local', 'task drift', 'cargo build --release',
    'git push origin main', 'sleep 30', 'docker compose up -d',
  ]) {
    const signals = fold([[bash('a', command), T0]]);
    assert.notEqual(
      waited(signals, T0 + 40 * MINUTE)?.signal, 'external-wait',
      `${command} is work, not a wait`,
    );
  }
});

test('only a Bash call can be a wait — the vocabulary is command-shaped', () => {
  // A false positive here does not raise a card, it ends a live session. A
  // file literally called `tail -f.md` must not park a phase.
  const signals = newLaneSignals(T0);
  applyEvent(signals, { kind: 'tool', id: 'a', name: 'Read', summary: 'notes/tail -f.md' }, T0);
  assert.notEqual(waited(signals, T0 + 40 * MINUTE)?.signal, 'external-wait');
});

test('the wait ends when the call comes back', () => {
  const signals = fold([[bash('a', 'gh run watch 456'), T0]]);
  assert.equal(waited(signals, T0 + 8 * MINUTE)?.signal, 'external-wait');
  applyEvent(signals, result('a'), T0 + 9 * MINUTE);
  // The call is closed, so there is nothing open to be waiting inside — and
  // the result was productive, so the silence clock restarted with it.
  assert.equal(waited(signals, T0 + 10 * MINUTE), null);
});

test('two open waits are judged on the OLDER one', () => {
  // The incident had exactly two concurrent poll loops. `openTools` is
  // insertion-ordered, so the first match is the oldest — and the age is the
  // whole question.
  const signals = fold([
    [bash('a', 'gh run watch 1'), T0],
    [bash('b', 'until [ x = y ]; do sleep 30; done'), T0 + 4 * MINUTE],
  ]);
  const stall = waited(signals, T0 + 6 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.since, new Date(T0).toISOString(),
    'the newer loop is not yet past the threshold; the older one already is');
});

test('a verifying phase is exempt, like every other signal', () => {
  // A §Verification the RUNNER is running has its own inbox row
  // (`verify-hanging`); it must not also be parked as a squatting session,
  // because the lane has already exited and there is no turn to be inside.
  const signals = fold([[bash('a', 'gh run watch 456'), T0]]);
  signals.verifying = true;
  assert.equal(waited(signals, T0 + 40 * MINUTE), null);
});

test('the open-tool summary reaches the wire, so a reader sees what a lane is inside', () => {
  const signals = fold([[bash('a', 'gh run watch 456'), T0]]);
  assert.equal(oldestOpenTool(signals)?.summary, 'gh run watch 456');
  assert.equal(livenessOf(2, signals).openTool?.summary, 'gh run watch 456');
});

/* ------------------------------------------------------------------ *
 * A wait the console REFUSED (zero-touch-console phase 5, RCV-5's firing half)
 * ------------------------------------------------------------------ */

const DENIED_LOCAL = { command: 'until [ -f /tmp/suite.done ]; do sleep 30; done', matched: 'until [^`]+; *do' };

test('a refused local wait, then silence, raises external-wait from the refusal — no call ever opened', () => {
  const signals = newLaneSignals(T0);
  noteWaitDenied(signals, DENIED_LOCAL, T0 + MINUTE, STALL_LOCAL_JOB_MS);
  assert.equal(waited(signals, T0 + 4 * MINUTE), null, 'inside the external-wait threshold: nothing yet');
  const stall = waited(signals, T0 + 7 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.source, 'denied');
  assert.equal(stall?.scope, 'local', 'read off the refused command, like an open one');
  assert.equal(stall?.since, new Date(T0 + MINUTE).toISOString(), 'since the refusal, not the tick');
  assert.match(String(stall?.detail), /refused 1 in-turn wait/);
  // Outranks `silent` for the same reason an open wait does: the cause is named.
  assert.equal(waited(signals, T0 + 12 * MINUTE)?.signal, 'external-wait');
});

test('a session that took the refusal and went on working is left alone; one that keeps asking is not', () => {
  // Took it: one refusal, then real work every minute — the console asked for exactly this.
  const working = newLaneSignals(T0);
  noteWaitDenied(working, DENIED_LOCAL, T0, STALL_LOCAL_JOB_MS);
  for (let m = 1; m <= 8; m++) applyEvent(working, step(1), T0 + m * MINUTE);
  assert.equal(waited(working, T0 + 8 * MINUTE + 30_000), null);

  // Pressing: refused again inside the threshold, however busy it looks between.
  const pressing = newLaneSignals(T0);
  noteWaitDenied(pressing, DENIED_LOCAL, T0, STALL_LOCAL_JOB_MS);
  for (let m = 1; m <= 6; m++) applyEvent(pressing, step(1), T0 + m * MINUTE);
  noteWaitDenied(pressing, { ...DENIED_LOCAL, command: 'while ! test -f /tmp/suite.done; do sleep 20; done' }, T0 + 5 * MINUTE, STALL_LOCAL_JOB_MS);
  const stall = waited(pressing, T0 + 6 * MINUTE);
  assert.equal(stall?.source, 'denied');
  assert.match(String(stall?.detail), /refused 2 in-turn wait/);
  assert.equal(stall?.since, new Date(T0).toISOString(), 'one episode — `since` holds while refusals keep coming');
});

test('a commit or a declared outcome ends the refusal\'s episode; an old refusal is over whatever the lane does now', () => {
  for (const summary of ['git commit -m "wip"', 'bash scripts/phase-outcome.sh demo 3 waiting-external --wait-minutes 30 --watch cmd:"test -f /tmp/x"']) {
    const signals = newLaneSignals(T0);
    noteWaitDenied(signals, DENIED_LOCAL, T0, STALL_LOCAL_JOB_MS);
    applyEvent(signals, bash('t1', summary), T0 + MINUTE);
    applyEvent(signals, result('t1'), T0 + MINUTE + 1_000);
    assert.equal(signals.waitDenied, undefined, `${summary.slice(0, 20)}…: durable progress ends it`);
    assert.equal(waited(signals, T0 + 9 * MINUTE)?.source, undefined);
  }
  const stale = newLaneSignals(T0);
  noteWaitDenied(stale, DENIED_LOCAL, T0, STALL_LOCAL_JOB_MS);
  const late = T0 + STALL_LOCAL_JOB_MS + STALL_DEFAULTS.stallExternalWaitMs + MINUTE;
  assert.notEqual(waited(stale, late)?.source, 'denied', 'a refusal from before the local budget plus the threshold is history');
});

test('a refused `--watch` is a refused wait too: raised from the refusal, on the clock it names', () => {
  // REC-48's other half: the session's `--watch` was refused before it opened,
  // exactly like its `until … pgrep` loop, and has to reach the same ladder.
  const signals = newLaneSignals(T0);
  noteWaitDenied(signals, { command: 'gh pr checks 12 --watch', matched: '--watch' }, T0, STALL_LOCAL_JOB_MS);
  noteWaitDenied(signals, { command: 'gh pr checks 12 --watch --interval 30', matched: '--watch' }, T0 + 2 * MINUTE, STALL_LOCAL_JOB_MS);
  const stall = waited(signals, T0 + 6 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.source, 'denied');
  assert.equal(stall?.scope, 'external', 'gh names somebody else\'s clock — the park keeps the command as prose, no minted cmd: ref');
});

test('RCV-5: a refused local `--watch` is a LOCAL wait — the runner\'s ladder, not the external park — and its one-shot form is the minted ref', () => {
  // The commonest refusal in the corpus (`--watch` ×16 of 37): a test runner,
  // a build, a type-checker re-running on change — a session supervising
  // something it started. It used to read as `external` (nothing local named)
  // and park at once on the raw command as its "ref".
  for (const command of ['vitest --watch', 'node --test --watch viewer/test > /tmp/t.log 2>&1', 'tsc --watch -p tsconfig.json', 'watch -n 5 ls dist']) {
    assert.equal(waitScope(command), 'local', command);
  }
  const signals = newLaneSignals(T0);
  noteWaitDenied(signals, { command: 'vitest --watch', matched: '--watch' }, T0, STALL_LOCAL_JOB_MS);
  noteWaitDenied(signals, { command: 'vitest --watch', matched: '--watch' }, T0 + 2 * MINUTE, STALL_LOCAL_JOB_MS);
  const stall = waited(signals, T0 + 6 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.source, 'denied');
  assert.equal(stall?.scope, 'local', 'the local-job ladder: one nudge, then the park with a minted ref');
  // …while a `--watch` on somebody else's clock keeps its scope.
  assert.equal(waitScope('gh pr checks 12 --watch'), 'external');
  assert.equal(waitScope('kubectl get pods --watch'), 'external');
});

test('RCV-5/TRS-3: mintWatchRef reads every shape the guard refuses — a poll loop, a --watch runner, a sleep, a gh watch — and answers null for a wait with no honest landing', () => {
  const at = Date.parse('2026-09-14T12:00:00Z');
  const cases: [string, string | null][] = [
    // The poll-loop arm, unchanged (phase 5's `localWatchRef`).
    ['until [ -f /tmp/suite.done ]; do sleep 30; done', 'cmd:"test -f /tmp/suite.done"'],
    ['while ! test -f /tmp/x; do sleep 5; done', 'cmd:"test -f /tmp/x"'],
    // A `--watch` flag names a command whose one-shot form is its own probe;
    // the flag and the redirections go, the lead must be a runner or a probe.
    ['vitest --watch', 'cmd:"vitest"'],
    ['node --test --watch viewer/test > /tmp/t.log 2>&1', 'cmd:"node --test viewer/test"'],
    ['npm test -- --watch', 'cmd:"npm test"'],
    ['tsc --watch -p tsconfig.json', 'cmd:"tsc -p tsconfig.json"'],
    ['rm -rf dist --watch', null],
    // `watch -n N <cmd>`: the watched command is the probe.
    ['watch -n 5 ls dist', 'cmd:"ls dist"'],
    // A sleep is a clock, not a probe.
    ['sleep 600', 'date:2026-09-14T12:10:00Z'],
    ['sleep 10m', 'date:2026-09-14T12:10:00Z'],
    // A gh watch names its run or PR — a real ref when the repo is named, the
    // one-shot form when it is not.
    ['gh run watch 12345 -R acme/widgets', 'gh:acme/widgets#run/12345'],
    ['gh run watch 12345', 'cmd:"gh run view 12345 --exit-status"'],
    ['gh pr checks 77 --watch --repo acme/widgets', 'gh:acme/widgets#pr/77'],
    ['gh pr checks 77 --watch', 'cmd:"gh pr checks 77"'],
    // No honest landing: the card keeps the sentence, nothing is minted.
    ['tail -f build.log', null],
    ['docker compose logs -f api', null],
    ['while true; do sleep 30; done', null],
  ];
  for (const [command, expected] of cases) assert.equal(mintWatchRef(command, at), expected, command);
  // The one-shot leads are runners a person would run by hand, never a verb
  // of consequence: nothing here deploys, ships or deletes.
  for (const lead of WATCH_ONESHOT_LEADS) assert.ok(!/deploy|ship|rm|delete|publish/.test(lead), lead);
});

test('stallExternalWaitMs: 0 is off — no external-wait from an open call or a refusal', () => {
  const off = stallThresholds({ stallExternalWaitMs: 0 });
  const open = fold([[bash('a', 'until [ "$(gh run view 1 -q .status)" = completed ]; do sleep 45; done'), T0 + MINUTE]]);
  assert.notEqual(evaluateStall(open, off, T0 + 9 * MINUTE, { verifyEnv: EXTERNAL_WAIT })?.signal, 'external-wait');
  const refused = newLaneSignals(T0);
  noteWaitDenied(refused, DENIED_LOCAL, T0, STALL_LOCAL_JOB_MS);
  assert.notEqual(evaluateStall(refused, off, T0 + 9 * MINUTE, { verifyEnv: EXTERNAL_WAIT })?.signal, 'external-wait');
});
