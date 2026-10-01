/**
 * Credits carry a run past its plan window (control-tower phase 93, #146) —
 * CR-4 and CR-5.
 *
 * Every usage rule used to treat a credit-backed account like a capped one:
 * the 97 % preflight door and a learned wall refused it, the 80/95 % pushes
 * rang, the 95 % decision braked or switched it, and the live wall acted on
 * 99 % while the CLI was still carrying the session. With the operator's
 * `overage: allowed` on the account AND its own credit state saying credits are
 * there, none of those fire; the moment either source says credits stopped,
 * the ordinary rules are back and the operator is told.
 *
 *   CR-4  while credits are available no run on the account is braked,
 *         switched, refused or parked for crossing a plan window.
 *   CR-5  when credits stop — cap reached, disabled, exhausted — its runs fall
 *         back to the ordinary rules within one poll, and the operator is told.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Accounts } = await import('../server/accounts/index.ts');
const { withSample } = await import('../server/accounts/usage.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { STATE_SANDBOX } = await import('./state-sandbox.ts');
type AccountUsage = import('../server/accounts/usage.ts').AccountUsage;
type UsageCredits = import('../server/accounts/usage.ts').UsageCredits;
type Exec = import('../server/accounts/credentials.ts').Exec;
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;
type StreamEvent = import('../server/runner/spawn.ts').StreamEvent;
type LeaveReason = import('../server/accounts/index.ts').LeaveReason;
type LeaveResult = import('../server/accounts/index.ts').LeaveResult;

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(ms).toISOString();

const exec: Exec = async (file, args) =>
  file === 'claude' && args[0] === '--version' ? { stdout: '2.1.283 (Claude Code)\n' } : { stdout: '' };

function newAccounts(now: number, opts: ConstructorParameters<typeof Accounts>[0] = {}) {
  return new Accounts({
    platform: 'linux', exec, now: () => now, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    registryDir: mkdtempSync(join(STATE_SANDBOX, 'p93-carry-')),
    learnedFile: join(STATE_SANDBOX, `learned-p93-${Math.random().toString(16).slice(2)}.json`),
    ...opts,
  });
}

const ENABLED: UsageCredits = { enabled: true, monthlyLimit: 40, used: 5, currency: 'USD' };

/** A reading of the machine login: five-hour at `pct`, climbing 20 %/h over the last hour, and its credits. */
function reading(now: number, pct: number, credits: UsageCredits | undefined): AccountUsage {
  const buckets = { five_hour: { utilization: pct, resetsAt: at(now + 3 * HOUR) }, seven_day: { utilization: 40, resetsAt: at(now + 72 * HOUR) } };
  let samples: AccountUsage['samples'];
  for (const minutesAgo of [60, 30, 0]) {
    samples = withSample(samples, {
      five_hour: { utilization: Math.max(0, pct - 20 * (minutesAgo / 60)), resetsAt: buckets.five_hour.resetsAt },
      seven_day: buckets.seven_day,
    }, now - minutesAgo * MIN);
  }
  return { buckets, fetchedAt: at(now), samples, ...(credits ? { credits } : {}) };
}

function plant(accounts: InstanceType<typeof Accounts>, usage: AccountUsage): void {
  (accounts as unknown as { poller: { cache: Map<string, AccountUsage> } }).poller.cache.set('default', usage);
}

/** The views the facade builds for its callbacks are async: let them land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The poll's own path into the facade — what a real read does after the cache takes it. */
function poll(accounts: InstanceType<typeof Accounts>, usage: AccountUsage): void {
  plant(accounts, usage);
  (accounts as unknown as { usageUpdated(id: string, u: AccountUsage, m: { outcome: 'ok' }): void })
    .usageUpdated('default', usage, { outcome: 'ok' });
}

/* ------------------------------------------------------------------ *
 * CR-4 — the account's own doors: preflight, the pushes, the forecast
 * ------------------------------------------------------------------ */

test('CR-4: preflight refuses a credit-carried account for nothing a plan window says — not the 97 % five-hour door, not a learned wall', () => {
  const now = Date.parse('2026-09-27T22:00:00Z');
  const accounts = newAccounts(now);
  plant(accounts, reading(now, 99, ENABLED));
  const before = accounts.headroom('default');
  assert.equal(before.ok, false, 'overage is OFF by default: 99 % is refused as it always was');

  const set = accounts.setOverage('default', true);
  assert.equal(set.ok, true);
  const carried = accounts.headroom('default');
  assert.equal(carried.ok, true, 'credits carry it past the window');
  assert.equal(carried.ok && carried.onCredit, true, 'and the verdict says why');

  accounts.markLimited('default', 'seven_day', at(now + 48 * HOUR));
  assert.equal(accounts.headroom('default').ok, true, 'a learned plan wall does not refuse it either');
  assert.equal(accounts.creditCarries('default'), true);
  assert.equal(accounts.creditCarries(undefined), true, 'the machine login answers to both spellings');
});

test('CR-4: the 80/95 % pushes and the forecast\'s warning stay quiet on a credit-carried account — and ring on one that is not', async () => {
  const now = Date.parse('2026-09-27T22:00:00Z');
  const thresholds: string[] = [];
  const forecasts: string[] = [];
  const accounts = newAccounts(now, {
    onThreshold: (_view, bucket, level) => thresholds.push(`${bucket}:${level}`),
    onForecast: (_view, bucket) => forecasts.push(bucket),
    forecastLeadMs: () => 2 * HOUR,
  });
  accounts.setActiveProbe(() => true);
  plant(accounts, reading(now, 90, ENABLED));
  assert.equal(accounts.setOverage('default', true).ok, true);
  poll(accounts, reading(now, 96, ENABLED));
  await settle();
  assert.deepEqual(thresholds, [], 'no "usage climbing" for an account credits carry');
  assert.deepEqual(forecasts, [], 'and no "walls in about …" — its wall is not a wall');

  accounts.setOverage('default', false);
  poll(accounts, reading(now + 1, 97, ENABLED));
  await settle();
  assert.deepEqual(thresholds, ['five_hour:alert'], 'with overage off the push is what it was');
  assert.deepEqual(forecasts, ['five_hour']);
});

/* ------------------------------------------------------------------ *
 * CR-5 — credits stop: the account's side
 * ------------------------------------------------------------------ */

test('CR-5: a poll that says credits stopped ends the carry at that poll, and the operator is told once, with the reason', async () => {
  const now = Date.parse('2026-09-27T22:00:00Z');
  const told: { id: string; carrying: boolean; reason: string }[] = [];
  const accounts = newAccounts(now, { onCredits: (view, change) => told.push({ id: view.id, ...change }) });
  plant(accounts, reading(now, 99, ENABLED));
  assert.equal(accounts.setOverage('default', true).ok, true);
  poll(accounts, reading(now, 99, ENABLED));
  await settle();
  assert.deepEqual(told, [], 'still carrying: nothing to tell');

  poll(accounts, reading(now, 99, { ...ENABLED, enabled: false, disabledReason: 'out_of_credits' }));
  await settle();
  assert.equal(accounts.creditCarries('default'), false);
  assert.equal(accounts.headroom('default').ok, false, 'the 97 % door is back, within this one poll');
  assert.equal(told.length, 1);
  assert.equal(told[0].carrying, false);
  assert.match(told[0].reason, /out of credits/);

  poll(accounts, reading(now, 99, { ...ENABLED, enabled: false, disabledReason: 'out_of_credits' }));
  await settle();
  assert.equal(told.length, 1, 'a standing stop is told once');

  poll(accounts, reading(now, 99, { ...ENABLED, used: 40 }));
  assert.equal(accounts.creditCarries('default'), false, 'the monthly limit reached is a stop as well');
  assert.match(accounts.creditOf('default').reason, /limit/);

  poll(accounts, reading(now, 99, ENABLED));
  await settle();
  assert.equal(accounts.creditCarries('default'), true, 'credits back: carrying again');
  assert.equal(told.at(-1)?.carrying, true, 'and that is told too');
});

test('CR-5: a session\'s refusal stops the carry at once — before any poll — until a later read says credits are back', () => {
  let now = Date.parse('2026-09-27T22:00:00Z');
  const accounts = new Accounts({
    platform: 'linux', exec, now: () => now, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    registryDir: mkdtempSync(join(STATE_SANDBOX, 'p93-carry-')),
    learnedFile: join(STATE_SANDBOX, `learned-p93-${Math.random().toString(16).slice(2)}.json`),
  });
  plant(accounts, reading(now, 99, ENABLED));
  assert.equal(accounts.setOverage('default', true).ok, true);
  now += MIN;
  accounts.noteSessionCredit(undefined, { usingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'org_spend_cap_reached' });
  assert.equal(accounts.creditCarries('default'), false);
  assert.match(accounts.creditOf('default').reason, /spend cap/);
  now += MIN;
  poll(accounts, reading(now, 99, ENABLED));
  assert.equal(accounts.creditCarries('default'), true, 'a read after the refusal that says enabled wins');
});

/* ------------------------------------------------------------------ *
 * CR-4/CR-5 — the live wall, in a running session
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-carry-'));
  const scripts = join(root, 'scripts');
  const state = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(state, 'done'), '');
  const write = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  write(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${state}"
case "\${2:-}" in
  --memory-block)
    if grep -qx 1 "$S/done" 2>/dev/null; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase \${3:-1} of $1" ;;
  --size) echo M ;;
  *) exit 2 ;;
esac
`);
  write(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  write(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(state, 'done'), `${phase}\n`),
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

function heldSession(r: Repo) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    entered();
    await held;
    r.markDone(1);
    return ok();
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

test('CR-4: the live wall leaves a session on credit alone — 99 % of the window, and a rejected window the CLI carries on overage', async () => {
  const r = repo();
  const session = heldSession(r);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const left: LeaveReason[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: session.spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    creditCarries: () => true,
    leaveAccount: (accountId, leaving): LeaveResult => {
      left.push(leaving);
      return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until: at(Date.now() + HOUR), throttleUntilMs: Date.now() + HOUR };
    },
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await session.inSession;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < 3; i++) {
      session.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.99, utilizationPct: 99, resetsAt: reset });
    }
    for (let i = 0; i < 3; i++) {
      session.say({ kind: 'limits', status: 'rejected', window: 'five_hour', utilization: 1, utilizationPct: 100, resetsAt: reset, usingOverage: true, overageStatus: 'allowed' });
    }
    assert.deepEqual(journalled(events, 'phase.live-wall'), [], 'no wall: the session is working on credit');
    assert.deepEqual(left, [], 'and no wall was learned from a notice while requests succeed');
    assert.equal(instance.current()?.phases['1']?.status, 'running');
    assert.equal(instance.current()?.limits?.usingOverage, true, 'the run shows the session is on credit');
  } finally {
    session.release();
    await instance.wait();
    r.cleanup();
  }
});

test('CR-5: a session saying its credits stopped is a wall again at once — and the account hears the reason', async () => {
  const r = repo();
  const session = heldSession(r);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const heard: { accountId: string | undefined; info: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: session.spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => null,
    creditCarries: () => true,
    noteSessionCredit: (accountId, info) => heard.push({ accountId, info: info as Record<string, unknown> }),
    leaveAccount: (accountId): LeaveResult =>
      ({ accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until: at(Date.now() + HOUR), throttleUntilMs: Date.now() + HOUR }),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'pause' });
    await session.inSession;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < 3; i++) {
      session.say({
        kind: 'limits', status: 'rejected', window: 'five_hour', utilization: 1, utilizationPct: 100, resetsAt: reset,
        usingOverage: false, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits',
      });
    }
    assert.equal(heard[0]?.info.overageDisabledReason, 'out_of_credits', 'the account learned why');
    assert.equal(heard[0]?.accountId, undefined, 'on the account the lane spends');
    const walls = journalled(events, 'phase.live-wall');
    assert.ok(walls.length >= 1, 'the ordinary rule acted');
    assert.equal(walls[0].action, 'pause');
  } finally {
    session.release();
    await instance.wait().catch(() => undefined);
    r.cleanup();
  }
});
