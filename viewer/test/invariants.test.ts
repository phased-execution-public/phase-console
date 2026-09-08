/**
 * The invariant this plan is named for, pinned so the class cannot come back.
 *
 *     A process is a fact; a record is a claim.
 *     Ask the fact in ONE place, act on it in ONE place, and settle every
 *     claim against the fact — never against another claim.
 *
 * The incident it comes from: a phase-9 session outlived the console that
 * spawned it, sat in state `T` for three and a half hours holding its session
 * id and its lock, while the run record three feet away went on reading
 * `running` — because the record had been settled against `state.status`,
 * which is another claim by the same dead writer. Meanwhile six copies of the
 * teardown ladder disagreed about whether to wake the child first, and two
 * separate liveness probes disagreed about whether it was alive at all.
 *
 * Three clauses, one section each:
 *
 *   1. THE CHOKE POINTS — one place asks, one place acts. Enforced as a lint
 *      over the real source of `server/`, because this clause is about code
 *      that does not exist yet: the fourth copy of the ladder someone adds next
 *      year is exactly what it has to catch.
 *   2. THE HANDLE OUTLIVES ITS CONSOLE — a ChildRef for a phase THIS console
 *      holds no lane for survives the merge byte-for-byte, so long as the probe
 *      says its process is there.
 *   3. SETTLE AGAINST THE PROBE — no reader ever sees a record claiming work in
 *      flight over a process that is gone, whatever the run says about itself.
 *
 * On duplication, since this plan is largely about it. The per-phase suites own
 * the exhaustive proofs — `signals.test.ts` the ladder's own behaviour,
 * `reconcile.test.ts` the identity tuple, `settle-matrix.test.ts` the settle
 * function cell by cell. This file asserts the INVARIANT, from the angle none
 * of them can: clause 1 is a source lint nothing else performs in full, clause
 * 2 targets `syncMirror`'s merge (the write path — reconcile is the read path),
 * and clause 3 goes through `saveRun`/`loadRun`, because the healer that
 * refused to recover the incident twice was a READER.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IN_FLIGHT, PHASE_IN_FLIGHT, loadRun, newRun, phaseRecord, saveRun,
  type PhaseStatus, type RunState, type RunStatus,
} from '../server/runner/state.ts';
import { setPsReader, forgetPid, type ProcessState } from '../server/pid.ts';
import { newLaneSignals } from '../server/runner/liveness.ts';
import { Runner } from '../server/runner/runner.ts';

/* ================================================================== *
 * Clause 1 — the choke points
 * ================================================================== */

const SERVER = new URL('../server/', import.meta.url);

type Source = { rel: string; lines: string[] };

/** Every `.ts` file under `server/`, as lines, with its path relative to it. */
function sources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      // A generated-output tree is not source. It holds no .ts today, but a
      // lint that started reading one would be linting a build artifact.
      if (entry.isDirectory()) { if (!entry.name.endsWith('-out')) walk(child); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      out.push({ rel: child.href.slice(SERVER.href.length), lines: readFileSync(child, 'utf8').split('\n') });
    }
  };
  walk(SERVER);
  return out;
}

const SOURCES = sources();

/**
 * Where `pattern` matches a line that is CODE.
 *
 * Comment-skipping is deliberately conservative — a line inside a `/* … *\/`
 * block, or one whose first non-space characters are `*` or `//`. It never
 * tries to parse strings, because the failure modes are not symmetric: a
 * comment mistaken for code fails loudly and gets fixed in one line, while code
 * mistaken for a comment is a silent hole in the lint. Every rule below is
 * therefore paired with a positive assertion that the lint can still SEE the
 * call sites that are supposed to be there — if the skipping ever starts
 * eating real code, those go red first.
 */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { rel, lines } of SOURCES) {
    let inBlock = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      const wasInBlock = inBlock;
      if (inBlock) { if (trimmed.includes('*/')) inBlock = false; }
      else if (trimmed.startsWith('/*') && !trimmed.includes('*/')) inBlock = true;
      if (wasInBlock || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (pattern.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found.sort();
}

/** The files (not lines) a pattern reaches. */
const filesOf = (found: string[]): string[] => [...new Set(found.map((h) => h.split(':')[0]))].sort();

test('clause 1: only signals.ts SIGNALS a process, and only pid.ts ASKS about one', () => {
  // `process.kill(pid, 0)` is a question, not a signal — the two are told apart
  // by the second argument, which is why this cannot be one grep.
  const all = hits(/process\.kill\(/);
  const probes = all.filter((h) => {
    const [rel, line] = h.split(':');
    const src = SOURCES.find((s) => s.rel === rel)!;
    return /process\.kill\([^,)]*,\s*0\s*\)/.test(src.lines[Number(line) - 1]);
  });
  const signalled = all.filter((h) => !probes.includes(h));

  assert.deepEqual(filesOf(signalled), ['runner/signals.ts'],
    'these files signal a process directly — route them through server/runner/signals.ts, '
    + 'which wakes the child first, addresses its GROUP, and always leaves a SIGKILL backstop. '
    + 'Six copies of that ladder is how two of them came to be missing the wake.');
  assert.deepEqual(filesOf(probes), ['pid.ts'],
    'these files ask whether a pid exists — route them through processState() in server/pid.ts. '
    + 'Two probes disagreeing about one process is how a stopped session read as alive.');

  // The lint can still see. If comment-skipping ever eats real code these go
  // red before a silent hole can open.
  assert.ok(signalled.length >= 2, 'the ladder itself must still be visible to this lint');
  assert.ok(probes.length >= 1, 'the probe itself must still be visible to this lint');
});

test('clause 1: only pid.ts shells `ps`', () => {
  // Any call whose first argument is the string `ps`. Matching the function
  // NAMES instead would be evaded by `import { execFileSync as e }`, and
  // there is nothing else in server/ that passes "ps" as a first argument.
  const found = hits(/\(\s*['"]ps['"]\s*,/);
  assert.deepEqual(filesOf(found), ['pid.ts'],
    'these files shell `ps` — the one reader is defaultReadPs() in server/pid.ts, which is also '
    + 'the only place that knows `comm` answers `claude` where `ucomm` answers the version string.');
  assert.equal(found.length, 1, 'and it is asked in exactly one place');
});

/**
 * Every `.kill(` in `server/` that is NOT the ladder, each named with the
 * reason it is allowed.
 *
 * The plan's Detail says a grep finds `process.kill(`/`child.kill(` only in
 * `signals.ts`. That was never true of this tree, and asserting it literally
 * would force three wrong refactors: none of these is a PHASE SESSION, which is
 * what the invariant is about. Three are short-lived children the console
 * spawns and awaits, with no group of their own to address; two are ptys, which
 * have their own ladder in `terminal.ts`.
 *
 * The list is asserted as an exact SET, so it fails in both directions — a new
 * kill anywhere fails, and so does deleting one of these without deleting its
 * entry here, which is what keeps the reasons from rotting. What it CANNOT see
 * is a kill inside one of these six files that is about something else; the
 * unit is the file, and for `terminal.ts` and `pty/broker.ts` that is the
 * loosest this can be.
 */
const KILL_ALLOWED: Record<string, string> = {
  'api/routes.ts':
    'service.terminals.kill(id) — the Terminals class\'s own method, closing a pty SESSION',
  'mcp/health.ts':
    'the one-turn `claude -p` MCP probe, killed when it answers or times out. Since Phase 5 the '
    + 'GROUP kill goes through signals.ts\'s groupSignal() — the probe is spawned detached, because '
    + 'it is the one console child guaranteed to have started MCP servers — and what is left here is '
    + 'the no-group fallback (a spawn seam that gave us no pid)',
  'runner/auth.ts':
    'the `claude auth status` probe, killed at its 20s timeout',
  'runner/spawn.ts':
    'onAbort\'s fallback for a child with NO pid — there is no group to address, so the '
    + 'ladder has nothing to work with; the pid path above it goes through wakeAndTerm()',
  'terminal.ts':
    'the pty handle\'s own kill() and the class\'s this.kill(id). A pty is not a child the '
    + 'console spawned, and terminal.ts already wakes before it hangs up. Since Phase 7 that '
    + 'handle is normally a broker client, so the hangup travels down a socket to pty/broker.ts',
  'pty/broker.ts':
    'the far end of that hangup: node-pty\'s own pty.kill() on the process the BROKER owns, and '
    + 'its own this.kill(id). This is where ptys are really ended now, and it is the same '
    + 'reasoning as terminal.ts\'s — a pty is a terminal, not a piped child, so closing the '
    + 'master is how it ends. The wake that must come first is the groupSignal(SIGCONT) on the '
    + 'line above it, through signals.ts like everything else',
};

test('clause 1: the only kills outside the ladder are probes and ptys', () => {
  // Any `<something>.kill(` that is not `process.kill(` — which the rule above
  // owns. Deliberately broader than `child.kill(`: a handle named anything
  // else would otherwise walk straight past this lint.
  const found = hits(/(?<!\bprocess)\.kill\(/);
  assert.deepEqual(filesOf(found), Object.keys(KILL_ALLOWED).sort(),
    'a child handle is being killed somewhere new, or one of the allowed sites is gone.\n'
    + 'ADDING one: if it is a phase session, route it through server/runner/signals.ts instead — '
    + 'a bare kill on a non-detached child leaves its bash, its MCP servers and its subagents behind.\n'
    + 'REMOVING one: delete its entry from KILL_ALLOWED in this file.\n'
    + 'Allowed today:\n'
    + Object.entries(KILL_ALLOWED).map(([f, why]) => `  ${f} — ${why}`).join('\n'));
});

test('clause 1: one definition each for the derivations that used to disagree', () => {
  // Every one of these was two copies that gave different answers, and the
  // console acted on both. Named here rather than in four places so that
  // re-introducing a copy fails once, loudly.
  const single: Array<{ what: string; pattern: RegExp; file: string; why: string }> = [
    {
      what: 'isProductiveEvent', pattern: /export function isProductiveEvent\b/,
      file: 'runner/liveness.ts',
      why: 'the ONE list of what counts as work rather than plumbing — a second copy drifts, '
        + 'and a retry counted as progress held a lane\'s silence clock below threshold for hours',
    },
    {
      what: 'lockLapsed', pattern: /export function lockLapsed\b/, file: 'runner/scheduler.ts',
      why: 'the ONE lock clock — the scheduler said lapsed while the classifier said foreign-live, '
        + 'for the same lock in the same second, and foreign-live has no rung',
    },
  ];
  for (const { what, pattern, file, why } of single) {
    assert.deepEqual(filesOf(hits(pattern)), [file], `${what} must be defined once, in ${file}: ${why}`);
  }
});

test('clause 1: the live-status vocabulary is imported, never re-typed', () => {
  // `server/inbox.ts` kept its own `LIVE_RUN_STATUSES` Set and its own
  // `isLiveStatus`, byte-identical to `shared/status-vocab.js` and stale in its
  // comment (it cited `views/run/defaults.ts`, a path the redesign deleted).
  // Three copies that agree today are three copies that disagree the day a word
  // is added — which is how a finished run gets painted as running on one page
  // and settled on another.
  assert.deepEqual(hits(/\bLIVE_RUN_STATUSES\s*=/), [],
    'a private copy of LIVE_RUN_STATUSES is back under server/. '
    + "Import it from '../shared/status-vocab.js' instead — and if you do, remember it must also be "
    + 'in the root package.json `files` allowlist and assert-tarball.sh, or a packed install cannot boot.');
  assert.deepEqual(hits(/(const|function)\s+isLiveStatus\b/), [],
    "a second definition of isLiveStatus is back under server/. There is one, in shared/status-vocab.js.");
});

test('clause 1: the two pause/halt re-checks in the drive loop stay', () => {
  // These are the lines a "the compiler says this is unreachable" cleanup
  // deletes. They are not unreachable: `pause()`, `halt()` and `park()` all
  // write `state.status` from OUTSIDE the loop, during the awaits that precede
  // both — and the comment above the first records the measured incident
  // ("an operator can press Pause in. They did, repeatedly, and watched the
  // next phase start anyway"). TypeScript narrows the property at the loop-top
  // guards and never re-widens it across an await, which is why the value goes
  // through `stopAdmitting` rather than being tested inline.
  const guards = hits(/stopAdmitting\(state\.status\)/);
  assert.equal(guards.length, 2,
    'the drive loop must re-check pause/halt after the board read AND before filling the second '
    + `lane of a burst; found ${guards.length}: ${guards.join(', ')}`);
  assert.deepEqual(filesOf(guards), ['runner/runner-loop.ts']);
});

test('clause 1: boardStates stays deleted, and the evidence builder stays injected', () => {
  // `boardStates` wrapped the board read in `try/catch { return {} }`, so
  // "the console could not read the board" and "no phase is done" were the same
  // value, and seven callers decided on it.
  assert.deepEqual(hits(/\bboardStates\b/), [],
    'boardStates is back. It cannot distinguish a failed board read from an empty board; '
    + 'use board(slug) and refuse on board.error.');

  // One evidence builder: the Service's, injected into the Runner, which
  // overlays only its own run-local facts.
  const read = (rel: string): string => readFileSync(new URL(rel, SERVER), 'utf8');
  // `RunnerDeps` moved to `runner/runner-core.ts` when P10 split the class across
  // an `extends` chain — the chain's links all need the prologue, so it had to
  // become a leaf module. The file is named exactly, not searched for: this
  // assertion is only worth having if it fails when the seam is removed, and a
  // scan of the whole folder would pass on any stray mention anywhere in it.
  assert.match(read('runner/runner-core.ts'), /evidenceDeps\?:\s*\(slug: string\)\s*=>\s*EvidenceDeps/,
    'the Runner must take the evidence builder as a dep, never build a second one');
  // The SUPPLY site sits where the Service mints a Runner — the runner pool,
  // which the P10 split put in the first link of the chain. Named exactly, for
  // the same reason as above.
  assert.match(read('service-base.ts'), /evidenceDeps:\s*\(slug\)\s*=>\s*this\.evidenceDeps\(slug\)/,
    'the Service must be the one that supplies it');
});

/**
 * One sentence for one refusal, in both processes.
 *
 * The foreign-session page (Phase 8) refuses the resume in the browser rather
 * than letting a person click a button that answers 403, and to do that it
 * carries the flag message as a client constant. Two copies of a sentence
 * drift: the server's gets reworded and the page keeps telling people to
 * restart with a flag spelled the old way. Asserted rather than shared —
 * `server/api/routes.ts` is not importable from `client/`, and inventing a
 * shared module for one string would put a server concern in the browser
 * bundle.
 */
test('clause 1: the agent-flag refusal reads the same in the server and in the page', () => {
  const sentence = 'Agent sessions are disabled. Restart with --allow-agent to enable them.';
  assert.ok(readFileSync(new URL('api/routes.ts', SERVER), 'utf8').includes(sentence),
    'the server must still refuse in these words');
  assert.ok(
    readFileSync(new URL('../client/src/features/sessions/foreign.tsx', SERVER), 'utf8').includes(sentence),
    'and the page that refuses FIRST must say the same words');
});

/* ================================================================== *
 * Clause 2 — the handle outlives the console that made it
 * ================================================================== */

/**
 * `processState` asks `kill(pid, 0)` BEFORE it consults the `setPsReader` seam,
 * so a stub written for a pid nobody has proves nothing — it returns `gone` on
 * the existence check and never reaches the reader. Use this process's own pid.
 * (That trap cost phase 3 a wrong turn.)
 */
const LIVE_PID = process.pid;
/** High, odd, and certainly not running — the one answer a stub cannot fake. */
const DEAD_PID = 0x7ffffffe;

/** A start time the ChildRef and the stubbed `ps` agree on, in any timezone. */
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

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-invariants-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A runner with no scripts and no model — only the merge is under test. */
function bareRunner(): Runner {
  return new Runner({ scriptsDir: '/nonexistent', verificationText: () => undefined });
}

/** Drive the private mirror sync. It is the write path clause 2 is about. */
function syncMirror(runner: Runner): void {
  (runner as unknown as { syncMirror: () => void }).syncMirror();
}

function lane(phase: number, pid: number) {
  return {
    phase, pid, handle: null, grant: null, frozen: null, freezeTimer: null,
    stopped: null, checkpointed: false, checkpointNote: null, leaseTimer: null,
    signals: newLaneSignals(Date.now()),
  };
}

/** A run carrying a foreign generation's handle on phase 9. */
function runWithForeignChild(root: string, pid: number): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  state.status = 'running';
  state.children = {
    9: { pid, phase: 9, sessionId: 'sess-9', startedAt: '2026-08-22T11:12:14Z', procStartedAt: PROC_STARTED_AT },
  };
  phaseRecord(state, 9).status = 'running';
  return state;
}

test('clause 2: a live foreign ChildRef survives the merge byte-for-byte', () => {
  // The incident, reduced. `syncMirror` used to project `this.lanes` wholesale
  // over `state.children`, which made the map a picture of one process's memory
  // instead of a record of a fact. A fresh console's first lane therefore
  // ERASED the previous generation's entry — the only durable handle on a child
  // that was still editing the tree. With it gone, reconcile's orphan branch,
  // adopt() and converge.runIsDead all went blind at once.
  const dir = scratch();
  const probe = withProbe('running');
  try {
    const state = runWithForeignChild(dir.root, probe.pid);
    const before = JSON.stringify(state.children!['9']);

    const runner = bareRunner();
    (runner as unknown as { state: RunState }).state = state;
    // A NEW console generation, driving a phase of its own. Phase 9 is not its
    // business, and that is exactly the point.
    (runner as unknown as { lanes: Map<number, unknown> }).lanes.set(2, lane(2, LIVE_PID));
    syncMirror(runner);

    assert.ok(state.children?.['9'], 'the foreign handle must survive a recovery that is not about it');
    assert.equal(JSON.stringify(state.children!['9']), before,
      'and survive UNCHANGED — the pid and its start time are the tuple a later console '
      + 'uses to tell this child from whatever recycled its pid');
    assert.ok(state.children?.['2'], 'this console\'s own lane is still recorded');
  } finally { probe.restore(); dir.cleanup(); }
});

test('clause 2: a foreign ChildRef is dropped only when the PROBE says it is gone', () => {
  const dir = scratch();
  const probe = withProbe('gone');
  try {
    const state = runWithForeignChild(dir.root, probe.pid);
    const runner = bareRunner();
    (runner as unknown as { state: RunState }).state = state;
    (runner as unknown as { lanes: Map<number, unknown> }).lanes.set(2, lane(2, LIVE_PID));
    syncMirror(runner);

    assert.equal(state.children?.['9'], undefined,
      'a handle on a process that is really gone is not a fact any more — but it takes the probe '
      + 'to say so, never the absence of a lane for it');
  } finally { probe.restore(); dir.cleanup(); }
});

test('clause 2: a stopped foreign child is KEPT — `T` is not `gone`', () => {
  // The incident's own child sat in state `T`. Dropping it there is what
  // anonymised the session and let its lock be released as debris, and it is
  // recoverable with one `kill -CONT`.
  const dir = scratch();
  const probe = withProbe('stopped');
  try {
    const state = runWithForeignChild(dir.root, probe.pid);
    const runner = bareRunner();
    (runner as unknown as { state: RunState }).state = state;
    syncMirror(runner);
    assert.ok(state.children?.['9'], 'a stopped process is still a process');
  } finally { probe.restore(); dir.cleanup(); }
});

/* ================================================================== *
 * Clause 3 — settle against the probe, never against another claim
 * ================================================================== */

const RUN_STATUSES: readonly RunStatus[] = [
  'running', 'pausing', 'paused', 'waiting', 'frozen', 'parked', 'halted',
  'halting', 'finished', 'stopping', 'queued', 'interrupted',
];

/** A saved run whose phase-12 record claims `record` over child `pid`. */
function savedRun(root: string, status: RunStatus, record: PhaseStatus, pid: number): RunState {
  const state = newRun({ slug: 'demo', root, model: 'opus' });
  state.status = status;
  state.activePhase = 12;
  state.child = { pid, phase: 12, sessionId: 'sess-12', startedAt: new Date().toISOString() };
  state.children = { 12: state.child };
  const held = phaseRecord(state, 12);
  held.status = record;
  held.sessionId = 'sess-12';
  saveRun(state);
  return state;
}

test('clause 3: no READER ever sees work in flight over a process that is gone', () => {
  // settle-matrix.test.ts asserts settleInFlightRecords() cell by cell. This
  // asserts the property a reader gets, through saveRun/loadRun — because the
  // healer that refused to recover the incident twice was a reader, and it read
  // `running` off a run that had already parked.
  const dir = scratch();
  const probe = withProbe('gone');
  try {
    let cells = 0;
    for (const runStatus of RUN_STATUSES) {
      for (const recordStatus of PHASE_IN_FLIGHT) {
        cells++;
        const saved = savedRun(dir.root, runStatus, recordStatus, probe.pid);
        const read = loadRun(dir.root, 'demo', saved.id);
        assert.ok(read, 'the run must still be readable');
        assert.ok(!(PHASE_IN_FLIGHT as readonly string[]).includes(read.phases['12'].status),
          `run ${runStatus} / record ${recordStatus} / probe gone: a reader still saw `
          + `"${read.phases['12'].status}". The record is a claim; the probe is the fact.`);
      }
    }
    assert.equal(cells, RUN_STATUSES.length * PHASE_IN_FLIGHT.length);
    assert.equal(cells, 36, 'a status was added to the vocabulary without being added here');
  } finally { probe.restore(); dir.cleanup(); }
});

test('clause 3: a record over a process that still HOLDS WORK is left standing', () => {
  // The other direction, and the one that costs a working session: a `running`
  // or `stopped` child is still there, and for `stopped` it is recoverable with
  // one `kill -CONT` — the remedy reconcile prints on the same screen. A settle
  // that contradicted that advice would be a second lie, not a fix.
  //
  // **`zombie` moved out of this set in P7 (B2).** It was here because the
  // filter asked `!== 'gone'`, which is a question about EXISTENCE, and the
  // rationale written beside it only ever covered `stopped` ("recoverable with
  // one kill -CONT"). A `Z` process has exited: no file descriptors, no cwd, no
  // next instruction — only its parent's `wait()` is outstanding. It cannot be
  // editing the tree, so a record claiming work in flight over one is a claim
  // that has outlived its fact, which is the whole of B2(a). The rule is now
  // "holds work" (`pidHoldsWork`), not "exists"; the zombie half is asserted in
  // the settle matrix and in `phase-liveness.test.ts`.
  const dir = scratch();
  try {
    for (const answer of ['running', 'stopped'] as const) {
      const probe = withProbe(answer);
      try {
        for (const runStatus of RUN_STATUSES) {
          for (const recordStatus of PHASE_IN_FLIGHT) {
            const saved = savedRun(dir.root, runStatus, recordStatus, probe.pid);
            const read = loadRun(dir.root, 'demo', saved.id);
            assert.equal(read?.phases['12'].status, recordStatus,
              `run ${runStatus} / record ${recordStatus} / probe ${answer}: the record was settled `
              + 'over a process that is still there');
          }
        }
      } finally { probe.restore(); }
    }

    // ...and the read path settles an EXITED one, over every run status — the
    // same rule clause 3 states for `gone`, now reaching the state that used to
    // slip through it.
    const zombie = withProbe('zombie');
    try {
      for (const runStatus of RUN_STATUSES) {
        for (const recordStatus of PHASE_IN_FLIGHT) {
          const saved = savedRun(dir.root, runStatus, recordStatus, zombie.pid);
          const read = loadRun(dir.root, 'demo', saved.id);
          assert.equal(read?.phases['12'].status, 'interrupted',
            `run ${runStatus} / record ${recordStatus} / probe zombie: a reader still saw work in `
            + 'flight over a process that had already exited');
        }
      }
    } finally { zombie.restore(); }
  } finally { dir.cleanup(); }
});

test('clause 3: the run-status axis is the whole vocabulary, and IN_FLIGHT is a subset', () => {
  // The matrix is only exhaustive if its axis is. A status added to RunStatus
  // and not here would silently narrow every assertion above.
  for (const status of IN_FLIGHT) {
    assert.ok(RUN_STATUSES.includes(status), `IN_FLIGHT names ${status}, which the matrix does not cover`);
  }
  assert.equal(new Set(RUN_STATUSES).size, RUN_STATUSES.length, 'no duplicates in the axis');
});
