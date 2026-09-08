/**
 * The two ultra tiers — `ultracode` and `ultrareview` (P14).
 *
 * Five properties, in the order they can go wrong:
 *
 *   1. **the licence is a word, and its ABSENCE is the default** — `ultracode`
 *      has no CLI flag; the opt-in is the word in the prompt. So the pin has to
 *      run in both directions, and the second direction is the one that
 *      matters: a run that never asked must not be paying for dozens of agents;
 *   2. **the resolution order** — a phase may carve itself out of a run's
 *      answer in either direction, and silence at both levels is off;
 *   3. **the feature detection**, which cannot read the exit code. Measured on
 *      `claude` 2.1.258: `claude nosuchsubcommand --help` also exits 0 and
 *      prints the TOP-LEVEL usage, because an unknown word is taken as a
 *      prompt. A probe that trusted the status would report the capability
 *      present on every CLI ever shipped;
 *   4. **the payload reader**, which must recover a finding list in several
 *      spellings and must NEVER answer `approved` from a container it could not
 *      find — an approval manufactured by a parser bug is a clean bill of
 *      health nobody gave, and this one is bought with the operator's money;
 *   5. **both tiers driven through the actual Runner**: the licence reaching a
 *      phase prompt and no other; a stubbed cloud review landing findings
 *      through the same door the session reviewer's go through, under the same
 *      hold policy; and a missing subcommand degrading to `unknown` while the
 *      run finishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const STATE_HOME = mkdtempSync(join(tmpdir(), 'pc-ultra-state-'));
process.env.XDG_STATE_HOME = STATE_HOME;
process.env.XDG_CONFIG_HOME = join(STATE_HOME, 'config');
process.env.PHASE_CONSOLE_LOG = '';
// The suite may itself be running under an autopilot, whose exported identity
// would otherwise reach the runner under test.
for (const key of ['PE_WORKTREE', 'PE_BRANCH', 'PE_SCOPE', 'PE_OWNER', 'PE_SESSION_ID']) {
  delete process.env[key];
}

const { ULTRACODE_LINE, ultracodeDirective } = await import('../server/skills.ts');
const { ultracodeOn } = await import('../server/runner/runner-core.ts');
const {
  ULTRAREVIEW_EVENTS, ULTRAREVIEW_TIMEOUT_MINUTES, lastFinishedPhase,
  parseUltraReviewPayload, probeUltraReview, runUltraReview, singleFlight, ultraReviewArgv,
} = await import('../server/runner/ultrareview.ts');
const { buildAgentLaunch } = await import('../server/agent.ts');
const { ULTRA_REVIEW_MODES } = await import('../shared/run-lifecycle.js');
const { Runner } = await import('../server/runner/runner.ts');
import type { SpawnFn, SpawnOutcome, SpawnRequest } from '../server/runner/spawn.ts';

test.after(() => rmSync(STATE_HOME, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * 1. the licence, and its absence
 * ------------------------------------------------------------------ */

test('the directive is the line and nothing else — and off is the empty string', () => {
  assert.equal(ultracodeDirective(true), `\n${ULTRACODE_LINE}\n`);
  // Byte-pinned emptiness. `''` concatenated into a prompt leaves the prompt
  // byte-identical to the one composed before this feature existed, which is
  // the property the whole opt-in rests on.
  assert.equal(ultracodeDirective(false), '');
});

test('the line SAYS what it licenses rather than ordering a fan-out', () => {
  // The word itself is load-bearing: the harness recognises `ultracode` in the
  // prompt and confirms the standing licence back to the session. Renaming it
  // would silently turn the feature off.
  assert.match(ULTRACODE_LINE, /^ultracode\b/);
  assert.match(ULTRACODE_LINE, /Workflow tool/);
  assert.match(ULTRACODE_LINE, /standing licence and not an instruction/);
});

test('a phase may carve itself out of the run in either direction', () => {
  assert.equal(ultracodeOn(null, null), false, 'silence at both levels is off');
  assert.equal(ultracodeOn({}, {}), false);
  assert.equal(ultracodeOn({ ultracode: true }, {}), true, 'the run alone');
  assert.equal(ultracodeOn({}, { ultracode: true }), true, 'the phase alone');
  // The two that make this a resolution rather than an OR.
  assert.equal(ultracodeOn({ ultracode: true }, { ultracode: false }), false,
    'a phase that said "not here" outranks a run that said "everywhere"');
  assert.equal(ultracodeOn({ ultracode: false }, { ultracode: true }), true,
    'and a phase that said "here" outranks a run that said nothing of the sort');
});

test('an agent ticket carries the licence only when it asked for it', () => {
  const ctx = { scriptsDir: '/x', skills: [], defaultSkills: [], planSkill: 'phased-execution' };
  const off = buildAgentLaunch({ prompt: 'do a thing' }, ctx as never);
  assert.equal(off.ok, true);
  assert.equal(
    (off as { launch: { args: string[] } }).launch.args.join('\n').includes('ultracode'), false,
    'a ticket nobody opted in for must not mention it at all',
  );
  const on = buildAgentLaunch({ prompt: 'do a thing', ultracode: true }, ctx as never);
  assert.equal(on.ok, true);
  assert.ok(
    (on as { launch: { args: string[] } }).launch.args.some((a) => a.includes(ULTRACODE_LINE)),
    'an opted-in ticket carries the line verbatim',
  );
  // Anything that is not `true` is silence, and silence is off. A ticket that
  // fans out dozens of agents has to have been asked for in so many words.
  for (const value of ['true', 1, {}, 'ultracode']) {
    const fuzzy = buildAgentLaunch({ prompt: 'x', ultracode: value }, ctx as never);
    assert.equal(
      (fuzzy as { launch: { args: string[] } }).launch.args.join('\n').includes('ultracode'), false,
      `\`ultracode: ${JSON.stringify(value)}\` is not an opt-in`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 2. the subcommand probe and its argv
 * ------------------------------------------------------------------ */

/** A `child_process.spawn` that answers from a script rather than a process. */
function fakeSpawn(
  answer: (argv: string[]) => { code?: number; stdout?: string; stderr?: string; error?: string },
): { spawn: typeof import('node:child_process').spawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = ((_file: string, argv: string[]) => {
    calls.push([...argv]);
    const said = answer(argv);
    const child = new EventEmitter() as EventEmitter & {
      pid?: number; stdout: PassThrough; stderr: PassThrough;
    };
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (said.error) { child.emit('error', new Error(said.error)); return; }
      if (said.stdout) child.stdout.write(said.stdout);
      if (said.stderr) child.stderr.write(said.stderr);
      child.emit('close', said.code ?? 0);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, calls };
}

const HELP = 'Usage: claude ultrareview [options] [target]\n\nRun a cloud-hosted multi-agent review\n';
const TOP_LEVEL_HELP = 'Usage: claude [options] [command] [prompt]\n\nClaude Code - starts a session\n';

test('the argv is the same one every time, and never posts to a pull request', () => {
  assert.deepEqual(ultraReviewArgv(), [
    'ultrareview', '--json', '--no-post', '--timeout', String(ULTRAREVIEW_TIMEOUT_MINUTES),
  ]);
  assert.deepEqual(ultraReviewArgv({ target: '42', timeoutMinutes: 5 }),
    ['ultrareview', '--json', '--no-post', '--timeout', '5', '42']);
  // `--no-post` is the CLI's own default and is passed anyway: this console
  // never writes to somebody's pull request, and a default can change.
  assert.ok(ultraReviewArgv().includes('--no-post'));
});

test('the probe reads the help TEXT, because the exit code says nothing', async () => {
  const real = fakeSpawn(() => ({ code: 0, stdout: HELP }));
  assert.deepEqual(await probeUltraReview({ spawn: real.spawn }), { available: true });
  assert.deepEqual(real.calls[0], ['ultrareview', '--help']);

  // The measured failure: an unknown subcommand ALSO exits 0, printing the
  // top-level usage. A probe that trusted the status would say "present" here.
  const absent = fakeSpawn(() => ({ code: 0, stdout: TOP_LEVEL_HELP }));
  const verdict = await probeUltraReview({ spawn: absent.spawn });
  assert.equal(verdict.available, false);
  assert.match(verdict.reason ?? '', /no `ultrareview` subcommand/);
});

test('no CLI at all is a different errand from no subcommand', async () => {
  const gone = fakeSpawn(() => ({ error: 'spawn claude ENOENT' }));
  const verdict = await probeUltraReview({ spawn: gone.spawn });
  assert.equal(verdict.available, false);
  assert.match(verdict.reason ?? '', /not on this console's PATH/);
});

/* ------------------------------------------------------------------ *
 * 3. the payload
 * ------------------------------------------------------------------ */

const PATHS = ['server/a.ts', 'server/b.ts'];

test('a finding list is read in every spelling the tool might use', () => {
  const report = parseUltraReviewPayload(JSON.stringify({
    bugs: [
      { path: 'server/a.ts', line: 12, body: 'this can be null' },
      { file: 'server/b.ts', start_line: 3, title: 'unbounded loop', description: 'no exit' },
      { location: { path: 'server/a.ts', line: 40 }, message: 'races the writer' },
    ],
  }), 'may-hold');
  assert.ok(report);
  assert.equal(report.findings.length, 3);
  assert.deepEqual(report.findings[0], { path: 'server/a.ts', line: 12, body: 'this can be null' });
  // A headline and an explanation are both kept: a label with no reason is not
  // a finding a person can act on.
  assert.equal(report.findings[1].body, 'unbounded loop — no exit');
  assert.equal(report.findings[1].line, 3);
  assert.equal(report.findings[2].path, 'server/a.ts');
  assert.equal(report.verdict, 'requested-changes', 'something found is changes requested');
});

test('a bare array is a finding list too', () => {
  const report = parseUltraReviewPayload('[{"path":"server/a.ts","body":"off by one"}]', 'may-hold');
  assert.equal(report?.findings.length, 1);
});

test('an empty list is an approval; a list it could not find is NOT', () => {
  const empty = parseUltraReviewPayload('{"bugs":[]}', 'may-hold');
  assert.equal(empty?.verdict, 'approved', 'zero findings in a list we really read is a clean bill');
  // The load-bearing half. A schema that moved must never be able to say the
  // code is fine — that is an approval manufactured by a parser bug, bought
  // with the operator's money.
  assert.equal(parseUltraReviewPayload('{"summary":"all good"}', 'may-hold'), null);
  assert.equal(parseUltraReviewPayload('', 'may-hold'), null);
  assert.equal(parseUltraReviewPayload('not json at all', 'may-hold'), null);
  assert.equal(parseUltraReviewPayload('{"bugs":"soon"}', 'may-hold'), null);
});

test('the run\'s hold policy governs this reviewer exactly as it governs the other', () => {
  const payload = '{"bugs":[{"path":"server/a.ts","body":"this leaks"}]}';
  const held = parseUltraReviewPayload(payload, 'may-hold');
  assert.equal(held?.verdict, 'requested-changes');
  assert.equal(held?.askedFor, undefined, 'nothing was downgraded');

  const quiet = parseUltraReviewPayload(payload, 'comment-only');
  assert.equal(quiet?.verdict, 'commented', 'comment-only records the finding and holds nothing');
  assert.equal(quiet?.askedFor, 'requested-changes', 'and says what it downgraded');
});

test('a path the caller cannot anchor is dropped, and the cap is the reviewer\'s', () => {
  const anchored = parseUltraReviewPayload(JSON.stringify({
    bugs: [{ path: 'server/a.ts', body: 'real' }, { path: 'nowhere/x.ts', body: 'invented' }],
  }), 'may-hold', PATHS);
  assert.deepEqual(anchored?.findings.map((f) => f.path), ['server/a.ts']);

  const many = parseUltraReviewPayload(JSON.stringify({
    bugs: Array.from({ length: 60 }, (_, i) => ({ path: 'server/a.ts', body: `finding ${i}` })),
  }), 'may-hold');
  assert.equal(many?.findings.length, 25, 'MAX_REVIEWER_COMMENTS, shared with the session reviewer');
});

test('a stated verdict is honoured only when this console already knows the word', () => {
  const stated = parseUltraReviewPayload('{"verdict":"approved","bugs":[]}', 'may-hold');
  assert.equal(stated?.verdict, 'approved');
  // A vocabulary of somebody else's is not translated into ours — the finding
  // count decides, because that is a fact rather than a guess.
  const foreign = parseUltraReviewPayload(
    '{"verdict":"LOOKS_FINE","bugs":[{"path":"a.ts","body":"x"}]}', 'may-hold');
  assert.equal(foreign?.verdict, 'requested-changes');
});

/* ------------------------------------------------------------------ *
 * 4. the child, and every way it can fail to answer
 * ------------------------------------------------------------------ */

test('a review that could not run is `unknown` with the reason, never a verdict', async () => {
  const noSubcommand = fakeSpawn(() => ({ code: 0, stdout: TOP_LEVEL_HELP }));
  const absent = await runUltraReview({ cwd: '/x', policy: 'may-hold', spawn: noSubcommand.spawn });
  assert.equal(absent.state, 'unknown');
  assert.match((absent as { reason: string }).reason, /no `ultrareview` subcommand/);
  assert.equal(noSubcommand.calls.length, 1, 'and the review itself was never started');

  const refused = fakeSpawn((argv) => (argv.includes('--help')
    ? { code: 0, stdout: HELP }
    : { code: 1, stderr: 'Ultrareview could not launch: needs a git repository' }));
  const failed = await runUltraReview({ cwd: '/x', policy: 'may-hold', spawn: refused.spawn });
  assert.equal(failed.state, 'unknown');
  assert.match((failed as { reason: string }).reason, /needs a git repository/);

  const garbage = fakeSpawn((argv) => (argv.includes('--help')
    ? { code: 0, stdout: HELP }
    : { code: 0, stdout: 'reviewing...\n' }));
  const unreadable = await runUltraReview({ cwd: '/x', policy: 'may-hold', spawn: garbage.spawn });
  assert.equal(unreadable.state, 'unknown');
  assert.match((unreadable as { reason: string }).reason, /no payload this console could read/);
});

test('a review that ran lands a report', async () => {
  const good = fakeSpawn((argv) => (argv.includes('--help')
    ? { code: 0, stdout: HELP }
    : { code: 0, stdout: '{"bugs":[{"path":"server/a.ts","body":"this leaks"}]}' }));
  const landed = await runUltraReview({ cwd: '/x', policy: 'comment-only', spawn: good.spawn });
  assert.equal(landed.state, 'landed');
  assert.equal((landed as { findings: number }).findings, 1);
  assert.deepEqual(good.calls[1], ultraReviewArgv());
});

test('a second press buys nothing — one review per run at a time', async () => {
  const inFlight = new Map<string, Promise<number>>();
  const releases: ((n: number) => void)[] = [];
  const start = () => new Promise<number>((resolve) => { releases.push(resolve); });

  const first = singleFlight(inFlight, 'demo', start);
  const second = singleFlight(inFlight, 'demo', start);
  // A different plan is a different branch, which is a review somebody meant
  // to buy — the guard is keyed, not global.
  const other = singleFlight(inFlight, 'beta', start);
  assert.equal(releases.length, 2, 'one review per plan, not one per press');
  assert.equal(first, second, 'and both callers hold the SAME promise');

  releases[0](7);
  assert.equal(await first, 7);
  assert.equal(await second, 7, "the second press gets the first press's answer");
  // Cleared when the work ends, so the NEXT press really does start one.
  assert.equal(inFlight.has('demo'), false);
  assert.equal(inFlight.has('beta'), true, 'and the other plan is untouched');
  releases[1](1);
  assert.equal(await other, 1);
});

test('the run-wide review hangs on the last phase that finished', () => {
  assert.equal(lastFinishedPhase(undefined), null);
  assert.equal(lastFinishedPhase({ 1: { phase: 1, status: 'failed' } }), null);
  assert.equal(lastFinishedPhase({
    1: { phase: 1, status: 'done' }, 4: { phase: 4, status: 'done' }, 2: { phase: 2, status: 'parked' },
  }), 4);
});

/* ------------------------------------------------------------------ *
 * 5. both tiers, driven through the real Runner
 * ------------------------------------------------------------------ */

/** One modified file: enough that the session reviewer is not skipped on an empty window. */
const DIFF = {
  slug: 'demo', phase: 1,
  window: { kind: 'handoff-window', base: 'aaa', tip: 'bbb', note: 'bracketed by the handoffs' },
  commits: [{ sha: 'bbb1111', subject: 'do the thing' }],
  files: [{
    path: 'server/a.ts', status: 'modified', additions: 1, deletions: 0, binary: false,
    hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ kind: 'add', text: 'const c = 4;', newLine: 2 }] }],
  }],
  additions: 1, deletions: 0, truncated: false, failed: false,
};

type Stub = { root: string; scripts: string; state: string; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A one-phase plan whose phase boards, verifies and finishes. */
function stubPlan(): Stub {
  const root = mkdtempSync(join(tmpdir(), 'pc-ultra-run-'));
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
shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx "1" "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready:"; else echo "done:"; echo "ready: 1"; fi
    echo "waiting:"
    ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --gate-status) echo "clear" ;;
  --repos) echo "demo-repo" ;;
  *) echo "" ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  write(join(scripts, 'next-phase-prompt.sh'), '#!/usr/bin/env bash\nexit 0\n');
  write(join(scripts, 'new-handoff.sh'), '#!/usr/bin/env bash\nexit 0\n');
  return { root, scripts, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function outcomeFor(text: string, costUsd = 0): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd, turns: 1, resultText: text,
    durationMs: 10, argv: ['-p', '<prompt>'],
  };
}

type Drive = {
  prompts: string[];
  recorded: { phase: number; report: { verdict: string; findings: unknown[]; askedFor?: string } }[];
  events: { event: string; data: Record<string, unknown> }[];
  ultraArgv: string[][];
  status: string | undefined;
};

/** The payloads of one journal event kind — they reach `onEvent` as `run:journal`. */
function journal(
  events: { event: string; data: Record<string, unknown> }[], kind: string,
): Record<string, unknown>[] {
  return events
    .filter((e) => e.event === 'run:journal' && e.data.event === kind)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);
}

async function drive(
  s: Stub, start: Record<string, unknown> = {},
  cloud: (argv: string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({ code: 0, stdout: HELP }),
): Promise<Drive> {
  const prompts: string[] = [];
  const recorded: Drive['recorded'] = [];
  const events: Drive['events'] = [];
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    prompts.push(request.prompt);
    const phase = /BOOT phase (\d+)/.exec(request.prompt)?.[1];
    if (phase) {
      writeFileSync(join(s.state, 'done'), `${phase}\n`, { flag: 'a' });
      return outcomeFor('done', 1);
    }
    return outcomeFor('```review\n{"verdict":"approved","findings":[]}\n```', 0.25);
  };
  const ultra = fakeSpawn(cloud);
  const runner = new Runner({
    scriptsDir: s.scripts,
    spawn,
    ultraReviewSpawn: ultra.spawn,
    verificationText: () => '`true`',
    onEvent: (event: string, data: Record<string, unknown>) => { events.push({ event, data }); },
    reviewer: {
      facts: async (_slug: string, phase: number, policy: string) => ({
        slug: 'demo', phase, policy, diff: DIFF,
      }),
      record: (_slug: string, phase: number, report: Drive['recorded'][number]['report']) => {
        recorded.push({ phase, report });
      },
    },
  } as never);
  await runner.start({ slug: 'demo', root: s.root, onlyPhases: [1], ...start } as Parameters<typeof runner.start>[0]);
  await runner.wait();
  return {
    prompts, recorded, events, ultraArgv: ultra.calls,
    status: (runner.current() as { phases?: Record<string, { status: string }> } | null)?.phases?.['1']?.status,
  };
}

test('a run that never asked for the licence composes a prompt that never mentions it', async () => {
  const s = stubPlan();
  try {
    const { prompts, ultraArgv } = await drive(s);
    assert.equal(prompts.length, 1, 'the phase session, and nothing else');
    // Byte-pinned absence: not merely "no line", but the word nowhere at all.
    assert.equal(prompts[0].includes('ultracode'), false);
    assert.equal(prompts[0].includes('Workflow tool'), false);
    assert.deepEqual(ultraArgv, [], 'and no cloud review was even probed for');
  } finally { s.cleanup(); }
});

test('with the licence on, the phase prompt carries the line verbatim', async () => {
  const s = stubPlan();
  try {
    const { prompts } = await drive(s, { ultracode: true });
    assert.ok(prompts[0].includes(ULTRACODE_LINE), 'the line, byte for byte');
    // Order: it rides with the other directives and the unattended contract
    // still has the last word.
    assert.ok(prompts[0].indexOf(ULTRACODE_LINE) < prompts[0].indexOf('UNATTENDED SESSION CONTRACT'));
  } finally { s.cleanup(); }
});

test('a phase that said "not here" is not licensed, on a run that said "everywhere"', async () => {
  const s = stubPlan();
  try {
    const { prompts } = await drive(s, {
      ultracode: true, phaseOptions: { 1: { ultracode: false } },
    });
    assert.equal(prompts[0].includes('ultracode'), false);
  } finally { s.cleanup(); }
});

test('the bounded sessions beside a phase get no licence to fan out', async () => {
  const s = stubPlan();
  try {
    const { prompts } = await drive(s, { ultracode: true, reviewEachPhase: true });
    assert.equal(prompts.length, 2, 'the phase, then the reviewer');
    assert.ok(prompts[0].includes(ULTRACODE_LINE), 'the phase is licensed');
    assert.equal(prompts[1].includes('ultracode'), false,
      'the reviewer is asked for one artefact and given the budget for one');
  } finally { s.cleanup(); }
});

test('a cloud review lands its findings through the same door, under the same policy', async () => {
  const s = stubPlan();
  try {
    const { recorded, events, ultraArgv } = await drive(
      s, { ultraReview: 'each-phase' },
      (argv) => (argv.includes('--help')
        ? { code: 0, stdout: HELP }
        : { code: 0, stdout: '{"bugs":[{"path":"server/a.ts","line":4,"body":"this leaks"}]}' }),
    );
    assert.deepEqual(ultraArgv[1], ultraReviewArgv(), 'the pinned argv, on the real path');
    assert.equal(recorded.length, 1, 'the report reached `reviewer.record`');
    // The run said nothing about holding, so the cautious default applies —
    // the same rule, and the same downgrade, the session reviewer obeys.
    assert.equal(recorded[0].report.verdict, 'commented');
    assert.equal(recorded[0].report.askedFor, 'requested-changes');
    const done = journal(events, ULTRAREVIEW_EVENTS.done);
    assert.equal(done.length, 1);
    assert.equal(done[0].ok, true);
    assert.equal(done[0].findings, 1);
    assert.equal(done[0].downgradedBy, 'comment-only');
  } finally { s.cleanup(); }
});

test('may-hold lets the cloud reviewer hold, exactly as it lets the other one', async () => {
  const s = stubPlan();
  try {
    const { recorded } = await drive(
      s, { ultraReview: 'each-phase', reviewerPolicy: 'may-hold' },
      (argv) => (argv.includes('--help')
        ? { code: 0, stdout: HELP }
        : { code: 0, stdout: '{"bugs":[{"path":"server/a.ts","body":"this leaks"}]}' }),
    );
    assert.equal(recorded[0].report.verdict, 'requested-changes');
    assert.equal(recorded[0].report.askedFor, undefined);
  } finally { s.cleanup(); }
});

test('a missing subcommand is journalled `unknown` and the phase still reads done', async () => {
  const s = stubPlan();
  try {
    const { recorded, events, status } = await drive(
      s, { ultraReview: 'each-phase' }, () => ({ code: 0, stdout: TOP_LEVEL_HELP }),
    );
    assert.deepEqual(recorded, [], 'no verdict was invented from an absent tool');
    const done = journal(events, ULTRAREVIEW_EVENTS.done);
    assert.equal(done.length, 1);
    assert.equal(done[0].ok, false);
    assert.match(String(done[0].reason), /no `ultrareview` subcommand/);
    // The whole degradation contract in one assertion: a tool that is not here
    // costs a journal line, never a park.
    assert.equal(status, 'done');
    assert.equal(journal(events, 'run.halted').length, 0);
  } finally { s.cleanup(); }
});

test('at-settle does not run at a phase-finish, and each-phase does not run at settle', async () => {
  const s = stubPlan();
  try {
    const { events, ultraArgv } = await drive(
      s, { ultraReview: 'at-settle' },
      (argv) => (argv.includes('--help') ? { code: 0, stdout: HELP } : { code: 0, stdout: '{"bugs":[]}' }),
    );
    const started = journal(events, ULTRAREVIEW_EVENTS.started);
    assert.equal(started.length, 1, 'exactly one review, for the whole run');
    assert.equal(started[0].occasion, 'at-settle');
    assert.equal(ultraArgv.length, 2, 'probed once, run once');
  } finally { s.cleanup(); }
});

test('the three words are the vocabulary, and `off` is one of them', () => {
  // `off` is spelled so a person can CHOOSE it in a form; it is never written
  // to disk, where absent is the same state.
  assert.deepEqual([...ULTRA_REVIEW_MODES], ['off', 'each-phase', 'at-settle']);
});
