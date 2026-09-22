/**
 * The usage window and the money (autopilot-token-drain phase 6, H6 + H7).
 *
 * Run `deadaff9` drained the `default` account's five-hour window twice: a
 * `run.usage-decision` at 95 % wrote `enacted: false` and nothing acted, so new
 * lanes kept boarding onto a nearly spent account; P2's session then sat through
 * 47 rate-limit retries (13:41:28 → 14:04:28, `retryDelayMs` 10 111 881) while the
 * live wall journalled two `none` decisions ten minutes apart before it waited on
 * a reset that was 2 h 48 min away all along; and the run view read $266.34 spent
 * while $111.87 was running in live sessions nobody could see.
 *
 * The harness is a trimmed copy of `runner.test.ts`'s: a temporary repo with stub
 * engine scripts, and only the `claude` child faked.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { BRAKE_HOLDER, Scheduler } from '../server/runner/scheduler.ts';
import { parseHookPayload, sessionsByAccount } from '../server/sessions/registry.ts';
import { unownedInboxDir } from '../shared/instances.mjs';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** A linear three-phase plan whose board is a `done` file the fake session appends to. */
function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-usage-brake-'));
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
    d=""; r=""; w=""; found=0
    for p in 1 2 3; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ] || [ -f "$S/parallel" ]; then r="$r$p,"; found=1
      else w="$w$p,"; fi
    done
    echo "done: \${d%,}"; echo "in-progress: "; echo "stuck: "
    echo "ready: \${r%,}"; echo "waiting: \${w%,}"
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), `#!/usr/bin/env bash
[ "\${2:-}" = "status" ] && echo "phase \${3:-?}: free"
exit 0
`);
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-0001', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

function runner(r: Repo, spawn: SpawnFn, extra: Partial<ConstructorParameters<typeof Runner>[0]> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    ...extra,
  });
  return { instance, events };
}

/* ------------------------------------------------------------------ *
 * Live cost beside booked spend (H7)
 * ------------------------------------------------------------------ */

test('a live lane reports what its session in flight has cost — replaced per result, and never a finished session\'s booked spend (H7)', async () => {
  const r = repo();
  const seen: (number | undefined)[] = [];
  let calls = 0;
  let live: () => number | undefined = () => undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    calls += 1;
    // What the lane claims the moment a session starts, before it says anything.
    seen.push(live());
    if (calls === 1) {
      request.onEvent?.({ kind: 'result', subtype: 'success', costUsd: 1.25, turns: 2 } as StreamEvent);
      seen.push(live());
      // The CLI's `total_cost_usd` is the session's running total: replaced, never summed.
      request.onEvent?.({ kind: 'result', subtype: 'success', costUsd: 2.5, turns: 1 } as StreamEvent);
      seen.push(live());
      // Ends with work in the tree and no paperwork, so the phase's lane runs
      // its closeout session next — the same lane, a second session.
      return ok({ costUsd: 2.5, resultText: 'ended without paperwork' });
    }
    r.markDone(1);
    return ok({ costUsd: 0.5 });
  };
  const { instance } = runner(r, spawn);
  live = () => instance.liveness().find((lane) => lane.phase === 1)?.spentUsd;
  try {
    execFileSync('git', ['init', '-q'], { cwd: r.root });
    writeFileSync(join(r.root, 'half-finished.txt'), 'work in flight\n');
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await instance.wait();
    assert.ok(calls >= 2, 'a second session ran on the phase\'s lane');
    assert.deepEqual(seen.slice(0, 4), [undefined, 1.25, 2.5, undefined],
      'nothing claimed before a result; the running total; and the next session starts from nothing — its predecessor is already booked');
    assert.ok((instance.current()!.spentUsd ?? 0) >= 3, 'the booked spend holds both sessions');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The live wall: act on the first burst when nothing can change (H6)
 * ------------------------------------------------------------------ */

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/** A clock the test winds by hand, shaped as `RunnerDeps.now`. */
function fakeClock(from: string) {
  const state = { at: Date.parse(from) };
  return { now: () => new Date(state.at), wind: (ms: number) => { state.at += ms; }, set: (iso: string) => { state.at = Date.parse(iso); } };
}

/** `Accounts.leaveAccount`, stubbed as `runner.test.ts` stubs it: a reset walls until it, none cools for 30 min. */
function leaveStub(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  const id = accountId ?? 'default';
  const resets = leaving.kind === 'usage' ? leaving.resetsAt ?? null : null;
  const until = (resets ?? new Date(Date.now() + 30 * 60_000)).toISOString();
  return {
    accountId: id, credential: 'stub', state: 'cooling', until,
    ...(leaving.kind === 'usage' && leaving.bucket && resets ? { wall: { bucket: leaving.bucket, resetsAt: resets.toISOString() } } : {}),
    throttleUntilMs: Date.parse(until),
  };
}

/** A session held open with its event sink captured. */
function streamingSession(r: Repo, markDone = true) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    entered();
    await held;
    if (markDone) r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

/** P2's retry, as `phase.api-retry` journalled it — the CLI's delay counting down to the window's reset. */
const p2Retry = (delayMs: number): StreamEvent => ({
  kind: 'retry', category: 'rate_limit', attempt: 1, maxRetries: 15, retryDelayMs: delayMs, errorStatus: 429, detail: 'rate_limit',
} as StreamEvent);

test('P2\'s wall: no account to move to and a reset hours away — the FIRST burst waits on the window, with no `none` decisions (H6)', async () => {
  const r = repo();
  const held = streamingSession(r, false);
  const clock = fakeClock('2026-09-16T13:30:04Z');
  const left: LeaveReason[] = [];
  const { instance, events } = runner(r, held.spawn, {
    now: clock.now,
    pickAccount: () => null,
    leaveAccount: (accountId, leaving) => { left.push(leaving); return leaveStub(accountId, leaving); },
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    held.say({ kind: 'init', sessionId: 'sess-p2', model: 'stub-1', tools: 0 } as StreamEvent);
    const reset = '2026-09-16T16:30:00.000Z';
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.95, utilizationPct: 95, resetsAt: Date.parse(reset) / 1000 });
    clock.set('2026-09-16T13:41:28.121Z');
    // 47 retries, thirty seconds apart, exactly as run deadaff9 journalled them.
    for (let i = 0; i < 47; i++) { held.say(p2Retry(10_111_881 - i * 30_000)); clock.wind(30_000); }

    const walls = journalled(events, 'phase.live-wall');
    assert.deepEqual(walls.map((wall) => wall.action), ['wait'], 'one decision, on the first burst — never "none" twice first');
    assert.equal(walls[0].until, reset, 'waits on the window\'s own reset');
    assert.equal(walls[0].trigger, 'far-reset');
    assert.equal(left.length, 1, 'the account is left once');
    assert.equal(left[0].resetsAt?.toISOString(), reset);
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting');
    assert.equal(record.parkedUntil, reset);
    assert.deepEqual(journalled(events, 'phase.rung').map((rung) => rung.rung), ['switch-account', 'wait-window']);
    assert.match(String(journalled(events, 'phase.situation').at(-1)?.why), /resets in 2 h 48 min/);
  } finally {
    held.release();
    await instance.stop();
    r.cleanup();
  }
});

test('a wall whose reset only the retry delay reports is still far — the burst waits on now + that delay (H6)', async () => {
  const r = repo();
  const held = streamingSession(r, false);
  const clock = fakeClock('2026-09-16T13:41:28Z');
  const left: LeaveReason[] = [];
  const { instance, events } = runner(r, held.spawn, {
    now: clock.now,
    pickAccount: () => null,
    leaveAccount: (accountId, leaving) => { left.push(leaving); return leaveStub(accountId, leaving); },
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'wait' });
    await held.inSession;
    held.say({ kind: 'init', sessionId: 'sess-delay', model: 'stub-1', tools: 0 } as StreamEvent);
    for (let i = 0; i < 3; i++) { held.say(p2Retry(10_111_881 - i * 30_000)); clock.wind(30_000); }
    // The third retry arrived at 13:42:28 and said 10 051 881 ms.
    const until = new Date(Date.parse('2026-09-16T13:42:28Z') + 10_051_881).toISOString();
    const walls = journalled(events, 'phase.live-wall');
    assert.deepEqual(walls.map((wall) => wall.action), ['wait']);
    assert.equal(walls[0].until, until);
    assert.equal(left[0].resetsAt?.toISOString(), until, 'the account is walled on the same clock, not a guessed cool-down');
  } finally {
    held.release();
    await instance.stop();
    r.cleanup();
  }
});

test('a wall that resets inside the action cooldown keeps the old debounce — the first burst is still `none` (H6)', async () => {
  const r = repo();
  const held = streamingSession(r, false);
  const clock = fakeClock('2026-09-16T13:41:28Z');
  const { instance, events } = runner(r, held.spawn, {
    now: clock.now,
    pickAccount: () => null,
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    held.say({ kind: 'init', sessionId: 'sess-near', model: 'stub-1', tools: 0 } as StreamEvent);
    const resetsAt = Math.floor((clock.now().getTime() + 5 * 60_000) / 1000);
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.99, utilizationPct: 99, resetsAt });
    for (let i = 0; i < 3; i++) { held.say(p2Retry(4 * 60_000)); clock.wind(20_000); }
    assert.deepEqual(journalled(events, 'phase.live-wall').map((wall) => wall.action), ['none'],
      'five minutes is not worth a checkpoint: the retries may simply get through');
  } finally {
    held.release();
    await instance.stop();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * The usage brake — admission (H6)
 * ------------------------------------------------------------------ */

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a braked account admits no NEW lane while one is live — never refuses the only one, never touches another account, and lapses at its reset (H6)', async () => {
  const clock = { at: Date.parse('2026-09-16T13:30:04Z') };
  const scheduler = new Scheduler({ now: () => clock.at, locks: () => [] });
  const request = (phase: number, accountId?: string) => ({
    slug: 'demo', phase, runId: 'run-1', scope: [`repo-${phase}`], ...(accountId ? { accountId } : {}),
  });
  try {
    const first = await scheduler.admit(request(1));
    assert.equal(first.accountId, undefined, 'the machine login is the absent account, on the grant as on the request');
    assert.equal(scheduler.brake(undefined, { untilMs: Date.parse('2026-09-16T16:30:00Z'), pct: 95 }), true, 'engaged');
    assert.equal(scheduler.brake(undefined, { untilMs: Date.parse('2026-09-16T16:30:00Z'), pct: 97 }), false, 'already engaged — once');

    const held = scheduler.wouldBlock(request(2));
    assert.equal(held.length, 1);
    assert.equal(held[0].slug, BRAKE_HOLDER);
    assert.match(held[0].owner, /95 %/);
    assert.deepEqual(scheduler.wouldBlock(request(3, 'spare')), [], 'another account pays for its own lanes');

    let boarded = false;
    const second = scheduler.admit(request(2)).then((grant) => { boarded = true; return grant; });
    await settle();
    assert.equal(boarded, false, 'queued behind the live lane');
    scheduler.release(first);
    const grant = await second;
    assert.equal(boarded, true, 'the brake never refuses the ONLY lane on the account');
    assert.equal(scheduler.wouldBlock(request(4))[0]?.slug, BRAKE_HOLDER, 'and holds the next one behind it');

    clock.at = Date.parse('2026-09-16T16:30:01Z');
    assert.deepEqual(scheduler.wouldBlock(request(4)), [], 'past its reset the brake holds nothing');
    assert.equal(scheduler.brakeOf(undefined), null);
    scheduler.release(grant);
  } finally { scheduler.close(); }
});

test('releasing the brake admits what it held, at once (H6)', async () => {
  const scheduler = new Scheduler({ locks: () => [] });
  try {
    const live = await scheduler.admit({ slug: 'demo', phase: 1, runId: 'run-1', scope: ['a'], accountId: 'work' });
    scheduler.brake('work', { untilMs: null, pct: 96 });
    let boarded = false;
    const waiting = scheduler.admit({ slug: 'demo', phase: 2, runId: 'run-1', scope: ['b'], accountId: 'work' })
      .then((grant) => { boarded = true; return grant; });
    await settle();
    assert.equal(boarded, false);
    const released = scheduler.releaseBrake('work');
    assert.equal(released?.pct, 96, 'the released brake is handed back for the journal');
    assert.equal(scheduler.releaseBrake('work'), null, 'twice is nothing');
    const grant = await waiting;
    assert.equal(boarded, true);
    scheduler.release(live);
    scheduler.release(grant);
  } finally { scheduler.close(); }
});

/* ------------------------------------------------------------------ *
 * The usage brake — the run's decision (H6)
 * ------------------------------------------------------------------ */

test('a 95 % warning with no account to move to engages the brake: `enacted` tells the truth, and a new lane on the account waits (H6)', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock('2026-09-16T13:30:04Z');
  const scheduler = new Scheduler({ now: () => clock.now().getTime(), locks: () => [] });
  const { instance, events } = runner(r, held.spawn, { now: clock.now, scheduler, pickAccount: () => null });
  try {
    const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    const reset = '2026-09-16T16:30:00.000Z';
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.95, utilizationPct: 95, resetsAt: Date.parse(reset) / 1000 });

    const decision = journalled(events, 'run.usage-decision')[0];
    assert.equal(decision.action, 'switch', 'the policy\'s decision, unchanged');
    assert.equal(decision.headroom, null, 'no account had headroom');
    assert.equal(decision.enacted, false, 'the switch was not carried out — nothing pretends it was');
    assert.equal(decision.brake, true, 'what WAS done: the account is braked');
    const braked = journalled(events, 'run.usage-brake');
    assert.deepEqual(braked, [{ accountId: 'default', utilizationPct: 95, thresholdPct: 95, window: 'five_hour', until: reset, live: 1 }]);
    const blockers = scheduler.wouldBlock({ slug: 'demo', phase: 2, runId: started.id, scope: ['elsewhere'] });
    assert.equal(blockers[0]?.slug, BRAKE_HOLDER, 'a second lane on the account would wait');

    // The same window read under the warning threshold: released, and said so.
    clock.wind(5 * 60_000);
    held.say({ kind: 'limits', status: 'allowed', window: 'five_hour', utilization: 0.4, utilizationPct: 40, resetsAt: Date.parse(reset) / 1000 });
    assert.deepEqual(journalled(events, 'run.usage-brake-released'),
      [{ accountId: 'default', reason: 'below-warn', utilizationPct: 40, heldMs: 5 * 60_000 }]);
    assert.equal(scheduler.brakeOf(undefined), null);
  } finally {
    held.release();
    await instance.wait();
    scheduler.close();
    r.cleanup();
  }
});

test('the brake outlasts a reading of ANOTHER window, and is released at the first reading past its reset (H6)', async () => {
  const r = repo();
  const held = streamingSession(r);
  const clock = fakeClock('2026-09-16T13:30:04Z');
  const scheduler = new Scheduler({ now: () => clock.now().getTime(), locks: () => [] });
  const { instance, events } = runner(r, held.spawn, {
    now: clock.now, scheduler, pickAccount: () => null, autoAccountSwitch: () => false,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'wait' });
    await held.inSession;
    const reset = Date.parse('2026-09-16T16:30:00Z') / 1000;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.96, utilizationPct: 96, resetsAt: reset });
    const decision = journalled(events, 'run.usage-decision')[0];
    assert.equal(decision.action, 'throttle');
    assert.equal(decision.enacted, true, 'hold new work — and the brake is exactly that');
    assert.equal('headroom' in decision, false, 'a throttle asks no picker');

    held.say({ kind: 'limits', status: 'allowed', window: 'seven_day', utilization: 0.3, utilizationPct: 30, resetsAt: reset + 86_400 });
    assert.deepEqual(journalled(events, 'run.usage-brake-released'), [], 'the weekly meter says nothing about the five-hour window');

    clock.set('2026-09-16T16:31:00Z');
    held.say({ kind: 'limits', status: 'allowed', window: 'five_hour', resetsAt: reset + 5 * 3600 });
    const released = journalled(events, 'run.usage-brake-released');
    assert.equal(released.length, 1);
    assert.equal(released[0].reason, 'reset');
  } finally {
    held.release();
    await instance.wait();
    scheduler.close();
    r.cleanup();
  }
});

test('with an account that has headroom, nothing is braked — the live wall moves the run at the wall (H6)', async () => {
  const r = repo();
  const held = streamingSession(r);
  const scheduler = new Scheduler({ locks: () => [] });
  const { instance, events } = runner(r, held.spawn, { scheduler, pickAccount: () => 'spare' });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.97, utilizationPct: 97, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    const decision = journalled(events, 'run.usage-decision')[0];
    assert.equal(decision.headroom, 'spare');
    assert.equal(decision.brake, false);
    assert.equal(decision.enacted, false);
    assert.deepEqual(journalled(events, 'run.usage-brake'), []);
    assert.equal(scheduler.brakeOf(undefined), null);
  } finally {
    held.release();
    await instance.wait();
    scheduler.close();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Attribution: who else is spending the account (H6)
 * ------------------------------------------------------------------ */

test('the presence hook reports the config dir its session reads credentials from, and whether an env credential overrides it — and the registry reads what the hook wrote (H6)', () => {
  const box = mkdtempSync(join(tmpdir(), 'pc-hook-account-'));
  const cwd = join(box, 'project');
  mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true });
  const base: NodeJS.ProcessEnv = {
    ...process.env, XDG_CONFIG_HOME: join(box, 'config'), XDG_STATE_HOME: join(box, 'state'), PHASE_CONSOLE_HOOK_INGEST: '0',
  };
  for (const name of ['DOCS_ROOT', 'PHASE_CONSOLE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete base[name];
  const hook = new URL('../../scripts/session-hook.sh', import.meta.url).pathname;
  const fire = (sessionId: string, env: NodeJS.ProcessEnv) => {
    const run = spawnSync('bash', [hook], {
      input: JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }), env, encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    const sink = unownedInboxDir(env);
    const name = (existsSync(sink) ? readdirSync(sink) : []).find((file) => file.includes(sessionId))!;
    return JSON.parse(readFileSync(join(sink, name), 'utf8')) as Record<string, unknown>;
  };
  try {
    const machine = fire('sess-machine', base);
    assert.equal(machine.config_dir, `${process.env.HOME}/.claude`, 'unset is the CLI\'s own default, stated');
    assert.equal(machine.auth_env, 0);
    assert.equal(parseHookPayload(machine)?.config_dir, `${process.env.HOME}/.claude`);
    assert.equal(parseHookPayload(machine)?.auth_env, undefined);

    const token = fire('sess-token', { ...base, CLAUDE_CONFIG_DIR: '/profiles/work', CLAUDE_CODE_OAUTH_TOKEN: 'never-sent' });
    assert.equal(token.config_dir, '/profiles/work');
    assert.equal(token.auth_env, 1, 'a flag — the credential itself never leaves the session');
    assert.doesNotMatch(JSON.stringify(token), /never-sent/);
    assert.equal(parseHookPayload(token)?.auth_env, true);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('live non-run sessions are counted per account only where a config dir names one — every other live session is `unattributed`, never guessed (H6)', () => {
  const live = { presence: 'live' as const };
  const counted = sessionsByAccount([
    { ...live, kind: 'foreign', configDir: '/home/op/.claude' },
    { ...live, kind: 'foreign', configDir: '/home/op/.claude/' },
    { ...live, kind: 'agent', configDir: '/state/accounts/work/config' },
    { ...live, kind: 'foreign', configDir: '/home/op/.claude-b' },
    { ...live, kind: 'foreign' },
    { ...live, kind: 'foreign', configDir: '/home/op/.claude', authEnv: true },
    { ...live, kind: 'autopilot', configDir: '/home/op/.claude' },
    { ...live, kind: 'foreign', configDir: '/home/op/.claude', probe: true },
    { presence: 'ended', kind: 'foreign', configDir: '/home/op/.claude' },
    { presence: 'unknown', kind: 'foreign', configDir: '/home/op/.claude' },
  ], [
    { accountId: 'default', configDir: '/home/op/.claude' },
    { accountId: 'work', configDir: '/state/accounts/work/config' },
  ]);
  assert.deepEqual(counted, {
    byAccount: { default: 2, work: 1 },
    // A dir no registered account uses, an old hook that reported none, and a
    // session whose env credential outranks its dir.
    unattributed: 3,
  });
});

test('the usage decision says who else is spending the account — or `unknown` when this console cannot see sessions (H6)', async () => {
  for (const seam of [true, false]) {
    const r = repo();
    const held = streamingSession(r);
    const { instance, events } = runner(r, held.spawn, {
      pickAccount: () => null,
      ...(seam ? { nonRunSessions: () => ({ byAccount: { default: 2 }, unattributed: 1 }) } : {}),
    });
    try {
      await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
      await held.inSession;
      held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.95, utilizationPct: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
      const decision = journalled(events, 'run.usage-decision')[0];
      assert.deepEqual(decision.nonRunSessions, seam ? { byAccount: { default: 2 }, unattributed: 1 } : 'unknown');
    } finally {
      held.release();
      await instance.wait();
      r.cleanup();
    }
  }
});


/**
 * console-open-findings O11 — `preFirstTurn` must ask what THIS session spent,
 * not what the lane has spent across all of them.
 *
 * Every other clause of that predicate is per-attempt: `lastToolUseAt`,
 * `turnsSinceLastTool`, `openTools`, `commitsSinceStart` (measured from
 * `attemptStartedAt`) and `record.tasksAt` (deleted at every spawn). The spend
 * clause read `lane.spentUsd`, whose ONLY writer replaces it from the CLI's
 * running total and which nothing clears between sessions — so once a lane had
 * spent a cent, no later session on it could ever be seen as pre-first-turn. Its
 * sibling `lane.sessionUsd` is the per-session field, cleared when spawnSession
 * starts and again when it returns, and that is the one the predicate means.
 */
test('O11: the pre-first-turn spend clause is per SESSION, and rolls over like every other clause', async () => {
  const core = await import('../server/runner/runner-core.ts');
  const src = readFileSync(new URL('../server/runner/runner.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('private preFirstTurn('));
  const clause = body.slice(0, body.indexOf('\n  }'));
  assert.ok(
    /sessionUsd/.test(clause),
    `preFirstTurn must read the per-session spend:\n${clause}`,
  );
  assert.ok(
    !/lane\.spentUsd/.test(clause),
    'lane.spentUsd survives the session that earned it — it can never mean "this attempt"',
  );
  // and the contract the two fields carry, so a later reader cannot swap them back
  assert.ok(core, 'runner-core loads');
  const base = readFileSync(new URL('../server/runner/runner-base.ts', import.meta.url), 'utf8');
  assert.ok(
    (base.match(/delete shared\.sessionUsd/g) ?? []).length >= 2,
    'sessionUsd is cleared when a session starts and again when it returns',
  );
  assert.ok(
    !/delete\s+\w+\.spentUsd/.test(base),
    'nothing clears spentUsd — which is exactly why it is the wrong field here',
  );
});
