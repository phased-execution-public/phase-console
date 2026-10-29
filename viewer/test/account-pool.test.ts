/**
 * A failover stays in its pool (control-tower phase 53, #55).
 *
 * The run that raised #55 declared three accounts and failed over at
 * preflight onto a fourth nobody had named, with `tried: []` — the pool it
 * had never asked. The pool is the run's `accounts` rows (`accountPool`), and
 * every failover ranks inside it (`rankInPool`):
 *
 * AP-1  the rank's outsider is never the target — the pool's member is
 * AP-2  the login probe is asked only of pool members, the ranked ones first
 * AP-3  a spent pool parks with an errand naming the pool, and the run stays put
 *
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';
import { stubRepo, VALIDATE_OK_SH } from './fixtures/repo.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { accountPool, rankInPool } = await import('../server/runner/state.ts');
const { RESET_MARGIN_MS } = await import('../server/runner/errors.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type SpawnRequest = import('../server/runner/spawn.ts').SpawnRequest;

/* ------------------------------------------------------------------ *
 * A runner over stub scripts — the shape `runner.test.ts` uses
 * ------------------------------------------------------------------ */

type Repo = { root: string; scripts: string; markDone: (phase: number) => void; cleanup: () => void };

function stubbedPlan(): Repo {
  // A linear 2-phase graph: phase N is ready once every earlier phase is done.
  const made = stubRepo({
    prefix: 'pc-pool-',
    scripts: ({ state }) => ({
      'phase-graph.sh': `#!/usr/bin/env bash
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
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`,
      'phase-lock.sh': `#!/usr/bin/env bash
set -u
if [ "\${2:-}" = "status" ]; then echo "phase \${3:-?}: free"; fi
exit 0
`,
      'validate.sh': VALIDATE_OK_SH,
    }),
  });
  return made;
}

/** A session that does what it was asked — marks its phase done — and counts itself. */
function workingSession(r: Repo, seen: number[]): SpawnFn {
  return async (request: SpawnRequest) => {
    const phase = Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1]);
    seen.push(phase);
    r.markDone(phase);
    return {
      signal: { subtype: 'success', code: 0, text: '' },
      sessionId: `sess-${phase}`, costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
    };
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

/** A `HeadroomVerdict` stub: the `spent` accounts refuse with a reset an hour off, the rest pass. */
function headroom(spent: string[], asked: (string | undefined)[] = []) {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  return (accountId: string | undefined, _model?: string) => {
    const id = accountId ?? 'default';
    asked.push(id);
    if (spent.includes(id)) {
      return {
        ok: false as const, accountId: id, kind: 'spent' as const, resetsAt,
        reason: `${id} has 0% of its 5-hour window left (resets ${resetsAt}).`,
      };
    }
    return { ok: true as const, accountId: id, fiveHourPct: 10 };
  };
}

/** What the facade answers when the run walks away from a spent window. */
function leave(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  const until = (leaving.resetsAt ?? new Date(Date.now() + 1_800_000)).toISOString();
  return { accountId: accountId ?? 'default', credential: 'stub', state: 'cooling', until, throttleUntilMs: Date.parse(until) };
}

const POOL = [{ id: 'work', minHeadroomPct: 20 }, { id: 'spare', minHeadroomPct: 20 }];

/* ------------------------------------------------------------------ *
 * The pure half
 * ------------------------------------------------------------------ */

test('the pool is the run\'s accounts rows, and failover ranks inside it — never outside, never the account being left', () => {
  assert.equal(accountPool({}), null, 'no rows: no pool, and failover ranks as it always did');
  assert.deepEqual(accountPool({ accounts: [...POOL, { id: 'work', minHeadroomPct: 50 }] }), ['work', 'spare']);
  assert.deepEqual(rankInPool(['outsider', 'spare'], null, 'work'), ['outsider', 'spare'], 'no pool: the rank, untouched');
  assert.deepEqual(rankInPool(['outsider', 'spare'], ['work', 'spare'], 'work'), ['spare']);
  // The pool's members the rank left out (cooling, walled, signed out) are
  // still asked, after the ranked ones, so the errand can say why each failed.
  assert.deepEqual(rankInPool(['outsider', 'third'], ['work', 'spare', 'third'], 'work'), ['third', 'spare']);
});

/* ------------------------------------------------------------------ *
 * AP-1..3 — the preflight door
 * ------------------------------------------------------------------ */

test('AP-0 (EI-21, measured-console phase 17): the account\'s defaultModel and defaultEffort board a phase the run and the plan name none for — and only then', async () => {
  const r = stubbedPlan();
  try {
    const boarded: { model?: string; effort?: string }[] = [];
    const seen: number[] = [];
    const work = workingSession(r, seen);
    const { instance } = runner(r, async (request) => {
      boarded.push({ model: request.model, effort: request.effort });
      return work(request);
    }, {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountDefaults: (id) => (id === 'work' ? { model: 'claude-sonnet-5-5', effort: 'low' } : {}),
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', phaseOptions: { 2: { model: 'claude-opus-5-5', effort: 'high' } } } as never);
    await instance.wait();
    assert.equal(instance.current()!.status, 'finished');
    assert.deepEqual(boarded, [
      { model: 'claude-sonnet-5-5', effort: 'low' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ], 'phase 1 boards on the account\'s defaults; phase 2\'s own choice wins');
  } finally { r.cleanup(); }
});

test('AP-1: a spent account fails over to the pool\'s member, never the rank\'s outsider, and the switch names the pool', async () => {
  const r = stubbedPlan();
  try {
    const seen: number[] = [];
    const { instance, events } = runner(r, workingSession(r, seen), {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountHeadroom: headroom(['work']),
      // The rank prefers an account the run never named.
      rankAccounts: (excluding) => ['outsider', 'spare'].filter((id) => id !== excluding),
      leaveAccount: leave,
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.status, 'finished');
    assert.equal(state.accountId, 'spare', 'the pool\'s member took the run');
    assert.deepEqual(seen, [1, 2]);
    const switched = journalled(events, 'run.account-switched');
    assert.equal(switched.length, 1);
    assert.equal(switched[0].to, 'spare');
    assert.equal(switched[0].at, 'preflight');
    assert.deepEqual(switched[0].pool, ['work', 'spare'], 'the switch names the pool it stayed in');
  } finally { r.cleanup(); }
});

test('AP-2: the login probe is asked only of pool members — the ranked ones first, then the rest of the pool', async () => {
  const r = stubbedPlan();
  try {
    const probed: string[] = [];
    const signedIn = new Set(['spare', 'outsider']);
    const { instance, events } = runner(r, workingSession(r, []), {
      checkAuth: async (accountId) => {
        const id = accountId ?? 'default';
        probed.push(id);
        return { loggedIn: signedIn.has(id), checkedAt: '', ...(signedIn.has(id) ? {} : { detail: `${id} is signed out` }) };
      },
      accountHeadroom: headroom([]),
      // The rank left `spare` out (say it was cooling) and put an outsider first.
      rankAccounts: (excluding) => ['outsider', 'third'].filter((id) => id !== excluding),
    });
    await instance.start({
      slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work',
      accounts: [...POOL, { id: 'third', minHeadroomPct: 20 }],
    });
    await instance.wait();
    assert.equal(instance.current()!.accountId, 'spare');
    assert.equal(probed.includes('outsider'), false, 'an account outside the pool is never probed');
    assert.deepEqual(probed.slice(0, 3), ['work', 'third', 'spare'], 'the run\'s own, then the ranked member, then the rest of the pool');
    const switched = journalled(events, 'run.account-switched');
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0].tried, ['switch-account → third: not signed in']);
  } finally { r.cleanup(); }
});

test('AP-3: with the pool spent the run parks with an errand naming the pool — it never leaves the pool by itself', async () => {
  const r = stubbedPlan();
  try {
    const seen: number[] = [];
    const asked: (string | undefined)[] = [];
    const { instance, events } = runner(r, workingSession(r, seen), {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountHeadroom: headroom(['work', 'spare'], asked),
      // An outsider with all the headroom in the world.
      rankAccounts: (excluding) => ['outsider'].filter((id) => id !== excluding),
      leaveAccount: leave,
    });
    const parked = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL });
    assert.equal(parked.status, 'parked');
    assert.equal(parked.halt?.kind, 'run-preflight');
    assert.equal(parked.accountId, 'work', 'the run stays on the account it was on');
    assert.equal(seen.length, 0, 'nothing spawned behind the refusal');
    assert.match(parked.errand?.need ?? '', /pool \(work, spare\)/, 'the errand names the pool');
    assert.match(parked.errand?.how ?? '', /outside the pool adds it to the pool/, 'and how to widen it');
    assert.equal(parked.errand?.tried?.length, 1, 'the pool\'s one other member was asked, and only it');
    assert.match(parked.errand!.tried![0], /^switch-account → spare: spare has 0% of its 5-hour window left/);
    assert.equal(asked.includes('outsider'), false, 'the outsider is never even asked for headroom');
    assert.equal(journalled(events, 'run.account-switched').length, 0);
    const refused = journalled(events, 'run.preflight-refused');
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0].pool, ['work', 'spare']);
  } finally { r.cleanup(); }
});

test('AP-3b (EI-22, measured-console phase 17): a preflight refusal ends through halt() — run.halt journalled, the halt signalled, finishedReason set — and the run reads parked', async () => {
  const r = stubbedPlan();
  try {
    const { instance, events } = runner(r, workingSession(r, []), {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      accountHeadroom: headroom(['work', 'spare']),
      rankAccounts: () => [],
      leaveAccount: leave,
    });
    const state = await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL } as never);
    assert.equal(state.status, 'parked', 'a preflight refusal still parks the run');
    assert.equal(state.halt?.kind, 'run-preflight');
    const halted = journalled(events, 'run.halt');
    assert.equal(halted.length, 1, 'the refusal is a halt like every other ending');
    assert.equal(halted[0].kind, 'run-preflight');
    assert.ok(state.finishedReason, 'the one field that says why it stopped is written');
  } finally { r.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * AP-4 — the headroom-aware picker stays in the pool (control-tower phase 78)
 * ------------------------------------------------------------------ */

test('AP-4: at a mid-phase wall the headroom-aware picker is asked WITH the pool and the wall\'s reset, and an outsider it ranks is still never taken', async () => {
  const r = stubbedPlan();
  try {
    const asked: { pool: readonly string[] | null | undefined; until: number | null | undefined }[] = [];
    const reset = Math.floor((Date.now() + 2 * 3_600_000) / 1000);
    let calls = 0;
    const { instance } = runner(r, async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          signal: { subtype: 'error_during_execution', code: 1, text: `Claude AI usage limit reached|${reset}` },
          sessionId: 'sess-wall', costUsd: 0.01, turns: 1, resultText: '', durationMs: 5, argv: ['-p', '<prompt>'],
        };
      }
      r.markDone(Number(/BOOT phase (\d+)/.exec(request.prompt)?.[1] ?? '1'));
      return {
        signal: { subtype: 'success', code: 0, text: '' },
        sessionId: 'sess-wall', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 10, argv: ['-p', '<prompt>'],
      };
    }, {
      switchCandidates: (_excluding, _model, opts) => {
        asked.push({ pool: opts.pool, until: opts.until });
        return { ranked: ['outsider', 'spare'], declined: [], wake: null };
      },
      portTranscript: () => ({ findable: true, ported: true, why: 'copied' as const }),
      leaveAccount: leave,
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL, onLimit: 'switch' });
    await instance.wait();
    assert.equal(instance.current()!.accountId, 'spare', 'the pool\'s member, never the outsider');
    assert.deepEqual(asked[0]?.pool, ['work', 'spare']);
    assert.equal(asked[0]?.until, reset * 1000 + RESET_MARGIN_MS, 'weighed against the wall\'s own reset (and its margin)');
  } finally { r.cleanup(); }
});


/* ------------------------------------------------------------------ *
 * AP-11..15 — the spill's mechanics (measured-console phase 24, #420, #389)
 * ------------------------------------------------------------------ */

const { Accounts } = await import('../server/accounts/index.ts');
const { withSample } = await import('../server/accounts/usage.ts');
const { STATE_SANDBOX } = await import('./state-sandbox.ts');
const { SPILL_LAND_MAX_PCT, SPILL_COOLDOWN_MIN } = await import('../shared/ops-vocab.js');

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function facadeAt(now: { ms: number }) {
  return new Accounts({
    platform: 'linux', exec: async () => ({ stdout: '' }), now: () => now.ms, usageBase: 'http://usage.invalid',
    fetchFn: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    learnedFile: join(STATE_SANDBOX, `learned-p24-${Math.random().toString(16).slice(2)}.json`),
  });
}

/** A fresh reading of `buckets`, flat over the last hour (no burn measured). */
function meters(accounts: InstanceType<typeof Accounts>, id: string, nowMs: number, buckets: Record<string, { utilization: number; resetsAt: string }>): void {
  let samples: ReturnType<typeof withSample> | undefined;
  for (const minutesAgo of [60, 30, 0]) samples = withSample(samples, buckets, nowMs - minutesAgo * 60_000);
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set(id, { buckets, fetchedAt: iso(nowMs), samples });
}

test('AP-11 (#420): a spill never lands on a login above 85 % in either shared window, and never re-enters one an automatic move left inside the cooldown', async () => {
  assert.equal(SPILL_LAND_MAX_PCT, 85);
  assert.equal(SPILL_COOLDOWN_MIN, 60);
  const now = { ms: Date.parse('2026-10-21T05:22:53Z') };
  const accounts = facadeAt(now);
  const weekly96 = await accounts.addToken('weekly96', 'sk-ant-oat01-p24weekly96value000');
  const five86 = await accounts.addToken('five86', 'sk-ant-oat01-p24fiveh86value0000');
  const room = await accounts.addToken('room', 'sk-ant-oat01-p24roomvalue0000000');
  try {
    const week = iso(now.ms + 60 * HOUR);
    const five = iso(now.ms + 3 * HOUR);
    meters(accounts, weekly96.id, now.ms, { five_hour: { utilization: 10, resetsAt: five }, seven_day: { utilization: 96, resetsAt: week } });
    meters(accounts, five86.id, now.ms, { five_hour: { utilization: 86, resetsAt: five }, seven_day: { utilization: 20, resetsAt: week } });
    meters(accounts, room.id, now.ms, { five_hour: { utilization: 10, resetsAt: five }, seven_day: { utilization: 84, resetsAt: week } });
    const plan = accounts.switchCandidates('default', undefined, { nowMs: now.ms });
    assert.deepEqual(plan.ranked, [room.id], 'only the login at or under 85 % in both windows');
    assert.deepEqual(plan.declined.map((row) => [row.id, row.bucket]).sort(), [[five86.id, 'five_hour'], [weekly96.id, 'seven_day']].sort());
    assert.match(plan.declined.find((row) => row.id === weekly96.id)!.why, /96 % — a spill never lands above 85 %/);

    // An automatic move LEFT `room` (the runner's switch writes it as `operator` by `runner`):
    // not re-entered inside the cooldown, by the test's clock — and re-entered after it.
    accounts.leaveAccount(room.id, { kind: 'operator', reason: 'account switch by runner', by: 'runner' });
    now.ms += 59 * 60_000;
    meters(accounts, room.id, now.ms, { five_hour: { utilization: 10, resetsAt: five }, seven_day: { utilization: 84, resetsAt: week } });
    const cooling = accounts.switchCandidates('default', undefined, { nowMs: now.ms });
    assert.deepEqual(cooling.ranked, []);
    const held = cooling.declined.find((row) => row.id === room.id)!;
    assert.equal(held.bucket, 'cooldown');
    assert.match(held.why, /not re-entered for 60 min/);
    assert.deepEqual(accounts.switchCandidates('default', undefined, { nowMs: now.ms, usage: false }).ranked.includes(room.id), true,
      'a credential failover is no spill: neither rule holds it');
    now.ms += 2 * 60_000;
    meters(accounts, room.id, now.ms, { five_hour: { utilization: 10, resetsAt: five }, seven_day: { utilization: 84, resetsAt: week } });
    assert.deepEqual(accounts.switchCandidates('default', undefined, { nowMs: now.ms }).ranked, [room.id], 'past the cooldown');

    // A person's move holds nothing against the account it left.
    accounts.leaveAccount(room.id, { kind: 'operator', reason: 'account switch by operator', by: 'operator' });
    assert.deepEqual(accounts.switchCandidates('default', undefined, { nowMs: now.ms }).ranked, [room.id]);
  } finally {
    for (const id of [weekly96.id, five86.id, room.id]) await accounts.remove(id);
    accounts.stop();
  }
});

test('AP-12: consume-first — of the logins a spill may land on, the one whose weekly window resets soonest goes first', async () => {
  const now = { ms: Date.parse('2026-10-21T05:00:00Z') };
  const accounts = facadeAt(now);
  const late = await accounts.addToken('late', 'sk-ant-oat01-p24latevalue0000000');
  const soon = await accounts.addToken('soon', 'sk-ant-oat01-p24soonvalue0000000');
  try {
    const five = iso(now.ms + 3 * HOUR);
    meters(accounts, late.id, now.ms, { five_hour: { utilization: 5, resetsAt: five }, seven_day: { utilization: 20, resetsAt: iso(now.ms + 120 * HOUR) } });
    meters(accounts, soon.id, now.ms, { five_hour: { utilization: 5, resetsAt: five }, seven_day: { utilization: 60, resetsAt: iso(now.ms + 20 * HOUR) } });
    assert.deepEqual(accounts.rankAccounts('default', undefined, now.ms), [late.id, soon.id], 'the rank: the most room first');
    assert.deepEqual(accounts.switchCandidates('default', undefined, { nowMs: now.ms }).ranked, [soon.id, late.id],
      'the spill: what `soon` still holds is lost in 20 h, so it is spent first');
  } finally {
    await accounts.remove(late.id);
    await accounts.remove(soon.id);
    accounts.stop();
  }
});

test('AP-13 (#389): a usage leave whose reset has already passed cools nothing — the reading is older than its own reset', async () => {
  const now = { ms: Date.parse('2026-10-18T00:10:00.440Z') };
  const accounts = facadeAt(now);
  try {
    const left = accounts.leaveAccount(undefined, {
      kind: 'usage', bucket: 'five_hour', resetsAt: new Date('2026-10-18T00:10:00.160Z'),
      reason: 'main has 0% of its 5-hour window left', by: 'preflight',
    });
    assert.notEqual(left.state, 'cooling', 'no cooling on a stale 100 %');
    assert.equal(left.throttleUntilMs, null, 'and no scheduler hold');
    assert.equal(accounts.headroom(undefined, undefined, now.ms).ok, true, 'the quota door stays open');
  } finally { accounts.stop(); }
});

test('AP-14 (#389): the preflight reads the account again after its probes, and a window that reset meanwhile is never cooled', async () => {
  const r = stubbedPlan();
  try {
    const leaves: { id: string; leaving: LeaveReason }[] = [];
    let probed = false;
    const resetsAt = new Date(Date.now() + 1_000).toISOString();
    const { instance } = runner(r, workingSession(r, []), {
      checkAuth: async () => { probed = true; return { loggedIn: true, checkedAt: '' }; },
      // Spent until the probe ran; by the time it answered, the five-hour window had reset.
      accountHeadroom: (accountId) => {
        const id = accountId ?? 'default';
        if (id === 'work' && !probed) {
          return { ok: false as const, accountId: id, kind: 'spent' as const, resetsAt, reason: 'work has 0% of its 5-hour window left' };
        }
        return { ok: true as const, accountId: id, fiveHourPct: 4 };
      },
      rankAccounts: (excluding) => ['spare'].filter((id) => id !== excluding),
      leaveAccount: (accountId, leaving) => { leaves.push({ id: accountId ?? 'default', leaving }); return leave(accountId, leaving); },
    });
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL } as never);
    await instance.wait();
    assert.deepEqual(leaves.filter((row) => row.id === 'work' && row.leaving.kind === 'usage'), [],
      'the account whose window reset during the probe is not cooled');
  } finally { r.cleanup(); }
});

test('AP-15: a dead token is quarantined at its second credential refusal in a day — no read argues it out of retired again, and a person\'s clearance ends it', async () => {
  const now = { ms: Date.parse('2026-10-27T08:00:00Z') };
  const accounts = facadeAt(now);
  const dead = await accounts.addToken('dead', 'sk-ant-oat01-p24deadtokenvalue00');
  const learned = (accounts as unknown as { learned: import('../server/accounts/learned.ts').LearnedAccounts }).learned;
  const fingerprint = accounts.fingerprintOf(dead.id);
  try {
    const refuse = () => accounts.leaveAccount(dead.id, { kind: 'credential', class: 'auth', reason: 'invalid x-api-key', by: 'classifier' });
    refuse();
    assert.equal(learned.quarantineOf(fingerprint), undefined, 'one refusal retires, and quarantines nothing');
    now.ms += 10 * 60_000;
    learned.noteProof(fingerprint, { at: iso(now.ms), by: 'runner', reason: 'a usage read went through' }, dead.id);
    assert.equal(accounts.entitlementOf(dead.id, now.ms).state, 'entitled', 'a later green read argues the first retirement out (#57)');

    now.ms += 3 * HOUR;
    refuse();
    const quarantine = learned.quarantineOf(fingerprint);
    assert.equal(quarantine?.strikes, 2, 'the second refusal inside a day quarantines it');
    now.ms += 10 * 60_000;
    learned.noteProof(fingerprint, { at: iso(now.ms), by: 'runner', reason: 'a usage read went through' }, dead.id);
    assert.equal(accounts.entitlementOf(dead.id, now.ms).state, 'retired', 'no read argues a quarantine out');
    const door = accounts.headroom(dead.id, undefined, now.ms);
    assert.match(door.ok ? '' : door.reason, /quarantined — 2 credential refusals in a day/);

    assert.equal(accounts.clearRetired(dead.id, 'operator'), true);
    assert.equal(learned.quarantineOf(fingerprint), undefined, 'a person\'s clearance ends it');
  } finally {
    await accounts.remove(dead.id);
    accounts.stop();
  }
});

test('AP-16 (B9): a session waits on a usage limit only until its pool next has room — the nearest reset, bounded at half an hour and floored at a minute', async () => {
  const { usageLimitWaitMs, WATCHDOG_MAX_WAIT_MS, WATCHDOG_USAGE_LIMIT_FLOOR_MS } = await import('../server/runner/errors.ts');
  const now = Date.parse('2026-10-27T10:00:00Z');
  assert.equal(usageLimitWaitMs(null, now), WATCHDOG_MAX_WAIT_MS, 'no reset known: the request\'s own bound');
  assert.equal(usageLimitWaitMs(now + 12 * 60_000, now), 12 * 60_000, 'a pool member resets in 12 min: wait that long, then rotate');
  assert.equal(usageLimitWaitMs(now + 25 * HOUR, now), WATCHDOG_MAX_WAIT_MS, 'a reset a day off never holds a session past the bound');
  assert.equal(usageLimitWaitMs(now + 5_000, now), WATCHDOG_USAGE_LIMIT_FLOOR_MS);

  // The runner states it on every session, from the pool's nearest reset.
  const r = stubbedPlan();
  try {
    const seen: (string | undefined)[] = [];
    const asked: (readonly string[] | null)[] = [];
    const work = workingSession(r, []);
    const { instance } = runner(r, async (request) => { seen.push(request.env?.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS); return work(request); }, {
      checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
      poolNearestReset: (pool, nowMs) => { asked.push(pool); return nowMs + 20 * 60_000; },
    });
    const saved = process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS;
    delete process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS;
    try {
      await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work', accounts: POOL } as never);
      await instance.wait();
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS = saved;
    }
    assert.ok(seen.length >= 1);
    for (const value of seen) assert.ok(Math.abs(Number(value) - 20 * 60_000) < 5_000, `about 20 min, read ${value}`);
    assert.deepEqual(asked[0], ['work', 'spare'], 'asked of the run\'s pool');
  } finally { r.cleanup(); }
});

