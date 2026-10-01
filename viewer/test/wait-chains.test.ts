/**
 * A wait is judged as a chain, and a refusal ends when the session moves on
 * (control-tower phase 47 — #52, #67, AUD-34).
 *
 * Two measured failures, one mechanism: the console judged a wait by ONE Bash
 * call. The wait procedure bounds a foreground call at ten minutes, so a long
 * local job is waited on in slices, and a clock measured per call could never
 * reach a rung past ten minutes — 32 cards, 0 nudges and 0 parks over one
 * 5.86-hour hold. And a refused wait's episode ended only on a commit or a
 * declaration, so a session that took the refusal and went on working read as
 * still waiting 16 minutes later, was killed, and its rung settled "the
 * session declared waiting-external" over a declaration nobody made.
 *
 *   WC-1..3  the refusal, the watchdog's park and its rung (EC2)
 *   WC-4..8  the chain, its age, its one card (EC3)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyEvent, evaluateStall, mintWatchRef, newLaneSignals, noteWaitDenied, probeSignature, stallThresholds, waitScope,
  type LaneSignals,
} from '../server/runner/liveness.ts';
import { Runner } from '../server/runner/runner.ts';
import { VERIFY_ENV_FALLBACK } from '../server/runner/verify-env.ts';
import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { LOCAL_WAIT_LABEL, STALL_LOCAL_JOB_MS, WAIT_CHAIN_GAP_MS } from '../shared/attention-model.js';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const ENV = VERIFY_ENV_FALLBACK;

const call = (id: string, command: string): StreamEvent => ({ kind: 'tool', id, name: 'Bash', summary: command });
const back = (id: string, extra: { refused?: boolean } = {}): StreamEvent => ({ kind: 'tool-result', id, ok: !extra.refused, ...extra });
const feed = (signals: LaneSignals, event: StreamEvent, at: number) => applyEvent(signals, event, at, ENV);
const stallAt = (signals: LaneSignals, at: number) => evaluateStall(signals, stallThresholds(), at, { verifyEnv: ENV });

/* ------------------------------------------------------------------ *
 * A runner over a stub engine, as `usage-brake.test.ts` builds one
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-wait-chains-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const script = (name: string, body: string) => {
    writeFileSync(join(scripts, name), body, 'utf8');
    chmodSync(join(scripts, name), 0o755);
  };
  script('phase-graph.sh', `#!/usr/bin/env bash
set -u
S="${state}"
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: "
    ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`);
  script('phase-lock.sh', '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  script('validate.sh', '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${readFileSync(join(state, 'done'), 'utf8')}${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ok(partial: Partial<SpawnOutcome> = {}): SpawnOutcome {
  return {
    signal: { subtype: 'success', code: 0, text: '' },
    sessionId: 'sess-chain', costUsd: 0.02, turns: 3, resultText: 'done',
    durationMs: 10, argv: ['-p', '<prompt>'], ...partial,
  };
}

function fakeClock() {
  const at = { now: T0 };
  return { now: () => new Date(at.now), wind: (ms: number) => { at.now += ms; } };
}

/** One session held open, with its event sink and an open stdin a nudge can reach. */
function heldSession(r: Repo) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  const sent: string[] = [];
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    request.onHandle?.({
      pid: undefined, open: () => true, send: (text: string) => { sent.push(text); return true; }, setFrozen: () => {},
    });
    request.onEvent?.({ kind: 'init', sessionId: 'sess-chain', model: 'stub-1', tools: 0 });
    entered();
    await held;
    r.markDone(1);
    return ok();
  };
  return { spawn, inSession, sent, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

function runner(r: Repo, spawn: SpawnFn, now: () => Date) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, now,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
  });
  return { instance, events };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/* ------------------------------------------------------------------ *
 * A console, reached for its announce path (the `stall-corrective` harness)
 * ------------------------------------------------------------------ */

function console_() {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: { category: string; message: { title: string; body?: string } }[] = [];
  sv.push.announce = ((category: string, message: { title: string; body?: string }) => {
    pushed.push({ category, message });
  }) as typeof sv.push.announce;
  sv.webhooks.announce = (() => {}) as typeof sv.webhooks.announce;
  const inner = sv as unknown as {
    notifications: {
      list(): { items: { category: string; title: string; body?: string; resolved?: unknown }[] };
      clear(what: 'all'): number;
    };
    prefs: { notify: Record<string, boolean> };
    announceStall: (data: unknown) => void;
  };
  inner.notifications.clear('all');
  inner.prefs.notify = { ...inner.prefs.notify, stalled: true };
  const cards = () => inner.notifications.list().items.filter((item) => item.category === 'stalled');
  return { sv, inner, pushed, cards };
}

/* ------------------------------------------------------------------ *
 * EC2 — the refusal, the watchdog's park and its rung
 * ------------------------------------------------------------------ */

test('WC-1 — a refused wait ends on the session\'s next call that is not the refused probe again', () => {
  const signals = newLaneSignals(T0);
  const refused = 'until curl -sf https://ci.example.invalid/status; do sleep 30; done';
  noteWaitDenied(signals, { command: refused, matched: 'until' }, T0, STALL_LOCAL_JOB_MS);

  feed(signals, call('again', 'curl -sf https://ci.example.invalid/status'), T0 + MINUTE);
  assert.ok(signals.waitDenied, 'polling the refused probe again is still acting on the refusal');
  feed(signals, { kind: 'tool', id: 'sub', name: 'Read', summary: 'notes.md', parent: 'task-1' }, T0 + 2 * MINUTE);
  assert.ok(signals.waitDenied, 'a subagent\'s call is not the session moving on');

  // No commit, no declaration: the session simply went on to other work.
  feed(signals, call('work', 'npm test -- --run lib'), T0 + 3 * MINUTE);
  assert.equal(signals.waitDenied, undefined, 'the session moved on, so the refusal is over');
  // …which is what keeps the watchdog off it: nothing is left to act on.
  feed(signals, back('work'), T0 + 4 * MINUTE);
  assert.notEqual(stallAt(signals, T0 + 9 * MINUTE)?.source, 'denied');

  noteWaitDenied(signals, { command: refused, matched: 'until' }, T0 + 10 * MINUTE, STALL_LOCAL_JOB_MS);
  feed(signals, { kind: 'tool', id: 'read', name: 'Read', summary: 'src/app.ts' }, T0 + 11 * MINUTE);
  assert.equal(signals.waitDenied, undefined, 'any call of its own on something else ends it');

  noteWaitDenied(signals, { command: refused, matched: 'until' }, T0 + 12 * MINUTE, STALL_LOCAL_JOB_MS);
  feed(signals, call('declare',
    'bash scripts/phase-outcome.sh demo 1 waiting-external --watch "cmd:curl -sf https://ci.example.invalid/status"'),
  T0 + 13 * MINUTE);
  assert.equal(signals.waitDenied, undefined, 'and a declaration still ends it, even naming the same probe');
});

test('WC-2/WC-3 — a watchdog park records no unpollable ref, and its rung settles as the watchdog\'s act', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, clock.now);
  try {
    const state = await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    // A rung the ladder was climbing when this attempt boarded.
    (state as unknown as { recoveries: unknown }).recoveries = {
      1: { rungs: [{ situation: 'no-handoff', rung: 'reboard-fresh', at: new Date(T0 - MINUTE).toISOString(), outcome: 'running' }] },
    };
    // Somebody else's clock, with no landing the console could poll: a bare
    // `while` lands when its condition goes false, which no ref can say.
    const wait = 'while sleep 30; do gh api repos/acme/api/actions/runs >/dev/null; done';
    assert.equal(mintWatchRef(wait), null, 'precondition: nothing to mint');
    held.say(call('toolu_wait', wait));
    clock.wind(6 * MINUTE);
    await instance.tickLiveness();

    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'parked on somebody else\'s clock');
    assert.deepEqual(record.watch ?? [], [], 'the command is not a ref, and is not recorded as one');
    assert.match(record.parkReason ?? '', /no ref the console can poll/);
    assert.equal(journalled(events, 'phase.watch-unpollable').length, 0, 'nothing unpollable was handed to the scheduler');
    assert.equal(journalled(events, 'phase.external-wait')[0]?.watch, null);

    held.release();
    await instance.wait();
    const rung = (instance.current() as unknown as { recoveries: Record<string, { rungs: { outcome?: string; note?: string }[] }> })
      .recoveries['1'].rungs[0];
    assert.equal(rung.outcome, 'interrupted', 'the watchdog ended the attempt — not a verdict on the rung');
    assert.match(String(rung.note), /watchdog/);
    assert.doesNotMatch(String(rung.note), /the session declared/);
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * EC3 — the chain
 * ------------------------------------------------------------------ */

test('WC-4 — calls of one probe signature within the gap are ONE chain; a longer gap or another probe is a new one', () => {
  const signals = newLaneSignals(T0);
  const poll = 'until grep -q GATE-EXIT /tmp/p9-gate.log; do sleep 10; done';
  assert.equal(probeSignature(poll), '/tmp/p9-gate.log', 'the key is what the call waits on');
  assert.equal(WAIT_CHAIN_GAP_MS, 3 * MINUTE);

  feed(signals, call('a', poll), T0);
  feed(signals, back('a'), T0 + 10 * MINUTE);
  // Re-issued 30 s later and spelled differently — the same log is the same wait.
  feed(signals, call('b', 'end=$((SECONDS+590)); until grep -q "GATE-EXIT" /tmp/p9-gate.log; do sleep 15; done'), T0 + 10.5 * MINUTE);
  assert.equal(signals.waitChains?.length, 1);
  assert.equal(signals.waitChains![0].calls, 2);
  assert.equal(signals.waitChains![0].since, T0, 'the chain is as old as its first call');
  feed(signals, back('b'), T0 + 20.5 * MINUTE);

  // A single status poll of the same log inside the gap is part of the wait.
  feed(signals, call('c', 'tail -n 5 /tmp/p9-gate.log'), T0 + 21 * MINUTE);
  feed(signals, back('c'), T0 + 21 * MINUTE + 1_000);
  assert.equal(signals.waitChains![0].calls, 3);
  // …but it starts nothing on its own: a lone look is not a wait.
  feed(signals, call('look', 'tail -n 5 /tmp/other.log'), T0 + 21 * MINUTE + 2_000);
  assert.equal(signals.waitChains!.length, 1);

  feed(signals, call('d', 'until curl -sf http://localhost:3000/health; do sleep 2; done'), T0 + 22 * MINUTE);
  assert.equal(signals.waitChains!.length, 2, 'another probe is another chain');
  feed(signals, back('d'), T0 + 22 * MINUTE + 1_000);

  // The first log again, after MORE than the gap: a new wait.
  feed(signals, call('e', poll), T0 + 21 * MINUTE + 1_000 + WAIT_CHAIN_GAP_MS + 1_000);
  const fresh = signals.waitChains!.find((chain) => chain.key === '/tmp/p9-gate.log');
  assert.equal(fresh?.calls, 1);
  assert.ok(fresh!.since > T0);

  // A call the console refused never waited, so it is not a link.
  feed(signals, call('no', 'until gh run view 7 -q .status | grep -q completed; do sleep 30; done'), T0 + 30 * MINUTE);
  feed(signals, back('no', { refused: true }), T0 + 30 * MINUTE + 1);
  assert.equal(signals.waitChains!.find((chain) => chain.key === 'gh run 7'), undefined);
});

test('WC-5 — ten-minute slices of one local wait age as ONE episode and pass the local-job budget', () => {
  const signals = newLaneSignals(T0);
  const poll = 'until grep -q DONE /tmp/suite.log; do sleep 10; done';
  const mids = [];
  let at = T0;
  for (let slice = 0; slice < 5; slice += 1) {
    feed(signals, call(`s${slice}`, poll), at);
    mids.push(stallAt(signals, at + 9 * MINUTE));
    feed(signals, back(`s${slice}`), at + 10 * MINUTE);
    // Between two slices the episode holds: the gap is part of the wait.
    const between = stallAt(signals, at + 10 * MINUTE + 10_000);
    assert.equal(between?.signal, 'external-wait', `slice ${slice}: the gap did not end the wait`);
    assert.equal(between?.since, new Date(T0).toISOString());
    at += 10 * MINUTE + 30_000;
  }
  for (const stall of mids) {
    assert.equal(stall?.signal, 'external-wait');
    assert.equal(stall?.scope, 'local');
    assert.equal(stall?.since, new Date(T0).toISOString(), 'one episode, as old as the chain');
  }
  assert.equal(mids[3]?.overBudget, undefined, '40 minutes in: inside the budget');
  assert.equal(mids[4]?.overBudget, true, '51 minutes in: past it, though no call was ever older than ten');
  assert.match(mids[4]!.detail, /5 calls on `\/tmp\/suite\.log`/, 'the card names what it waits on');
  assert.deepEqual(mids[4]?.chain, { key: '/tmp/suite.log', calls: 5 });
});

test('WC-6 — the nudge and the park read the chain\'s age: sanctioned slices reach the 45-minute rung', async () => {
  const r = repo();
  const held = heldSession(r);
  const clock = fakeClock();
  const { instance, events } = runner(r, held.spawn, clock.now);
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
    await held.inSession;
    const poll = 'until grep -q DONE /tmp/suite.log; do sleep 10; done';
    const slice = async (id: string, tickAfter: number[]) => {
      held.say(call(id, poll));
      let spent = 0;
      for (const at of tickAfter) { clock.wind(at - spent); spent = at; await instance.tickLiveness(); }
      clock.wind(10 * MINUTE - spent);
      held.say(back(id));
      clock.wind(30_000);
    };
    await slice('s1', [6 * MINUTE]);             // chain 6 min: a local wait, silent, no nudge yet
    assert.equal(instance.current()!.phases['1'].stallRemedy?.localNudges ?? 0, 0);
    await slice('s2', [2 * MINUTE]);             // chain 12.5 min, call 2 min: the nudge is the chain's
    assert.equal(instance.current()!.phases['1'].stallRemedy?.localNudges, 1, 'nudged on the chain\'s age');
    assert.equal(held.sent.length, 1);
    await slice('s3', [5 * MINUTE]);
    await slice('s4', [5 * MINUTE]);             // chain ~36.5 min: still working, still its lane
    assert.equal(instance.current()!.phases['1'].status, 'running');
    held.say(call('s5', poll));
    clock.wind(4 * MINUTE);                      // chain 46 min, call 4 min
    await instance.tickLiveness();

    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'waiting', 'parked at the local-job budget — per call it never got past ten minutes');
    // The poll's condition would be its ref, but the job it waits on is the
    // SESSION's own, and the checkpoint signals the session's process group —
    // so the job ends with it and no ref is armed on its output; the record
    // owes the next session a re-run (control-tower phase 89, #121 ask 2).
    assert.deepEqual(record.watch ?? [], [], 'no ref armed on the output of a job the checkpoint ended');
    assert.match(record.parkReason ?? '', /ends that job with the session/);
    assert.equal(record.reverify?.cause, 'checkpoint');
    assert.equal(journalled(events, 'phase.stall').length, 2, 'one episode, and one line when it passed its budget — not one per slice');
    assert.equal(journalled(events, 'phase.stall')[1]?.overBudget, true);
    held.release();
    await instance.wait();
  } finally { r.cleanup(); }
});

test('WC-7 — a local chain inside its budget is silent; past it, it is said once, under its own name', () => {
  const { sv, pushed, cards, inner } = console_();
  try {
    const since = new Date(T0).toISOString();
    const local = {
      signal: 'external-wait', scope: 'local', source: 'open', since,
      detail: '3 calls on `/tmp/suite.log` over 31 min — it waits on a background job this session started',
      chain: { key: '/tmp/suite.log', calls: 3 },
    };
    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 2, attempt: 1, stall: local });
    assert.equal(cards().length, 0, 'the wait procedure being followed is not a card');
    assert.equal(pushed.length, 0);

    const over = { ...local, overBudget: true, detail: '5 calls on `/tmp/suite.log` over 51 min — it waits on a background job this session started' };
    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 2, attempt: 1, stall: over });
    assert.equal(cards().length, 1, 'past the budget it is said');
    assert.match(cards()[0].title, new RegExp(LOCAL_WAIT_LABEL.toLowerCase()), 'titled by its scope');
    assert.match(pushed.at(-1)?.message.body ?? '', /\/tmp\/suite\.log/, 'naming what it waits on');

    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 2, attempt: 1, stall: over });
    assert.equal(cards().length, 1, 'and said once');
  } finally { sv.close?.(); }
});

test('WC-8 — one card per chain: a slice is not news, a new chain replaces the old card', () => {
  const { sv, cards, inner } = console_();
  try {
    const first = new Date(T0).toISOString();
    const external = {
      signal: 'external-wait', scope: 'external', source: 'open', since: first,
      detail: 'a Bash call matching `gh run watch` has been open for 5 min — it waits on a clock outside this session: `gh run 42`',
      chain: { key: 'gh run 42', calls: 1 },
    };
    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 3, attempt: 1, stall: external });
    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 3, attempt: 1, stall: { ...external, chain: { key: 'gh run 42', calls: 2 } } });
    assert.equal(cards().length, 1, 'the second call of the chain is the same wait');

    const next = { ...external, since: new Date(T0 + 30 * MINUTE).toISOString(), chain: { key: 'gh run 43', calls: 1 } };
    inner.announceStall({ slug: 'demo', runId: 'run-1', phase: 3, attempt: 1, stall: next });
    assert.equal(cards().length, 2);
    assert.equal(cards().filter((card) => !card.resolved).length, 1, 'the earlier chain\'s card stood down');
  } finally { sv.close?.(); }
});

/* ------------------------------------------------------------------ *
 * MR — the ref the console mints (control-tower phase 88, #121 item 3)
 * ------------------------------------------------------------------ */

test('CK-1 — quoted DATA is masked before the remote-verb test: a slice of the session\'s own wait that quotes "aws …" stays local', () => {
  // P27, hub 4123 2026-09-25: its chain on its own verify jobs read `local`,
  // then `external` two calls in (seq 2414 → 2416) — a call quoted a phrase
  // beginning `"aws ` — and the checkpoint came at 9.7 minutes, not 45.
  const own = 'until [ -f /tmp/p27/aws-verify.rc ]; do sleep 30; done; grep -c "aws verify: PASS" /tmp/p27/aws-verify.log';
  assert.equal(waitScope(own), 'local', 'a quoted phrase is data, not an aws call');
  // Code stays code: a remote verb outside quotes, or inside a `-c` payload.
  assert.equal(waitScope('until aws s3 ls s3://bucket/done > /tmp/s3.log; do sleep 30; done'), 'external');
  assert.equal(waitScope('bash -c "gh run watch 123" > /tmp/ci.log'), 'external');
  assert.equal(waitScope('until curl -sf "https://status.example.test/health"; do sleep 30; done'), 'external', 'a quoted URL is still a URL');
});

test('CK-2 — a chain keeps the scope it started with: a later slice that happens to name a remote word is still the session\'s own job', () => {
  const signals = newLaneSignals(T0);
  feed(signals, call('a1', 'until [ -f /tmp/p27/het-verify.rc ]; do sleep 30; done'), T0);
  feed(signals, back('a1'), T0 + 10 * MINUTE);
  // The next slice of the SAME wait (the same file) mentions `ssh ` in passing.
  feed(signals, call('a2', 'until [ -f /tmp/p27/het-verify.rc ]; do sleep 30; done; echo ssh deploy-host was not used'), T0 + 10 * MINUTE + 5_000);
  const chain = signals.waitChains?.find((one) => one.key === probeSignature('until [ -f /tmp/p27/het-verify.rc ]; do sleep 30; done'));
  assert.equal(chain?.calls, 2, 'one chain');
  assert.equal(chain?.scope, 'local', 'decided by its first wait');
  const stall = stallAt(signals, T0 + 16 * MINUTE);
  assert.equal(stall?.signal, 'external-wait');
  assert.equal(stall?.scope, 'local', 'judged on the local budget — no checkpoint before 45 minutes');
});

test('MR-1 — a minted cmd: ref is PARSED, never sliced: each `[ … ]` member is its own test, and a ref with $ or a relative path is never minted', () => {
  // P27's loop, hub 4123 2026-09-25: minted as `test -f …het-verify.rc ] && [ -f …aws-verify.rc` — unbalanced.
  assert.equal(
    mintWatchRef('until [ -f /tmp/p27/het-verify.rc ] && [ -f /tmp/p27/aws-verify.rc ]; do sleep 30; done'),
    'cmd:"test -f /tmp/p27/het-verify.rc && test -f /tmp/p27/aws-verify.rc"',
  );
  assert.equal(mintWatchRef('until [ -f /tmp/a ] || [ -f /tmp/b ]; do sleep 5; done'), 'cmd:"test -f /tmp/a || test -f /tmp/b"');
  // vca P10, 2026-09-26: the session's `$L`, minted single-quoted, could never land.
  assert.equal(mintWatchRef('until grep -q "ios done" "$L" 2>/dev/null; do sleep 2; done'), null);
  assert.equal(mintWatchRef('until test -f out/sweep/ios.rc; do sleep 5; done'), null, 'relative to the SESSION\'s cwd, not the console\'s');
  assert.equal(mintWatchRef('until [ -f /tmp/x.rc ] && ./import.sh; do sleep 5; done'), null, 'every member must be a probe');
  // A self-contained one is minted as it was.
  assert.equal(
    mintWatchRef('until grep -q ANDROID_JOB_DONE /tmp/vca/e2e/android-final.log 2>/dev/null; do sleep 10; done'),
    'cmd:"grep -q ANDROID_JOB_DONE /tmp/vca/e2e/android-final.log 2>/dev/null"',
  );
});

test('MR-2 — a watchdog park never arms a minted cmd: ref the console will not run; with watchMintedCmdRefs on, it does', async () => {
  const park = async (mintedCmdRefs?: () => boolean) => {
    const r = repo();
    const held = heldSession(r);
    const clock = fakeClock();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const instance = new Runner({
      scriptsDir: r.scripts, spawn: held.spawn, now: clock.now,
      verificationText: () => '`true`',
      onEvent: (event, data) => events.push({ event, data }),
      ...(mintedCmdRefs ? { mintedCmdRefs } : {}),
    });
    try {
      await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1] });
      await held.inSession;
      held.say(call('toolu_wait', 'until curl -sf https://status.example.test/health; do sleep 30; done'));
      clock.wind(6 * MINUTE);
      await instance.tickLiveness();
      const record = instance.current()!.phases['1'];
      held.release();
      await instance.wait();
      return { record, wait: journalled(events, 'phase.external-wait')[0] };
    } finally { r.cleanup(); }
  };
  const REF = 'cmd:"curl -sf https://status.example.test/health"';
  const off = await park();
  assert.equal(off.record.status === 'waiting' || off.record.status === 'parked' || off.record.status === 'interrupted', true);
  assert.deepEqual(off.record.watch ?? [], [], 'nothing will run it, so nothing is armed');
  assert.equal(off.record.declared?.minted, undefined);
  assert.match(off.record.parkReason ?? '', /watchMintedCmdRefs is off/);
  assert.equal(off.wait?.watch, null);

  const on = await park(() => true);
  assert.deepEqual(on.record.declared?.watch, [REF], 'the operator said yes: the ref is armed');
  assert.deepEqual(on.record.declared?.minted, [REF]);
});
