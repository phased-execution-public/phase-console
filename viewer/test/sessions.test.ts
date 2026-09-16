/**
 * Durable sessions, and the off switch.
 *
 * Three things that were previously true only by inspection:
 *
 *  1. **What a session's end is worth telling you.** The registry raises six
 *     lifecycle events; exactly three shapes of one of them earn an
 *     interruption. The rest — including every session you closed yourself —
 *     must be silent, because a channel that fires for everything is a channel
 *     that gets muted.
 *  2. **That the `sessions` event carries enough to redraw a list.** The
 *     dashboard card and the nav badge are not holding the session's socket, so
 *     the event is the only thing that tells them.
 *  3. **How the process actually stops.** Under launchd `KeepAlive` an exit is
 *     a restart, so "stop" has to be spelled `launchctl bootout`. That decision
 *     is asserted against a fake spawner rather than by booting anything out of
 *     the machine running the tests; the unsupervised path is exercised for
 *     real, end to end, because there it is safe and it is the path that must
 *     leave nothing behind.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VIEWER_DIR, SKILL_DIR } from '../server/config.ts';
import { bootout, detectSupervisor, stopPlan, unload, type Supervisor } from '../server/lifecycle.ts';
import { Service } from '../server/service.ts';
import { handleApi } from '../server/api/routes.ts';
import { journalFile, newRun, phaseRecord, saveRun } from '../server/runner/state.ts';
import { defaultCategories, routeFor } from '../server/push/catalogue.ts';
import type { SessionEvent, SessionInfo } from '../server/terminal.ts';
import { sandbox, spawnConsole } from './spawn-console.ts';

/* ------------------------------------------------------------------ *
 * The announce policy
 * ------------------------------------------------------------------ */

function service(flags: Record<string, unknown> = {}): Service {
  const sv = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
    ...flags,
  } as never);
  // Belt and braces on the announce path. `state-sandbox.ts` now moves the push
  // register somewhere disposable, so this Service can no longer reach a real
  // device — but this file asserts on announcements by the hundred, and the one
  // failure mode worth two guards is the one that ends with a stranger's console
  // buzzing someone's phone. Every other leg is exercised for real.
  sv.push.announce = (() => {}) as typeof sv.push.announce;
  return sv;
}

/** A session record as the registry describes one, with the bits a case needs. */
function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'abc123', label: 'Claude 1', kind: 'claude', cwd: '/tmp', shell: 'claude',
    cols: 80, rows: 24, pid: 4242, clients: 0, createdAt: 1, lastOutputAt: 1,
    ...overrides,
  };
}

/**
 * Drive one lifecycle event through the service and report both legs: what went
 * out over SSE, and what reached the inbox.
 */
function fire(sv: Service, event: SessionEvent): { events: string[]; announced: string[] } {
  const events: string[] = [];
  const off = sv.onEvent((name) => { events.push(name); });
  // Diffed by id, never by count: the inbox is a real, persisted, bounded store
  // shared with whatever ran before, so "one more than there was" is not the
  // same question as "what did this announce".
  const before = new Set(sv.inbox({ limit: 500 }).items.map((r) => r.id));
  (sv as unknown as { onSessionEvent: (e: SessionEvent) => void }).onSessionEvent(event);
  off();
  const announced = sv.inbox({ limit: 500 }).items
    .filter((r) => !before.has(r.id))
    .map((r) => r.title);
  return { events, announced };
}

/**
 * The same, for the one exit whose answer is asynchronous.
 *
 * A recovery session's ending is not reported, it is *checked*: the service
 * re-reads the board before it says anything (`announceRecoveryOutcome`), so
 * the notification lands a tick after the event that caused it. Polling rather
 * than a fixed sleep, so this neither flakes nor waits for a timeout it does
 * not need.
 */
async function fireAsync(sv: Service, event: SessionEvent): Promise<{ events: string[]; announced: string[] }> {
  const events: string[] = [];
  const off = sv.onEvent((name) => { events.push(name); });
  const before = new Set(sv.inbox({ limit: 500 }).items.map((r) => r.id));
  (sv as unknown as { onSessionEvent: (e: SessionEvent) => void }).onSessionEvent(event);
  const fresh = () => sv.inbox({ limit: 500 }).items.filter((r) => !before.has(r.id));
  for (let tries = 0; tries < 100 && !fresh().length; tries++) {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  off();
  return { events, announced: fresh().map((r) => r.title) };
}

test('a session ending is announced when nobody saw it, when it failed, or when it was a repair', async () => {
  const sv = service();
  sv.savePreferences({ notify: defaultCategories() } as never);

  // ---- announced: it finished while you were not attached ----
  const quiet = fire(sv, {
    type: 'exited',
    session: session({ exited: { code: 0 }, exitedAt: 2 }),
    detached: true,
  });
  assert.deepEqual(quiet.announced, ['Agent session finished']);

  // ---- announced: it failed, even with a tab open on it ----
  const failed = fire(sv, {
    type: 'exited',
    session: session({ id: 'd2', label: 'Terminal 3', kind: 'shell', exited: { code: 127 }, exitedAt: 3 }),
    detached: false,
  });
  assert.deepEqual(failed.announced, ['Terminal failed']);

  // ---- announced: a recovery session, however it ended and whoever watched ----
  // And it says what it ACHIEVED, not that it ended. With no source directory
  // open there is no board to check it against, which is itself an honest
  // answer — never a claim that the repair worked.
  const repair = await fireAsync(sv, {
    type: 'exited',
    session: session({
      id: 'd3',
      exited: { code: 0 },
      exitedAt: 4,
      meta: { intent: 'recovery', recovery: { kind: 'halted-verification', slug: 'demo', phase: 3 } },
    }),
    detached: false,
  });
  assert.deepEqual(repair.announced, ['Still needs you · Recovery finished']);

  // ---- silent: a clean exit you were watching happen ----
  const watched = fire(sv, {
    type: 'exited',
    session: session({ id: 'd4', exited: { code: 0 }, exitedAt: 5 }),
    detached: false,
  });
  assert.deepEqual(watched.announced, [], 'you were looking at it — that is not news');

  // ---- silent: every other lifecycle moment ----
  for (const type of ['created', 'attached', 'detached', 'killed', 'dismissed'] as const) {
    const other = fire(sv, { type, session: session({ id: `x-${type}` }) });
    assert.deepEqual(other.announced, [], `${type} must not raise a notification`);
    assert.ok(other.events.includes('sessions'), `${type} must still reach the stream`);
  }
});

test('a session you closed yourself is never announced, even though its pty exits', () => {
  const sv = service();
  sv.savePreferences({ notify: defaultCategories() } as never);

  // This is the shape `kill()` produces — and the reason it reports `killed`
  // rather than `exited`. If the operator's own close arrived here as an exit,
  // every deliberate ✕ would buzz a phone.
  const closed = fire(sv, {
    type: 'killed',
    session: session({ exited: { code: 0, closedByOperator: true }, exitedAt: 9 }),
  });
  assert.deepEqual(closed.announced, []);
});

test('the session category obeys the global switch like every other', () => {
  const sv = service();
  sv.savePreferences({ notify: { ...defaultCategories(), session: false } } as never);
  const off = fire(sv, {
    type: 'exited',
    session: session({ exited: { code: 3 }, exitedAt: 2 }),
    detached: true,
  });
  assert.deepEqual(off.announced, [], 'switched off means no inbox record — the P1 gate covers this one too');
  assert.ok(off.events.includes('sessions'), 'the live stream is not a notification and is unaffected');
});

test('the sessions event carries the whole list, so a surface that has no socket can redraw', () => {
  const sv = service();
  const seen: unknown[] = [];
  sv.onEvent((name, data) => { if (name === 'sessions') seen.push(data); });
  (sv as unknown as { onSessionEvent: (e: SessionEvent) => void })
    .onSessionEvent({ type: 'created', session: session() });

  const payload = seen[0] as { type: string; session: SessionInfo; sessions: SessionInfo[]; live: number };
  assert.equal(payload.type, 'created');
  assert.equal(payload.session.id, 'abc123');
  assert.ok(Array.isArray(payload.sessions), 'the list rides along rather than forcing a refetch');
  assert.equal(typeof payload.live, 'number');
});

test('a session notification deep-links to the session, and degrades to its page', () => {
  assert.equal(routeFor('session', { sessionId: 'abc123', sessionKind: 'claude' }), '/#/agent/abc123');
  assert.equal(routeFor('session', { sessionId: 'abc123', sessionKind: 'shell' }), '/#/terminal/abc123');
  // The record may be long gone by the time a push is tapped; the page is a
  // real destination, `/#/agent/undefined` is not.
  assert.equal(routeFor('session'), '/#/terminal');
  assert.equal(routeFor('session', { sessionKind: 'claude' }), '/#/agent');
  assert.equal(routeFor('session', { sessionId: 'a/b?c', sessionKind: 'claude' }), '/#/agent/a%2Fb%3Fc');
});

/* ------------------------------------------------------------------ *
 * The inventory
 * ------------------------------------------------------------------ */

test('the inventory counts live processes by kind, and ended records separately', async () => {
  const sv = service({ allowTerminal: true, allowAgent: true });
  const ptys: { exit: (code: number) => void }[] = [];
  // The registry's own spawn seam — the same one `test/terminal.test.ts` uses,
  // so no native module is involved.
  (sv.terminals as unknown as { options: { spawn?: unknown } }).options.spawn = (() => {
    const pty = {
      pid: 1, exit: (_code: number) => {},
      onData() {}, onExit(fn: (e: { exitCode: number }) => void) { pty.exit = (code) => fn({ exitCode: code }); },
      write() {}, resize() {}, kill() {},
    };
    ptys.push(pty);
    return pty;
  }) as never;

  const shell = await sv.terminals.mint();
  await sv.terminals.mint(undefined, undefined, {
    kind: 'claude', file: 'claude', args: [], label: 'Claude 1',
  });
  assert.ok(shell.ok, 'the shell minted');

  const both = sv.sessionInventory();
  assert.deepEqual(
    { live: both.live, agent: both.agent, terminal: both.terminal, ended: both.ended },
    { live: 2, agent: 1, terminal: 1, ended: 0 },
  );
  assert.equal(both.sessions.length, 2);

  // One dies: it leaves the live count and the inventory of what a shutdown
  // would stop, but stays listed as an ended record.
  ptys[0].exit(0);
  const after = sv.sessionInventory();
  assert.deepEqual(
    { live: after.live, agent: after.agent, terminal: after.terminal, ended: after.ended },
    { live: 1, agent: 1, terminal: 0, ended: 1 },
  );
  assert.equal(after.sessions.length, 1, 'a dialog says what it will stop, not what already stopped');
  assert.equal(
    after.survives, false,
    'these ptys were made in THIS process by the injected spawn, so they do not survive it',
  );

  sv.terminals.close();
});

test('the restart dialog is told the sessions SURVIVE, because since Phase 7 they do', () => {
  // No injected spawn: exactly how a real console is built, so its ptys belong
  // to the broker. Restart used to kill every one of them and say nothing; a
  // dialog that now claimed to stop them would be the same lie with the sign
  // flipped, so the flag is read from the registry that owns them rather than
  // written into either dialog.
  const sv = service({ allowTerminal: true, allowAgent: true });
  assert.equal(sv.sessionInventory().survives, true);
  assert.equal(
    sv.restartReadiness().sessions.survives, true,
    'POST /api/restart must not report that it will kill terminal sessions when it will not',
  );
  sv.close();
});

/* ------------------------------------------------------------------ *
 * How the process stops
 * ------------------------------------------------------------------ */

const LAUNCHD: Supervisor = {
  supervised: true, kind: 'launchd', detail: 'launchd · com.example.console · KeepAlive is on',
};

test('SHD-2/SHD-5: under launchd, `exit` comes straight back and `unload` disables, boots out, marks and names its way back', () => {
  // `exit` — the default. KeepAlive is on, so an exit IS a comeback: the plan
  // says so and claims no durability it does not have.
  const exit = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501);
  assert.equal(exit.via, 'exit');
  assert.equal(exit.mode, 'exit');
  assert.equal(exit.durability, 'returns');
  assert.match(exit.detail, /comes straight back/);

  // `unload` — "stay off". The old Shut down was a bare `bootout` that promised
  // "it stays off" and came back at the next login with the plist on disk; the
  // plan now DISABLES first (launchd's override database, synchronously, before
  // the SIGTERM the bootout sends), boots out, and writes the marker a boot
  // honours.
  const unload = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501, 'unload');
  assert.ok(unload, 'a named launchd job can be unloaded');
  assert.equal(unload.via, 'launchctl');
  assert.equal(unload.file, 'launchctl');
  assert.deepEqual(unload.steps, [['disable', 'gui/501/com.example.console'], ['bootout', 'gui/501/com.example.console']]);
  assert.deepEqual(unload.args, ['bootout', 'gui/501/com.example.console'], '`bootout` on the service target — `stop` under KeepAlive is a restart');
  assert.equal(unload.marker, true);
  assert.equal(unload.durability, 'disabled');
  assert.match(unload.resurrect, /^launchctl enable gui\/\$\(id -u\)\/com\.example\.console && launchctl bootstrap gui\/\$\(id -u\) ~\/Library\/LaunchAgents\/com\.example\.console\.plist/);
  assert.match(unload.detail, /disabled/);
  assert.match(unload.detail, /a login does not bring it back/);

  // KeepAlive OFF: nothing brings an exit back now, and the next login does.
  const noKeepAlive = stopPlan(
    { supervised: false, kind: 'launchd', detail: 'launchd · com.example.console · KeepAlive is off' },
    { XPC_SERVICE_NAME: 'com.example.console' }, 501,
  );
  assert.equal(noKeepAlive.durability, 'until-login');
});

test('with nothing supervising, stopping is just exiting — and there is nothing to unload', () => {
  const plan = stopPlan(
    { supervised: false, kind: 'none', detail: 'nothing is supervising this process' },
    {}, 501,
  );
  assert.equal(plan.via, 'exit');
  assert.equal(plan.durability, 'stays-off', 'nothing starts it again');
  assert.equal(
    stopPlan({ supervised: false, kind: 'none', detail: '' }, {}, 501, 'unload'), null,
    '`exit` already stops it, so a "stay off" has nothing to unload',
  );

  // A launchd job whose label this process cannot read cannot be booted out by
  // name — exiting is the honest fallback, not a guessed label.
  assert.equal(stopPlan(LAUNCHD, {}, 501).via, 'exit');
  assert.equal(stopPlan(LAUNCHD, {}, 501, 'unload'), null);
  // A platform with no uid (Windows) cannot name a `gui/<uid>/…` target.
  assert.equal(stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, null).via, 'exit');
  assert.equal(stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, null, 'unload'), null);

  // A FOREIGN systemd unit — one that never stamped PHASE_CONSOLE_UNIT — is
  // supervision this process cannot name, so it cannot be stopped by name
  // either; it says so rather than pretending an exit is a stop.
  const systemd = stopPlan(
    { supervised: true, kind: 'systemd', detail: 'systemd started this unit', assumed: true },
    { INVOCATION_ID: 'x' }, 501,
  );
  assert.equal(systemd.via, 'exit');
  assert.match(systemd.detail, /may be brought back/);
  assert.equal(
    stopPlan({ supervised: true, kind: 'systemd', detail: '', assumed: true }, { INVOCATION_ID: 'x' }, 501, 'unload'),
    null,
  );
});

test('under systemd with a known unit, `unload` is disable --now and names enable --now; `exit` returns', () => {
  // The unit agent.sh writes stamps its own name (%n) into the environment —
  // the XPC_SERVICE_NAME of this platform. With the name known, Stop can mean
  // what the button says.
  const sup: Supervisor = { supervised: true, kind: 'systemd', detail: 'systemd · phase-console.service' };
  const env = { INVOCATION_ID: 'x', PHASE_CONSOLE_UNIT: 'phase-console.service' };
  const unload = stopPlan(sup, env, 501, 'unload');
  assert.ok(unload);
  assert.equal(unload.via, 'systemctl');
  // Both halves in one command: the unit stops (its SIGTERM ends the console)
  // and loses its login link.
  assert.deepEqual(unload.steps, [['--user', 'disable', '--now', 'phase-console.service']]);
  assert.equal(unload.resurrect.startsWith('systemctl --user enable --now phase-console.service'), true);
  assert.equal(unload.durability, 'disabled');
  const exit = stopPlan(sup, env, 501);
  assert.equal(exit.via, 'exit');
  assert.equal(exit.durability, 'returns');
});

test('a stamped unit file is read for Restart=, not assumed', () => {
  const config = mkdtempSync(join(tmpdir(), 'phase-console-unit-'));
  mkdirSync(join(config, 'systemd', 'user'), { recursive: true });
  const env = {
    INVOCATION_ID: 'x',
    PHASE_CONSOLE_UNIT: 'phase-console.service',
    XDG_CONFIG_HOME: config,
  };
  const unit = join(config, 'systemd', 'user', 'phase-console.service');

  writeFileSync(unit, '[Service]\nExecStart=/usr/bin/node index.js\nRestart=always\n');
  const supervised = detectSupervisor(env, 'linux');
  assert.deepEqual(
    { supervised: supervised.supervised, kind: supervised.kind, assumed: supervised.assumed ?? false },
    { supervised: true, kind: 'systemd', assumed: false },
    'Restart=always is read, so the button is offered on evidence',
  );

  // `on-failure` never re-runs a clean exit — the Restart button would be a
  // stop button wearing the wrong label.
  writeFileSync(unit, '[Service]\nRestart=on-failure\n');
  assert.equal(detectSupervisor(env, 'linux').supervised, false);

  // No unit file to read: supervision is assumed, and marked as assumed.
  const foreign = detectSupervisor({ INVOCATION_ID: 'x', PHASE_CONSOLE_UNIT: 'other.service', XDG_CONFIG_HOME: config }, 'linux');
  assert.deepEqual({ supervised: foreign.supervised, assumed: foreign.assumed }, { supervised: true, assumed: true });
});

test('bootout spawns detached, and a spawn that throws does not take the shutdown with it', () => {
  const calls: { file: string; args: string[]; options: unknown }[] = [];
  const plan = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501, 'unload')!;

  const ok = bootout(plan, (file, args, options) => {
    calls.push({ file, args, options });
    return { unref() {} };
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'launchctl');
  assert.deepEqual(calls[0].args, ['bootout', 'gui/501/com.example.console']);
  // Detached with no stdio: the command outlives this process on purpose — it
  // is the thing that ends it.
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore' });

  assert.equal(bootout(plan, () => { throw new Error('launchctl: not found'); }), false,
    'a missing launchctl is a false, so the caller falls through to exiting');
  assert.equal(bootout({ via: 'exit', mode: 'exit', durability: 'stays-off', detail: '' }, () => { throw new Error('must not spawn'); }), false);
});

test('SHD-5: `unload` disables SYNCHRONOUSLY before handing over the stop, and a failed disable is said — the stop still goes', () => {
  const order: string[] = [];
  const plan = stopPlan(LAUNCHD, { XPC_SERVICE_NAME: 'com.example.console' }, 501, 'unload')!;
  const carried = unload(
    plan,
    (file, args) => { order.push(`spawn ${file} ${args.join(' ')}`); return { unref() {} }; },
    (file, args) => { order.push(`run ${file} ${args.join(' ')}`); return { status: 0 }; },
  );
  assert.deepEqual(order, [
    'run launchctl disable gui/501/com.example.console',
    'spawn launchctl bootout gui/501/com.example.console',
  ], 'the disable lands before the bootout whose SIGTERM ends this process');
  assert.deepEqual(carried, { disabled: true, spawned: true });

  const failed = unload(plan, () => ({ unref() {} }), () => ({ status: 1 }));
  assert.deepEqual(failed, { disabled: false, spawned: true }, 'the marker is then the only thing holding the boot — and the log says so');

  // systemd's single `disable --now` has nothing to run ahead of it.
  const sd = stopPlan(
    { supervised: true, kind: 'systemd', detail: '' },
    { INVOCATION_ID: 'x', PHASE_CONSOLE_UNIT: 'phase-console.service' }, 501, 'unload',
  )!;
  const sdCalls: string[] = [];
  unload(sd, (file, args) => { sdCalls.push(`spawn ${file} ${args.join(' ')}`); return { unref() {} }; }, () => {
    sdCalls.push('run');
    return { status: 0 };
  });
  assert.deepEqual(sdCalls, ['spawn systemctl --user disable --now phase-console.service']);
});

/* ------------------------------------------------------------------ *
 * The refusals, in process (SHD-1, SHD-2)
 * ------------------------------------------------------------------ */

/** Set env keys for one case and put them back — `supervisor()` reads the process environment. */
async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const was: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    was[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const REFUSAL_PLAN = `---
slug: demo
created: 2026-09-15
status: active
phases: 2
---

# demo

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | demo | it works |
| 2 | second | 1 | — | demo | it still works |

## Phases

### Phase 1 — first
- **Size:** S

### Phase 2 — second
- **Size:** S
`;

/** A run parked on a declared wait whose clock is two hours ahead — the 09-12 lane, in miniature. */
function parkedRun(root: string): { id: string; until: string } {
  const state = newRun({ slug: 'demo', root });
  const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  state.status = 'paused';
  state.stoppedBy = 'system';
  state.waitReason = 'external';
  state.waitUntil = until;
  const record = phaseRecord(state, 1);
  record.status = 'waiting';
  record.parkedUntil = until;
  record.sessionId = 's-parked';
  record.resumeSessionId = 's-parked';
  record.declared = { status: 'waiting-external', reason: 'the image build', watch: ['date:2030-01-01T00:00:00Z'], at: new Date().toISOString() };
  saveRun(state);
  return { id: state.id, until };
}

async function callApi(
  sv: Service, method: string, path: string, body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = { text }; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: { host: '127.0.0.1:4123', 'content-type': 'application/json', 'x-phase-console': '1' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (raw) yield Buffer.from(raw); },
  };
  await handleApi({ service: sv } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return { status, payload };
}

test('ACC-6.1 (SHD-1, SHD-2): readiness names the armed clock; a bare {confirm:true} is refused naming it; unload needs acknowledge; an unknown mode is a 400', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-shutdown-refusal-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), REFUSAL_PLAN, 'utf8');
  const parked = parkedRun(root);
  // A systemd unit this process can name, so `unload` has a plan — without
  // touching launchd (no label) whatever the machine running the suite is.
  await withEnv({ XPC_SERVICE_NAME: '0', PHASE_CONSOLE_SUPERVISED: undefined, INVOCATION_ID: 'test-invocation', PHASE_CONSOLE_UNIT: 'phase-console-test.service' }, async () => {
    const sv = service({ allowRun: true, allowWrites: true, converge: false });
    try {
      assert.equal(sv.open(root).ok, true);
      await sv.bootSettled;

      // The inventory is WORK: the run's wait clock re-armed at boot, and the run
      // on disk the next boot picks up — not pty terminals and a handler count.
      const readiness = sv.shutdownReadiness();
      assert.equal(readiness.empty, false);
      const clock = readiness.inventory.clocks.find((c) => c.source === 'wait-resume' && c.slug === 'demo');
      assert.ok(clock, `the armed resume is named: ${JSON.stringify(readiness.inventory.clocks)}`);
      assert.equal(Date.parse(clock.at), Date.parse(parked.until));
      assert.deepEqual(readiness.soonestClock?.source, 'wait-resume');
      const run = readiness.inventory.runs.find((r) => r.id === parked.id);
      assert.ok(run, 'the parked run is on the inventory');
      assert.equal(run.live, false);
      assert.equal(run.waitUntil, parked.until);
      assert.equal(readiness.modes.exit.durability, 'returns');
      assert.ok(readiness.modes.unload, 'a named unit can be unloaded');
      assert.match(String(readiness.unloadHint), /systemctl --user enable --now phase-console-test\.service/);

      // GET /api/shutdown returns the same inventory.
      const got = await callApi(sv, 'GET', '/api/shutdown');
      assert.equal(got.status, 200);
      assert.ok((got.payload.inventory as { clocks: unknown[] }).clocks.length >= 1);

      // A bare confirm over that inventory: refused, NAMING the clock.
      const bare = await callApi(sv, 'POST', '/api/shutdown', { confirm: true });
      assert.equal(bare.status, 409, JSON.stringify(bare.payload));
      assert.equal(bare.payload.ok, false);
      assert.equal(bare.payload.needs, 'acknowledge');
      assert.match(String(bare.payload.reason), /wait-resume clock for demo due/);
      assert.match(String(bare.payload.reason), /acknowledge/);
      assert.ok(bare.payload.inventory, 'the refusal carries the inventory it is about');

      // Stay off, unacknowledged: refused, naming its way back.
      const unloadBare = await callApi(sv, 'POST', '/api/shutdown', { confirm: true, mode: 'unload' });
      assert.equal(unloadBare.status, 409);
      assert.equal(unloadBare.payload.needs, 'acknowledge');
      assert.match(String(unloadBare.payload.reason), /stay off/);
      assert.match(String(unloadBare.payload.reason), /systemctl --user enable --now/);

      const bogus = await callApi(sv, 'POST', '/api/shutdown', { confirm: true, mode: 'halt', acknowledge: true });
      assert.equal(bogus.status, 400);
      assert.equal(bogus.payload.needs, 'mode');
    } finally { sv.close(); }
  });
  // With nothing supervising there is nothing to unload — even acknowledged.
  await withEnv({ XPC_SERVICE_NAME: '0', PHASE_CONSOLE_SUPERVISED: '0', INVOCATION_ID: undefined, PHASE_CONSOLE_UNIT: undefined }, () => {
    const sv = service({});
    try {
      const refused = sv.shutdown('a test', { mode: 'unload', acknowledge: true });
      assert.equal(refused.ok, false);
      assert.equal(refused.needs, 'unload');
      assert.match(String(refused.reason), /nothing supervises this console/);
    } finally { sv.close(); }
  });
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The endpoint, against a real console
 * ------------------------------------------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

function http(
  port: number, path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({
      host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    call.on('error', reject);
    call.end(opts.body);
  });
}

async function waitFor(port: number, tries = 120): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { if ((await http(port, '/api/state')).status === 200) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const CONSOLE_HEADERS = { 'x-phase-console': '1', 'content-type': 'application/json' };

test('POST /api/shutdown stops an unsupervised console, and refuses to do it by accident', async () => {
  const port = await freePort();
  const box = sandbox('shutdown');
  // A plan with a run parked on a declared wait two hours out, on disk where the
  // spawned console reads it: the test process's own (sandboxed) state home is
  // handed to the child, so `saveRun` here is the console's run file there.
  const parked = parkedRun(box.root);
  const logFile = join(box.stateHome, 'console-under-test.log');
  const { child } = spawnConsole(VIEWER_DIR, port, ['--allow-terminal', '--allow-run', '--no-converge', '--log-file', logFile], {
    sandbox: box,
    withRoot: true,
    // Nothing supervising: the graceful path, and the one that is safe to run
    // for real on the machine running the tests.
    env: { PHASE_CONSOLE_SUPERVISED: '0', XPC_SERVICE_NAME: '', XDG_STATE_HOME: process.env.XDG_STATE_HOME },
    // Piped, because what the console WRITES about the shutdown is under test
    // too: `shutdown.requested` mirrors to stderr, and its actor is the point.
    stdio: 'pipe',
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  child.stdout?.on('data', () => {});
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  try {
    if (!await waitFor(port)) assert.fail('the console did not come up');

    // The readiness read is what the confirm dialog renders — an inventory of
    // WORK (SHD-1). The boot re-armed the parked run's resume, so the clock the
    // exit would discard is named with its moment, and the run is listed.
    let readiness: Record<string, any> = {};
    for (let i = 0; i < 60; i++) {
      readiness = JSON.parse((await http(port, '/api/shutdown')).body);
      if (readiness.inventory?.clocks?.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(readiness.stop.via, 'exit');
    assert.equal(readiness.stop.durability, 'stays-off');
    assert.equal(readiness.modes.unload, null, 'nothing supervises it, so there is nothing to unload');
    assert.equal(readiness.sessions.live, 0);
    assert.ok('busy' in readiness && 'run' in readiness);
    assert.match(String(readiness.restartHint), /start it again/);
    assert.equal(readiness.empty, false);
    const clock = readiness.inventory.clocks.find((c: { source: string }) => c.source === 'wait-resume');
    assert.ok(clock, `readiness names the armed clock: ${JSON.stringify(readiness.inventory)}`);
    assert.equal(Date.parse(clock.at), Date.parse(parked.until));
    assert.ok(readiness.inventory.runs.some((run: { id: string }) => run.id === parked.id));

    // Same-origin + console header, like every other mutation.
    assert.equal((await http(port, '/api/shutdown', { method: 'POST', body: '{"confirm":true}' })).status, 403);
    assert.equal((await http(port, '/api/shutdown', {
      method: 'POST', headers: { ...CONSOLE_HEADERS, origin: 'https://evil.example' }, body: '{"confirm":true}',
    })).status, 403);

    // A bare POST — a stray curl, a replayed request — must not end a console.
    const bare = await http(port, '/api/shutdown', { method: 'POST', headers: CONSOLE_HEADERS, body: '{}' });
    assert.equal(bare.status, 400);
    assert.match(bare.body, /confirm/);

    // …and neither may a confirm that has not seen what it stops (SHD-1): the
    // 09-12 press went through over a lane 36.8 minutes from its resume.
    const unseen = await http(port, '/api/shutdown', {
      method: 'POST', headers: CONSOLE_HEADERS, body: '{"confirm":true,"by":"a test"}',
    });
    assert.equal(unseen.status, 409, unseen.body);
    assert.match(JSON.parse(unseen.body).reason, /wait-resume clock for demo due/);
    assert.ok(await waitFor(port, 10), 'and it is still serving');

    const done = await http(port, '/api/shutdown', {
      method: 'POST', headers: CONSOLE_HEADERS, body: '{"confirm":true,"acknowledge":true,"by":"a test"}',
    });
    assert.equal(done.status, 200, done.body);
    assert.equal(JSON.parse(done.body).ok, true);

    // The response reaches the browser BEFORE the socket it arrived on closes —
    // that is what the 250ms delay in `onShutdownRequest` buys — and then the
    // process actually goes, cleanly, after its drain.
    const code = await Promise.race([
      exited,
      // `.unref()`, or the losing timer holds the test runner open for its full
      // 20 seconds after the console has already gone.
      new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), 20_000).unref(); }),
    ]);
    assert.equal(code, 0, 'an unsupervised shutdown exits 0 after the drain');

    // SHD-3: the record names WHO — the body's label — and the transport it
    // arrived by, derived from the request rather than supplied: `api` from
    // `local` (a loopback Host), no proxy user, and how the stop is carried
    // out beside it. Exactly one such line: the SIGTERM the drain sends
    // itself must not be written a second time as an unattributed signal.
    const requested = stderr.split('\n').filter((line) => line.includes('shutdown.requested'));
    assert.equal(requested.length, 1, `one shutdown.requested line: ${requested.join(' | ')}`);
    const payload = JSON.parse(requested[0].slice(requested[0].indexOf('{'))) as Record<string, any>;
    assert.equal(payload.by, 'a test');
    assert.equal(payload.via, 'api');
    assert.equal(payload.origin, 'local');
    assert.equal(payload.remoteUser, null);
    assert.equal(payload.stop, 'exit');
    // …and what it chose, what that achieves, and what it acknowledged (SHD-1, SHD-5).
    assert.equal(payload.mode, 'exit');
    assert.equal(payload.durability, 'stays-off');
    assert.equal(payload.acknowledged, true);
    assert.equal(payload.inventory.soonestClock.source, 'wait-resume');

    // SHD-8: the parked plan learns from its OWN journal that the console went
    // away, and which clock went with it — no runner was driving it.
    const journal = readFileSync(journalFile(box.root, 'demo', parked.id), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event: string; data: Record<string, any> });
    const abandoned = journal.find((line) => line.event === 'run.console-shutdown');
    assert.ok(abandoned, `run.console-shutdown on the parked run: ${journal.map((l) => l.event).join(', ')}`);
    assert.equal(abandoned.data.intent, 'shutdown');
    assert.match(String(abandoned.data.reason), /^shutdown \(a test via api from local\)/);
    assert.equal(abandoned.data.live, false);
    assert.equal(abandoned.data.clock?.source, 'wait-resume');
    assert.match(String(abandoned.data.discards), /wait-resume clock due/);

    // …and the exit record names the intent beside the reason (SHD-8).
    assert.ok(existsSync(logFile), 'the console wrote its log');
    const entries = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; data?: Record<string, any> });
    const exit = entries.filter((entry) => entry.event === 'exit').at(-1);
    assert.ok(exit, 'an exit record');
    assert.equal(exit.data?.intent, 'shutdown');
    assert.match(String(exit.data?.reason), /^shutdown \(a test via api from local\)/);
    const begin = entries.find((entry) => entry.event === 'shutdown.begin');
    assert.equal(begin?.data?.intent, 'shutdown');
    assert.equal(begin?.data?.via, 'exit');
    const announced = entries.find((entry) => entry.event === 'shutdown.announced');
    assert.ok(announced, 'the drain waited on the shutdown announcement');
    assert.ok((announced.data?.delivery as string[]).length > 0, 'and it left with a delivery, never []');
  } finally {
    child.kill('SIGKILL');
    box.cleanup();
  }
});
