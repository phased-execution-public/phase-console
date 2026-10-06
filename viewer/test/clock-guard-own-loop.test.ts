/**
 * The in-turn clock guard judges a wait by its SUBJECT (control-tower phase
 * 111, #179, #206).
 *
 * #179 — control-tower P34, 2026-10-01: an in-turn loop timing the session's
 * OWN fixture (`until [ "$(date +%s)" -ge "$target" ]; do sleep 5` around a
 * `net` server it had just written to /tmp) was read as somebody else's clock —
 * the summary was cut at `http://127`, and a cut loopback URL read as a remote
 * host. The watchdog checkpointed the session at minute 5, parked the run for
 * a fixed 30 minutes with no nudge, wrote `stop.kind: declared` over a
 * declaration nobody made, and re-parked it 72 s after an operator's resume.
 *
 * #206 — ai-builder-v7 P17, 2026-10-03: a call held 2 min 45 s on a person's
 * approval card counted toward its "5 minutes"; its window stayed open after
 * it returned and fired 2 min 20 s into a DIFFERENT, sanctioned own-job wait;
 * and the checkpoint killed the session's two release preflights.
 *
 *   CG-1  a wait whose subject is the session's own clock or process takes the
 *         own-job rungs (a nudge at 10 min, the park at 45), not the 5-minute
 *         external checkpoint;
 *   CG-2  an external clock park is preceded by a nudge, and a park is bounded
 *         by what is known — a loop's own target instant, not a fixed window;
 *   CG-3  the lifecycle names the watchdog as the actor, never `declared`;
 *   CG-4  an operator's resume cuts a watchdog window short — or refuses and
 *         says why — and the runner does not park the phase again for it;
 *   CG-5  time held on an approval card never counts toward a wait, and a
 *         window closes when its call returns once another wait is open;
 *   CG-6  a checkpoint never ends the session's own background jobs: the
 *         external park waits for them, under the own-job rungs.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyEvent, creditHeldTime, evaluateStall, newLaneSignals, stallThresholds, waitScope, type LaneSignals,
} from '../server/runner/liveness.ts';
import { Runner } from '../server/runner/runner.ts';
import { VERIFY_ENV_FALLBACK } from '../server/runner/verify-env.ts';
import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { loadRun, newRun, phaseRecord, runDir, saveRun } from '../server/runner/state.ts';
import { phaseLifecycle } from '../shared/run-lifecycle.js';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const ENV = VERIFY_ENV_FALLBACK;
const iso = (ms: number) => new Date(ms).toISOString();

const call = (id: string, command: string): StreamEvent => ({ kind: 'tool', id, name: 'Bash', summary: command });
const back = (id: string): StreamEvent => ({ kind: 'tool-result', id, ok: true });
const feed = (signals: LaneSignals, event: StreamEvent, at: number) => applyEvent(signals, event, at, ENV);
const stallAt = (signals: LaneSignals, at: number) => evaluateStall(signals, stallThresholds(), at, { verifyEnv: ENV });

/** The P34 call, as its summary reached the console — cut at `http://127`. */
const P34 = 'target=$(date -j -u -f \'%Y-%m-%dT%H:%M:%SZ\' \'2026-10-01T07:54:40Z\' +%s); until [ "$(date +%s)" -ge "$target" ]; '
  + 'do sleep 5; done; date -u +%H:%M:%SZ node /tmp/p34-blackhole.mjs 47911 & BH=$!; sleep 1 export npm_config_https_proxy=http://127';

/** Somebody else's clock, with nothing in it the console can mint a ref from. */
const CI_WAIT = 'while sleep 30; do gh api repos/acme/api/actions/runs >/dev/null; done';

/* ------------------------------------------------------------------ *
 * A runner over a stub engine, as `wait-chains.test.ts` builds one
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: () => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-clock-guard-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const script = (name: string, body: string) => { writeFileSync(join(scripts, name), body, 'utf8'); chmodSync(join(scripts, name), 0o755); };
  script('phase-graph.sh', `#!/usr/bin/env bash
S="${state}"; slug="$1"; shift; mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  script('phase-lock.sh', '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: () => writeFileSync(join(state, 'done'), '1\n'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-guard', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

function fakeClock() {
  const at = { now: T0 };
  return { now: () => new Date(at.now), wind: (ms: number) => { at.now += ms; } };
}

/** One session held open; `deaf` makes its stdin refuse every write (no nudge can arrive). */
function heldSession(r: Repo, opts: { deaf?: boolean } = {}) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const sent: string[] = [];
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    request.onHandle?.({
      pid: undefined, open: () => !opts.deaf, send: (text: string) => { if (opts.deaf) return false; sent.push(text); return true; }, setFrozen: () => {},
    });
    request.onEvent?.({ kind: 'init', sessionId: 'sess-guard', model: 'stub-1', tools: 0 });
    entered();
    await held;
    r.markDone();
    return ok();
  };
  return { spawn, inSession, sent, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

function runner(r: Repo, spawn: SpawnFn, now: () => Date) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, now, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/* ------------------------------------------------------------------ *
 * CG-1 — the subject decides whose clock it is
 * ------------------------------------------------------------------ */

test('CG-1: a loop on the session\'s own clock is its own job — P34\'s call reads local', () => {
  assert.equal(waitScope(P34), 'local', 'its condition reads only the clock; the cut URL names no host');
  assert.equal(waitScope('until grep -q up /tmp/srv.log; do sleep 2; done; curl -s http://127'), 'local', 'a URL cut at the summary\'s end is no remote host');
  // Controls: a clock-bounded loop that polls GitHub in its body, and a plain CI wait, are somebody else's clock.
  assert.equal(waitScope('until [ "$(date +%s)" -ge "$deadline" ]; do gh run view 123 --json status | grep -q completed && break; sleep 30; done'), 'external');
  assert.equal(waitScope('until gh run view 123 --json status | grep -q completed; do sleep 30; done'), 'external');
  assert.equal(waitScope('curl -sf https://ci.example.invalid/status'), 'external');
});

test('CG-1: the P34 loop gets the own-job rungs — no park at 5 minutes, a nudge at 10, still running', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    held.say(call('toolu_p34', P34));
    clock.wind(6 * MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].status, 'running', 'not checkpointed at minute 5');
    assert.equal(journalled(events, 'phase.external-wait').length, 0);
    clock.wind(5 * MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].stallRemedy?.localNudges, 1, 'the own-job nudge at 10 minutes');
    assert.equal(instance.current()!.phases['1'].status, 'running');
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * CG-2 / CG-3 — a nudge before the park; the park bounded by what is known; the watchdog named
 * ------------------------------------------------------------------ */

test('CG-2: an external clock is nudged first and parked only if the call is still open after the grace', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    held.say(call('toolu_ci', CI_WAIT));
    clock.wind(6 * MINUTE);
    await instance.tickLiveness();
    let record = instance.current()!.phases['1'];
    assert.equal(record.status, 'running', 'not parked on the first tick');
    assert.equal(held.sent.length, 1, 'the session is told first');
    assert.match(held.sent[0]!, /somebody else's clock/);
    assert.equal(journalled(events, 'phase.auto-nudged').at(-1)?.scope, 'external');
    clock.wind(2 * MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].status, 'running', 'inside the grace');
    clock.wind(4 * MINUTE);
    await instance.tickLiveness();
    record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'parked once the grace ran out with the call still open');
    // CG-3: the console parked it, and the lifecycle on disk says so.
    const saved = loadRun(r.root, 'demo', instance.current()!.id, null)!.phases['1'];
    assert.equal(saved.lifecycle?.stop?.kind, 'watchdog');
    assert.equal(saved.lifecycle?.stop?.declared, 'waiting-external');
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('CG-2: a session that cannot be told is parked at once, as before', async () => {
  const r = repo();
  const held = heldSession(r, { deaf: true });
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    held.say(call('toolu_ci', CI_WAIT));
    clock.wind(6 * MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].status, 'waiting');
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('CG-2: a park on a loop with a known target resumes at that target, not a fixed window', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    // `parkWaiting` reads the wall clock, so the loop's target is a real instant 9 minutes ahead.
    const target = iso(Math.ceil((Date.now() + 9 * MINUTE) / 1000) * 1000);
    const loop = `target=$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' '${target.replace(/\.000Z$/, 'Z')}' +%s); until [ "$(date +%s)" -ge "$target" ]; do sleep 30; done`;
    held.say(call('toolu_clock', loop));
    clock.wind(46 * MINUTE);
    await instance.tickLiveness();
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'parked at the own-job budget');
    assert.equal(record.parkedUntil, target, 'the loop said when it ends — 9 minutes, not 30');
    assert.match(record.parkReason ?? '', /its loop ends at/);
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('CG-3: the lifecycle reads a watchdog park as the watchdog\'s, and a session\'s word as declared', () => {
  const watchdog = phaseLifecycle({ status: 'waiting', declared: { status: 'waiting-external', by: 'watchdog' } } as never);
  assert.deepEqual(watchdog.stop, { kind: 'watchdog', declared: 'waiting-external' });
  const session = phaseLifecycle({ status: 'waiting', declared: { status: 'waiting-external', by: 'session' } } as never);
  assert.equal(session.stop?.kind, 'declared');
});

/* ------------------------------------------------------------------ *
 * CG-4 — an operator's resume of a run waiting on a park
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: omega
created: 2026-10-04
status: active
phases: 1
---

# omega

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | release | — | — | app | it ships |

## Phases

### Phase 1 — release
- **Size:** S
`;

const PERSON = { by: 'ana', via: 'api', origin: 'local', remoteUser: null, door: 'operator' } as never;

function service() {
  const root = mkdtempSync(join(tmpdir(), 'pc-resume-cut-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'omega.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const starts: Record<string, unknown>[] = [];
  (svc as never as Record<string, unknown>).startRun = async (slug: string, options: Record<string, unknown>) => {
    starts.push({ slug, ...options });
    return loadRun(root, 'omega', String(options.resumeRunId), null);
  };
  /** A run waiting on phase 1's park, as the watchdog (or the session) left it. */
  const waiting = (declared: Record<string, unknown>) => {
    const state = newRun({ slug: 'omega', root });
    const until = new Date(Date.now() + 30 * MINUTE).toISOString();
    Object.assign(state, { status: 'waiting', waitReason: 'external', waitUntil: until });
    const record = phaseRecord(state, 1);
    Object.assign(record, {
      status: 'waiting', attempts: 1, sessionId: 'sess-p1', parkedUntil: until,
      declared: { status: 'waiting-external', at: new Date().toISOString(), ...declared },
    });
    saveRun(state);
    return state;
  };
  const journal = (runId: string) => {
    const file = join(runDir(root, 'omega'), `run-${runId}.jsonl`);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { root, svc, starts, waiting, journal, cleanup: async () => { await svc.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('CG-4: an operator\'s resume cuts a WATCHDOG window short, so the loop boards the phase now — never re-parked for it', async () => {
  const h = service();
  try {
    const state = h.waiting({ by: 'watchdog', reason: 'waiting on an external clock inside the turn', watch: [] });
    const before = Date.now();
    const answer = await h.svc.resumeRun('omega', PERSON);
    assert.equal(answer.ok, true, answer.ok ? '' : answer.error);
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0]!.resumeRunId, state.id);
    const record = loadRun(h.root, 'omega', state.id, null)!.phases['1'];
    assert.ok(record.parkedUntil && Date.parse(record.parkedUntil) <= Date.now(), 'the window is over: the loop admits a waiting phase whose clock has passed');
    assert.ok(Date.parse(record.parkedUntil!) >= before - 1000);
    const cut = h.journal(state.id).filter((e) => e.event === 'phase.wait-cut');
    assert.equal(cut.length, 1);
    assert.equal(cut[0].data.by, 'ana');
    assert.equal(cut[0].data.parker, 'watchdog');
  } finally { await h.cleanup(); }
});

test('CG-4: a session\'s own declared wait is re-asked — landed, it is cut; not landed, the resume is refused, saying why', async () => {
  const h = service();
  try {
    const flag = join(h.root, 'gate.done');
    const state = h.waiting({ by: 'session', reason: 'the gate run', watch: [`cmd:"test -f ${flag}"`] });
    const refused = await h.svc.resumeRun('omega', PERSON);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.status, 409);
    assert.match(!refused.ok ? refused.error : '', /phase 1 waits on cmd:"test -f /);
    assert.match(!refused.ok ? refused.error : '', /has not landed/);
    assert.equal(h.starts.length, 0, 'nothing started that would only park again');
    writeFileSync(flag, 'ALL GREEN\n');
    const resumed = await h.svc.resumeRun('omega', PERSON);
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error);
    assert.equal(h.starts.length, 1);
    const record = loadRun(h.root, 'omega', state.id, null)!.phases['1'];
    assert.ok(Date.parse(record.parkedUntil!) <= Date.now(), 'its ref is true: the wait is over now, not at the backstop');
  } finally { await h.cleanup(); }
});

test('CG-4: an automatic press never cuts a wait short', async () => {
  const h = service();
  try {
    const state = h.waiting({ by: 'watchdog', watch: [] });
    const was = loadRun(h.root, 'omega', state.id, null)!.phases['1'].parkedUntil;
    await h.svc.resumeRun('omega', { by: 'supervisor', via: 'supervisor', origin: 'test', door: 'supervisor' } as never);
    assert.equal(loadRun(h.root, 'omega', state.id, null)!.phases['1'].parkedUntil, was, 'the window stands');
    assert.equal(h.journal(state.id).filter((e) => e.event === 'phase.wait-cut').length, 0);
  } finally { await h.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * CG-5 — card time, and a window that closes with its call
 * ------------------------------------------------------------------ */

test('CG-5: time a call spends held on an approval card is not waiting', () => {
  const signals = newLaneSignals(T0);
  const lsRemote = 'until [ "$(git -C /work/tb ls-remote origin refs/heads/pe/x | cut -c1-8)" = "19a25a53" ]; do sleep 10; done';
  feed(signals, call('toolu_ls', lsRemote), T0);
  // Held on a person's card from 1 s to 2 min 46 s, then it ran.
  creditHeldTime(signals, { toolUseId: 'toolu_ls', since: T0 + 1000, until: T0 + 166_000 });
  // 5 min 10 s after it went out, but only 2 min 25 s of it was waiting.
  assert.equal(stallAt(signals, T0 + 310_000)?.signal === 'external-wait', false, 'the card\'s minutes are not the wait\'s');
  // …and the window still opens once the call has really waited five minutes.
  assert.equal(stallAt(signals, T0 + 166_000 + 5 * MINUTE + 1000)?.signal, 'external-wait');
});

test('CG-5: a window closes when its call returns once the session is in another wait — the new wait is judged on its own', () => {
  const signals = newLaneSignals(T0);
  feed(signals, call('toolu_ls', 'until [ "$(git -C /work/tb ls-remote origin refs/heads/pe/x | cut -c1-8)" = "19a25a53" ]; do sleep 10; done'), T0);
  feed(signals, back('toolu_ls'), T0 + 166_000);
  // The session's own preflights, which it started itself.
  feed(signals, call('toolu_own', 'until grep -q \'^EXIT=\' /tmp/p17/tb-verify2.log && grep -q \'^EXIT=\' /tmp/p17/aws-verify2.log; do sleep 15; done'), T0 + 231_000);
  const at = T0 + 311_000; // 5 min 11 s after the ls-remote call went out, 2 min 25 s after it returned
  const stall = stallAt(signals, at);
  assert.notEqual(stall?.signal, 'external-wait', 'the returned call\'s window is closed');
  // The own-job wait, judged on its own clock and scope, much later:
  const late = stallAt(signals, T0 + 231_000 + 6 * MINUTE);
  assert.equal(late?.signal, 'external-wait');
  assert.equal(late?.scope, 'local');
});

/* ------------------------------------------------------------------ *
 * CG-6 — the session's own background jobs outlive no checkpoint
 * ------------------------------------------------------------------ */

test('CG-6: while the session\'s own background job runs, an external wait is not checkpointed — the own-job rungs apply', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    held.say({ kind: 'background', op: 'started', taskId: 'bg-verify', taskType: 'local_bash', tool: 'Bash', description: 'npm run verify:local > /tmp/p17/tb.log' } as StreamEvent);
    held.say(call('toolu_ci', CI_WAIT));
    clock.wind(12 * MINUTE);
    await instance.tickLiveness();
    clock.wind(MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].status, 'running', 'its job would die with the session: no checkpoint');
    assert.equal(journalled(events, 'phase.external-wait').length, 0);
    assert.equal(journalled(events, 'phase.auto-nudged').at(-1)?.scope, 'local', 'the own-job nudge instead');
    // The job finishes: the wait is somebody else's clock again, and parks as one (after its nudge's grace).
    held.say({ kind: 'background', op: 'ended', taskId: 'bg-verify', status: 'completed' } as StreamEvent);
    clock.wind(6 * MINUTE);
    await instance.tickLiveness();
    assert.equal(instance.current()!.phases['1'].status, 'waiting');
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});
