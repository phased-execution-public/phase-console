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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Both are read when the modules below load, so the redirect has to come first:
// a policy read out of the operator's real config would make this suite depend
// on rules that are none of its business.
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-config-'));
const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-hook-state-'));
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { POLICY_PATH } = await import('../server/runner/approvals.ts');
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
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile, phases: {}, ...extra,
    }),
    note: (event: string, data: Record<string, unknown>, phase?: number) =>
      noted.push({ event, data, phase }),
    park: () => {},
  });
  return { service, noted };
};

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

test('a supervised session may not wait inside its own turn, on any profile', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    for (const command of [
      'until [ "$(gh run view 1 -q .status)" = completed ]; do sleep 15; done',
      'while true; do sleep 30; done',
      'sleep 90',
      'gh run watch 42',
      // The fourth round's shapes, end to end: a trailing `&` backgrounds only
      // the last statement, and an escaped quote is not a quote.
      'until [ -f /tmp/x ]; do sleep 30; done; echo ok &',
      'echo \\" && until [ -f /tmp/x ]; do sleep 30; done',
      'echo "$(until [ -f /tmp/x ]; do sleep 30; done)"',
      // Round 4's: a script piped into a shell, exempt data run by eval, and
      // a backgrounded job the same command then waits for.
      "cat <<'EOF' | bash\nuntil [ -f /tmp/x ]; do sleep 30; done\nEOF",
      'eval "$(printf \'sleep 600\')"',
      'sleep 600 & wait',
    ]) {
      const { service } = laned(profile);
      const answer = decision(await service.decideToolUse(bash(command), 'r1'));
      assert.equal(answer.permissionDecision, 'deny', `${profile} allowed: ${command}`);
      // The wording has to be actionable, and has to name the alternative —
      // a deny a session cannot act on is a deny it will try to route around.
      assert.match(answer.permissionDecisionReason, /wait inside a turn/);
      assert.match(answer.permissionDecisionReason, /run_in_background/);
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
