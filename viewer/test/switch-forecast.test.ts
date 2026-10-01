/**
 * The switch picker reads the forecast (control-tower phase 92, #141, #100's
 * 2026-09-25 comments).
 *
 * Phase 78 weighed a target against the current wall's reset at a CONSTANT burn
 * (20 %/h five-hour, 4 %/h weekly). The measured burn of the work being moved is
 * what decides whether a target carries it; a target with no reading at all was
 * still headroom and parked a release phase for 51 hours; the run's own
 * `minHeadroomPct` floor was never read; nothing moved a run back when the
 * account it left reset; a `usage-decision {action: switch}` was journalled
 * `enacted: false` and dropped; and two profiles of one login counted as two
 * accounts, so `default` was "headroom" for the account it was the same meter as.
 *
 * SW-1  `carriesUntil` reads a measured burn — `SWITCH_BURN_PCT_PER_HOUR` is retired
 * SW-2  the picker adds the moving work's burn (the account being left) to the target's own
 * SW-3  unknown usage is no headroom
 * SW-4  the run's `minHeadroomPct` floor, in either window
 * SW-5  the run moves back when the account it was moved off resets — past the horizon rule — and a wall wait wakes then
 * SW-6  a `run.usage-decision {action: switch}` is enacted at the lanes' boundary, or says why not
 * SW-7  one identity is one account: `default` is never a second meter for the login it is
 *       (the run card naming the machine login is the client's `tiles.test.tsx`)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const accountsModule = await import('../server/accounts/index.ts');
const { Accounts, carriesUntil } = accountsModule;
const { withSample } = await import('../server/accounts/usage.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { RESET_MARGIN_MS } = await import('../server/runner/errors.ts');
const { STATE_SANDBOX } = await import('./state-sandbox.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;
type StreamEvent = import('../server/runner/stream.ts').StreamEvent;
type Exec = import('../server/accounts/credentials.ts').Exec;
type LeaveReason = import('../server/accounts/index.ts').LeaveReason;
type LeaveResult = import('../server/accounts/index.ts').LeaveResult;
type UsageSample = import('../server/accounts/usage.ts').UsageSample;

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(ms).toISOString();

const exec: Exec = async (file, args) =>
  file === 'claude' && args[0] === '--version' ? { stdout: '9.9.9 (Claude Code)\n' } : { stdout: '' };

function newAccounts(now: number) {
  return new Accounts({
    platform: 'linux', exec, now: () => now, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    learnedFile: join(STATE_SANDBOX, `learned-p92-${Math.random().toString(16).slice(2)}.json`),
  });
}

/** Meters, and — with `burn` — an hour of readings climbing at that many percent per hour to them. */
function plant(
  accounts: InstanceType<typeof Accounts>, id: string, now: number,
  buckets: Record<string, { utilization: number; resetsAt: string }>, burn: Record<string, number> = {},
): void {
  let samples: Record<string, UsageSample[]> | undefined;
  for (const minutesAgo of [60, 30, 0]) {
    const readings: Record<string, { utilization: number; resetsAt: string }> = {};
    for (const [name, bucket] of Object.entries(buckets)) {
      readings[name] = { ...bucket, utilization: Math.max(0, bucket.utilization - (burn[name] ?? 0) * (minutesAgo / 60)) };
    }
    samples = withSample(samples, readings, now - minutesAgo * MIN);
  }
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set(id, { buckets, fetchedAt: at(now), samples });
}

/* ------------------------------------------------------------------ *
 * SW-1 — the rule reads a measured burn
 * ------------------------------------------------------------------ */

test('SW-1: carriesUntil judges a target at the burn it is given — the constant is retired, and no measured burn is no evidence of a wall', () => {
  const now = Date.parse('2026-09-25T12:36:00Z');
  const until = now + 2 * HOUR; // the five-hour wall being left resets in two hours
  assert.equal((accountsModule as Record<string, unknown>).SWITCH_BURN_PCT_PER_HOUR, undefined, 'SWITCH_BURN_PCT_PER_HOUR is retired');
  const weekly80 = { seven_day: { utilization: 80, resetsAt: at(now + 72 * HOUR) } };
  // 20 % left at a measured 4 %/h is five hours: it carries the two.
  assert.equal(carriesUntil(weekly80, until, now, undefined, { seven_day: 4 }), null);
  // The same account under work burning 12 %/h lasts 1 h 40 min: it walls first.
  const declined = carriesUntil(weekly80, until, now, undefined, { seven_day: 12 });
  assert.equal(declined?.bucket, 'seven_day');
  assert.ok(declined && declined.lastsMs !== null && declined.lastsMs < 2 * HOUR);
  assert.match(declined?.why ?? '', /12 %\/h/, 'the reason names the burn it used');
  // Nothing measured: the horizon cannot be judged, so it declines nothing.
  assert.equal(carriesUntil(weekly80, until, now, undefined, {}), null);
});

/* ------------------------------------------------------------------ *
 * SW-2 — the moving work's burn, measured on the account it leaves
 * ------------------------------------------------------------------ */

test('SW-2: the picker weighs a target at its own burn plus the burn the moving work was measured at on the account being left', async () => {
  const now = Date.now();
  const accounts = newAccounts(now);
  const from = await accounts.addToken('from', 'sk-ant-oat01-p92fromaccount0000');
  const target = await accounts.addToken('target', 'sk-ant-oat01-p92targetaccount00');
  try {
    const until = now + 2 * HOUR;
    // The target: 90 % weekly, flat — nobody spends it. 10 % left.
    plant(accounts, target.id, now, { five_hour: { utilization: 5, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 90, resetsAt: at(now + 60 * HOUR) } });
    // The work being moved burned the account it leaves at 6 %/h weekly: 10 % lasts 1 h 40 min.
    plant(accounts, from.id, now, { five_hour: { utilization: 100, resetsAt: at(until) }, seven_day: { utilization: 50, resetsAt: at(now + 90 * HOUR) } }, { five_hour: 30, seven_day: 6 });
    const hot = accounts.switchCandidates(from.id, undefined, { until, nowMs: now });
    assert.deepEqual(hot.ranked, [], 'it would wall before the current wall resets');
    assert.equal(hot.declined.find((row) => row.id === target.id)?.bucket, 'seven_day');
    // The same work at 2 %/h: 10 % is five hours.
    plant(accounts, from.id, now, { five_hour: { utilization: 100, resetsAt: at(until) }, seven_day: { utilization: 50, resetsAt: at(now + 90 * HOUR) } }, { five_hour: 30, seven_day: 2 });
    assert.deepEqual(accounts.switchCandidates(from.id, undefined, { until, nowMs: now }).ranked, [target.id]);
  } finally {
    await accounts.remove(from.id);
    await accounts.remove(target.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * SW-3 — unknown usage is no headroom
 * ------------------------------------------------------------------ */

test('SW-3: an account with no reading is never a switch target — unknown usage is no headroom (#100, 2026-09-25 12:53Z)', async () => {
  const now = Date.now();
  const accounts = newAccounts(now);
  const own = await accounts.addToken('own', 'sk-ant-oat01-p92ownaccount00000');
  const unread = await accounts.addToken('unread', 'sk-ant-oat01-p92unreadaccount00');
  try {
    // The run's own account resets in eight minutes; the only other one was never read.
    plant(accounts, own.id, now, { five_hour: { utilization: 99, resetsAt: at(now + 8 * MIN) }, seven_day: { utilization: 44, resetsAt: at(now + 80 * HOUR) } });
    for (const until of [now + 8 * MIN, undefined]) {
      const plan = accounts.switchCandidates(own.id, undefined, { until, nowMs: now, pool: [own.id, unread.id] });
      assert.deepEqual(plan.ranked, [], 'nothing to move to');
      assert.equal(plan.declined.find((row) => row.id === unread.id)?.bucket, 'unknown');
      assert.match(plan.declined.find((row) => row.id === unread.id)?.why ?? '', /unknown/);
    }
    // A credential failover is not a usage switch: the account being left cannot
    // run at all, so an unmetered account is still somewhere to go.
    const failover = accounts.switchCandidates(own.id, undefined, { nowMs: now, pool: [own.id, unread.id], usage: false });
    assert.deepEqual(failover.ranked, [unread.id]);
  } finally {
    await accounts.remove(own.id);
    await accounts.remove(unread.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * SW-4 — the run's floor, in either window
 * ------------------------------------------------------------------ */

test('SW-4: a target under the run\'s own minHeadroomPct in EITHER window is passed over, and the reason names the floor', async () => {
  const now = Date.now();
  const accounts = newAccounts(now);
  const target = await accounts.addToken('target', 'sk-ant-oat01-p92flooraccount000');
  try {
    // #100's 12:36Z move: `default minHeadroomPct: 15`, and info@ at 90 % of its week.
    plant(accounts, target.id, now, { five_hour: { utilization: 10, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 90, resetsAt: at(now + 60 * HOUR) } });
    const weekly = accounts.switchCandidates('default', undefined, { nowMs: now, floors: { [target.id]: 15 } });
    assert.deepEqual(weekly.ranked, []);
    assert.match(weekly.declined.find((row) => row.id === target.id)?.why ?? '', /15 % floor/);
    assert.deepEqual(accounts.switchCandidates('default', undefined, { nowMs: now, floors: { [target.id]: 5 } }).ranked, [target.id]);
    // The five-hour window counts exactly the same.
    plant(accounts, target.id, now, { five_hour: { utilization: 88, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 20, resetsAt: at(now + 60 * HOUR) } });
    const five = accounts.switchCandidates('default', undefined, { nowMs: now, floors: { [target.id]: 15 } });
    assert.deepEqual(five.ranked, []);
    assert.equal(five.declined.find((row) => row.id === target.id)?.bucket, 'five_hour');
  } finally {
    await accounts.remove(target.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * SW-7 — one identity, one account
 * ------------------------------------------------------------------ */

test('SW-7: two profiles of one login are one account — leaving one never lands on the other, and the rank lists the person once', async () => {
  const now = Date.now();
  const accounts = newAccounts(now);
  const signIn = (dir: string, email: string) => {
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: `tok-${dir.length}-${email}`, refreshToken: `r-${email}`, expiresAt: now + HOUR, subscriptionType: 'max' },
    }));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationUuid: 'org-a', organizationName: 'An org' } }));
  };
  const a = accounts.beginProfile('admin-a');
  const b = accounts.beginProfile('admin-b');
  const c = accounts.beginProfile('info');
  try {
    signIn(a.dir, 'admin@example.com');
    signIn(b.dir, 'admin@example.com');
    signIn(c.dir, 'info@example.com');
    const meters = { five_hour: { utilization: 20, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 30, resetsAt: at(now + 60 * HOUR) } };
    for (const id of [a.id, b.id, c.id]) plant(accounts, id, now, meters);
    const plan = accounts.switchCandidates(a.id, undefined, { nowMs: now, pool: [a.id, b.id, c.id] });
    assert.deepEqual(plan.ranked, [c.id], 'admin-b is the same meter as admin-a');
    const rank = accounts.rankAccounts(null, undefined, now).filter((id) => [a.id, b.id, c.id].includes(id));
    assert.equal(rank.filter((id) => id === a.id || id === b.id).length, 1, 'one person, one place in the rank');
  } finally {
    for (const id of [a.id, b.id, c.id]) await accounts.remove(id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * The runner — a stub-scripts harness (switch-headroom.test.ts's)
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-forecast-'));
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
    for p in 1 2; do
      if grep -qx "$p" "$S/done" 2>/dev/null; then d="$d$p,"
      elif [ "$found" -eq 0 ]; then r="$r$p,"; found=1
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

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) =>
  events.filter((e) => e.event === 'run:journal' && e.data.event === name)
    .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function leave(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  const untilIso = (leaving.resetsAt ?? new Date(Date.now() + 1_800_000)).toISOString();
  return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until: untilIso, throttleUntilMs: Date.parse(untilIso) };
}

const wall = (resetMs: number): SpawnOutcome =>
  ok({ signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${Math.floor(resetMs / 1000)}` }, sessionId: 'sess-wall' });

/* ------------------------------------------------------------------ *
 * SW-5 — the move back
 * ------------------------------------------------------------------ */

test('SW-5: when the account a run was moved off resets, the next boarding moves it back — even though the horizon rule would decline it against the new wall', async () => {
  const r = repo();
  let clock = Date.now();
  const fiveReset = Math.floor((clock + HOUR) / 1000) * 1000;
  const spawned: string[] = [];
  const spawn: SpawnFn = async (request) => {
    spawned.push(request.env?.CLAUDE_CODE_OAUTH_TOKEN ?? 'default');
    if (spawned.length === 1) return wall(fiveReset);
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1');
    r.markDone(phase);
    // Phase 1 finishes on the account it moved to — and the origin's window resets meanwhile.
    if (phase === 1) clock = fiveReset + RESET_MARGIN_MS + MIN;
    return ok({ sessionId: `sess-${phase}` });
  };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    now: () => new Date(clock),
    accountEnv: async (accountId) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null),
    // From acct-a: acct-b carries. From acct-b: acct-a is declined against acct-b's own 51-hour weekly horizon.
    switchCandidates: (from) => from === 'acct-a'
      ? { ranked: ['acct-b'], declined: [], wake: null }
      : { ranked: [], declined: [{ id: 'acct-a', bucket: 'seven_day', pct: 48, lastsMs: 13 * HOUR, resetsAt: at(clock + 80 * HOUR), why: 'its seven_day window would wall first' }], wake: null },
    accountRoom: (accountId) => accountId === 'acct-a' && clock > fiveReset
      ? { ok: true, headroomPct: 52, resetsAt: null }
      : { ok: false, headroomPct: 0, resetsAt: at(fiveReset) },
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accountId: 'acct-a' });
    await until(() => spawned.length >= 3 || instance.current()?.status === 'done', 'phase 2 to board');
    const state = instance.current()!;
    assert.deepEqual(spawned, ['tok-acct-a', 'tok-acct-b', 'tok-acct-a'], 'walled on a, finished phase 1 on b, back on a for phase 2');
    const back = journalled(events, 'run.account-switch-back');
    assert.equal(back.length, 1);
    assert.equal(back[0].from, 'acct-b');
    assert.equal(back[0].to, 'acct-a');
    assert.equal(state.switchedFrom ?? null, null, 'nothing is owed a move back any more');
  } finally {
    await instance.stop();
    await instance.wait();
    r.cleanup();
  }
});

test('SW-5: a run that walls again on the account it was moved to waits for the ORIGIN\'s reset, not the new wall\'s 51 hours', async () => {
  const r = repo();
  const now = Date.now();
  const fiveReset = Math.floor((now + HOUR) / 1000) * 1000;
  const weeklyReset = Math.floor((now + 51 * HOUR) / 1000) * 1000;
  const spawned: string[] = [];
  const spawn: SpawnFn = async (request) => {
    spawned.push(request.env?.CLAUDE_CODE_OAUTH_TOKEN ?? 'default');
    return spawned.length === 1 ? wall(fiveReset) : wall(weeklyReset);
  };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    accountEnv: async (accountId) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null),
    switchCandidates: (from) => from === 'acct-a'
      ? { ranked: ['acct-b'], declined: [], wake: null }
      : { ranked: [], declined: [], wake: null },
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accountId: 'acct-a' });
    await until(() => instance.current()?.status === 'waiting', 'the second wall to be waited on');
    const state = instance.current()!;
    assert.equal(state.accountId, 'acct-b');
    assert.equal(state.waitUntil, new Date(fiveReset + RESET_MARGIN_MS).toISOString(), 'the origin resets first: that is when to look again');
  } finally {
    await instance.stop();
    await instance.wait();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SW-6 — a usage decision is enacted, or says why not
 * ------------------------------------------------------------------ */

function streamingSession(r: Repo) {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const inSession = new Promise<void>((resolve) => { entered = resolve; });
  let sink: ((event: StreamEvent) => void) | undefined;
  const spawn: SpawnFn = async (request: SpawnRequest) => {
    sink = request.onEvent;
    entered();
    await held;
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)![1]));
    return ok();
  };
  return { spawn, inSession, release: () => release(), say: (event: StreamEvent) => sink?.(event) };
}

test('SW-6: a 95 % warning with an account that carries the work ENACTS the switch at the lanes\' boundary — the live lane finishes where it is', async () => {
  const r = repo();
  const held = streamingSession(r);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const asked: { until: number | null; floors?: Record<string, number> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: held.spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => 'spare',
    switchCandidates: (_from, _model, opts) => {
      asked.push(opts as { until: number | null; floors?: Record<string, number> });
      return { ranked: ['spare'], declined: [], wake: null };
    },
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accounts: [{ id: 'default', minHeadroomPct: 0 }, { id: 'spare', minHeadroomPct: 15 }] });
    await held.inSession;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.95, utilizationPct: 95, resetsAt: reset });
    const decision = journalled(events, 'run.usage-decision')[0];
    assert.equal(decision.action, 'switch');
    assert.equal(decision.headroom, 'spare');
    assert.equal(decision.enacted, true, 'the switch is carried out, not dropped');
    assert.equal(decision.when, 'boundary');
    assert.equal(asked[0]?.until, reset * 1000, 'the target must carry the work past this window\'s reset');
    assert.equal(asked[0]?.floors?.spare, 15, 'and clear the run\'s own floor');
    const moved = journalled(events, 'run.account-switch');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].when, 'boundary');
    assert.equal(moved[0].checkpointed, 0, 'the live lane keeps its session');
    assert.equal(instance.current()?.accountId, 'spare', 'every next spawn pays with the new account');
    assert.equal(instance.current()?.switchedFrom?.accountId, 'default', 'and the run owes the machine login a move back at its reset');
  } finally {
    held.release();
    await instance.wait();
    r.cleanup();
  }
});

test('SW-6: with nothing that carries the work, the decision says why it was not enacted', async () => {
  const r = repo();
  const held = streamingSession(r);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: held.spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => 'weekly-98',
    switchCandidates: () => ({
      ranked: [],
      declined: [{ id: 'weekly-98', bucket: 'seven_day', pct: 98, lastsMs: 30 * MIN, resetsAt: at(Date.now() + 72 * HOUR), why: 'its seven_day window reads 98 %' }],
      wake: null,
    }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.96, utilizationPct: 96, resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    const decision = journalled(events, 'run.usage-decision')[0];
    assert.equal(decision.enacted, false);
    assert.equal(decision.headroom, null, 'the forecast\'s answer, not the old rank\'s');
    assert.match(String(decision.why), /weekly-98/, 'why: the account it passed over, and its reason');
    assert.deepEqual(journalled(events, 'run.account-switch'), []);
  } finally {
    held.release();
    await instance.wait();
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * CR-4 (control-tower phase 93, #146) — a credit-carried account is not decided
 * ------------------------------------------------------------------ */

test('CR-4: a 95 % warning on an account credits carry decides nothing — no switch is asked, no brake, and run.usage-carried says so once per window', async () => {
  const { Scheduler } = await import('../server/runner/scheduler.ts');
  const r = repo();
  const held = streamingSession(r);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let asked = 0;
  let carries = true;
  const scheduler = new Scheduler({ max: 1, locks: () => [] });
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: held.spawn, verificationText: () => '`true`', scheduler,
    onEvent: (event, data) => events.push({ event, data }),
    pickAccount: () => 'spare',
    switchCandidates: () => { asked += 1; return { ranked: ['spare'], declined: [], wake: null }; },
    creditCarries: () => carries,
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch' });
    await held.inSession;
    const reset = Math.floor(Date.now() / 1000) + 3600;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.96, utilizationPct: 96, resetsAt: reset });
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.97, utilizationPct: 97, resetsAt: reset });
    assert.equal(asked, 0, 'the picker is never asked: there is nothing to move away from');
    assert.deepEqual(journalled(events, 'run.usage-decision'), []);
    assert.equal(scheduler.brakeOf(undefined), null, 'and the account is not braked');
    const carried = journalled(events, 'run.usage-carried');
    assert.equal(carried.length, 1, 'said once for the window and its reset');
    assert.equal(carried[0].window, 'five_hour');
    assert.equal(instance.current()?.accountId, undefined, 'the run stays where it is');

    carries = false;
    held.say({ kind: 'limits', status: 'allowed_warning', window: 'five_hour', utilization: 0.98, utilizationPct: 98, resetsAt: reset });
    assert.equal(journalled(events, 'run.usage-decision').length, 1, 'credits stopped: the next warning is decided as ever');
    assert.equal(asked, 1);
  } finally {
    held.release();
    await instance.wait();
    r.cleanup();
  }
});
