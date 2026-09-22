/**
 * The poll-loop guard (autopilot-token-drain phase 2).
 *
 * Run `deadaff9`'s phase 3 spent 311 of its 434 tool calls on status checks —
 * `ListAgents` and `date`, one every four seconds, at 790k–947k of context — in
 * streaks of 100 and 198: 270M of its 342M context tokens (79 %). Phase 1 gave
 * every surface one wait procedure; this is the mechanical backstop behind it.
 * `shared/poll-loop.js` sees every main-thread tool call, and once six status
 * checks land inside two minutes with nothing else between, the PreToolUse hook
 * refuses them until the session does something else or goes quiet.
 *
 * The tuning is the plan's, measured over 357 transcripts and 36,012 calls: it
 * fires on exactly three sessions, all real loops, and on nothing else. The
 * fixtures under `fixtures/poll-loops/` are those sessions and the normal ones
 * beside them, sanitised by `scripts/replay-poll-guard.mjs --extract`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLL_LOOP, POLL_STATUS_TOOLS, foldDigits, isProbeCommand, isStatusCapable, newPollLoop, observeCall, replayCalls,
} from '../shared/poll-loop.js';
import { fixtureCalls } from '../scripts/replay-poll-guard.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'poll-loops');
type FixtureCall = { dtMs: number; name: string; command?: string; block?: boolean; runInBackground?: boolean };
const fixture = (name: string): FixtureCall[] =>
  (JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { calls: FixtureCall[] }).calls;
const episodesOf = (name: string) => replayCalls(fixtureCalls(fixture(name))).episodes.map((episode) => episode.index);

type Call = { name: string; input?: Record<string, unknown> };

const listAgents: Call = { name: 'ListAgents', input: {} };
const read: Call = { name: 'Read', input: { file_path: '/tmp/notes.md' } };
const bash = (command: string): Call => ({ name: 'Bash', input: { command } });

/** Feed calls `stepMs` apart from t=0; returns every verdict. */
function feed(calls: Call[], stepMs = 4_000, state = newPollLoop(), start = 0) {
  return calls.map((call, i) => observeCall(state, call, start + i * stepMs));
}

test('the vocabulary: three status tools, and Bash is the one tool that may or may not be a status check', () => {
  assert.deepEqual([...POLL_STATUS_TOOLS], ['ListAgents', 'TaskOutput', 'BashOutput']);
  assert.ok(Object.isFrozen(POLL_STATUS_TOOLS), 'the owner hands out the object, never a copy to edit');
  assert.deepEqual({ ...POLL_LOOP }, { threshold: 6, windowMs: 120_000 });
  for (const name of ['Bash', 'ListAgents', 'TaskOutput', 'BashOutput']) assert.ok(isStatusCapable(name), name);
  for (const name of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Agent', 'Monitor', 'ToolSearch']) {
    assert.ok(!isStatusCapable(name), name);
  }
});

test('digits fold, so a poll that counts up still reads as the same poll', () => {
  assert.equal(foldDigits('tail -c 200 /tmp/p3-commit2.log'), 'tail -c # /tmp/p#-commit#.log');
  assert.equal(foldDigits('gh run view 17812345'), foldDigits('gh run view 9'));
});

test('a probe is a command made only of clock and process checks and reads of a log or task output', () => {
  for (const command of [
    'date',
    'date -u +%H:%M:%S',
    'pgrep -f "git commit"',
    'ps -p 4242 -o etime=',
    'sleep 5',
    // The P3 shape the guard first refuses (#263).
    'tail -c 200 /tmp/p3-commit2.log; echo; pgrep -f "git commit"',
    'tail -n 20 /tmp/build.log 2>/dev/null',
    'cat /tmp/claude/tasks/a1b2.output',
    'wc -l /tmp/claude/tasks/a1b2.output && date',
    'ls -la /tmp/claude/tasks/',
    'grep -c ERROR /tmp/run.log || echo none',
    'echo ---; date',
    'stat -f %z /tmp/claude/tasks/a1.output',
    'F=/tmp/claude/tasks/a1.output; wc -c /tmp/claude/tasks/a1.output',
    // A separator inside quotes is data, not a second command.
    'pgrep -f "vite | node"',
  ]) {
    assert.ok(isProbeCommand(command), `should be a probe: ${command}`);
  }
});

test('anything else is work, even when it looks like a check', () => {
  for (const command of [
    'echo done',
    // Every pipeline stage must itself be a probe: `awk` is not.
    "ls -la /tmp/claude/tasks/a1.output | awk '{print $5}'",
    'pgrep -f vite | head -1',
    'tail -5 README.md',
    'cat package.json',
    'git status',
    'gh run view 123',
    'until [ -f /tmp/x.done ]; do sleep 10; done',
    'grep -rn "sleep" viewer/server',
    'echo "a; git push"',
    '',
  ]) {
    assert.ok(!isProbeCommand(command), `should not be a probe: ${command}`);
  }
});

test('the sixth status check inside two minutes is the first one refused, and the episode names what it saw', () => {
  const verdicts = feed([listAgents, bash('date'), listAgents, bash('date'), listAgents, bash('date'), listAgents]);
  assert.deepEqual(verdicts.map((v) => v.status), [true, true, true, true, true, true, true]);
  assert.deepEqual(verdicts.map((v) => v.deny), [false, false, false, false, false, true, true]);
  assert.deepEqual(verdicts.map((v) => v.episodeStart), [false, false, false, false, false, true, false]);
  assert.deepEqual(verdicts[5].episode, { calls: 6, windowMs: 20_000, tools: ['ListAgents', 'Bash'], firstAt: 0 });
  assert.equal(verdicts[6].episode?.calls, 7);
  assert.equal(verdicts[4].episode, null, 'nothing is refused, so nothing is reported');
});

test('Read never counts, and any other call — Read, Grep, Edit — breaks the streak', () => {
  for (const other of [read, { name: 'Grep', input: { pattern: 'x' } }, { name: 'Edit', input: {} }]) {
    const verdicts = feed([listAgents, listAgents, listAgents, listAgents, listAgents, other,
      listAgents, listAgents, listAgents, listAgents, listAgents, listAgents]);
    assert.equal(verdicts[5].status, false, `${other.name} is not a status check`);
    assert.deepEqual(verdicts.map((v, i) => (v.deny ? i : -1)).filter((i) => i >= 0), [11],
      `${other.name} reset the count: the sixth check AFTER it is the first refused`);
  }
});

test('TaskOutput that blocks is a wait, not a poll; without block it is a status check, like BashOutput', () => {
  const state = newPollLoop();
  assert.equal(observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1', block: true } }, 0).status, false);
  assert.equal(observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1' } }, 1_000).status, true);
  assert.equal(observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1', block: false } }, 2_000).status, true);
  assert.equal(observeCall(state, { name: 'BashOutput', input: { bash_id: 'b1' } }, 3_000).status, true);
  // A blocking wait resets the streak it interrupts.
  const verdicts = feed([listAgents, listAgents, listAgents, listAgents, listAgents,
    { name: 'TaskOutput', input: { task_id: 'a1', block: true } }, listAgents]);
  assert.ok(verdicts.every((v) => !v.deny));
});

test('six checks spread over more than two minutes are patience, not a loop — the window is inclusive', () => {
  const slow = feed(Array.from({ length: 12 }, () => listAgents), 30_000);
  assert.ok(slow.every((v) => !v.deny), 'one check every 30 s: six span 150 s');
  const edge = feed(Array.from({ length: 6 }, () => listAgents), 24_000);
  assert.equal(edge[5].deny, true, 'one every 24 s: six span exactly 120 s');
});

test('a gap longer than two minutes starts the count again', () => {
  const state = newPollLoop();
  const first = feed([listAgents, listAgents, listAgents, listAgents, listAgents], 4_000, state);
  const after = feed([listAgents, listAgents, listAgents, listAgents, listAgents, listAgents], 4_000, state, 16_000 + 120_001);
  assert.ok(first.every((v) => !v.deny));
  assert.deepEqual(after.map((v) => v.deny), [false, false, false, false, false, true]);
});

test('an episode holds until the session does something else or goes quiet for two minutes', () => {
  const state = newPollLoop();
  const opening = feed(Array.from({ length: 6 }, () => listAgents), 4_000, state);
  assert.equal(opening[5].deny, true);
  // Slowing down is not stopping: every check of the episode is refused.
  assert.equal(observeCall(state, listAgents, 20_000 + 60_000).deny, true);
  assert.equal(observeCall(state, listAgents, 80_000 + 100_000).deny, true);
  // A real call ends it; the next check is allowed again.
  assert.equal(observeCall(state, read, 181_000).deny, false);
  assert.equal(observeCall(state, listAgents, 182_000).deny, false);

  const quiet = newPollLoop();
  feed(Array.from({ length: 6 }, () => listAgents), 4_000, quiet);
  assert.equal(observeCall(quiet, listAgents, 20_000 + 120_001).deny, false, 'a quiet gap ends the episode');
});

test('a repeated command is a poll whatever it runs — digits folded, remembered for two minutes across resets', () => {
  // `gh run view` is no probe, so the first one is work — and the repeats are the loop.
  const view = (run: number) => bash(`gh run view ${run} --json status`);
  const verdicts = feed([view(1), view(2), view(3), view(4), view(5), view(6), view(7)], 10_000);
  assert.deepEqual(verdicts.map((v) => v.status), [false, true, true, true, true, true, true]);
  assert.deepEqual(verdicts.map((v) => v.deny), [false, false, false, false, false, false, true]);

  // The memory outlives the reset its first occurrence caused (P3 #312 → #316).
  const state = newPollLoop();
  const check = bash('F=/tmp/claude/tasks/a1.output; ls -la "$F" | awk \'{print $5}\'');
  assert.equal(observeCall(state, check, 0).status, false);
  assert.equal(observeCall(state, listAgents, 4_000).status, true);
  assert.equal(observeCall(state, check, 8_000).status, true);

  // …but only for two minutes.
  const stale = newPollLoop();
  observeCall(stale, view(1), 0);
  assert.equal(observeCall(stale, view(2), 120_001).status, false);
});

test('a malformed call is work, never a crash', () => {
  const state = newPollLoop();
  assert.equal(observeCall(state, { name: 'Bash' }, 0).status, false);
  assert.equal(observeCall(state, { name: 'Bash', input: { command: 42 } }, 1).status, false);
  assert.equal(observeCall(state, { name: 'TaskOutput' }, 2).status, true);
});

test('counts are kept for the telemetry that reads them (phase 3)', () => {
  const state = newPollLoop();
  feed([read, listAgents, listAgents, listAgents, listAgents, listAgents, listAgents, listAgents, read], 4_000, state);
  assert.deepEqual({ ...state.counts }, { calls: 9, status: 7, denied: 2, episodes: 1 });
});

test('replayCalls reports every verdict and each episode by its 1-based call index', () => {
  const calls = [read, listAgents, listAgents, listAgents, listAgents, listAgents, listAgents, read,
    listAgents, listAgents, listAgents, listAgents, listAgents, listAgents]
    .map((call, i) => ({ ...call, at: i * 4_000 }));
  const replay = replayCalls(calls);
  assert.equal(replay.verdicts.length, calls.length);
  assert.deepEqual(replay.episodes, [{ index: 7, at: 24_000 }, { index: 14, at: 52_000 }]);
});

/* ---- the measured sessions (fixtures from `scripts/replay-poll-guard.mjs --extract`) ---- */

test('P3 of run deadaff9: refused at the annotation-commit poll (#263) and inside the reviewer wait (#318)', () => {
  const calls = fixture('p3-builder');
  assert.equal(calls.length, 773, 'both transcript copies, merged by tool_use id');
  assert.deepEqual(episodesOf('p3-builder'), [263, 318, 326, 392, 434]);
  assert.equal(calls[262].name, 'Bash');
  assert.match(calls[262].command ?? '', /^tail -c \d+ \/tmp\/p3-commit2\.log; echo; pgrep -f /);
  assert.equal(calls[317].name, 'ListAgents');
});

test('the corpus\'s other two loops fire too — a CD-run poll and a waiter check', () => {
  assert.deepEqual(episodesOf('cd-run-poll'), [172, 194, 201, 219]);
  assert.deepEqual(episodesOf('check-waiters'), [317, 396]);
});

test('and it stays silent on normal work: the other builders, both review sessions, paging a file', () => {
  for (const [name, count] of [
    ['p1-builder', 288], ['p1-review', 63], ['p8-builder', 289], ['p8-review', 52],
    ['p2-builder', 177], ['p6-builder', 148], ['paging-read', 40],
  ] as const) {
    const calls = fixture(name);
    assert.equal(calls.length, count, name);
    const replay = replayCalls(fixtureCalls(calls));
    assert.deepEqual(replay.episodes, [], `${name} never fires`);
    assert.equal(replay.counts.denied, 0, name);
  }
});

/* ---- the feed: what the tracker is told, and by which channel ---- */

const { applyEvent, newLaneSignals } = await import('../server/runner/liveness.ts');

type Signals = ReturnType<typeof newLaneSignals>;

test('every lane starts with a tracker of its own, so a fresh session starts from nothing', () => {
  const signals = newLaneSignals(0);
  assert.deepEqual(signals.pollLoop, newPollLoop());
  assert.notEqual(newLaneSignals(0).pollLoop, signals.pollLoop);
});

test('the stream resets the streak on the session\'s own other calls — never on a subagent\'s, never on a tool the hook counts', () => {
  const fiveChecks = (signals: Signals) => {
    for (let i = 0; i < 5; i++) observeCall(signals.pollLoop, listAgents, i * 4_000);
  };

  const own = newLaneSignals(0);
  fiveChecks(own);
  applyEvent(own, { kind: 'tool', name: 'Read', id: 'r1', summary: 'notes.md' }, 18_000);
  assert.equal(observeCall(own.pollLoop, listAgents, 20_000).deny, false, 'the session read something: the count restarts');

  const delegated = newLaneSignals(0);
  fiveChecks(delegated);
  applyEvent(delegated, { kind: 'tool', name: 'Read', id: 'r2', summary: 'notes.md', parent: 'agent-call' }, 18_000);
  assert.equal(observeCall(delegated.pollLoop, listAgents, 20_000).deny, true, 'a subagent reading is not the session working');

  for (const name of ['Bash', 'ListAgents', 'TaskOutput', 'BashOutput']) {
    const hooked = newLaneSignals(0);
    fiveChecks(hooked);
    applyEvent(hooked, { kind: 'tool', name, id: `h-${name}`, summary: 'date' }, 18_000);
    assert.equal(observeCall(hooked.pollLoop, listAgents, 20_000).deny, true, `${name} is the hook's to count, not the stream's`);
  }
});

/* ---- the hook: what a polling session is told ---- */

const { Service } = await import('../server/service.ts');
const { SKILL_DIR } = await import('../server/config.ts');
const { waitProcedure } = await import('../server/runner/runner-core.ts');

type Noted = { event: string; data: Record<string, unknown>; phase?: number };
type HookReply = { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };

const scriptsDir = join(SKILL_DIR, 'scripts');

/**
 * A service driving one run whose phase 2 session is `s-main`, with a runner
 * stub that keeps a REAL tracker on a four-second clock — the pattern of
 * `hook-decisions.test.ts`'s `laned`, because the question here is what the
 * hook does with the tracker's answer, not how a lane keeps one.
 */
function polled(profile: string, opts: { status?: string; throws?: boolean; delivered?: boolean } = {}) {
  const service = new Service({ port: 0, host: '127.0.0.1', open: false, allowWrites: false, scriptsDir, logFile: null } as never);
  const noted: Noted[] = [];
  const nudges: { phase: number; text: string }[] = [];
  const recordDenials: unknown[] = [];
  const tracker = newPollLoop();
  let clock = 0;
  (service as unknown as { runners: Map<string, unknown> }).runners.set('demo', {
    busy: () => true,
    current: () => ({
      id: 'r1', slug: 'demo', activePhase: 2, permissionProfile: profile,
      phases: { 2: { phase: 2, sessionId: 's-main', status: opts.status ?? 'running' } },
    }),
    note: (event: string, data: Record<string, unknown>, phase?: number) => noted.push({ event, data, phase }),
    noteToolDenied: (...args: unknown[]) => recordDenials.push(args),
    noteWaitDenied: () => {},
    observeToolCall: (_phase: number, call: { name: string; input?: unknown }) => {
      if (opts.throws) throw new Error('the tracker is broken');
      clock += 4_000;
      return observeCall(tracker, call, clock);
    },
    nudgePollLoop: (phase: number, text: string) => {
      nudges.push({ phase, text });
      return opts.delivered ?? true;
    },
    park: () => {},
  });
  const ask = async (tool_name: string, tool_input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (await service.decideToolUse({ tool_name, tool_input, session_id: 's-main', tool_use_id: 'toolu_x', ...extra }, 'r1') as HookReply)
      .hookSpecificOutput;
  return { ask, noted, nudges, recordDenials, tracker };
}

const outcome = `bash ${scriptsDir}/phase-outcome.sh demo 2`;

test('a session polling at the hook is refused from the sixth check, on every profile, and told how to wait', async () => {
  for (const profile of ['guarded', 'trusted', 'bypass']) {
    const { ask } = polled(profile);
    const answers = [];
    for (let i = 0; i < 7; i++) {
      answers.push(i % 2 ? await ask('Bash', { command: 'date -u +%H:%M:%S' }) : await ask('ListAgents', {}));
    }
    assert.deepEqual(answers.map((a) => a.permissionDecision), ['allow', 'allow', 'allow', 'allow', 'allow', 'deny', 'deny'], profile);
    const reason = answers[5].permissionDecisionReason;
    assert.match(reason, /6 status checks in 20 s/, `${profile}: the refusal says what it saw`);
    assert.ok(reason.includes(waitProcedure(outcome)), `${profile}: and carries the procedure verbatim`);
  }
});

test('an episode is journalled once, each refusal as a poll-loop denial, and nothing lands on the record to widen', async () => {
  const { ask, noted, nudges, recordDenials } = polled('guarded');
  for (let i = 0; i < 8; i++) await ask('TaskOutput', { task_id: 'a1' });
  const episodes = noted.filter((n) => n.event === 'phase.poll-loop');
  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0], {
    event: 'phase.poll-loop', phase: 2,
    data: { calls: 6, windowMs: 20_000, tools: ['TaskOutput'], firstAt: new Date(4_000).toISOString(), nudged: true },
  });
  const denials = noted.filter((n) => n.event === 'phase.tool-denied');
  assert.deepEqual(denials.map((n) => n.data), [
    { tool: 'TaskOutput', rule: 'poll-loop' }, { tool: 'TaskOutput', rule: 'poll-loop' }, { tool: 'TaskOutput', rule: 'poll-loop' },
  ]);
  assert.deepEqual(recordDenials, [], 'a poll loop is not a permission wall: nothing to widen, nothing to classify as blocked');
  assert.equal(nudges.length, 1, 'the runner is asked to nudge at the start of the episode, not on every refusal');
  assert.ok(nudges[0].text.includes(waitProcedure(outcome)));
});

test('a nudge the session could not take is journalled as not delivered', async () => {
  const { ask, noted } = polled('trusted', { delivered: false });
  for (let i = 0; i < 6; i++) await ask('ListAgents', {});
  assert.equal(noted.find((n) => n.event === 'phase.poll-loop')?.data.nudged, false);
});

test('a subagent\'s calls, and the tools the guard does not read, never reach the tracker', async () => {
  const { ask, tracker } = polled('guarded');
  for (let i = 0; i < 10; i++) {
    assert.equal((await ask('ListAgents', {}, { agent_id: 'agent-7' })).permissionDecision, 'allow');
  }
  await ask('Edit', { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' });
  assert.equal(tracker.counts.calls, 0);
});

test('a policy deny keeps its own reason — the guard only ever turns an allow into a deny', async () => {
  const { ask, noted } = polled('bypass');
  const answers = [];
  for (let i = 0; i < 8; i++) answers.push(await ask('Bash', { command: 'terraform destroy -auto-approve' }));
  assert.ok(answers.every((a) => a.permissionDecision === 'deny'));
  assert.ok(answers.every((a) => !/status checks/.test(a.permissionDecisionReason)), 'the wall answers, not the guard');
  assert.equal(noted.filter((n) => n.event === 'phase.poll-loop').length, 0);
});

test('the guard stands down while the phase verifies, and a broken tracker fails open', async () => {
  const verifying = polled('guarded', { status: 'verifying' });
  for (let i = 0; i < 10; i++) assert.equal((await verifying.ask('ListAgents', {})).permissionDecision, 'allow');
  assert.equal(verifying.tracker.counts.calls, 0);

  const broken = polled('guarded', { throws: true });
  for (let i = 0; i < 10; i++) assert.equal((await broken.ask('ListAgents', {})).permissionDecision, 'allow');
});


/**
 * console-open-findings O7 — paging a file is not a poll, whichever tool does it.
 *
 * `Read` is already exempt from the repeat rule, with the reason in the tuning
 * itself: "paging one large file by offset looked like a repeat". The Bash
 * equivalents — `sed -n 'N,Mp' f`, `scripts/view-file f N M` — had no such
 * exemption, so digit-folding made the eighth page of a file identical to the
 * first and the guard denied it. Reproduced in the source finding: 8 pages 8 s
 * apart, the 7th and 8th refused.
 *
 * ⚠️ THE TRAP, and why the carve-out is narrow: "a repeat whose digits advance"
 * is NOT a safe rule. `gh run view 1`, `gh run view 2`, … advances too, and it
 * is a real poll with nothing else catching it — `gh run view` is not an
 * `isProbeCommand`, so the repeat rule is the only thing that sees it. What
 * separates them is not that the numbers grow but that a page walk is a
 * CONTIGUOUS RANGE: two digit runs where the next starts exactly where the last
 * one ended. A single advancing number never qualifies.
 */
test('O7: paging a file by a contiguous range is not a repeat', () => {
  for (const page of [
    (a: number, b: number) => `sed -n '${a},${b}p' viewer/server/runner/runner.ts`,
    (a: number, b: number) => `scripts/view-file docs/plans/phase-07.md ${a} ${b}`,
  ]) {
    const calls = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => bash(page(i * 50 + 1, (i + 1) * 50)));
    const verdicts = feed(calls, 8_000);
    assert.deepEqual(
      verdicts.map((v) => v.deny), Array(8).fill(false),
      `paging was refused: ${page(1, 50)}`,
    );
  }
});

test('O7: a single advancing number is still a poll — the carve-out does not reach it', () => {
  const verdicts = feed([1, 2, 3, 4, 5, 6, 7].map((n) => bash(`gh run view ${n} --json status`)), 10_000);
  assert.ok(
    verdicts.some((v) => v.deny),
    'gh run view <id> advancing is the poll the repeat rule exists to catch',
  );
});

test('O7: a fixed range against changing names is still a repeat — only a walk is exempt', () => {
  const verdicts = feed([0, 1, 2, 3, 4, 5, 6, 7].map((i) => bash(`sed -n '1,50p' log-${i}.txt`)), 8_000);
  assert.ok(verdicts.some((v) => v.deny), 'the range never moves — that is not a page walk');
});


/**
 * console-open-findings O8 — CLOSED with the fact recorded, not by a behaviour
 * change.
 *
 * Phase 7 left this open as "unverified": it could not find the CLI's default
 * for `TaskOutput`'s `block` in the 2.1.274 binary. The tool's own schema
 * answers it — `"default": true`, and the description says "Use block=true
 * (default) to wait for task completion" — so an omitted `block` WOULD block.
 *
 * The guard still counts an omitted one, on purpose. `block` is in that schema's
 * `required` list, so a call without it is malformed and the CLI does not
 * produce one; the guard's rule for unknown input is to count it rather than
 * guess. Reading a default into a call that cannot occur would widen the one
 * tool a session could then use to poll, to fix nothing that happens.
 */
test('O8: block is what decides, and an absent one is still counted (the default is documented, not assumed)', () => {
  const state = newPollLoop();
  assert.equal(
    observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1', block: true } }, 0).status, false,
    'an explicit blocking read is the wait itself',
  );
  assert.equal(
    observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1', block: false } }, 1_000).status, true,
    'an explicit non-blocking read is a status check',
  );
  assert.equal(
    observeCall(state, { name: 'TaskOutput', input: { task_id: 'a1' } }, 2_000).status, true,
    'and an omitted one is unknown input, counted like any other malformed call',
  );
});
