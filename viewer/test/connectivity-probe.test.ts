/**
 * The one connectivity probe (control-tower phase 76, #110).
 *
 * After the 23:00–00:04Z outage every meter read had failed with `fetch
 * failed`, and each failure had doubled the account's back-off: 1, 2, 4, 8, 16,
 * 30 minutes. Fifteen minutes after the network was back nothing had been read.
 * A transport failure says nothing about an account, so it no longer grows the
 * back-off; instead ONE helper probes the network — a HEAD any HTTP answer
 * satisfies, at most once a minute — and tells its listeners the moment it
 * answers, which is when the poller reads every account. Phase 80's attempt
 * loop imports the same helper.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTIVITY_PROBE_MS, ConnectivityProbe, probeReachable } from '../server/connectivity-probe.ts';

const settle = () => new Promise((r) => setImmediate(r));

/** A hand-driven clock: `armed[n].fn()` fires a timer, and a fired or cancelled timer is no longer live. */
function clock() {
  const armed: { fn: () => void; ms: number; cancelled: boolean; fired: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn: () => { entry.fired = true; fn(); }, ms, cancelled: false, fired: false };
    armed.push(entry);
    return () => { entry.cancelled = true; };
  };
  return { armed, schedule, live: () => armed.filter((a) => !a.cancelled && !a.fired) };
}

test('#110: an unreachable network is probed at most once a minute until it answers; recovery fires once', async () => {
  const { armed, schedule, live } = clock();
  let up = false;
  let probes = 0;
  const probe = new ConnectivityProbe({ probe: async () => { probes += 1; return up; }, schedule });
  const recovered: number[] = [];
  probe.onRecovered(() => recovered.push(probes));

  assert.equal(CONNECTIVITY_PROBE_MS, 60_000, 'at most every 60 s');
  assert.equal(probe.offline, false);
  probe.noteUnreachable();
  probe.noteUnreachable();
  probe.noteUnreachable();
  assert.equal(probe.offline, true);
  assert.equal(live().length, 1, 'three failures arm one probe, not three');
  assert.equal(armed[0]?.ms, CONNECTIVITY_PROBE_MS, 'a minute on — the failure itself was just observed');

  armed[0]?.fn();
  await settle();
  assert.equal(probes, 1);
  assert.deepEqual(recovered, [], 'still down: nobody is told anything');
  assert.equal(live().length, 1, 'a failed probe arms the next');
  assert.equal(armed[1]?.ms, CONNECTIVITY_PROBE_MS);

  up = true;
  armed[1]?.fn();
  await settle();
  assert.deepEqual(recovered, [2], 'the probe that answered tells every listener, once');
  assert.equal(probe.offline, false);
  assert.equal(live().length, 0, 'and nothing more is armed');

  // A real answer ends an outage too, without waiting for the probe's minute.
  probe.noteUnreachable();
  assert.equal(live().length, 1);
  probe.noteReachable();
  assert.equal(live().length, 0, 'the armed probe is cancelled');
  assert.equal(recovered.length, 2);
  probe.noteReachable();
  assert.equal(recovered.length, 2, 'reachable while online is nothing');
  probe.stop();
});

test('#110: a slow probe is never doubled; a listener that throws does not stop the others; stop ends it', async () => {
  const { schedule, live, armed } = clock();
  let release: (answer: boolean) => void = () => {};
  const probe = new ConnectivityProbe({ probe: () => new Promise<boolean>((r) => { release = r; }), schedule });
  const heard: string[] = [];
  probe.onRecovered(() => { throw new Error('a careless listener'); });
  const off = probe.onRecovered(() => heard.push('second'));
  probe.noteUnreachable();
  armed[0]?.fn();
  probe.noteUnreachable();
  assert.equal(live().length, 0, 'a probe in flight is the probe — no second one is armed beside it');
  release(true);
  await settle();
  assert.deepEqual(heard, ['second']);

  off();
  probe.noteUnreachable();
  probe.stop();
  assert.equal(live().length, 0, 'stop cancels what is armed');
  probe.noteUnreachable();
  assert.equal(live().length, 0, 'and a stopped probe arms nothing again');
});

test('#110: probeReachable — any HTTP answer is a network, a thrown fetch is none', async () => {
  const seen: string[] = [];
  const answering = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(url)}`);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  assert.equal(await probeReachable('http://api.invalid', { fetchFn: answering }), true, 'a 404 is an answer');
  assert.deepEqual(seen, ['HEAD http://api.invalid'], 'one HEAD, no credential, no body');
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal(await probeReachable('http://api.invalid', { fetchFn: down }), false);
});
