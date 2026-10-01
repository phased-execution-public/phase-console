/**
 * A probe is not a session (control-tower phase 49, #73).
 *
 * The console's MCP health probe is a one-turn `claude -p` spawned every five
 * minutes. Its presence hook registered it like any session, so in one week on
 * one console it was 614 of 639 registry files, and 92 % of every "stuck"
 * warning named one: an ended probe whose pid the kernel had since handed to
 * some other process read `unknown` (the pid answered `kill(0)`), and
 * `unknown` was enough to be called stuck.
 *
 *   PS-1 — the probe spawns with `PE_SESSION_KIND=probe`, and nothing is
 *          registered for it (the hook's half is `session-hook.bats`);
 *   PS-2 — an ended record stays ended unless (pid, process start time) still
 *          match;
 *   PS-3 — a stuck verdict needs a live, unended record;
 *   PS-4 — the probe backs off while nothing consumes its answer.
 *   PS-5 — the probe has its own event and its own budget, and never spends
 *          the console's work-start ceiling (control-tower phase 100, #73's
 *          "must not share the automatic-start ledger with work sessions").
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeEnv } from '../server/accounts/entitlement-probe.ts';
import { probeMcp, PROBE_OWNER, PROBE_SESSION_KIND, SESSION_KIND_ENV } from '../server/mcp/health.ts';
import { HEALTH_IDLE_MAX_MS, HEALTH_TTL_MS, Mcp } from '../server/mcp/index.ts';
import { warmPids } from '../server/pid.ts';
import { IDENTITY_FRESH_MS, presenceOf, SessionRegistry, type SessionRecord } from '../server/sessions/registry.ts';

const T0 = Date.parse('2026-09-23T09:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const MIN = 60_000;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-probe-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ended(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: 'p-1', kind: 'agent', cwd: '/w', startedAt: iso(T0), lastSeen: iso(T0 + 3_000), turns: 0,
    endedAt: iso(T0 + 3_000), pid: 66072, ...over,
  };
}

/* ---------------- PS-1 ---------------- */

test('PS-1: the MCP probe and the entitlement probe spawn with PE_SESSION_KIND=probe', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const spawnFn = ((_file: string, _argv: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.push(opts.env);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 1));
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  await probeMcp({ mcpServers: { a: { type: 'http', url: 'https://e.example/mcp' } } }, { spawnFn, env: { PATH: '/bin' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][SESSION_KIND_ENV], PROBE_SESSION_KIND);
  assert.equal(SESSION_KIND_ENV, 'PE_SESSION_KIND', 'the name session-hook.sh reads');
  assert.equal(PROBE_SESSION_KIND, 'probe');
  assert.equal(seen[0].PE_OWNER, PROBE_OWNER, 'it still names its owner, for the locks and the ceiling');

  const env = probeEnv(null, { PATH: '/bin', PE_SESSION_KIND: 'agent' });
  assert.equal(env[SESSION_KIND_ENV], PROBE_SESSION_KIND, 'the entitlement probe is a probe too, whatever the console carried');
});

test('PS-1: a probe payload from an older hook registers nothing, and a legacy probe record is pruned at load', () => {
  const { dir, cleanup } = scratch();
  try {
    // What a console before the rule left behind: a flagged record on disk.
    writeFileSync(join(dir, 'old-probe.json'), JSON.stringify({
      sessionId: 'old-probe', kind: 'agent', probe: true, owner: 'console/mcp-probe', cwd: '/w',
      startedAt: iso(T0), lastSeen: iso(T0), endedAt: iso(T0 + 3_000), turns: 0,
    }));
    const changes: string[] = [];
    const reg = new SessionRegistry({
      dir, now: () => new Date(T0 + 10_000), pidAlive: null, onChange: (r, e) => changes.push(`${e}:${r.sessionId}`),
    }).load();
    assert.equal(reg.get('old-probe'), undefined, 'the legacy probe record is gone');
    assert.equal(existsSync(join(dir, 'old-probe.json')), false, 'and so is its file');

    for (const event of ['SessionStart', 'Stop', 'SessionEnd'] as const) {
      reg.ingest({ session_id: 'new-probe', event, cwd: '/w', owner: 'console/mcp-probe', probe: true, pid: 5, at: iso(T0 + 10_000) });
    }
    assert.equal(reg.get('new-probe'), undefined);
    assert.equal(existsSync(join(dir, 'new-probe.json')), false);
    assert.deepEqual(changes, ['prune:old-probe'], 'the prune is the only change: a probe ingests nothing');
    reg.close();
  } finally { cleanup(); }
});

/* ---------------- PS-2 ---------------- */

test('PS-2: an ended record stays ended unless (pid, process start time) still match', () => {
  const now = T0 + 199 * MIN;
  // The measured case: ended at SessionEnd, its pid now a `ugrep`. With no
  // start time recorded there is nothing to match, so the hook's end stands —
  // `kill(0)` answering is not the session coming back.
  assert.equal(presenceOf(ended(), now, () => true), 'ended');
  assert.equal(presenceOf(ended(), now, () => 'running'), 'ended');

  const started = iso(T0 - 1_000);
  const sameProcess = (_pid: number, startedAt?: string) => startedAt === started;
  // The same process still runs — `/clear` fired SessionEnd in front of the
  // operator (PRS-1): the witnesses disagree, and unknown releases nothing.
  assert.equal(presenceOf(ended({ procStartedAt: started }), now, sameProcess), 'unknown');
  // A stranger holds the pid: its start time is not the one recorded.
  assert.equal(presenceOf(ended({ procStartedAt: iso(T0 + 3 * 3_600_000) }), now, sameProcess), 'ended');
  // Nobody to ask, or a probe that threw: the end stands, as before.
  assert.equal(presenceOf(ended({ procStartedAt: started }), now), 'ended');
  assert.equal(presenceOf(ended({ procStartedAt: started }), now, () => { throw new Error('ps'); }), 'ended');
});

test('PS-2: the registry records the start time from a fresh event only, and a new pid takes the old identity away', () => {
  const { dir, cleanup } = scratch();
  try {
    let now = T0;
    const asked: number[] = [];
    const starts: Record<number, number> = { 7: T0 - 60_000, 8: T0 - 5_000, 9: T0 - 1_000 };
    const reg = new SessionRegistry({
      dir, now: () => new Date(now), pidAlive: () => true,
      procStart: (pid) => { asked.push(pid); return starts[pid] ?? null; },
    }).load();

    reg.ingest({ session_id: 's', event: 'SessionStart', cwd: '/w', pid: 7, at: iso(now) });
    assert.equal(reg.get('s')?.procStartedAt, iso(starts[7]), 'a fresh event names its process');

    // A `--resume` in a new process: the identity follows the pid.
    now += 30_000;
    reg.ingest({ session_id: 's', event: 'Stop', cwd: '/w', pid: 8, at: iso(now) });
    assert.equal(reg.get('s')?.procStartedAt, iso(starts[8]));

    // An inbox drop drained long after the fact may name a pid the kernel has
    // handed on: its start time is never read for it.
    now += 3_600_000;
    reg.ingest({ session_id: 'late', event: 'SessionStart', cwd: '/w', pid: 9, at: iso(now - IDENTITY_FRESH_MS - 1_000) }, 'inbox');
    assert.equal(reg.get('late')?.procStartedAt, undefined);
    assert.deepEqual(asked, [7, 8], 'the late event never asked');
    reg.close();
  } finally { cleanup(); }
});

test('PS-2: end to end on a real process — the same process after SessionEnd is unknown, a recycled pid is ended', async () => {
  const { dir, cleanup } = scratch();
  try {
    const reg = new SessionRegistry({ dir }).load();
    await warmPids([process.pid]);
    reg.ingest({ session_id: 'me', event: 'SessionStart', cwd: dir, pid: process.pid, at: new Date().toISOString() });
    const record = reg.get('me')!;
    assert.ok(record.procStartedAt, 'the kernel\'s start time for this very process was recorded');
    reg.ingest({ session_id: 'me', event: 'SessionEnd', cwd: dir, pid: process.pid, reason: 'clear', at: new Date().toISOString() });
    assert.equal(reg.presence('me'), 'unknown', 'the process that ended the session is still here — PRS-1');
    // What a recycled pid looks like from here: the process holding the pid
    // started at another time than the one recorded.
    const now = reg.get('me')!;   // every event replaces the record object
    now.procStartedAt = iso(Date.parse(now.procStartedAt!) - 3_600_000);
    assert.equal(reg.presence('me'), 'ended');
    reg.close();
  } finally { cleanup(); }
});

/* ---------------- PS-3 ---------------- */


/* ---------------- PS-4 ---------------- */

function clocked(id: string) {
  let clock = T0;
  const probes: number[] = [];
  const mcp = new Mcp({
    exec: async () => ({ stdout: '' }),
    platform: 'darwin',
    now: () => clock,
    probeFn: async () => {
      probes.push((clock - T0) / MIN);
      return { servers: [{ id, status: 'connected', tools: [] }], checkedAt: iso(clock) };
    },
  });
  return { mcp, probes, at: (min: number) => { clock = T0 + min * MIN; } };
}

test('PS-4: with nobody reading, the health clock backs off — the wait doubles per unread probe, to an hour', async () => {
  assert.equal(HEALTH_TTL_MS, 5 * MIN);
  assert.equal(HEALTH_IDLE_MAX_MS, 60 * MIN);
  const { mcp, probes, at } = clocked('idle');
  at(0);
  await mcp.add({ label: 'idle', id: 'idle', transport: 'http', url: 'https://mcp.example/idle' });
  probes.length = 0;
  for (let min = 0; min <= 360; min += 5) { at(min); await mcp.refresh(); }
  assert.deepEqual(probes, [0, 5, 15, 35, 75, 135, 195, 255, 315], '9 probes in six unread hours, not 73');
});

test('PS-4: a reader puts the clock back to its pace; a boarding and a forced refresh are never held', async () => {
  const { mcp, probes, at } = clocked('read');
  at(0);
  await mcp.add({ label: 'read', id: 'read', transport: 'http', url: 'https://mcp.example/read' });
  probes.length = 0;
  for (let min = 0; min <= 140; min += 5) { at(min); await mcp.refresh(); }
  assert.deepEqual(probes, [0, 5, 15, 35, 75, 135]);

  // Inside the hour's wait the clock declines…
  at(150);
  assert.deepEqual(await mcp.refresh(), { probed: false });
  // …but a boarding reads the answer and gets a fresh one,
  const board = await mcp.preflight(['read']);
  assert.equal(board.probes, 1);
  // and an operator's Refresh is never held either.
  at(152);
  assert.deepEqual(await mcp.refresh({ force: true }), { probed: true });
  assert.deepEqual(probes, [0, 5, 15, 35, 75, 135, 150, 152]);

  // Somebody reads: the next probe comes at the TTL again.
  probes.length = 0;
  at(160);
  mcp.consumed();
  for (let min = 160; min <= 200; min += 5) { at(min); await mcp.refresh(); }
  assert.deepEqual(probes, [160, 165, 175, 195], 'at the TTL once read, then backing off again while unread');
});

/* ---------------- PS-5 (control-tower phase 100) ---------------- */

test('PS-5: the MCP probe spends its own budget and names its own event — never the work-start ceiling (#73)', async () => {
  const { readFileSync, mkdirSync } = await import('node:fs');
  const { SKILL_DIR } = await import('../server/config.ts');
  const { Service } = await import('../server/service.ts');
  const { doorActor } = await import('../server/actor.ts');
  const { PROBE_STARTS_PER_HOUR } = await import('../server/start-ceiling.ts');
  const { dir, cleanup } = scratch();
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  try {
    assert.equal(svc.open(dir).ok, true);
    type Gate = { admit(actor: unknown): { ok: boolean; starts?: number }; charge(actor: unknown): void };
    const probeGate = (svc as unknown as { mcp: { opts: { ceiling: Gate } } }).mcp.opts.ceiling;
    const work = (svc as unknown as { startCeiling: Gate }).startCeiling;
    const probe = doorActor('mcp-health-probe', { by: 'console', via: 'timer', origin: 'mcp' });
    const relaunch = doorActor('converge-relaunch', { by: 'console', via: 'timer', origin: 'converge' });

    // The console may have probed once already at its own boot — its own budget, counted from there.
    const already = probeGate.admit(probe).starts ?? 0;
    for (let i = already; i < PROBE_STARTS_PER_HOUR; i++) {
      assert.equal(probeGate.admit(probe).ok, true, `probe ${i + 1} is inside its own budget`);
      probeGate.charge(probe);
    }
    assert.equal(probeGate.admit(probe).ok, false, 'past its own budget the probe is refused — the cache goes stale, nothing else');
    const verdict = work.admit(relaunch);
    assert.equal(verdict.ok, true, 'the work-start ceiling never saw a probe');
    assert.equal(verdict.starts, 0);
  } finally {
    svc.close();
    cleanup();
  }
  const source = readFileSync(new URL('../server/mcp/index.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('private async runProbe('), source.indexOf('this.lastProbe ='));
  assert.match(body, /log\.info\('mcp\.probe\.start'/, 'its own event');
  assert.doesNotMatch(body, /'session\.start'/, 'not a session start: a probe is not a session');
});
