/**
 * `engine.ts`'s own readings, and the environment it hands a script.
 *
 * Everything here was unpinned (parse-recovery-10): `readSessionPlan` had no
 * test at all, `readQaMode`'s failure paths had none, and the subprocess
 * environment had none — which is how it came to spread `process.env` whole for
 * as long as it did. `engine-parity.test.ts` compares the two PARSERS; nothing
 * compared these, and they are the layer between.
 *
 * No subprocess, no environment, no plan library: pure functions and one
 * exported env builder.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scriptEnv, readQaMode, readLint, readSessionPlan, readMemoryBlock,
  type EngineResult, type EngineOptions,
} from '../server/engine.ts';

const OPTS: EngineOptions = { scriptsDir: '/scripts', root: '/root' };

/** An engine result that answered normally. */
function ok(stdout: string): EngineResult {
  return { code: 0, stdout, stderr: '', ms: 1, timedOut: false };
}

/** Set env vars for one call and restore whatever was there. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ------------------------------------------------------------------ *
 * The subprocess environment
 * ------------------------------------------------------------------ */

test('an engine subprocess never inherits the console\'s own PE_*/PHASE_* vocabulary', () => {
  withEnv({
    PE_MCP_SERVERS: 'inherited-from-somewhere',
    PE_MCP_POLICY: 'require',
    PE_OWNER: 'somebody@else',
    PE_SESSION_ID: 'not-this-run',
    PHASE_EXEC_GATES: '1',
    PHASE_GATE_TIMEOUT: '600',
    CLAUDE_CODE_SESSION_ID: 'the-console-own-session',
  }, () => {
    const env = scriptEnv(OPTS);
    // PE_MCP_SERVERS absent (not empty) is what turns F15 off; inheriting one
    // decided F15 for a plan that never asked.
    assert.equal(env.PE_MCP_SERVERS, undefined, 'an inherited registry must not answer for this console');
    assert.equal(env.PE_MCP_POLICY, undefined, 'nor an inherited policy — same rule, same reason');
    assert.equal(env.PE_OWNER, undefined);
    assert.equal(env.PE_SESSION_ID, undefined);
    // The big one: --gate-status refuses to RUN a `cmd` gate unless this is set,
    // so inheriting it would EXECUTE a plan's shell on an ordinary display read.
    assert.equal(env.PHASE_EXEC_GATES, undefined, 'the gate opt-in must never arrive by inheritance');
    assert.equal(env.PHASE_GATE_TIMEOUT, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  });
});

test('the denial is a PREFIX rule, so the next PE_ variable is covered for free', () => {
  withEnv({ PE_SOMETHING_INVENTED_LATER: 'x', PHASE_ALSO_NEW: 'y' }, () => {
    const env = scriptEnv(OPTS);
    assert.equal(env.PE_SOMETHING_INVENTED_LATER, undefined);
    assert.equal(env.PHASE_ALSO_NEW, undefined);
  });
});

test('everything else the shell needs is still inherited', () => {
  withEnv({ PATH: '/usr/bin:/bin', HOME: '/home/somebody', LANG: 'en_US.UTF-8' }, () => {
    const env = scriptEnv(OPTS);
    assert.equal(env.PATH, '/usr/bin:/bin', 'a script with no PATH cannot run anything');
    assert.equal(env.HOME, '/home/somebody');
    assert.equal(env.LANG, 'en_US.UTF-8');
  });
});

test('the console states DOCS_ROOT and the quiet-output vars itself', () => {
  withEnv({ DOCS_ROOT: '/somewhere/else', NO_COLOR: undefined, TERM: 'xterm-256color' }, () => {
    const env = scriptEnv(OPTS);
    assert.equal(env.DOCS_ROOT, '/root', 'the root is the console\'s to declare, never inherited');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.TERM, 'dumb');
  });
});

test('a DELIBERATE opt-in still reaches the script — that is the whole distinction', () => {
  withEnv({ PHASE_EXEC_GATES: undefined }, () => {
    // The runner passes this explicitly for a gate check it means to run.
    const env = scriptEnv(OPTS, { env: { PHASE_EXEC_GATES: '1' } });
    assert.equal(env.PHASE_EXEC_GATES, '1', 'extra.env is applied AFTER the filter, on purpose');
  });
});

test('opts.mcpServers is set-but-empty when the console has none, absent when it says nothing', () => {
  withEnv({ PE_MCP_SERVERS: 'inherited' }, () => {
    // Set-but-empty is a real answer: a console with nothing registered.
    assert.equal(scriptEnv({ ...OPTS, mcpServers: [] }).PE_MCP_SERVERS, '');
    assert.equal(scriptEnv({ ...OPTS, mcpServers: ['a', 'b'] }).PE_MCP_SERVERS, 'a b');
    // Absent means "no console here", which disables F15 — and now genuinely
    // means this console said nothing, rather than something upstream did.
    assert.equal(scriptEnv(OPTS).PE_MCP_SERVERS, undefined);
  });
});

/* ------------------------------------------------------------------ *
 * readQaMode — the fourth answer
 * ------------------------------------------------------------------ */

test('readQaMode reads the three words the engine answers with', () => {
  assert.deepEqual(readQaMode(ok('off')), { mode: 'off', reason: undefined });
  assert.deepEqual(readQaMode(ok('on (plan directive: QA gate: on)')),
    { mode: 'on', reason: 'plan directive: QA gate: on' });
  assert.deepEqual(readQaMode(ok('waived (plan directive: QA gate: off)')),
    { mode: 'waived', reason: 'plan directive: QA gate: off' });
});

test('a QA read that FAILED is `unknown`, never the permissive `off`', () => {
  // `off` means QA does not gate: dependents may proceed and no reviewer is
  // owed. Producing the most permissive word in the vocabulary from the ABSENCE
  // of an answer is the defect — every sibling reader in engine.ts already
  // guards these two cases.
  const timedOut = readQaMode({ code: 0, stdout: '', stderr: '', ms: 1, timedOut: true });
  assert.equal(timedOut.mode, 'unknown');
  assert.match(timedOut.error ?? '', /timed out/);

  const crashed = readQaMode({ code: 1, stdout: '', stderr: 'ERROR: no such plan\n', ms: 1, timedOut: false });
  assert.equal(crashed.mode, 'unknown');
  assert.equal(crashed.error, 'no such plan', 'the ERROR: prefix is stripped, the reason kept');

  const gibberish = readQaMode(ok('perhaps?'));
  assert.equal(gibberish.mode, 'unknown');
  assert.match(gibberish.error ?? '', /unrecognised/);

  const silent = readQaMode(ok(''));
  assert.equal(silent.mode, 'unknown');
  assert.match(silent.error ?? '', /said nothing/);
});

/* ------------------------------------------------------------------ *
 * readLint — a timeout and an overflow are different facts
 * ------------------------------------------------------------------ */

test('readLint refuses to call a KILLED run a failure', () => {
  const result = readLint({ code: 1, stdout: '', stderr: '', ms: 45_000, timedOut: true });
  assert.equal(result.ok, true, 'a killed run proves nothing either way');
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.issues, []);
});

test('an OVERFLOW is a failure, because the script had plenty to say', () => {
  // Node sets `killed` for a maxBuffer overflow as well as a timeout. Reading
  // them as one made a plan whose lint failed loudest of all report clean,
  // because readLint deliberately reports a timeout as ok.
  const result = readLint({
    code: 1, stdout: 'F2 phase 9 depends on undefined phase 40\n', stderr: '',
    ms: 900, timedOut: false, overflow: true,
  });
  assert.equal(result.ok, false, 'an overflow is an answer, and the answer was "not ok"');
  assert.equal(result.timedOut, false, 'and it must not be reported as a timeout');
  assert.match(result.summary, /more output than the console can hold/);
  assert.ok(result.issues.length > 0, 'what did arrive is still worth showing');
});

test('an ordinary lint result is read the ordinary way', () => {
  assert.equal(readLint(ok('LINT OK')).ok, true);
  const bad = readLint({
    code: 1, stdout: 'F3 cycle: 2 -> 3 -> 2\nLINT FAIL\n', stderr: '', ms: 10, timedOut: false,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.summary, 'LINT FAIL');
  assert.deepEqual(bad.issues, ['F3 cycle: 2 -> 3 -> 2']);
});

/* ------------------------------------------------------------------ *
 * readSessionPlan — members are not the flags
 * ------------------------------------------------------------------ */

test('a group\'s phases stop where its flags begin', () => {
  const plan = readSessionPlan(ok([
    'Session plan — demo   (budget ~200K/session · S=15K M=40K L=90K)',
    '',
    '  (already done, excluded: 1)',
    '  Session 1  solo   (~40K):  Phase 3  ⚠ waiting on: 2',
    '  Session 2  batch  (~90K):  4 → 5  ⚠ waiting on: 2 3',
    '  Session 3  solo   (~40K):  Phase 7  🔒 GATED — own session, confirm gates first',
    '  Session 4  batch  (~300K):  8 → 9  ⚠ over budget — split',
    '  Session 5  batch  (~80K):  10 → 11',
  ].join('\n')));

  // Captured up to whitespace/·/), so the printer's `/session` suffix rides
  // along. It is a display string and nothing parses it further; pinned as-is
  // rather than "fixed", since changing it would move a rendered label.
  assert.equal(plan.budget, '200K/session');
  assert.deepEqual(plan.excluded, [1]);
  // The failure this pins: [3, 2] — the dependency read as a member, which the
  // route map then drew the session line through.
  assert.deepEqual(plan.groups[0].phases, [3]);
  assert.deepEqual(plan.groups[1].phases, [4, 5]);
  assert.deepEqual(plan.groups[2].phases, [7]);
  assert.deepEqual(plan.groups[3].phases, [8, 9]);
  assert.deepEqual(plan.groups[4].phases, [10, 11]);
});

test('the flags themselves are still read — from the flags', () => {
  const plan = readSessionPlan(ok([
    '  Session 1  solo   (~40K):  Phase 7  🔒 GATED — own session, confirm gates first',
    '  Session 2  batch  (~300K):  8 → 9  ⚠ over budget — split',
    '  Session 3  batch  (~80K):  10 → 11',
  ].join('\n')));
  assert.equal(plan.groups[0].gated, true);
  assert.equal(plan.groups[0].note, 'own session, confirm gates first');
  assert.equal(plan.groups[1].gated, false);
  assert.equal(plan.groups[1].note, 'split');
  assert.equal(plan.groups[2].gated, false);
  assert.equal(plan.groups[2].note, undefined, 'a group with no flags has no note');
  assert.equal(plan.groups[0].kind, 'solo');
  assert.equal(plan.groups[1].kind, 'batch');
});

/* ------------------------------------------------------------------ *
 * readMemoryBlock — the board still refuses to guess
 * ------------------------------------------------------------------ */

test('a board that could not be read carries the reason, not an empty plan', () => {
  const timedOut = readMemoryBlock({ code: 0, stdout: '', stderr: '', ms: 45_000, timedOut: true });
  assert.equal(timedOut.phased, false);
  assert.match(timedOut.error ?? '', /timed out/);

  const crashed = readMemoryBlock({
    code: 1, stdout: '', stderr: 'ERROR: could not parse a "## Phase graph" table\n', ms: 5, timedOut: false,
  });
  assert.equal(crashed.phased, false);
  assert.equal(crashed.error, 'could not parse a "## Phase graph" table');
});

test('opts.mcpPolicy is a deliberate statement too — never an inheritance', () => {
  // mcp-8. F15 names the CONSEQUENCE of a missing server, and the consequence
  // depends on a policy whose third level — the RUN's setting — bash cannot
  // read out of the plan. So the console states it, through `extra`-style
  // assignment AFTER the PE_* denial, exactly as PE_MCP_SERVERS is stated.
  withEnv({ PE_MCP_POLICY: 'require' }, () => {
    // Absent is the third state: no console here, so no claim. `validate.sh`
    // shells the engine by hand and has no console default to state.
    assert.equal(scriptEnv(OPTS).PE_MCP_POLICY, undefined, 'an inherited one must not speak for this console');
    assert.equal(scriptEnv({ ...OPTS, mcpPolicy: 'require' }).PE_MCP_POLICY, 'require');
    assert.equal(scriptEnv({ ...OPTS, mcpPolicy: 'continue' }).PE_MCP_POLICY, 'continue');
  });
});
