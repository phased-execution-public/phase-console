/**
 * A usage wall is "until at the latest" (control-tower phase 54, #78).
 *
 * The live wall parked a phase on the reset the CLI reported and trusted it:
 * measured, a weekly window reported ~12 h late held a park while the same
 * account served the same run again, and a phase sat idle for hours on an
 * account that could already pay. Now the park is re-read — on a back-off
 * re-probe of the account, on every fresh usage reading, and on every spend
 * that went through — and it lifts or shortens, never lengthens.
 *
 *   UW-1  the back-off re-probe reads the account and re-boards the phase the
 *         moment the quota door says yes — before the reported reset;
 *   UW-2  a fresh reading shortens the park to an earlier reset, never
 *         lengthens it, and lifts it on headroom;
 *   UW-3  a sibling's successful spend lifts the account's walls and cooling
 *         (`noteSpend`) and re-arms the parked phase at once — and the walled
 *         session's own interrupted ending proves nothing;
 *   UW-4  the learned store's re-read and lift, and the facade's poll and
 *         spend, move the walls the quota door reads.
 *
 * The harness is `usage-brake.test.ts`'s far-reset one, on the real clock:
 * the drive loop judges an elapsed park against wall time, so a park lifted
 * "now" must be now for both.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Runner } from '../server/runner/runner.ts';
import { Scheduler, type AccountWalls } from '../server/runner/scheduler.ts';
import { waitClockOf } from '../server/runner/state.ts';
import { WALL_REPROBE_BACKOFF_MS } from '../server/runner/runner-core.ts';
import { Accounts, type HeadroomVerdict, type LeaveReason, type LeaveResult } from '../server/accounts/index.ts';
import { LearnedAccounts, credentialFingerprint } from '../server/accounts/learned.ts';
import type { Exec } from '../server/accounts/credentials.ts';
import type { SpawnFn, SpawnOutcome, SpawnRequest, StreamEvent } from '../server/runner/spawn.ts';
import { STATE_SANDBOX } from './state-sandbox.ts';

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** Three phases whose board is a `done` file; with `parallel`, every open phase is ready at once. */
function repo(parallel = false): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-wall-reprobe-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  if (parallel) writeFileSync(join(state, 'parallel'), '');
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

/** What the walled session's own ending looks like: the console ended it at the wall. */
function interrupted(): SpawnOutcome {
  return ok({ endedBy: 'checkpoint', sessionId: 'sess-walled', costUsd: 0.4 });
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

/**
 * The accounts facade as the runner and the scheduler see it, in one object:
 * the learned walls (`markLimited`/`limitedUntil` — what the scheduler's
 * throttle writes through to), the quota door that reads them, `leaveAccount`
 * writing a wall at the reset, and `noteSpend` lifting them. `answer`
 * overrides the door's verdict when a test wants to say something exact.
 */
function facade() {
  const walls = new Map<string, string>();
  const s = { answer: null as HeadroomVerdict | null };
  const open = (nowMs = Date.now()) => [...walls.entries()].filter(([, iso]) => Date.parse(iso) > nowMs);
  const accountWalls: AccountWalls = {
    limitedUntil: (_id, nowMs) => Object.fromEntries(open(nowMs)),
    markLimited: (_id, bucket, resetsAt) => { walls.set(bucket, resetsAt); },
    accountIds: () => ['default'],
  };
  const headroom = (accountId: string | undefined): HeadroomVerdict => {
    if (s.answer) return s.answer;
    const standing = open();
    return standing.length
      ? { ok: false, accountId: accountId ?? 'default', kind: 'wall', resetsAt: standing[0][1], reason: 'default hit its usage limit' }
      : { ok: true, accountId: accountId ?? 'default' };
  };
  const leaveAccount = (accountId: string | undefined, leaving: LeaveReason): LeaveResult => {
    const id = accountId ?? 'default';
    const resets = leaving.kind === 'usage' ? leaving.resetsAt ?? null : null;
    const until = (resets ?? new Date(Date.now() + 30 * 60_000)).toISOString();
    const bucket = leaving.kind === 'usage' ? leaving.bucket ?? 'learned_window' : 'learned_window';
    if (resets) walls.set(bucket, until);
    return {
      accountId: id, credential: 'stub', state: 'cooling', until,
      ...(resets ? { wall: { bucket, resetsAt: until } } : {}),
      throttleUntilMs: Date.parse(until),
    };
  };
  const lift = (): string[] => { const names = [...walls.keys()]; walls.clear(); return names; };
  return { s, walls, accountWalls, headroom, leaveAccount, lift };
}

/**
 * The service's half of a settled wait: a run whose loop ended `waiting` is
 * resumed from its clock once the clock is due (`armLimitResume` →
 * `resumeLimitPaused`). The test drives it by hand, the way the service would.
 */
async function resumeWhenDue(instance: InstanceType<typeof Runner>, root: string, onlyPhases: number[], done: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting for the phase to finish');
    const state = instance.current();
    const clock = state ? waitClockOf(state) : null;
    if (state && !instance.busy() && state.status === 'waiting' && clock && Date.parse(clock) <= Date.now()) {
      await instance.start({ slug: 'demo', root, resumeRunId: state.id, onlyPhases, autonomy: 'keep-going' });
    }
    await sleep(10);
  }
  await instance.wait();
}

/**
 * Phase 1's first session is held open while the test drives it into the wall,
 * then ends as the console ended it; every later session marks its phase done.
 */
function wallThenDone(r: Repo) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const boarded: number[] = [];
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? 1);
    boarded.push(phase);
    if (boarded.length === 1) {
      sink = request.onEvent;
      entered();
      await held;
      return interrupted();
    }
    r.markDone(phase);
    return ok({ sessionId: `sess-${phase}-${boarded.length}` });
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event), boarded };
}

/** Drive a live session into a far-reset wall with no account to move to. */
function hitWall(say: (event: StreamEvent) => void, resetMs: number): void {
  say({ kind: 'init', sessionId: 'sess-walled', model: 'stub-1', tools: 0 } as StreamEvent);
  say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.99, utilizationPct: 99, resetsAt: resetMs / 1000 });
  for (let i = 0; i < 4; i++) {
    say({
      kind: 'retry', category: 'rate_limit', attempt: i + 1, maxRetries: 15, retryDelayMs: resetMs - Date.now(),
      errorStatus: 429, detail: 'rate_limit',
    } as StreamEvent);
  }
}

async function until(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/* ------------------------------------------------------------------ *
 * UW-1 — the back-off re-probe
 * ------------------------------------------------------------------ */

test('UW-1: a far-reset wall is "until at the latest" — the account is re-probed on a back-off, and the phase re-boards when it has headroom, before the reported reset', async () => {
  const r = repo();
  const session = wallThenDone(r);
  const resetMs = Date.now() + 3 * HOUR;
  const account = facade();
  const reads: (string | undefined)[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: session.spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    leaveAccount: account.leaveAccount,
    accountHeadroom: account.headroom,
    // The account's meters read "open" from the third read on — the poll lifts the learned wall.
    refreshUsage: async (accountId) => { reads.push(accountId); if (reads.length >= 3) account.lift(); },
    wallReprobeBackoffMs: [20, 40, 80],
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', onLimit: 'switch' });
    await session.inSession;
    hitWall(session.say, resetMs);

    const parked = instance.current()!.phases['1'];
    assert.equal(parked.status, 'waiting', 'parked on the window');
    assert.equal(parked.parkedUntil, new Date(resetMs).toISOString(), 'bounded by the reported reset');
    assert.match(parked.parkReason ?? '', /at the latest/, 'and says it is a ceiling, not a promise');
    assert.deepEqual(
      { account: parked.usageWall?.account, bucket: parked.usageWall?.bucket, latest: parked.usageWall?.latest, probes: parked.usageWall?.probes },
      { account: 'default', bucket: 'five_hour', latest: new Date(resetMs).toISOString(), probes: 0 },
      'the wall it waits on is on the record',
    );
    session.release();

    await resumeWhenDue(instance, r.root, [1], () => instance.current()?.phases['1']?.status === 'done');
    const record = instance.current()!.phases['1'];
    assert.equal(record.status, 'done', 'the phase finished');
    assert.ok(Date.now() < resetMs, 'long before the reset it reported');
    assert.equal(reads.length, 3, 'three re-probes: two walled, the third open — and no more once it lifted');
    assert.ok(reads.every((id) => id === undefined), 'each one a read of the machine login');
    const lifted = journalled(events, 'phase.wall-lifted');
    assert.equal(lifted.length, 1);
    assert.equal(lifted[0].by, 'reprobe');
    assert.equal(lifted[0].account, 'default');
    assert.equal(lifted[0].was, new Date(resetMs).toISOString());
    assert.equal(record.usageWall, undefined, 'the wall ended with the park');
    assert.deepEqual(session.boarded, [1, 1], 'the phase boarded again on the same account');
    assert.deepEqual(journalled(events, 'run.walls-lifted'), [], 'the walled session\'s interrupted ending proved nothing');
  } finally {
    session.release();
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});

test('UW-1: the back-off is 10, 20, 40, then every 60 minutes — gentle on an account that really is spent', () => {
  assert.deepEqual(WALL_REPROBE_BACKOFF_MS, [10 * 60_000, 20 * 60_000, 40 * 60_000, 60 * 60_000]);
});

/* ------------------------------------------------------------------ *
 * UW-2 — every fresh reading re-reads the wall's until
 * ------------------------------------------------------------------ */

test('UW-2: a fresh reading shortens the park to an earlier reset, never lengthens it, and lifts it on headroom', async () => {
  const r = repo();
  const session = wallThenDone(r);
  const resetMs = Date.now() + 3 * HOUR;
  const account = facade();
  const quota = account;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: session.spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    leaveAccount: account.leaveAccount,
    accountHeadroom: account.headroom,
    // No re-probe fires inside this test: the readings are the test's own.
    wallReprobeBackoffMs: [HOUR],
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', onLimit: 'switch' });
    await session.inSession;
    hitWall(session.say, resetMs);
    session.release();
    const record = () => instance.current()!.phases['1'];
    await until(() => !instance.liveness().some((lane) => lane.phase === 1), 'the walled lane to end');

    assert.equal(instance.rereadWalls('reading'), 0, 'the same wall read again moves nothing');
    assert.equal(record().parkedUntil, new Date(resetMs).toISOString());

    const earlier = new Date(resetMs - 2 * HOUR).toISOString();
    quota.s.answer = { ok: false, accountId: 'default', kind: 'wall', resetsAt: earlier, reason: 'walled' };
    assert.equal(instance.rereadWalls('reading'), 1, 'an earlier reset is news');
    assert.equal(record().parkedUntil, earlier, 'the park shortened to it');
    assert.equal(record().status, 'waiting', 'and still waits — the account is still walled');
    assert.deepEqual(journalled(events, 'phase.wall-reread').map((line) => ({ by: line.by, from: line.from, to: line.to })),
      [{ by: 'reading', from: new Date(resetMs).toISOString(), to: earlier }]);

    quota.s.answer = { ok: false, accountId: 'default', kind: 'spent', resetsAt: new Date(resetMs + 2 * HOUR).toISOString(), reason: 'spent' };
    assert.equal(instance.rereadWalls('reading'), 0, 'a LATER reset never lengthens the park');
    assert.equal(record().parkedUntil, earlier);
    assert.equal(record().usageWall?.lastReading?.ok, false, 'the reading is kept on the wall');

    quota.s.answer = { ok: false, accountId: 'default', kind: 'retired', reason: 'retired' };
    assert.equal(instance.rereadWalls('reading'), 0, 'a retirement is the breaker\'s to settle, not the wall\'s');

    quota.s.answer = { ok: true, accountId: 'default', fiveHourPct: 12 };
    assert.equal(instance.rereadWalls('reading'), 1, 'headroom lifts it');
    assert.ok(Date.parse(waitClockOf(instance.current()!) ?? '') <= Date.now(), 'and the run\'s clock moved with it — what the service re-arms on');
    await resumeWhenDue(instance, r.root, [1], () => record().status === 'done');
    assert.equal(record().status, 'done', 'and the phase re-boarded and finished');
    assert.deepEqual(journalled(events, 'phase.wall-lifted').map((line) => line.by), ['reading']);
  } finally {
    session.release();
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * UW-3 — a spend lifts the walls and re-arms the parked phase
 * ------------------------------------------------------------------ */

test('UW-3: a sibling\'s successful spend on the account lifts its walls and cooling, and re-arms the phase parked on them — at once', async () => {
  const r = repo(true);
  const resetMs = Date.now() + 3 * HOUR;
  const account = facade();
  const spends: { accountId: string | undefined; model?: string }[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  // Two lanes live at once: phase 1 walls, phase 2 is mid-session beside it.
  let wallSink: ((event: StreamEvent) => void) | undefined;
  let walledIn!: () => void;
  const walled = new Promise<void>((resolve) => { walledIn = resolve; });
  let releaseWalled!: () => void;
  const walledHeld = new Promise<void>((resolve) => { releaseWalled = resolve; });
  let siblingIn!: () => void;
  const siblingLive = new Promise<void>((resolve) => { siblingIn = resolve; });
  let releaseSibling!: () => void;
  const siblingHeld = new Promise<void>((resolve) => { releaseSibling = resolve; });
  const boarded: number[] = [];
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? 0);
    boarded.push(phase);
    if (phase === 1 && boarded.filter((p) => p === 1).length === 1) {
      wallSink = request.onEvent;
      walledIn();
      await walledHeld;
      return interrupted();
    }
    if (phase === 2) {
      siblingIn();
      await siblingHeld;
    }
    r.markDone(phase);
    return ok({ sessionId: `sess-${phase}-${boarded.length}` });
  };
  const scheduler = new Scheduler({ max: 2, locks: () => [], accountWalls: account.accountWalls });
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    scheduler,
    maxParallel: 2,
    phaseScope: (_slug, phase) => [`repo-${phase}`],
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    leaveAccount: account.leaveAccount,
    accountHeadroom: account.headroom,
    // The facade's answer to a spend: the account's walls and its cooling lift.
    noteSpend: (accountId, model) => {
      spends.push({ accountId, ...(model ? { model } : {}) });
      const lifted = account.lift();
      return { lifted, cooled: lifted.length > 0 };
    },
    wallReprobeBackoffMs: [HOUR],
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1, 2], autonomy: 'keep-going', onLimit: 'switch' });
    await walled;
    await siblingLive;
    hitWall((event) => wallSink?.(event), resetMs);
    assert.equal(instance.current()!.phases['1'].status, 'waiting', 'phase 1 parked on the wall');
    releaseWalled();
    await until(() => !instance.liveness().some((lane) => lane.phase === 1), 'the walled lane to end');
    assert.equal(instance.current()!.phases['1'].status, 'waiting', 'and its own interrupted ending lifted nothing');
    releaseSibling();
    await instance.wait();
    scheduler.close();

    const state = instance.current()!;
    assert.equal(state.phases['1'].status, 'done', 'the walled phase finished');
    assert.equal(state.phases['2'].status, 'done', 'and so did the sibling whose spend lifted the wall');
    assert.ok(Date.now() < resetMs, 'hours before the reported reset');
    // The two lanes board in either order; what matters is that phase 1 boarded
    // AGAIN, and only after the sibling whose spend lifted its wall had run.
    assert.equal(boarded.filter((p) => p === 1).length, 2, 'phase 1 walled, then boarded again');
    assert.equal(boarded.filter((p) => p === 2).length, 1, 'phase 2 ran once, beside the park');
    assert.ok(boarded.lastIndexOf(1) > boarded.indexOf(2), 'the re-boarding came after the sibling\'s session');
    assert.equal(spends[0]?.accountId, undefined, 'the spend proved the machine login');
    const walls = journalled(events, 'run.walls-lifted');
    assert.equal(walls.length, 1, 'said once, when something moved');
    assert.deepEqual({ account: walls[0].account, lifted: walls[0].lifted, cooled: walls[0].cooled },
      { account: 'default', lifted: ['five_hour'], cooled: true });
    const lifted = journalled(events, 'phase.wall-lifted');
    assert.equal(lifted.length, 1);
    assert.equal(lifted[0].by, 'spend', 'the spend re-armed it — no re-probe, no reading');
    assert.equal(spends.length >= 1, true);
    assert.equal(spends.some((spend) => spend.model === undefined || typeof spend.model === 'string'), true);
  } finally {
    releaseWalled();
    releaseSibling();
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * UW-4 — the learned store and the facade move the walls the door reads
 * ------------------------------------------------------------------ */

test('UW-4: rereadWalls lifts a wall read under WALL_PCT, shortens one to an earlier reset, never lengthens, and lifts the nameless wall once the shared windows read open', () => {
  const learned = new LearnedAccounts({ file: join(STATE_SANDBOX, 'learned-uw4.json') });
  const fp = credentialFingerprint('test:uw4');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  learned.markWall(fp, 'five_hour', iso(3 * HOUR), now);
  learned.markWall(fp, 'seven_day', iso(48 * HOUR), now);
  learned.markWall(fp, 'seven_day_opus', iso(24 * HOUR), now);

  const change = learned.rereadWalls(fp, {
    five_hour: { utilization: 20, resetsAt: iso(3 * HOUR) },
    seven_day: { utilization: 100, resetsAt: iso(12 * HOUR) },
    seven_day_opus: { utilization: 100, resetsAt: iso(30 * HOUR) },
  }, at);
  assert.deepEqual(change?.lifted, ['five_hour'], 'a reading under the wall lifts it');
  assert.deepEqual(change?.moved, [{ bucket: 'seven_day', from: iso(48 * HOUR), to: iso(12 * HOUR) }], 'an earlier reset shortens');
  const walls = learned.snapshot().credentials[fp].walls;
  assert.equal(walls.five_hour, undefined);
  assert.equal(walls.seven_day, iso(12 * HOUR));
  assert.equal(walls.seven_day_opus, iso(24 * HOUR), 'a later reset never lengthens');
  assert.equal(learned.rereadWalls(fp, { seven_day: { utilization: 100, resetsAt: iso(12 * HOUR) } }, at), null, 'nothing new is null');

  const fp2 = credentialFingerprint('test:uw4-nameless');
  learned.markWall(fp2, 'learned_window', iso(2 * HOUR), now);
  assert.equal(learned.rereadWalls(fp2, { five_hour: { utilization: 30, resetsAt: iso(HOUR) } }, at), null,
    'one shared window open is not both');
  const both = learned.rereadWalls(fp2, {
    five_hour: { utilization: 30, resetsAt: iso(HOUR) }, seven_day: { utilization: 40, resetsAt: iso(90 * HOUR) },
  }, at);
  assert.deepEqual(both?.lifted, ['learned_window'], 'the nameless wall lifts once every shared window reads open');
});

test('UW-4: a usage cooling ends on an open reading and shortens to the wall that stands; a certificate cooling is untouched; a spend lifts what it names', () => {
  const learned = new LearnedAccounts({ file: join(STATE_SANDBOX, 'learned-uw4-cooling.json') });
  const now = Date.now();
  const at = new Date(now).toISOString();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const open = { five_hour: { utilization: 10, resetsAt: iso(HOUR) }, seven_day: { utilization: 10, resetsAt: iso(90 * HOUR) } };

  const usage = credentialFingerprint('test:uw4-usage');
  learned.setEntitlement(usage, { state: 'entitled', by: 'poller' });
  learned.setEntitlement(usage, { state: 'cooling', until: iso(5 * HOUR) });
  assert.equal(learned.rereadWalls(usage, open, at)?.cooling, 'ended');
  assert.equal(learned.entitlementOf(usage).state, 'entitled');

  const standing = credentialFingerprint('test:uw4-standing');
  learned.setEntitlement(standing, { state: 'entitled', by: 'poller' });
  learned.setEntitlement(standing, { state: 'cooling', until: iso(5 * HOUR) });
  learned.markWall(standing, 'seven_day', iso(2 * HOUR), now);
  const shortened = learned.rereadWalls(standing, { seven_day: { utilization: 100, resetsAt: iso(2 * HOUR) } }, at);
  assert.deepEqual(shortened?.cooling, { from: iso(5 * HOUR), to: iso(2 * HOUR) }, 'shortened to the wall that stands');

  const cert = credentialFingerprint('test:uw4-cert');
  learned.setEntitlement(cert, { state: 'entitled', by: 'poller' });
  learned.setEntitlement(cert, { state: 'cooling', until: iso(5 * HOUR), class: 'certificate' });
  assert.equal(learned.rereadWalls(cert, open, at), null, 'a certificate is not a usage fact');
  assert.equal(learned.entitlementOf(cert).state, 'cooling');
  assert.deepEqual(learned.liftWalls(cert, ['five_hour'], at), { lifted: [], cooled: false }, 'nor does a spend end it');

  const spent = credentialFingerprint('test:uw4-spent');
  learned.setEntitlement(spent, { state: 'entitled', by: 'poller' });
  learned.setEntitlement(spent, { state: 'cooling', until: iso(5 * HOUR) });
  learned.markWall(spent, 'five_hour', iso(3 * HOUR), now);
  learned.markWall(spent, 'seven_day_opus', iso(30 * HOUR), now);
  assert.deepEqual(learned.liftWalls(spent, ['five_hour', 'seven_day', 'learned_window'], at), { lifted: ['five_hour'], cooled: true });
  assert.equal(learned.snapshot().credentials[spent].walls.seven_day_opus, iso(30 * HOUR), 'another model\'s wall stands');
});

const lenientExec: Exec = async (file, args) => (file === 'claude' && args[0] === '--version'
  ? { stdout: '9.9.9 (Claude Code)\n' }
  : { stdout: '' });

test('UW-4: the facade — a spend lifts the account\'s shared walls and its model\'s own, and the quota door opens', async () => {
  const accounts = new Accounts({ platform: 'linux', exec: lenientExec, learnedFile: join(STATE_SANDBOX, 'learned-uw4-facade.json') });
  try {
    const later = new Date(Date.now() + 3 * HOUR).toISOString();
    accounts.markLimited(undefined, 'five_hour', later);
    accounts.markLimited(undefined, 'seven_day_opus', later);
    accounts.markLimited(undefined, 'seven_day_fable', later);
    assert.equal(accounts.headroom(undefined, 'opus').ok, false, 'walled');
    const moved = accounts.noteSpend(undefined, 'claude-opus-5-5[1m]');
    assert.deepEqual([...moved.lifted].sort(), ['five_hour', 'seven_day_opus']);
    assert.equal(accounts.limitedUntil('default').seven_day_fable, later, 'a model it did not run stays walled');
    assert.equal(accounts.headroom(undefined, 'opus').ok, true, 'the door is open again');
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * UW-5 — the wall ends with its park
 * ------------------------------------------------------------------ */

test('UW-5: a wall ends with its park — a retried phase boards without it, and a reading never lifts the declared wait it parks on next', async () => {
  const r = repo();
  const resetMs = Date.now() + 3 * HOUR;
  const account = facade();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let sink: ((event: StreamEvent) => void) | undefined;
  let entered!: () => void;
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let sessions = 0;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sessions += 1;
    if (sessions === 1) {
      sink = request.onEvent;
      entered();
      await held;
      return interrupted();
    }
    // The retried attempt parks on a clock that is not the account's.
    writeFileSync(request.env!.PE_OUTCOME_FILE as string, JSON.stringify({
      version: 1, slug: 'demo', phase: 1, status: 'waiting-external', reason: 'the image build',
      resume_after: new Date(Date.now() + 1.5 * HOUR).toISOString(),
      written_at: new Date().toISOString(), session_id: 'sess-declares',
    }));
    return ok({ sessionId: 'sess-declares' });
  };
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    leaveAccount: account.leaveAccount,
    accountHeadroom: account.headroom,
    wallReprobeBackoffMs: [HOUR],
  });
  const record = () => instance.current()!.phases['1'];
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', onLimit: 'switch' });
    await inSession;
    hitWall((event) => sink?.(event), resetMs);
    release();
    await until(() => !instance.liveness().some((lane) => lane.phase === 1), 'the walled lane to end');
    await instance.wait();
    assert.ok(record().usageWall, 'parked on the wall');

    // The account frees up and a person presses Retry before any reading re-reads the park.
    account.lift();
    instance.retry(1);
    if (!instance.busy()) {
      await instance.start({ slug: 'demo', root: r.root, resumeRunId: instance.current()!.id, onlyPhases: [1], autonomy: 'keep-going' });
    }
    await until(() => record().status === 'waiting' && sessions === 2 && !instance.liveness().some((lane) => lane.phase === 1),
      'the retried attempt to park on its declared wait');
    await instance.wait();
    const declared = record().parkedUntil;
    assert.ok(declared && Date.parse(declared) > Date.now(), 'parked on its own declared clock');
    assert.equal(record().usageWall, undefined, 'the wall went with the park it bounded');

    assert.equal(instance.rereadWalls('reading'), 0, 'a reading with headroom moves nothing');
    assert.equal(record().parkedUntil, declared, 'the declared wait keeps its clock');
    assert.equal(record().status, 'waiting');
    assert.deepEqual(journalled(events, 'phase.wall-lifted'), [], 'no wall was lifted — there was none');
  } finally {
    release();
    await instance.stop().catch(() => undefined);
    r.cleanup();
  }
});

test('#109: meters earned under the previous identity never wall the new one — the rank stops deciding on them the moment the identity changes', async () => {
  const { Accounts } = await import('../server/accounts/index.ts');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { STATE_SANDBOX } = await import('./state-sandbox.ts');
  const HOUR = 3_600_000;
  let body: Record<string, unknown> | null = {
    five_hour: { utilization: 2, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
    seven_day: { utilization: 100, resets_at: new Date(Date.now() + 48 * HOUR).toISOString() },
  };
  const fetchFn = (async () => {
    if (!body) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const exec = (async (file: string, args: string[]) =>
    (file === 'claude' && args[0] === '--version' ? { stdout: '9.9.9 (Claude Code)\n' } : { stdout: '' })) as never;
  const accounts = new Accounts({
    platform: 'linux', exec, fetchFn, usageBase: 'http://usage.invalid', learnedFile: join(STATE_SANDBOX, 'learned-p76-wall.json'),
  });
  const login = (dir: string, email: string, token: string) => {
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + 4 * HOUR },
    }));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: `org-${email}` } }));
  };
  try {
    const { id, dir } = accounts.beginProfile('relogin');
    login(dir, 'mobin@example.com', 'tok-mobin');
    await accounts.refreshUsage(id);
    assert.ok(!accounts.rankAccounts(null).includes(id), 'the first login’s week reads 100 % — out of the rank');
    login(dir, 'admin@example.com', 'tok-admin');
    body = null;
    await accounts.refreshUsage(id);
    assert.ok(accounts.rankAccounts(null).includes(id), 'the new login is not walled by a week that was never its own');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});

/* ------------------------------------------------------------------ *
 * CR-4 (control-tower phase 93, #146) — a wall credits carry is no wall
 * ------------------------------------------------------------------ */

test('CR-4: a phase parked on a plan window re-boards at the next reading once its account carries on credit — the park was for a window credits now pay past', async () => {
  const r = repo();
  const session = wallThenDone(r);
  const resetMs = Date.now() + 3 * HOUR;
  const exec: Exec = async (file, args) =>
    file === 'claude' && args[0] === '--version' ? { stdout: '2.1.283 (Claude Code)\n' } : { stdout: '' };
  const accounts = new Accounts({
    platform: 'linux', exec, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    registryDir: mkdtempSync(join(STATE_SANDBOX, 'p93-uw-')),
    learnedFile: join(STATE_SANDBOX, `learned-p93-uw-${Math.random().toString(16).slice(2)}.json`),
  });
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set('default', {
    // Under the preflight door, so the phase boards; the live wall is what parks it.
    buckets: { five_hour: { utilization: 90, resetsAt: new Date(resetMs).toISOString() } }, fetchedAt: new Date().toISOString(),
    credits: { enabled: true, monthlyLimit: 40, used: 5, currency: 'USD' },
  });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts,
    spawn: session.spawn,
    verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    leaveAccount: (accountId, leaving) => accounts.leaveAccount(accountId, leaving),
    accountHeadroom: (accountId, model) => accounts.headroom(accountId, model),
    creditCarries: (accountId) => accounts.creditCarries(accountId),
    refreshUsage: async () => undefined,
    wallReprobeBackoffMs: [60 * 60_000],
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', onLimit: 'switch' });
    await session.inSession;
    hitWall(session.say, resetMs);
    assert.equal(instance.current()!.phases['1'].status, 'waiting', 'overage off: parked on the window, as ever');
    assert.equal(accounts.headroom('default').ok, false, 'and the wall it learned refuses the account');
    session.release();

    assert.equal(accounts.setOverage('default', true).ok, true, 'the operator allows credits; the account\'s own state confirms them');
    assert.ok(instance.rereadWalls('reading') >= 1, 'the next reading moves the park');
    await resumeWhenDue(instance, r.root, [1], () => instance.current()?.phases['1']?.status === 'done');
    assert.equal(instance.current()!.phases['1'].status, 'done', 'the phase finished on credit, hours before the reset');
    assert.equal(journalled(events, 'phase.wall-lifted')[0]?.by, 'reading');
  } finally {
    session.release();
    await instance.stop().catch(() => undefined);
    accounts.stop();
    r.cleanup();
  }
});
