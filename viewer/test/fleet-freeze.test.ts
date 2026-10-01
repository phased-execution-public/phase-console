/**
 * Fleet freeze: one switch, everything holds, exact resume.
 *
 * The operator's report was not "the freeze button is broken". It was **"it
 * said frozen and kept working"** — a console that stopped the thing you were
 * looking at and started something else behind it. That failure has one shape:
 * a mechanism that can begin work and does not ask the predicate. There are
 * twenty-four such mechanisms today, and the number only ever goes up — the
 * first draft of this file counted eighteen and QA found a whole CLASS it had
 * missed, the runner's own extra sessions.
 *
 * So the centrepiece of this file is not a behaviour, it is a **registry**.
 * `MECHANISMS` names every auto-start the console has, says where its gate
 * lives, and carries a token that proves the gate is in that file. The count is
 * pinned, and three censuses below pin the other direction — every `startRun`
 * site, every bare `claude` the runner spawns, and a sweep proving no OTHER
 * file in `server/` spawns one at all. A twenty-fifth mechanism cannot be added
 * without failing this file, which is the only property that survives the next
 * six months of features. It is the same philosophy as the vocabulary scans
 * (`vocab-owners.test.ts`) — declare it, or the suite goes red.
 *
 * Around the registry sit the behaviours a registry cannot express: that a
 * held entry never ages, that a recovery is NOT exempt, that the operator's own
 * press still works, and that a marker nobody can parse means *not frozen*.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions, and
// this file writes a freeze marker into it.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { Scheduler, AGING_MS } = await import('../server/runner/scheduler.ts');
const { ConvergeScheduler, CHANGE_DEBOUNCE_MS } = await import('../server/converge.ts');
const { freezeVerdict } = await import('../server/runner/freeze.ts');
const {
  readFleetHold, writeFleetHold, clearFleetHold, FLEET_FREEZE_FILE,
} = await import('../server/fleet-hold.ts');
// Every top-level await sits here, above the first test: one between two
// tests lets `--test-force-exit` see an empty queue while the module is still
// loading, and cancel the tests registered after it (RR-1, under a name filter).
const { FLEET_HOLDER, fleetFreezeReason, fleetHoldSentence, heldStopReason, SHUTDOWN_CONTINUES } = await import('../shared/orchestration-model.js');

type ConvergeTrigger = import('../server/converge.ts').ConvergeTrigger;
type ConvergeReport = import('../server/converge.ts').ConvergeReport;

const VIEWER = new URL('..', import.meta.url).pathname;
const source = (rel: string): string => readFileSync(join(VIEWER, rel), 'utf8');

/* ================================================================== *
 * A. The auto-start inventory
 * ================================================================== */

/**
 * Every mechanism in this console that can begin or resume work without a
 * person asking, and where its fleet-freeze gate lives.
 *
 * `guard` is a string that must appear in `where`. It is deliberately a token
 * from the gate's OWN body — a journal event name, a call — rather than the
 * word `fleetHold`, because several files call the predicate for other reasons
 * and a test that matched the predicate would go green on the wrong line.
 *
 * `exempt: true` marks the one row that must NOT be blocked. The operator's
 * press is not an auto-start; a console that silently refused it would be
 * lying to the person holding it.
 */
const MECHANISMS: {
  id: string;
  what: string;
  where: string;
  guard: string;
  exempt?: true;
}[] = [
  {
    id: 'converge:boot',
    what: 'the convergence pass every open plan gets at startup',
    where: 'server/converge.ts',
    guard: "log.info('converge.frozen'",
  },
  {
    id: 'converge:change',
    what: "the docs watcher's debounced pass when a handoff lands",
    where: 'server/converge.ts',
    guard: "trigger !== 'button'",
  },
  {
    id: 'converge:timer',
    what: 'the periodic sweep over every plan',
    where: 'server/converge.ts',
    guard: 'this.deps.fleetHold?.()',
  },
  {
    id: 'converge:halt',
    what: "the quiet minute after a run breaks, then a healer pass",
    where: 'server/converge.ts',
    guard: 'converge.frozen',
  },
  {
    id: 'converge:button',
    what: "the operator's own Recover & continue press",
    where: 'server/converge.ts',
    // The EXEMPTION is the assertion here: the gate must be conditional on the
    // trigger, not unconditional.
    guard: "if (trigger !== 'button')",
    exempt: true,
  },
  {
    id: 'runner:park-poke',
    what: "the timer that wakes a run's drive loop when an external wait elapses",
    where: 'server/runner/runner.ts',
    guard: "log.info('runner.park-poke-frozen'",
  },
  {
    id: 'service:limit-resume',
    what: 'the clock that resumes a run parked on a usage window or an external wait',
    where: 'server/service-base.ts',
    guard: "log.info('run.limit-resume-frozen'",
  },
  {
    id: 'service:boot-readopt',
    what: 'the boot pass that picks up queued runs and re-arms every persisted clock',
    where: 'server/service-base.ts',
    guard: "log.info('run.readopt-frozen'",
  },
  {
    id: 'service:mcp-require-timeout',
    what: 'the clock that continues a phase parked on an unreachable MCP server',
    where: 'server/service.ts',
    guard: "log.info('mcp.require-timeout-frozen'",
  },
  {
    id: 'service:auto-recover',
    what: "the healer's relaunch of a halted run",
    where: 'server/service-base.ts',
    // Gated UPSTREAM: `scheduleAutoRecover` does not spawn, it asks the
    // convergence loop, whose `fire` is where the freeze is read. The token
    // pins that the route really is the loop and not a direct start.
    guard: "this.converger.request(slug, 'halt', delayMs)",
  },
  {
    id: 'service:recovery-continue',
    what: 'a recovery session that fixed something, continuing the run by itself',
    where: 'server/service-recovery.ts',
    guard: "log.info('run.recovery-continue-frozen'",
  },
  {
    id: 'service:recovery-outcome-continue',
    what: 'the same continue, on the outcome path a manual Fix-with-AI takes',
    where: 'server/service-base.ts',
    guard: "log.info('run.recovery-continue-frozen'",
  },
  {
    id: 'service:unsupervised-outcome',
    what: "re-boarding a phase whose own session declared `partial` from outside this console",
    where: 'server/service-runs.ts',
    guard: "log.info('outcome-inbox.board-frozen'",
  },
  {
    id: 'scheduler:poll',
    what: 'the admission scan — the one door every lane passes through',
    where: 'server/runner/scheduler.ts',
    // Per entry since control-tower phase 48 (#70): a restart waiting for its
    // lanes binds only the plans whose scope meets theirs.
    guard: 'const fleet = this.fleetHolderOf(hold, entry.slug);',
  },
  {
    id: 'scheduler:would-block',
    what: 'the probe that tells the runner whether an admission is free',
    where: 'server/runner/scheduler.ts',
    guard: 'const fleet = this.fleetHolder(request.slug);\n    if (fleet) return [fleet];',
  },
  {
    id: 'scheduler:release',
    what: 'a grant handed back, which re-scans the queue',
    where: 'server/runner/scheduler.ts',
    // `release` calls `poll`, which is where the gate is. Pinned so that a
    // future `release` that admitted directly would have to declare itself.
    guard: 'release(grant: ScopeGrant | null | undefined): void {',
  },
  {
    id: 'scheduler:idle-poll',
    what: 'the quiet re-check, so nothing waits on an event that never comes',
    where: 'server/runner/scheduler.ts',
    guard: 'IDLE_POLL_MS',
  },
  {
    id: 'scheduler:throttle-timer',
    what: 'the timer that re-scans when a usage window reopens',
    where: 'server/runner/scheduler.ts',
    guard: 'armThrottleTimer',
  },
  // ── the extra sessions ─────────────────────────────────────────────────
  // Three `claude` sessions the runner spawns from INSIDE its own loop, none of
  // which passes through `admit()` — so the scheduler's fleet holder can never
  // see them, and the `startRun` census below cannot either. QA found this
  // class; it is the exact failure the operator reported, and it is why the
  // census now has a second half.
  //
  // What makes them worse than a phase: the phase's own lane has already
  // resolved by the time these run and its pid is nulled, so a Freeze-all
  // landing in that window marked the lane frozen and started a fresh session
  // anyway.
  {
    id: 'runner:auto-review',
    what: 'the reviewer session `reviewEachPhase` spawns over a finished phase',
    where: 'server/runner/runner-loop.ts',
    guard: "reason: `the console is frozen${frozen.by ? ` by ${frozen.by}` : ''} — no session is started under a freeze`,",
  },
  {
    id: 'runner:closeout',
    what: "the closeout session that resumes a phase's own session to finish its paperwork",
    where: 'server/runner/runner-attempt.ts',
    guard: "this.record('phase.closeout-frozen'",
  },
  {
    // Landed with 3.2.0's warm QA verdict, met the freeze for the first time in
    // 3.3.0's merge, and had no gate: the session is spawned from inside the
    // lane, so neither `startRun` nor `Scheduler.admit` is above it. The census
    // below is what found it.
    id: 'runner:qa-verdict',
    what: "the owed QA verdict, chased warm on the phase's own session at finish",
    where: 'server/runner/runner-attempt.ts',
    guard: 'so no verdict session was started',
  },
  {
    id: 'runner:pr-session',
    what: "the pull-request session the last done phase inherits when a run finishes",
    where: 'server/runner/runner-loop.ts',
    guard: "this.record('run.pr-session-skipped'",
  },
  {
    id: 'runner:recovery-session',
    what: "the recovery session `recover()` resumes to fix a halted phase",
    where: 'server/runner/runner-control.ts',
    // Gated UPSTREAM, at the convergence loop — its only automatic caller is
    // `maybeAutoRecover`. The token pins that the spawn still lives inside
    // `resumeWithInstruction` and has not grown a second, ungated entry point.
    // `protected` since phase 8: the landing's rebase session (below) is a
    // second CALLER of the same one spawn, not a second entry point.
    guard: 'protected async resumeWithInstruction(',
  },
  {
    id: 'service:recovery-agent-rung',
    what: "the healer's AGENT rung — a `claude` minted through the terminal broker",
    where: 'server/service-recovery.ts',
    // A THIRD spawn shape, found in QA round 2: not `startRun`, not
    // `spawnClaude`, but `terminals.mint({kind: 'claude'})`. Gated upstream at
    // the convergence loop, like the rest of `maybeAutoRecover`. The token pins
    // the mint stays inside that method.
    guard: "{ kind: 'claude', intent: 'recovery'",
  },
  {
    id: 'runner:silent-watchdog',
    what: 'the silent-session watchdog that nudges, then recycles, a lane that says nothing',
    where: 'server/runner/runner.ts',
    // Phase 20. It does not spawn — it WRITES to a live session and then kills
    // one — and under a fleet freeze both are the harm the freeze exists to
    // prevent: a SIGSTOPped child is silent by construction, so an ungated
    // watchdog would read every frozen lane as wedged and recycle the operator's
    // own pause. The row pins the gate; `behaviour:` below pins that it works.
    guard: "log.info('runner.silent-watchdog-frozen'",
  },
  {
    id: 'service:freeze-escalation',
    what: "the boot clock that converts a lapsed lane freeze into a checkpoint",
    where: 'server/service.ts',
    // Not an auto-START — it ENDS a session — but it is a timer that acts on a
    // frozen child, and under a fleet freeze acting on one is exactly the harm
    // the freeze exists to prevent. Fire-time gated, timer deliberately left
    // armed so the thaw restores it with no rewind.
    guard: "log.info('run.freeze-escalate-frozen'",
  },
];

/**
 * The pin.
 *
 * A twenty-sixth auto-start mechanism must add its row here, which means
 * someone has to decide where its freeze gate lives.
 *
 * It read 18 when this file shipped. Two QA rounds raised it to 24 by finding the class
 * the first count missed entirely — the runner's three EXTRA sessions, which
 * spawn from inside the loop and pass through neither `startRun` nor `admit()`.
 * Phase 20 made it 25 with the silent-session watchdog, the first row that is
 * not a spawn at all: it writes to a live session and then kills one.
 * That is the useful lesson about this number: it is not a tally of what was
 * thought of, it is what forces the next person to think.
 *
 * **And a row is not a proof.** This registry pins each gate's TEXT, which
 * catches a gate that was deleted and not one that never worked: a QA round on
 * Phase 16 switched FOUR gates off at once, left every `guard` token in place,
 * and the whole suite came back byte-identical to its baseline. Every row here
 * wants a behavioural test beside it — see `watchdog: a frozen lane is never
 * nudged…` below, which is the one for the row Phase 20 added.
 */
// 26 in both trees, plus the rows that ride a Pro region above — one, the
// landing session — read as the marked list's length, so the number is true
// in the free tree too (where that row is absent by marker).
const PRO_MECHANISMS: string[] = [];
const AUTO_START_MECHANISM_COUNT = 26 + PRO_MECHANISMS.length;

test('inventory: every auto-start mechanism is declared, and the count cannot silently move', () => {
  assert.equal(
    MECHANISMS.length,
    AUTO_START_MECHANISM_COUNT,
    'a mechanism was added or removed without updating AUTO_START_MECHANISM_COUNT — '
    + 'if you added one, say where its fleet-freeze gate is',
  );
  const ids = MECHANISMS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'two rows share an id');
});

for (const mechanism of MECHANISMS) {
  test(`inventory: ${mechanism.id} — ${mechanism.what}`, () => {
    const text = source(mechanism.where);
    assert.ok(
      text.includes(mechanism.guard),
      `${mechanism.where} no longer contains the gate this row names:\n  ${mechanism.guard}\n`
      + 'Either the gate moved (update the row) or it was removed (put it back).',
    );
  });
}

/**
 * The other direction: nothing may begin work from a site nobody counted.
 *
 * TWO censuses, because there are two ways this console starts a session and
 * the first version of this test only knew about one:
 *
 *  - **`this.startRun(`** — a whole RUN. Every one of these ends in a phase
 *    that passes through `Scheduler.admit`, where the fleet holder lives.
 *  - **`spawn({`/`spawnClaude(`** — a bare `claude` process spawned from inside
 *    the runner's own loop. These pass through NEITHER `startRun` nor
 *    `admit()`, so no gate above them can see them. QA found three, and the
 *    census missed the whole class because it grepped only the first pattern.
 *
 * Pinned per file rather than in total, so the failure message names where to
 * look. A new site is not a bug — `retryPhase` and `recoverPlan` are here and
 * are operator doors. What is a bug is a new site nobody ruled on.
 */
const START_SITES: { file: string; count: number; note: string }[] = [
  {
    file: 'server/service-base.ts',
    count: 4,
    note: 'recovery-outcome continue · boot re-adoption · limit resume · the overdue-wait ruling '
      + '(`resumeOverdueWait`, zero-touch-console phase 5) — all four gated in place; the last two read '
      + 'the same `run.limit-resume-frozen` hold',
  },
  {
    file: 'server/service-runs.ts',
    count: 10,
    note: 'retryPhase (an operator door that nonetheless QUEUES — it funnels into a phase, and '
      + "every phase goes through admit()) · recoverPlan (goes through: its halt path uses the "
      + "EXEMPT `button` trigger — and refuses 409 first under a hold that binds the plan, #93) · "
      + "convergeDeps' healer vehicle (gated at the loop) · "
      + 'unsupervised outcome re-boarding (gated in place) · a person\'s fresh resume '
      + '(`reboardForPerson`, control-tower phase 53 — an operator door that queues as retryPhase '
      + 'does: its reboard boards through admit()) · the continue a press queued behind the loop '
      + '(`continueAfterPress` — gated in place on `fleetHoldFor`) · Resume lifting a settled pause '
      + '(`resumeRun`, control-tower phase 77 — an operator door, refused 409 under a hold that binds '
      + 'the plan since phase 81, #93, rather than a 200 queued behind it) · a person\'s answer to an '
      + 'identity park (`answerIdentity`, control-tower phase 91 — an operator door, refused 409 under a '
      + 'hold that binds the plan, as Resume is) · a person\'s repair of a refused checkout '
      + '(`repairCheckout`, control-tower phase 90 — an operator door, refused 409 under a hold that '
      + 'binds the plan, as Resume is) · a person\'s raise of a spent run budget (`raiseBudget`, '
      + 'control-tower phase 14 — an operator door: the raise is a person\'s Continue, started under '
      + '`pressActor`, and a phase-scoped raise goes through `pressRetry` instead)',
  },
  {
    file: 'server/service-recovery.ts',
    count: 5,
    note: "maybeAutoRecover's three relaunch vehicles — the reboard, and since phase 10 the "
      + 'switch-account and raise-budget rungs, each a stopped-run relaunch inside the same '
      + "healer (gated at the loop; the operator's press is deliberate) · "
      + 'recovery-continue (gated in place) · watch-landed continue (gated in place: '
      + '`resumeOnWatchLanded` checks fleetHold before the resume and again before the continue)',
  },
  {
    file: 'server/service.ts',
    count: 1,
    note: 'continueMcpParkedPhase — the clock is gated at fire, the button is an operator door',
  },
];

/**
 * The runner's own spawns. `deps.spawn ?? spawnClaude` is the shape every one
 * of them takes, so counting that phrase counts them exactly.
 */
/**
 * The loop's Pro spawn sites, as a marked list whose `.length` the count below
 * reads — so the census is true in both trees (three here, two in the free
 * tree, where the landing engine and its session are absent by path).
 */
const PRO_LOOP_SPAWNS: string[] = [];

const RUNNER_SPAWN_SITES: { file: string; count: number; note: string }[] = [
  {
    file: 'server/runner/runner-loop.ts',
    count: 2 + PRO_LOOP_SPAWNS.length,
    note: `autoReview · openPrFromLastLeaf${PRO_LOOP_SPAWNS.map((s) => ` · ${s}`).join('')} — all gated in place with \`fleetFrozen()\``,
  },
  {
    file: 'server/runner/runner-attempt.ts',
    count: 3,
    note: "closeout (gated in place) · the owed QA verdict, chased warm inside the lane "
      + "(gated in place) · the phase's own attempt (gated at `admit`)",
  },
  {
    file: 'server/runner/runner-control.ts',
    count: 2,
    note: "resumeWithInstruction, inside `recover()` — gated UPSTREAM: the automatic route is "
      + "`maybeAutoRecover`, which only the convergence loop calls, and the loop is gated at "
      + "`fire`. The other route is the operator pressing Fix with AI, which is deliberate. "
      + "· repairSession, inside `recover({mode:'repair'})` — the four briefed-agent rungs as "
      + "runner sessions instead of ptys. Gated IN PLACE with `fleetFrozen()` as well as "
      + "upstream, because it is the vehicle the healer reaches for most and a freeze that "
      + "let it through would be the console starting work the instant the operator stopped it.",
  },
];

/**
 * The door those sites go through (zero-touch-console phase 4, SES-6).
 *
 * Every runner session is spawned by `RunnerBase.spawnSession`, which writes
 * the session's `phase.session` record — so the raw spawn lives in exactly one
 * place, and the sites above are counted as callers of the door. The gates
 * stay where they were: each site still asks `fleetFrozen()` (or is gated at
 * `admit`) BEFORE it calls the door, which gates nothing itself.
 */
const SPAWN_DOOR = { file: 'server/runner/runner-base.ts', note: 'spawnSession — the one raw spawn under the runner' };

/**
 * …and there are no OTHER `spawnClaude` users anywhere in `server/`.
 *
 * The per-file counts above are only a complete census if the files listed are
 * the only ones that spawn. A new spawn in `qa-session.ts`, `agent.ts` or
 * `terminal.ts` would sail past every count in this file.
 */
/**
 * The THIRD spawn shape, and the one two censuses in a row could not see.
 *
 * `terminals.mint({kind: 'claude'})` starts a real session through the terminal
 * broker. It is neither a `startRun` nor a `spawnClaude`, so both patterns
 * above are blind to it — QA round 2 found the healer's agent rung this way.
 *
 * Most of these are operator doors (an account sign-in, an MCP sign-in, a
 * button on an inbox row), which is why this census records WHY rather than
 * just how many.
 */
const MINT_SITES: { file: string; count: number; note: string }[] = [
  {
    file: 'server/service-recovery.ts',
    count: 1,
    note: "maybeAutoRecover's agent rung — gated at the convergence loop, like the rest of it",
  },
  {
    file: 'server/service.ts',
    count: 2,
    note: 'beginAccountLogin · beginMcpLogin — both operator doors, and neither runs a phase',
  },
  {
    file: 'server/inbox.ts',
    count: 1,
    note: "a QA row's own action button — the operator presses it; nothing fires it on a clock",
  },
];

test('census: every place a claude session is MINTED is accounted for', () => {
  for (const site of MINT_SITES) {
    const found = source(site.file).match(/kind: 'claude'/g)?.length ?? 0;
    assert.equal(
      found, site.count,
      `${site.file} mints ${found} claude sessions, this census expects ${site.count}.\n`
      + `Known sites: ${site.note}\n`
      + 'A mint is a third spawn shape that neither of the censuses above can see. If a clock '
      + 'or a loop can reach it, gate it and add a MECHANISMS row.',
    );
  }
});

test('census: the runner is the only thing in server/ that spawns a bare claude', () => {
  const files = new Set(RUNNER_SPAWN_SITES.map((s) => s.file));
  const stray: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(VIEWER, dir))) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const rel = `${dir}/${entry}`;
      if (statSync(join(VIEWER, rel)).isDirectory()) { walk(rel); continue; }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      // `spawn.ts` DEFINES it; a definition is not a call site. The door is
      // pinned to its one call by the census below.
      if (rel === 'server/runner/spawn.ts' || rel === SPAWN_DOOR.file || files.has(rel)) continue;
      // A USE, not a mention. Both shapes: the `deps.spawn ?? spawnClaude`
      // fallback every site here takes, and a bare call. Naming it in an import
      // list or a type is not spawning anything.
      if (/(\?\?\s*spawnClaude|spawnClaude\s*\()/.test(source(rel))) stray.push(rel);
    }
  };
  walk('server');
  assert.deepEqual(
    stray, [],
    'a new file spawns `claude` and no census counts it. Gate it with `fleetFrozen()` (or say '
    + 'why it is an operator door), add a MECHANISMS row, and list it in RUNNER_SPAWN_SITES.',
  );
});

test('census: every place a RUN can be started is accounted for', () => {
  for (const site of START_SITES) {
    const found = source(site.file).match(/this\.startRun\(/g)?.length ?? 0;
    assert.equal(
      found, site.count,
      `${site.file} has ${found} startRun sites, this census expects ${site.count}.\n`
      + `Known sites: ${site.note}\n`
      + 'A new one needs a ruling: is it an auto-start (gate it and add a MECHANISMS row) '
      + 'or an operator door (say so here)?',
    );
  }
});

test('census: every place the RUNNER spawns a bare session is accounted for', () => {
  // The door holds the one raw spawn…
  const raw = source(SPAWN_DOOR.file).match(/this\.deps\.spawn \?\? spawnClaude/g)?.length ?? 0;
  assert.equal(raw, 1, `${SPAWN_DOOR.file} must hold exactly one raw spawn (${SPAWN_DOOR.note}); found ${raw}`);
  // …and no site bypasses it: every site below goes through the door.
  for (const site of RUNNER_SPAWN_SITES) {
    assert.equal(source(site.file).match(/this\.deps\.spawn \?\? spawnClaude/g)?.length ?? 0, 0,
      `${site.file} spawns a raw session instead of going through ${SPAWN_DOOR.note}`);
    const found = source(site.file).match(/this\.spawnSession\(/g)?.length ?? 0;
    assert.equal(
      found, site.count,
      `${site.file} has ${found} runner spawn sites, this census expects ${site.count}.\n`
      + `Known sites: ${site.note}\n`
      + 'A session spawned from inside the loop passes through NEITHER `startRun` nor '
      + '`Scheduler.admit`, so no gate above it can see it. A new one must call '
      + '`this.fleetFrozen()` before it spawns and add a MECHANISMS row.',
    );
  }
});

/**
 * …and the operator doors, said honestly — which took three attempts.
 *
 * The first version of this file claimed `retryPhase` and `recoverPlan` were
 * "operator doors a freeze must never block". Wrong for `retryPhase`: it
 * funnels into a phase, every phase goes through `admit()`, and the fleet
 * holder blocks with no exemption — so a Retry under a freeze QUEUES, visibly,
 * with the freeze named on the queue page. That is the right behaviour; the
 * note was the thing that was wrong.
 *
 * The second version then over-corrected and said the same of `recoverPlan`.
 * Also wrong, the other way: its halt path runs `converger.converge(slug,
 * 'button')`, and `button` is the ONE exempt trigger, so that half really does
 * go through. Both are recorded here rather than quietly deleted, because the
 * pair is the point — "is it blocked?" has a different answer per verb, and
 * guessing it from the verb's name is how this note got written twice.
 */
/**
 * The row above is a claim about a FILE. This is the claim about the BEHAVIOUR.
 *
 * Two QA rounds on this plan established the gap the hard way: the registry
 * pins each gate's TEXT, so switching four gates off while leaving every
 * `guard` token in place produced a suite byte-identical to its baseline — zero
 * failures, exit zero. A row is what forces the next person to think; it is not
 * a proof that the gate does anything.
 *
 * The behavioural proof for the Phase 20 watchdog needs a live Runner, a live
 * lane and a fake clock, which is `runner.test.ts`'s harness and nowhere else's
 * — so it lives there and this asserts it EXISTS. That is a weaker check than
 * running it, and deliberately the strongest one available from here: it fails
 * the moment someone adds a row without a behaviour to go with it.
 */
test('inventory: the watchdog row has a BEHAVIOURAL test, not only a token', () => {
  const runnerTests = source('test/runner.test.ts');
  assert.ok(
    runnerTests.includes("test('a frozen, pausing or fleet-held lane is never touched by the watchdog'"),
    'the three freeze rails must be proven against a live lane, not only greppped for in a source file',
  );
  // …and that the proof is two-sided. A guard test that only shows the remedy
  // NOT firing passes just as well against a watchdog that was deleted.
  assert.ok(
    runnerTests.includes('the guards suppress the remedy — they do not remove it'),
    'the same lane must be nudged once the freeze is lifted, or the test proves nothing',
  );
});

test('the operator doors, per verb — and the one that only LOOKS like the others', () => {
  const converge = source('server/converge.ts');
  assert.ok(
    converge.includes("if (trigger !== 'button') {"),
    'Recover & continue: the press runs a pass, and the pass may relaunch — deliberate',
  );
  assert.ok(
    source('server/service-runs.ts').includes("this.converger.converge(slug, 'button')"),
    "recoverPlan reaches the healer through the EXEMPT trigger, so its halt path goes through — "
    + 'the opposite of `retryPhase`, which queues behind the fleet holder like any other phase',
  );
  // …but only once no hold binds the plan. Under one, Recover and Resume answer
  // 409 naming it before anything is reconciled or started (control-tower phase
  // 81, #93, RR-3): whatever they launched would queue behind the holder, and a
  // 200 that changes nothing is what the operator got on 2026-09-24.
  for (const refusal of ['was not recovered — ${fleetHoldSentence(held)}', 'was not resumed — ${fleetHoldSentence(held)}']) {
    assert.ok(source('server/service-runs.ts').includes(refusal), `the press refuses by name under a hold: ${refusal}`);
  }
  const control = source('server/service-runs.ts');
  for (const verb of ['freezeRun(', 'thawRun(', 'stopRun(']) {
    assert.ok(control.includes(verb), `${verb} acts on a live child and starts nothing`);
  }
  // The inverse, stated so nobody re-derives it: retry/recover are NOT exempt.
  assert.ok(
    !control.includes('retryPhaseIgnoringFleetFreeze'),
    'a Retry under a freeze queues behind the fleet holder and says so — it does not bypass it',
  );
});

/* ================================================================== *
 * B. Admission — the door every lane passes through
 * ================================================================== */

function held(hold: { at: string; by?: string } | null) {
  let current = hold;
  const scheduler = new Scheduler({
    max: 8,
    locks: () => [],
    fleetHold: () => current,
  });
  return { scheduler, set: (next: typeof current) => { current = next; } };
}

/** Let the microtask `admit()` schedules actually run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Has this admission genuinely not settled? See `scheduler.test.ts`. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const settled = promise.then(() => 'settled' as const, () => 'settled' as const);
  const later = new Promise<symbol>((resolve) => setImmediate(() => resolve(marker)));
  return await Promise.race([settled, later]) === marker;
}

test('admission: a frozen fleet admits nothing, and every waiting entry says why', async () => {
  const { scheduler } = held({ at: new Date().toISOString(), by: 'mo' });
  const waiting = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  waiting.catch(() => {});
  await tick();
  assert.ok(await pending(waiting), 'a fleet freeze holds an admission with a clear scope');

  const entry = scheduler.snapshot().entries[0];
  assert.equal(entry.waitingOn[0].slug, FLEET_HOLDER, 'the queue names the fleet freeze, not a scope');
  assert.equal(entry.waitingOn[0].owner, fleetFreezeReason('mo'), 'and says who froze it');
  assert.equal(entry.waitingOn[0].kind, 'reserved');
});

test('admission: a RECOVERY is not exempt — the one carve-out the boarding window has, this does not', async () => {
  const { scheduler } = held({ at: new Date().toISOString(), by: 'mo' });
  const recovery = scheduler.admit({
    slug: 'alpha', phase: null, runId: 'r1', scope: ['app'], kind: 'recovery',
  });
  recovery.catch(() => {});
  await tick();
  assert.ok(
    await pending(recovery),
    'a recovery admitted under a fleet freeze would relaunch the session the operator just stopped',
  );
  assert.equal(scheduler.snapshot().entries[0].waitingOn[0].slug, FLEET_HOLDER);
});

test('admission: wouldBlock reports the freeze ahead of every other reason', () => {
  const { scheduler } = held({ at: new Date().toISOString(), by: 'mo' });
  const holders = scheduler.wouldBlock({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  assert.equal(holders.length, 1, 'one reason, and it is the operator’s own');
  assert.equal(holders[0].slug, FLEET_HOLDER);
});

test('admission: a fleet-held entry never ages into reserving, however long it waits', async () => {
  let now = Date.parse('2026-08-26T10:00:00Z');
  const scheduler = new Scheduler({
    max: 8,
    locks: () => [],
    now: () => now,
    fleetHold: () => ({ at: '2026-08-26T09:59:00Z', by: 'mo' }),
  });
  const waiting = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  waiting.catch(() => {});
  await tick();
  now += AGING_MS * 3;
  scheduler.poll();
  await tick();
  const entry = scheduler.snapshot().entries[0];
  assert.equal(
    entry.reserving, false,
    'a reserving frozen entry would hold its checkout against work that could legitimately '
    + 'start the moment the console thaws',
  );
  assert.equal(entry.waitingOn[0].slug, FLEET_HOLDER);
});

test('admission: the thaw admits on the very next scan, with nothing to unwind', async () => {
  const { scheduler, set } = held({ at: new Date().toISOString(), by: 'mo' });
  const waiting = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  waiting.catch(() => {});
  await tick();
  assert.ok(await pending(waiting));
  set(null);
  scheduler.poll();
  const grant = await waiting;
  assert.equal(grant.slug, 'alpha', 'the entry that waited out the freeze is the one that runs');
});

test('admission: the freeze outranks the boarding schedule, and survives it reopening', async () => {
  // Quiet hours covering the whole day, so BOTH clocks are against this entry.
  let quiet = true;
  const scheduler = new Scheduler({
    max: 8,
    locks: () => [],
    schedule: () => (quiet
      ? ({ enabled: true, quiet: [{ from: '00:00', to: '23:59' }] } as never)
      : undefined),
    fleetHold: () => ({ at: '2026-08-26T09:59:00Z', by: 'mo' }),
  });
  const waiting = scheduler.admit({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  waiting.catch(() => {});
  await tick();
  assert.equal(
    scheduler.snapshot().entries[0].waitingOn[0].slug, FLEET_HOLDER,
    'with several clocks against a phase, the operator’s own press is the sentence worth showing',
  );

  // The schedule reopens while the freeze stands. Still held, and still for
  // the right reason — a thawed schedule is not a thawed console.
  quiet = false;
  scheduler.poll();
  await tick();
  assert.ok(await pending(waiting));
  assert.equal(scheduler.snapshot().entries[0].waitingOn[0].slug, FLEET_HOLDER);
});

test('admission: a fleetHold dep that throws is read as NOT frozen', async () => {
  const scheduler = new Scheduler({
    max: 8,
    locks: () => [],
    fleetHold: () => { throw new Error('the marker file is on a disk that went away'); },
  });
  const grant = await scheduler.admit({ slug: 'alpha', phase: 1, runId: 'r1', scope: ['app'] });
  assert.equal(grant.slug, 'alpha', 'a console that cannot read the marker must not stop the fleet silently');
});

/* ================================================================== *
 * C. The convergence loop
 * ================================================================== */

class FakeClock {
  time = Date.parse('2026-08-26T10:00:00Z');
  private timers: { at: number; fn: () => void }[] = [];
  now(): number { return this.time; }
  setTimeout(fn: () => void, ms: number): unknown {
    const handle = { at: this.time + ms, fn };
    this.timers.push(handle);
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t !== handle);
  }
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
}

function converger(hold: { at: string; by?: string } | null) {
  const clock = new FakeClock();
  let current = hold;
  const passes: ConvergeTrigger[] = [];
  const s = new ConvergeScheduler({
    run: async (_slug, trigger): Promise<ConvergeReport | null> => { passes.push(trigger); return null; },
    slugs: () => ['alpha'],
    clock,
    fleetHold: () => current,
  });
  return { s, clock, passes, set: (next: typeof current) => { current = next; } };
}

test('converge: boot, change, sweep and halt all no-op while the console is frozen', async () => {
  const { s, clock, passes } = converger({ at: '2026-08-26T09:59:00Z', by: 'mo' });
  await s.boot(['alpha']);
  s.request('alpha', 'change');
  s.request('alpha', 'halt');
  await clock.advance(10 * 60_000);
  await s.idle();
  assert.deepEqual(passes, [], 'a frozen console does not even READ the board — a pass costs a subprocess');
});

test("converge: the operator's own press is not silently blocked", async () => {
  const { s, passes } = converger({ at: '2026-08-26T09:59:00Z', by: 'mo' });
  await s.converge('alpha', 'button');
  assert.deepEqual(passes, ['button'], 'a freeze stops the console acting on its own, not the person holding it');
});

test('converge: a request made during the freeze still fires after the thaw — nothing is cancelled', async () => {
  const { s, clock, passes, set } = converger({ at: '2026-08-26T09:59:00Z', by: 'mo' });
  s.request('alpha', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS + 1);
  await s.idle();
  assert.deepEqual(passes, [], 'the debounce fired and found the console frozen');
  set(null);
  s.request('alpha', 'change');
  await clock.advance(CHANGE_DEBOUNCE_MS + 1);
  await s.idle();
  assert.deepEqual(passes, ['change'], 'the very next request runs — no clock had to be rewound');
});

test('converge: a fleetHold dep that throws is read as NOT frozen', async () => {
  const clock = new FakeClock();
  const passes: ConvergeTrigger[] = [];
  const s = new ConvergeScheduler({
    run: async (_slug, trigger) => { passes.push(trigger); return null; },
    slugs: () => ['alpha'],
    clock,
    fleetHold: () => { throw new Error('unreadable'); },
  });
  await s.boot(['alpha']);
  assert.deepEqual(passes, ['boot'], 'the console keeps working rather than stopping for a reason nobody can see');
});

/* ================================================================== *
 * D. The marker on disk
 * ================================================================== */

test('marker: write, read, clear — and clearing twice is not an error', () => {
  clearFleetHold();
  assert.equal(readFleetHold(), null, 'a console with no marker is not frozen');

  const written = writeFleetHold('mo', '2026-08-26T10:00:00Z');
  assert.deepEqual(written, { at: '2026-08-26T10:00:00Z', by: 'mo' });
  assert.deepEqual(readFleetHold(), written, 'what was written is what the next reader sees');

  clearFleetHold();
  clearFleetHold();
  assert.equal(readFleetHold(), null);
});

test('marker: an unreadable or nonsense marker reads as NOT frozen', () => {
  mkdirSync(join(FLEET_FREEZE_FILE, '..'), { recursive: true });
  for (const junk of ['', 'not json at all', 'null', '[]', '{"by":"mo"}', '{"at":"never"}']) {
    writeFileSync(FLEET_FREEZE_FILE, junk, 'utf8');
    assert.equal(
      readFleetHold(), null,
      `"${junk}" must not freeze the fleet — a console that wrongly believes itself frozen `
      + 'stops everything silently and looks exactly like a console with nothing to do',
    );
  }
  rmSync(FLEET_FREEZE_FILE, { force: true });
});

test('marker: a `by` nobody supplied still reads back as something', () => {
  writeFileSync(FLEET_FREEZE_FILE, JSON.stringify({ at: '2026-08-26T10:00:00Z' }), 'utf8');
  assert.equal(readFleetHold()?.by, 'console');
  rmSync(FLEET_FREEZE_FILE, { force: true });
});

/* ================================================================== *
 * E. The standing freeze — a freeze with no deadline
 * ================================================================== */

test('standing: a freeze written without escalateAt never converts on a clock', () => {
  const standing = { at: '2026-08-26T10:00:00Z', by: 'mo' };
  assert.deepEqual(
    freezeVerdict(standing, Date.parse('2027-01-01T00:00:00Z')),
    { kind: 'none' },
    'a fleet freeze half a year old must still be the operator’s to undo — '
    + 'converting it would checkpoint the very work they asked to hold',
  );
});

test('standing: an ordinary lane freeze still escalates — the two forms are not confused', () => {
  const ordinary = { at: '2026-08-26T10:00:00Z', by: 'mo', escalateAt: '2026-08-26T10:15:00Z' };
  assert.equal(freezeVerdict(ordinary, Date.parse('2026-08-26T10:16:00Z')).kind, 'escalate');
  assert.equal(freezeVerdict(ordinary, Date.parse('2026-08-26T10:05:00Z')).kind, 'rearm');
});

test('standing: the run-control freeze writes the standing form when asked, and only then', () => {
  const text = source('server/runner/runner-control.ts');
  assert.ok(
    text.includes('const escalateAt = opts?.standing'),
    'the standing form is what a fleet freeze writes; without it every lane carries a 15-minute '
    + 'clock that would undo the freeze',
  );
  assert.ok(
    text.includes('if (escalateAt) {\n        lane.freezeTimer = setTimeout'),
    'a standing freeze must arm no escalation timer either — the record and the timer are two '
    + 'halves of the same promise, and half a promise is the orphan this whole area exists to prevent',
  );
});


/* ================================================================== *
 * F. A freeze is named wherever a card would promise continuation
 *    (control-tower phase 81, #93)
 * ================================================================== */

/**
 * Measured on hub 4123 and pe-hub 4130, 2026-09-24: an operator froze the
 * whole console at 09:57:43Z; launchd restarted it at 10:11:30Z with the
 * freeze still set. Every run's `finishedReason` said "the console shut down
 * while this run was working — it continues by itself once the console is
 * back", and nothing continued; a per-run Resume answered 200 and changed
 * nothing, because admission holds every entry behind the fleet holder. An
 * agent spent seven minutes finding the console-wide flag behind a stall the
 * card had called self-healing.
 *
 * RR-1: the shutdown sentence names the freeze — who, when, and the one act
 * that ends it — whenever a hold that outlives the process binds the run.
 * RR-2: the card's reading of a stored promise, through one shared function:
 * under a hold the promise is replaced by the hold, and a restart's own hold
 * (which lifts with the process) leaves it standing.
 * RR-3: Resume and Recover under a hold answer 409 with that sentence.
 */

const FROZE_AT = '2026-09-24T09:57:43.000Z';

function stubRepo(): { root: string; scripts: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-freeze-named-'));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block) echo "done: "; echo "ready: 1"; echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return { root, scripts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A console going away under a working run — the SHD-8 shape: a real child, killed by the checkpoint. */
async function shutDownUnder(hold: { at: string; by: string; scope?: 'machine' | 'restart' } | null): Promise<string | undefined> {
  const { Runner } = await import('../server/runner/runner.ts');
  const r = stubRepo();
  // The ladder's waits are unref'd; something has to hold the loop open around them.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    let childPid = 0;
    let current: typeof hold = null;
    const instance = new Runner({
      scriptsDir: r.scripts, verificationText: () => '`true`',
      // The freeze lands while the phase is working, as it did: nothing would
      // have boarded under it.
      fleetHold: () => current,
      spawn: async (request) => {
        const child = spawnProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore', detached: true });
        childPid = child.pid!;
        request.onPid?.(child.pid!);
        request.onHandle?.({ pid: child.pid!, open: () => true, send: () => true, setFrozen: () => {} });
        request.onEvent?.({ kind: 'init', sessionId: 'sess-frozen-0001', model: 'stub-1', tools: 0 });
        await new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
        return {
          signal: { subtype: 'error_during_execution', code: 143, text: 'terminated' },
          sessionId: 'sess-frozen-0001', costUsd: 0, turns: 1, resultText: '', durationMs: 10, argv: [], injected: 0,
        };
      },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    for (let i = 0; i < 200 && !childPid; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    current = hold;
    await (instance as never as { checkpointForShutdown: (context: unknown) => Promise<void> })
      .checkpointForShutdown({ intent: 'restart', reason: 'restart (launchd)', mode: 'exit' });
    await instance.wait();
    return instance.current()?.finishedReason;
  } finally { clearInterval(keepAlive); r.cleanup(); }
}

test('RR-1: a console that shuts down under a fleet freeze says so on the run — who froze it and when — never "it continues by itself"', async () => {
  const said = await shutDownUnder({ at: FROZE_AT, by: 'operator' });
  assert.match(said ?? '', /frozen console-wide by operator at 2026-09-24T09:57:43\.000Z/);
  assert.match(said ?? '', /thaw to continue/);
  assert.doesNotMatch(said ?? '', /continues by itself/, 'the one promise the freeze makes false');
});

test('RR-1: with no hold, or only a restart\'s own (it lifts with the process), the promise stands — it is true', async () => {
  for (const hold of [null, { at: FROZE_AT, by: 'a restart by mo, updating to the latest version first', scope: 'restart' as const }]) {
    const said = await shutDownUnder(hold);
    assert.match(said ?? '', new RegExp(SHUTDOWN_CONTINUES), `hold=${JSON.stringify(hold)}: ${said}`);
  }
});

test('RR-2: the card reads a stored promise through the hold — replaced while one binds, untouched once it lifts', () => {
  const stored = `the console shut down while this run was working — ${SHUTDOWN_CONTINUES}`;
  const frozen = heldStopReason(stored, { at: FROZE_AT, by: 'operator' });
  assert.equal(frozen, `the console shut down while this run was working — frozen console-wide by operator at ${FROZE_AT} — thaw to continue`);
  assert.equal(heldStopReason(stored, null), stored, 'thawed: the promise is true again');
  assert.equal(heldStopReason(stored, { at: FROZE_AT, by: 'a restart by mo', scope: 'restart' }), stored,
    'a restart\'s hold lifts with the process — the run does continue by itself');
  assert.match(heldStopReason(stored, { at: FROZE_AT, by: 'the supervisor', scope: 'machine' }),
    /held machine-wide by the supervisor at .* — release the hold to continue/);
  assert.equal(heldStopReason('phase 3 declared itself blocked', { at: FROZE_AT, by: 'operator' }),
    'phase 3 declared itself blocked', 'a stop that promised nothing keeps its own words');
  assert.equal(fleetHoldSentence({ at: FROZE_AT, by: 'operator' }), `frozen console-wide by operator at ${FROZE_AT} — thaw to continue`);
});

test('RR-3: under a fleet freeze Resume and Recover answer 409 with the freeze — never a 200 that does nothing', async () => {
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-freeze-409-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), `---
slug: alpha
created: 2026-08-06
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
`, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  try {
    assert.equal(svc.open(root).ok, true);
    const state = newRun({ slug: 'alpha', root });
    state.status = 'paused';
    state.stoppedBy = 'system';
    state.finishedReason = `the console shut down while this run was working — ${SHUTDOWN_CONTINUES}`;
    phaseRecord(state, 1).status = 'pending';
    saveRun(state);
    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun = async (...args: unknown[]) => { started.push(args); return state; };

    assert.equal(svc.freezeFleet('operator').ok, true);
    const actor = { by: 'operator', door: 'operator' } as never;

    const resumed = await svc.resumeRun('alpha', actor);
    assert.equal(resumed.ok, false);
    assert.equal(!resumed.ok && resumed.status, 409);
    assert.match(!resumed.ok ? resumed.error : '', /frozen console-wide by operator at .* — thaw to continue/);

    await assert.rejects(svc.recoverPlan('alpha', actor), /frozen console-wide by operator at .* — thaw to continue/,
      'the route answers a refusal 409 — see `case \'recover\'`');
    assert.deepEqual(started, [], 'nothing was started under the freeze');
  } finally {
    clearFleetHold();
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
