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
  applyEvent, attemptSignals, evaluateStall, livenessOf, newLaneSignals, noteWaitDenied, oldestOpenTool, stallThresholds,
  type LaneSignals,
  mintWatchRef, WATCH_ONESHOT_LEADS, waitScope,
  clockLoop, knownEndOf, ownBackgroundWork,
} from '../server/runner/liveness.ts';
import { VERIFY_ENV_FALLBACK } from '../server/runner/verify-env.ts';
import {
  LOCAL_JOB_GRACE_MS, SILENCE_KINDS, STALL_DEFAULTS, STALL_LOCAL_JOB_MS, STALL_SIGNALS,
} from '../shared/attention-model.js';
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
  assert.deepEqual([...STALL_SIGNALS],
    ['stalemate', 'retrying', 'external-wait', 'silent', 'spinning', 'looping']);
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
    // Always present on a live lane (#28): it names WHICH silence clock runs
    // and what it is measured against. Its `sinceMs` is an instant, so the
    // figure a reader prints never goes stale between two snapshots.
    silence: { kind: 'no-output', sinceMs: T0 + MINUTE, thresholdMs: STALL_DEFAULTS.stallSilentMs },
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


/**
 * console-open-findings O5/O6/O11 — three small corrections, each pinned here.
 *
 * O6 is the one with teeth. The console's own wait procedure tells a session it
 * may hold ONE foreground call on its own job "bounded by the Bash timeout ...
 * at most once per ten minutes". The local-job nudge then fired on the first
 * tick after the `external-wait` signal opened, which is `stallExternalWaitMs`
 * — five minutes by default. So the console interrupted a session for doing
 * exactly what the console had just told it to do, halfway through the window it
 * had granted. The text costs one message rather than changing behaviour, which
 * is why it stayed a P3; it is still the console contradicting itself in
 * writing.
 */
test('O6: the local-job nudge waits out the window the wait procedure grants', async () => {
  const { localNudgeAfterMs } = await import('../server/runner/liveness.ts');
  const { STALL_DEFAULTS, STALL_LOCAL_JOB_MS, LOCAL_JOB_GRACE_MS } =
    await import('../shared/attention-model.js');

  // the procedure's own number, and the reason this constant exists
  assert.equal(LOCAL_JOB_GRACE_MS, 600_000, 'ten minutes — the bound the procedure quotes');

  // the default: the signal opens at 5 min, but the nudge waits for the full ten
  assert.equal(
    localNudgeAfterMs(STALL_DEFAULTS.stallExternalWaitMs),
    LOCAL_JOB_GRACE_MS,
    'a 5-minute signal must not nudge a session inside its own 10-minute allowance',
  );

  // an operator who widens the signal past ten minutes is honoured, not clamped back
  assert.equal(localNudgeAfterMs(20 * 60_000), 20 * 60_000, 'the larger of the two wins');

  // and the nudge always comes before the 45-minute park, or the rung is dead
  assert.ok(
    localNudgeAfterMs(STALL_DEFAULTS.stallExternalWaitMs) < STALL_LOCAL_JOB_MS,
    'rung 1 must still be reachable before rung 2 parks the lane',
  );
});

/* ------------------------------------------------------------------ *
 * The labelled silence (#28 §4)
 * ------------------------------------------------------------------ */

test('LS-1 — the silence kinds are one vocabulary, owned by attention-model', () => {
  assert.deepEqual([...SILENCE_KINDS], ['no-output', 'unproductive', 'in-tool', 'own-job', 'external-wait']);
});

test('LS-2 — nothing on the wire at all: `no-output`, on the productive clock, against stallSilentMs', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  assert.deepEqual(livenessOf(4, signals).silence, {
    kind: 'no-output', sinceMs: T0 + MINUTE, thresholdMs: STALL_DEFAULTS.stallSilentMs,
  });
});

test('LS-3 — heard from but producing nothing: `unproductive`, and the clock is NOT the last output', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  applyEvent(signals, { kind: 'retry', category: 'rate_limit' }, T0 + 4 * MINUTE);
  const silence = livenessOf(4, signals).silence!;
  assert.equal(silence.kind, 'unproductive');
  // The retry moved `lastOutputAt`; the silence still runs from the last PRODUCTIVE event.
  assert.equal(silence.sinceMs, T0 + MINUTE);
  assert.equal(livenessOf(4, signals).lastOutputAt, new Date(T0 + 4 * MINUTE).toISOString());
  assert.equal(silence.thresholdMs, STALL_DEFAULTS.stallSilentMs);
});

test('LS-4 — a tool call out: `in-tool`, measured exactly as `silent` measures it', () => {
  const signals = fold([[tool('a', 'Read'), T0 + 2 * MINUTE]]);
  const silence = livenessOf(4, signals).silence!;
  assert.equal(silence.kind, 'in-tool');
  assert.equal(silence.sinceMs, signals.lastProductiveAt);
  assert.equal(silence.thresholdMs, STALL_DEFAULTS.stallSilentMs);
  // The same clock the detector fires on: past the threshold, `silent` holds.
  const stall = evaluateStall(signals, stallThresholds(), silence.sinceMs + silence.thresholdMs);
  assert.equal(stall?.signal, 'silent');
});

test('LS-5 — a turn ended on its own background work: `own-job`, with the 45-minute bound and the 10-minute grace', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  signals.backgroundTasks = [{ id: 'bg1', taskType: 'local_agent', since: T0 + MINUTE }];
  const silence = livenessOf(4, signals).silence!;
  assert.equal(silence.kind, 'own-job');
  assert.equal(silence.sinceMs, T0 + MINUTE);
  // The owner's numbers — and NOT the issue's misquote: the grace is ten minutes.
  assert.equal(silence.thresholdMs, STALL_LOCAL_JOB_MS);
  assert.equal(silence.graceMs, LOCAL_JOB_GRACE_MS);
  assert.equal(LOCAL_JOB_GRACE_MS, 10 * MINUTE);
  // It is exactly the stretch `silent` stays quiet through.
  assert.equal(evaluateStall(signals, stallThresholds(), T0 + MINUTE + STALL_LOCAL_JOB_MS - 1), null);
});

test('LS-6 — a wait on somebody else\'s clock is `external-wait`; on its own job it is `own-job`', () => {
  const signals = fold([[bash('w', 'gh run watch 123'), T0 + MINUTE]]);
  signals.stall = {
    signal: 'external-wait', since: new Date(T0 + MINUTE).toISOString(), detail: 'x', scope: 'external', source: 'open',
  };
  assert.deepEqual(livenessOf(4, signals).silence, {
    kind: 'external-wait', sinceMs: T0 + MINUTE, thresholdMs: STALL_DEFAULTS.stallExternalWaitMs,
  });
  signals.stall = { ...signals.stall, scope: 'local' };
  assert.deepEqual(livenessOf(4, signals).silence, {
    kind: 'own-job', sinceMs: T0 + MINUTE, thresholdMs: STALL_LOCAL_JOB_MS, graceMs: LOCAL_JOB_GRACE_MS,
  });
});

test('LS-7 — the thresholds are the ones the detector uses, prefs included; a verifying or frozen lane has none', () => {
  const signals = fold([[step(1), T0 + MINUTE]]);
  const widened = stallThresholds({ stallSilentMs: 20 * MINUTE, stallExternalWaitMs: 15 * MINUTE });
  assert.equal(livenessOf(4, signals, widened).silence?.thresholdMs, 20 * MINUTE);
  signals.backgroundTasks = [{ id: 'bg1', taskType: 'local_agent', since: T0 + MINUTE }];
  // The grace is the larger of the wait signal's own threshold and the ten minutes.
  assert.equal(livenessOf(4, signals, widened).silence?.graceMs, 15 * MINUTE);
  signals.verifying = true;
  assert.equal(livenessOf(4, signals).silence, undefined, 'the console arranged this silence');
  signals.verifying = false;
  signals.frozen = true;
  assert.equal(livenessOf(4, signals).silence, undefined);
});

/* ------------------------------------------------------------------ *
 * The in-turn-wait guard's two questions, over the AUD-34 corpus
 * (control-tower phase 47, #52)
 * ------------------------------------------------------------------ */

/**
 * 12 of the 15 refusals in the autopilot week were the session's own local
 * work (AUD-34). The guard refuses only when BOTH answers say so — the command
 * waits (`inTurnWait`) and the wait is on somebody else's clock (`waitScope`).
 * `verify-env.test.ts` holds bash and JS to the first answer; this holds the
 * pair to the corpus's verdicts, with the pids each session had announced.
 */
test('AUD-34: the guard refuses 3 of the 15 — the counters, the declarations and the local waits go through', async () => {
  const { inTurnWait } = await import('../server/runner/liveness.ts');
  const { readFileSync } = await import('node:fs');
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/wait-corpus/aud-34.json', import.meta.url), 'utf8')) as {
    items: { id: string; wait: boolean; verdict: 'local' | 'external'; ownPids?: number[]; command: string }[];
  };
  let local = 0;
  for (const item of corpus.items) {
    const matched = inTurnWait(item.command, EXTERNAL_WAIT);
    assert.equal(matched !== null, item.wait, `#${item.id}: inTurnWait read ${matched ?? 'no wait'}`);
    const refused = matched !== null && waitScope(item.command, { ownPids: item.ownPids }) === 'external';
    assert.equal(refused, item.verdict === 'external', `#${item.id}: the guard ${refused ? 'refused' : 'allowed'} it`);
    if (!refused) local += 1;
  }
  assert.equal(local, 12, '12 of 15 local, as AUD-34 counted them');
});

test('waitScope: a loopback URL, a local git probe and an announced pid are the session\'s own clock', () => {
  assert.equal(waitScope('until curl -sf http://localhost:3000/health; do sleep 2; done'), 'local');
  assert.equal(waitScope('until curl -sf http://127.0.0.1:8197/openapi.json; do sleep 3; done'), 'local');
  assert.equal(waitScope('until curl -sf http://[::1]:8080/; do sleep 3; done'), 'local');
  assert.equal(waitScope('until curl -sf https://api.example.invalid/health; do sleep 3; done'), 'external');
  // A host that merely STARTS with a loopback spelling is somebody else's.
  assert.equal(waitScope('until curl -sf http://localhost.example.invalid/; do sleep 3; done'), 'external');
  assert.equal(waitScope('until git log -1 --format=%s | grep -q handoff; do sleep 5; done'), 'local');
  assert.equal(waitScope('until git diff --quiet; do sleep 5; done'), 'local');
  assert.equal(waitScope('until git ls-remote origin pe/x | grep -q .; do sleep 5; done'), 'external');
  // A pid is the session's own only when it said so: `$!` in a variable, or a
  // literal it announced earlier. Any other pid is a process it FOUND.
  assert.equal(waitScope('until ! kill -0 "$pid"; do sleep 5; done'), 'local');
  assert.equal(waitScope('until ! kill -0 4242; do sleep 5; done', { ownPids: [4242] }), 'local');
  assert.equal(waitScope('until ! kill -0 4242; do sleep 5; done'), 'external');
  assert.equal(waitScope('until ! ps -p 4242 && ! ps -p 77; do sleep 5; done', { ownPids: [4242] }), 'external',
    'one pid it did not start is a wait on somebody else');
});

test('waitScope (control-tower phase 111, #179): a loop on nothing but the clock is the session timing itself', () => {
  // Its condition reads the time and nothing else, and its body only paces.
  assert.equal(clockLoop('until [ "$(date +%s)" -ge "$target" ]; do sleep 5; done'), true);
  assert.equal(clockLoop('while (( SECONDS < 600 )); do sleep 10; done'), true);
  assert.equal(clockLoop('until [[ $EPOCHSECONDS -ge $end ]]; do echo waiting; sleep 1; done'), true);
  // Another substitution in the condition reads something besides the clock,
  // and a body that does work is a poll, whatever bounds it.
  assert.equal(clockLoop('until [ "$(date +%s)" -ge "$(cat /tmp/deadline)" ]; do sleep 5; done'), false);
  assert.equal(clockLoop('until [ "$(date +%s)" -ge "$t" ]; do gh run view 1 --json status; sleep 30; done'), false);
  assert.equal(clockLoop('until curl -sf https://ci.example.invalid/; do sleep 5; done'), false);
  // What follows `done` is what it does once the time comes, not what it waits on.
  assert.equal(waitScope('until [ "$(date +%s)" -ge "$t" ]; do sleep 5; done; gh run view 1'), 'local');
});

test('knownEndOf (#179): a clock loop is bounded by the instant its target names, and by nothing it would have to guess', () => {
  const target = '2026-10-01T07:54:40Z';
  const loop = `t=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' '${target}' +%s); until [ "$(date +%s)" -ge "$t" ]; do sleep 5; done`;
  const before = Date.parse(target) - 30 * 60_000;
  assert.equal(knownEndOf(loop, before), Date.parse(target));
  assert.equal(knownEndOf(loop, Date.parse(target) + 1000), null, 'a target already passed bounds nothing');
  assert.equal(knownEndOf('until [ "$(date +%s)" -ge "$t" ]; do sleep 5; done', before), null, 'no instant named, none guessed');
  assert.equal(knownEndOf(`until gh run view 1 | grep -q ${target}; do sleep 5; done`, before), null,
    'a timestamp inside a poll is not when the poll ends');
});

test('ownBackgroundWork (#206): the session\'s own background tasks, never a subagent\'s', () => {
  const tasks = [
    { id: 'b1', taskType: 'local_bash', description: 'release preflight', since: 1 },
    { id: 'a1', taskType: 'local_agent', ownedBySubagent: true, since: 2 },
    { id: 'm1', taskType: 'local_bash', tool: 'Monitor', since: 3 },
  ];
  assert.deepEqual(ownBackgroundWork({ backgroundTasks: tasks }).map((task) => task.id), ['b1', 'm1']);
  assert.deepEqual(ownBackgroundWork({ backgroundTasks: [] }), []);
});

test('the pids a session announces with $! are remembered on its lane, and nothing else is', () => {
  const signals = fold([
    [bash('bg', 'npm test > /tmp/t.log 2>&1 & echo $!'), T0 + MINUTE],
    [{ kind: 'tool-result', id: 'bg', ok: true, detail: '51616' }, T0 + MINUTE + 1],
    [bash('ls', 'wc -l src/*.ts'), T0 + 2 * MINUTE],
    [{ kind: 'tool-result', id: 'ls', ok: true, detail: '4242 total' }, T0 + 2 * MINUTE + 1],
  ]);
  assert.deepEqual(signals.ownPids, [51616]);
});

/* ------------------------------------------------------------------ *
 * Each attempt's liveness is its own (control-tower phase 80, #99)
 * ------------------------------------------------------------------ */

/** A dead session's accumulator: everything a working session leaves behind. */
function worn(): LaneSignals {
  const signals = fold([
    [{ kind: 'retry', category: 'overloaded' } as StreamEvent, T0 + MINUTE],
    [tool('t1'), T0 + 2 * MINUTE],
    [step(1), T0 + 3 * MINUTE],
  ]);
  signals.idleAttempts = 2;
  signals.attempt = 4;
  signals.procStartedAt = T0;
  signals.commitsSinceStart = 3;
  signals.treeDirty = true;
  signals.ownPids = [51616];
  signals.backgroundTasks = [{ id: 'bg-1', since: T0 }];
  signals.tokens = {
    calls: 9, firstContext: 40_000, lastContext: 180_000, peakContext: 180_000,
    input: 90, cacheWrite: 0, cacheRead: 900_000, output: 4_000, rebuilds: 0,
  } as LaneSignals['tokens'];
  signals.pollNudged = true;
  signals.contextWindow = 1_000_000;
  signals.stall = { signal: 'silent', since: new Date(T0 + 3 * MINUTE).toISOString(), detail: 'quiet' };
  return signals;
}

test('AL: attemptSignals starts the next attempt over — clocks, retries, tools, waits and tokens — stamped with its number', () => {
  const booted = T0 + 102 * MINUTE;
  const next = attemptSignals(worn(), booted, 5);
  assert.equal(next.attempt, 5);
  assert.equal(next.startedAt, booted);
  assert.equal(next.lastOutputAt, booted, 'the silent clock starts at this attempt\'s boot');
  assert.equal(next.lastProductiveAt, booted);
  assert.equal(next.retriesSinceProgress, 0);
  assert.equal(next.retryBurstSince, undefined);
  assert.equal(next.lastToolUseAt, undefined);
  assert.equal(next.turnsSinceLastTool, 0);
  assert.deepEqual(next.openTools, []);
  assert.deepEqual(next.recentCalls, []);
  assert.equal(next.ownPids, undefined, 'a dead process\'s pids are nobody\'s job now');
  assert.equal(next.backgroundTasks, undefined);
  assert.equal(next.tokens, undefined, 'the context is the live session\'s, from its first call');
  assert.equal(next.procStartedAt, undefined, 'stamped when the new process is seen, not inherited');
  assert.equal(next.commitsSinceStart, 0, 'this attempt has committed nothing yet');
  assert.equal(next.stall, null, 'the dead session\'s episode is not the live one\'s');
});

test('AL: attemptSignals keeps what belongs to the phase — the stalemate count and episode, the tree, the spent notice, the window', () => {
  const previous = worn();
  const next = attemptSignals(previous, T0 + 102 * MINUTE, 5);
  assert.equal(next.idleAttempts, 2);
  assert.equal(next.treeDirty, true, 'the tree did not change when the process did');
  assert.equal(next.pollNudged, true, 'one poll-loop notice per lane');
  assert.equal(next.contextWindow, 1_000_000);
  previous.stall = { signal: 'stalemate', since: new Date(T0).toISOString(), detail: '3 attempts in a row' };
  assert.equal(attemptSignals(previous, T0 + 102 * MINUTE, 5).stall?.signal, 'stalemate',
    'a stalemate is about the phase, and ends when an attempt commits');
});

test('AL: the wire view names the attempt and the process it describes — and says nothing until it knows', () => {
  const signals = newLaneSignals(T0, { attempt: 3 });
  signals.procStartedAt = Date.parse('2026-09-24T11:32:23.000Z');
  const view = livenessOf(26, signals);
  assert.equal(view.attempt, 3);
  assert.equal(view.procStartedAt, '2026-09-24T11:32:23.000Z');
  const bare = livenessOf(26, newLaneSignals(T0));
  assert.equal('attempt' in bare, false);
  assert.equal('procStartedAt' in bare, false);
});

test('AL: 102 minutes after the last attempt spoke is silence for that attempt, and not for the one just booted', () => {
  const thresholds = stallThresholds();
  const previous = fold([[step(0), T0]]);
  assert.equal(evaluateStall(previous, thresholds, T0 + 102 * MINUTE)?.signal, 'silent', 'the inherited clock says hung');
  const next = attemptSignals(previous, T0 + 102 * MINUTE, 2);
  assert.equal(evaluateStall(next, thresholds, T0 + 103 * MINUTE), null, 'the live process is one minute old');
});

test('the wire view names the last call a lane finished, beside the one it has open (control-tower phase 95, #138)', () => {
  const signals = fold([[tool('a'), T0], [result('a'), T0 + MINUTE], [tool('b', 'Read'), T0 + 2 * MINUTE]]);
  const view = livenessOf(4, signals);
  assert.equal(view.openTool?.name, 'Read');
  assert.deepEqual(view.lastCall, { tool: 'Bash', summary: 'Bash', since: new Date(T0).toISOString(), ok: true });
  assert.equal(livenessOf(4, fold([[step(1), T0]])).lastCall, undefined, 'no call finished, nothing named');
});

/* ------------------------------------------------------------------ *
 * The stall reading (control-tower phase 44): silent + a link + waiting words
 * ------------------------------------------------------------------ */

test('a silent lane whose last output is a link and waiting words reads as a suspected human step — only on silence, only the last output', () => {
  const thresholds = stallThresholds();
  const login = 'Opening browser to https://cli-auth.heroku.com/auth/cli/browser/5f1\nheroku: Waiting for login...';
  const signals = fold([
    [{ kind: 'tool', id: 'h', name: 'Bash', summary: 'npx heroku-cli-plugin auth' }, T0 + 1],
    [{ kind: 'tool-result', id: 'h', ok: false, detail: login }, T0 + 2],
  ]);
  assert.deepEqual(signals.suspectedStep, {
    kind: 'browser-login', url: 'https://cli-auth.heroku.com/auth/cli/browser/5f1', words: 'Waiting for login',
    where: 'host', at: T0 + 2,
  });
  // The signal is `silent` either way — the reading only says WHAT it is quiet on.
  const stall = evaluateStall(signals, thresholds, T0 + 2 + thresholds.stallSilentMs);
  assert.equal(stall?.signal, 'silent');
  assert.equal(stall?.suspectedStep?.url, 'https://cli-auth.heroku.com/auth/cli/browser/5f1');
  // A retry is not output: the reading stands through a 429 loop.
  applyEvent(signals, { kind: 'retry', attempt: 1, category: 'rate_limit' } as StreamEvent, T0 + 3);
  assert.ok(signals.suspectedStep);
  // A call going out is not output either; its answer is, and it replaces the reading.
  applyEvent(signals, { kind: 'tool', id: 'g', name: 'Bash', summary: 'git status' }, T0 + 4);
  assert.ok(signals.suspectedStep);
  applyEvent(signals, { kind: 'tool-result', id: 'g', ok: true, detail: 'nothing to commit, working tree clean' }, T0 + 5);
  assert.equal(signals.suspectedStep, undefined);
  // A link without waiting words is every test log.
  applyEvent(signals, { kind: 'text', text: 'The suite passed; the report is at https://ci.example.com/run/9.' }, T0 + 6);
  assert.equal(signals.suspectedStep, undefined);
  assert.equal(evaluateStall(signals, thresholds, T0 + 6 + thresholds.stallSilentMs)?.suspectedStep, undefined);
});
