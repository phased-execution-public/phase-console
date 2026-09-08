/**
 * Booting over a poisoned session inbox (D24).
 *
 * `SessionRegistry.load()` reads the records on disk AND whatever the hook
 * dropped in the inbox while no console was up, then prunes — and every one of
 * those moves calls back into `Service.onPresenceChange`. That callback runs
 * while the right-hand side of
 *
 *     this.sessions = new SessionRegistry({ … }).load().start();
 *
 * is still evaluating, so at that instant `this.sessions` is `undefined`, and
 * so are `this.scheduler` and `this.converger`, which are assigned further down
 * the same constructor. Production paid for it three times: hard Node crashes
 * with `TypeError: Cannot read properties of undefined (reading 'presence')`,
 * `uptimeSeconds: 0`, no shutdown path — under launchd `KeepAlive`, which
 * restarts and so makes a crash-loop look like a console that is merely slow.
 * Twelve more were survivable only because `ingestInbox` happens to wrap its
 * callback in a try/catch, which turned the event into a
 * `sessions.inbox-apply-failed` warning and threw the event away.
 *
 * Both halves are asserted here, because a fix that only stops the throw would
 * still be losing the event: the console must boot, AND the ended session must
 * be applied once the object exists.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR, SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';

const SESSIONS_DIR = join(INSTANCE_STATE_DIR, 'sessions');
const INBOX_DIR = join(SESSIONS_DIR, 'inbox');

function service(): Service {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  // This suite constructs real services; the announce leg must not reach a real
  // device even though `state-sandbox.ts` has already moved the register.
  sv.push.announce = (() => {}) as typeof sv.push.announce;
  return sv;
}

/** A record file as the registry persists one. */
function writeRecord(sessionId: string, record: Record<string, unknown>): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify({
    sessionId, cwd: '/tmp/poisoned', kind: 'claude', turns: 0, ...record,
  }));
}

/** A drop as the user-scope hook leaves one when no console is listening. */
function writeDrop(name: string, payload: Record<string, unknown>): void {
  mkdirSync(INBOX_DIR, { recursive: true });
  writeFileSync(join(INBOX_DIR, name), JSON.stringify(payload));
}

test('the console boots over a session inbox that fires presence callbacks mid-construction', async () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const WEEK = 7 * 24 * 60 * 60_000;

  // (1) A record nobody has reported for over a week. `load()` prunes it and
  //     announces the prune — the UNGUARDED callback, the one that produced
  //     the three hard crashes.
  writeRecord('d24-stale-record', { startedAt: iso(9 * 24 * 60 * 60_000), lastSeen: iso(WEEK + 60_000) });

  // (2) A `*-SessionEnd.json` drop, which is the shape the twelve non-fatal
  //     `sessions.inbox-apply-failed` warnings all carried. Recent, so it
  //     survives the prune and there is something left to observe.
  writeDrop('d24-ended-SessionEnd.json', {
    session_id: 'd24-ended', event: 'SessionEnd', cwd: '/tmp/poisoned', at: iso(60_000),
  });

  const seen: { event: string; data: unknown }[] = [];
  let sv: Service;
  // The boot itself. Pre-fix this line throws and the process dies with it.
  assert.doesNotThrow(() => { sv = service(); }, 'a poisoned inbox must not take the boot down');
  const off = sv!.onEvent((event, data) => { seen.push({ event, data }); });

  // Construction is over when the stack unwinds, so the backlog drains on the
  // first microtask — before any timer, and without the test having to guess a
  // delay. A listener attached synchronously above is therefore in time.
  await Promise.resolve();

  const presence = seen.filter((e) => e.event === 'sessions')
    .map((e) => e.data as { type?: string; presence?: { sessionId?: string; presence?: string } })
    .filter((d) => d.type === 'presence');
  assert.ok(
    presence.some((d) => d.presence?.sessionId === 'd24-ended' && d.presence?.presence === 'ended'),
    'the SessionEnd from the inbox must be APPLIED after boot, not swallowed by a construction-time throw',
  );
  assert.ok(
    presence.some((d) => d.presence?.sessionId === 'd24-stale-record'),
    'the prune raised during load must reach the browser too',
  );

  off();
  sv!.close();
});

test('a presence callback raised after boot still applies directly', async () => {
  const sv = service();
  await Promise.resolve(); // the backlog (empty here) drains; the gate opens

  const seen: unknown[] = [];
  const off = sv.onEvent((event, data) => { if (event === 'sessions') seen.push(data); });
  sv.sessions.ingest({
    session_id: 'd24-after-boot', event: 'SessionStart', cwd: '/tmp/after-boot',
  } as never);
  off();

  // No microtask: once construction is over the callback is not parked at all,
  // or every presence move on a running console would be a tick late.
  assert.equal(seen.length, 1, 'after boot a presence move is applied synchronously, not queued');
  sv.close();
});
