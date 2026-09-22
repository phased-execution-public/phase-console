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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IN_FLIGHT, PHASE_IN_FLIGHT, loadRun, newRun, phaseRecord, runFile, saveRun,
  type PhaseStatus, type RunState, type RunStatus,
} from '../server/runner/state.ts';
import { setPsReader, forgetPid, type ProcessState } from '../server/pid.ts';
import { newLaneSignals } from '../server/runner/liveness.ts';
import { Runner } from '../server/runner/runner.ts';
import {
  RESUME_CACHE_COLD_MS, RESUME_FRESH_MIN_CONTEXT, RESUME_FRESH_PARTIAL_REASONS, tokensLabel,
} from '../server/runner/usage.ts';
import { sessionLedgerDefect, sessionRecordOf } from '../server/runner/session-record.ts';
import type { SpawnOutcome } from '../server/runner/spawn.ts';
import { ENDED_BY, SESSION_MODES, START_DOORS } from '../shared/run-lifecycle.js';
import { fixtureJournals, fixtureRuns } from './journal-fixture.ts';

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
    'the one-turn `claude -p` MCP probe, ended when it answers or times out. Since zero-touch-console '
    + 'phase 7 the ending is signals.ts\'s killLadder() with the interrupt rung off — SIGCONT, SIGTERM '
    + 'to the GROUP so the CLI runs its SessionEnd hook, then the SIGKILL the npx shims need (the probe '
    + 'is spawned detached, because it is the one console child guaranteed to have started MCP '
    + 'servers) — and what is left here is the no-group fallback (a spawn seam that gave us no pid)',
  'runner/auth.ts':
    'the `claude auth status` probe, killed at its 20s timeout',
  'shell.ts':
    'the command seam\'s own timeout, on a child it started itself a moment ago. Deliberately NOT '
    + 'the signal ladder: these are git, du, gh and a setup `sh -c` — piped, short-lived, no turn to '
    + 'close and no session to end, and the ladder exists for a `claude -p` whose SIGINT writes the '
    + 'result that books the turn. The one `claude` this seam must never take is spawn.ts\'s, which '
    + 'stays outside it by name (with pid.ts\'s `ps`) in the two lints below',
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

/* ------------------------------------------------------------------ *
 * The session ledger's one door (zero-touch-console phase 4, SES-6)
 * ------------------------------------------------------------------ */

test('clause 1: every claude -p session under runner/ goes through the one door, and the door writes the record', () => {
  // Two of seven spawn sites wrote `phase.session`, one wrote three fields
  // under another name, and four wrote nothing: 50 of the 138 sessions the
  // audit's six plans spawned were invisible to every census built on the
  // record. The door is `RunnerBase.spawnSession`; a new site that calls the
  // spawner directly would be a session with no record again.
  const spawns = hits(/\bspawnClaude\s*\(|\bdeps\.spawn\b/).filter((hit) => hit.startsWith('runner/'));
  assert.deepEqual(filesOf(spawns), ['runner/runner-base.ts'],
    'a session is being spawned outside spawnSession — route it through the door, which writes its phase.session');
  assert.equal(spawns.length, 1, `exactly one raw spawn, inside the door (${spawns.join(', ')})`);

  const writers = hits(/record\(\s*'phase\.session'/);
  assert.deepEqual(writers.map((hit) => hit.split(':')[0]), ['runner/runner-base.ts'],
    'phase.session has ONE writer, so it has one shape (session-record.ts sessionRecordOf)');

  // And every purpose the vocabulary names is a site that really calls it —
  // the positive half, so a comment-skipping bug cannot pass the lint empty.
  for (const mode of SESSION_MODES) {
    const sites = hits(new RegExp(`spawnSession\\(phase, '${mode}'`));
    assert.equal(sites.length, 1, `SESSION_MODES names '${mode}', and exactly one spawn site says it (${sites.join(', ')})`);
  }
});

test('clause 1: no session record the ledger writes can be the 4.1.0 defect — and the fixture still shows the defect it replaced', () => {
  // The predicate: a session that ran over a minute, did no turn, and was
  // ended by nobody named. Every record the 4.1.0 console wrote for a session
  // it SIGTERMed had that shape; the journal fixture keeps them as the
  // before-picture (build.mjs copies them raw).
  const fixtureSessions = fixtureJournals()
    .flatMap((journal) => journal.lines)
    .filter((line) => line.event === 'phase.session')
    .map((line) => (line.data ?? {}) as Record<string, unknown>);
  assert.ok(fixtureSessions.length >= 80, `the fixture's session records are readable (${fixtureSessions.length})`);
  assert.equal(fixtureSessions.filter(sessionLedgerDefect).length, 28,
    'the 4.1.0 before-picture: 28 records of more than a minute, zero turns and no ending (inventory.json)');

  // The after-picture: a zero-turn session of 61 s, ended every way there is,
  // through the one function that builds the record — never the defect.
  for (const endedBy of [...ENDED_BY, undefined]) {
    const outcome = {
      signal: { code: 130 }, costUsd: 0, turns: 0, resultText: '', durationMs: 61_000, argv: ['--print'], injected: 0,
      ...(endedBy ? { endedBy } : {}),
    } as SpawnOutcome;
    const record = sessionRecordOf({ mode: 'phase', request: { prompt: 'BOOT', cwd: '/tmp' }, outcome });
    assert.equal(sessionLedgerDefect(record), false, `a record ended by ${endedBy ?? '(nothing said)'} still names its ending`);
    assert.ok(record.endedBy, 'endedBy is never blank');
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

/* ================================================================== *
 * The plan that drives this work is held to the tree it names
 * ================================================================== */

/**
 * `docs/plans/zero-touch-console.md` lives in the superproject that carries
 * this repository as a submodule, and every one of its 23 phases names the
 * suites that prove it. Chapter 14 of the audit found gates citing files that
 * did not exist (`test/decisions.test.ts`) — a §Verification line pointing at
 * a file that is not there is a phase that can never go green, and the runner
 * only learns it at boarding. So: every suite path a §Verification line names
 * either resolves in this tree, or the plan marks it `(new)` — on the same
 * line, or in a sentence that names the file and says `(new)` (the plan keeps
 * one such sentence in its closing section). Skipped where the plan is not
 * beside this checkout (a hub copy, a plain clone, the free tree): the lint is
 * about THIS plan, and only the superproject has it.
 */
test('every suite path the zero-touch-console plan names resolves, or the plan marks it (new)', (t) => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  let dir = repo;
  let plan: string | null = null;
  for (let i = 0; i < 4 && !plan; i++) {
    dir = dirname(dir.replace(/\/$/, ''));
    const candidate = join(dir, 'docs', 'plans', 'zero-touch-console.md');
    if (existsSync(candidate)) plan = candidate;
  }
  if (!plan) { t.skip('docs/plans/zero-touch-console.md is not beside this checkout'); return; }
  // The free tree is materialized INSIDE this checkout (`.free-preview-*`), so the walk above finds the
  // plan from there too — and the plan names Pro suites that tree does not carry. `free/` is a proPath,
  // so its manifest's absence is the free tree's own signature.
  if (!existsSync(join(repo, 'free', 'manifest.json'))) { t.skip('the free tree: the plan names Pro suites it does not carry'); return; }

  const lines = readFileSync(plan, 'utf8').split('\n');
  const newSentences = lines.filter((line) => /\(new\)/.test(line));
  const markedNew = (path: string): boolean => {
    const base = path.split('/').pop()!.replace(/\.test\.ts$/, '');
    return newSentences.some((line) => line.includes(path) || line.includes(`\`${base}\``));
  };
  const missing: string[] = [];
  let named = 0;
  lines.forEach((line, i) => {
    if (!/^\s*- `/.test(line)) return;
    for (const m of line.matchAll(/(?:node --test|bats)\s+((?:viewer\/test|tests)\/[\w./-]+\.(?:test\.ts|bats))/g)) {
      named++;
      const path = m[1];
      if (existsSync(join(repo, path))) continue;
      if (markedNew(path)) continue;
      missing.push(`${path} (plan line ${i + 1})`);
    }
  });
  assert.ok(named >= 100, `the plan names ${named} suite paths — the §Verification lines are not being read`);
  assert.deepEqual(missing, [],
    'these §Verification suite paths neither exist nor are marked `(new)` in the plan — a phase citing one can never go green');
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 5: one resume gate, one wait expression
 * ------------------------------------------------------------------ */

/**
 * Every read of `record.resumeSessionId` under `runner/`, by file, with why it is
 * allowed — asserted as an exact table, so a new reader fails and a removed one
 * must delete its entry (the `.kill(` rule's shape). The rule behind it: the id
 * a `--resume` would take is only ever INPUT to `resumableSession`, the gate that
 * reads the gone stamp, the transcript's account and the session's presence.
 * The drive loop's boarding once read it straight into a spawn (SLF-10), and no
 * `--resume` path read presence at all (REG-1).
 */
const RESUME_ID_READERS: Record<string, { count: number; why: string }> = {
  'runner/runner-attempt.ts': {
    count: 2,
    why: 'attemptSession hands it to resumableSession (the gate) before anything spawns; the shutdown '
      + 'checkpoint\'s finishedReason only phrases a sentence with it',
  },
  'runner/runner-control.ts': { count: 1, why: 'resumeWithInstruction hands it to resumableSession before the spawn' },
  'runner/runner-loop.ts': {
    count: 3,
    why: 'the wait-resume bookkeeping asks whether one is named — a gone own-session is journalled, never re-armed; '
      + 'the boarding hands a hint-less resume to resumableSession before its prompt is final, so a session not '
      + 'worth resuming boards fresh with the resume brief (autopilot-token-drain phase 4); and the boot mail '
      + 'names the session it is handed to on the mailbox journal line — a decoration on a record, reaching no '
      + 'spawn and no --resume (many-plans-one-repo phase 11)',
  },
  'runner/runner.ts': {
    count: 3,
    why: 'the ladder\'s own-session availability (the hint still boards through composeBrief\'s gate), an errand '
      + 'sentence, and the widen-rule card\'s answer, which re-boards through the same hint and the same gate (phase 9)',
  },
  'runner/situation.ts': { count: 2, why: 'the evidence a situation is classified from — display, no spawn' },
  'runner/state.ts': { count: 1, why: 'isSessionGone, the predicate the gate itself reads' },
};

test('clause 1: every --resume passes the one gate, the gate reads presence, and the id reaches no spawn around it', () => {
  // The door admits only a vetted resume: `SessionRequest` omits the raw string.
  const core = SOURCES.find((s) => s.rel === 'runner/runner-core.ts')!.lines.join('\n');
  assert.match(core, /export type SessionRequest = Omit<SpawnRequest, 'resume'> & \{ resumeFrom\?: VettedResume \}/);
  const base = SOURCES.find((s) => s.rel === 'runner/runner-base.ts')!.lines.join('\n');
  assert.match(base, /protected async spawnSession\(\s*phase: number, mode: SessionMode, request: SessionRequest,/);

  // …and a vetted resume is minted in exactly one place — the gate — which reads presence.
  const mints = hits(/as VettedResume\b/);
  assert.deepEqual(filesOf(mints), ['runner/runner-control.ts'], `one mint, in the gate (${mints.join(', ')})`);
  assert.equal(mints.length, 1);
  const control = SOURCES.find((s) => s.rel === 'runner/runner-control.ts')!.lines;
  const start = control.findIndex((line) => /protected resumableSession\(record: PhaseRecord, sessionId: string \| undefined\): ResumeVerdict/.test(line));
  assert.ok(start >= 0, 'resumableSession returns the verdict');
  const body = control.slice(start, start + 40).join('\n');
  assert.match(body, /this\.deps\.sessionPresence\?\.\(sessionId\)/, 'the gate reads the registry\'s presence');
  assert.match(body, /isSessionGone\(record, sessionId\)/, 'and the gone stamp');
  assert.ok(Number(mints[0].split(':')[1]) - 1 > start && Number(mints[0].split(':')[1]) - 1 < start + 40, 'the mint is inside it');

  // Every read of the id a --resume would take, by file.
  const reads = hits(/\.resumeSessionId\b(?!\s*(?:=(?!=)|\?\?=))/)
    .filter((hit) => hit.startsWith('runner/'))
    .filter((hit) => {
      const [rel, line] = hit.split(':');
      const text = SOURCES.find((s) => s.rel === rel)!.lines[Number(line) - 1];
      return !/\bdelete\b/.test(text);
    });
  const byFile: Record<string, number> = {};
  for (const hit of reads) byFile[hit.split(':')[0]] = (byFile[hit.split(':')[0]] ?? 0) + 1;
  assert.deepEqual(byFile, Object.fromEntries(Object.entries(RESUME_ID_READERS).map(([f, v]) => [f, v.count])),
    'record.resumeSessionId is read somewhere new, or an allowed read is gone. A spawn path must hand it to '
    + 'resumableSession; a removed read must delete its RESUME_ID_READERS entry.\n'
    + Object.entries(RESUME_ID_READERS).map(([f, v]) => `  ${f} ×${v.count} — ${v.why}`).join('\n')
    + `\nfound: ${reads.join(', ')}`);
});

/**
 * autopilot-token-drain phase 4 amended the outcome-protocol invariant. It said
 * "the resume is ALWAYS the phase's own session — never a fresh boot", and a
 * session 681k tokens large and four hours cold was resumed by it for $27. The
 * amendment has to read the SAME wherever a session or a maintainer learns it,
 * and with the numbers the gate really uses — so the sentence is built here from
 * `runner/usage.ts`, and a threshold changed in code without its docs fails.
 */
test('the resume invariant reads the same in CLAUDE.md, SKILL.md and console-surface.md — with the numbers the gate uses', () => {
  const sentence = `a session is resumed only while it is worth resuming: one that ended at ≥ ${tokensLabel(RESUME_FRESH_MIN_CONTEXT)} `
    + `tokens of context and is cold (idle ≥ ${RESUME_CACHE_COLD_MS / 60_000} min) or under another account, that declared `
    + `\`partial --reason ${RESUME_FRESH_PARTIAL_REASONS.join('|')}\`, or that the console checkpointed is boarded FRESH `
    + 'with the resume brief instead';
  const repo = new URL('../../', import.meta.url);
  for (const doc of ['CLAUDE.md', 'SKILL.md', 'references/console-surface.md']) {
    const text = readFileSync(new URL(doc, repo), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes(sentence), `${doc} does not state the amended resume invariant verbatim:\n  ${sentence}`);
  }
  assert.doesNotMatch(readFileSync(new URL('CLAUDE.md', repo), 'utf8'), /resume is ALWAYS the phase's own/,
    'the unamended invariant is gone');
});

test('the wait budget is evaluated through ONE expression — at park and at resume, and nowhere else', () => {
  // WAI-3: the budget lived in four copies of one arithmetic, each a little different.
  const callers = hits(/\bevaluateWait\(\{/);
  assert.deepEqual(filesOf(callers), ['runner/runner-attempt.ts', 'runner/runner-loop.ts', 'service-base.ts', 'service-runs.ts'],
    `evaluateWait callers: parkWaiting, the boarding, the overdue ruling, the unsupervised twin (${callers.join(', ')})`);
  assert.equal(callers.length, 4, callers.join(', '));
  // …and no second copy of the arithmetic: the budget constant and the per-phase
  // cap are read in wait-budget.ts, the directive's sentence and the re-exports.
  const budgetMath = hits(/DEFAULT_WAIT_BUDGET_MS\s*[-+*/<>]|[-+*/<>]\s*DEFAULT_WAIT_BUDGET_MS|WAIT_MAX_PER_PHASE\s*[<>]|[<>]=?\s*WAIT_MAX_PER_PHASE|parkedMs\s*>=\s*DEFAULT_WAIT_BUDGET_MS/)
    .filter((hit) => !hit.startsWith('runner/wait-budget.ts'));
  assert.deepEqual(budgetMath, [], 'the budget is arithmetic in wait-budget.ts alone');
});

/**
 * WAI-6 — no loaded run holds a `waiting` record whose `parkedUntil` is past
 * while the run carries no clock. Over the phase-2 fixture, through the real
 * loader: each such record is either RE-ARMED (the run's clock read from the
 * record) or SETTLED (`pending` with the declaration intact, or `interrupted`
 * on a run that is over), and `phase.wait-settled` says which. The fixture
 * holds the audit's own case — `customer-app-ios-release` p4, `paused` by the
 * operator, 189 hours past its clock — raw.
 */
test('WAI-6: no fixture run loads with a waiting record past its clock and no run clock — re-armed or settled, and journalled', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-wai6-fixture-'));
  try {
    const runs = fixtureRuns();
    let raw = 0;
    let settledOrRearmed = 0;
    for (const { slug, runId, state } of runs) {
      const phases = Object.values((state.phases ?? {}) as Record<string, { status?: string; parkedUntil?: string }>);
      const stale = phases.filter((r) => r.status === 'waiting' && r.parkedUntil && Date.parse(r.parkedUntil) < Date.now());
      if (stale.length && !state.waitUntil) raw++;
      const target = runFile(root, slug, runId);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(state));
      const loaded = loadRun(root, slug, runId);
      assert.ok(loaded, `${slug}/${runId} did not load`);
      for (const record of Object.values(loaded.phases)) {
        if (record.status !== 'waiting' || !record.parkedUntil) continue;
        if (Date.parse(record.parkedUntil) >= Date.now()) continue;
        assert.ok(loaded.waitUntil,
          `${slug}/${runId} p${record.phase}: still waiting until ${record.parkedUntil} with state.waitUntil null — nothing will ever fire it`);
      }
      if (stale.length && !state.waitUntil) {
        const lines = readFileSync(join(dirname(runFile(loaded.root, slug, runId)), `run-${runId}.jsonl`), 'utf8')
          .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; data?: { to?: string } });
        const which = lines.filter((line) => line.event === 'phase.wait-settled');
        assert.ok(which.length >= 1, `${slug}/${runId}: the settlement was not journalled`);
        assert.ok(which.every((line) => ['rearmed', 'pending', 'interrupted'].includes(line.data?.to ?? '')));
        settledOrRearmed++;
      }
    }
    assert.ok(raw >= 1, 'the fixture is the evidence: at least one raw stale waiting record went in');
    assert.equal(settledOrRearmed, raw);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * WAI-9 — every licence journals. `consumeDeclaration` is the one deleter of
 * `record.declared`; a site that spends testimony either hands it a journal
 * (the third argument) or writes `DECLARATION_CONSUMED_EVENT` itself within
 * the next few lines. `settleStoredWaitTimeout` returns the spend for ITS one
 * caller to pair, and that caller is held here too.
 */
test('WAI-9: every consumeDeclaration( site is paired with phase.declaration-consumed — a sink, or the line beside it', () => {
  const sites = hits(/\bconsumeDeclaration\(/);
  const unpaired: string[] = [];
  const shapes = { sink: 0, beside: 0, returned: 0 };
  for (const hit of sites) {
    const [rel, lineNo] = hit.split(':');
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    const idx = Number(lineNo) - 1;
    const text = lines[idx];
    if (/export function consumeDeclaration\(/.test(text)) continue; // the definition
    // The call, possibly wrapped: take the text from the call to the closing paren.
    const window = lines.slice(idx, idx + 3).join(' ');
    const args = /consumeDeclaration\(([^;]*?)\)(?:;|\s*$|\s*\))/.exec(window)?.[1] ?? '';
    const passesSink = args.split(',').length >= 3;
    const pairedBeside = lines.slice(idx, idx + 5).some((l) => l.includes('DECLARATION_CONSUMED_EVENT'));
    const returnsForCaller = /^\s*const spent = consumeDeclaration\(record, 'new-outcome'\);/.test(text)
      && lines.slice(Math.max(0, idx - 40), idx).some((l) => /export function settleStoredWaitTimeout\(/.test(l));
    if (passesSink) shapes.sink++; else if (pairedBeside) shapes.beside++; else if (returnsForCaller) shapes.returned++;
    if (!passesSink && !pairedBeside && !returnsForCaller) unpaired.push(hit);
  }
  assert.deepEqual(unpaired, [], `a declaration is spent here with no journal line: ${unpaired.join(', ')}`);
  assert.ok(sites.length >= 8, `the licences have callers (${sites.length})`);
  // Not vacuous: all three shapes exist today (the sink form, the paired line, the one returned spend).
  assert.ok(shapes.sink >= 3 && shapes.beside >= 3 && shapes.returned === 1, JSON.stringify(shapes));
  // …and the one site that returns its spend has its caller pair it.
  const callers = hits(/\bsettleStoredWaitTimeout\(/).filter((hit) => !hit.startsWith('runner/state.ts'));
  assert.deepEqual(filesOf(callers), ['service-base.ts']);
  for (const hit of callers) {
    const [rel, lineNo] = hit.split(':');
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    assert.ok(lines.slice(Number(lineNo) - 1, Number(lineNo) + 4).some((l) => l.includes('DECLARATION_CONSUMED_EVENT')),
      `${hit}: the returned spend is not journalled`);
  }
});

/**
 * SLF-4 / WAI-8 — an unsupervised `partial` re-boards through `prepareReboard`,
 * never `resetForRetry`: the reset that wipes the watchdog's bound is an
 * OPERATOR's press, and these two arms are driven from outside the console.
 */
test('SLF-4: the unsupervised partial arms never reach resetForRetry — prepareReboard keeps the bounds', () => {
  const functions: [string, RegExp][] = [
    ['service-runs.ts', /private async applyUnsupervisedOutcome\(/],
    ['runner/runner-control.ts', /async declareOutcome\(/],
  ];
  for (const [rel, head] of functions) {
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    const start = lines.findIndex((l) => head.test(l));
    assert.ok(start >= 0, `${rel}: ${head} found`);
    // The body runs to the next method at the same indentation.
    const indent = /^(\s*)/.exec(lines[start])![1];
    let end = start + 1;
    while (end < lines.length && !(new RegExp(`^${indent}(?:private |protected |async |public )*[a-zA-Z]+\\(`).test(lines[end]) && !/^\s*\*|^\s*\/\//.test(lines[end]))) end++;
    const body = lines.slice(start, end).join('\n');
    assert.ok(!/\bresetForRetry\(/.test(body), `${rel}: the unsupervised arm calls resetForRetry`);
    assert.ok(/\bprepareReboard\(/.test(body), `${rel}: the partial arm re-boards through prepareReboard`);
    assert.ok(/\bchargeDeclaration\(/.test(body), `${rel}: the arm charges the declarations ledger`);
  }
  // …and every resetForRetry caller says who asked.
  const resets = hits(/\bresetForRetry\(/).filter((hit) => !/runner\/state\.ts/.test(hit));
  for (const hit of resets) {
    const [rel, lineNo] = hit.split(':');
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    const window = lines.slice(Number(lineNo) - 1, Number(lineNo) + 3).join(' ');
    // `press ? 'operator' : 'console'` is phase 9's word (RCV-3): a Retry whose
    // actor is a person's press clears the bounds; the healer's or a watch
    // landing's carries them, exactly as it carries the streak.
    assert.match(window, /by: '(?:operator|console)'|by: (?:opts\.by === 'operator'|press) \? 'operator' : 'console'/, `${hit}: resetForRetry with no by`);
  }
  assert.ok(resets.length >= 7, `the reset has its callers (${resets.length})`);
});

/* ================================================================== *
 * SLF-1 / RCV-9 — every automatic start names its door, every
 * classification names who classified (zero-touch-console phase 7)
 * ================================================================== */

/**
 * The text of the argument list that begins at `open` (the index of a `(`),
 * spanning lines, with parentheses balanced. Strings are not parsed — the
 * same conservative posture as `hits()`: a paren inside a string literal
 * would truncate an argument list, and a truncated list fails the assertion
 * below LOUDLY rather than passing it.
 */
function argumentsFrom(lines: string[], lineIdx: number, open: number): string {
  let depth = 0;
  let out = '';
  for (let i = lineIdx; i < lines.length; i += 1) {
    const line = i === lineIdx ? lines[i].slice(open) : lines[i];
    for (const ch of line) {
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) return out; }
      out += ch;
    }
    out += '\n';
    if (out.length > 20_000) break;
  }
  return out;
}

/**
 * Every `startRun(` CALL under `server/`, with the door its options name.
 *
 * Fourteen doors are the census (`START_DOORS`); `operator` is the press. A
 * site names its door one of three ways, and the lint reads all three: a
 * literal `doorActor('<door>', …)`; `pressActor(…)` for a person's press; or
 * an actor THREADED from its caller — an identifier the same file built with
 * `doorActor('<door>'…)`, a helper that returns one, or the method's own
 * `actor: StartActor` parameter (a relay verb such as `retryPhase`, whose
 * door is whoever called it). Anything else is an unnamed start, which is the
 * thing the audit found 324 of.
 */
function startSites(): { site: string; door: string }[] {
  const out: { site: string; door: string }[] = [];
  for (const { rel, lines } of SOURCES) {
    const file = lines.join('\n');
    const built = new Map<string, string>();
    for (const m of file.matchAll(/const (\w+) = (?:\([^)]*\)(?::\s*\w+)?\s*=>\s*)?doorActor\('([a-z-]+)'/g)) built.set(m[1], m[2]);
    const relay = /\bactor:\s*StartActor\b/.test(file);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const at = line.indexOf('startRun(');
      if (at < 0) return;
      // Not calls: the definition, the abstract declaration, the dep wiring.
      if (/\b(async|abstract)\s+startRun\(|startRun:\s*\(/.test(line)) return;
      const args = argumentsFrom(lines, i, at + 'startRun'.length);
      const site = `${rel}:${i + 1}`;
      const literal = /\bdoorActor\(\s*'([a-z-]+)'/.exec(args);
      if (literal) { out.push({ site, door: literal[1] }); return; }
      if (/\bpressActor\(/.test(args)) { out.push({ site, door: 'operator' }); return; }
      const threaded = /\bactor:\s*(\w+)\b/.exec(args);
      if (threaded && built.has(threaded[1])) { out.push({ site, door: built.get(threaded[1])! }); return; }
      if (threaded && threaded[1] === 'actor' && relay) { out.push({ site, door: "the caller's" }); return; }
      out.push({ site, door: '(unnamed)' });
    });
  }
  return out.sort((a, b) => a.site.localeCompare(b.site));
}

test('SLF-1: every startRun( site names its door, and the doors named are the census', () => {
  const sites = startSites();
  const unnamed = sites.filter((s) => s.door === '(unnamed)').map((s) => s.site);
  assert.deepEqual(unnamed, [], `startRun( sites naming no door: ${unnamed.join(', ')}`);
  const words = new Set([...START_DOORS, 'operator', "the caller's"]);
  const unknown = sites.filter((s) => !words.has(s.door));
  assert.deepEqual(unknown, [], `doors that are not in START_DOORS: ${unknown.map((s) => `${s.site}=${s.door}`).join(', ')}`);
  // The census, site by site — a new door site must be added here by name,
  // and a site that stops naming its door is caught above.
  const census = Object.fromEntries(sites.map((s) => [s.site.replace(/:\d+$/, ''), s.door]));
  assert.deepEqual(
    sites.map((s) => `${s.site.replace(/:\d+$/, '')} → ${s.door}`).sort(),
    [
      'api/routes.ts → operator',
      'converge.ts → converge-relaunch',
      'service-base.ts → boot-readopt',
      'service-base.ts → pty-continue',
      'service-base.ts → wait-clock',
      'service-base.ts → wait-clock',
      // Three heal doors since phase 10: the reboard vehicle, and the two
      // stopped-run resource rungs that relaunch after moving the run — the
      // account switch and the budget raise — each under `converge-heal`.
      'service-recovery.ts → converge-heal',
      'service-recovery.ts → converge-heal',
      'service-recovery.ts → converge-heal',
      'service-recovery.ts → recovery-continue',
      'service-recovery.ts → watch-landed',
      "service-runs.ts → the caller's",
      "service-runs.ts → the caller's",
      'service-runs.ts → outcome-inbox',
      'service.ts → mcp-require-timeout',
    ].sort(),
    `the startRun census moved: ${JSON.stringify(census)}`,
  );
  // Every `startRun` door in START_DOORS is opened by some site — the five
  // that spawn some other way (the probe, the preflight, the reviewer,
  // ultrareview, the pty agent) name themselves on `session.start` /
  // `phase.session-start` instead and are held by the tests of those files.
  const opened = new Set(sites.map((s) => s.door));
  for (const door of START_DOORS.slice(0, 9)) assert.ok(opened.has(door), `no startRun( site opens ${door}`);
  // …and the relay verbs are the only place an actor is threaded rather than named.
  const relays = hits(/\bactor: actor \?\? unattributedActor\(/);
  assert.deepEqual(filesOf(relays), ['service-runs.ts'], `relays: ${relays.join(', ')}`);
});

/**
 * RCV-6 (zero-touch-console phase 10) — a rung is settled through ONE door per
 * side, and the door writes the journal line with the whole payload. All 132
 * `phase.rung-settled` payloads the audit read said `{outcome, rung}` and
 * nothing else; twenty-five bare `settleRung(` sites each wrote (or forgot)
 * their own line. The definition, the two doors, the attempt-end backstop and
 * the MCP flip's in-place settle are the whole allowed set — by file and
 * count, failing in either direction so a reason cannot rot.
 */
const SETTLE_SITES: Record<string, { count: number; why: string }> = {
  'runner/ladder.ts': { count: 3, why: 'the two definitions, and `settleRung` handing the newest open rung to `settleRungRecord` — the one writer of `outcome`' },
  'runner/runner-base.ts': { count: 2, why: "the runner's door (`settleOpenRung`) and its attempt-end backstop (`settleRungsAfterAttempt`), both writing `phase.rung-settled` through `rungSettledPayload`" },
  'service-recovery.ts': { count: 1, why: "the service's door (`settleRungOn`), writing the same payload on the stored run's journal" },
  'runner/mcp-park.ts': { count: 1, why: "the `require` flip settles the `wait-heal` rung the healer accounted while the clock ran, in place, and journals it through the caller's sink" },
};

test('RCV-6: settleRung and settleRungRecord are called only at the doors, and every phase.rung-settled line is built from rungSettledPayload', () => {
  const calls = hits(/\bsettleRung(?:Record)?\(/);
  const byFile = new Map<string, number>();
  for (const hit of calls) {
    const file = hit.split(':')[0];
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  // The definition file's own `export function` lines are calls to the
  // pattern's eye; they are the definitions, counted in its three.
  assert.deepEqual([...byFile.keys()].sort(), Object.keys(SETTLE_SITES).sort(),
    `settleRung callers moved: ${[...byFile.entries()].map(([f, n]) => `${f}×${n}`).join(', ')}`);
  for (const [file, { count }] of Object.entries(SETTLE_SITES)) {
    assert.equal(byFile.get(file), count, `${file}: ${byFile.get(file)} settle sites, ${count} allowed`);
  }
  // …and no `phase.rung-settled` line is composed by hand any more: every
  // append of it spreads `rungSettledPayload(`.
  const lines = hits(/'phase\.rung-settled'/);
  assert.ok(lines.length >= 4, `the writers are visible (${lines.join(', ')})`);
  for (const hit of lines) {
    const [rel, lineNo] = hit.split(':');
    const src = SOURCES.find((f) => f.rel === rel)!.lines;
    // A READER of the line composes nothing: the run ledger's projection
    // (`analysis/ledger.ts`, zero-touch phase 19) names the event in a `case`
    // to read the payload back. Only a comparison is let through — any other
    // mention is still held to the one payload builder.
    if (/\bcase\s+'phase\.rung-settled'\s*:|===\s*'phase\.rung-settled'/.test(src[Number(lineNo) - 1])) continue;
    const window = src.slice(Number(lineNo) - 1, Number(lineNo) + 2).join('\n');
    assert.match(window, /rungSettledPayload\(/, `${hit}: a settlement line not built from rungSettledPayload`);
  }
});

/**
 * RCV-9 — every `phase.situation` and `phase.rung` append carries `by`. The
 * runner's climb always did (`drive` · `outcome` · `closed`); the healer's
 * 1 249 unsigned situation lines are what this holds shut.
 */
test('RCV-9: every phase.situation / phase.rung append carries by', () => {
  const sites = hits(/\b(record|append)\('phase\.(situation|rung)'/);
  assert.ok(sites.length >= 4, `the writers are visible (${sites.join(', ')})`);
  for (const hit of sites) {
    const [rel, lineNo] = hit.split(':');
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    const idx = Number(lineNo) - 1;
    const open = lines[idx].indexOf('(', lines[idx].indexOf("'phase."));
    const args = open >= 0 ? argumentsFrom(lines, idx, open) : lines.slice(idx, idx + 4).join('\n');
    // The line before the open paren too — `this.record('phase.situation', {` has its paren before the literal.
    const call = argumentsFrom(lines, idx, Math.max(0, lines[idx].lastIndexOf('(', lines[idx].indexOf("'phase.")))) || args;
    assert.match(call, /[{,\s]by[,:}\s]/, `${hit}: the append carries no by`);
  }
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 8: accounts — the account on every start, the
 * mark before every switch, no dead setter, a token's reach scoped
 * ------------------------------------------------------------------ */

/**
 * ACT-1 — every `startRun(` site passes `accountId`, or passes `resumeRunId`
 * (from which `Service.startRun` resolves the stored run's account before any
 * door is asked — ONE resolver), or is named here with a reason. Nine of the
 * twelve automatic doors omitted the field, so the quota and auth doors judged
 * the machine login while the runner resumed under `state.accountId`.
 */
const ACCOUNT_SITE_ALLOWLIST: Record<string, string> = {
  // The browser's launch form names the account itself (`accountId` in the
  // body, `auto` resolved once against the meters) and may also carry a
  // `resumeRunId`; a FRESH start with neither is the machine login by design.
  'api/routes.ts': 'the one door a person opens: the body names the account, or the machine login is meant',
};

test('ACT-1: every startRun( site passes accountId or resumeRunId, or is allowlisted with a reason', () => {
  const unnamed: string[] = [];
  let sites = 0;
  for (const { rel, lines } of SOURCES) {
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const at = line.indexOf('startRun(');
      if (at < 0) return;
      if (/\b(async|abstract)\s+startRun\(|startRun:\s*\(/.test(line)) return;
      sites += 1;
      const args = argumentsFrom(lines, i, at + 'startRun'.length);
      if (/\baccountId\b/.test(args) || /\bresumeRunId\b/.test(args)) return;
      if (ACCOUNT_SITE_ALLOWLIST[rel]) return;
      unnamed.push(`${rel}:${i + 1}`);
    });
  }
  assert.ok(sites >= 13, `the startRun( sites are visible (${sites})`);
  assert.deepEqual(unnamed, [], `startRun( sites that name no account and resume no stored run: ${unnamed.join(', ')}`);
  // …and the resolver exists, in ONE place: the service reads the stored run's
  // account before the runner is asked.
  const resolver = hits(/options\.accountId === undefined && options\.resumeRunId/);
  assert.deepEqual(filesOf(resolver), ['service-runs.ts'], `the account resolver: ${resolver.join(', ')}`);
  // Every allowlisted file still exists and still calls startRun( — a stale
  // allowlist entry is a lie about the census.
  for (const rel of Object.keys(ACCOUNT_SITE_ALLOWLIST)) {
    assert.ok(SOURCES.some((s) => s.rel === rel && s.lines.some((l) => l.includes('startRun('))), `${rel} no longer calls startRun( — drop it from the allowlist`);
  }
});

/**
 * ACT-5 — every `trySwitchAccount(` call under `server/runner/` is preceded, in
 * the same file within the same arm, by a `leaveAccount(` call: the account is
 * marked BEFORE the switch, every time. The live wall was the one mover that
 * did not, and 16 of 17 lifetime switches ping-ponged.
 */
test('ACT-5: every trySwitchAccount( site is paired with a leaveAccount( before it', () => {
  const calls = hits(/\bthis\.trySwitchAccount\(/);
  assert.ok(calls.length >= 3, `the movers are visible (${calls.join(', ')})`);
  const unpaired: string[] = [];
  for (const hit of calls) {
    const [rel, lineNo] = hit.split(':');
    const lines = SOURCES.find((s) => s.rel === rel)!.lines;
    const idx = Number(lineNo) - 1;
    // Look back to the arm's opening — the nearest `case '…':` or the method's
    // own signature — and demand the mark inside it.
    let start = idx;
    while (start > 0 && !/^\s*case '[\w-]+':|^\s*(private|protected|public)?\s*(async\s+)?\w+\(.*\)[^;]*\{\s*$/.test(lines[start])) start -= 1;
    const arm = lines.slice(start, idx).join('\n');
    if (!/\bthis\.leaveAccount\(/.test(arm)) unpaired.push(hit);
  }
  assert.deepEqual(unpaired, [], `trySwitchAccount( sites with no leaveAccount( before them: ${unpaired.join(', ')}`);
  // The definition lives in one file, and the marks reach the facade through
  // one dep (`deps.leaveAccount`) — no site calls the facade around it.
  assert.deepEqual(filesOf(hits(/protected leaveAccount\(/)), ['runner/runner-control.ts']);
  assert.deepEqual(filesOf(hits(/deps\.leaveAccount\?\.\(/)), ['runner/runner-control.ts']);
  assert.deepEqual(hits(/onAccountLimited/), [], 'the three-of-four hook is gone; every mover goes through the one helper');
});

/**
 * ACT-3 — every SETTER the accounts facade exports has a caller under
 * `server/` that is not the facade itself. `setActiveProbe` had none, so the
 * poller's adaptive cadence was dead for as long as the seam existed.
 */
test('ACT-3: every exported setter on Accounts has a production caller', () => {
  const facade = SOURCES.find((s) => s.rel === 'accounts/index.ts')!;
  const setters: string[] = [];
  for (const line of facade.lines) {
    const m = /^  (?:async )?((?:set|mark|leave|retire|clear|note|add|begin|complete|remove|rename|start|stop|refresh)\w*)\(/.exec(line);
    if (m && !setters.includes(m[1])) setters.push(m[1]);
  }
  assert.ok(setters.includes('setActiveProbe') && setters.includes('leaveAccount') && setters.includes('retire') && setters.includes('clearRetired'),
    `the setters are visible: ${setters.join(', ')}`);
  const uncalled = setters.filter((name) => {
    const re = new RegExp(`\\baccounts\\.${name}\\(`);
    return !SOURCES.some((s) => !s.rel.startsWith('accounts/') && s.lines.some((l) => re.test(l)));
  });
  assert.deepEqual(uncalled, [], `Accounts setters nothing under server/ calls: ${uncalled.join(', ')}`);
});

/**
 * ACT-12 — a token account's secret rides the whole child process tree, so a
 * spawn that carries `--mcp-config` under a token account attaches only the
 * stdio servers the PLAN declares. Held statically: the secret is minted in
 * one place, the server set is scoped in one place before the preflight, and
 * the scoping journals itself.
 */
test('ACT-12: the token secret is minted once, and a token run\'s MCP set is scoped before it is probed or written', () => {
  const minted = hits(/CLAUDE_CODE_OAUTH_TOKEN:\s*token/);
  assert.deepEqual(minted, ['accounts/credentials.ts:234'.replace(/:\d+$/, `:${minted[0]?.split(':')[1]}`)],
    `the token env is produced in exactly one place: ${minted.join(', ')}`);
  assert.deepEqual(filesOf(minted), ['accounts/credentials.ts']);
  const attempt = SOURCES.find((s) => s.rel === 'runner/runner-attempt.ts')!.lines.join('\n');
  const resolve = attempt.slice(attempt.indexOf('protected async resolveMcp('));
  const scoped = resolve.indexOf('this.tokenScoped(');
  const probed = resolve.indexOf('this.deps.mcp.preflight(');
  assert.ok(scoped >= 0 && probed > scoped, 'resolveMcp scopes the ids for a token account BEFORE the preflight probes them');
  assert.ok(/this\.record\('run\.token-scope'/.test(attempt), 'the scoping journals run.token-scope');
  assert.ok(/log\.warn\('accounts\.token-scope'/.test(attempt), 'and a drop is a console log line');
  assert.deepEqual(filesOf(hits(/'run\.token-scope'/)), ['runner/runner-attempt.ts']);
});

/* ------------------------------------------------------------------ *
 * zero-touch-console phase 14: ONE auto-answer call site, deny list first
 * ------------------------------------------------------------------ */

test('AC-14 (QRL-6): exactly one auto-answer call site under server/ — the relay picks, the service relays from one place, and the deny list is read before any window', () => {
  // The console answering a question on a session's behalf used to be spread
  // over the classifier, the auto-grant block and a card's timeout — which is
  // how auto-grant came to answer the two rules the carve-out pinned for a
  // person. Now one function chooses an answer and one file calls it.
  const picks = hits(/\bpickAnswer\(/);
  assert.deepEqual(filesOf(picks), ['relay.ts'], `pickAnswer( is called outside the relay: ${picks.join(', ')}`);
  // The answers map a hook carries back is built in exactly one place.
  const built = hits(/\banswers:\s*byText\b/);
  assert.deepEqual(built, built.filter((hit) => hit.startsWith('relay.ts:')));
  assert.equal(built.length, 1, `the answers map is built ${built.length} times: ${built.join(', ')}`);
  // And the relay is entered from exactly one line: the hook's decision, which
  // both hooks (PreToolUse and PermissionRequest) reach.
  const entered = hits(/\brelayQuestion\(/).filter((hit) => !hit.startsWith('relay.ts:'));
  assert.deepEqual(filesOf(entered), ['service.ts']);
  assert.equal(entered.length, 1, `relayQuestion( is entered from ${entered.length} places: ${entered.join(', ')}`);
  const service = SOURCES.find((s) => s.rel === 'service.ts')!.lines.join('\n');
  assert.match(service, /decidePermissionRequest[\s\S]*?this\.decideToolUse\(body, runId, \{ mechanism: 'permission-request' \}\)/,
    'the PermissionRequest hook reaches the relay through the same decision as PreToolUse');

  // Deny list first: inside `relayQuestion`, the wall is read before a kept
  // answer is given and before a window is opened.
  const relay = SOURCES.find((s) => s.rel === 'relay.ts')!.lines.join('\n');
  const body = relay.slice(relay.indexOf('async relayQuestion('), relay.indexOf('/* ---------------- a person\'s answer'));
  const wall = body.indexOf('matchedDenyRule(');
  assert.ok(wall > 0, 'relayQuestion reads the deny list');
  for (const later of ['this.takeKept(', 'this.hold(', 'destructiveOption(', 'runStopped(']) {
    assert.ok(body.indexOf(later) > wall, `${later} comes after the deny list`);
  }
});

// ── SCH-3 — two schedulers of work read the raw presence ─────────────────────
// `sessions.presenceOfLock` is the registry's word about the session a lock
// NAMES, and `service-runs.ts` documents in its own comment why that word is
// unusable for a lane: a lane's lock outlives its attempt's session by design
// (the keepalive rewrites it every refresh, still naming a session that
// exited), so the raw answer is `ended` for a claim a run is actively holding.
//
// `lockPresenceFor` is the wrapper that knows this. `claimHolders` already went
// through it; the SCHEDULER's admission dep and CONVERGE's debris dep did not —
// the two places where `ended` means "take that lock away and start a second
// session in the same tree".
test('SCH-3: every presence dep goes through lockPresenceFor, never the raw registry', () => {
  const raw = hits(/presence\w*:\s*\(lock\w*\)\s*=>\s*this\.sessions\.presenceOfLock\(/);
  assert.deepEqual(raw, [],
    `a presence dep reads the raw registry instead of lockPresenceFor: ${raw.join(', ')}`);

  // The positive half, so the lint cannot pass by seeing nothing: both deps
  // exist and both name the wrapper.
  const wrapped = hits(/presence\w*:\s*\(lock\w*\)\s*=>\s*this\.lockPresenceFor\(/);
  assert.ok(wrapped.length >= 2, `expected the scheduler's and converge's deps: ${wrapped.join(', ')}`);
  const files = new Set(wrapped.map((hit) => hit.slice(0, hit.indexOf(':'))));
  assert.ok(files.has('service-base.ts'), `the scheduler's dep: ${wrapped.join(', ')}`);
  assert.ok(files.has('service-runs.ts'), `converge's dep: ${wrapped.join(', ')}`);
});

// ── LCK-6 — five spawn sites claimed UNQUALIFIED ─────────────────────────────
// The main attempt injects all four claim fields (`PE_OWNER`, `PE_SCOPE`,
// `PE_WORKTREE`, `PE_BRANCH`); the reviewer, the closeout, the repair and both
// resume sites injected the first two. A session's own `phase-lock.sh claim`
// therefore wrote a lock with no branch and no tree — which collides with
// EVERYTHING — and it stayed that way until the runner's keepalive rewrote it,
// up to a third of a lease into the run. Two isolated runs that should have
// carved cleanly serialised against each other for ten minutes, every time.
//
// One helper answers for every site, because the failure was five places
// agreeing about two fields and forgetting two.
test('LCK-6: every phase-scoped spawn builds its claim env from claimEnv', () => {
  // Scoped to `runner/`: the account probe, the MCP probe and the agent also
  // set `PE_OWNER`, and none of them claims a phase lock. Inside the runner,
  // one site may write the field — the helper — and that is the whole rule.
  const owners = hits(/PE_OWNER:/).filter((hit) => hit.startsWith('runner/'));
  assert.deepEqual(owners.map((hit) => hit.slice(0, hit.indexOf(':'))), ['runner/runner-base.ts'],
    `a runner spawn sets PE_OWNER outside claimEnv: ${owners.join(', ')}`);
  assert.equal(owners.length, 1, `claimEnv should be the only writer: ${owners.join(', ')}`);

  // The positive half, so the lint cannot pass by seeing nothing: the helper is
  // defined once, and every phase-scoped spawn spreads it.
  const built = hits(/protected async claimEnv\(/);
  assert.equal(built.length, 1, `claimEnv is defined ${built.length} times: ${built.join(', ')}`);
  const spread = hits(/\.\.\.\(await this\.claimEnv\(/);
  assert.ok(spread.length >= 6, `expected every phase-scoped spawn to spread it: ${spread.join(', ')}`);

  // And nothing sets PE_BRANCH/PE_WORKTREE beside it either — the pair is the
  // thing that was forgotten, so it may not be assembled a second way.
  const pair = hits(/PE_(BRANCH|WORKTREE):/).filter((hit) => hit.startsWith('runner/'));
  assert.deepEqual(pair.map((hit) => hit.slice(0, hit.indexOf(':'))), ['runner/runner-base.ts', 'runner/runner-base.ts'],
    `the claim pair is assembled outside claimEnv: ${pair.join(', ')}`);
});

// ── LCK-2 — a foreign takeover was journalled and then ignored ───────────────
// The keepalive is the only thing that ever learns its lock was taken. It
// journalled `phase.lock-lost`, cleared its own timer — and let the lane carry
// on editing the working tree another session now holds the claim to. The
// journal line was written for a person who was not there.
test('LCK-2: losing the lock stops the lane, it does not merely say so', () => {
  const runner = SOURCES.find((s) => s.rel === 'runner/runner.ts')!.lines.join('\n');
  const at = runner.indexOf("this.record('phase.lock-lost'");
  assert.ok(at > 0, 'the lock-lost arm is still here');
  // A window around the arm, because the stop is ordered BEFORE the journal
  // line on purpose: the line reports what the stop did.
  const arm = runner.slice(at - 1_600, at + 400);
  assert.match(arm, /this\.stopPhase\(/, 'the lock-lost arm stops the lane');
  assert.match(arm, /stopped: stopped\.ok/, 'and the journal line reports whether it could');
});
