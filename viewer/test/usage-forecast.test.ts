/**
 * Every account and window has a forecast (control-tower phase 92, #141, #33).
 *
 * Four lanes ran on one account and the operator had to work out from three
 * polls — 37 → 44 → 51 % five-hour, 83 → 84 → 85 % weekly between 06:35 and
 * 07:05Z — that it would wall at about 10:50Z and stay walled until 09-30. The
 * meters showed only the current number, and the one warning that could have
 * said so was off by default.
 *
 * FC-1  a linear burn over the last 60 minutes, the projected wall and the reset — the pure rule
 * FC-2  the readings are kept by the poller that READ, carried by a failed read and by the shared meter file
 * FC-3  `/api/accounts` (the facade's view) carries each window's forecast and the runs burning it
 * FC-4  `usage-climbing` warns N hours (default 2) before an account serving live runs walls
 * FC-5  the words the account bar draws: "and climbing" against "and flat"
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { forecastUsage, withSample, UsagePoller } = await import('../server/accounts/usage.ts');
const { Accounts } = await import('../server/accounts/index.ts');
const { FORECAST_WINDOW_MS, FORECAST_LEAD_HOURS, trendPhrase, burnPhrase } = await import('../shared/ops-vocab.js');
type AccountUsage = import('../server/accounts/usage.ts').AccountUsage;
type UsageSample = import('../server/accounts/usage.ts').UsageSample;
type Exec = import('../server/accounts/credentials.ts').Exec;

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-09-26T06:35:00Z');
const WEEKLY_RESET = '2026-09-30T12:00:00Z';
const FIVE_RESET = '2026-09-26T09:30:00Z';

/** #141's three polls, as the endpoint answered them. */
const POLLS: [number, number, number][] = [
  [T0, 37, 83],
  [T0 + 14 * MIN, 44, 84],
  [T0 + 30 * MIN, 51, 85],
];

function buckets(five: number, weekly: number) {
  return { five_hour: { utilization: five, resetsAt: FIVE_RESET }, seven_day: { utilization: weekly, resetsAt: WEEKLY_RESET } };
}

function usageFrom(polls: [number, number, number][]): AccountUsage {
  let samples: Record<string, UsageSample[]> | undefined;
  for (const [at, five, weekly] of polls) samples = withSample(samples, buckets(five, weekly), at);
  const [lastAt, five, weekly] = polls[polls.length - 1];
  return { buckets: buckets(five, weekly), fetchedAt: new Date(lastAt).toISOString(), samples };
}

const near = (actual: number | null | undefined, expected: number, within: number, what: string) => {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= within, `${what}: ${actual} is not within ${within} of ${expected}`);
};

/* ------------------------------------------------------------------ *
 * FC-1 — the rule, pure
 * ------------------------------------------------------------------ */

test('FC-1: three polls make a forecast — a line through the last hour\'s readings, the wall it projects and the reset it races', () => {
  const now = T0 + 30 * MIN;
  const forecast = forecastUsage(usageFrom(POLLS), now);
  // 83 → 85 % over 30 minutes is 4 %/h; 15 % left lasts 3 h 45 min — ≈10:50Z, long before 09-30.
  near(forecast.seven_day?.burnPctPerHour, 4, 0.1, 'the weekly burn');
  assert.equal(forecast.seven_day?.trend, 'climbing');
  assert.equal(forecast.seven_day?.resetsAt, WEEKLY_RESET);
  near(Date.parse(forecast.seven_day?.wallsAt ?? ''), Date.parse('2026-09-26T10:50:00Z'), 5 * MIN, 'the weekly wall');
  assert.equal(forecast.seven_day?.samples, 3);
  assert.equal(forecast.seven_day?.spanMs, 30 * MIN);
  // 37 → 51 % is 28 %/h: it walls at ≈08:50Z, forty minutes before its 09:30Z reset.
  near(forecast.five_hour?.burnPctPerHour, 28, 0.5, 'the five-hour burn');
  near(Date.parse(forecast.five_hour?.wallsAt ?? ''), Date.parse('2026-09-26T08:50:00Z'), 5 * MIN, 'the five-hour wall');
});

test('FC-1: flat is flat, one reading measures nothing, a window that resets first projects no wall', () => {
  const now = T0 + 30 * MIN;
  const flat = forecastUsage(usageFrom([[T0, 78, 78], [T0 + 15 * MIN, 78, 78], [now, 78, 78]]), now);
  assert.equal(flat.five_hour?.trend, 'flat');
  assert.equal(flat.five_hour?.burnPctPerHour, 0);
  assert.equal(flat.five_hour?.wallsAt, null, 'a flat window never walls');

  const one = forecastUsage(usageFrom([[now, 78, 78]]), now);
  assert.equal(one.five_hour?.trend, 'unknown');
  assert.equal(one.five_hour?.burnPctPerHour, null, 'one reading is not a rate');
  assert.equal(one.five_hour?.wallsAt, null);
  assert.equal(one.five_hour?.pct, 78, 'the reading itself is still the reading');

  const close = forecastUsage(usageFrom([[now - 2 * MIN, 70, 70], [now, 72, 72]]), now);
  assert.equal(close.five_hour?.burnPctPerHour, null, 'two readings two minutes apart are noise, not a burn');

  // 4 %/h with 15 % left is 3.75 h — the five-hour window resets in 2 h, so it never walls.
  const resetsFirst = forecastUsage({
    buckets: { five_hour: { utilization: 85, resetsAt: new Date(now + 2 * HOUR).toISOString() } },
    fetchedAt: new Date(now).toISOString(),
    samples: { five_hour: [{ at: new Date(now - 30 * MIN).toISOString(), pct: 83 }, { at: new Date(now).toISOString(), pct: 85 }] },
  }, now);
  assert.equal(resetsFirst.five_hour?.trend, 'climbing');
  assert.equal(resetsFirst.five_hour?.wallsAt, null, 'it resets before it walls');
});

test('FC-1: the series keeps the last hour only, and a window that resets starts a new one', () => {
  let samples: Record<string, UsageSample[]> | undefined;
  samples = withSample(samples, buckets(10, 50), T0);
  samples = withSample(samples, buckets(20, 51), T0 + 30 * MIN);
  samples = withSample(samples, buckets(30, 52), T0 + FORECAST_WINDOW_MS + 10 * MIN);
  assert.deepEqual(samples.five_hour.map((s) => s.pct), [20, 30], 'a reading older than the window is dropped');
  assert.equal(FORECAST_WINDOW_MS, 60 * MIN, 'the burn window is the last hour');
  // The five-hour window reset: 30 → 2 %. Its old line would read a crash, not a rate.
  samples = withSample(samples, buckets(2, 53), T0 + FORECAST_WINDOW_MS + 20 * MIN);
  assert.deepEqual(samples.five_hour.map((s) => s.pct), [2], 'a fall restarts the series');
  assert.deepEqual(samples.seven_day.map((s) => s.pct), [51, 52, 53], 'the weekly window did not reset: its last hour stands');
});

/* ------------------------------------------------------------------ *
 * FC-2 — the poller keeps the readings; the shared file carries them
 * ------------------------------------------------------------------ */

function answering(bodies: (Record<string, unknown> | 'fail')[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    if (body === 'fail') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const body = (five: number, weekly: number) => ({
  five_hour: { utilization: five, resets_at: FIVE_RESET },
  seven_day: { utilization: weekly, resets_at: WEEKLY_RESET },
});

const exec: Exec = async (file, args) =>
  file === 'claude' && args[0] === '--version' ? { stdout: '9.9.9 (Claude Code)\n' } : { stdout: '' };

test('FC-2: the poller that READ keeps each window\'s readings, and a failed read carries them', async () => {
  let clock = T0;
  const poller = new UsagePoller({
    resolveToken: async () => ({ token: 'tok' }),
    fetchFn: answering([body(37, 83), body(44, 84), 'fail', body(51, 85)]),
    exec, base: 'http://usage.test', now: () => clock,
  });
  try {
    await poller.refresh('a');
    clock = T0 + 14 * MIN;
    await poller.refresh('a');
    clock = T0 + 20 * MIN;
    await poller.refresh('a');
    assert.equal(poller.snapshot('a')?.samples?.seven_day?.length, 2, 'a failed read adds nothing and loses nothing');
    clock = T0 + 30 * MIN;
    await poller.refresh('a');
    const snapshot = poller.snapshot('a')!;
    assert.deepEqual(snapshot.samples?.seven_day?.map((s) => s.pct), [83, 84, 85]);
    near(forecastUsage(snapshot, clock).seven_day?.burnPctPerHour, 4, 0.1, 'the burn from the poller\'s own readings');
  } finally {
    poller.stop();
  }
});


/* ------------------------------------------------------------------ *
 * FC-3 — the facade's view: the forecast and the runs burning it
 * ------------------------------------------------------------------ */

function plant(accounts: InstanceType<typeof Accounts>, id: string, usage: AccountUsage): void {
  (accounts as unknown as { poller: { cache: Map<string, unknown> } }).poller.cache.set(id, usage);
}

test('FC-3: every account in the view carries its forecast per window and the runs burning it; the raw readings stay off the wire', async () => {
  const now = T0 + 30 * MIN;
  const accounts = new Accounts({ platform: 'linux', exec, now: () => now, usageBase: 'http://usage.invalid', fetchFn: answering(['fail']) });
  const admin = await accounts.addToken('admin', 'sk-ant-oat01-adminforecast00000');
  try {
    plant(accounts, admin.id, usageFrom(POLLS));
    accounts.setBurningProbe((id) => (id === admin.id ? [{ slug: 'demo-plan', runId: 'run-1', lanes: [41, 43] }] : []));
    const view = (await accounts.list()).find((v) => v.id === admin.id)!;
    near(view.forecast?.buckets.seven_day?.burnPctPerHour, 4, 0.1, 'the weekly burn on the view');
    assert.equal(view.forecast?.buckets.seven_day?.resetsAt, WEEKLY_RESET);
    assert.equal(view.forecast?.bucket, 'five_hour', 'the soonest projected wall');
    near(Date.parse(view.forecast?.wallsAt ?? ''), Date.parse('2026-09-26T08:50:00Z'), 5 * MIN, 'when');
    assert.deepEqual(view.forecast?.burning, [{ slug: 'demo-plan', runId: 'run-1', lanes: [41, 43] }]);
    assert.equal(view.usage?.samples, undefined, 'the view serves the forecast, not the series');
    const idle = (await accounts.list()).find((v) => v.id === 'default')!;
    assert.deepEqual(idle.forecast?.burning ?? [], [], 'nobody burns an account no run is on');
  } finally {
    await accounts.remove(admin.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * FC-4 — the warning, hours ahead, for an account serving live runs
 * ------------------------------------------------------------------ */

test('FC-4: a projected wall inside the lead is told once, only for an account serving live runs; the lead is configurable', async () => {
  let clock = T0;
  const told: { bucket: string; wallsAt: string | null; resetsAt: string }[] = [];
  let lead = FORECAST_LEAD_HOURS * HOUR;
  let serving = false;
  const accounts = new Accounts({
    platform: 'linux', exec, now: () => clock, usageBase: 'http://usage.test',
    fetchFn: answering([body(37, 83), body(44, 84), body(51, 85), body(52, 85), body(53, 86)]),
    forecastLeadMs: () => lead,
    onForecast: (_view, bucket, forecast) => { told.push({ bucket, wallsAt: forecast.wallsAt, resetsAt: forecast.resetsAt }); },
  });
  const admin = await accounts.addToken('admin', 'sk-ant-oat01-adminwarning000000');
  accounts.setActiveProbe((id) => serving && id === admin.id);
  try {
    assert.equal(FORECAST_LEAD_HOURS, 2, 'the default lead');
    await accounts.refreshUsage(admin.id);
    clock = T0 + 14 * MIN;
    await accounts.refreshUsage(admin.id);
    clock = T0 + 30 * MIN;
    await accounts.refreshUsage(admin.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(told, [], 'nothing serves this account: no run to warn about');
    serving = true;
    clock = T0 + 31 * MIN;
    await accounts.refreshUsage(admin.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(told.map((t) => t.bucket), ['five_hour'], 'the five-hour wall is under two hours off; the weekly one is not');
    assert.equal(told[0].resetsAt, FIVE_RESET);
    lead = 5 * HOUR;
    clock = T0 + 32 * MIN;
    await accounts.refreshUsage(admin.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(told.map((t) => t.bucket), ['five_hour', 'seven_day'], 'a longer lead reaches the weekly wall; the five-hour one is not told twice');
  } finally {
    await accounts.remove(admin.id);
    accounts.stop();
  }
});

/* ------------------------------------------------------------------ *
 * FC-5 — the account bar's words (#33's deferred trend)
 * ------------------------------------------------------------------ */

test('FC-5: 78 % and climbing is a different decision from 78 % and flat — the words the bar and the card draw', () => {
  assert.equal(trendPhrase({ trend: 'climbing' }), 'and climbing');
  assert.equal(trendPhrase({ trend: 'flat' }), 'and flat');
  assert.equal(trendPhrase({ trend: 'unknown' }), '');
  assert.equal(trendPhrase(undefined), '');
  assert.equal(burnPhrase(4.04), '+4 %/h');
  assert.equal(burnPhrase(0.26), '+0.3 %/h');
  assert.equal(burnPhrase(0), '');
  assert.equal(burnPhrase(null), '');
});
