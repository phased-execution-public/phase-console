/**
 * What the PreToolUse hook is told, and in whose voice.
 *
 * Three reports came out of one line of this path. A bypass run — the profile
 * whose whole promise is "stop asking me" — raised a card for a wrapped
 * command, waited out the hook's full hour with nobody watching, and timed out
 * into a deny; the CLI renders a deny with its own canned "The user doesn't
 * want to proceed with this tool use", so standing configuration reached the
 * session as a person refusing its work. It apologised and went looking for a
 * way around a rule that was never a person's opinion.
 *
 * So: the profile reaches the classifier, a denial says whose decision it is,
 * and a veto is written down where it can be read afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both are read when the modules below load, so the redirect has to come first:
// a policy read out of the operator's real config would make this suite depend
// on rules that are none of its business.
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const {
  POLICY_PATH, QUESTION_CLASS, carvedPolicy, classifyTool, loadPolicy,
} = await import('../server/runner/approvals.ts');
const { Service } = await import('../server/service.ts');

const flags = {
  port: 0, host: '127.0.0.1', open: false, allowWrites: false,
  scriptsDir: join(SKILL_DIR, 'scripts'),
  logFile: null,
};

type Noted = { event: string; data: Record<string, unknown>; phase?: number };

/**
 * A service driving one run, which is whatever this test says it is.
 *
 * `decideToolUse` reads four things off the run — its id, its slug, the phase
 * it is on and its profile — so standing one up beats driving a real session to
 * reach one branch of a classifier.
 *
 * Since the runner pool landed, the run has to be reachable the way the real
 * lookup finds it: by run id, through `runners`. `busy()` is what makes a
 * runner count as live — a stub without it is a service that reads as driving
 * nothing, which sends every call to the `guarded` fallback and hangs the
 * bypass tests on a card nobody is going to answer.
 */
function serviceOn(profile: string): { service: InstanceType<typeof Service>; noted: Noted[] } {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({ id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile }),
    note: (event: string, data: Record<string, unknown>, phase?: number) =>
      noted.push({ event, data, phase }),
    park: () => {},
  });
  return { service, noted };
}

function decision(reply: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

const WRAPPED = { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock ./job.sh' } };

test('a bypass run is not asked about a wrapper it said it did not want to be asked about', async () => {
  const { service } = serviceOn('bypass');
  // No `await` race to arrange: an 'ask' verdict would block on a decision
  // nobody is going to make, so if this resolves at all it did not raise a card.
  const answer = decision(await service.decideToolUse(WRAPPED, 'r1'));
  assert.equal(answer.permissionDecision, 'allow');
  assert.match(answer.permissionDecisionReason, /bypass profile/);
  service.close();
});

test('a guarded run that opted out of auto-grant still gets a person for the same command', async () => {
  // Since auto-grant shipped ON, "a card waits for a person" is the OPT-OUT
  // path: the console answers asks itself unless a scope says otherwise. This
  // pins that the opt-out is real — a global `autoApprove: false` and the same
  // wrapper is back on a card in front of a human.
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  const { service } = serviceOn('guarded');
  // An 'ask' verdict parks until somebody answers, so "it asked" is expressible
  // only as "it had not answered by itself" — hence the race rather than an
  // await that would sit here for the hook's full hour.
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(WRAPPED, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'guarded raised a card instead of deciding for itself');
  assert.equal(service.approvals.pending().length, 1, 'and the card is a real one, in the queue');

  // Settle it, or the request holds a timer and this suite never exits.
  service.approvals.disarm();
  service.close();
  rmSync(POLICY_PATH, { force: true });
});

test('a trusted run of a plan that lands by pull request still gets a card for `gh pr merge`, and never a push', async () => {
  // The publish carve-out (many-plans-one-repo phase 8). Under `trusted` the
  // ask list is emptied to the pinned set, and `gh pr merge` was an everyday
  // ask — so a landing session under a `Land: trunk` plan would have merged a
  // pull request with nobody asked. `planPublishes` pins its two acts.
  const { service } = serviceOn('trusted');
  (service as unknown as { planPublishes: (slug: string) => boolean }).planPublishes = (slug) => slug === 'demo';
  const MERGE = { tool_name: 'Bash', tool_input: { command: 'gh pr merge 7 --merge' } };
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(MERGE, 'r1'),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'the merge raised a card instead of being trusted through');
  assert.equal(service.approvals.pending().length, 1);
  // The push stays the console's: the wall refuses it on every profile.
  const push = decision(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'git push origin pe/demo-p1' } }, 'r1',
  ));
  assert.equal(push.permissionDecision, 'deny');
  service.approvals.disarm();
  service.close();

  // …and a plan that does NOT land by pull request keeps the everyday answer:
  // `trusted` trusts the merge verb like any other ask.
  const plain = serviceOn('trusted');
  const answer = decision(await plain.service.decideToolUse(MERGE, 'r1'));
  assert.equal(answer.permissionDecision, 'allow');
  plain.service.close();
});

test('a denial says whose decision it is, names the rule, and is written down', async () => {
  const { service, noted } = serviceOn('bypass');
  const answer = decision(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, 'r1',
  ));

  assert.equal(answer.permissionDecision, 'deny', 'the wall is identical in every profile');
  // The wording is the fix. A session that reads "the user doesn't want to
  // proceed" has been told a person judged its work; one that reads this knows
  // it is policy, that a retry cannot change it, and what to do instead.
  assert.match(answer.permissionDecisionReason, /standing policy/i);
  assert.match(answer.permissionDecisionReason, /not a person rejecting your work/i);
  assert.match(answer.permissionDecisionReason, /do not retry/i);
  assert.match(answer.permissionDecisionReason, /rule:/, 'and it names the line that stopped it');

  // A veto used to happen inside a hook reply and leave no trace at all, so a
  // phase that quietly worked around a blocked command was unexplainable later.
  const denied = noted.find((n) => n.event === 'phase.tool-denied');
  assert.ok(denied, 'the veto reaches the journal');
  assert.equal(denied!.data.tool, 'Bash');
  assert.match(String(denied!.data.rule), /push/);
  assert.equal(denied!.phase, 2, 'attributed to the phase it happened in');
  service.close();
});

test('a wrapper cannot smuggle a denied command past a profile that stopped asking', async () => {
  // The hole the profile change would otherwise have opened. `stripWrappers`
  // refuses to peel `flock` — its arguments vary too much to guess — so the
  // deny rules, which match the START of a command, never saw the `git push`
  // one word in. Under guarded that was survivable (a person got the card);
  // under bypass it would have run.
  const { service } = serviceOn('bypass');
  const answer = decision(await service.decideToolUse(
    { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock git push origin main' } }, 'r1',
  ));
  assert.equal(answer.permissionDecision, 'deny');
  assert.match(answer.permissionDecisionReason, /rule:/);
  service.close();
});

process.on('exit', () => {
  rmSync(CONFIG_HOME, { recursive: true, force: true });
  rmSync(STATE_HOME, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The Stop hook: may this session end its turn?
 *
 * The delivery-overhaul incident again, from the enforcement side: a session
 * about to end with neither a handoff on the board nor a declared outcome is
 * told exactly what to do INSTEAD of exiting into a halt. Fail-open by
 * construction — the runner's own exit-time check is the load-bearing layer.
 * ------------------------------------------------------------------ */

function serviceForStop(over: {
  boardState?: string;
  /** The board read FAILED — `board.error`, the fact `boardStates` could not express. */
  boardError?: string;
  phases?: Record<string, { phase: number; sessionId?: string; startedAt?: string }>;
  /** The phase's QA regime, as `qaMode`/`qaVerdict` answer it; absent = off. */
  qa?: { mode: string; verdict?: string; throws?: boolean };
} = {}): InstanceType<typeof Service> {
  const service = new Service(flags as never);
  const state = {
    id: 'r1', slug: 'demo', root: '/tmp/nowhere', activePhase: 2,
    phases: over.phases ?? { 2: { phase: 2, sessionId: 'sess-stop', startedAt: '2026-01-01T00:00:00Z' } },
  };
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => state,
    note: () => {},
  });
  (service as unknown as { root: unknown }).root = { ok: true, path: '/tmp/nowhere' };
  // The board, as the one reader answers it (`board(slug)` — `boardStates` was
  // deleted in P6/D2). `error` is part of the shape on purpose: `decideStop`
  // must fail OPEN on a board it could not read, and a stub that cannot express
  // "unreadable" cannot pin that.
  (service as unknown as { board: (slug: string) => Promise<Record<string, unknown>> })
    .board = async () => (over.boardError
      ? { phased: true, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {}, error: over.boardError }
      : { phased: true, states: { 2: over.boardState ?? 'ready' }, done: [], inProgress: [], stuck: [], ready: [], waiting: [], blockedBy: {}, qa: {} });
  (service as unknown as { qaMode: (slug: string, phase?: number) => Promise<{ mode: string }> })
    .qaMode = async () => {
      if (over.qa?.throws) throw new Error('the engine is unreachable');
      return { mode: over.qa?.mode ?? 'off' };
    };
  (service as unknown as { qaVerdict: (slug: string, phase: number) => Promise<string> })
    .qaVerdict = async () => over.qa?.verdict ?? 'none';
  return service;
}

test('Stop: a phase whose board reads done may end its turn', async () => {
  const service = serviceForStop({ boardState: 'done' });
  const decision = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  assert.deepEqual(decision, {});
});

test('Stop: a done board with an owed QA verdict blocks, naming the brief and the recorder', async () => {
  // The one mechanism positioned to catch the omission in-session explicitly
  // allowed it: board done was the whole test, and a complete handoff
  // satisfies it while the pending row holds every dependent.
  const service = serviceForStop({ boardState: 'done', qa: { mode: 'on', verdict: 'pending' } });
  const decision = await service.decideStop({ session_id: 'sess-stop' }, 'r1') as {
    hookSpecificOutput?: { decision: string; reason: string };
  };
  assert.equal(decision.hookSpecificOutput?.decision, 'block');
  assert.match(decision.hookSpecificOutput?.reason ?? '', /--qa-prompt 2/);
  assert.match(decision.hookSpecificOutput?.reason ?? '', /qa-record\.sh demo 2/);
});

test('Stop: the QA block honors the two-nudge bound', async () => {
  const service = serviceForStop({ boardState: 'done', qa: { mode: 'on', verdict: 'pending' } });
  await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  const third = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  assert.deepEqual(third, {}, 'two nudges bound the loop, QA included');
});

test('Stop: a recorded QA verdict — even a fail — lets the session go', async () => {
  // A fail means QA RAN; the fix cycle is the ladder's and the finish
  // dispatcher's, not this hook's.
  const service = serviceForStop({ boardState: 'done', qa: { mode: 'on', verdict: 'fail' } });
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, 'r1'), {});
});

test('Stop: a QA regime that cannot be read fails open', async () => {
  const service = serviceForStop({ boardState: 'done', qa: { mode: 'on', verdict: 'pending', throws: true } });
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, 'r1'), {});
});

test('Stop: a board the console could not read fails OPEN', async () => {
  // `boardStates` caught internally and returned `{}`, so "the engine timed
  // out" and "phase 2 is not done" were one value here — and this hook holds a
  // session's TURN on that value. Holding a turn because a read failed is
  // strictly worse than letting a finished session stop, and the catch one line
  // below has always agreed; `board.error` is what makes the two paths say the
  // same thing (P6/D2).
  const service = serviceForStop({ boardError: 'the engine timed out reading this plan' });
  const decision = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  assert.deepEqual(decision, {}, 'an unreadable board must not block the turn');
});

test('Stop: no handoff and no outcome blocks, naming both scripts', async () => {
  const service = serviceForStop();
  const decision = await service.decideStop({ session_id: 'sess-stop' }, 'r1') as {
    hookSpecificOutput?: { hookEventName: string; decision: string; reason: string };
  };
  assert.equal(decision.hookSpecificOutput?.hookEventName, 'Stop');
  assert.equal(decision.hookSpecificOutput?.decision, 'block');
  assert.match(decision.hookSpecificOutput?.reason ?? '', /new-handoff\.sh demo 2/);
  assert.match(decision.hookSpecificOutput?.reason ?? '', /phase-outcome\.sh demo 2 waiting-external/);
});

test('Stop: the third ask from one session is allowed — the loop guard', async () => {
  const service = serviceForStop();
  const first = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  const second = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  const third = await service.decideStop({ session_id: 'sess-stop' }, 'r1');
  assert.ok((first as { hookSpecificOutput?: unknown }).hookSpecificOutput, 'first: blocked');
  assert.ok((second as { hookSpecificOutput?: unknown }).hookSpecificOutput, 'second: blocked');
  assert.deepEqual(third, {}, 'third: the guard yields — two nudges bound the loop');
});

test('Stop: an unknown run, session or missing body fails open', async () => {
  const service = serviceForStop();
  assert.deepEqual(await service.decideStop({}, 'r1'), {});
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, undefined), {});
  assert.deepEqual(await service.decideStop({ session_id: 'sess-stop' }, 'r-unknown'), {});
});

/* ------------------------------------------------------------------ *
 * The in-turn wait guard (R25) — a deny that is not a deny RULE
 * ------------------------------------------------------------------ */

/**
 * The measured failure: a session sat 35+ minutes inside two `until … sleep`
 * loops holding `scope=all`, and nothing stopped it going in. The post-hoc
 * detector fires five minutes AFTER the call — by which time the lock has been
 * held for five minutes and the turn has produced nothing.
 *
 * So the hook refuses the call before it runs. The shape of that refusal is
 * the whole design: it is NOT a `policy.deny` line, because a rule there would
 * take a strike, appear in the editor, be switchable per plan, and make
 * `sleep 8` — the standard bring-up pause — impossible.
 */
const laned = (profile: string, extra: Record<string, unknown> = {}) => {
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const denials: { phase: number; command: string; matched: string }[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {}, ...extra,
    }),
    note: (event: string, data: Record<string, unknown>, phase?: number) =>
      noted.push({ event, data, phase }),
    noteWaitDenied: (phase: number, denial: { command: string; matched: string }) => denials.push({ phase, ...denial }),
    park: () => {},
  });
  return { service, noted, denials };
};

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

test('a supervised session may not wait inside its own turn on somebody else\'s clock, on any profile', async () => {
  // Since autopilot-token-drain phase 1 a wait on the session's OWN job is
  // allowed (`test/wait-procedure.test.ts` (b)), so the parser-robustness
  // shapes below wait on a named remote (`gh run view`) rather than on a
  // `/tmp` flag: what they prove — that no spelling hides a wait from the
  // splitter — is unchanged, and a `/tmp` flag would now be allowed on sight.
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    for (const command of [
      'until [ "$(gh run view 1 -q .status)" = completed ]; do sleep 15; done',
      'while true; do sleep 30; done',
      'sleep 90',
      'gh run watch 42',
      // The fourth round's shapes, end to end: a trailing `&` backgrounds only
      // the last statement, and an escaped quote is not a quote.
      'until gh run view 1 --exit-status; do sleep 30; done; echo ok &',
      'echo \\" && until gh run view 1 --exit-status; do sleep 30; done',
      'echo "$(until gh run view 1 --exit-status; do sleep 30; done)"',
      // Round 4's: a script piped into a shell, exempt data run by eval, and
      // a backgrounded job the same command then waits for.
      "cat <<'EOF' | bash\nuntil gh run view 1 --exit-status; do sleep 30; done\nEOF",
      'eval "$(printf \'sleep 600\')"',
      'sleep 600 & wait',
    ]) {
      const { service } = laned(profile);
      const answer = decision(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `${profile} allowed: ${command}`);
      // The wording has to be actionable, and has to name the alternative —
      // a deny a session cannot act on is a deny it will try to route around.
      assert.match(answer.permissionDecisionReason, /wait inside a turn/);
      assert.match(answer.permissionDecisionReason, /in the FOREGROUND/);
      assert.match(answer.permissionDecisionReason, /waiting-external/);
      service.close();
    }
  }
});

test('the refusal is written down, with the fragment that matched it', async () => {
  const { service, noted } = laned('bypass');
  await service.decideToolUse(bash('until curl -sf localhost:8080; do sleep 20; done'), 'r1');
  const denied = noted.find((n) => n.event === 'phase.tool-denied');
  assert.ok(denied, 'a veto nobody can read afterwards is a veto that cannot be explained');
  assert.equal(denied!.data.rule, 'in-turn-wait');
  assert.match(String(denied!.data.matched), /until .*do/);
  service.close();
});

test('the refusal reaches the lane\'s own signals, so the wait ladder can climb it — and a declaration is never refused (RCV-5)', async () => {
  const { service, denials } = laned('bypass');
  // RCV-5's refusal of a wait on the session's own job was reversed by
  // autopilot-token-drain phase 1 — that wait is allowed now and reaches no
  // ladder. A refused wait is somebody else's clock, and still reaches it.
  const own = 'until [ -f /tmp/suite.done ]; do sleep 30; done';
  assert.equal(decision(await service.decideToolUse(bash(own), 'r1')).permissionDecision, 'allow');
  assert.deepEqual(denials, [], 'an allowed wait is no denial');
  const command = 'until gh run view 7 --exit-status; do sleep 30; done';
  assert.equal(decision(await service.decideToolUse(bash(command), 'r1')).permissionDecision, 'deny');
  assert.deepEqual(denials.map((d) => [d.phase, d.command]), [[2, command]],
    'a denied wait opens no call, so this is the only way the watchdog learns the lane is still waiting');
  assert.match(denials[0].matched, /until/);
  // The documented way to declare a wait carries `--watch`, and must never be refused as one.
  const declare = 'bash scripts/phase-outcome.sh demo 2 waiting-external --wait-minutes 30 --watch gh:o/r#run/7';
  assert.equal(decision(await service.decideToolUse(bash(declare), 'r1')).permissionDecision, 'allow');
  assert.equal(denials.length, 1, 'and a declaration is no refusal');
  service.close();
});

test('ACC-8.4 (TRS-3): a guard denial followed by a waiting-external declaration with NO --watch ref is journalled phase.watch-missing at the hook — and the call is still allowed', async () => {
  // The measured shape (REC-48): refused `until … sleep` at 16:11:52, refused
  // `--watch` at 16:21:02, then `waiting-external` 37 s later with `watch: []`
  // — a blind park that resumed 581 minutes late. The hook is where the gap is
  // first visible: the denial the runner stamped on the RECORD (the lane's own
  // episode is retired by this very call) and a declaration with no ref.
  const command = 'until ! pgrep -f run_ring.sh >/dev/null 2>&1; do sleep 30; done';
  const { service, noted } = laned('trusted', {
    phases: { 2: { toolDenied: { tool: 'Bash', rule: 'in-turn-wait', command, matched: 'until [^`]+; *do', at: '2026-09-12T16:11:52.381Z' } } },
  });
  const declare = 'bash scripts/phase-outcome.sh demo 2 waiting-external --wait-minutes 30 --reason "ring job still running"';
  assert.equal(decision(await service.decideToolUse(bash(declare), 'r1')).permissionDecision, 'allow', 'a declaration is never refused');
  const missing = noted.filter((n) => n.event === 'phase.watch-missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].phase, 2);
  assert.equal(missing[0].data.source, 'hook');
  assert.equal(missing[0].data.command, command);
  assert.equal(missing[0].data.deniedAt, '2026-09-12T16:11:52.381Z');
  assert.match(String(missing[0].data.declaration), /waiting-external --wait-minutes 30/);
  // The recipe followed in full — a `--watch` ref — journals nothing.
  const withRef = 'bash scripts/phase-outcome.sh demo 2 waiting-external --wait-minutes 30 --watch cmd:"test -f /tmp/ring.done"';
  assert.equal(decision(await service.decideToolUse(bash(withRef), 'r1')).permissionDecision, 'allow');
  assert.equal(noted.filter((n) => n.event === 'phase.watch-missing').length, 1, 'a declaration that carries its ref is not missing one');
  service.close();
  // …and with no denial on the record, a ref-less declaration is the session's own business here.
  const { service: clean, noted: quiet } = laned('trusted');
  assert.equal(decision(await clean.decideToolUse(bash(declare), 'r1')).permissionDecision, 'allow');
  assert.equal(quiet.filter((n) => n.event === 'phase.watch-missing').length, 0);
  clean.close();
});

test('the guard does not touch the deny list, and says so in its own voice', async () => {
  const { service } = laned('bypass');
  const guard = decision(await service.decideToolUse(bash('sleep 120'), 'r1'));
  const wall = decision(await service.decideToolUse(bash('git push origin main'), 'r1'));
  assert.equal(guard.permissionDecision, 'deny');
  assert.equal(wall.permissionDecision, 'deny');
  // Two different refusals with two different remedies. Sharing the deny
  // list's wording would tell a session to "note it in your handoff and carry
  // on" about a loop it should simply have backgrounded.
  assert.ok(!/deny list/.test(guard.permissionDecisionReason),
    'the guard is not the wall, and must not claim to be');
  assert.match(wall.permissionDecisionReason, /deny list/);
  service.close();
});

test('a bring-up pause is not a wait, and a verifying lane may take as long as it likes', async () => {
  const { service } = laned('bypass');
  assert.equal(decision(await service.decideToolUse(bash('sleep 8'), 'r1')).permissionDecision, 'allow');
  service.close();

  // While the phase is inside its own §Verification the plan is entitled to a
  // slow command — that path has its own 30-minute bound and its own signal.
  const verifying = laned('bypass', {
    phases: { 2: { phase: 2, sessionId: 'sess-v', status: 'verifying' } },
  });
  const answer = decision(await verifying.service.decideToolUse(
    { ...bash('sleep 600'), session_id: 'sess-v' }, 'r1',
  ));
  assert.equal(answer.permissionDecision, 'allow', 'a verification is allowed to be slow');
  verifying.service.close();
});

test('the remedy the deny message prescribes is allowed, on every profile', async () => {
  // QA round 4's H1: the reason text, the Stop-hook block, SKILL.md and both
  // boot prompts tell a session to run `phase-outcome.sh … --watch <ref>`, and
  // the ` --watch` arm of the vocabulary denied exactly that — on every
  // profile, since the phase's first commit. A guard that refuses its own
  // remedy refuses twice.
  const outcome = join(SKILL_DIR, 'scripts', 'phase-outcome.sh');
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    for (const command of [
      `bash ${outcome} demo 2 waiting-external --wait-minutes 30 --watch "gh:o/r#run/42"`,
      `bash ${outcome} demo 2 waiting-external --wait-minutes 30 --watch=gh:o/r#run/42 --reason "CI"`,
      `bash ${outcome} demo 2 blocked --until 2026-09-01T09:00:00Z --watch lock:demo/3`,
      // Round 5's H1: the boot prompt's own order, with a reason that holds a
      // separator — the shape a session actually types.
      `bash ${outcome} demo 2 waiting-external --wait-minutes 30 --reason "build & test on CI" --watch gh:o/r#run/42`,
      'npm test > /tmp/x.log 2>&1 &',
    ]) {
      const { service, noted } = laned(profile);
      const answer = decision(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'allow', `${profile} refused the remedy: ${command}`);
      assert.ok(!noted.some((n) => n.event === 'phase.tool-denied'), 'and wrote no refusal');
      service.close();
    }
  }
});

test('an ask goes to a person, and the guard does not second-guess the person', async () => {
  // The third exemption, which had no assertion: the guard runs only on an
  // `allow`. A command the policy marks `ask` reaches a card even when it
  // carries a poll loop — a human looking at the card is the better judge, and
  // a deny here would take the decision away from the one person entitled to
  // it. Auto-grant is switched off so the ask is a real card, as in the
  // guarded test above.
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  const { service, noted } = laned('guarded');
  const pending = Symbol('still asking');
  const outcome = await Promise.race([
    service.decideToolUse(
      bash('psql -c "select 1"; until [ -f /tmp/x ]; do sleep 30; done'), 'r1',
    ),
    new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
  ]);
  assert.equal(outcome, pending, 'an ask raised a card rather than a deny');
  assert.equal(service.approvals.pending().length, 1);
  assert.ok(!noted.some((n) => n.event === 'phase.tool-denied'), 'the guard stayed out of it');
  service.approvals.disarm();
  service.close();
  rmSync(POLICY_PATH, { force: true });
});

test('a call this console cannot place is allowed — the hook fails open everywhere else', async () => {
  const { service } = laned('bypass');
  // No run token: an unsupervised CLI pointed at this port, or a run this
  // console is not driving. Inventing a deny for it would break a session
  // nobody here is responsible for.
  const answer = decision(await service.decideToolUse(bash('sleep 600'), null));
  assert.equal(answer.permissionDecision, 'allow');
  service.close();
});

/* ------------------------------------------------------------------ *
 * The question class (TRS-1) — a question survives every profile
 * ------------------------------------------------------------------ */

const ASK_QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [{
      question: 'Another live session holds this phase. How should I proceed?',
      header: 'Collision',
      multiSelect: false,
      options: [{ label: 'Ask it first (Recommended)', description: '' }, { label: 'I take the phase', description: '' }],
    }],
  },
};

test('ACC-8.4 (TRS-1): on guarded, trusted AND bypass the question class classifies hold — never allow or deny — whatever the ask list holds', () => {
  assert.deepEqual(QUESTION_CLASS, ['AskUserQuestion']);
  for (const profile of ['guarded', 'trusted', 'bypass'] as const) {
    for (const carveOut of [false, true]) {
      const policy = carvedPolicy(loadPolicy('/nonexistent'), profile, carveOut);
      assert.equal(classifyTool('AskUserQuestion', ASK_QUESTION.tool_input, policy, profile), 'hold',
        `${profile}${carveOut ? ' + carve-out' : ''}: a question is not a permission`);
    }
    // An operator's written allow rule cannot answer it either — `always` comes after the question class.
    const allowed = { ...carvedPolicy(loadPolicy('/nonexistent'), profile, false), always: ['AskUserQuestion'] };
    assert.equal(classifyTool('AskUserQuestion', {}, allowed, profile), 'hold');
    // The wall is still consulted first: a deny rule naming the tool refuses it.
    const walled = { ...carvedPolicy(loadPolicy('/nonexistent'), profile, false), deny: ['AskUserQuestion'] };
    assert.equal(classifyTool('AskUserQuestion', {}, walled, profile), 'deny', 'the deny list before anything else');
  }
});

test('ACC-8.4 (TRS-1): at the hook a held question is answered by the plan\'s ambiguity row — journalled as a hold, never asked, never allowed', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    const { service, noted } = laned(profile);
    const answer = decision(await service.decideToolUse(ASK_QUESTION, 'r1'));
    assert.equal(answer.permissionDecision, 'deny', `${profile}: the CLI takes only allow or deny, and a bare allow carries no answer`);
    assert.match(answer.permissionDecisionReason, /by policy \(ambiguity: ruling\)/);
    assert.match(answer.permissionDecisionReason, /NOT a refusal of your work/);
    assert.match(answer.permissionDecisionReason, /ruling --kind ambiguity/);
    assert.match(answer.permissionDecisionReason, /blocked --needs <key>/);
    const held = noted.filter((n) => n.event === 'phase.policy-answered');
    assert.equal(held.length, 1, `${profile}: one record of the question and its answer`);
    assert.equal(held[0].data.decision, 'hold');
    assert.equal(held[0].data.decisionKey, 'ambiguity');
    assert.equal(held[0].data.answer, 'ruling');
    assert.equal(held[0].data.source, 'default');
    assert.equal(held[0].data.tool, 'AskUserQuestion');
    assert.equal(held[0].phase, 2);
    assert.deepEqual(held[0].data.questions, [{
      question: 'Another live session holds this phase. How should I proceed?',
      options: ['Ask it first (Recommended)', 'I take the phase'],
      multiSelect: false,
    }]);
    assert.equal(service.approvals.pending().length, 0, 'no card was raised');
    assert.ok(!noted.some((n) => n.event === 'phase.approval-auto-granted'), 'and nothing was granted');
    service.close();
  }
  // A plan whose ambiguity row wants a person: the session is told to declare, not to guess.
  const { service, noted } = laned('trusted', {
    manifest: { decisions: [{ key: 'ambiguity', state: 'answered', source: 'plan', value: 'halt' }] },
  });
  const halted = decision(await service.decideToolUse(ASK_QUESTION, 'r1'));
  assert.equal(halted.permissionDecision, 'deny');
  assert.match(halted.permissionDecisionReason, /needs-human --needs ambiguity/);
  assert.equal(noted.find((n) => n.event === 'phase.policy-answered')?.data.source, 'plan');
  service.close();
});

test('ACC-8.10 (TRS-7): a raised card and its ending are on the run that asked — phase.approval-raised, then exactly one phase.approval-decided', async () => {
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  const { service, noted } = laned('guarded');
  try {
    const pending = Symbol('still asking');
    const outcome = await Promise.race([
      service.decideToolUse(bash('psql -c "select 1"'), 'r1'),
      new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
    ]);
    assert.equal(outcome, pending);
    const card = service.approvals.pending()[0];
    const raised = noted.filter((n) => n.event === 'phase.approval-raised');
    assert.equal(raised.length, 1, 'a raise is on the run');
    assert.equal(raised[0].data.approvalId, card.id);
    assert.equal(raised[0].data.matched, 'Bash(psql:*)', 'naming the rule that asked');
    assert.equal(raised[0].phase, 2);
    service.approvals.disarm('r1');
    await new Promise((resolve) => setImmediate(resolve));
    const decided = noted.filter((n) => n.event === 'phase.approval-decided');
    assert.equal(decided.length, 1, 'one ending, one record — the run ending included');
    assert.equal(decided[0].data.decision, 'deny');
    assert.equal(decided[0].data.decidedBy, 'run ended');
  } finally {
    service.close();
    rmSync(POLICY_PATH, { force: true });
  }
});

test('ACC-8.10 (TRS-11): an answer given on a card recovered after a restart answers the session\'s identical call — once, and no second card', async () => {
  const { INSTANCE_STATE_DIR } = await import('../server/config.ts');
  const at = new Date().toISOString();
  mkdirSync(join(INSTANCE_STATE_DIR, 'approvals'), { recursive: true });
  writeFileSync(join(INSTANCE_STATE_DIR, 'approvals', 'pending.json'), JSON.stringify([{
    id: 'kept-1', runId: 'r1', slug: 'demo', phase: 2, kind: 'tool', title: 'Bash: psql', detail: 'd', evidence: [],
    tool: { name: 'Bash', input: { command: 'psql -c "select 2"' } }, createdAt: at, expiresAt: new Date(Date.now() + 60_000).toISOString(), status: 'pending',
  }]), 'utf8');
  mkdirSync(join(POLICY_PATH, '..'), { recursive: true });
  writeFileSync(POLICY_PATH, `${JSON.stringify({ autoApprove: false })}\n`, 'utf8');
  const { service } = laned('guarded');
  try {
    assert.deepEqual(service.approvals.recover(() => ({ answerable: true })), { answerable: 1, unanswerable: {} });
    assert.equal(service.approvals.settle('kept-1', 'allow', 'phone'), true);
    const answer = decision(await service.decideToolUse(bash('psql -c "select 2"'), 'r1'));
    assert.equal(answer.permissionDecision, 'allow');
    assert.match(answer.permissionDecisionReason, /recovered after the console restarted/);
    assert.equal(service.approvals.pending().length, 0, 'answered by the kept decision, not by a second card');
    // Spent: the same call again is an ordinary ask.
    const pending = Symbol('still asking');
    const again = await Promise.race([
      service.decideToolUse(bash('psql -c "select 2"'), 'r1'),
      new Promise((resolve) => { setTimeout(() => resolve(pending), 100).unref(); }),
    ]);
    assert.equal(again, pending);
  } finally {
    service.approvals.disarm();
    service.close();
    rmSync(POLICY_PATH, { force: true });
  }
});

/**
 * What a real `PermissionRequest` body gets told.
 *
 * Phase 1 of zero-touch-console captured these bodies from `claude -p` on
 * 2.1.270 (`fixtures/spikes/permissionrequest.md` tells the story): the event
 * fires in print mode, for Bash outside the allow list and, with a permission
 * host, for AskUserQuestion. On that event the CLI honours `allow` and `deny`
 * only — an `ask` is an answer nobody can act on. Since phase 14 the event has
 * its own door (`POST /hooks/permission-request` → `decidePermissionRequest`),
 * which answers in the event's own wire shape: `decision.behavior`.
 */
const PERMISSION_BODIES = () => readFileSync(
  fileURLToPath(new URL('./fixtures/spikes/permissionrequest.jsonl', import.meta.url)), 'utf8',
).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

type PermissionReply = { hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message?: string; updatedInput?: Record<string, unknown> } } };

test('the captured PermissionRequest bodies replay through their own route to allow or deny, never ask', async () => {
  const bodies = PERMISSION_BODIES();
  assert.ok(bodies.length >= 1, 'the phase-1 spike captured at least one body');
  // `laned`, not `serviceOn`: a real body names its session, and the lookup
  // that matches it walks `run.phases`.
  const { service, noted } = laned('bypass');
  for (const body of bodies) {
    const label = `${body.tool_name} (${String(body.session_id).slice(0, 8)})`;
    assert.equal(body.hook_event_name, 'PermissionRequest', `${label}: a PermissionRequest body`);
    assert.equal(typeof body.tool_name, 'string', `${label}: tool_name is a string`);
    assert.ok(!('tool_use_id' in body), `${label}: the CLI sends no tool_use_id on this event`);
    const reply = await service.decidePermissionRequest(body as never, 'r1') as PermissionReply;
    assert.equal(reply.hookSpecificOutput.hookEventName, 'PermissionRequest', `${label}: the event's own shape`);
    const { behavior } = reply.hookSpecificOutput.decision;
    assert.ok(behavior === 'allow' || behavior === 'deny', `${label}: ${behavior}`);
    assert.notEqual(behavior, 'ask', `${label}: never asked`);
    if (behavior === 'deny') assert.ok(reply.hookSpecificOutput.decision.message, `${label}: a denial says why`);
  }
  // …and each arrival is on the run, before its decision.
  assert.equal(noted.filter((n) => n.event === 'phase.permission-request').length, bodies.length);
  assert.ok(noted.some((n) => n.event === 'phase.permission-request' && n.data.tool === 'AskUserQuestion'));
  service.close();
});

/* ------------------------------------------------------------------ *
 * The relay (phase 14) — the exclusions, the push, the wire shapes
 * ------------------------------------------------------------------ */

/**
 * `laned`, on a run whose relay is ARMED, with every act the relay performs on
 * the record: parks, pushes, the notice to the session. The relay's own window
 * is shortened on the instance so a raised question answers in milliseconds.
 */
async function relayLaned(profile = 'trusted', extra: Record<string, unknown> = {}) {
  const { INSTANCE_STATE_DIR } = await import('../server/config.ts');
  const { defaultCategories } = await import('../server/push/catalogue.ts');
  // The relay keeps the keys each phase asked on disk; every case starts clean.
  rmSync(join(INSTANCE_STATE_DIR, 'relay'), { recursive: true, force: true });
  const service = new Service(flags as never);
  const noted: Noted[] = [];
  const parks: { reason: string; phase: number | null; kind: string }[] = [];
  const told: { phase: number; answers: unknown[] }[] = [];
  const pushed: { category: string; title: string; body: string }[] = [];
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {}, status: 'running',
      relay: 'last-resort', relayArming: { armed: true, version: '2.1.270', floor: '2.1.268', at: new Date().toISOString() },
      ...extra,
    }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteWaitDenied: () => {},
    park: (reason: string, phase: number | null, kind: string) => { parks.push({ reason, phase, kind }); return true; },
    tellRelayAnswer: (phase: number, answers: unknown[]) => { told.push({ phase, answers }); return { ok: true }; },
  });
  const inner = service as unknown as {
    prefs: Record<string, unknown>;
    push: { announce: (...args: unknown[]) => void };
    relay: { deps: { answerMs?: number } };
  };
  inner.prefs.notify = defaultCategories();
  inner.push.announce = (category: unknown, message: unknown) => {
    pushed.push({ category: category as string, ...(message as { title: string; body: string }) });
  };
  inner.relay.deps.answerMs = 25;
  return { service, noted, parks, told, pushed };
}

const asking = (questions: unknown[], extra: Record<string, unknown> = {}) => ({
  tool_name: 'AskUserQuestion', tool_input: { questions }, session_id: 'sess-q', tool_use_id: 'toolu_q', ...extra,
});
const choice = (text: string, labels: string[], more: Record<string, unknown> = {}) => ({
  question: text, header: 'Choice', multiSelect: false, options: labels.map((label) => ({ label, description: '' })), ...more,
});

test('ACC-8.16 (AC-5): each of the five exclusions is phase.question-unanswerable, a needs-human park and ONE push — never a window', async () => {
  const cases: { reason: string; body: Record<string, unknown>; extra?: Record<string, unknown>; first?: Record<string, unknown> }[] = [
    { reason: 'deny-list', body: asking([choice('How should the branch land?', ['Rebase it', 'Run `git push origin main`'])]) },
    { reason: 'multi-select', body: asking([choice('Which checks should run?', ['lint', 'types'], { multiSelect: true })]) },
    // Prose the deny list cannot match — `git reset --hard` here would be the wall's, and the wall is consulted first.
    { reason: 'destructive-option', body: asking([choice('The checks are green. What now?', ['Wait for review', 'Merge the PR now'])]) },
    { reason: 'run-stopped', body: asking([choice('Carry on after the wall?', ['Yes', 'No'])]), extra: { status: 'parked' } },
    {
      reason: 'repeated-key',
      first: asking([choice('Which port should the worker take?', ['8080', '9090'])]),
      body: asking([choice('Which port should the worker take?', ['8080', '9090'])]),
    },
  ];
  for (const { reason, body, extra, first } of cases) {
    const { service, noted, parks, pushed } = await relayLaned('trusted', extra ?? {});
    try {
      if (first) {
        // Asked and answered once — the relay answers it at the end of its window.
        const answered = decision(await service.decideToolUse(first as never, 'r1'));
        assert.equal(answered.permissionDecision, 'allow', `${reason}: the first ask is answered`);
        pushed.length = 0;
      }
      const raisedBefore = service.approvals.counts().raised;
      const reply = decision(await service.decideToolUse(body as never, 'r1'));
      assert.equal(reply.permissionDecision, 'deny', `${reason}: never auto-answered`);
      assert.match(reply.permissionDecisionReason, /needs-human --needs ambiguity/, `${reason}: told to declare, not guess`);
      const refused = noted.filter((n) => n.event === 'phase.question-unanswerable');
      assert.equal(refused.length, 1, `${reason}: one record`);
      assert.equal(refused[0].data.reason, reason);
      assert.equal(refused[0].phase, 2);
      assert.equal(parks.length, 1, `${reason}: parked`);
      assert.equal(parks[0].kind, 'needs-human');
      assert.equal(parks[0].phase, 2);
      assert.equal(pushed.length, 1, `${reason}: exactly one push`);
      assert.equal(pushed[0].category, 'needs-you');
      assert.equal(service.approvals.counts().raised, raisedBefore, `${reason}: no card, no window`);
    } finally {
      service.approvals.disarm();
      service.close();
    }
  }
});

test('ACC-8.16: on an ARMED run a question is raised with a session-ask push, answered allow + updatedInput by rule, and the session is told — on both hooks', async () => {
  const q = choice('Which colour should the banner be?', ['Red', 'Blue (Recommended)']);
  const { service, noted, pushed, told } = await relayLaned('guarded');
  try {
    const reply = await service.decideToolUse(asking([q]) as never, 'r1') as {
      hookSpecificOutput: { permissionDecision: string; updatedInput?: { questions: unknown; answers: Record<string, string> } };
    };
    assert.equal(reply.hookSpecificOutput.permissionDecision, 'allow', 'no denial — the answer IS the allow');
    assert.deepEqual(reply.hookSpecificOutput.updatedInput?.questions, [q]);
    assert.deepEqual(reply.hookSpecificOutput.updatedInput?.answers, { 'Which colour should the banner be?': 'Blue (Recommended)' });
    assert.equal(pushed.filter((p) => p.category === 'session-ask').length, 1, 'a lane\'s question also pushes');
    assert.match(pushed.find((p) => p.category === 'session-ask')!.body, /Which colour should the banner be\?/);
    assert.ok(noted.some((n) => n.event === 'phase.question-raised' && n.data.mechanism === 'pre-tool-use'));
    assert.equal(noted.find((n) => n.event === 'phase.question-answered')?.data.by, 'recommended');
    assert.ok(!noted.some((n) => n.event === 'phase.policy-answered'), 'the relay answered it, not the policy table');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(told.length, 1, 'the session is told who answered');
  } finally {
    service.close();
  }

  // The same question through the transport phase 1 measured: the event's own shape.
  const second = await relayLaned('guarded');
  try {
    const body = PERMISSION_BODIES().find((entry) => entry.tool_name === 'AskUserQuestion')!;
    const reply = await second.service.decidePermissionRequest(body as never, 'r1') as PermissionReply;
    assert.equal(reply.hookSpecificOutput.decision.behavior, 'allow');
    assert.deepEqual(reply.hookSpecificOutput.decision.updatedInput?.answers, { 'Which colour should the banner be?': 'Blue (Recommended)' });
    assert.ok(second.noted.some((n) => n.event === 'phase.question-raised' && n.data.mechanism === 'permission-request'));
  } finally {
    second.service.close();
  }
});

test('a run whose relay is NOT armed still answers a question by policy — the relay is the last resort, not the default', async () => {
  const { service, noted } = await relayLaned('trusted', {
    relayArming: { armed: false, version: null, floor: '2.1.268', reason: 'version-unknown', at: new Date().toISOString() },
  });
  try {
    const reply = decision(await service.decideToolUse(asking([choice('Anything?', ['Yes', 'No'])]) as never, 'r1'));
    assert.equal(reply.permissionDecision, 'deny');
    assert.match(reply.permissionDecisionReason, /by policy \(ambiguity: ruling\)/);
    assert.ok(noted.some((n) => n.event === 'phase.policy-answered'));
    assert.ok(!noted.some((n) => n.event === 'phase.question-raised'));
  } finally {
    service.close();
  }
});
