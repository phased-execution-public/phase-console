/**
 * A phase is "Running" because a process is, not because a file says so.
 *
 * B2, the operator-reported class. Three defects, one sentence between them:
 * **the board's word is a claim, and nothing in the console settled it against
 * a fact.**
 *
 *  (a) `phase_status()` greps `^status:` out of a handoff's frontmatter,
 *      `BOARD_STATE_UI` maps `in-progress` to `running`, and five surfaces
 *      paint it. A phase of one plan on this estate showed "Running" for 18
 *      DAYS with no run, no lock and no process. Nothing anywhere could tell
 *      the difference, because nothing anywhere held the other half of the
 *      sentence: `PhaseView.live`.
 *  (b) Continue asked `isLiveStatus(run.status)` — another word the same dead
 *      writer left behind — so a run whose session was still editing the tree
 *      offered the button, and the server's own guard read only this process's
 *      memory.
 *  (c) A phase that IS running had nowhere to send you.
 *
 * And under all three, one probe bug: every "is a lane still in flight" filter
 * asked `processState(...) !== 'gone'`, which is a question about EXISTENCE. A
 * `Z` process very much exists — it has exited, closed its files, and is
 * waiting only to be reaped. Counting it as work in flight is how a claim
 * outlives its fact.
 *
 * These tests pin the fixes as CONTRACTS, in the order the facts flow:
 * the probe, the records it settles, the resolver that reads them, and the
 * link the answer earns.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PHASE_IN_FLIGHT, newRun, phaseRecord, reconcileRun, settleInFlightRecords,
  type RunState,
} from '../server/runner/state.ts';
import { setPsReader, forgetPid, pidAlive, pidHoldsWork, type ProcessState } from '../server/pid.ts';
import { phaseLive } from '../server/service-core.ts';
import { laneHref, phaseSessionHref, sessionsHref } from '../shared/routes.js';

/* ------------------------------------------------------------------ *
 * Probe harness — the same one `invariants.test.ts` uses, and for the
 * same reason: `processState` asks `kill(pid, 0)` BEFORE it consults the
 * `setPsReader` seam, so a stub written for a pid nobody has never
 * reaches the reader. Use this process's own pid.
 * ------------------------------------------------------------------ */

const DEAD_PID = 0x7ffffffe;
const PROC_STARTED_AT = '2026-08-22T17:30:07.000Z';
const PS_LSTART = new Date(PROC_STARTED_AT).toString();

function withProbe(answer: ProcessState): { pid: number; restore: () => void } {
  if (answer === 'gone') {
    const previous = setPsReader(null);
    return { pid: DEAD_PID, restore: () => { setPsReader(previous); forgetPid(); } };
  }
  const stat = answer === 'stopped' ? 'T' : answer === 'zombie' ? 'Z' : 'S';
  const previous = setPsReader(() => ({ stat, comm: 'claude', lstart: PS_LSTART }));
  return { pid: process.pid, restore: () => { setPsReader(previous); forgetPid(); } };
}

/** A run holding one lane on phase 9, mid-flight, exactly as a console leaves one. */
function runWithChild(pid: number, status: RunState['status'] = 'running'): RunState {
  const state = newRun({ slug: 'demo', root: '/nowhere', model: 'opus' });
  state.status = status;
  state.children = {
    9: { pid, phase: 9, sessionId: 'sess-9', startedAt: '2026-08-22T11:12:14Z', procStartedAt: PROC_STARTED_AT },
  };
  const record = phaseRecord(state, 9);
  record.status = 'running';
  // The record's own session, not only the ChildRef's: `settleInFlightRecords`
  // copies this into `resumeSessionId`, which is the difference between
  // offering to CONTINUE the phase and offering only to start it over.
  record.sessionId = 'sess-9';
  return state;
}

/* ================================================================== *
 * The probe — existence and work are different questions
 * ================================================================== */

test('`pidHoldsWork` splits the zombie off from `pidAlive`, and keeps `stopped` with it', () => {
  // The whole correction. `pidAlive` answers "is there a process" — a zombie
  // is one, and its reaping is still somebody's job, so `signals.ts` and
  // `pid.ts` must keep asking that. `pidHoldsWork` answers "could this still
  // be editing the tree", and only two states can.
  const expected: Record<ProcessState, { alive: boolean; holdsWork: boolean }> = {
    running: { alive: true, holdsWork: true },
    // Not scheduled, but it still holds its files, its cwd and its session id,
    // and one `kill -CONT` puts it back to work. Settling its record would
    // contradict the advice the console prints on the same screen.
    stopped: { alive: true, holdsWork: true },
    // Exited. Nothing it holds can change again.
    zombie: { alive: true, holdsWork: false },
    gone: { alive: false, holdsWork: false },
  };
  for (const [answer, want] of Object.entries(expected) as [ProcessState, { alive: boolean; holdsWork: boolean }][]) {
    const probe = withProbe(answer);
    try {
      assert.equal(pidAlive(probe.pid), want.alive, `${answer}: pidAlive`);
      assert.equal(pidHoldsWork(probe.pid), want.holdsWork, `${answer}: pidHoldsWork`);
    } finally {
      probe.restore();
    }
  }
});

/* ================================================================== *
 * The records it settles
 * ================================================================== */

test('a phase record over a ZOMBIE child is settled; over a STOPPED one it is left alone', () => {
  // `settleInFlightRecords` used to test `!== 'gone'`, so a reaped-but-unwaited
  // child kept a phase reading `running` with nothing behind it — a claim
  // outliving its fact, on the read path, for every reader.
  const dead = withProbe('zombie');
  try {
    const state = runWithChild(dead.pid);
    assert.deepEqual(settleInFlightRecords(state), [9], 'a zombie holds no work');
    assert.equal(phaseRecord(state, 9).status, 'interrupted');
    // Interrupted, never failed: the phase may be twenty minutes from done and
    // the session id is what makes Continue possible rather than a restart.
    assert.equal(phaseRecord(state, 9).resumeSessionId, 'sess-9');
  } finally {
    dead.restore();
  }

  const frozen = withProbe('stopped');
  try {
    const state = runWithChild(frozen.pid);
    assert.deepEqual(settleInFlightRecords(state), [], 'a stopped child is still there');
    assert.equal(phaseRecord(state, 9).status, 'running');
  } finally {
    frozen.restore();
  }
});

test("reconcile does not park a run over a child that has already exited", () => {
  // The orphan branch parks and tells the operator a session is "still editing
  // the tree, unobserved", printing a pid to look at. Over a zombie that pid
  // closed its files before we looked, and the run was held for a person who
  // had nothing to do.
  const dead = withProbe('zombie');
  try {
    const state = runWithChild(dead.pid);
    reconcileRun(state);
    assert.notEqual(state.halt?.kind, 'orphaned-session', 'an exited child is not an orphan');
    assert.notEqual(state.status, 'parked');
  } finally {
    dead.restore();
  }

  // And the case the branch exists for still parks — a SIGSTOPped orphan is
  // the frozen half of `orphanAdvice`, and nothing will schedule it again.
  const frozen = withProbe('stopped');
  try {
    const state = runWithChild(frozen.pid);
    reconcileRun(state);
    assert.equal(state.status, 'parked');
    assert.equal(state.halt?.kind, 'orphaned-session');
    assert.equal(state.stoppedBy, 'system');
  } finally {
    frozen.restore();
  }
});

/* ================================================================== *
 * The resolver — three witnesses, in falling authority
 * ================================================================== */

test('`phaseLive` prefers a probed process, then a vouched lock, then the registry', () => {
  const RUN = { inFlight: true, session: 'from-run', pid: 4242 };
  const LOCK = { expired: false, presence: 'live' as const, session: 'from-lock' };
  const REG = { session: 'from-registry', presence: 'live' as const };

  // All three agree something is live; the strongest answers, because a
  // process is a fact and the other two are reports about one.
  assert.deepEqual(phaseLive({ run: RUN, lock: LOCK, registry: REG }),
    { via: 'run', actor: 'autopilot', session: 'from-run', pid: 4242 });
  assert.deepEqual(phaseLive({ run: { inFlight: false }, lock: LOCK, registry: REG }),
    { via: 'lock', actor: 'external', session: 'from-lock' });
  // The case the third witness exists for: a console that restarted with an
  // empty `children` map settles a record whose session is still working.
  assert.deepEqual(phaseLive({ run: { inFlight: false }, lock: null, registry: REG }),
    { via: 'registry', actor: 'external', session: 'from-registry' });
});

test('`phaseLive` names the VEHICLE, not just the witness', () => {
  // `via` says who SAW it; `actor` says what it IS. A run record is always an
  // autopilot lane. For the other two witnesses, the console's own pty list
  // outranks the registry's kind — a pty minted before PE_OWNER was set still
  // registers as foreign — and both `foreign` and never-heard-of fold to
  // `external`, because "not one of ours" is the honest reading of both.
  const LIVE = { expired: false, presence: 'live' as const };

  // The console's own pty wins whatever the registry thinks.
  assert.equal(phaseLive({
    lock: { ...LIVE, session: 's1', kind: 'foreign' },
    ptySessions: new Set(['s1']),
  })?.actor, 'agent');

  // The registry's kind speaks when the pty list does not claim the session.
  assert.equal(phaseLive({
    registry: { session: 's2', presence: 'live', kind: 'autopilot' },
  })?.actor, 'autopilot', "another console's lane is still an autopilot");
  assert.equal(phaseLive({
    registry: { session: 's3', presence: 'live', kind: 'agent' },
  })?.actor, 'agent');
  assert.equal(phaseLive({
    registry: { session: 's4', presence: 'live', kind: 'foreign' },
  })?.actor, 'external');

  // A session nobody has a record for is outside every console.
  assert.equal(phaseLive({ lock: { ...LIVE, session: 's5' } })?.actor, 'external');
});

test('`phaseLive` answers UNDEFINED for every shape that is only a claim', () => {
  // Absence is the answer, never `{live: false}` — so "no server sent it" and
  // "nothing is running" read alike to a surface deciding whether to pulse.
  const cases: Record<string, Parameters<typeof phaseLive>[0]> = {
    'nothing at all': {},
    'a settled record': { run: { inFlight: false, session: 's' } },
    // An unexpired lock the registry cannot vouch for is a CLAIM. What it is
    // for is the scheduler's queue, not a pulsing chip — `presence === 'live'`
    // and deliberately not `!== 'ended'`.
    'a lock nobody can vouch for': { lock: { expired: false, presence: 'unknown', session: 's' } },
    'a lock whose session ended': { lock: { expired: false, presence: 'ended', session: 's' } },
    'an EXPIRED lock, however live its session': { lock: { expired: true, presence: 'live', session: 's' } },
    'a registry record that ended': { registry: { session: 's', presence: 'ended' } },
    'a registry record nobody can vouch for': { registry: { session: 's', presence: 'unknown' } },
  };
  for (const [name, facts] of Object.entries(cases)) {
    assert.equal(phaseLive(facts), undefined, name);
  }
});

test('`phaseLive` omits what a witness does not know rather than inventing it', () => {
  // A lock knows a session and never a pid; the registry knows only a session.
  // Absent keys, not empty strings — the client tests `Boolean(live)` for the
  // pulse and `live.session` for the link.
  assert.deepEqual(phaseLive({ run: { inFlight: true } }), { via: 'run', actor: 'autopilot' });
  assert.deepEqual(phaseLive({ lock: { expired: false, presence: 'live' } }), { via: 'lock', actor: 'external' });
});

test("the run witness is the SETTLED record's own status, so the probe decides it", () => {
  // The join between the two halves above: `detail()` computes `inFlight` as
  // `PHASE_IN_FLIGHT.includes(record.status)` on a `listRuns` read, which has
  // already run `settle`. So a zombie's phase reads `interrupted` there and
  // `phaseLive` answers undefined without ever probing again — one probe, one
  // answer, and no second opinion to disagree with.
  const dead = withProbe('zombie');
  try {
    const state = runWithChild(dead.pid);
    settleInFlightRecords(state);
    const inFlight = PHASE_IN_FLIGHT.includes(phaseRecord(state, 9).status);
    assert.equal(inFlight, false);
    assert.equal(phaseLive({ run: { inFlight, session: 'sess-9' } }), undefined);
  } finally {
    dead.restore();
  }
});

/* ================================================================== *
 * (c) The link the answer earns
 * ================================================================== */

test('a phase with nothing live gets NO link — that is the whole contract', () => {
  // A link to a session that ended is the same lie as a pulsing chip, one step
  // quieter. `null` is what the caller checks before wrapping a chip in an
  // anchor at all.
  assert.equal(phaseSessionHref({ slug: 'demo', phase: 7, live: null }), null);
  assert.equal(phaseSessionHref({ slug: 'demo', phase: 7 }), null);
  assert.equal(phaseSessionHref({ slug: 'demo', phase: 7, live: {} as never }), null);
});

test('a live phase links to its lane, and to its pty session when it has one', () => {
  const live = { via: 'run', session: 'sess-9' };
  // An autopilot lane is a TAB on the run page, not a pty: `#/sessions/<id>`
  // would resolve against the terminal registry alone and render "gone".
  assert.equal(phaseSessionHref({ slug: 'demo', phase: 9, live }), '#/plan/demo/run?lane=p9');
  assert.equal(laneHref('demo', 9), '#/plan/demo/run?lane=p9');
  // `pty` is a fact the caller supplies — `qa-launcher` is the shipped
  // precedent — and it is the only thing that changes the destination.
  assert.equal(phaseSessionHref({ slug: 'demo', phase: 9, live, pty: true }), '#/sessions/sess-9');
  // ...but a pty with no session id has nothing to point at, so it falls back
  // rather than building `#/sessions/undefined`.
  assert.equal(
    phaseSessionHref({ slug: 'demo', phase: 9, live: { via: 'lock' }, pty: true }),
    '#/plan/demo/run?lane=p9',
  );
});

test('every href this builds is encoded, and `sessionsHref` has ONE definition', () => {
  assert.equal(laneHref('a/b', 3), '#/plan/a%2Fb/run?lane=p3');
  assert.equal(sessionsHref('a b'), '#/sessions/a%20b');
  assert.equal(sessionsHref(), '#/sessions');
  // It moved out of `client/src/app/routes.ts` into the one file that spells a
  // route; the client re-exports it, so two spellings cannot drift.
  assert.equal(
    readClientRoutes().match(/export const sessionsHref/)?.length ?? 0,
    0,
    'sessionsHref must be re-exported from shared/routes.js, never redefined',
  );
});

function readClientRoutes(): string {
  return readFileSync(new URL('../client/src/app/routes.ts', import.meta.url), 'utf8');
}

/* ================================================================== *
 * (b) Admission — the two doors a second session used to walk through
 * ================================================================== */

const { SKILL_DIR } = await import('../server/config.ts');
const { Service, PhaseClaimedError } = await import('../server/service.ts');
const { saveRun } = await import('../server/runner/state.ts');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const PLAN = `---
slug: alpha
created: 2026-08-23
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function planRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-b2-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha', '.locks'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function svcAt(root: string) {
  const service = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  service.push.announce = (() => {}) as typeof service.push.announce;
  assert.equal(service.open(root).ok, true);
  return service;
}

/** A lock on disk, as `phase-lock.sh claim` writes one. */
function writeLock(
  root: string, phase: number,
  { owner = 'someone@elsewhere', session = '', leaseSeconds = 1800 } = {},
): void {
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', '.locks', `phase-0${phase}.lock`),
    [
      'slug=alpha', `phase=${phase}`, `owner=${owner}`, 'host=Mac',
      `claimed_at=${now}`, `lease_until=${now + leaseSeconds}`, 'scope=app',
      ...(session ? [`session=${session}`] : []),
    ].join('\n') + '\n',
    'utf8',
  );
}

test('a named-phase start refuses a claim nobody can vouch AGAINST, and ignores real debris', async () => {
  const root = planRoot();
  const service = svcAt(root);
  try {
    // A session the registry has never heard of is `unknown` — nobody can say
    // it ended, so the claim stands and the start refuses. This is the rule
    // the fix preserves; what changed is WHICH presence answer is asked for.
    writeLock(root, 2, { session: 'a-session-nobody-knows' });
    await assert.rejects(
      () => service.startRun('alpha', { onlyPhases: [2] }),
      (error: unknown) => error instanceof PhaseClaimedError,
      'an unexpired claim with unvouched presence is a holder',
    );

    // An EXPIRED lease is not a holder — nobody is working a phase whose claim
    // lapsed, and treating debris as an owner is the bug this rail was built
    // around. Asserted through `claimPreflight`, which is the SAME predicate
    // (`claimHolders`) the refusal uses, and deliberately not through a second
    // `startRun`: a start that is not refused starts a run, and a test that
    // spawns `claude` is not a test.
    writeLock(root, 2, { session: 'a-session-nobody-knows', leaseSeconds: -60 });
    assert.deepEqual(service.claimPreflight('alpha'), [],
      'a lapsed lease must not read as a claim');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('THE FINDING: the admission check asks `lockPresenceFor`, not the raw registry', () => {
  // `assertNotClaimed` was the last direct caller of `sessions.presenceOfLock`,
  // and the one that could not afford it. Our own lane holds its phase lock for
  // the WHOLE phase — boarding, session, verification, closeout — while the
  // attempt's `claude` process exits well before the end of that. So the raw
  // answer was `ended` for a lock our own run was actively holding, the
  // `!== 'ended'` test went false, nothing threw, and a retry boarded a second
  // session onto a phase this console was still verifying. `lockPresenceFor`
  // carves our own live runs out and answers `unknown`, which refuses.
  //
  // Pinned at the source because the behaviour needs a live runner holding a
  // real lease, and a test that fakes one would be asserting the fake.
  const source = readFileSync(new URL('../server/service-runs.ts', import.meta.url), 'utf8');
  const body = /private claimHolders\([\s\S]*?\n  \}/.exec(source)?.[0] ?? '';
  assert.ok(body, 'claimHolders must exist — it is the one predicate behind both doors');
  assert.match(body, /this\.lockPresenceFor\(lock\)/,
    'the claim check must ask the presence that carves out our own live runs');
  assert.doesNotMatch(body, /presenceOfLock/,
    'the raw registry answer reports our own verifying lane as `ended` — that is the double-spawn');
  // And `retryPhase` must keep asking BEFORE its live-runner branch, which is
  // the path the incident actually took.
  const retry = /async retryPhase\([\s\S]*?const runner = this\.liveRunner\(slug\)/.exec(source)?.[0] ?? '';
  assert.match(retry, /this\.assertNotClaimed\(slug, \[phase\]\)/,
    'a retry must test the claim before it queues work on a live loop');
});

test('a WHOLE-PLAN start reports a claimed phase instead of refusing the run', () => {
  // B2(b) asks that whole-plan Continue stop skipping the lock check. It does
  // NOT ask that one live claim refuse fourteen other phases — a foreign
  // unexpired lock QUEUES, never terminally parks, and the scheduler owns that
  // wait. So the answer is the third thing: say it, on the start response,
  // at the moment the button is pressed rather than an hour later.
  const root = planRoot();
  const service = svcAt(root);
  try {
    writeLock(root, 2, { owner: 'someone@elsewhere', session: 'unknown-to-us' });
    const whole = service.claimPreflight('alpha');
    assert.equal(whole.length, 1);
    assert.match(whole[0]!, /phase 2 is claimed by someone@elsewhere/);
    assert.match(whole[0]!, /queue behind that lock/);
    // A named-phase start refuses instead, so it has nothing to advise about.
    assert.deepEqual(service.claimPreflight('alpha', [2]), []);
    assert.deepEqual(service.claimPreflight('alpha', [1]), []);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a start is refused over a live child this console is not driving', async () => {
  // The guard read `this.runners` — memory — so a second console, or this one
  // after a restart against a session that outlived it, walked straight past
  // it and created a second run over a live `claude`. The button answered 200
  // and two agents wrote one working tree.
  const root = planRoot();
  const service = svcAt(root);
  const alive = withProbe('running');
  try {
    const run = newRun({ slug: 'alpha', root });
    run.status = 'running';
    run.children = {
      2: { pid: alive.pid, phase: 2, sessionId: 'sess-2', startedAt: '2026-08-23T10:00:00Z', procStartedAt: PROC_STARTED_AT },
    };
    phaseRecord(run, 2).status = 'running';
    saveRun(run);

    await assert.rejects(
      () => service.startRun('alpha', {}),
      /still being worked by a live session/,
      'a live child of a run we cannot see must refuse a second run',
    );
  } finally {
    alive.restore();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('...and a start is NOT refused once that child has exited', () => {
  // The other direction, and why `pidHoldsWork` matters here too: a zombie
  // child holds nothing, so refusing over one would strand the plan behind a
  // process that had already finished.
  //
  // Asserted on the PREDICATE and not through `startRun`, for the reason the
  // first test gives: a start that is not refused starts a run.
  const root = planRoot();
  const service = svcAt(root);
  /** Write a run whose phase-2 lane is in the given process state, then ask. */
  const probe = (which: 'zombie' | 'running') => {
    const p = withProbe(which);
    try {
      const run = newRun({ slug: 'alpha', root });
      run.status = 'running';
      run.children = {
        2: { pid: p.pid, phase: 2, sessionId: 'sess-2', startedAt: '2026-08-23T10:00:00Z', procStartedAt: PROC_STARTED_AT },
      };
      phaseRecord(run, 2).status = 'running';
      saveRun(run);
      const answer = (service as unknown as { foreignRunHoldingWork: (s: string) => unknown })
        .foreignRunHoldingWork('alpha');
      return { answer, runId: run.id };
    } finally {
      p.restore();
    }
  };
  try {
    assert.equal(probe('zombie').answer, null, 'an exited child must not hold the plan');
    // ...and the guard still fires for a child that IS working — with the
    // zombie's run still on disk beside it, so this also pins that the scan
    // answers for the run that holds work rather than the newest one.
    const working = probe('running');
    assert.deepEqual(working.answer, { runId: working.runId, phase: 2, pid: process.pid });
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
