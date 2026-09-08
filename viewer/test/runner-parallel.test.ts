/**
 * Lanes: does one run genuinely drive several phases at once, and does it
 * refuse to when their scopes overlap?
 *
 * The hard part of testing concurrency is that "it looked concurrent" is not
 * evidence — two sessions that happened to be quick can finish in the order a
 * serial loop would have produced. So the fake session **blocks on a barrier
 * that only opens once N sessions are inside it**. Genuine overlap is the only
 * way the barrier opens; a serial loop deadlocks against it and falls out on a
 * timeout with a peak of one. The assertion is therefore about something that
 * cannot happen by luck.
 *
 * Same stub-repo shape as `runner.test.ts` — real shell scripts, a real board
 * driven by a `done` file, only the `claude` child faked — but with a board
 * where several phases are ready at once, which is what lanes are for.
 */

import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-lanes-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';

const { Runner: RunnerBase } = await import('../server/runner/runner.ts');
const { Scheduler: SchedulerBase } = await import('../server/runner/scheduler.ts');

/* ------------------------------------------------------------------ *
 * Teardown that a failing assertion cannot skip
 * ------------------------------------------------------------------ *
 * Every test here ended with `scheduler.close(); r.cleanup();` as the last
 * statements of its body, so a throw ANYWHERE above them skipped both and
 * leaked a Scheduler, a Runner and a temp repo per failure — up to 20 stub
 * repos under $TMPDIR on a bad run.
 *
 * It does NOT leak the event loop: every timer in both classes is `unref`'d
 * (`runner.ts` arms the liveness ticker, the git probe and each lane's lease
 * keepalive with `.unref?.()`; `scheduler.ts` does the same for its throttle,
 * lock, schedule and idle timers), which was measured here — the file with a
 * deliberate mid-test failure and no teardown still exits on its own in 12s.
 * So the "unclosed scheduler hangs the suite" reading in the phase 3 handoff
 * is not the mechanism; the suite's real hazard is oversubscription, and the
 * cure measured for that is the `--test-concurrency` cap in package.json.
 *
 * The two classes are subclassed rather than tracked at each call site
 * because twelve `new Scheduler(...)`/`new Runner(...)` calls live outside
 * the `runnerOn` helper. Registering in the constructor catches all of them
 * and changes no test's semantics: both `close()` methods are idempotent by
 * contract, and the explicit calls that already exist stay as no-ops.
 *
 * `close()` is deliberately NOT `stop()` — `close()` only releases timers,
 * while `stop()` ends the lanes and is what two tests assert on themselves.
 */
const liveRunners = new Set<InstanceType<typeof RunnerBase>>();
const liveSchedulers = new Set<InstanceType<typeof SchedulerBase>>();
const liveRepos: Repo[] = [];

class Runner extends RunnerBase {
  constructor(...args: ConstructorParameters<typeof RunnerBase>) {
    super(...args);
    liveRunners.add(this);
  }
}

class Scheduler extends SchedulerBase {
  constructor(...args: ConstructorParameters<typeof SchedulerBase>) {
    super(...args);
    liveSchedulers.add(this);
  }
}

afterEach(() => {
  // Schedulers first: closing one cancels queued grants the runner may still
  // be holding. Each guarded on its own so a throwing teardown can never mask
  // the assertion failure that is the real result of the test.
  for (const s of liveSchedulers) { try { s.close(); } catch { /* already closed */ } }
  liveSchedulers.clear();
  for (const r of liveRunners) { try { r.close(); } catch { /* already closed */ } }
  liveRunners.clear();
  for (const r of liveRepos) { try { r.cleanup(); } catch { /* already gone */ } }
  liveRepos.length = 0;
});

after(() => { rmSync(STATE_HOME, { recursive: true, force: true }); });
const { loadRun, journalFile } = await import('../server/runner/state.ts');
import type { SpawnFn, SpawnOutcome } from '../server/runner/spawn.ts';

const PHASES = [1, 2, 3];

type Repo = { root: string; scripts: string; state: string; doneList: () => number[]; cleanup: () => void };

/**
 * A repo whose board reports EVERY unfinished phase as ready at once.
 *
 * The linear stub in `runner.test.ts` is the right shape for testing the loop;
 * it is the wrong shape here, because a graph that only ever offers one
 * candidate cannot tell a lane table from a `while` loop.
 */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-lanes-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');

  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    d=""; r=""
    for p in ${PHASES.join(' ')}; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"; else r="$r$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);

  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
set -u
echo "$*" >> "${state}/locks"
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);

  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');

  const made: Repo = {
    root, scripts, state,
    doneList: () => readFileSync(join(state, 'done'), 'utf8').split('\n').filter(Boolean).map(Number),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  liveRepos.push(made);
  return made;
}

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0, turns: 1, resultText: 'done',
    durationMs: 1, argv: ['-p', '<prompt>'], ...partial,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * A fake session that will not finish until `want` of them are running.
 *
 * This is the whole method: overlap is not observed after the fact, it is
 * *required* for the test to make progress. A serial loop never opens the
 * barrier and every session leaves on the fallback timeout instead, recording
 * a peak of one.
 */
function barrierSpawn(r: Repo, want: number, fallbackMs = 750) {
  const gate = deferred<void>();
  const order: string[] = [];
  let live = 0;
  let peak = 0;

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    live += 1;
    peak = Math.max(peak, live);
    order.push(`start ${phase}`);
    if (live >= want) gate.resolve();
    await Promise.race([gate.promise, sleep(fallbackMs)]);
    live -= 1;
    order.push(`end ${phase}`);
    // What a real session does when it writes its handoff. APPEND, never
    // read-modify-write: two lanes finishing in the same millisecond both read
    // the old file and one overwrites the other, the board never sees a phase
    // that did complete, and the run halts on a failure the harness invented.
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  return { spawn, order, peak: () => peak, scopes: [] as string[] };
}

function runnerOn(
  r: Repo, spawn: SpawnFn, scope: (phase: number) => string[], maxParallel = 3,
): { instance: InstanceType<typeof Runner>; scheduler: InstanceType<typeof Scheduler> } {
  const scheduler = new Scheduler({ max: maxParallel, locks: () => [] });
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: (_slug, phase) => scope(phase),
  });
  return { instance, scheduler };
}

/* ------------------------------------------------------------------ *
 * Overlap
 * ------------------------------------------------------------------ */

test('two phases in different repos run at the same time, proven by a barrier only concurrency opens', async () => {
  const r = repo();
  // Three ready phases, three disjoint repos. Two have to be inside the
  // barrier together before either can leave it.
  const held = barrierSpawn(r, 2);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.ok(held.peak() >= 2, `expected overlapping sessions, peak was ${held.peak()}`);
  assert.deepEqual(r.doneList().sort(), PHASES, 'and all three phases still completed');
  scheduler.close();
  r.cleanup();
});

test('phases that share a repo serialise, however many lanes are allowed', async () => {
  const r = repo();
  // Same three ready phases, same three lanes — but one scope between them.
  const held = barrierSpawn(r, 2, 400);
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(held.peak(), 1, 'two agents in one working tree is the failure this prevents');
  // Every start is closed by its OWN end before the next start — which is what
  // serialisation means. Deliberately not asserted as `1,2,3`: the lanes are
  // created in one tick and each runs a `--gate-status` subprocess before it
  // reaches admission, so which of three racing subprocesses returns first is
  // genuinely undetermined. The queue is FIFO by arrival, and pinning an
  // arrival order would be pinning the scheduler of the operating system.
  assert.equal(held.order.length, 6);
  for (let i = 0; i < held.order.length; i += 2) {
    const phase = held.order[i].split(' ')[1];
    assert.equal(held.order[i], `start ${phase}`);
    assert.equal(held.order[i + 1], `end ${phase}`, `phase ${phase} was interleaved with another`);
  }
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

test('the lane cap holds even when every scope is disjoint', async () => {
  const r = repo();
  // Three disjoint phases but only two lanes: the third waits for a free one.
  const held = barrierSpawn(r, 3, 400);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`], 2);

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  assert.equal(held.peak(), 2, 'the cap is about the machine, not about the scopes');
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * What the checkpoint says while several lanes are open
 * ------------------------------------------------------------------ */

test('every live lane is in `children`, and `child` mirrors one of them', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const seen: { children: number; child: number | null }[] = [];

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    request.onPid?.(process.pid);
    live += 1;
    if (live >= 2) {
      // Both lanes are open: read the checkpoint from DISK, not from memory,
      // because a restarted console only ever gets the disk. The write sits on
      // the other side of an async boundary, so under a loaded suite the first
      // read can land before the second lane's persist — poll briefly rather
      // than race it (the property under test is "the disk says it", not
      // "the disk says it within one scheduler tick").
      for (let tries = 0; ; tries += 1) {
        const state = loadRun(r.root, 'demo', runId!, runId);
        const snap = {
          children: Object.keys(state?.children ?? {}).length,
          child: state?.child?.phase ?? null,
        };
        if ((snap.children >= 2 && snap.child !== null) || tries >= 24) { seen.push(snap); break; }
        await sleep(25);
      }
      gate.resolve();
    }
    // 3s, not 750ms: the fallback exists so a SERIAL loop fails fast, and under
    // a fully parallel suite the shorter window let a loaded box leave the
    // barrier before both lanes were inside.
    await Promise.race([gate.promise, sleep(3_000)]);
    live -= 1;
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const { instance, scheduler } = runnerOn(r, spawn, (phase) => [`repo-${phase}`]);
  const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  const runId: string | undefined = started.id;
  await instance.wait();

  assert.ok(seen.length, 'two lanes were never open at once');
  assert.ok(seen[0].children >= 2, `expected every lane in children, saw ${seen[0].children}`);
  assert.ok(seen[0].child !== null, 'the single-lane mirror must still be written — old consoles read it');

  // …and nothing is left claiming to be alive afterwards.
  const after = loadRun(r.root, 'demo', runId, runId);
  assert.equal(after?.child, null);
  assert.equal(after?.children, undefined);
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Stopping, with several lanes open
 * ------------------------------------------------------------------ */

test('a stop reaches every open lane, not just the one being mirrored', async () => {
  const r = repo();
  const started = deferred<void>();
  let live = 0;
  const aborted: number[] = [];

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    live += 1;
    if (live >= 2) started.resolve();
    // Ends only when the run's abort signal fires — so a lane the stop failed
    // to reach would hang this test rather than quietly passing it.
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) { resolve(); return; }
      request.signal?.addEventListener('abort', () => resolve(), { once: true });
      setTimeout(resolve, 5_000).unref?.();
    });
    aborted.push(phase);
    live -= 1;
    return ok({ signal: { subtype: 'error', code: 143, text: 'terminated' } });
  };

  const { instance, scheduler } = runnerOn(r, spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await started.promise;
  await instance.stop();

  assert.ok(aborted.length >= 2, `a stop must end every lane, ended ${aborted.length}`);
  assert.equal(instance.current()?.status, 'paused');
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * Admission against the world outside this console
 * ------------------------------------------------------------------ */

test("a stranger's live lock holds a phase back, and releasing it lets the phase through", async () => {
  const r = repo();
  let locks = [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['repo-1'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });

  const order: string[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    order.push(`start ${phase}`);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel: 3,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: (_slug, phase) => [`repo-${phase}`],
  });

  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  // Phases 2 and 3 are disjoint from the stranger and go straight through;
  // phase 1 shares `repo-1` with it and waits.
  await sleep(400);
  assert.ok(!order.includes('start 1'), `phase 1 must wait for the lock, order was ${order.join(', ')}`);
  assert.ok(order.includes('start 2'), 'and a disjoint phase must not be held up by it');

  locks = [];
  scheduler.poll();
  await instance.wait();

  assert.ok(order.includes('start 1'), 'and it runs once the lock is gone');
  assert.deepEqual(r.doneList().sort(), PHASES);
  scheduler.close();
  r.cleanup();
});

test('a phase blocked at admission reads `queued`, and says what it is waiting on', async () => {
  const r = repo();
  const locks = [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['all'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });

  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: async () => ok(),
    scheduler,
    maxParallel: 1,
    // A verification that passes. Without one, `confirm` halts every phase on
    // "the plan states no verification" — which halted the run after the first
    // lane and made a lane-cap test look like a lane-cap bug.
    verificationText: () => '`true`',
    phaseScope: () => ['repo-1'],
    onEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
  });

  const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await sleep(300);

  assert.equal(state.phases['1']?.status, 'queued', 'the phase says it is waiting');
  // Not in IN_FLIGHT on purpose: a queued run has done nothing, so a restart
  // may re-adopt it rather than reconciling it into `interrupted`.
  assert.equal(state.status, 'queued', 'and so does the run');

  const queued = events.find((e) => e.event === 'run:phase' && e.data.status === 'queued');
  assert.ok(queued, 'the console is told, rather than left watching a phase that never starts');
  const waitingOn = queued.data.waitingOn as { owner: string }[];
  assert.equal(waitingOn[0].owner, 'someone/else', 'and told WHO it is waiting on');

  await instance.stop();
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * A halt in one lane, honestly, while others are live
 * ------------------------------------------------------------------ */

test('a halt in one lane stops admitting, drains the rest, and reads halting on the way', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const seen: number[] = [];
  const midDrain: string[] = [];
  let instance!: InstanceType<typeof Runner>;

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) {
      // The liar: exits clean, writes nothing. confirm() halts the run while
      // phase 2 is still inside this function — the drain case.
      return ok({ sessionId: 'sess-liar' });
    }
    // Stay live until lane 1's halt lands, then record what the run claimed
    // while this lane was still running, then finish honestly.
    //
    // 🔴 POLLED, not a fixed 400ms. The claim is that a LIVE lane can see the
    // run read `halting` — never that the halt lands inside any particular
    // number of milliseconds. Under full-suite load 400ms was not enough and
    // this lane sampled `running`, failing an assertion about drain semantics
    // for a reason that had nothing to do with them. This lane is inside
    // `spawn`, so it is live for every one of these ticks.
    let claimed = instance.current()!.status;
    for (let tick = 0; tick < 100 && claimed !== 'halting'; tick++) {
      await sleep(20);
      claimed = instance.current()!.status;
    }
    midDrain.push(claimed);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const made = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  instance = made.instance;
  // `maxConsecutiveFailures: 1` since the halt-kind split: the liar's
  // `no-handoff` is a PHASE-level kind and settles only its own phase, so what
  // stops the run — the thing this test is about — is the failure STREAK, which
  // is run-level. One phase's failure no longer drains its siblings; a plan that
  // keeps failing still stops everything.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted', 'the final word, once nothing is running');
  assert.ok(state.halt, 'the halt survived the drain');
  assert.equal(state.halt?.kind, 'failure-streak', 'a RUN-level kind is what drains the lanes');
  assert.ok(midDrain.includes('halting'),
    `a live lane saw the run read 'halting', not 'running'-with-a-halt (saw: ${midDrain.join(', ')})`);
  assert.ok(!seen.includes(3), 'no new phase boarded after the halt');
  r.cleanup();
});

test('criterion 3: a phase-level ending settles ONE phase — the queued sibling boards, never phase.not-started', async () => {
  // The claim exit criterion 3 makes, asserted end to end rather than reasoned
  // from `boardingBlocked()`. ONE lane, so phase 2 is genuinely queued behind
  // phase 1's grant when phase 1 ends; phase 1 is the liar (exits clean, writes
  // no handoff), whose `no-handoff` is a PHASE-level kind.
  //
  // Before the halt-kind split this wrote `state.halt`, `boardingBlocked()`
  // answered `halted`, and the queued lane was written off with
  // `phase.not-started` "the run was stopped / halted while this phase waited
  // for its scope" — 125 of those in the corpus, later re-read as
  // `never-started` and answered by re-boarding a phase that never had a chance.
  const r = repo();
  const seen: number[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    if (phase === 1) return ok({ sessionId: 'sess-liar' });
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const events: { event: string; data: Record<string, unknown> }[] = [];
  const scheduler = new Scheduler({ max: 1, locks: () => [] });
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel: 1,
    verificationText: () => '`true`',
    phaseScope: (_slug, phase) => [`repo-${phase}`],
    onEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.phases['1'].halt?.kind, 'no-handoff', 'the ending is on the PHASE');
  // The two halves of the criterion, in order of what they cost when they fail.
  assert.ok(seen.includes(2), `the queued sibling boarded — spawned ${JSON.stringify(seen)}`);
  const notStarted = events.filter((e) => e.event === 'run:journal' && e.data.event === 'phase.not-started');
  assert.deepEqual(notStarted, [], 'and none was written off because another phase ended');
  // The phase's ending never became the RUN's. `state.halt` at the END of a run
  // is the loop's own end-of-plan summary ("nothing left to run on its own …"),
  // which is a different fact with no `kind` — what must never appear here is
  // the phase's own kind, because that is what `boardingBlocked()` reads while
  // the run is still driving.
  assert.notEqual(state.halt?.kind, 'no-handoff', 'a phase-level kind must not become the run-s halt');
  r.cleanup();
});

test('a lane sleeping on a retry backoff stands down when another lane halts', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const spawnsPerPhase = new Map<number, number>();

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    spawnsPerPhase.set(phase, (spawnsPerPhase.get(phase) ?? 0) + 1);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) return ok({ sessionId: 'sess-liar' }); // halts the run
    // Phase 2 reports a retryable failure: a 30-second backoff sleep begins —
    // which the halt must cut short, and which must NOT be followed by a
    // second attempt on a run that has stopped.
    await sleep(120);
    return ok({ signal: { subtype: 'crash', code: 137, text: '' }, sessionId: 'sess-2' });
  };

  const { instance } = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  // Run-level, deliberately: see the drain test above.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(spawnsPerPhase.get(2), 1, 'no attempt N+1 on a halted run');
  assert.equal(state.phases['2'].status, 'interrupted');
  assert.match(state.phases['2'].note ?? '', /waited to retry/);
  r.cleanup();
});

test('a lane sleeping on a usage window stands down when another lane halts', async () => {
  const r = repo();
  const gate = deferred<void>();
  let live = 0;
  const spawnsPerPhase = new Map<number, number>();

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    spawnsPerPhase.set(phase, (spawnsPerPhase.get(phase) ?? 0) + 1);
    live += 1;
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(750)]);
    if (phase === 1) return ok({ sessionId: 'sess-liar' }); // halts the run
    await sleep(120);
    // "usage limit reached" with no parseable reset → wait-until now+1h. The
    // halt wakes the sleeper; waking into a halted run must not spawn again.
    return ok({ signal: { subtype: 'limit', code: 1, text: 'usage limit reached' }, sessionId: 'sess-2' });
  };

  const { instance } = runnerOn(r, spawn, (phase) => [`repo-${phase}`], 2);
  // Run-level, deliberately: see the drain test above.
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', maxConsecutiveFailures: 1 });
  await instance.wait();

  const state = instance.current()!;
  assert.equal(state.status, 'halted');
  assert.equal(spawnsPerPhase.get(2), 1, 'no attempt N+1 on a halted run');
  assert.equal(state.phases['2'].status, 'interrupted');
  assert.match(state.phases['2'].note ?? '', /usage window/);
  assert.equal(state.waitUntil, null, 'the window sleep did not outlive the run');
  r.cleanup();
});

test('a pause armed while a phase waits for its scope abandons it back to pending', async () => {
  const r = repo();
  let locks: { slug: string; phase: number; owner: string; expired: boolean; scope: string[] }[] =
    [{ slug: 'other', phase: 9, owner: 'someone/else', expired: false, scope: ['blocked-repo'] }];
  const scheduler = new Scheduler({ max: 3, locks: () => locks });
  const seen: number[] = [];
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    seen.push(phase);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok();
  };
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, scheduler, maxParallel: 3,
    verificationText: () => '`true`',
    phaseScope: () => ['blocked-repo'],
  });
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onlyPhases: [1] });
  // 🔴 Waited on, not slept at. `await sleep(250)` was standing in for the
  // condition "phase 1 has reached `queued` behind the foreign lock", and under
  // full-suite load it has not; the assertion then reported the phase's status
  // as a scheduling bug. The claim is unchanged — it must reach `queued`, and a
  // phase that never does still fails here, after 5s and saying what it saw.
  let queued = instance.current()!.phases['1']?.status;
  for (let tick = 0; tick < 200 && queued !== 'queued'; tick++) {
    await sleep(25);
    queued = instance.current()!.phases['1']?.status;
  }
  assert.equal(queued, 'queued');
  assert.equal(instance.pause('test'), true);

  locks = [];        // the blocker releases…
  scheduler.poll();  // …and the scheduler notices — the grant arrives into an armed pause

  await instance.wait();
  const state = instance.current()!;
  assert.equal(state.status, 'paused');
  assert.deepEqual(seen, [], 'admission arrived into an armed pause — nothing spawned');
  assert.equal(state.phases['1'].status, 'pending', 'restored so the phase stays startable');
  r.cleanup();
});

test('a queued second lane does not repaint a run that is still driving its first', async () => {
  const r = repo();
  const gate = deferred<void>();
  let sampled: { run?: string; waiting?: string } = {};
  let driving: number | undefined;
  let instance!: InstanceType<typeof Runner>;
  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    // 🔴 Whichever lane boards FIRST is the one that drives, and the scheduler
    // does not promise that is phase 1. Pinning the sampler to phase 1 made
    // this test read the OTHER lane's status long after it had finished —
    // `'done' !== 'queued'`, seen at 4.5s under full-suite load, which is
    // phase 2's own 3s gate race plus the sampler that started after it. The
    // claims are unchanged; they were never about which number went first.
    // (This assignment is safe: nothing awaits between entry and here.)
    if (driving === undefined) driving = phase;
    if (phase === driving) {
      const other = String(driving === 1 ? 2 : 1);
      // Wait for the other lane to REACH admission rather than assuming a fixed
      // delay covers it — on a loaded runner 400ms was not enough and the
      // sample read a phase that had not queued yet. The claims under test are
      // unchanged: once the waiting lane has a recorded status it must be
      // `queued` (never a concurrent boarding into the same scope), and the RUN
      // must still say `running` while its first lane drives.
      for (let tick = 0; tick < 100 && !sampled.waiting; tick++) {
        await sleep(50);
        const state = instance.current()!;
        const status = state.phases[other]?.status;
        if (status) sampled = { run: state.status, waiting: status };
      }
      gate.resolve();
    }
    await Promise.race([gate.promise, sleep(3_000)]);
    appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };
  const made = runnerOn(r, spawn, () => ['shared-repo'], 2);
  instance = made.instance;
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await instance.wait();

  // Seen live: phase 4 driving with a real child while the RUN read `queued`,
  // because phases 5–6 sat behind its scope. The lane's own record is where
  // "queued" belongs; the run is running for as long as anything drives.
  assert.equal(sampled.run, 'running', "queued is the lane's word, not a driving run's");
  assert.equal(sampled.waiting, 'queued', 'the waiting lane itself says so');
  assert.equal(instance.current()!.status, 'finished');
  r.cleanup();
});

/* ---------------- per-lane freeze and stop, across lanes ---------------- */

/** What `ps` says about a process: `T` is stopped, `S`/`R` are running. */
function procState(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim().slice(0, 1);
  } catch { return ''; }
}

/**
 * Every lane gets a REAL sleeper child, so freeze/stop assertions are the
 * kernel's answer rather than ours. A lane's spawn resolves when the test
 * releases everyone — or when its child dies, which is exactly what a
 * SIGTERM'd session does.
 */
function sleeperLanes(r: Repo) {
  const pids = new Map<number, number>();
  const watchers: (() => void)[] = [];
  let released: () => void = () => {};
  const gate = new Promise<void>((resolve) => { released = resolve; });

  const spawn: SpawnFn = async (request) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)![1]);
    const child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    pids.set(phase, child.pid!);
    request.onPid?.(child.pid!);
    request.onEvent?.({ kind: 'init', sessionId: `sess-${phase}`, model: 'stub', tools: 0 });
    for (const notify of watchers) notify();
    const exited = new Promise<'died'>((resolve) => { child.on('exit', () => resolve('died')); });
    const wayOut = await Promise.race([gate.then(() => 'released' as const), exited]);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (wayOut === 'released') appendFileSync(join(r.state, 'done'), `${phase}\n`);
    return ok({ sessionId: `sess-${phase}` });
  };

  const lanesUp = (want: number) => (pids.size >= want
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      watchers.push(() => { if (pids.size >= want) resolve(); });
    }));

  return { spawn, pids, lanesUp, release: () => released() };
}

test('freeze with no phase freezes EVERY lane, and thaw with none frees them all', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test'), true);
  const frozen = instance.current()!;
  assert.equal(frozen.status, 'frozen', 'nothing is left running, so the run itself is frozen');
  for (const [phase, pid] of held.pids) {
    assert.equal(procState(pid), 'T', `phase ${phase}'s session is stopped`);
    assert.ok(frozen.children?.[String(phase)]?.frozen, `the checkpoint records phase ${phase}'s freeze`);
  }
  assert.ok(frozen.freeze, 'the single-slot mirror is set for pre-lanes readers');

  assert.equal(instance.thaw(), true);
  const thawed = instance.current()!;
  assert.equal(thawed.status, 'running');
  assert.equal(thawed.freeze, null);
  for (const [phase, pid] of held.pids) {
    assert.notEqual(procState(pid), 'T', `phase ${phase} is scheduled again`);
    assert.equal(thawed.children?.[String(phase)]?.frozen, undefined);
  }

  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});

test('freezing one lane of three leaves the run running, with the mirror on the frozen one', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test', 2), true);
  const state = instance.current()!;
  assert.equal(state.status, 'running', 'two sessions are still editing — the run has not stopped');
  assert.ok(state.children?.['2']?.frozen);
  assert.equal(state.freeze?.phase, 2, 'the single-slot mirror names the frozen lane');
  assert.equal(procState(held.pids.get(2)!), 'T');
  assert.notEqual(procState(held.pids.get(1)!), 'T');
  assert.notEqual(procState(held.pids.get(3)!), 'T');

  assert.equal(instance.thaw(2), true);
  assert.equal(instance.current()!.status, 'running');
  assert.equal(instance.current()!.freeze, null);

  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});

test('stopping one lane records interrupted, spares the streak, and the rest carries on', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.deepEqual(instance.stopPhase(2, 'tester'), { ok: true });
  // The child got SIGCONT+SIGTERM; its death resolves the spawn, and the
  // consumption settles the record without touching the failure budget.
  await sleep(400);
  const mid = instance.current()!;
  assert.equal(mid.phases['2'].status, 'interrupted');
  assert.match(mid.phases['2'].note ?? '', /stopped by tester/);
  assert.match(mid.phases['2'].note ?? '', /carries on/);
  assert.equal(mid.consecutiveFailures, 0, 'an operator stop is not a failure');
  assert.equal(mid.status, 'running', 'the run did not stop with the lane');

  held.release();
  await instance.wait();
  const after = instance.current()!;
  assert.deepEqual(r.doneList().sort(), [1, 3], 'the other lanes finished their phases');
  assert.equal(after.phases['2'].status, 'interrupted');
  // Phase 2 never wrote a handoff, so the board still offers it; a settled
  // record is not a candidate, and the run parks naming what is left.
  assert.equal(after.status, 'parked');
  scheduler.close();
  r.cleanup();
});

test('a queued phase can be taken out of the line, and never spawns on arrival', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  // One scope between three phases: one runs, the others queue behind it.
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(1);
  await sleep(200);

  const queued = Object.values(instance.current()!.phases)
    .filter((p) => p.status === 'queued')
    .map((p) => p.phase)
    .sort();
  assert.ok(queued.length >= 1, `something queues behind the scope (saw ${JSON.stringify(queued)})`);
  const target = queued[0];

  assert.deepEqual(instance.stopPhase(target, 'tester'), { ok: true });
  assert.equal(instance.current()!.phases[String(target)].status, 'interrupted');

  held.release();
  await instance.wait();
  assert.ok(!held.pids.has(target), 'the dequeued phase never spawned a session');
  assert.equal(instance.current()!.phases[String(target)].status, 'interrupted');
  scheduler.close();
  r.cleanup();
});

test('a phase skipped while queued does not spawn when its admission arrives', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, () => ['one-repo']);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(1);
  await sleep(200);

  const queued = Object.values(instance.current()!.phases)
    .filter((p) => p.status === 'queued')
    .map((p) => p.phase)
    .sort();
  assert.ok(queued.length >= 1);
  const target = queued[0];
  instance.skip(target);
  assert.equal(instance.current()!.phases[String(target)].status, 'skipped');

  held.release();
  await instance.wait();
  assert.ok(!held.pids.has(target),
    'a settled record is abandoned on arrival — the latent spawn was the bug');
  assert.equal(instance.current()!.phases[String(target)].status, 'skipped');
  scheduler.close();
  r.cleanup();
});

test('two frozen lanes escalate independently — one checkpoints, the others stay frozen', async () => {
  const r = repo();
  const held = sleeperLanes(r);
  const { instance, scheduler } = runnerOn(r, held.spawn, (phase) => [`repo-${phase}`]);
  await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
  await held.lanesUp(3);

  assert.equal(instance.freeze('test'), true);
  const internals = instance as unknown as {
    lanes: Map<number, unknown>;
    escalateFreeze(lane?: unknown): void;
  };
  // The timer names its lane in production; driven directly here, because a
  // test that waits fifteen real minutes is a test nobody runs.
  internals.escalateFreeze(internals.lanes.get(1));

  const state = instance.current()!;
  assert.equal(state.phases['1'].status, 'pending');
  assert.equal(state.phases['1'].resumeSessionId, 'sess-1', 'Continue resumes the checkpointed session');
  assert.notEqual(state.status, 'paused', 'other sessions are live — the run must not read as stopped');
  assert.ok(state.children?.['2']?.frozen, 'the other freezes survive the escalation');
  assert.equal(state.freeze?.phase, 2, 'the mirror moved to the next frozen lane');
  assert.equal(procState(held.pids.get(2)!), 'T');

  assert.equal(instance.thaw(), true, 'thaw-all frees what is still frozen');
  held.release();
  await instance.wait();
  scheduler.close();
  r.cleanup();
});

/* ------------------------------------------------------------------ *
 * P8 — the branch carve-out, end to end
 *
 * Everything above is about ONE run's lanes. This is the other axis, and the
 * one the whole plan exists for: two SEPARATE runs whose scopes name the same
 * repository, each with a console-managed checkout of its own.
 *
 * Before P8 that pair serialised. Scope answers "which repository", and a
 * repository was as fine as admission got — so a console could hand two runs
 * two trees and then let only one of them work at a time. P7 gave a claim a
 * BRANCH; this proves the scheduler acts on it, through the real chain
 * (`isolation` → `state.workRoot` → `branchFor` → `AdmitRequest.branch` →
 * `conflictsFor`) rather than by handing the scheduler a branch by hand.
 *
 * The barrier is the method, exactly as above: overlap is REQUIRED for the
 * test to finish, so it cannot pass by luck.
 * ------------------------------------------------------------------ */

/** `git`, throwing on failure — a broken FIXTURE must not read as a finding. */
function git(cwd: string, ...args: string[]): string {
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'p8', GIT_AUTHOR_EMAIL: 'p8@example.invalid',
      GIT_COMMITTER_NAME: 'p8', GIT_COMMITTER_EMAIL: 'p8@example.invalid',
    },
  })).trim();
}

/**
 * A stub repo that a worktree can actually be taken from, for plan `slug`.
 *
 * `checkAvailable` refuses anything that is not a git repository BY NAME and
 * degrades silently to the shared root, so a fixture that skipped the init
 * would assert against the shared-checkout path and pass for the wrong reason.
 */
function isolatedRepo(slug: string): Repo {
  const r = repo();
  writeFileSync(join(r.root, 'docs', 'plans', `${slug}.md`), `# ${slug}\n`);
  // 🔴 The scope token these tests claim (`hub`) must be a PATH under the root,
  // as every real plan's Repos token is. Since console-parallel-repaint P1
  // (W5) a claim is qualified only for a scope the root CONTAINS
  // (`scopeConfined` — `all`, the root's basename, or an existing path);
  // an abstract token made every claim here unqualified, the two isolated
  // runs collided, and the barrier that "only concurrency opens" never did.
  mkdirSync(join(r.root, 'hub'), { recursive: true });
  writeFileSync(join(r.root, 'hub', '.keep'), '');
  git(r.root, 'init', '-q', '-b', 'main');
  git(r.root, 'add', '-A');
  git(r.root, 'commit', '-q', '-m', 'base');
  return r;
}

test('P8: two isolated runs naming ONE repo drive together, proven by a barrier only concurrency opens', async () => {
  const a = isolatedRepo('alpha');
  const b = isolatedRepo('beta');
  // ONE scheduler — the fleet — and ONE scope token between the two runs. As
  // far as admission is concerned this is a single repository with two runs
  // asking for it, which is the pair that used to serialise.
  const scheduler = new Scheduler({ max: 4, locks: () => [] });

  const gate = deferred<void>();
  let live = 0;
  let peak = 0;
  const spawn = (r: Repo): SpawnFn => async (request) => {
    live += 1;
    peak = Math.max(peak, live);
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(1500)]);
    live -= 1;
    appendFileSync(join(r.state, 'done'), '1\n');
    return ok({ sessionId: 'sess-1' });
  };

  const runnerFor = (r: Repo): InstanceType<typeof Runner> => new Runner({
    scriptsDir: r.scripts,
    spawn: spawn(r),
    scheduler,
    maxParallel: 4,
    verificationText: () => '`true`',
    phaseScope: () => ['hub'],
  });

  const ra = runnerFor(a);
  const rb = runnerFor(b);
  const isolated = { onlyPhases: [1], gitMode: 'new-branch', isolation: 'worktree' } as const;
  try {
    await Promise.all([
      ra.start({ slug: 'alpha', root: a.root, autonomy: 'keep-going', ...isolated }),
      rb.start({ slug: 'beta', root: b.root, autonomy: 'keep-going', ...isolated }),
    ]);
    await Promise.all([ra.wait(), rb.wait()]);

    // Both really got a checkout — otherwise the branches are undefined, every
    // claim is unqualified, and a green peak below would mean nothing at all.
    for (const [name, instance] of [['alpha', ra], ['beta', rb]] as const) {
      const state = instance.current()!;
      assert.equal(state.checkout, 'worktree', `${name} took no checkout — this proves nothing`);
      assert.ok(state.workRoot, `${name} has no work root`);
      assert.equal(git(state.workRoot!, 'rev-parse', '--abbrev-ref', 'HEAD'), `pe/${name}`);
    }

    assert.ok(peak >= 2, `expected two isolated runs to overlap, peak was ${peak}`);
  } finally {
    scheduler.close();
    a.cleanup();
    b.cleanup();
  }
});

test('P8: the SAME two runs without a checkout of their own still serialise', async () => {
  // The control, and the more important half: the carve-out must not have
  // widened admission for the ordinary run. No isolation ⇒ no branch ⇒ an
  // unqualified claim ⇒ one session in the shared tree at a time, exactly as
  // before P8. A barrier that needs two is never opened, so both sessions
  // leave on the fallback and the peak is one.
  const a = isolatedRepo('alpha');
  const b = isolatedRepo('beta');
  const scheduler = new Scheduler({ max: 4, locks: () => [] });

  let live = 0;
  let peak = 0;
  const gate = deferred<void>();
  const spawn = (r: Repo): SpawnFn => async () => {
    live += 1;
    peak = Math.max(peak, live);
    if (live >= 2) gate.resolve();
    await Promise.race([gate.promise, sleep(400)]);
    live -= 1;
    appendFileSync(join(r.state, 'done'), '1\n');
    return ok({ sessionId: 'sess-1' });
  };
  const runnerFor = (r: Repo): InstanceType<typeof Runner> => new Runner({
    scriptsDir: r.scripts,
    spawn: spawn(r),
    scheduler,
    maxParallel: 4,
    verificationText: () => '`true`',
    phaseScope: () => ['hub'],
  });

  const ra = runnerFor(a);
  const rb = runnerFor(b);
  try {
    await Promise.all([
      ra.start({ slug: 'alpha', root: a.root, autonomy: 'keep-going', onlyPhases: [1] }),
      rb.start({ slug: 'beta', root: b.root, autonomy: 'keep-going', onlyPhases: [1] }),
    ]);
    await Promise.all([ra.wait(), rb.wait()]);
    assert.equal(ra.current()!.workRoot, undefined, 'the control must NOT have a checkout of its own');
    assert.equal(rb.current()!.workRoot, undefined, 'nor the other one');
    assert.equal(peak, 1, 'two agents in one working tree is the failure the guard prevents');
  } finally {
    scheduler.close();
    a.cleanup();
    b.cleanup();
  }
});

test('P8/QA F-2: an admission claims the RUN branch, never a lane`s — admission precedes the lane', async () => {
  // The ordering fact three documents got wrong, pinned so it cannot drift
  // again: `drivePhase` admits, THEN `lanes.set`, then `acquireWorktree`. So
  // `branchFor`'s lane arm cannot fire at admission and every request presents
  // the RUN branch `pe/<slug>` — which is why two LANES of one run are not
  // carved apart from each other and still rely on disjoint scopes.
  //
  // Since the tree dimension joined the claim, a new-branch run states its
  // branch at admission whether or not it holds a checkout — a lane's
  // `pe/<slug>-pN` appearing here would still be the drift under test.
  const r = isolatedRepo('gamma');
  const seen: (string | undefined)[] = [];
  const cwds: (string | undefined)[] = [];
  const scheduler = new Scheduler({ max: 4, locks: () => [] });
  // Wrap the scheduler rather than the runner: this is the only place the
  // request is visible, and reading it through a spy is the one way to assert
  // about a value that is never persisted anywhere.
  const spy = new Proxy(scheduler, {
    get(target, prop, receiver) {
      if (prop === 'admit') {
        return (request: { branch?: string }) => {
          seen.push(request.branch);
          return target.admit(request as Parameters<typeof target.admit>[0]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: async (request) => {
      cwds.push(request.cwd);
      appendFileSync(join(r.state, 'done'), '1\n');
      return ok();
    },
    scheduler: spy,
    maxParallel: 4,
    verificationText: () => '`true`',
    phaseScope: () => ['hub'],
    // 🔴 Worktree LANES opted in, or this proves nothing: without the plan
    // directive `checkAvailable` refuses `not-opted-in`, no lane ever gets a
    // branch, and `['pe/gamma']` holds for a reason that has nothing to do with
    // the ordering under test.
    planWorktrees: () => 'on',
  });
  try {
    // A worktree-LANE run (not a run-level isolated one — a run with its own
    // checkout deliberately has no lanes, so there would be no lane branch to
    // leak and the assertion would hold for the wrong reason).
    await instance.start({
      slug: 'gamma', root: r.root, autonomy: 'keep-going',
      onlyPhases: [1], gitMode: 'new-branch',
    });
    await instance.wait();

    // The lane really got a checkout on its own branch — that is the value
    // which must NOT appear in the admission below. Asserted from git rather
    // than from the record, the way `git-strategy.test.ts` does it.
    const laneDir = cwds[0];
    assert.ok(laneDir && laneDir !== r.root, `no lane worktree was taken: ${laneDir}`);
    assert.equal(git(laneDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pe/gamma-p1');
    assert.ok(seen.length, 'nothing was admitted — this proves nothing');
    assert.deepEqual([...new Set(seen)], ['pe/gamma'],
      'admission ran before the lane existed, so it claimed the RUN branch — '
      + 'a `pe/gamma-p1` here would be the drift three documents described');
  } finally {
    scheduler.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * P9 — the branch probe, through the runner rather than beside it.
 *
 * `worktree.test.ts` proves the probe's arithmetic against real git.
 * What that cannot prove is the property the JOURNAL depends on: a
 * verdict that has not moved is written once and never again. A
 * five-minute ticker over three pairs would otherwise add a line every
 * five minutes for as long as a run lives, and the one line that was
 * news would be buried in a thousand that were not.
 * ------------------------------------------------------------------ */

test('P9: an isolated run probes its branch, and a verdict that has not moved journals ONCE', async () => {
  const r = isolatedRepo('probe');
  const scheduler = new Scheduler({ max: 2, locks: () => [] });
  const events: string[] = [];
  const runner = new Runner({
    scriptsDir: r.scripts,
    // The session leaves one uncommitted file behind, which is not decoration:
    // a CLEAN settle removes the run's checkout and deletes `workRoot`, and
    // every probe below would then be a no-op returning `false` — the exact
    // shape that makes a suppression test pass by having nothing to suppress.
    // A dirty tree is the one `pruneRun` refuses to delete, so the run finishes
    // still holding the thing this test is about.
    spawn: async (request) => {
      writeFileSync(join(request.cwd, 'left-behind.txt'), 'a session was here\n');
      appendFileSync(join(r.state, 'done'), '1\n2\n3\n');
      return ok({ sessionId: 's' });
    },
    scheduler,
    maxParallel: 1,
    verificationText: () => '`true`',
    phaseScope: () => ['hub'],
    onEvent: (event) => { events.push(event); },
  });

  try {
    await runner.start({
      slug: 'probe', root: r.root, autonomy: 'keep-going',
      onlyPhases: [1], gitMode: 'new-branch', isolation: 'worktree',
    });
    await runner.wait();

    const state = runner.current()!;
    // Without a real checkout there is no branch, every probe is a no-op, and
    // everything below would pass by being vacuous.
    assert.equal(state.checkout, 'worktree', 'the run took no checkout — this proves nothing');
    // 🔴 And `workRoot`, not `checkout` alone. `checkout` is the run's HISTORY
    // and stays `worktree` after a settle removed the tree; `workRoot` is the
    // directory, and `refreshGit` returns false without one. Asserting only the
    // word would let every probe below be a silent no-op — which is what the
    // first version of this test did, and it passed.
    assert.ok(state.workRoot, 'the checkout was swept — every probe below would be a no-op');

    // 🔴 The suppression, measured at the file. Once the run has stopped
    // moving, two more probes of a repository nobody has touched must add
    // NOTHING, and `refreshGit` must say so by returning false.
    const journal = journalFile(r.root, 'probe', state.id);
    const radarLines = (): number => readFileSync(journal, 'utf8')
      .split('\n').filter((line) => line.includes('run.git-radar')).length;
    const emitted = (): number => events.filter((event) => event === 'run:git').length;

    // 🔴 Quiesce FIRST. The settle fires its probe with `void` — deliberately,
    // so the loop never waits on git to admit the next phase — which means an
    // in-flight probe can land AFTER `wait()` resolves and emit into the tally
    // this test is about. Asserting straight after `wait()` is asserting on a
    // race (the same shape `pruneWorktrees` taught P6). Polled rather than
    // slept-on a fixed ceiling: a loaded machine is slow, not broken.
    for (let quiet = 0, i = 0; quiet < 3 && i < 100; i += 1) {
      const n = emitted();
      await sleep(50);
      quiet = emitted() === n ? quiet + 1 : 0;
    }
    // A view exists without anyone asking for one: each settle probes, so the
    // answer is on the run by the time it stops rather than five minutes later.
    const first = runner.gitSnapshot();
    assert.ok(first, 'the run finished with no git view at all');
    assert.equal(first.branch, 'pe/probe');
    assert.ok(first.checkouts.some((entry) => entry.branch === 'pe/probe' && entry.managed),
      `the run's own checkout is missing from ${JSON.stringify(first.checkouts)}`);

    const settled = radarLines();
    const before = emitted();
    assert.equal(await runner.refreshGit(), false, 'an unchanged repository reported news');
    assert.equal(await runner.refreshGit(), false);
    assert.equal(radarLines(), settled, 'a standing verdict was re-journalled');
    assert.equal(emitted(), before, 'an unchanged probe emitted on the wire');

    // …and it is not simply mute: a new branch with a live checkout is a new
    // pair, so the next probe is news, journals exactly one line, and emits
    // exactly one event. Without this half, deleting the journal call
    // altogether would leave every assertion above green.
    // A fresh directory per run: a fixed path under `tmpdir()` survives a
    // failed run and makes the NEXT one fail on `already exists`, which reads
    // as a finding about the probe and is not one.
    const other = join(mkdtempSync(join(tmpdir(), 'pc-rival-')), 'wt');
    git(r.root, 'worktree', 'add', '-q', '-b', 'pe/rival', other, 'main');
    assert.equal(await runner.refreshGit(), true, 'a new live branch was not news');
    // TWO new pairs, not one — `pe/rival` joins the radar against `pe/probe`
    // AND against the base — and each is journalled exactly once. Counting the
    // pair by name rather than the lines by number is what makes this an
    // assertion about the rule instead of about the fixture's arithmetic.
    const pairs = (name: string): number => readFileSync(journal, 'utf8')
      .split('\n').filter((line) => line.includes('run.git-radar') && line.includes(name)).length;
    assert.equal(pairs('pe/probe × pe/rival'), 1, 'the new pair journalled once, or not at all');
    assert.equal(pairs('main × pe/rival'), 1);
    assert.equal(radarLines(), settled + 2);
    assert.equal(emitted(), before + 1, 'news is ONE event however many pairs moved');

    // Twice in a row, again: the new verdicts are now the standing ones.
    assert.equal(await runner.refreshGit(), false);
    assert.equal(radarLines(), settled + 2);
    assert.equal(pairs('pe/probe × pe/rival'), 1);
  } finally {
    scheduler.close();
    r.cleanup();
  }
});
