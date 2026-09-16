/**
 * Phase 2 — the clock is evidence.
 *
 * One test per exit criterion, plus the regressions each round of review left
 * behind. The four criteria:
 *
 *   1. every declared ref scheme is polled on a clock the console owns, and a
 *      `cmd:` ref runs only through `verify.ts`'s policy (or not at all);
 *   2. a landing resumes the phase's own session with the declaration intact,
 *      bounded, and the instruction names the CONCLUSION;
 *   3. a run with a due ref is never skipped as "nothing has changed";
 *   4. an uncategorised retry is classified from its detail, and a lane that
 *      only ever retries is ended by policy rather than after eleven hours.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWatchRef, pollableRefs, nextDueFor, probeWatchRef,
  WATCH_POLL_MS, WATCH_FLOOR_MS, WATCH_REDELIVER_MS, MAX_CMD_RUNS_PER_PHASE,
  type WatchRefTarget, type WatchState,
} from '../server/watch-refs.ts';
import { WatchScheduler, MAX_WATCH_REFS, MAX_LANDING_DELIVERIES } from '../server/watch-scheduler.ts';
import {
  chargeDeclaration, clearWatchBookkeeping, consumeDeclaration, journalFile, loadRun, newRun, phaseRecord,
  prepareReboard, resetForRetry, saveRun, soonestWaitingClock, waitClockOf,
} from '../server/runner/state.ts';
import { waitClockVerdict } from '../server/converge.ts';
import {
  DECLARATION_COOLDOWN_MS, DECLARATIONS_MAX_PER_PHASE, DECLARED_CLOCK_MAX_MS, WAIT_SETTLE_GRACE_MS, declarationCooldownFor, declaredClock,
} from '../server/runner/wait-budget.ts';
import { evidenceFingerprint } from '../server/converge.ts';
import { inferRetryCategory } from '../server/runner/spawn.ts';
import { landingDirective } from '../server/service-recovery.ts';
import { runSingleCommand } from '../server/runner/verify.ts';
import type { PhaseRecord, RunState } from '../server/runner/state.ts';
import {
  closeWaitEntry, evaluateWait, openWaitEntry, parkedMsOf, waitBudgetFrom,
  DEFAULT_WAIT_BUDGET_MS, WAIT_MAX_PER_PHASE, WATCHDOG_PARKS_MAX_PER_PHASE, type WaitBudget,
} from '../server/runner/wait-budget.ts';
import { waitResumePrompt } from '../server/runner/runner-core.ts';
import { dateOfRef, unpollableRefs, watchRefProblem } from '../server/watch-refs.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from '../server/config.ts';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

const NOW = Date.parse('2026-08-30T12:00:00Z');

class FakeClock {
  time = NOW;
  now = (): number => this.time;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timers = this.timers.filter((t) => t.id !== handle); };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
  pendingCount(): number { return this.timers.length; }
}

/** A run state with one waiting phase carrying `watch` refs. */
function waitingRun(refs: string[], over: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1', slug: 'alpha', status: 'parked', model: 'claude-opus-5',
    startedAt: new Date(NOW).toISOString(),
    phases: {
      1: {
        phase: 1, status: 'waiting', attempts: 1,
        parkedUntil: new Date(NOW + 3_600_000).toISOString(),
        declared: { status: 'waiting-external', reason: 'the image build', watch: refs, at: new Date(NOW).toISOString() },
      },
    },
    ...over,
  } as unknown as RunState;
}

/* ------------------------------------------------------------------ *
 * Criterion 1 — every scheme, on the console's own clock
 * ------------------------------------------------------------------ */

test('criterion 1: every declared scheme parses, and only these', () => {
  assert.deepEqual(parseWatchRef('gh:acme/app#run/33123610977'), {
    kind: 'gh-run', repo: 'acme/app', id: '33123610977', ref: 'gh:acme/app#run/33123610977',
  });
  assert.deepEqual(parseWatchRef('gh:acme/web-admin#pr/77'), {
    kind: 'gh-pr', repo: 'acme/web-admin', number: '77', ref: 'gh:acme/web-admin#pr/77',
  });
  assert.deepEqual(parseWatchRef('date:2026-09-01T09:00:00Z'), {
    kind: 'date', at: Date.parse('2026-09-01T09:00:00Z'), ref: 'date:2026-09-01T09:00:00Z',
  });
  // Two spellings of one scheme — `--until` writes an instant and a session
  // saying "not before 09:00" writes the same thing.
  assert.equal(parseWatchRef('until:2026-09-01T09:00:00Z')?.kind, 'date');
  assert.deepEqual(parseWatchRef('lock:demo/3'), { kind: 'lock', slug: 'demo', phase: 3, ref: 'lock:demo/3' });
  assert.deepEqual(parseWatchRef('cmd:"npm test"'), { kind: 'cmd', command: 'npm test', ref: 'cmd:"npm test"' });
  assert.equal(parseWatchRef('cmd:npm test')?.kind, 'cmd', 'quotes are punctuation, not required');

  // Still unpollable, and still for a reason.
  assert.equal(parseWatchRef('url:https://ci.example.com/build/9'), null, 'another subsystem’s');
  assert.equal(parseWatchRef('date:run'), null, 'Date.parse accepts a great deal that is not an instant');
  assert.equal(parseWatchRef('date:2026'), null, 'a year is not a moment');
  // Shape is not sense, and V8 will not tell you: an out-of-range ISO day falls
  // through to the legacy parser and ROLLS OVER, so this used to become October
  // 1st and the phase waited a day longer than the session asked, silently.
  assert.equal(parseWatchRef('date:2026-09-31T10:00:00Z'), null, 'September has thirty days');
  assert.equal(parseWatchRef('date:2026-02-30T10:00Z'), null, 'and February never has thirty');
  assert.equal(parseWatchRef('date:2026-02-29T10:00:00Z'), null, '2026 is not a leap year');
  assert.ok(parseWatchRef('date:2028-02-29T10:00:00Z'), 'but 2028 is — the check is the calendar, not a table');
  // …and the check must read the ref in ITS OWN frame. Comparing UTC components
  // against a wall clock three hours ahead refused these three outright, with
  // no journal and no errand — the silence the check was added to end (QA F5).
  for (const ref of [
    'date:2026-09-15T01:00:00+03:00',
    'date:2026-09-15T23:30:00-05:00',
    'date:2026-09-15T00:30:00+05:30',
  ]) assert.ok(parseWatchRef(ref), `${ref} is a real instant`);
  assert.equal(
    (parseWatchRef('date:2026-09-15T01:00:00+03:00') as { at: number }).at,
    Date.parse('2026-09-14T22:00:00Z'),
    'and the offset is honoured, not merely tolerated',
  );
  // A bare HH:MM with no zone is LOCAL time, deliberately: it is what a person
  // means by "not before 09:00", and it is what `Date` does.
  assert.equal(
    parseWatchRef('until:2026-09-01 09:00')!.kind === 'date'
      && (parseWatchRef('until:2026-09-01 09:00') as { at: number }).at,
    new Date(2026, 8, 1, 9, 0).getTime(),
  );
  assert.equal(parseWatchRef('lock:demo/0'), null, 'phases are 1-based');
  assert.equal(parseWatchRef('lock:../../etc/1'), null, 'a slug is not a path');
  assert.equal(parseWatchRef('cmd:'), null, 'an empty command is not a ref');
  assert.equal(parseWatchRef('gh:acme/app#job/12'), null, 'only run and pr shapes');
});

test('criterion 1: a date ref is due exactly once; every other scheme is a cadence', () => {
  const date = parseWatchRef('date:2026-09-01T09:00:00Z')!;
  // Pending: due at its instant, not one cadence from now.
  assert.equal(nextDueFor(date, 'pending', NOW), Date.parse('2026-09-01T09:00:00Z'));
  // `refused` has no next: nothing about the console's own POLICY changes
  // between two ticks. `landed` does — not because the world might answer
  // differently (it will not) but because the healer may not have managed to
  // act on the answer yet. See the re-delivery tests below.
  assert.equal(nextDueFor(parseWatchRef('cmd:"x"')!, 'refused', NOW), null);
  assert.equal(nextDueFor(date, 'landed', NOW), NOW + WATCH_REDELIVER_MS);
  const run = parseWatchRef('gh:acme/app#run/1')!;
  assert.equal(nextDueFor(run, 'pending', NOW), NOW + WATCH_POLL_MS['gh-run']);
  assert.equal(nextDueFor(run, 'unknown', NOW), NOW + WATCH_POLL_MS['gh-run'],
    'unknown is not landed — it is re-asked');
});

test('criterion 1: date, lock and cmd probes answer without a network, and default to unknown', async () => {
  const date = parseWatchRef('date:2026-08-30T11:00:00Z')!;
  assert.equal((await probeWatchRef(date, { now: NOW })).state, 'landed', 'the instant has passed');
  assert.equal((await probeWatchRef(parseWatchRef('date:2026-09-30T00:00:00Z')!, { now: NOW })).state, 'pending');

  const lock = parseWatchRef('lock:demo/3')!;
  // No oracle wired is `unknown`, never an assumption in either direction:
  // "I could not check" and "it has not landed" both refuse to resume, but
  // only the first is honest about why.
  assert.equal((await probeWatchRef(lock)).state, 'unknown');
  assert.equal((await probeWatchRef(lock, { lockFree: () => true })).state, 'landed');
  assert.equal((await probeWatchRef(lock, { lockFree: () => false })).state, 'pending');
  assert.equal((await probeWatchRef(lock, { lockFree: () => null })).state, 'unknown');
  assert.equal((await probeWatchRef(lock, { lockFree: () => { throw new Error('boom'); } })).state, 'unknown',
    'a throwing oracle must not take the scheduler with it');

  const cmd = parseWatchRef('cmd:"gh run list"')!;
  assert.equal((await probeWatchRef(cmd)).state, 'unknown', 'no runner wired: the console did not ask');
  assert.equal((await probeWatchRef(cmd, { runCommand: async () => ({ ok: true }) })).state, 'landed');
  assert.equal((await probeWatchRef(cmd, { runCommand: async () => ({ ok: false }) })).state, 'pending');
  const refused = await probeWatchRef(cmd, { runCommand: async () => ({ ok: false, refused: 'writes are refused' }) });
  assert.equal(refused.state, 'refused', 'a policy verdict is terminal, not a pending answer');
  assert.match(refused.detail!, /writes are refused/);
});

test('criterion 1: the scheduler polls on its own timer, journals transitions once, and writes watchState', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9', 'date:2026-09-01T09:00:00Z']);
  const journal: { kind: string; data: Record<string, unknown> }[] = [];
  let ghState: WatchState['state'] = 'pending';
  const asked: string[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    journal: (_s, _st, kind, data) => { journal.push({ kind, data }); },
    probe: async (t: WatchRefTarget) => {
      asked.push(t.ref);
      return t.kind === 'date'
        ? { ref: t.ref, state: 'pending', detail: 'not before 2026-09-01T09:00:00Z' }
        : { ref: t.ref, state: ghState, ...(ghState === 'landed' ? { detail: 'completed: success' } : {}) };
    },
  });
  scheduler.open();
  await scheduler.tick();

  const rows = state.phases[1].watchState!.refs;
  assert.equal(rows.length, 2, 'one row per declared ref, not one field for whichever was last');
  assert.deepEqual(rows.map((r) => r.scheme).sort(), ['date', 'gh-run']);
  assert.equal(rows.find((r) => r.scheme === 'gh-run')!.nextDueAt, clock.time + WATCH_POLL_MS['gh-run']);
  assert.equal(rows.find((r) => r.scheme === 'date')!.nextDueAt, Date.parse('2026-09-01T09:00:00Z'),
    'a date ref is scheduled at its instant, not on a cadence');
  assert.equal(journal.filter((j) => j.kind === 'phase.watch-checked').length, 2, 'two transitions, two lines');

  // The second pass is inside the gh cadence and before the date instant:
  // nothing is due, so nothing is asked and nothing is journalled again.
  journal.length = 0; asked.length = 0;
  await scheduler.tick();
  assert.deepEqual(asked, [], 'a pending ref inside its cadence costs nothing');
  assert.deepEqual(journal, [], 'still-pending is not news');

  // Past the cadence with the same answer: asked again, still not journalled.
  clock.time += WATCH_POLL_MS['gh-run'];
  await scheduler.tick();
  assert.deepEqual(asked, ['gh:acme/app#run/9'], 'the gh ref alone — the date ref is not due until September');
  assert.deepEqual(journal, [], 'pending -> pending is not a transition');

  // And the landing IS news, once.
  ghState = 'landed';
  clock.time += WATCH_POLL_MS['gh-run'];
  await scheduler.tick();
  assert.equal(journal.length, 1);
  assert.equal(journal[0].data.state, 'landed');
  assert.equal(state.phases[1].watchChecked!.state, 'landed', 'the legacy single-ref field is kept in step');
  // A landed row keeps a due time — for RE-DELIVERY to the healer, never for a
  // second probe. See "a landing is re-offered until the healer acts".
  assert.equal(rows.find((r) => r.scheme === 'gh-run')!.nextDueAt, clock.time + WATCH_REDELIVER_MS);
  scheduler.close();
});

test('criterion 1: a refusal is journalled once, EVER — across declarations, not just across ticks', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['cmd:"rm -rf /"']);
  const journal: string[] = [];
  let asks = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    journal: (_s, _st, kind) => { journal.push(kind); },
    probe: async (t) => { asks += 1; return { ref: t.ref, state: 'refused', detail: 'a destructive verb' }; },
  });
  scheduler.open();
  await scheduler.tick();
  clock.time += 10 * WATCH_POLL_MS.cmd;
  await scheduler.tick();
  assert.deepEqual(journal, ['phase.watch-refused'], 'said once, not argued with every pass');
  assert.equal(asks, 1, 'a refused ref is dropped from the rotation, not re-asked on a cadence');

  // A refused `cmd:` ref is RETIRED on the record (SLF-8, zero-touch-console
  // phase 6): a new declaration clears `watchState` (F1) but not `watchRetired`,
  // so the same command is not asked again — the world's answer to it was
  // final. (Until phase 6 the re-declared ref WAS asked again, and this test
  // held that; the retirement is the plan's own ruling.)
  assert.deepEqual(state.phases[1].watchRetired, ['cmd:"rm -rf /"'], 'retired on the record');
  clearWatchBookkeeping(state.phases[1]);
  clock.time += WATCH_POLL_MS.cmd;
  await scheduler.tick();
  assert.equal(asks, 1, 'the re-declared ref is NOT asked again — it is retired');
  assert.deepEqual(state.phases[1].watchRetired, ['cmd:"rm -rf /"'], 'clearWatchBookkeeping keeps the retirement');

  // Only an operator's Retry un-retires. The policy then reaches the same
  // verdict it will always reach — and that line must still not be written
  // twice: the in-process dedupe (QA F8) is what this half holds.
  resetForRetry(state.phases[1], { by: 'operator', journal: () => {} });
  state.phases[1].status = 'waiting';
  state.phases[1].declared = { status: 'waiting-external', reason: 'again', watch: ['cmd:"rm -rf /"'], at: new Date(clock.time).toISOString() };
  clock.time += WATCH_POLL_MS.cmd;
  await scheduler.tick();
  assert.equal(asks, 2, 'un-retired by the operator, the ref is asked again');
  assert.deepEqual(journal, ['phase.watch-refused'], 'and the refusal is still said only once');
  scheduler.close();
});

test('criterion 1: a cmd: ref is bounded — it runs a command, it does not just read one', async () => {
  // The other four schemes read something; this one RUNS something, every five
  // minutes, for as long as the phase is parked — which is days (QA F11).
  const clock = new FakeClock();
  const state = waitingRun(['cmd:"gh run list"']);
  let runs = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { runs += 1; return { ref: t.ref, state: 'pending', detail: 'exit 1' }; },
  });
  scheduler.open();
  for (let i = 0; i < MAX_CMD_RUNS_PER_PHASE + 4; i += 1) {
    await scheduler.tick();
    clock.time += WATCH_POLL_MS.cmd;
  }
  assert.equal(runs, MAX_CMD_RUNS_PER_PHASE, 'the command stops being run');
  const row = state.phases[1].watchState!.refs[0];
  assert.equal(row.state, 'refused', 'and the operator sees a state, not a silence');
  assert.match(row.detail!, /will not run it again/);
  assert.equal(row.runs, MAX_CMD_RUNS_PER_PHASE, 'the count is on the row, not in memory');
  // …and the exhausted ref is RETIRED, not merely re-labelled (SLF-8): the row
  // stays for the operator to read, the ref is never a probe target again.
  assert.deepEqual(state.phases[1].watchRetired, ['cmd:"gh run list"']);
  scheduler.close();
});

test('criterion 1: a cmd: probe that ran NOTHING does not spend the budget', async () => {
  // QA round 2, G4. With `watchCmdRefs` off, `probeWatchRef` answers `unknown`
  // having executed nothing — and counting that spent the budget on twelve
  // non-events, after which the ref read `refused` for ever. That is exactly
  // what this phase's own F12 ruling exists to prevent: turning the pref back
  // on would never resume watching.
  const clock = new FakeClock();
  const state = waitingRun(['cmd:"gh run list"']);
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'unknown', detail: 'cmd refs are not being run' }),
  });
  scheduler.open();
  for (let i = 0; i < MAX_CMD_RUNS_PER_PHASE + 6; i += 1) {
    await scheduler.tick();
    clock.time += WATCH_POLL_MS.cmd;
  }
  const row = state.phases[1].watchState!.refs[0];
  assert.equal(row.runs, undefined, 'nothing ran, so nothing is charged');
  assert.equal(row.state, 'unknown', 'and the ref is still watchable when the pref comes back on');
  scheduler.close();
});

test('criterion 1: rows are pruned to what is declared NOW — the cap cannot wedge a real ref out', async () => {
  // QA F4. Rows accumulate across declarations and the cap is a hard 8, so with
  // eight stale rows a ninth ref could never be written — and an unwritable row
  // meant `!before` was true for ever, so every pass journalled it, rewrote
  // `watchChecked` and re-saved the run. For a `cmd:` ref that is the command
  // running every 60 s instead of every 5 min.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/99']);
  state.phases[1].watchState = {
    at: new Date(NOW).toISOString(),
    refs: Array.from({ length: 8 }, (_, i) => ({
      ref: `gh:old/repo#run/${i}`, scheme: 'gh-run' as const, state: 'landed' as const,
      checkedAt: new Date(NOW).toISOString(),
    })),
  };
  const journal: string[] = [];
  let saves = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    journal: (_s, _st, kind) => { journal.push(kind); },
    save: () => { saves += 1; },
    probe: async (t) => ({ ref: t.ref, state: 'pending' }),
  });
  scheduler.open();
  await scheduler.tick();
  const refs = state.phases[1].watchState!.refs;
  assert.deepEqual(refs.map((r) => r.ref), ['gh:acme/app#run/99'],
    'the rows nobody is watching any more are gone, and the real one is stored');
  assert.equal(journal.length, 1);
  assert.equal(saves, 1);

  // …and it does not churn on the next passes.
  for (let i = 0; i < 3; i += 1) { clock.time += WATCH_POLL_MS['gh-run']; await scheduler.tick(); }
  assert.equal(journal.length, 1, 'pending -> pending is still not a transition');
  assert.equal(saves, 1, 'and an unchanged pass does not rewrite the run file');
  scheduler.close();
});

test('criterion 1: one probe in flight per ref, however many phases declared it', async () => {
  const clock = new FakeClock();
  const a = waitingRun(['gh:acme/app#run/9']);
  const b = waitingRun(['gh:acme/app#run/9'], { id: 'run-2', slug: 'beta' });
  let concurrent = 0; let peak = 0; let asks = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state: a }, { slug: 'beta', state: b }],
    probe: async (t) => {
      asks += 1; concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((r) => setImmediate(r));
      concurrent -= 1;
      return { ref: t.ref, state: 'pending' };
    },
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(peak, 1, 'never two probes of one ref at once');
  assert.equal(asks, 1, 'and the second run reads the first run’s answer');
  assert.ok(a.phases[1].watchState && b.phases[1].watchState, 'both records still learn the verdict');
  scheduler.close();
});

test('criterion 1: the scheduler’s own timer floors at a minute and never runs while frozen', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['date:2026-08-30T12:00:30Z']);  // due in 30 s
  let holds: { at: string } | null = null;
  let passes = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    fleetHold: () => holds,
    probe: async (t) => { passes += 1; return { ref: t.ref, state: 'pending' }; },
  });
  scheduler.open();
  assert.equal(clock.pendingCount(), 1, 'opening arms exactly one timer');
  await clock.advance(WATCH_FLOOR_MS - 1);
  assert.equal(passes, 0, 'a ref due in 30 s does not buy a wake in 30 s — the floor is one a minute');
  await clock.advance(1);
  assert.equal(passes, 1);

  // Frozen: the schedule is kept and the pass does nothing, so a thaw needs no
  // reconstruction — the same contract the convergence loop holds.
  holds = { at: new Date().toISOString() };
  const before = passes;
  await clock.advance(WATCH_FLOOR_MS * 3);
  assert.equal(passes, before, 'a frozen console keeps its clock and does not act on it');
  assert.ok(clock.pendingCount() > 0, 'and it is still armed for the thaw');
  scheduler.close();
  assert.equal(clock.pendingCount(), 0, 'close drops every timer');
});

test('criterion 1: a needs-human PARK is watched — the person is asked AND the machine keeps watch', async () => {
  // The status a `needs-human` declaration leaves behind is `parked`, not
  // `waiting`. A watchable-status list written as `['waiting']` would have made
  // the arm the refs exist FOR the one arm that never got them, silently.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  state.phases[1].status = 'parked';
  state.phases[1].declared!.status = 'needs-human';
  const asked: string[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { asked.push(t.ref); return { ref: t.ref, state: 'pending' }; },
  });
  scheduler.open();
  await scheduler.tick();
  assert.deepEqual(asked, ['gh:acme/app#run/9']);

  // …and the four other words that are not `waiting` and are not finished.
  for (const status of ['pending', 'failed', 'interrupted', 'queued']) {
    asked.length = 0;
    state.phases[1].status = status as never;
    state.phases[1].watchState = undefined;
    await scheduler.tick();
    assert.deepEqual(asked, ['gh:acme/app#run/9'], `${status} is watchable`);
  }
  // A phase with its own session on it needs no watching, and a finished one
  // has nothing left to resume.
  for (const status of ['running', 'verifying', 'done', 'skipped', 'gated']) {
    asked.length = 0;
    state.phases[1].status = status as never;
    state.phases[1].watchState = undefined;
    await scheduler.tick();
    assert.deepEqual(asked, [], `${status} is not watchable`);
  }
  scheduler.close();
});

test('criterion 1: refs are capped at eight, and a declaration outranks the record', async () => {
  const clock = new FakeClock();
  const many = Array.from({ length: 12 }, (_, i) => `gh:acme/app#run/${i + 1}`);
  const state = waitingRun(many);
  const scheduler = new WatchScheduler({
    clock, runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'pending' }),
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(state.phases[1].watchState!.refs.length, MAX_WATCH_REFS,
    'the same bound phase-outcome.sh puts on --watch, enforced on the read side too');

  // `declared.watch` is the session's own testimony and wins over `record.watch`,
  // which may be left from an earlier attempt.
  const two = waitingRun(['gh:acme/app#run/99']);
  (two.phases[1] as { watch?: string[] }).watch = ['gh:stale/repo#run/1'];
  const asked: string[] = [];
  const s2 = new WatchScheduler({
    clock, runs: () => [{ slug: 'beta', state: two }],
    probe: async (t) => { asked.push(t.ref); return { ref: t.ref, state: 'pending' }; },
  });
  s2.open();
  await s2.tick();
  assert.deepEqual(asked, ['gh:acme/app#run/99']);
  s2.close();
  scheduler.close();
});

test('criterion 1: `cmd:` goes through verify.ts\'s real policy — and a refusal is in WORDS', async () => {
  // The one scheme that executes anything, exercised against the actual policy
  // rather than a stub of it.
  const ok = await runSingleCommand('git status --porcelain', { cwd: process.cwd(), timeoutMs: 20_000 });
  assert.equal(ok.refused, undefined, 'a read-only command is run');
  // And the READS a watch ref actually wants stay allowed — the point of the
  // release-verb line was to close a hole, not to make `gh` unusable.
  for (const good of ['gh run list --repo o/r --limit 5', 'gh release view v1.2.3', 'npm ls --depth 0']) {
    const answer = await runSingleCommand(good, { cwd: process.cwd(), timeoutMs: 1_000 });
    assert.equal(answer.refused, undefined, `${good} must be allowed: ${answer.refused}`);
  }

  // The release verbs were added to `MUTATION_DENY` when this scheme opened it.
  // `npm publish` sailed straight past a denylist that already refused a script
  // CALLED `publish.sh` — a rule that stops the wrapper and runs the command it
  // wraps is a spelling test, and this repo IS an npm package.
  for (const bad of [
    'rm -rf /tmp/x', 'git push origin main',
    'npm publish', 'pnpm publish --access public', 'yarn version --patch', 'cargo publish',
    // Refused by `gh`'s OWN inverted allowlist, not by the denylist above —
    // asserted here so the two policies cannot quietly stop overlapping.
    'gh release create v1.0.0', 'gh api repos/o/r/dispatches -X POST',
  ]) {
    const answer = await runSingleCommand(bad, { cwd: process.cwd(), timeoutMs: 1_000 });
    assert.ok(answer.refused, `${bad} must be refused`);
    assert.equal(answer.ok, false);
    assert.ok(!answer.refused!.includes('\u0000'), 'a refusal is a sentence, not a sentinel');
  }

  // A command that is preamble the whole way down. The policy answers with its
  // internal `PREAMBLE` marker, which the plan path consumes by skipping the
  // line; this caller has nowhere to skip to, so it must translate it — or
  // `\u0000preamble` reaches a journal line and an operator errand verbatim.
  const preamble = await runSingleCommand('export FOO=1', { cwd: process.cwd(), timeoutMs: 1_000 });
  assert.ok(preamble.refused, 'nothing to wait for');
  assert.ok(!preamble.refused!.includes('\u0000'), `the sentinel leaked: ${JSON.stringify(preamble.refused)}`);
  assert.match(preamble.refused!, /runs nothing/);
});

/* ------------------------------------------------------------------ *
 * Criterion 2 — the landing, and what it tells the session
 * ------------------------------------------------------------------ */

test('criterion 2: the instruction names the conclusion, not just the landing', () => {
  // The measured p12 shape. "Re-check it now" against a cancelled run sends the
  // session to read a result that does not exist, and it declares the same wait
  // again — a resumed loop rather than a resumed session.
  assert.match(landingDirective({ detail: 'completed: cancelled' }), /CANCELLED[\s\S]*re-run it/);
  assert.match(landingDirective({ detail: 'completed: canceled' }), /CANCELLED/, 'both spellings');
  assert.match(landingDirective({ detail: 'completed: failure' }), /FAILED/);
  assert.match(landingDirective({ detail: 'completed: timed_out' }), /FAILED/);
  assert.match(landingDirective({ detail: 'CLOSED' }), /CLOSED rather than merged/);
  assert.match(landingDirective({ detail: 'MERGED' }), /Re-check it now/, 'a merge needs no special reading');
  assert.match(landingDirective({ detail: 'completed: success' }), /Re-check it now/);
  assert.match(landingDirective({}), /Re-check it now/, 'and no detail at all is still a landing');
});

test('criterion 2: a landing is handed to onLanded with the record, once per pass', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  const landed: { phase: number; ref: string }[] = [];
  let probes = 0;
  // `deferred` throughout: the healer is being asked and cannot act, which is
  // the case the re-delivery exists for.
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { probes += 1; return { ref: t.ref, state: 'landed', detail: 'completed: cancelled' }; },
    onLanded: (_slug, _st, phase, l) => { landed.push({ phase, ref: l.ref }); return 'deferred' as const; },
  });
  scheduler.open();
  await scheduler.tick();
  assert.deepEqual(landed, [{ phase: 1, ref: 'gh:acme/app#run/9' }]);
  assert.equal(probes, 1);

  // Inside the re-delivery clock: nothing.
  await scheduler.tick();
  assert.equal(landed.length, 1, 'not on every tick');

  // Past it: the landing is OFFERED AGAIN — and the world is NOT re-asked. The
  // healer may have been frozen, capped or unable to spawn on the first offer,
  // and a landing handed over exactly once loses it in all three cases (QA F2).
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'the landing is re-offered until the healer acts');
  assert.equal(probes, 1, 'and re-PROBED never — the world already answered');

  // Bounded where the healer bounds itself — and by the ERRAND, not only by the
  // count. The healer's over-cap branch writes `watchLandedErrandFor` and
  // returns WITHOUT incrementing `watchResumes`, so the count sits one below the
  // cap for ever; keying only on it would re-offer every minute to be
  // early-returned every minute.
  state.phases[1].watchLandedErrandFor = 'gh:acme/app#run/9';
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'the errand is the healer saying it has nothing left to try');
  delete state.phases[1].watchLandedErrandFor;
  state.phases[1].watchResumes = MAX_LANDING_DELIVERIES + 1;
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'and the count alone stops it too');

  // And the declaration being spent retires it whatever the count says.
  state.phases[1].watchResumes = 0;
  delete state.phases[1].declared;
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'nothing is waiting on it any more');
  scheduler.close();
});

test('criterion 2: a re-declared ref is watched again — watchState is cleared with the declaration', async () => {
  // QA F1, the one that recreated this phase's founding incident. A `landed`
  // row retires the ref from the rotation; left behind across a reset, the SAME
  // ref declared by the next attempt was never watched again and the phase
  // parked with nothing looking at it.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  const probes: string[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => { probes.push(t.ref); return { ref: t.ref, state: 'landed', detail: 'completed: success' }; },
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(probes.length, 1);
  assert.equal(state.phases[1].watchState!.refs[0].state, 'landed');

  // The session produced work, so its declaration is spent — through the one
  // writer, which is where the watch bookkeeping must go with it.
  clearWatchBookkeeping(state.phases[1]);
  assert.equal(state.phases[1].watchState, undefined);
  assert.equal(state.phases[1].watchChecked, undefined, 'both halves, or neither');

  // It parks again on the SAME ref. It must be watched again.
  state.phases[1].declared = {
    status: 'waiting-external', reason: 'the image build again',
    watch: ['gh:acme/app#run/9'], at: new Date(clock.time).toISOString(),
  };
  clock.time += WATCH_POLL_MS['gh-run'];
  await scheduler.tick();
  assert.equal(probes.length, 2, 'the re-declared ref is probed again');
  scheduler.close();
});

test('criterion 2: resetForRetry clears the watch bookkeeping even with no declaration to spend', () => {
  // `consumeDeclaration` clears it as a side effect of spending a declaration —
  // which does nothing on a phase that never declared one. A Retry must still
  // start the clock over.
  const record = waitingRun(['gh:acme/app#run/9']).phases[1];
  delete record.declared;
  record.watchState = {
    at: new Date(NOW).toISOString(),
    refs: [{ ref: 'gh:acme/app#run/9', scheme: 'gh-run', state: 'landed', checkedAt: new Date(NOW).toISOString() }],
  };
  record.watchChecked = { at: new Date(NOW).toISOString(), ref: 'gh:acme/app#run/9', state: 'landed' };
  record.watch = ['gh:acme/app#run/9'];
  resetForRetry(record, { by: 'operator', journal: () => {} });
  assert.equal(record.watchState, undefined);
  assert.equal(record.watchChecked, undefined);
  assert.equal(record.watch, undefined, 'the pre-`declared` shadow starts over too');
});

test('criterion 2: a SECOND declaration gets its own offer budget — the count and errand stamp retire with the wait they bound', () => {
  // QA round 3, H2. Round 1's rule — bookkeeping that retires something is
  // cleared wherever its subject is cleared — was applied to the row store and
  // missed these two: `watchResumes` and `watchLandedErrandFor` survived
  // `consumeDeclaration`, so a phase's SECOND wait inherited a spent count and
  // a standing errand stamp. Its very first landing went straight to the
  // over-cap branch: zero offers, and an errand about resumes that never
  // happened. The feature was silently off for every phase that waits twice.
  const record = waitingRun(['gh:acme/app#run/9']).phases[1];
  record.watchResumes = MAX_LANDING_DELIVERIES + 1;
  record.watchLandedErrandFor = 'gh:acme/app#run/9';
  record.watch = ['gh:acme/app#run/9'];
  const spent = consumeDeclaration(record, 'session-productive');
  assert.ok(spent, 'there was a declaration to spend');
  assert.equal(record.watchResumes, undefined, 'the spent count belongs to the spent wait');
  assert.equal(record.watchLandedErrandFor, undefined, 'and so does the errand stamp');
  assert.equal(record.watch, undefined,
    'and the record-level watch shadow — a copy that outlives its declaration testifies to a wait that is over (M1)');

  // The no-declaration path retires them identically: ONE writer.
  const bare = waitingRun(['gh:acme/app#run/9']).phases[1];
  delete bare.declared;
  bare.watchResumes = MAX_LANDING_DELIVERIES + 1;
  bare.watchLandedErrandFor = 'gh:acme/app#run/9';
  clearWatchBookkeeping(bare);
  assert.equal(bare.watchResumes, undefined);
  assert.equal(bare.watchLandedErrandFor, undefined);
});

test('criterion 2: a landed offer is HELD by the un-settled drive, and returns when it settles', async () => {
  // QA rounds 2 and 3, G1 → H1. The hold was first a clock (which could not
  // tell a running resume from one that never happened) and then a
  // `deliveredAt` receipt the scheduler stamped when the healer had merely
  // CALLED `recoverPhase` — before a session could be known to exist — so a
  // drive that resolved without launching gated the landing FOR EVER, silently.
  // The hold is now `resumeInFlight`: the service's own un-settled drive
  // promise, the one thing that settles exactly when the drive does.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  let inFlight = false;
  const landed: number[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'landed', detail: 'completed: success' }),
    onLanded: (_s, _st, phase) => { landed.push(phase); inFlight = true; return 'resumed' as const; },
    resumeInFlight: () => inFlight,
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(landed.length, 1);

  // The drive is settling. However long that takes — a queued admission, a
  // session mid-work — the landing is not offered again: the scheduler asks
  // the component holding the promise instead of guessing from a stamp, and
  // `WATCH_REDELIVER_MS` is shorter than a first productive turn.
  for (let i = 0; i < 10; i += 1) { clock.time += WATCH_REDELIVER_MS; await scheduler.tick(); }
  assert.equal(landed.length, 1, 'not while the drive is in flight');

  // The drive settled with the wait still declared — the resume ran and
  // produced nothing, or launched nothing and was un-charged. Offered again,
  // which is what makes the bound meaningful.
  inFlight = false;
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'the drive settled with the wait still declared');

  // And the scheduler signs NOTHING: the stamp belongs to the healer, beside
  // the rollback that can revoke it (H1's whole point).
  assert.equal(state.phases[1].watchState!.refs[0].deliveredAt, undefined,
    'no receipt is written here');
  scheduler.close();
});

test('criterion 2: a DEFERRED landing spends nothing — the healer that could not act is asked again', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  const landed: number[] = [];
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'landed' }),
    // A fleet freeze, `--allow-run` off, a recovery already in flight, a spawn
    // that threw — all of them answer this way.
    onLanded: (_s, _st, phase) => { landed.push(phase); return 'deferred' as const; },
  });
  scheduler.open();
  await scheduler.tick();
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(landed.length, 2, 'asked again');
  assert.equal(state.phases[1].watchState!.refs[0].deliveredAt, undefined,
    'and nothing was stamped, because nothing was delivered');
  scheduler.close();
});

test('criterion 2: a DONE landing retires the row and stops churning the fingerprint', async () => {
  // QA round 2, G2: a terminal landed row kept its `nextDueAt`, and nothing
  // advances it on a `waiting`/`parked` phase — which `WATCH_INELIGIBLE_STATUSES`
  // does not cover — so `evidenceFingerprint` changed every minute for ever.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'landed' }),
    onLanded: () => 'done' as const,
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(state.phases[1].watchState!.refs[0].nextDueAt, undefined, 'retired at once');

  // …and the other terminal route: the healer's over-cap errand.
  const two = waitingRun(['gh:acme/app#run/9'], { id: 'run-2', slug: 'beta' });
  const s2 = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'beta', state: two }],
    probe: async (t) => ({ ref: t.ref, state: 'landed' }),
    onLanded: () => 'deferred' as const,
  });
  s2.open();
  await s2.tick();
  assert.ok(two.phases[1].watchState!.refs[0].nextDueAt, 'due while it is still being offered');
  two.phases[1].watchLandedErrandFor = 'gh:acme/app#run/9';
  clock.time += WATCH_REDELIVER_MS;
  await s2.tick();
  assert.equal(two.phases[1].watchState!.refs[0].nextDueAt, undefined,
    'a row nothing will ever advance is not evidence, and must not read as due');
  s2.close();
  scheduler.close();
});

test('criterion 3: the terminal retirement of a landed row reaches DISK — saved, and a re-loaded copy stops churning', async () => {
  // QA round 3, M2. The terminal `delete row.nextDueAt` existed and was
  // mutation-proven — on the object it happened on. Production re-loads the
  // run from disk on every pass, so a delete that triggered no save stopped
  // the churn only in memory: the DISK copy's fingerprint still read
  // `due@<minute>`, advancing every minute for ever. The same proxy mistake
  // round 2 named for G3, in a different place — the harness's scheduler and
  // its fingerprint shared one object, so the test could not see it.
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9']);
  let saves = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'landed', detail: 'completed: success' }),
    onLanded: () => 'deferred' as const,
    save: () => { saves += 1; },
  });
  scheduler.open();
  await scheduler.tick();
  assert.ok(state.phases[1].watchState!.refs[0].nextDueAt, 'due while the offer still stands');

  // The healer writes its terminal word; the next pass retires the row.
  state.phases[1].watchLandedErrandFor = 'gh:acme/app#run/9';
  const before = saves;
  clock.time += WATCH_REDELIVER_MS;
  await scheduler.tick();
  assert.equal(state.phases[1].watchState!.refs[0].nextDueAt, undefined, 'retired');
  assert.ok(saves > before, 'and the retirement is SAVED — a write that stays in memory protects nothing');

  // The reader's view: what a fresh pass would load from disk.
  const reloaded = JSON.parse(JSON.stringify(state)) as RunState;
  const board = { 1: 'in-progress' };
  const a = evidenceFingerprint(reloaded, board, [], null, null, clock.time);
  const b = evidenceFingerprint(reloaded, board, [], null, null, clock.time + 600_000);
  assert.equal(a, b, 'the re-loaded copy no longer reads as due every minute');
  scheduler.close();
});

test('criterion 2: an onLanded that throws does not stop the sweep', async () => {
  const clock = new FakeClock();
  const state = waitingRun(['gh:acme/app#run/9', 'gh:acme/app#run/10']);
  let seen = 0;
  const scheduler = new WatchScheduler({
    clock,
    runs: () => [{ slug: 'alpha', state }],
    probe: async (t) => ({ ref: t.ref, state: 'landed' }),
    onLanded: () => { seen += 1; throw new Error('the healer blew up'); },
  });
  scheduler.open();
  await scheduler.tick();
  assert.equal(seen, 2, 'the second landing is still delivered');
  // A throw is a DEFERRAL, not a delivery: nothing was acted on, so nothing may
  // be charged as though it had been.
  for (const row of state.phases[1].watchState!.refs) {
    assert.equal(row.deliveredAt, undefined, `${row.ref} must not carry a receipt`);
  }
  scheduler.close();
});

/* ------------------------------------------------------------------ *
 * Criterion 3 — the noop latch cannot hide a due ref
 * ------------------------------------------------------------------ */

test('criterion 3: a due watch ref changes the evidence fingerprint; a scheduled one does not', () => {
  const board = { 1: 'in-progress' };
  const base = waitingRun(['gh:acme/app#run/9']);
  base.phases[1].watchState = {
    at: new Date(NOW).toISOString(),
    refs: [{ ref: 'gh:acme/app#run/9', scheme: 'gh-run', state: 'pending', checkedAt: new Date(NOW).toISOString(), nextDueAt: NOW + 120_000 }],
  };

  // Nothing due: the fingerprint is stable across the whole cadence, so the
  // "found nothing to climb" latch still holds and the healer stays quiet.
  const a = evidenceFingerprint(base, board, [], null, null, NOW);
  const b = evidenceFingerprint(base, board, [], null, null, NOW + 119_000);
  assert.equal(a, b, 'a pending ref inside its cadence is not a change');

  // Due and not yet probed: the term becomes the current minute, which
  // advances — so the latch cannot hold across the five-minute sweep. This is
  // the p12 shape: a workflow run finished, and nothing else about the run, the
  // board, the locks or the gate had changed.
  const due = evidenceFingerprint(base, board, [], null, null, NOW + 120_000);
  assert.notEqual(due, a, 'a ref that has come due IS a change');
  const later = evidenceFingerprint(base, board, [], null, null, NOW + 180_000);
  assert.notEqual(due, later, 'and it keeps changing while the probe is late');

  // A row on a phase the scheduler will NEVER probe again must not churn it.
  // `converge` scans every phase's rows; the scheduler skips ineligible
  // statuses — so a `pending` row left on a phase that moved to `done` reads as
  // due for ever and defeats the noop latch permanently, which is the exact
  // "permanent spin" the latch exists to stop (QA F3).
  const stale = waitingRun(['gh:acme/app#run/9']);
  stale.phases[1].status = 'done';
  stale.phases[1].watchState = {
    at: new Date(NOW).toISOString(),
    refs: [{ ref: 'gh:acme/app#run/9', scheme: 'gh-run', state: 'pending', checkedAt: new Date(NOW).toISOString(), nextDueAt: NOW - 1 }],
  };
  assert.equal(
    evidenceFingerprint(stale, board, [], null, null, NOW),
    evidenceFingerprint(stale, board, [], null, null, NOW + 600_000),
    'a row nobody will ever advance is not evidence',
  );

  // A run with no watch state at all is unaffected — the term is empty, so
  // this cannot make every plan converge on a timer.
  const bare = waitingRun([]);
  assert.equal(
    evidenceFingerprint(bare, board, [], null, null, NOW),
    evidenceFingerprint(bare, board, [], null, null, NOW + 3_600_000),
    'no refs, no clock in the fingerprint — the lease lesson is intact',
  );
});

/* ------------------------------------------------------------------ *
 * Criterion 4 — retry storms
 * ------------------------------------------------------------------ */

test('criterion 4: an uncategorised retry is classified from its detail, conservatively', () => {
  assert.equal(inferRetryCategory('Error: 429 Too Many Requests'), 'rate_limit');
  assert.equal(inferRetryCategory('rate limit exceeded for this organization'), 'rate_limit');
  assert.equal(inferRetryCategory('rate_limit_error'), 'rate_limit');
  assert.equal(inferRetryCategory('Overloaded'), 'overloaded');
  assert.equal(inferRetryCategory('API error 529'), 'overloaded');
  assert.equal(inferRetryCategory('401 Unauthorized'), 'authentication_failed');
  assert.equal(inferRetryCategory('invalid api key'), 'authentication_failed');
  assert.equal(inferRetryCategory('403 forbidden'), 'authentication_failed');

  // A 429 body often says "overloaded" too. The quota reading wins because it
  // is the one with a remedy: another account pays, and no account has more
  // capacity than another.
  assert.equal(inferRetryCategory('429: server overloaded'), 'rate_limit');

  // And everything else stays uncategorised. A WRONG category is worse than
  // none — it would send the live wall after an account switch for a capacity
  // problem every account has.
  assert.equal(inferRetryCategory('connection reset by peer'), undefined);
  assert.equal(inferRetryCategory('socket hang up'), undefined);
  assert.equal(inferRetryCategory(''), undefined);
  assert.equal(inferRetryCategory(undefined), undefined);
});

/* ------------------------------------------------------------------ *
 * The wait budget, answered — never cut (zero-touch-console phase 5)
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60_000;
const DEFAULT: WaitBudget = { budgetMs: DEFAULT_WAIT_BUDGET_MS, source: 'default', countersignedUntil: null, refs: [] };

test('WAI-1: a declared window past the budget is REFUSED with the arithmetic — never a silent eight hours', () => {
  // The measured soak: 48 hours asked, eight granted, woken early, halted with
  // 2 377 of 2 880 minutes still to run. The answer is now given at park.
  const verdict = evaluateWait({ now: NOW, requestedUntil: NOW + 48 * HOUR, parkedMs: 0, waits: 0, budget: DEFAULT, ledger: 'session' });
  assert.equal(verdict.verdict, 'timeout');
  assert.ok(verdict.verdict === 'timeout');
  assert.equal(verdict.ledger, 'budget');
  assert.match(verdict.reason, /asked to wait until 2026-09-01T12:00:00\.000Z \(48 h from now\)/);
  assert.match(verdict.reason, /wait budget is 8\.0 h \(the console default\) with 0\.0 h already parked, so 8\.0 h remain/);
  assert.match(verdict.reason, /does not cut a declared window short/);
  assert.match(verdict.reason, /Waits on:/, 'and it names the line that would have allowed it');

  // Inside the budget: granted exactly as asked, not capped.
  const inside = evaluateWait({ now: NOW, requestedUntil: NOW + 2 * HOUR, parkedMs: HOUR, waits: 1, budget: DEFAULT, ledger: 'session' });
  assert.ok(inside.verdict === 'park');
  assert.equal(inside.until, NOW + 2 * HOUR);
  assert.equal(inside.granted, 2 * HOUR);
  assert.equal(inside.capped, false);
  assert.equal(inside.requestedSource, 'declared');
  assert.equal(inside.budgetRemainingMs, 7 * HOUR);

  // A window already in the past floors to a minute, never to the default.
  const lapsed = evaluateWait({ now: NOW, requestedUntil: NOW - HOUR, parkedMs: 0, waits: 0, budget: DEFAULT, ledger: 'session' });
  assert.ok(lapsed.verdict === 'park' && lapsed.until === NOW + 60_000);
});

test('WAI-1: only a DEFAULT window is ever capped, and the per-phase cap refuses by its own ledger', () => {
  // No `resume_after`: the session named no window, so what is left is what it gets.
  const tail = evaluateWait({ now: NOW, parkedMs: 7.9 * HOUR, waits: 1, budget: DEFAULT, ledger: 'session' });
  assert.ok(tail.verdict === 'park');
  assert.equal(tail.capped, true);
  assert.equal(tail.requestedSource, 'default');
  assert.equal(Math.round(tail.granted / 60_000), 6);

  const spent = evaluateWait({ now: NOW, requestedUntil: NOW + HOUR, parkedMs: 0, waits: WAIT_MAX_PER_PHASE, budget: DEFAULT, ledger: 'session' });
  assert.ok(spent.verdict === 'timeout');
  assert.equal(spent.ledger, 'waits');
  assert.match(spent.reason, /already declared 4 wait\(s\)/);
});

test('WAI-11: a declared `date:` ref extends the park to its instant — or is named in the refusal; the plan can countersign it', () => {
  const soak = NOW + 3 * HOUR;
  const extended = evaluateWait({
    now: NOW, requestedUntil: NOW + 30 * 60_000, parkedMs: 0, waits: 0, budget: DEFAULT, ledger: 'session',
    dates: [['date:2026-08-30T15:00:00Z', soak]],
  });
  assert.ok(extended.verdict === 'park');
  assert.equal(extended.until, soak, 'the date ref is the session saying exactly when the wait ends');
  assert.equal(extended.extendedBy, 'date:2026-08-30T15:00:00Z');

  const far = NOW + 46 * HOUR;
  const named = evaluateWait({
    now: NOW, requestedUntil: NOW + HOUR, parkedMs: 0, waits: 0, budget: DEFAULT, ledger: 'session',
    dates: [['date:2026-09-01T10:00:00Z', far]],
  });
  assert.ok(named.verdict === 'timeout');
  assert.equal(named.overriddenRef, 'date:2026-09-01T10:00:00Z');
  assert.match(named.reason, /names `date:2026-09-01T10:00:00Z`/);

  // The plan's own `- **Waits on:** date:…` countersigns it: granted past the budget.
  const countersigned = waitBudgetFrom('', 'date:2026-09-02T00:00:00Z\ngh:acme/app#run/9\n', dateOfRef);
  assert.equal(countersigned.source, 'default');
  assert.equal(countersigned.countersignedUntil, Date.parse('2026-09-02T00:00:00Z'));
  const honoured = evaluateWait({
    now: NOW, requestedUntil: NOW + HOUR, parkedMs: 0, waits: 0, budget: countersigned, ledger: 'session',
    dates: [['date:2026-09-01T10:00:00Z', far]],
  });
  assert.ok(honoured.verdict === 'park' && honoured.until === far && honoured.capped === false);

  // …and the engine's `Waits on:` max is the phase's own budget, in minutes.
  assert.deepEqual(waitBudgetFrom('45\tphase\n', '', dateOfRef), { budgetMs: 45 * 60_000, source: 'phase', countersignedUntil: null, refs: [] });
  assert.equal(waitBudgetFrom('', '', dateOfRef).budgetMs, DEFAULT_WAIT_BUDGET_MS, 'silence is the console default');
});

test('WAI-5: the watchdog parks on a ledger of its own — four automatic parks spend nothing of the session\'s', () => {
  const auto = evaluateWait({ now: NOW, parkedMs: 20 * HOUR, waits: 3, budget: DEFAULT, ledger: 'watchdog' });
  assert.ok(auto.verdict === 'park', 'a watchdog park is never refused by the declared budget');
  const fifthAuto = evaluateWait({ now: NOW, parkedMs: 0, waits: WATCHDOG_PARKS_MAX_PER_PHASE, budget: DEFAULT, ledger: 'watchdog' });
  assert.ok(fifthAuto.verdict === 'timeout');
  assert.equal(fifthAuto.ledger, 'watchdog');
  assert.match(fifthAuto.reason, /parked this phase 4 time\(s\) by itself/);
  assert.match(fifthAuto.reason, /session's own wait allowance is untouched/);

  // After four AUTOMATIC parks, a declared wait still has all of its own.
  const record = { status: 'waiting', waits: 0, watchdogParks: 4 } as unknown as PhaseRecord;
  for (let i = 0; i < 4; i++) {
    openWaitEntry(record, { parkedFrom: new Date(NOW - (8 - i) * HOUR).toISOString(), parkedUntil: new Date(NOW - (7.5 - i) * HOUR).toISOString(), by: 'watchdog' }, NOW);
  }
  closeWaitEntry(record, new Date(NOW - 3 * HOUR).toISOString());
  assert.equal(parkedMsOf(record, NOW), 0, 'the watchdog\'s parked time is not the declared ledger\'s');
  const declared = evaluateWait({ now: NOW, requestedUntil: NOW + HOUR, parkedMs: parkedMsOf(record, NOW), waits: record.waits ?? 0, budget: DEFAULT, ledger: 'session' });
  assert.ok(declared.verdict === 'park', 'the fifth wait — the first DECLARED one — is granted');
});

test('WAI-3: parked time comes from the park\'s own stamps — correct with no resume, superseded parks included', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const record = { status: 'waiting' } as unknown as PhaseRecord;
  // Parked at T-10h for a 4 h window, superseded at T-8h by a second park, which
  // the console outlived: its clock went by at T-2h and nothing stamped an end.
  openWaitEntry(record, { parkedFrom: iso(NOW - 10 * HOUR), parkedUntil: iso(NOW - 6 * HOUR), by: 'session' }, NOW);
  openWaitEntry(record, { parkedFrom: iso(NOW - 8 * HOUR), parkedUntil: iso(NOW - 2 * HOUR), by: 'session' }, NOW);
  assert.equal(record.waitHistory![0].resumedAt, iso(NOW - 8 * HOUR), 'the superseded park ended when the next began');
  // The second is the park still holding (status waiting): it counts to now.
  assert.equal(parkedMsOf(record, NOW), 2 * HOUR + 8 * HOUR, 'both windows, the elapsed hours included — never zero for a park that did not resume');
  // Not waiting any more and never stamped: bounded by its own clock.
  record.status = 'pending';
  assert.equal(parkedMsOf(record, NOW), 2 * HOUR + 6 * HOUR);
  // A record from before the history reads its legacy accrual, and carries it in once.
  const legacy = { status: 'pending', parkedMs: 3 * HOUR } as unknown as PhaseRecord;
  assert.equal(parkedMsOf(legacy, NOW), 3 * HOUR);
  openWaitEntry(legacy, { parkedFrom: iso(NOW - HOUR), parkedUntil: iso(NOW), by: 'session' }, NOW);
  legacy.status = 'waiting';
  assert.equal(parkedMsOf(legacy, NOW), 4 * HOUR);
});

test('WAI-4: at resume, a park past its budget is not boarded — unless the plan countersigned the wait', () => {
  const over = evaluateWait({ purpose: 'resume', now: NOW, parkedMs: 11.76 * HOUR, waits: 1, budget: DEFAULT, ledger: 'session' });
  assert.ok(over.verdict === 'timeout');
  assert.match(over.reason, /parked 12 h against its 8\.0 h wait budget/);
  assert.match(over.reason, /will not board it on a stale clock/);
  const within = evaluateWait({ purpose: 'resume', now: NOW, parkedMs: 2 * HOUR, waits: 1, budget: DEFAULT, ledger: 'session' });
  assert.ok(within.verdict === 'resume' && within.budgetRemainingMs === 6 * HOUR);
  const countersigned = evaluateWait({
    purpose: 'resume', now: NOW, parkedMs: 30 * HOUR, waits: 1, ledger: 'session',
    budget: { ...DEFAULT, countersignedUntil: NOW + HOUR },
  });
  assert.ok(countersigned.verdict === 'resume' && countersigned.extendedBy);
  assert.equal(evaluateWait({ purpose: 'resume', now: NOW, parkedMs: 99 * HOUR, waits: 0, budget: DEFAULT, ledger: 'watchdog' }).verdict, 'resume');
});

test('WAI-2: only a declared window that really elapsed is called one', () => {
  const facts = {
    scriptsDir: '/skill/scripts', slug: 'soak', phase: 16, reason: 'the 48 h soak', watch: ['date:2026-09-01T12:00:00Z'],
    externalLeftMs: 40 * HOUR, budgetMs: DEFAULT_WAIT_BUDGET_MS, budgetRemainingMs: 0, budgetSource: 'default' as const, lateMs: 0,
  };
  const declared = waitResumePrompt({ ...facts, cause: 'declared-window', externalLeftMs: null });
  assert.match(declared, /The wait window you declared for phase 16 of `soak` has elapsed/);
  for (const cause of ['budget-elapsed', 'watchdog'] as const) {
    const prompt = waitResumePrompt({ ...facts, cause });
    assert.doesNotMatch(prompt, /the wait window you declared/i, `${cause}: never claims the declared window`);
    assert.doesNotMatch(prompt, /has elapsed/, `${cause}: never says "has elapsed"`);
  }
  const budget = waitResumePrompt({ ...facts, cause: 'budget-elapsed' });
  assert.match(budget, /wait BUDGET ran out — NOT because the window you declared is over/);
  assert.match(budget, /still 40 h away/, 'it names the external time left');
  assert.match(budget, /Waits on:/, 'and the one act that extends it');
  assert.match(waitResumePrompt({ ...facts, cause: 'watchdog' }), /The CONSOLE parked phase 16 .* you did not declare this wait/);
  // Every re-file instruction carries the real path and the allowance left.
  assert.match(budget, /bash \/skill\/scripts\/phase-outcome\.sh soak 16 waiting-external/);
  assert.match(budget, /may stay parked 0\.0 h more \(its wait\s+budget is 8\.0 h, the console default\)/);
  // A resume that came hours late says so.
  assert.match(waitResumePrompt({ ...facts, cause: 'declared-window', lateMs: 9.7 * HOUR }), /came 9\.7 h after the clock/);
});

test('WAI-11: an unparseable ref is named with why — one gh: ref polls, the other is unpollable', () => {
  const refs = ['gh:acme/app#run/42', 'config/fleet-pin.yaml:app-prod'];
  assert.deepEqual(pollableRefs(refs).map((t) => t.ref), ['gh:acme/app#run/42']);
  const unpollable = unpollableRefs(refs);
  assert.equal(unpollable.length, 1);
  assert.equal(unpollable[0].ref, 'config/fleet-pin.yaml:app-prod');
  assert.match(unpollable[0].reason, /no watch scheme/);
  assert.equal(watchRefProblem('gh:acme/app#run/42'), null);
  assert.match(watchRefProblem('date:2026-09-31T00:00:00Z') ?? '', /not a real ISO8601 instant/, 'the calendar is read, not just the shape');
});

test('WAI-11: phase-outcome.sh warns at write time about exactly the refs the console cannot poll', () => {
  // The script checks shape; the console also reads the calendar — so the list
  // holds only refs where shape and calendar agree.
  const refs = [
    'gh:acme/app#run/42', 'gh:acme/app#pr/7', 'gh:acme#run/1', 'gh:acme/app#issue/3',
    'date:2026-09-20T06:00:00Z', 'until:2026-09-20 06:00', 'date:soon',
    'lock:alpha/2', 'lock:alpha/02', 'lock:alpha/0', 'lock:/2',
    'cmd:"npm test"', "cmd:'make check'", 'cmd:""', 'cmd:',
    'config/fleet-pin.yaml:app-prod', 'https://ci.example/run/9',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'pc-watch-warn-'));
  try {
    for (const ref of refs) {
      let stderr = '';
      try {
        execFileSync('/bin/bash', [join(SKILL_DIR, 'scripts', 'phase-outcome.sh'), 'demo', '3', 'waiting-external', '--wait-minutes', '30', '--watch', ref], {
          env: { ...process.env, PE_OUTCOME_FILE: join(dir, 'outcome.json') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) { stderr = String((error as { stderr?: string }).stderr ?? ''); }
      // execFileSync hides stderr on success — ask again with it folded in.
      stderr ||= execFileSync('/bin/bash', ['-c', `"$0" demo 3 waiting-external --wait-minutes 30 --watch "$1" 2>&1 >/dev/null || true`, join(SKILL_DIR, 'scripts', 'phase-outcome.sh'), ref], {
        env: { ...process.env, PE_OUTCOME_FILE: join(dir, 'outcome.json') }, encoding: 'utf8',
      });
      const warned = stderr.includes('will never be checked');
      assert.equal(warned, watchRefProblem(ref) !== null, `${ref}: the script ${warned ? 'warned' : 'said nothing'}, the console reads ${watchRefProblem(ref) ?? 'pollable'}`);
      assert.ok(readFileSync(join(dir, 'outcome.json'), 'utf8').includes('"watch"'), 'recorded either way');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * WAI-6 — a `waiting` record whose clock nothing will fire
 * ------------------------------------------------------------------ */

/** Every journal line of a run, parsed. */
function journalLines(root: string, slug: string, id: string): { event: string; phase?: number; data?: Record<string, unknown> }[] {
  try {
    return readFileSync(journalFile(root, slug, id), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; phase?: number; data?: Record<string, unknown> });
  } catch {
    return [];
  }
}

/** A stored run with one `waiting` record parked until `parkedUntil`, and no run clock. */
function storedWait(root: string, over: { status: RunState['status']; stoppedBy?: 'operator' | 'system'; parkedUntil: string; resolved?: boolean }) {
  const state = newRun({ slug: 'alpha', root, model: 'opus' });
  state.status = over.status;
  if (over.stoppedBy) state.stoppedBy = over.stoppedBy;
  state.waitUntil = null;
  if (over.resolved) state.resolved = { at: new Date(NOW).toISOString(), by: 'operator', note: 'done with it' } as never;
  const record = phaseRecord(state, 4);
  record.status = 'waiting';
  record.sessionId = 'sess-p4';
  record.parkedUntil = over.parkedUntil;
  record.parkReason = 'the Monday deploy window';
  record.declared = { status: 'waiting-external', reason: 'the Monday deploy window', at: new Date(NOW).toISOString() };
  saveRun(state);
  return state;
}

test('WAI-6: a run that lost its clock is re-armed from the record on load, and the journal says which', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-'));
  try {
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    const stored = storedWait(root, { status: 'waiting', stoppedBy: 'system', parkedUntil: ahead });
    assert.equal(stored.waitUntil, null, 'precondition: the run carries no clock');
    const loaded = loadRun(root, 'alpha', stored.id);
    assert.ok(loaded);
    // Re-armed, not orphaned: `reconcileRun` used to send a clockless `waiting`
    // run to `interrupted-by-restart`; with the record's clock read first it is
    // the paused-with-clock shape the boot re-arm knows.
    assert.equal(loaded.waitUntil, ahead);
    assert.equal(loaded.waitReason, 'external');
    assert.equal(loaded.status, 'paused');
    assert.equal(loaded.phases[4].status, 'waiting');
    assert.equal(loaded.phases[4].parkedUntil, ahead);
    const settled = journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].phase, 4);
    assert.equal(settled[0].data?.to, 'rearmed');
    assert.equal(settled[0].data?.clock, ahead);
    // The one reader both re-arm paths use answers the same clock, and the
    // converge predicate arms it rather than calling it not-a-wait.
    assert.equal(waitClockOf(loaded), ahead);
    assert.equal(waitClockVerdict(loaded, { now: Date.now(), prefs: {} }).verdict, 'arm');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WAI-6: waitClockVerdict reads the record\'s clock when the run has none — a wait, not not-a-wait', () => {
  const run = waitingRun([], { status: 'paused', stoppedBy: 'system', waitUntil: null } as never);
  assert.equal(run.waitUntil, null);
  assert.equal(soonestWaitingClock(run), run.phases[1].parkedUntil);
  const verdict = waitClockVerdict(run, { now: NOW, prefs: {} });
  assert.equal(verdict.verdict, 'arm');
  // …and with no waiting record either, it is what it always was.
  run.phases[1].status = 'done';
  assert.equal(waitClockVerdict(run, { now: NOW, prefs: {} }).verdict, 'not-a-wait');
});

test('WAI-6: an operator-stopped run\'s dead clock is SETTLED — `pending`, the declaration intact, the session kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-'));
  try {
    // The audit's two: `paused`/`stoppedBy: operator`, 189 hours past the clock.
    const dead = new Date(Date.now() - 189 * 3_600_000).toISOString();
    const stored = storedWait(root, { status: 'paused', stoppedBy: 'operator', parkedUntil: dead });
    const loaded = loadRun(root, 'alpha', stored.id)!;
    const record = loaded.phases[4];
    assert.equal(record.status, 'pending');
    assert.equal(record.parkedUntil, undefined, 'the dead clock is gone from the record');
    assert.equal(record.declared?.status, 'waiting-external', 'the testimony stands');
    assert.equal(record.resumeSessionId, 'sess-p4', 'a Retry resumes the session, not a restart');
    assert.equal(loaded.waitUntil, null, 'an operator\'s stop is not re-armed');
    assert.equal(loaded.status, 'paused');
    const settled = journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled');
    assert.equal(settled.length, 1);
    assert.deepEqual(
      { to: settled[0].data?.to, why: settled[0].data?.why, clock: settled[0].data?.clock, phase: settled[0].phase },
      { to: 'pending', why: 'operator-stopped', clock: dead, phase: 4 },
    );
    assert.ok((settled[0].data?.lateByMs as number) > 188 * 3_600_000);
    // Idempotent: a second load settles nothing more and writes nothing more.
    loadRun(root, 'alpha', stored.id);
    assert.equal(journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WAI-6: a record still inside the settlement grace is left standing — the row and the settlement agree on when', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-'));
  try {
    const recent = new Date(Date.now() - WAIT_SETTLE_GRACE_MS / 2).toISOString();
    const stored = storedWait(root, { status: 'paused', stoppedBy: 'operator', parkedUntil: recent });
    const loaded = loadRun(root, 'alpha', stored.id)!;
    assert.equal(loaded.phases[4].status, 'waiting');
    assert.equal(loaded.phases[4].parkedUntil, recent);
    assert.equal(journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WAI-6: a `waiting` record on a run that is OVER is `interrupted`, naming the dead clock — at once', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-'));
  try {
    const clock = new Date(Date.now() + 60_000).toISOString(); // not even past: the run is over, so the clock is dead anyway
    const stored = storedWait(root, { status: 'finished', parkedUntil: clock });
    const loaded = loadRun(root, 'alpha', stored.id)!;
    assert.equal(loaded.phases[4].status, 'interrupted');
    assert.match(loaded.phases[4].note ?? '', /run ended before the clock fired/);
    assert.equal(loaded.phases[4].declared?.status, 'waiting-external');
    const settled = journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].data?.to, 'interrupted');
    assert.equal(settled[0].data?.why, 'run-over');
    assert.equal(settled[0].data?.clock, clock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WAI-6: a `waiting` record on an interrupted run whose clock died is `pending` after the grace, why: clock-unarmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-'));
  try {
    const dead = new Date(Date.now() - 2 * WAIT_SETTLE_GRACE_MS).toISOString();
    const stored = storedWait(root, { status: 'interrupted', stoppedBy: 'system', parkedUntil: dead });
    const loaded = loadRun(root, 'alpha', stored.id)!;
    assert.equal(loaded.phases[4].status, 'pending');
    assert.equal(loaded.phases[4].declared?.status, 'waiting-external');
    const settled = journalLines(root, 'alpha', stored.id).filter((l) => l.event === 'phase.wait-settled');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].data?.why, 'clock-unarmed');
    assert.equal(settled[0].data?.runStatus, 'interrupted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * WAI-8 — every declared word counted, capped and cooled
 * ------------------------------------------------------------------ */

test('WAI-8: N+1 declarations of one word are N acts and one refusal — on every word but the wait, which its own ledger bounds', () => {
  for (const status of ['partial', 'needs-human', 'blocked', 'complete', 'no-defect'] as const) {
    const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
    const verdicts: string[] = [];
    for (let i = 0; i < DECLARATIONS_MAX_PER_PHASE + 1; i++) {
      verdicts.push(chargeDeclaration(record, status, { now: NOW + i * 3_600_000 }).verdict);
    }
    assert.deepEqual(verdicts, [...Array(DECLARATIONS_MAX_PER_PHASE).fill('act'), 'refused'], status);
    assert.equal(record.declarations?.[status]?.count, DECLARATIONS_MAX_PER_PHASE);
    assert.equal(record.declarations?.[status]?.refused, 1);
    // The refusal names the arithmetic.
    const again = chargeDeclaration(record, status, { now: NOW + 10 * 3_600_000 });
    assert.deepEqual({ verdict: again.verdict, count: again.count, max: again.max, refused: again.refused },
      { verdict: 'refused', count: DECLARATIONS_MAX_PER_PHASE, max: DECLARATIONS_MAX_PER_PHASE, refused: 2 });
  }
  // `waiting-external` is COUNTED here and refused only by `waits` (evaluateWait):
  // one word is never refused twice.
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
  for (let i = 0; i < 6; i++) assert.equal(chargeDeclaration(record, 'waiting-external', { now: NOW + i * 3_600_000 }).verdict, 'act');
  assert.equal(record.declarations?.['waiting-external']?.count, 6);
});

test('WAI-8 / SLF-4: inside the cooldown a second `partial` collapses into the act that stands — anchored to the act, not the repeat', () => {
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
  const cooldown = declarationCooldownFor('partial');
  assert.equal(cooldown, DECLARATION_COOLDOWN_MS);
  assert.equal(chargeDeclaration(record, 'partial', { now: NOW, cooldownMs: cooldown }).verdict, 'act');
  assert.equal(chargeDeclaration(record, 'partial', { now: NOW + 60_000, cooldownMs: cooldown }).verdict, 'cooled');
  // A stream of repeats every minute never buys a fresh window: the anchor is the last ACT.
  assert.equal(chargeDeclaration(record, 'partial', { now: NOW + 4 * 60_000, cooldownMs: cooldown }).verdict, 'cooled');
  assert.equal(record.declarations?.partial?.count, 1);
  assert.equal(record.declarations?.partial?.refused, 2);
  assert.equal(chargeDeclaration(record, 'partial', { now: NOW + DECLARATION_COOLDOWN_MS + 1, cooldownMs: cooldown }).verdict, 'act');
  assert.equal(record.declarations?.partial?.count, 2);
  // Only `partial` has a cooldown: a wait has its own floor and budget, a blocker rewrites an errand.
  for (const status of ['waiting-external', 'needs-human', 'blocked', 'complete', 'no-defect']) {
    assert.equal(declarationCooldownFor(status), undefined, status);
  }
});

test('WAI-8 / SLF-4: prepareReboard keeps the phase\'s bounds; only an operator\'s Retry clears them', () => {
  const record: PhaseRecord = phaseRecord(newRun({ slug: 'alpha', root: '/tmp/x' }), 1);
  record.status = 'failed';
  record.stallRemedy = { nudges: 2, recycles: 1 };
  record.said = 'I ran out of context';
  record.stall = { kind: 'silent', since: new Date(NOW).toISOString(), detail: 'quiet' } as never;
  record.idleAttempts = 3;
  record.watchRetired = ['cmd:npm ci'];
  chargeDeclaration(record, 'partial', { now: NOW });
  prepareReboard(record);
  assert.equal(record.status, 'pending');
  assert.equal(record.stall, undefined, 'the attempt\'s stall episode goes');
  assert.equal(record.idleAttempts, undefined);
  assert.deepEqual(record.stallRemedy, { nudges: 2, recycles: 1 }, 'the watchdog\'s bound stays (SLF-4)');
  assert.equal(record.said, 'I ran out of context', 'the session\'s last words stay (phase 9 reads them)');
  assert.equal(record.declarations?.partial?.count, 1, 'the ledger stays');
  assert.deepEqual(record.watchRetired, ['cmd:npm ci'], 'a retired ref stays retired');
  // The console's own Retry (a converge relaunch, the ladder) carries every bound forward too…
  record.status = 'failed';
  const lines: string[] = [];
  resetForRetry(record, { by: 'console', journal: (event) => { lines.push(event); } });
  assert.deepEqual(record.stallRemedy, { nudges: 2, recycles: 1 });
  assert.equal(record.declarations?.partial?.count, 1);
  assert.deepEqual(record.watchRetired, ['cmd:npm ci']);
  // …and only a person's press clears them.
  record.status = 'failed';
  resetForRetry(record, { by: 'operator', journal: (event) => { lines.push(event); } });
  assert.equal(record.stallRemedy, undefined);
  assert.equal(record.declarations, undefined);
  assert.equal(record.watchRetired, undefined);
  assert.deepEqual(lines, [], 'nothing declared, nothing spent, nothing journalled');
});

test('WAI-8: a blocked / needs-human clock a month out is CAPPED at seven days, and says so', () => {
  const monthOut = new Date(NOW + 30 * 24 * 3_600_000).toISOString();
  const clock = declaredClock(monthOut, { now: NOW });
  assert.ok(clock);
  assert.equal(clock.requested, monthOut);
  assert.equal(clock.until, new Date(NOW + DECLARED_CLOCK_MAX_MS).toISOString());
  assert.equal(clock.capped, true);
  assert.equal(DECLARED_CLOCK_MAX_MS, 7 * 24 * 3_600_000);
  // Inside the ceiling: granted as asked, `capped: false`.
  const tomorrow = new Date(NOW + 24 * 3_600_000).toISOString();
  assert.deepEqual(declaredClock(tomorrow, { now: NOW }), { until: tomorrow, requested: tomorrow, capped: false });
  // A moment already past is floored, exactly as `parkWaiting` floors — and that is not a cap.
  const past = new Date(NOW - 3_600_000).toISOString();
  assert.deepEqual(declaredClock(past, { now: NOW, floorMs: 60_000 }), { until: new Date(NOW + 60_000).toISOString(), requested: past, capped: false });
  assert.equal(declaredClock(undefined), null);
  assert.equal(declaredClock('not a date'), null);
});

/* ------------------------------------------------------------------ *
 * SLF-8 — minted refs never run by default; retirement outlives the process
 * ------------------------------------------------------------------ */

test('SLF-8: a cmd: ref the console MINTED is never run by default — one `unknown` row, no clock, never asked; the pref turns it on', async () => {
  const clock = new FakeClock();
  const mint = (enabled: boolean) => {
    const state = waitingRun(['cmd:"pgrep -f build"']);
    // The watchdog's park marks what it lifted out of the tool summary.
    state.phases[1].declared!.minted = ['cmd:"pgrep -f build"'];
    state.phases[1].declared!.by = 'watchdog';
    const asked: string[] = [];
    const journal: string[] = [];
    const scheduler = new WatchScheduler({
      clock,
      runs: () => [{ slug: 'alpha', state }],
      journal: (_s, _st, kind) => { journal.push(kind); },
      probe: async (t) => { asked.push(t.ref); return { ref: t.ref, state: 'pending', detail: 'exit 1' }; },
      mintedCmdRefsEnabled: () => enabled,
    });
    return { state, scheduler, asked, journal };
  };

  const held = mint(false);
  held.scheduler.open();
  for (let i = 0; i < 4; i += 1) {
    await held.scheduler.tick();
    clock.time += WATCH_POLL_MS.cmd;
  }
  assert.deepEqual(held.asked, [], 'the probe never receives a minted cmd ref');
  const row = held.state.phases[1].watchState!.refs[0];
  assert.equal(row.state, 'unknown', 'unknown, not refused — the console did not ask');
  assert.equal(row.minted, true);
  assert.match(row.detail!, /console-minted cmd ref — not run/);
  assert.equal(row.nextDueAt, undefined, 'no clock: nothing will advance it, and the fingerprint must not churn');
  assert.equal(row.runs, undefined, 'nothing ran, nothing charged');
  assert.deepEqual(held.journal, ['phase.watch-checked'], 'said once');
  assert.equal(held.state.phases[1].watchRetired, undefined, 'not RETIRED either: turn the pref on and it runs');
  held.scheduler.close();

  // With the operator's yes, a minted ref runs exactly as a declared one.
  const allowed = mint(true);
  allowed.scheduler.open();
  await allowed.scheduler.tick();
  assert.deepEqual(allowed.asked, ['cmd:"pgrep -f build"']);
  assert.equal(allowed.state.phases[1].watchState!.refs[0].runs, 1);
  allowed.scheduler.close();
});

test('SLF-8: retirement lives on the record — a re-loaded run, a new scheduler, and the refused ref is still not asked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-retired-'));
  try {
    const clock = new FakeClock();
    const state = newRun({ slug: 'alpha', root, model: 'opus' });
    state.status = 'parked';
    const record = phaseRecord(state, 1);
    record.status = 'waiting';
    record.parkedUntil = new Date(NOW + 3_600_000).toISOString();
    record.declared = { status: 'waiting-external', reason: 'the build', watch: ['cmd:"rm -rf dist"'], at: new Date(NOW).toISOString() };
    let asks = 0;
    const first = new WatchScheduler({
      clock, runs: () => [{ slug: 'alpha', state }],
      probe: async (t) => { asks += 1; return { ref: t.ref, state: 'refused', detail: 'a destructive verb' }; },
    });
    first.open();
    await first.tick();
    first.close();
    assert.equal(asks, 1);
    assert.deepEqual(record.watchRetired, ['cmd:"rm -rf dist"']);
    saveRun(state);

    // A RESTART: a fresh scheduler with a blank in-memory refusal set, over the
    // run read back from disk, after the session re-declared the same ref.
    const back = loadRun(root, 'alpha', state.id)!;
    clearWatchBookkeeping(back.phases[1]);
    back.phases[1].declared = { status: 'waiting-external', reason: 'again', watch: ['cmd:"rm -rf dist"'], at: new Date(NOW).toISOString() };
    const journal: string[] = [];
    const second = new WatchScheduler({
      clock, runs: () => [{ slug: 'alpha', state: back }],
      journal: (_s, _st, kind) => { journal.push(kind); },
      probe: async (t) => { asks += 1; return { ref: t.ref, state: 'refused', detail: 'a destructive verb' }; },
    });
    second.open();
    clock.time += WATCH_POLL_MS.cmd;
    await second.tick();
    second.close();
    assert.equal(asks, 1, 'not asked again after the restart — the retirement is on disk, not in a Set');
    assert.deepEqual(journal, [], 'and not journalled again either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
