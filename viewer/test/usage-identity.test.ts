/**
 * Meters belong to the identity that earned them (control-tower phase 76, #109).
 *
 * `default` is fingerprinted by its LOCATOR — the CLI's keychain item or
 * credentials file — so a re-login as somebody else under the same locator kept
 * the fingerprint, and with it the previous login's buckets: the new identity
 * showed the old one's 100 % weekly for two hours, through an outage that kept
 * the poll from replacing them. What must hold: a credential, organisation or
 * email change clears the account's meters and re-polls them — never carried
 * over, even when that re-poll fails; a follower never adopts a shared read made
 * under another identity; and every bucket on the view says when it was read and
 * whether it is stale (older than twice the poll interval, or past its reset).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Accounts } from '../server/accounts/index.ts';
import type { Exec } from '../server/accounts/credentials.ts';
import {
  agedUsage, USAGE_IDLE_MS, USAGE_STALE_FACTOR,
} from '../server/accounts/usage.ts';
import { STATE_SANDBOX } from './state-sandbox.ts';

const HOUR = 3_600_000;
const exec: Exec = async (file, args) =>
  file === 'claude' && args[0] === '--version' ? { stdout: '9.9.9 (Claude Code)\n' } : { stdout: '' };

/** A usage endpoint the test moves: a body answers 200, `null` is a transport failure. */
function endpoint() {
  const state: { body: Record<string, unknown> | null; reads: number } = { body: null, reads: 0 };
  const fetchFn = (async () => {
    state.reads += 1;
    if (!state.body) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(state.body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { state, fetchFn };
}

/** What `claude auth login` leaves in a config dir: the OAuth blob and the account it belongs to. */
function signIn(dir: string, who: { email: string; org: string; token: string }): void {
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: {
      accessToken: who.token, refreshToken: `refresh-${who.token}`,
      expiresAt: Date.now() + 4 * HOUR, subscriptionType: 'max',
    },
  }));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: who.email, organizationUuid: who.org, organizationName: 'An org' },
  }));
}

const meters = (fiveHour: number, sevenDay: number) => ({
  five_hour: { utilization: fiveHour, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
  seven_day: { utilization: sevenDay, resets_at: new Date(Date.now() + 48 * HOUR).toISOString() },
});

function facade(name: string, fetchFn: typeof fetch): Accounts {
  return new Accounts({
    platform: 'linux', exec, fetchFn, usageBase: 'http://usage.invalid',
    learnedFile: join(STATE_SANDBOX, `learned-p76-${name}.json`),
  });
}

test('#109: a re-login as somebody else clears the meters — never carried over, even through a failing re-poll', async () => {
  const { state, fetchFn } = endpoint();
  const accounts = facade('relogin', fetchFn);
  try {
    const { id, dir } = accounts.beginProfile('relogin');
    signIn(dir, { email: 'mobin@example.com', org: 'org-mobin', token: 'tok-mobin' });
    state.body = meters(2, 100);
    assert.equal((await accounts.refreshUsage(id))?.buckets.seven_day?.utilization, 100, 'the first login reads its own week');

    // The operator signs in again as somebody else — and the API is down.
    signIn(dir, { email: 'admin@example.com', org: 'org-admin', token: 'tok-admin' });
    state.body = null;
    const during = await accounts.refreshUsage(id);
    assert.deepEqual(during?.buckets ?? {}, {}, 'the previous login’s buckets are gone, and a failed re-poll does not resurrect them');
    assert.equal(during?.fetchedAt, undefined, 'nor its read time: this identity has never been read');
    assert.match(during?.error ?? '', /fetch failed/, 'the failure is said beside the empty meters');
    const view = (await accounts.list()).find((a) => a.id === id);
    assert.equal(view?.usage?.buckets.seven_day, undefined, 'the card shows no week rather than somebody else’s');
    assert.equal(view?.email, 'admin@example.com');

    state.body = meters(4, 14);
    assert.equal((await accounts.refreshUsage(id))?.buckets.seven_day?.utilization, 14, 'the new login’s own reading lands');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});

test('#109: an organisation change alone clears them; the same identity polled again keeps them through an outage', async () => {
  const { state, fetchFn } = endpoint();
  const accounts = facade('org', fetchFn);
  try {
    const { id, dir } = accounts.beginProfile('org-move');
    signIn(dir, { email: 'one@example.com', org: 'org-a', token: 'tok-one' });
    state.body = meters(10, 60);
    await accounts.refreshUsage(id);

    // Same login, same identity, the API down: stale-and-said-so beats blank.
    state.body = null;
    const kept = await accounts.refreshUsage(id);
    assert.equal(kept?.buckets.seven_day?.utilization, 60, 'an unchanged identity keeps its last reading through weather');
    assert.ok(kept?.fetchedAt, 'with the time it was read');

    // The same address, moved to another organisation.
    signIn(dir, { email: 'one@example.com', org: 'org-b', token: 'tok-one' });
    const moved = await accounts.refreshUsage(id);
    assert.deepEqual(moved?.buckets ?? {}, {}, 'another organisation’s meters are not this one’s');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});

test('#109: every bucket on the view carries polledAt and a stale mark — older than twice the poll interval, or past its reset', async () => {
  const now = Date.parse('2026-09-25T01:00:00Z');
  const polledAt = new Date(now - 5 * 60_000).toISOString();
  const usage = {
    buckets: {
      five_hour: { utilization: 65, resetsAt: '2026-09-25T00:00:00Z' },
      seven_day: { utilization: 40, resetsAt: '2026-09-30T00:00:00Z' },
    },
    fetchedAt: polledAt,
  };
  assert.equal(USAGE_STALE_FACTOR, 2, 'twice the poll interval, the issue’s rule');

  const fresh = agedUsage(usage, USAGE_IDLE_MS, now);
  assert.equal(fresh.buckets.seven_day?.polledAt, polledAt, 'each bucket says when it was read');
  assert.equal(fresh.buckets.seven_day?.stale, false, 'five minutes old on a ten-minute clock is current');
  assert.equal(fresh.buckets.five_hour?.polledAt, polledAt);
  assert.equal(fresh.buckets.five_hour?.stale, true, 'a window whose reset has passed is stale whatever its age');
  assert.equal(usage.buckets.five_hour.resetsAt, '2026-09-25T00:00:00Z', 'the cache is never edited to make a view');
  assert.equal(Object.hasOwn(usage.buckets.seven_day, 'stale'), false);

  const old = agedUsage(usage, 90_000, now);
  assert.equal(old.buckets.seven_day?.stale, true, 'five minutes old on a 90-second clock is past twice the interval');

  const never = agedUsage({ buckets: usage.buckets }, USAGE_IDLE_MS, now);
  assert.equal(never.buckets.seven_day?.stale, true, 'a bucket no successful read stands behind is stale');
  assert.equal(never.buckets.seven_day?.polledAt, undefined);

  // The facade's view is the same function over the poller's snapshot.
  const { state, fetchFn } = endpoint();
  const accounts = facade('aged', fetchFn);
  try {
    const { id, dir } = accounts.beginProfile('aged');
    signIn(dir, { email: 'aged@example.com', org: 'org-aged', token: 'tok-aged' });
    state.body = {
      ...meters(30, 20),
      seven_day_opus: { utilization: 5, resets_at: new Date(Date.now() - 60_000).toISOString() },
    };
    const read = await accounts.refreshUsage(id);
    const view = (await accounts.list()).find((a) => a.id === id);
    for (const [name, bucket] of Object.entries(view?.usage?.buckets ?? {})) {
      assert.equal(bucket.polledAt, read?.fetchedAt, `${name} carries the read's time`);
    }
    assert.equal(view?.usage?.buckets.five_hour?.stale, false);
    assert.equal(view?.usage?.buckets.seven_day_opus?.stale, true, 'a reset already past is marked on the view');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});


test('#109 (contributes, control-tower phase 91): a re-login as somebody else also takes the learned walls and the breaker with the old identity', async () => {
  const { state, fetchFn } = endpoint();
  const accounts = facade('p91-walls', fetchFn);
  try {
    const { id, dir } = accounts.beginProfile('walls');
    signIn(dir, { email: 'mobin@example.com', org: 'org-mobin', token: 'tok-mobin' });
    state.body = meters(2, 100);
    await accounts.refreshUsage(id);
    accounts.markLimited(id, 'seven_day', new Date(Date.now() + 48 * HOUR).toISOString());
    accounts.retire(id, undefined, 'the API refused the login', 'classifier', 'auth');
    assert.ok(accounts.limitedUntil(id).seven_day);

    // The re-login lands while the API is unreachable: no reading can lift
    // anything, so only the identity change may.
    signIn(dir, { email: 'admin@example.com', org: 'org-mobin', token: 'tok-admin' });
    state.body = null;
    await accounts.refreshUsage(id);
    assert.deepEqual(accounts.limitedUntil(id), {}, 'the week that walled mobin@ is not admin@’s wall');
    assert.equal(accounts.entitlementOf(id).state, 'unknown', 'nor is mobin@’s refused login admin@’s — the breaker starts over');
    await accounts.remove(id);
  } finally { accounts.stop(); }
});
