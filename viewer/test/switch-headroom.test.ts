/**
 * The switch picker weighs the reset horizon (control-tower phase 78, #100).
 *
 * The shared login hit its five-hour wall with the reset two hours away, and
 * `onLimit: switch` moved the runs onto accounts at 97–98 % of their SEVEN-day
 * windows. One walled weekly within the hour and held its phases for three
 * days. Waiting the two hours would have lost nothing. The rank sorted by the
 * worse of the two shared meters and asked nothing about WHEN.
 *
 * SH-1  the picker never moves work onto an account whose window would wall
 *       before the current wall resets — the pure rule, the facade, the runner
 * SH-2  with no real headroom, `switch` degrades to `wait` on the soonest reset
 * SH-3  the account a run is on is always in its pool
 * (SH-4..6 — the ladder's `switch-account` rung — are in `ladder.test.ts`.)
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Accounts, carriesUntil: carriesAt } = await import('../server/accounts/index.ts');
const { withSample } = await import('../server/accounts/usage.ts');

/**
 * The rates measured on 2026-09-24 — phase 78's constant, retired by phase 92
 * (#141): the rule now takes the burn as data, measured by the caller.
 */
const BURN = { five_hour: 20, seven_day: 4, seven_day_opus: 4 };
const carriesUntil = (buckets: Parameters<typeof carriesAt>[0], until: number, now: number, family?: string) =>
  carriesAt(buckets, until, now, family, BURN);
const { Runner } = await import('../server/runner/runner.ts');
const { RESET_MARGIN_MS } = await import('../server/runner/errors.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnOutcome = import('../server/runner/spawn.ts').SpawnOutcome;
type Exec = import('../server/accounts/credentials.ts').Exec;
type LeaveReason = import('../server/accounts/index.ts').LeaveReason;
type LeaveResult = import('../server/accounts/index.ts').LeaveResult;

const HOUR = 3_600_000;
const PERSON = { by: 'operator', via: 'api', origin: '127.0.0.1', remoteUser: null } as const;

/* ------------------------------------------------------------------ *
 * SH-1 — the rule, pure
 * ------------------------------------------------------------------ */

const at = (ms: number) => new Date(ms).toISOString();

test('SH-1: the horizon rule — a window that would wall before the current wall resets declines the account; one that resets first never does', () => {
  const now = Date.parse('2026-09-24T15:25:00Z');
  const until = Date.parse('2026-09-24T17:20:00Z'); // the current five-hour wall's reset, ~2 h off

  // #100's targets: 97–98 % weekly, reset in three days. At 4 %/h that is under
  // an hour of work — it walls long before 17:20, and then holds for days.
  const weekly98 = { seven_day: { utilization: 98, resetsAt: at(now + 72 * HOUR) }, five_hour: { utilization: 5, resetsAt: at(now + 4 * HOUR) } };
  const declined = carriesUntil(weekly98, until, now);
  assert.ok(declined, 'declined');
  assert.equal(declined.bucket, 'seven_day');
  assert.equal(declined.pct, 98);
  assert.equal(declined.resetsAt, at(now + 72 * HOUR));
  assert.ok(declined.lastsMs < until - now);
  assert.match(declined.why, /seven_day/);

  // A weekly window with room: 40 % left at 4 %/h is ten hours — past 17:20.
  assert.equal(carriesUntil({ seven_day: { utilization: 60, resetsAt: at(now + 72 * HOUR) } }, until, now), null);
  // A window that resets BEFORE the current wall does cannot hold work past the
  // moment waiting would have resumed it, however full it is.
  assert.equal(carriesUntil({ five_hour: { utilization: 97, resetsAt: at(now + HOUR) } }, until, now), null);
  // A five-hour window that resets after it, and would wall first, declines too.
  const five = carriesUntil({ five_hour: { utilization: 90, resetsAt: at(until + HOUR) } }, until, now);
  assert.equal(five?.bucket, 'five_hour');
  // The model's own weekly window counts for that model only.
  const opus = { seven_day_opus: { utilization: 99, resetsAt: at(now + 72 * HOUR) } };
  assert.equal(carriesUntil(opus, until, now), null, 'no model named: a per-model window says nothing');
  assert.equal(carriesUntil(opus, until, now, 'opus')?.bucket, 'seven_day_opus');
  // No meters at all is not evidence of a wall.
  assert.equal(carriesUntil({}, until, now), null);
  // A horizon already past asks nothing.
  assert.equal(carriesUntil(weekly98, now - 1, now), null);
});

/* ------------------------------------------------------------------ *
 * SH-1 — the facade: `switchCandidates`
 * ------------------------------------------------------------------ */

function fakeExec(): Exec {
  return async () => ({ stdout: '' });
}

function plantMeters(
  accounts: InstanceType<typeof Accounts>, id: string, buckets: Record<string, { utilization: number; resetsAt: string }>, fetchedAt: string,
  burn?: Record<string, number>,
): void {
  // With `burn`: an hour of readings climbing to these meters at that many
  // percent per hour — the burn the picker measures (phase 92).
  let samples: ReturnType<typeof withSample> | undefined;
  if (burn) {
    const at = Date.parse(fetchedAt);
    for (const minutesAgo of [60, 30, 0]) {
      const readings = Object.fromEntries(Object.entries(buckets).map(([name, bucket]) =>
        [name, { ...bucket, utilization: Math.max(0, bucket.utilization - (burn[name] ?? 0) * (minutesAgo / 60)) }]));
      samples = withSample(samples, readings, at - minutesAgo * 60_000);
    }
  }
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set(id, { buckets, fetchedAt, ...(samples ? { samples } : {}) });
}

test('SH-1: switchCandidates ranks only accounts that carry the work past the current wall\'s reset, and names each one it declined', async () => {
  const now = Date.now();
  const accounts = new Accounts({ platform: 'linux', exec: fakeExec(), now: () => now });
  const nearly = await accounts.addToken('nearly-spent', 'sk-ant-oat01-nearlyspentvalue00');
  const roomy = await accounts.addToken('roomy', 'sk-ant-oat01-roomyvalue000000000');
  try {
    const fresh = at(now);
    plantMeters(accounts, nearly.id, { five_hour: { utilization: 2, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 98, resetsAt: at(now + 72 * HOUR) } }, fresh);
    plantMeters(accounts, roomy.id, { five_hour: { utilization: 30, resetsAt: at(now + 4 * HOUR) }, seven_day: { utilization: 40, resetsAt: at(now + 96 * HOUR) } }, fresh);
    // The work being moved burned the machine login at the measured rates.
    plantMeters(accounts, 'default', { five_hour: { utilization: 100, resetsAt: at(now + 2 * HOUR) }, seven_day: { utilization: 50, resetsAt: at(now + 90 * HOUR) } }, fresh, { five_hour: 20, seven_day: 4 });

    // No wall to weigh against: the rank as it always was — the worse shared meter.
    assert.deepEqual(accounts.rankAccounts('default', undefined, now), [roomy.id, nearly.id]);
    const open = accounts.switchCandidates('default', undefined, { nowMs: now });
    assert.deepEqual(open.ranked, [roomy.id, nearly.id]);
    assert.deepEqual(open.declined, []);

    // Walled until +2 h: the nearly spent account walls weekly before then.
    const plan = accounts.switchCandidates('default', undefined, { until: now + 2 * HOUR, nowMs: now });
    assert.deepEqual(plan.ranked, [roomy.id], 'only the account that carries the work until the reset');
    assert.equal(plan.declined.length, 1);
    assert.equal(plan.declined[0].id, nearly.id);
    assert.equal(plan.declined[0].bucket, 'seven_day');
    assert.match(plan.declined[0].why, /seven_day/);

    // Inside a pool: only its members, and nothing else is ever ranked.
    const pooled = accounts.switchCandidates('default', undefined, { until: now + 2 * HOUR, nowMs: now, pool: ['default', nearly.id] });
    assert.deepEqual(pooled.ranked, [], 'the pool\'s one other member would wall first');
    assert.deepEqual(pooled.declined.map((row) => row.id), [nearly.id]);
    assert.equal(pooled.wake, null, 'no pool member frees up before the current wall resets');
  } finally {
    await accounts.remove(nearly.id);
    await accounts.remove(roomy.id);
    accounts.stop();
  }
});

test('SH-2: the facade names the soonest reset — a pool member whose wall lifts before the current one is when to look again', async () => {
  const now = Date.now();
  const accounts = new Accounts({ platform: 'linux', exec: fakeExec(), now: () => now });
  const soon = await accounts.addToken('soon', 'sk-ant-oat01-soonvalue0000000000');
  try {
    // `soon` hit its five-hour wall and resets in 30 minutes — before the run's own wall at +2 h.
    accounts.leaveAccount(soon.id, { kind: 'usage', bucket: 'five_hour', resetsAt: new Date(now + 30 * 60_000), reason: 'walled', by: 'classifier' });
    const plan = accounts.switchCandidates('default', undefined, { until: now + 2 * HOUR, nowMs: now, pool: ['default', soon.id] });
    assert.deepEqual(plan.ranked, [], 'walled now');
    assert.equal(plan.wake, at(now + 30 * 60_000), 'the soonest reset in the pool');
    const later = accounts.switchCandidates('default', undefined, { until: now + 20 * 60_000, nowMs: now, pool: ['default', soon.id] });
    assert.equal(later.wake, null, 'a member that frees up AFTER the current wall is no reason to wake early');
  } finally {
    await accounts.remove(soon.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * The runner — a stub-scripts harness
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function write(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-horizon-'));
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

/** The first session hits the account's usage limit; every later one finishes its phase. */
function walledOnce(r: Repo, resetEpochS: number, spawned: string[]): SpawnFn {
  return async (request) => {
    spawned.push(request.env?.CLAUDE_CODE_OAUTH_TOKEN ?? 'default');
    if (spawned.length === 1) {
      return ok({ signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${resetEpochS}` }, sessionId: 'sess-wall' });
    }
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1'));
    return ok({ sessionId: 'sess-wall' });
  };
}

/* ------------------------------------------------------------------ *
 * SH-1/SH-2 — onLimit: switch, at the wall
 * ------------------------------------------------------------------ */

test('SH-1/SH-2: onLimit switch with only a nearly spent account to go to does not move — it waits on the wall\'s own reset, and says what it declined', async () => {
  const r = repo();
  const resetMs = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
  const spawned: string[] = [];
  const { instance, events } = runner(r, walledOnce(r, resetMs / 1000, spawned), {
    accountEnv: async (accountId) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null),
    // The old picker's answer — what #100 moved onto.
    pickAccount: () => 'weekly-98',
    rankAccounts: () => ['weekly-98'],
    // The horizon-aware answer: it walls weekly long before the reset.
    switchCandidates: () => ({
      ranked: [],
      declined: [{ id: 'weekly-98', bucket: 'seven_day', pct: 98, lastsMs: 30 * 60_000, resetsAt: new Date(Date.now() + 72 * HOUR).toISOString(), why: 'its seven_day window reads 98 %' }],
      wake: null,
    }),
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accountId: 'acct-a' });
    await until(() => instance.current()?.status === 'waiting' || instance.current()?.accountId !== 'acct-a', 'the wall to be answered');
    const state = instance.current()!;
    assert.equal(state.accountId, 'acct-a', 'the run stays on its own account');
    assert.equal(state.status, 'waiting', 'switch degraded to wait');
    // The classifier's reset carries its margin (`RESET_MARGIN_MS`), on the wait and on the picker's horizon alike.
    const reset = new Date(resetMs + RESET_MARGIN_MS).toISOString();
    assert.equal(state.waitUntil, reset, 'on the wall\'s own reset — the soonest there is');
    assert.deepEqual(journalled(events, 'phase.account-switch'), [], 'nothing moved');
    const declined = journalled(events, 'phase.switch-declined');
    assert.equal(declined.length, 1);
    assert.equal(declined[0].from, 'acct-a');
    assert.equal(declined[0].until, reset);
    assert.deepEqual((declined[0].declined as { id: string }[]).map((row) => row.id), ['weekly-98']);
    assert.equal(spawned.length, 1, 'no session was spent on the account that would wall');
  } finally {
    await instance.stop();
    await instance.wait();
    r.cleanup();
  }
});

test('SH-2: a pool member whose wall lifts sooner wakes the wait sooner — the run looks again at the soonest reset, not the latest', async () => {
  const r = repo();
  const resetMs = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
  const wakeIso = new Date(Date.now() + 30 * 60_000).toISOString();
  const { instance } = runner(r, walledOnce(r, resetMs / 1000, []), {
    switchCandidates: () => ({ ranked: [], declined: [], wake: wakeIso }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accountId: 'acct-a' });
    await until(() => instance.current()?.status === 'waiting', 'the wait');
    assert.equal(instance.current()!.waitUntil, wakeIso);
  } finally {
    await instance.stop();
    await instance.wait();
    r.cleanup();
  }
});

test('SH-1: with a candidate that carries the work, the switch still happens — the rule declines, it does not forbid', async () => {
  const r = repo();
  const resetMs = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
  const spawned: string[] = [];
  const { instance, events } = runner(r, walledOnce(r, resetMs / 1000, spawned), {
    accountEnv: async (accountId) => (accountId ? { CLAUDE_CODE_OAUTH_TOKEN: `tok-${accountId}` } : null),
    switchCandidates: (_excluding, _model, opts) => {
      assert.equal(opts.until, resetMs + RESET_MARGIN_MS, 'the picker is told when the current wall resets');
      return { ranked: ['roomy'], declined: [], wake: null };
    },
    portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
    leaveAccount: leave,
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', onLimit: 'switch', accountId: 'acct-a' });
    await instance.wait();
    assert.equal(instance.current()!.accountId, 'roomy');
    assert.equal(spawned[1], 'tok-roomy');
    assert.equal(journalled(events, 'phase.account-switch')[0]?.to, 'roomy');
  } finally {
    r.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * SH-3 — the account a run is on is always in its pool
 * ------------------------------------------------------------------ */

test('SH-3: a run started on an account its pool leaves out has it in the pool — at launch, on a Continue that names another, and after a switch', async () => {
  const r = repo();
  const { instance } = runner(r, async (request) => {
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1'));
    return ok();
  });
  try {
    const pool = [{ id: 'work', minHeadroomPct: 20 }, { id: 'spare', minHeadroomPct: 20 }];
    // #100: observability-plane ran on `account` with fallbacks [account-4940, default, account-ebbb].
    const started = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'outsider', accounts: pool });
    await instance.wait();
    assert.deepEqual(instance.current()!.accounts, [...pool, { id: 'outsider', minHeadroomPct: 0 }],
      'the run\'s account joins its pool at launch, with no floor of its own');

    // A Continue that names another account: it joins too.
    await instance.start({ slug: 'demo', root: r.root, resumeRunId: started.id, autonomy: 'keep-going', accountId: 'third' });
    await instance.wait();
    const resumed = instance.current()!;
    assert.equal(resumed.accountId, 'third');
    assert.ok(resumed.accounts?.some((row) => row.id === 'third'), 'the account a Continue moved it to is in its pool');
    assert.ok(resumed.accounts?.some((row) => row.id === 'outsider'), 'and nothing was dropped');
  } finally {
    r.cleanup();
  }
});

test('SH-3: a person\'s switch keeps the invariant too — the pool names the account the record names', async () => {
  const r = repo();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { instance } = runner(r, async (request) => {
    await held;
    r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1'));
    return ok();
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: [{ id: 'work', minHeadroomPct: 20 }] });
    const out = instance.switchAccount('spare', PERSON as never);
    assert.equal(out.ok, true);
    const state = instance.current()!;
    assert.equal(state.accountId, 'spare');
    assert.ok(state.accounts?.some((row) => row.id === 'spare'));
  } finally {
    release();
    await instance.wait();
    r.cleanup();
  }
});
