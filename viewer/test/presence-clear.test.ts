/**
 * A `/clear` ends the session it replaced, and a released lock's scope never
 * lingers on a record (control-tower phase 108, #172).
 *
 * Measured on hub 4123 on 2026-09-28 at 20:28Z: two queue entries each named
 * four session holders, three of them ONE interactive terminal (pid 87367)
 * that had run `/clear` twice after finishing its phase. Each `/clear` fires
 * `SessionEnd reason: clear` for the old id and a `SessionStart` for a new id
 * in the SAME process — and the registry answers an ended record whose process
 * still runs `unknown` (PRS-1), so the replaced ids kept matching a live pid
 * and kept holding the queue. The oldest still carried the scope of a phase
 * lock it had already released.
 *
 *  - PC-1 the registry: a SessionStart for a new id in the pid an ended (or
 *    silent) record names ends that record at once — `supersededBy`, presence
 *    `ended`, the end announced, the raw log saying what replaced it — and a
 *    resume back to the old id in the same process revives it;
 *  - PC-2 PRS-1 kept: a lone `SessionEnd reason: clear` is still `unknown`, and
 *    a lock the replaced id claimed is not debris while its process lives;
 *  - PC-3 wired: the queue drops the replaced session's holder at once, with
 *    nobody polling;
 *  - PC-4 a released lock's scope never lingers: a release in the transcript
 *    voids the lock calls before it and holds nothing itself, and a claim whose
 *    lock is gone holds nothing.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { SessionRegistry, readSessionEvents, PEER_CLAIM_WINDOW_MS } = await import('../server/sessions/registry.ts');
const { warmPids } = await import('../server/pid.ts');
const { inferSessionScope, touchesOf, CLAIM_GRACE_MS } = await import('../server/sessions/scope-inference.ts');
type Record_ = import('../server/sessions/registry.ts').SessionRecord;
type Change = import('../server/sessions/registry.ts').RegistryChange;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const T0 = Date.parse('2026-09-28T20:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A registry whose clock and process table the test owns. Every event is sent
 * fresh — the clock stands at its `at` — so the registry stamps the process's
 * identity the way it does for a live hook (`IDENTITY_FRESH_MS`).
 */
function registry() {
  const dir = mkdtempSync(join(tmpdir(), 'pc-clear-'));
  const changes: { id: string; event: Change }[] = [];
  let clock = T0;
  const reg = new SessionRegistry({
    dir,
    now: () => new Date(clock),
    pidAlive: () => true,
    // One process, one start time: the kernel's word for pid 87367.
    procStart: () => T0 - 3_600_000,
    onChange: (record, event) => changes.push({ id: record.sessionId, event }),
  }).load();
  const send = (ms: number, over: Record<string, unknown>): Record_ => {
    clock = ms;
    return reg.ingest({ cwd: '/w/hub', root: '/w/hub', pid: 87367, at: iso(ms), ...over } as never);
  };
  return { reg, dir, changes, send, cleanup: () => { reg.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ------------------------------------------------------------------ PC-1 */

test('PC-1 — a /clear: SessionEnd reason clear, then a SessionStart for a new id in the same pid, ends the old record at once', () => {
  const { reg, dir, changes, send, cleanup } = registry();
  try {
    send(T0, { session_id: 'old', event: 'SessionStart', source: 'startup' });
    assert.ok(reg.get('old')!.procStartedAt, 'the process\'s identity is on the record');
    send(T0 + 30_000, { session_id: 'old', event: 'SessionEnd', reason: 'clear' });
    assert.equal(reg.presence('old'), 'unknown', 'alone, the end is the hook\'s claim and the process still runs (PRS-1)');

    changes.length = 0;
    send(T0 + 30_000, { session_id: 'new', event: 'SessionStart', source: 'clear' });
    const old = reg.get('old')!;
    assert.equal(reg.presence('old'), 'ended', 'the process now belongs to another session: the old id is over');
    assert.deepEqual(old.supersededBy, { sessionId: 'new', at: iso(T0 + 30_000) });
    assert.equal(old.endedBy, 'hook', 'it reported its own end, and that report stands');
    assert.equal(old.reason, 'clear');
    assert.equal(reg.presence('new'), 'live');
    assert.ok(changes.some((c) => c.id === 'old' && c.event === 'SessionEnd'),
      `the replaced session's end is announced, so the queue re-reads its holders: ${JSON.stringify(changes)}`);
    const lines = readSessionEvents(dir, 'old');
    assert.equal(lines.at(-1)?.event, 'superseded', 'its raw log says what replaced it');
    assert.deepEqual(lines.at(-1)?.payload, { by: 'new', pid: 87367 });
    assert.ok(!reg.inRoot('/w/hub').some((r) => r.sessionId === 'old'), 'and it is nobody\'s peer any more');
  } finally { cleanup(); }
});

test('PC-1 — out of order, and with the end lost: the start still ends the record it replaced, and a late event cannot revive it', () => {
  const { reg, send, cleanup } = registry();
  try {
    // A SessionEnd that never arrived (a hook killed at its 1.5 s budget): the
    // record's last word was a Stop.
    send(T0, { session_id: 'silent', event: 'SessionStart', source: 'startup' });
    send(T0 + 10_000, { session_id: 'silent', event: 'Stop' });
    send(T0 + 20_000, { session_id: 'next', event: 'SessionStart', source: 'clear' });
    const silent = reg.get('silent')!;
    assert.equal(reg.presence('silent'), 'ended');
    assert.equal(silent.endedBy, 'successor', 'no end was reported: the successor\'s start is the evidence');
    assert.equal(silent.endedAt, iso(T0 + 10_000), 'ended at its last evidence of life, never at the moment somebody looked');

    // The replaced session's own events, drained late from the inbox in the
    // second of the hand-over: recorded, and they revive nothing.
    send(T0 + 20_000, { session_id: 'silent', event: 'Stop' });
    assert.equal(reg.presence('silent'), 'ended', 'an event from before the hand-over is history');
    send(T0 + 20_000, { session_id: 'silent', event: 'SessionEnd', reason: 'clear' });
    assert.equal(reg.presence('silent'), 'ended');
    assert.equal(reg.get('silent')!.supersededBy?.sessionId, 'next');
  } finally { cleanup(); }
});

test('PC-1 — a resume back to the old id in the same process revives it and ends the one it replaced; another pid ends nothing', () => {
  const { reg, send, cleanup } = registry();
  try {
    send(T0, { session_id: 'a', event: 'SessionStart', source: 'startup' });
    send(T0 + 1_000, { session_id: 'a', event: 'SessionEnd', reason: 'clear' });
    send(T0 + 1_000, { session_id: 'b', event: 'SessionStart', source: 'clear' });
    assert.equal(reg.presence('a'), 'ended');
    send(T0 + 5_000, { session_id: 'b', event: 'SessionEnd', reason: 'resume' });
    send(T0 + 5_000, { session_id: 'a', event: 'SessionStart', source: 'resume' });
    assert.equal(reg.presence('a'), 'live', '`/resume a` in the same process: a is back');
    assert.equal(reg.get('a')!.supersededBy, undefined);
    assert.equal(reg.presence('b'), 'ended');
    assert.equal(reg.get('b')!.supersededBy?.sessionId, 'a');

    // A session in ANOTHER process is never ended by this one's start.
    send(T0 + 6_000, { session_id: 'other', event: 'SessionStart', source: 'startup', pid: 4242 });
    send(T0 + 7_000, { session_id: 'c', event: 'SessionStart', source: 'startup', pid: 5151 });
    assert.equal(reg.presence('other'), 'live');
    assert.equal(reg.presence('a'), 'live');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------- PC-2..3 */

const PLAN = `---
slug: alpha
created: 2026-10-04
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | — | app | it works |
| 2 | two | 1 | — | app | it works |

## Phases

### Phase 1 — one
- **Verification:**
  - \`true\`

### Phase 2 — two
- **Verification:**
  - \`true\`
`;

/** One transcript line the way the CLI writes it: an assistant turn with tool calls. */
const toolLine = (at: string, ...uses: { name: string; input: Record<string, unknown> }[]): string =>
  JSON.stringify({
    type: 'assistant', timestamp: at,
    message: { role: 'assistant', content: uses.map((use, i) => ({ type: 'tool_use', id: `t${i}`, ...use })) },
  });

async function call(
  svc: InstanceType<typeof Service>, method: string, path: string, body?: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { try { payload = JSON.parse(text); } catch { payload = text; } },
    on() { return this; },
    writableEnded: false, destroyed: false,
  };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: { host: '127.0.0.1:4123', 'content-type': 'application/json', 'x-phase-console': '1', origin: 'http://127.0.0.1:4123' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (raw) yield Buffer.from(raw); },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return { status, payload: payload as Record<string, unknown> };
}

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test('PC-2..3 — wired: the queue drops a /clear\'d session\'s holder at once, and a lock it claimed is not debris while its process lives', async () => {
  const base = mkdtempSync(join(tmpdir(), 'p108-pc-'));
  const terminal = spawnProcess('sleep', ['120'], { stdio: 'ignore' });
  try {
    const root = join(base, 'hub');
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
    mkdirSync(join(root, 'app', 'src'), { recursive: true });
    writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '-A'], { cwd: root, env });
    execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });

    const svc = new Service({
      port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
      scriptsDir: SCRIPTS, logFile: null, converge: false, remoteHosts: [], remoteUsers: [],
    } as never);
    svc.push.announce = (() => {}) as typeof svc.push.announce;
    assert.equal(svc.open(root).ok, true);
    await svc.bootSettled;

    // The terminal's start time is read the moment its first hook lands, as on
    // a console that has been up a while — so the lone SessionEnd is `unknown`
    // (PRS-1) and only the successor's start can end it.
    await warmPids([terminal.pid!]);
    const now = new Date().toISOString();
    const oldTranscript = join(base, 'old.jsonl');
    // The terminal worked in `app`, then — its phase done — went on in the same process.
    writeFileSync(oldTranscript, `${toolLine(now, { name: 'Edit', input: { file_path: join(root, 'app', 'src', 'x.ts') } })}\n`);
    const newTranscript = join(base, 'new.jsonl');
    writeFileSync(newTranscript, '');
    const post = (body: Record<string, unknown>) => call(svc, 'POST', '/hooks/session', {
      version: 1, cwd: root, root, pid: terminal.pid, user: 'sam', host: 'laptop', ...body,
    });
    assert.equal((await post({ session_id: 'old', event: 'SessionStart', source: 'startup', transcript_path: oldTranscript, at: now })).status, 200);

    const request = { slug: 'alpha', phase: 2, runId: 'pc-run', scope: ['app'] };
    void svc.scheduler.admit(request);
    const sessionHolders = () => (svc.scheduler.entryOf('pc-run', 2)?.waitingOn ?? []).filter((h) => h.kind === 'session');
    assert.ok(await until(() => sessionHolders().some((h) => h.session === 'old')),
      `queued behind the terminal: ${JSON.stringify(sessionHolders())}`);

    // The /clear.
    assert.ok(svc.sessions.get('old')?.procStartedAt, 'the terminal\'s identity is on its record');
    assert.equal((await post({ session_id: 'old', event: 'SessionEnd', reason: 'clear', transcript_path: oldTranscript, at: now })).status, 200);
    assert.equal(svc.sessions.presence('old'), 'unknown', 'alone, the end is a claim the live process contradicts (PRS-1)');
    assert.equal((await post({ session_id: 'new', event: 'SessionStart', source: 'clear', transcript_path: newTranscript, at: now })).status, 200);

    assert.equal(svc.sessions.presence('old'), 'ended', 'the replaced session is over');
    assert.equal(svc.sessions.presence('new'), 'live');
    // At once: the presence change polled the queue (its own clock is a minute).
    assert.ok(await until(() => !sessionHolders().some((h) => h.session === 'old'), 1_500),
      `the replaced session still holds the queue: ${JSON.stringify(sessionHolders())}`);
    const registry = await call(svc, 'GET', '/api/sessions/registry');
    const views = registry.payload.sessions as { sessionId: string; presence: string; supersededBy?: { sessionId: string } }[];
    assert.equal(views.find((view) => view.sessionId === 'old')?.presence, 'ended', 'the Sessions page says so too');
    assert.equal(views.find((view) => view.sessionId === 'old')?.supersededBy?.sessionId, 'new');

    // PRS-1 kept: the process that claimed the lock is still here, so its
    // claim is not debris — the lease decides, as it did before.
    const lockPresence = (svc as unknown as { lockPresenceFor(lock: { owner: string; session?: string }): string })
      .lockPresenceFor({ owner: 'sam@laptop', session: 'old' });
    assert.equal(lockPresence, 'unknown', 'a /clear never frees the lock the old id claimed while its process lives');

    // …and once the process is gone, the claim is debris like any other.
    terminal.kill('SIGKILL');
    assert.ok(await until(() => (svc as unknown as { lockPresenceFor(lock: { owner: string; session?: string }): string })
      .lockPresenceFor({ owner: 'sam@laptop', session: 'old' }) === 'ended'), 'a dead process holds nothing');
    svc.close?.();
  } finally {
    terminal.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ PC-4 */

test('PC-4 — a release in the transcript voids the lock calls before it, and holds nothing itself', () => {
  const read = (lines: string[], nowIso: string, lockHeld?: (slug: string, phase: number) => boolean) => inferSessionScope({
    root: '/w/hub',
    record: { cwd: '/w/hub', startedAt: '2026-09-28T19:00:00Z' },
    touches: touchesOf(lines.join('\n')),
    planScope: (slug, phase) => (slug === 'alpha' ? (phase === 2 ? ['app'] : phase === 3 ? ['api'] : []) : undefined),
    isRepository: () => false,
    ...(lockHeld ? { lockHeld } : {}),
    now: Date.parse(nowIso),
  });
  const bash = (at: string, command: string) => toolLine(at, { name: 'Bash', input: { command } });

  // The #172 shape: claimed with a scope of its own, released, carried on.
  const released = read([
    bash('2026-09-28T20:10:00Z', 'bash scripts/phase-lock.sh alpha claim 2 --scope "app/app-backend,docs/observability"'),
    bash('2026-09-28T20:14:00Z', 'bash scripts/phase-lock.sh alpha release 2 --git'),
  ], '2026-09-28T20:16:00Z');
  assert.deepEqual(released.scope, [], `a released lock's scope never lingers: ${JSON.stringify(released)}`);
  assert.equal(released.basis, 'nothing', 'it claimed, and let go — not a session that has touched nothing yet');
  assert.ok(released.evidence.some((line) => /released alpha P2/.test(line)), released.evidence.join(' | '));

  // A release alone used to hold the phase's Repos scope.
  const releaseOnly = read([bash('2026-09-28T20:14:00Z', 'bash scripts/phase-lock.sh alpha release 2')], '2026-09-28T20:15:00Z');
  assert.deepEqual(releaseOnly.scope, [], 'a release is letting go, never a claim');

  // `conflicts` then release: voided too. A later phase's claim still holds.
  const next = read([
    bash('2026-09-28T20:00:00Z', 'bash scripts/phase-lock.sh alpha conflicts 2 --scope app'),
    bash('2026-09-28T20:01:00Z', 'bash scripts/phase-lock.sh alpha claim 2 --scope app'),
    bash('2026-09-28T20:10:00Z', 'bash scripts/phase-lock.sh alpha release 2'),
    bash('2026-09-28T20:11:00Z', 'bash scripts/phase-lock.sh alpha claim 3'),
  ], '2026-09-28T20:12:00Z', () => true);
  assert.equal(next.basis, 'touched');
  assert.deepEqual(next.scope, ['api'], 'what it holds is the phase it holds now');
});

test('PC-4 — a claim holds only while its lock is held: released by anyone else, it holds nothing past the grace', () => {
  const claim = toolLine('2026-09-28T20:10:00Z', { name: 'Bash', input: { command: 'bash scripts/phase-lock.sh alpha claim 2' } });
  const read = (nowMs: number, held: boolean) => inferSessionScope({
    root: '/w/hub',
    record: { cwd: '/w/hub', startedAt: '2026-09-28T19:00:00Z' },
    touches: touchesOf(claim),
    planScope: (slug, phase) => (slug === 'alpha' && phase === 2 ? ['app'] : undefined),
    isRepository: () => false,
    lockHeld: () => held,
    now: nowMs,
  });
  const claimed = Date.parse('2026-09-28T20:10:00Z');
  assert.ok(CLAIM_GRACE_MS > 0 && CLAIM_GRACE_MS < PEER_CLAIM_WINDOW_MS);
  assert.deepEqual(read(claimed + 60_000 * 3, true).scope, ['app'], 'held while the lock is');
  assert.deepEqual(read(claimed + 1_000, false).scope, ['app'], 'a claim the lock list has not caught up with still holds');
  const gone = read(claimed + CLAIM_GRACE_MS + 1_000, false);
  assert.deepEqual(gone.scope, [], 'its lock is gone — released by another session, the console, or its lease');
  assert.equal(gone.basis, 'nothing');
});
