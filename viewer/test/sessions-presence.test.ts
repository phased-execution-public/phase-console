/**
 * Session presence, end to end through the service.
 *
 * Pinned: the `/hooks/session` route (loopback only, validated, rate-limited,
 * feeding the registry the `GET /api/sessions/registry` reads back with the
 * plan+phase correlated through the lock's `session=`); a person's lock whose
 * session the hook reports ENDED is released by the convergence loop on the
 * change trigger — lease or no lease — while a live one stays; a declared
 * outcome from a session nobody here spawned (`phase-outcome.sh` with no
 * `PE_OUTCOME_FILE`, the real script) is picked up from the inbox and parks
 * the phase `waiting` on a run with the resume armed; and the hook installer
 * routes. Nothing spawns `claude`: the resume window is in the future.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR, savePrefs } = await import('../server/config.ts');
const { Service, HOOK_EVENTS_PER_MINUTE } = await import('../server/service.ts');
const { handleApi } = await import('../server/api/routes.ts');
const { lockPath, readLock } = await import('../server/store.ts');
const { latestRun, journalFile, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { inboxOutcomeFile, inboxOutcomePhase } = await import('../server/runner/outcome.ts');
const { instanceId } = await import('../shared/instances.mjs');
const { recent: recentLog } = await import('../server/log.ts');
const { PEER_CLAIM_WINDOW_MS } = await import('../server/sessions/registry.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PLAN = `---
slug: alpha
created: 2026-08-06
status: active
phases: 3
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |
| 3 | checkout | 2 | — | app | it ships |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S

### Phase 3 — checkout
- **Size:** S
`;

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-presence-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root, env });
}

function handoff(root: string, phase: number, title: string, status: string): void {
  const pad = String(phase).padStart(2, '0');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-${pad}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase} — ${title}
`, 'utf8');
}

/** A lock exactly as `phase-lock.sh claim --session` writes it. */
function claim(root: string, phase: number, owner: string, leaseFromNowS: number, session?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const file = lockPath(join(root, 'docs', 'handoffs'), 'alpha', phase);
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha', '.locks'), { recursive: true });
  writeFileSync(file, [
    'slug=alpha', `phase=${phase}`, `owner=${owner}`, 'host=test', `claimed_at=${now - 60}`, `lease_until=${now + leaseFromNowS}`,
    'scope=app', ...(session ? [`session=${session}`] : []), '',
  ].join('\n'), 'utf8');
  return file;
}

function service(root: string, flags: Record<string, unknown> = {}, before?: (svc: InstanceType<typeof Service>) => void) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: false,
    scriptsDir: SCRIPTS, logFile: null, converge: true, remoteHosts: [], remoteUsers: [], ...flags,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  before?.(svc);
  assert.equal(svc.open(root).ok, true);
  return svc;
}

async function settle(svc: InstanceType<typeof Service>): Promise<void> {
  await svc.bootSettled;
  await svc.converger.idle();
}

/** A request through the real `handleApi`, from a given socket address. */
async function call(
  svc: InstanceType<typeof Service>, method: string, path: string,
  body?: unknown, opts: { remote?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; payload: unknown }> {
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
    headers: { host: '127.0.0.1:4123', 'content-type': 'application/json', ...(opts.headers ?? {}) },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { if (raw) yield Buffer.from(raw); },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1:4123${path}`));
  return { status, payload };
}

/**
 * Write an inbox file the way the only thing that really writes one does.
 *
 * `phase-outcome.sh` is tmp+`mv` (line 220), and that is not decoration: the
 * watcher debounces 250 ms per path and then READS, so a plain `writeFileSync`
 * can be seen at zero length, parsed as junk, and consumed — the declaration
 * gone before the runner is handed it. macOS coalesces the create and the write
 * inside one FSEvents window and hides it; Linux inotify does not, which is why
 * this only ever failed on the ubuntu leg of CI.
 */
const writeInbox = (file: string, body: string): void => {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, file);
};

/**
 * Wait for something a FILE WATCHER has to notice — an inbox outcome consumed, a
 * lock released, a run minted from a declaration.
 *
 * The default is generous on purpose. Every one of these waits on the OS to
 * deliver a filesystem event and on a debounce to fire, and under a full
 * parallel suite on a shared CI runner that has been measured well past four
 * seconds — which is how a release-blocking failure appeared here ("handed to
 * the live runner") on a path this change set never touched, in a suite that
 * passes locally every time. Two call sites below had already been bumped to 6s
 * one at a time; this fixes the shape rather than the next symptom.
 *
 * A generous ceiling costs nothing when the condition is met — the loop returns
 * on the first check that passes.
 */
const poll = async (check: () => boolean, ms = 20_000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
};

/* ------------------------------------------------------------------ *
 * The route and the registry
 * ------------------------------------------------------------------ */

test('POST /hooks/session: loopback only, validated, fed to the registry; GET /api/sessions/registry reads it back with the plan+phase the lock names', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      claim(root, 2, 'sam@laptop', 3600, 's-hand');
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);

      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-hand', event: 'SessionStart', cwd: root, user: 'sam', host: 'laptop', source: 'startup', at: new Date().toISOString(),
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));
      assert.deepEqual(started.payload, { ok: true, session: { sessionId: 's-hand', presence: 'live' } });

      const list = await call(svc, 'GET', '/api/sessions/registry');
      assert.equal(list.status, 200);
      const sessions = (list.payload as { sessions: { sessionId: string; presence: string; plan?: { slug: string; phase: number; strong: boolean }; kind: string }[] }).sessions;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].sessionId, 's-hand');
      assert.equal(sessions[0].presence, 'live');
      assert.equal(sessions[0].kind, 'foreign');
      assert.deepEqual(sessions[0].plan, { slug: 'alpha', phase: 2, strong: true });

      // Not a session event → 400; not from this machine → 403; GET → 405.
      assert.equal((await call(svc, 'POST', '/hooks/session', { hello: 'world' })).status, 400);
      assert.equal((await call(svc, 'POST', '/hooks/session', { session_id: 'x', event: 'Stop', cwd: root }, { remote: '100.64.0.7' })).status, 403);
      assert.equal((await call(svc, 'GET', '/hooks/session')).status, 405);
      // The bucket: far more events than a person's sessions produce answer 429.
      //
      // 🔴 The budget COMPENSATES FOR REFILL instead of assuming the flood
      // outruns it. The bucket regains HOOK_EVENTS_PER_MINUTE/60 = 5 tokens per
      // elapsed second, so a fixed `+5` overshoot drains it only while the whole
      // flood finishes inside ~1.2s — true alone (132ms), false under
      // full-suite load, where this read 200 after all 305 attempts and failed
      // `200 !== 429` with no message to say why. Not a slow-machine flake: ten
      // times slower is enough. Terminating for any throughput above 5 events/s
      // (measured: ~2300/s alone), and the deadline turns a machine below that
      // into a diagnosis rather than a hang.
      const flood = Date.now();
      const deadline = flood + 60_000;
      let last = 200;
      let fired = 0;
      while (last === 200 && Date.now() < deadline) {
        const refilled = Math.floor((Date.now() - flood) / 1000) * (HOOK_EVENTS_PER_MINUTE / 60);
        if (fired > HOOK_EVENTS_PER_MINUTE + refilled + 5) break;
        last = (await call(svc, 'POST', '/hooks/session', { session_id: 'flood', event: 'Stop', cwd: root })).status;
        fired++;
      }
      assert.equal(last, 429,
        `the bucket never closed: ${fired} events in ${Date.now() - flood}ms answered ${last}`);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Presence → the lock
 * ------------------------------------------------------------------ */

test('a person\'s lock whose session the hook reports ENDED is released by the convergence loop at once; a live one stays', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      // Two hand-driven sessions, each holding its phase with an unexpired lease.
      const gone = claim(root, 2, 'sam@laptop', 3600, 's-gone');
      const live = claim(root, 3, 'kim@desk', 3600, 's-live');
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);
      for (const [id, user] of [['s-gone', 'sam'], ['s-live', 'kim']] as const) {
        svc.ingestSessionEvent({ session_id: id, event: 'SessionStart', cwd: root, user, host: 'laptop', source: 'startup' });
      }
      assert.equal(svc.sessions.presenceOfLock(readLock(join(root, 'docs', 'handoffs'), 'alpha', 2)!), 'live');
      // The converge loop needs a run of the plan to act on; a stopped one will do.
      const { newRun, saveRun, phaseRecord } = await import('../server/runner/state.ts');
      const state = newRun({ slug: 'alpha', root, autoRecover: false });
      state.status = 'halted';
      state.halt = { at: new Date().toISOString(), reason: 'x' };
      Object.assign(phaseRecord(state, 2), { status: 'failed', attempts: 1 });
      saveRun(state);

      // SessionEnd for the first: its lock is debris NOW.
      svc.ingestSessionEvent({ session_id: 's-gone', event: 'SessionEnd', cwd: root, reason: 'other' });
      assert.equal(svc.sessions.presence('s-gone'), 'ended');
      assert.ok(await poll(() => !existsSync(gone), 6_000), 'the ended session\'s lock is released by converge on the change trigger');
      await svc.converger.idle();
      assert.ok(existsSync(live), 'the live session\'s lock stays');
      // Journalled on the plan's latest run, naming the session.
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      const released = lines.find((l) => l.event === 'run.lock-debris-released');
      assert.ok(released, 'journalled');
      assert.equal(released!.data.owner, 'sam@laptop');
      assert.equal(released!.data.session, 's-gone');
      assert.equal(released!.data.by, 'converge');
      // The scheduler reads the same verdict through its presence dep: a foreign lock on phase 3 (live) blocks; phase 2's is gone.
      const evidence = await svc.classifyPhase('alpha', 3, null, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.situation.id, 'foreign-live');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Unsupervised outcomes
 * ------------------------------------------------------------------ */

test('phase-outcome.sh from a shell with no PE_OUTCOME_FILE lands in the inbox; the console parks the phase waiting on a run with the resume armed', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      assert.equal(latestRun(root, 'alpha'), null, 'no run yet — a person is driving phase 2 by hand');
      // The real script, the real identity rule: no PE_OUTCOME_FILE, DOCS_ROOT = the repo, XDG_STATE_HOME = the sandbox.
      // Its own session id: `s-hand` is registered LIVE by an earlier test in
      // this file, and a live declaring session is exactly what the inbox now
      // refuses to arm a resume of (REG-1) — the case beside this one pins that.
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-inbox' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      const out = execFileSync('/bin/bash', [join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'waiting-external', '--wait-minutes', '45', '--reason', 'image build', '--watch', 'gh:x#run/1'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(out, /"session_id": "s-inbox"/);
      // The stamp is the script's own `date -u`, so the file is FOUND rather
      // than predicted (S9-a): one declaration, so exactly one name is there,
      // and asserting a path that could never exist would have made the
      // "consumed" poll below pass on an empty directory.
      const inbox = dirname(inboxOutcomeFile(root, 'alpha', 2));
      assert.equal(inbox.includes(instanceId(root)), true);
      const landed = readdirSync(inbox).filter((n) => inboxOutcomePhase(n) === 2);
      assert.equal(landed.length, 1, `one declaration, one file: ${landed.join(', ')}`);
      assert.match(landed[0], /^phase-02-\d{8}T\d{6}Z\.json$/);
      const expected = join(inbox, landed[0]);
      // Picked up (by the watcher, or the boot scan had it been written before) and consumed.
      assert.ok(await poll(() => !existsSync(expected) && latestRun(root, 'alpha') !== null, 6_000), 'the inbox file is consumed and a run exists');
      const state = latestRun(root, 'alpha')!;
      const rec = state.phases['2'];
      assert.equal(rec.status, 'waiting');
      assert.equal(rec.parkReason, 'image build');
      assert.deepEqual(rec.watch, ['gh:x#run/1']);
      assert.equal(rec.resumeSessionId, 's-inbox', 'THAT session is what resumes');
      assert.ok(rec.parkedUntil && Date.parse(rec.parkedUntil) > Date.now() + 30 * 60_000, 'parked on the declared window');
      assert.equal(state.status, 'paused');
      assert.equal(state.stoppedBy, 'system');
      assert.equal(state.waitUntil, rec.parkedUntil);
      assert.deepEqual(state.onlyPhases, [2], 'scoped to the phase the person declared');
      // The resume is armed on the service's own clock (restart-safe: `readoptQueued` re-arms a paused+waitUntil run).
      const timers = (svc as unknown as { limitResumeTimers: Map<string, unknown> }).limitResumeTimers;
      assert.ok(timers.has('alpha'), 'armLimitResume armed for the window');
      // The declaration is the classifier's evidence for the phase.
      const { evidence, situation } = await svc.classifyPhase('alpha', 2, state, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.declared?.status, 'waiting-external');
      assert.equal(situation.id, 'waiting-external');
      // Journalled on the run it created.
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      assert.ok(lines.some((l) => l.event === 'phase.outcome' && l.data.by === 'unsupervised' && l.data.sessionId === 's-inbox'));
      assert.ok(lines.some((l) => l.event === 'run.waiting-external'));
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/**
 * REG-1 — the console resumed a session it never asked the registry about.
 *
 * The standing case: a hand session declared `waiting-external`, took the phase
 * over and kept working, and the inbox armed a `--resume` of it for 21:15 — a
 * second `claude` on a live transcript in the same tree, with no confirm and no
 * record. Presence is now read BEFORE the declaration is spent: a live author
 * is a recorded refusal, nothing is armed, and the file is kept until that
 * session ends.
 */
test('REG-1: a declaration from a session still running is refused and kept — no run parked, no resume armed, no resumeSessionId', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const announced: { category: string; title: string }[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = 3_600_000;
      s.push.announce = ((category: string, message: { title: string }) => { announced.push({ category, title: message.title }); }) as typeof s.push.announce;
    });
    try {
      await settle(svc);
      // The declaring session, alive: its pid is this very test process.
      svc.ingestSessionEvent({ version: 1, session_id: 's-took-over', event: 'SessionStart', cwd: root, pid: process.pid, source: 'startup', at: new Date().toISOString() });
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-took-over' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      execFileSync('/bin/bash', [join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'waiting-external', '--wait-minutes', '45', '--reason', 'took the phase over', '--watch', 'date:2026-09-13T21:15:00Z'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      // FOUND, not predicted: the name carries the script's own `date -u`
      // stamp since S9-a, so the only honest way to name it is to look.
      const inbox = dirname(inboxOutcomeFile(root, 'alpha', 2));
      const landed = readdirSync(inbox).filter((n) => inboxOutcomePhase(n) === 2);
      assert.equal(landed.length, 1, `one declaration, one file: ${landed.join(', ')}`);
      const file = join(inbox, landed[0]);
      assert.ok(await poll(() => announced.some((a) => /A resume is held/.test(a.title)), 6_000), 'the refusal is announced');
      assert.ok(existsSync(file), 'the declaration is KEPT, as evidence, until its author ends');
      assert.equal(latestRun(root, 'alpha'), null, 'no run was parked on it');
      const timers = (svc as unknown as { limitResumeTimers: Map<string, unknown> }).limitResumeTimers;
      assert.equal(timers.has('alpha'), false, 'no armLimitResume');
      assert.equal(announced.filter((a) => /A resume is held/.test(a.title)).length, 1, 'said once, however many sweeps read it');
      // …and the moment that session ends, the same declaration is acted on.
      svc.ingestSessionEvent({ version: 1, session_id: 's-took-over', event: 'SessionEnd', cwd: root, reason: 'other', at: new Date().toISOString() });
      (svc as unknown as { ingestOutcomeFile: (slug: string, file: string) => void }).ingestOutcomeFile('alpha', file);
      assert.ok(await poll(() => latestRun(root, 'alpha')?.phases['2']?.status === 'waiting', 6_000), 'parked once its author ended');
      assert.equal(latestRun(root, 'alpha')!.phases['2'].resumeSessionId, 's-took-over');
      assert.ok(timers.has('alpha'), 'and only now is the resume armed');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('SHD-6: an overdue wait is ruled on with the watch clock already open — refs read before run.limit-resume', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const state = newRun({ slug: 'alpha', root });
    state.status = 'paused';
    state.stoppedBy = 'system';
    state.waitReason = 'external';
    const until = new Date(Date.now() - 90 * 60_000).toISOString();
    state.waitUntil = until;
    const rec = phaseRecord(state, 2);
    rec.status = 'waiting';
    rec.parkedUntil = until;
    rec.sessionId = 's-overdue';
    rec.resumeSessionId = 's-overdue';
    rec.declared = { status: 'waiting-external', reason: 'the image build', watch: ['date:2026-01-01T00:00:00Z'], at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
    saveRun(state);
    const started: string[] = [];
    let clockOpenAtResume: boolean | null = null;
    const svc = service(root, {}, (s) => {
      s.prefs.resumeAtBoot = 'auto';
      s.prefs.convergeEveryMs = 3_600_000;
      (s as never as { startRun: (slug: string, o: Record<string, unknown>) => Promise<unknown> }).startRun = async (slug, o) => {
        clockOpenAtResume = s.watchClock.snapshot().open;
        started.push(String(o.resumeRunId ?? slug));
        return null;
      };
    });
    try {
      await settle(svc);
      assert.ok(await poll(() => started.length > 0, 6_000), 'the overdue wait resumed');
      assert.equal(clockOpenAtResume, true, 'the watch clock was open before anything resumed');
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      const order = lines.map((l) => l.event);
      assert.ok(order.indexOf('run.wait-overdue') >= 0 && order.indexOf('run.wait-overdue') < order.indexOf('run.limit-resume'), order.join(', '));
      const overdue = lines.find((l) => l.event === 'run.wait-overdue')!;
      assert.deepEqual((overdue.data.refs as { state: string }[]).map((r) => r.state), ['landed']);
    } finally {
      // `open()` wrote `auto` into the sandbox's prefs; every other case in this
      // file assumes the shipped `ask`, under which a system-stopped run is
      // asked about rather than relaunched. Put it back.
      svc.prefs.resumeAtBoot = 'ask';
      savePrefs(svc.prefs);
      svc.close();
    }
  } finally { cleanup(); }
});

/**
 * xcut-6 — the unsupervised park gets the answer the supervised one gets.
 *
 * Its unsupervised twin — a hand-run session declaring an outcome with no
 * `PE_OUTCOME_FILE` — once had no caps at all: a `--until` a week out parked the
 * plan a week out, past `setTimeout`'s reach. Then it had the supervised
 * clamp, which cut any window to the eight hours left and recorded neither the
 * ask nor the cut (WAI-1). Both twins now go through `evaluateWait`: a window
 * past the budget is REFUSED with the arithmetic, a window inside it parks for
 * exactly what it asked, and the per-phase cap still turns a re-filed wait into
 * a refusal.
 */
test('an unsupervised waiting-external park is answered by the wait budget — refused with the arithmetic past it, never cut (xcut-6, WAI-1)', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-budget' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      const inbox = inboxOutcomeFile(root, 'alpha', 2);
      const lines = (): { event: string; data: Record<string, unknown> }[] => {
        const run = latestRun(root, 'alpha');
        if (!run || !existsSync(journalFile(root, 'alpha', run.id))) return [];
        return readFileSync(journalFile(root, 'alpha', run.id), 'utf8').trim().split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
      };
      const refusals = (): number => lines().filter((line) => line.event === 'phase.wait-budget-spent').length;
      const declare = (minutes: string): void => {
        execFileSync('/bin/bash', [
          join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'waiting-external',
          '--wait-minutes', minutes, '--reason', 'a very slow build',
        ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      };

      // A week out. The budget is eight hours: REFUSED, with the arithmetic —
      // never parked for a silent eight and then woken 51 hours early.
      declare(String(7 * 24 * 60));
      assert.ok(await poll(() => latestRun(root, 'alpha') !== null, 6_000), 'a run exists');
      assert.ok(await poll(() => refusals() === 1, 12_000), 'the week-long window is refused on the record');
      const refused = latestRun(root, 'alpha')!;
      assert.notEqual(refused.phases['2']?.status, 'waiting', 'not parked for a cut-down eight hours');
      assert.equal(refused.phases['2']?.waits ?? 0, 0, 'a refused window spends no wait');
      const refusal = lines().find((line) => line.event === 'phase.wait-budget-spent')!.data;
      assert.equal(refusal.ledger, 'budget');
      assert.match(String(refusal.refusal), /8\.0 h \(the console default\)/, 'the arithmetic names the budget and its source');
      assert.match(String(refusal.refusal), /does not cut a declared window short/);

      // Inside the budget: parked for exactly the window it asked for.
      declare('60');
      assert.ok(await poll(() => latestRun(root, 'alpha')!.phases['2']?.status === 'waiting', 12_000));
      const parked = latestRun(root, 'alpha')!;
      const until = Date.parse(parked.phases['2'].parkedUntil!);
      assert.ok(Math.abs(until - (Date.now() + 60 * 60_000)) < 3 * 60_000,
        `parked for the declared hour (${parked.phases['2'].parkedUntil})`);
      const waiting = lines().filter((line) => line.event === 'phase.waiting').at(-1)!.data;
      assert.equal(waiting.capped, false);
      assert.equal(waiting.requestedSource, 'declared');
      assert.equal(waiting.budgetMs, 8 * 60 * 60_000);
      assert.equal(waiting.by, 'unsupervised');

      // Re-declared until the per-phase cap is spent. The fourth park is the
      // last one; the fifth must be refused rather than parking again.
      for (let i = 0; i < 4; i++) {
        const before = latestRun(root, 'alpha')!.phases['2'].waits ?? 0;
        if (before >= 4) break;
        declare('60');
        // ASSERTED, with a budget for a loaded runner: the inbox is one file
        // per phase, so declaring again before the last drop was consumed
        // REPLACES it — an unasserted timeout here silently coalesced two
        // parks and the cap read 3 (CI, ubuntu).
        assert.ok(
          await poll(
            () => (latestRun(root, 'alpha')!.phases['2'].waits ?? 0) > before, 12_000,
            // Re-declared only while the drop is still sitting there: a lost
            // watcher event is not a slow one, and the budget above was the
            // previous attempt at the same failure.
            () => { if (existsSync(inbox)) declare('60'); },
          ),
          `park after ${before} never landed`,
        );
      }
      const spent = latestRun(root, 'alpha')!;
      assert.equal(spent.phases['2'].waits, 4, 'four parks, the documented cap');

      const parkedUntilBefore = spent.phases['2'].parkedUntil;
      declare('60');
      assert.ok(await poll(() => refusals() === 2, 12_000), 'the refusal is journalled');
      assert.equal(lines().filter((line) => line.event === 'phase.wait-budget-spent').at(-1)!.data.ledger, 'waits',
        'and it names the ledger that ran out — the declared waits, not the hours');
      const after = latestRun(root, 'alpha')!;
      assert.equal(after.phases['2'].waits, 4, 'the fifth declaration does NOT park again');
      assert.equal(after.phases['2'].parkedUntil, parkedUntilBefore, 'and the clock is not pushed out');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('WAI-7: a stale or invalid inbox file is SET ASIDE under outcomes/ignored/ and journalled — never destroyed; a live runner gets a valid declaration through its own verb', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      // A stored run to journal on — "the plan's latest run".
      const state = newRun({ slug: 'alpha', root, model: 'opus' });
      state.status = 'paused';
      state.stoppedBy = 'operator';
      saveRun(state);
      const journal = () => {
        try {
          return readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').filter(Boolean)
            .map((l) => JSON.parse(l) as { event: string; phase?: number; data: Record<string, unknown> });
        } catch { return []; }
      };
      const ignored = (reason: string) => join(inboxOutcomeFile(root, 'alpha', 2), '..', 'ignored', `phase-02.json.${reason}`);

      const file = inboxOutcomeFile(root, 'alpha', 2);
      mkdirSync(join(file, '..'), { recursive: true });
      const stale = JSON.stringify({ version: 1, slug: 'alpha', phase: 2, status: 'waiting-external', watch: [], written_at: '2020-01-01T00:00:00Z' });
      writeInbox(file, stale);
      assert.ok(await poll(() => !existsSync(file)), 'gone from the inbox');
      assert.ok(existsSync(ignored('stale')), 'kept beside it, named for why');
      assert.equal(readFileSync(ignored('stale'), 'utf8').trim(), stale, 'the bytes are intact');
      assert.equal(state.phases[2], undefined, 'a declaration from 2020 changes nothing');
      let line = journal().find((l) => l.event === 'phase.outcome-ignored');
      assert.ok(line, 'journalled on the plan\'s latest run');
      assert.equal(line!.phase, 2);
      assert.equal(line!.data.reason, 'stale');
      assert.equal(line!.data.writtenAt, '2020-01-01T00:00:00Z');
      assert.ok((line!.data.ageMs as number) > 24 * 3_600_000);
      assert.equal(line!.data.status, 'waiting-external');
      assert.equal(line!.data.kept, 'ignored/phase-02.json.stale');

      writeInbox(file, 'not json');
      assert.ok(await poll(() => !existsSync(file)), 'junk gone from the inbox too');
      assert.ok(existsSync(ignored('invalid')));
      assert.equal(readFileSync(ignored('invalid'), 'utf8').trim(), 'not json');
      line = journal().filter((l) => l.event === 'phase.outcome-ignored').at(-1);
      assert.equal(line!.data.reason, 'invalid');
      assert.equal(line!.data.writtenAt, null, 'nothing to peek in non-JSON');

      // A second invalid one with the same name is NOT overwritten: `.1`.
      const wrongVersion = JSON.stringify({ version: 2, slug: 'alpha', phase: 2, status: 'complete', written_at: '2026-09-14T09:00:00Z' });
      writeInbox(file, wrongVersion);
      assert.ok(await poll(() => !existsSync(file)));
      assert.ok(existsSync(`${ignored('invalid')}.1`), 'evidence is never overwritten');
      line = journal().filter((l) => l.event === 'phase.outcome-ignored').at(-1);
      assert.equal(line!.data.writtenAt, '2026-09-14T09:00:00Z', 'the rejected file\'s own stamp is still read');
      assert.equal(line!.data.kept, 'ignored/phase-02.json.invalid.1');

      // A live runner: the declaration goes through `declareOutcome`.
      const declared: unknown[] = [];
      (svc as unknown as { runners: Map<string, unknown> }).runners.set('alpha', {
        busy: () => true,
        current: () => ({ id: 'r1', slug: 'alpha' }),
        declareOutcome: (phase: number, outcome: unknown, by: string) => { declared.push({ phase, outcome, by }); return 'parked'; },
        noteDocsChanged: () => {},
      });
      const live = JSON.stringify({ version: 1, slug: 'alpha', phase: 2, status: 'partial', reason: 'budget', watch: [], written_at: new Date().toISOString(), session_id: 's-verb' });
      writeInbox(file, live);
      // Re-delivered, unconditionally, until it lands: on a loaded Linux runner
      // the watcher can miss the rename onto a path it has already seen
      // consumed twice in this same test, and no ceiling fixes a lost event.
      // Unconditional because the drop can also be consumed WITHOUT reaching
      // the handler, and a nudge guarded on the file still being there would
      // then never fire again. The nudge stops the moment one lands, and only
      // `declared[0]` is asserted, so an extra in-flight write is harmless.
      assert.ok(
        await poll(() => declared.length === 1, 20_000, () => writeInbox(file, live)),
        'handed to the live runner',
      );
      assert.deepEqual(declared[0], { phase: 2, outcome: { version: 1, slug: 'alpha', phase: 2, status: 'partial', reason: 'budget', watch: [], written_at: (declared[0] as { outcome: { written_at: string } }).outcome.written_at, session_id: 's-verb' }, by: 'unsupervised' });
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('WAI-7: a valid declaration is consumed only AFTER its act settles — and a thrown act sets it aside as `failed`', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, model: 'opus' });
      state.status = 'paused';
      state.stoppedBy = 'operator';
      saveRun(state);
      let release!: () => void;
      let fail!: (error: Error) => void;
      let applied = 0;
      (svc as unknown as { applyUnsupervisedOutcome: unknown }).applyUnsupervisedOutcome = () => {
        applied++;
        return new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      };
      const file = inboxOutcomeFile(root, 'alpha', 3);
      mkdirSync(join(file, '..'), { recursive: true });
      writeInbox(file, JSON.stringify({ version: 1, slug: 'alpha', phase: 3, status: 'complete', watch: [], written_at: new Date().toISOString() }));
      assert.ok(await poll(() => applied === 1), 'the act was asked');
      // The sweep fires every 10 s and the watcher on every change; while the
      // act is in flight the file is still there and is NOT applied again.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(existsSync(file), 'consume LAST: the file stands until the act settles');
      assert.equal(applied, 1, 'in flight ⇒ not re-applied');
      release();
      assert.ok(await poll(() => !existsSync(file)), 'consumed once the act settled');
      assert.ok(!existsSync(join(file, '..', 'ignored')), 'nothing set aside for a clean act');

      // A thrown act: kept as `failed`, journalled, never re-applied every sweep.
      writeInbox(file, JSON.stringify({ version: 1, slug: 'alpha', phase: 3, status: 'complete', watch: [], written_at: new Date().toISOString() }));
      assert.ok(await poll(() => applied === 2));
      fail(new Error('the board could not be read'));
      assert.ok(await poll(() => !existsSync(file)));
      assert.ok(existsSync(join(file, '..', 'ignored', 'phase-03.json.failed')));
      const lines = readFileSync(journalFile(root, 'alpha', state.id), 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
      const failed = lines.find((l) => l.event === 'phase.outcome-ignored' && l.data.reason === 'failed');
      assert.ok(failed, 'journalled as failed');
      assert.equal(failed!.data.error, 'the board could not be read');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(applied, 2, 'a failed file is not re-applied');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('WAI-8 / SLF-4: an unsupervised `partial` past its cap is recorded, not boarded; one inside the cooldown collapses; stallRemedy survives the re-board', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const boards: unknown[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = 3_600_000;
      // The boarding is what a `partial` buys; here it is counted, never spawned.
      (s as unknown as { startRun: unknown }).startRun = async (slug: string, opts: unknown) => { boards.push({ slug, opts }); return null; };
    });
    try {
      await settle(svc);
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-partial' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      const declare = (): void => {
        execFileSync('/bin/bash', [
          join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'partial', '--reason', 'context',
        ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      };
      const lines = (): { event: string; data: Record<string, unknown> }[] => {
        const run = latestRun(root, 'alpha');
        if (!run || !existsSync(journalFile(root, 'alpha', run.id))) return [];
        return readFileSync(journalFile(root, 'alpha', run.id), 'utf8').trim().split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
      };
      const count = (event: string) => lines().filter((l) => l.event === event).length;

      // A stored run whose phase 2 carries the watchdog's bound and three acts on `partial` already.
      const state = newRun({ slug: 'alpha', root, model: 'opus' });
      state.status = 'paused';
      state.stoppedBy = 'system';
      const record = phaseRecord(state, 2);
      record.status = 'failed';
      record.stallRemedy = { nudges: 2, recycles: 1 };
      record.declarations = { partial: { count: 3, lastAt: new Date(Date.now() - 60 * 60_000).toISOString() } };
      saveRun(state);

      // The fourth act: re-boarded, with the bound INTACT (it used to be wiped here).
      declare();
      assert.ok(await poll(() => boards.length === 1, 12_000), 'the fourth partial boards');
      let stored = latestRun(root, 'alpha')!;
      assert.equal(stored.phases['2'].status, 'pending');
      assert.deepEqual(stored.phases['2'].stallRemedy, { nudges: 2, recycles: 1 }, 'stallRemedy survives an unsupervised re-board');
      assert.equal(stored.phases['2'].boardingHint?.situation, 'work-in-progress');
      assert.equal(stored.phases['2'].declarations?.partial?.count, 4);
      assert.equal(count('phase.reboard-requested'), 1);

      // The fifth, a second later: inside the cooldown of the fourth — collapsed, not boarded.
      declare();
      assert.ok(await poll(() => count('phase.declaration-refused') === 1, 12_000), 'refused on the record');
      let refused = lines().filter((l) => l.event === 'phase.declaration-refused').at(-1)!.data;
      assert.equal(refused.why, 'cooldown');
      assert.equal(refused.status, 'partial');
      assert.equal(boards.length, 1, 'no second boarding');
      assert.equal(count('phase.reboard-requested'), 1);

      // Past the cooldown but past the cap too: recorded, not acted on — the count is a Retry's to clear.
      stored = latestRun(root, 'alpha')!;
      stored.phases['2'].declarations!.partial!.lastAt = new Date(Date.now() - 10 * 60_000).toISOString();
      saveRun(stored);
      declare();
      assert.ok(await poll(() => count('phase.declaration-refused') === 2, 12_000));
      refused = lines().filter((l) => l.event === 'phase.declaration-refused').at(-1)!.data;
      assert.equal(refused.why, 'cap');
      assert.equal(refused.count, 4);
      assert.equal(refused.max, 4);
      assert.equal(boards.length, 1, 'N acts and one refusal: the fifth act never happens');
      assert.equal(latestRun(root, 'alpha')!.phases['2'].declarations?.partial?.refused, 2);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('WAI-8: an unsupervised needs-human --until a month out is capped at seven days, and the cap is journalled', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, {}, (s) => { s.prefs.convergeEveryMs = 3_600_000; });
    try {
      await settle(svc);
      const state = newRun({ slug: 'alpha', root, model: 'opus' });
      state.status = 'paused';
      state.stoppedBy = 'system';
      saveRun(state);
      const env = { ...process.env, DOCS_ROOT: root, PE_SESSION_ID: 's-month' };
      delete (env as Record<string, unknown>).PE_OUTCOME_FILE;
      const monthOut = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      execFileSync('/bin/bash', [
        join(SCRIPTS, 'phase-outcome.sh'), 'alpha', '2', 'needs-human', '--needs', 'credential',
        '--reason', 'the token', '--until', monthOut,
      ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = (): { event: string; data: Record<string, unknown> }[] => readFileSync(journalFile(root, 'alpha', state.id), 'utf8')
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> });
      assert.ok(await poll(() => existsSync(journalFile(root, 'alpha', state.id)) && lines().some((l) => l.event === 'phase.outcome'), 12_000));
      const outcome = lines().find((l) => l.event === 'phase.outcome')!.data;
      assert.equal(outcome.capped, true, 'the ceiling applied, and said so');
      assert.equal(Date.parse(String(outcome.requested)), Date.parse(monthOut), 'the ask is recorded as asked');
      const granted = Date.parse(String(outcome.granted));
      assert.ok(Math.abs(granted - (Date.now() + 7 * 24 * 3_600_000)) < 5 * 60_000, `granted seven days out (${outcome.granted})`);
      const stored = latestRun(root, 'alpha')!;
      assert.equal(stored.phases['2'].parkedUntil, outcome.granted);
      assert.equal(stored.phases['2'].declared?.status, 'needs-human');
      assert.equal(stored.phases['2'].declarations?.['needs-human']?.count, 1);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/**
 * The inbox has a floor under the watcher.
 *
 * `fs.watch(dir, { recursive: true })` was the ONLY thing that noticed a
 * declaration, and it is not a guarantee: a loaded machine drops events, and
 * the watcher's own error handler closes it for the life of the console with
 * nothing to re-arm it. Either way the drop sat unread until the next boot —
 * and `phase-outcome.sh` is the session→runner channel, so what was lost is a
 * phase saying how it ended. Both halves are pinned here: the floor is armed,
 * and it reads what the watcher never delivered.
 */
test('a declaration the watcher never delivers is still read, on the sweep', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const svc = service(root);
    try {
      await settle(svc);
      const internals = svc as unknown as {
        outcomeSweep: ReturnType<typeof setInterval> | null;
        outcomeWatcher: { close(): void } | null;
      };
      assert.ok(internals.outcomeSweep, 'the sweep is armed when the inbox is');

      // The watcher, gone — exactly what its own error handler does, and what a
      // dropped event looks like from here.
      internals.outcomeWatcher?.close();
      internals.outcomeWatcher = null;

      const file = inboxOutcomeFile(root, 'alpha', 2);
      mkdirSync(join(file, '..'), { recursive: true });
      writeInbox(file, JSON.stringify({
        version: 1, slug: 'alpha', phase: 2, status: 'waiting-external',
        watch: [], written_at: new Date().toISOString(),
      }));
      // No nudge, deliberately: re-delivering would re-arm nothing and prove
      // nothing. Two sweeps of headroom.
      assert.ok(await poll(() => !existsSync(file), 25_000),
        'the sweep never read a drop the watcher could not deliver');
    } finally { svc.close(); }
    // …and it is not left running behind a closed console.
    assert.equal((svc as unknown as { outcomeSweep: unknown }).outcomeSweep, null,
      'the sweep outlived the service that armed it');
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * The installer routes
 * ------------------------------------------------------------------ */

test('GET/POST /api/hooks-install: status, install, uninstall — behind --allow-writes, against CLAUDE_CONFIG_DIR', async () => {
  const { root, cleanup } = scratch();
  const conf = mkdtempSync(join(tmpdir(), 'pc-conf-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = conf;
  try {
    gitInit(root);
    writeFileSync(join(conf, 'settings.json'), '{\n  "model": "opus"\n}\n', 'utf8');
    const svc = service(root);
    try {
      await settle(svc);
      const before = await call(svc, 'GET', '/api/hooks-install');
      assert.equal(before.status, 200);
      assert.equal((before.payload as { installed: boolean; path: string }).installed, false);
      assert.equal((before.payload as { path: string }).path, join(conf, 'settings.json'));
      // A POST without the console header is refused like every other mutation.
      assert.equal((await call(svc, 'POST', '/api/hooks-install', { action: 'install' })).status, 403);
      const headers = { 'x-phase-console': '1' };
      const installed = await call(svc, 'POST', '/api/hooks-install', { action: 'install' }, { headers });
      assert.equal(installed.status, 200, JSON.stringify(installed.payload));
      assert.equal((installed.payload as { status: { installed: boolean } }).status.installed, true);
      const text = readFileSync(join(conf, 'settings.json'), 'utf8');
      assert.match(text, /^ {2}"model": "opus",\n {2}"hooks": \{/m);
      const written = JSON.parse(text) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
      assert.equal(written.hooks.SessionStart.at(-1)!.hooks[0].command, `bash "${SKILL_DIR}/scripts/session-hook.sh"`);
      assert.equal((await call(svc, 'POST', '/api/hooks-install', { action: 'nonsense' }, { headers })).status, 400);
      const removed = await call(svc, 'POST', '/api/hooks-install', { action: 'uninstall' }, { headers });
      assert.equal(removed.status, 200);
      assert.equal(readFileSync(join(conf, 'settings.json'), 'utf8'), '{\n  "model": "opus"\n}\n', 'byte-identical after uninstall');
    } finally { svc.close(); }
    // Without --allow-writes the write is refused and the file untouched.
    const ro = service(root, { allowWrites: false });
    try {
      await settle(ro);
      assert.equal((await call(ro, 'POST', '/api/hooks-install', { action: 'install' }, { headers: { 'x-phase-console': '1' } })).status, 403);
      assert.equal(readFileSync(join(conf, 'settings.json'), 'utf8'), '{\n  "model": "opus"\n}\n');
    } finally { ro.close(); }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(conf, { recursive: true, force: true });
    cleanup();
  }
});


/* ------------------------------------------------------------------ *
 * Session asks — the waiting flag reaching a push and the inbox
 * ------------------------------------------------------------------ */

test('a session ask announces once per episode: repeats are silent, a new episode re-announces, and the body is the question — never the cwd', async () => {
  const { root, cleanup } = scratch();
  const pushed: { category: string; title: string; tag: string; body: string }[] = [];
  const svc = service(root, {}, (instance) => {
    instance.push.announce = ((category: string, message: { title: string; tag: string; body: string }) => {
      pushed.push({ category, title: message.title, tag: message.tag, body: message.body });
    }) as never as typeof instance.push.announce;
  });
  try {
    await settle(svc);
    const at = (plusMs: number) => new Date(Date.now() - 60_000 + plusMs).toISOString();
    const base = { cwd: root, at: at(0) };

    // A person's own session starts, then hits a permission prompt.
    svc.ingestSessionEvent({ session_id: 'ask-1', event: 'SessionStart', ...base });
    svc.ingestSessionEvent({
      session_id: 'ask-1', event: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash', cwd: root, at: at(1_000),
    });
    const asks = () => pushed.filter((c) => c.category === 'session-ask');
    assert.equal(asks().length, 1, 'the transition announces');
    assert.match(asks()[0].title, /permission/);
    // TRS-6: the audit's one real question reached the phone as a directory.
    assert.match(asks()[0].body, /Claude needs your permission to use Bash/, 'the question itself');
    assert.ok(!asks()[0].body.includes(root), 'and not the cwd');

    // The CLI nags again while still waiting — same episode, same silence.
    svc.ingestSessionEvent({
      session_id: 'ask-1', event: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash', cwd: root, at: at(61_000),
    });
    assert.equal(asks().length, 1, 'a repeat inside the episode is silent — the first push stands');

    // Answered (the turn ends), then a NEW ask: a new episode, a new push.
    svc.ingestSessionEvent({ session_id: 'ask-1', event: 'Stop', cwd: root, at: at(120_000) });
    svc.ingestSessionEvent({
      session_id: 'ask-1', event: 'Notification', notification_type: 'elicitation_dialog',
      message: 'Claude is asking you to choose', cwd: root, at: at(180_000),
    });
    assert.equal(asks().length, 2, 'a new episode earns a new push');
    assert.match(asks()[1].title, /answer/);
    assert.equal(asks()[0].tag, asks()[1].tag, 'one tag per session — repeats collapse on the device');

  } finally {
    svc.close();
    cleanup();
  }
});

test('ACC-8.9 (REG-5): an autopilot lane\'s wait announces in its own right — once — and is deduplicated against a pending card for its phase, logged', async () => {
  const { root, cleanup } = scratch();
  const pushed: { category: string; body: string }[] = [];
  const svc = service(root, { converge: false }, (instance) => {
    instance.push.announce = ((category: string, message: { body: string }) => {
      pushed.push({ category, body: message.body });
    }) as never as typeof instance.push.announce;
  });
  try {
    await settle(svc);
    const at = (plusMs: number) => new Date(Date.now() - 60_000 + plusMs).toISOString();
    const asks = () => pushed.filter((c) => c.category === 'session-ask');
    // The run on disk names the lane's session — the correlation a lane really has.
    const laneAsks = (session: string, phase: number) => {
      runNaming(root, phase, session);
      svc.ingestSessionEvent({ session_id: session, event: 'SessionStart', owner: 'autopilot/ab12cd34', cwd: root, at: at(0) });
      svc.ingestSessionEvent({
        session_id: session, event: 'Notification', notification_type: 'permission_prompt', owner: 'autopilot/ab12cd34',
        message: `Claude needs your permission to use WebFetch (lane ${phase})`, cwd: root, at: at(1_000),
      });
    };

    // No approval channel armed for the lane's phase: the wait is announced, once.
    laneAsks('lane-1', 2);
    assert.equal(asks().length, 1, 'a lane stopped at a prompt is no longer silent');
    assert.match(asks()[0].body, /lane 2/);
    assert.match(asks()[0].body, /alpha phase 2/, 'with the plan and phase it works');
    svc.ingestSessionEvent({
      session_id: 'lane-1', event: 'Notification', notification_type: 'permission_prompt', owner: 'autopilot/ab12cd34',
      message: 'Claude needs your permission to use WebFetch (lane 2)', cwd: root, at: at(30_000),
    });
    assert.equal(asks().length, 1, 'the same episode stays silent');

    // A pending card for THAT phase is already the ask: no second announcement, and the suppression is logged.
    const { approval } = svc.approvals.request({
      runId: 'ab12cd34', slug: 'alpha', phase: 3, kind: 'tool', title: 'Bash: psql', detail: 'd', evidence: [],
    });
    laneAsks('lane-2', 3);
    assert.equal(asks().length, 1, 'deduplicated against the card, not suppressed by kind');
    const suppressed = recentLog(200).filter((entry) => entry.event === 'sessions.ask-suppressed' && entry.data?.sessionId === 'lane-2');
    assert.equal(suppressed.length, 1, 'and the one suppression left says so');
    assert.equal(suppressed[0].data?.approvalId, approval.id);
    svc.approvals.settle(approval.id, 'deny', 'test');
  } finally {
    svc.close();
    cleanup();
  }
});

test('a waiting session is an inbox item — and the registry beat nudges the debounced inbox event', async () => {
  const { root, cleanup } = scratch();
  const svc = service(root);
  try {
    await settle(svc);
    const events: string[] = [];
    svc.onEvent((name: string) => events.push(name));
    svc.ingestSessionEvent({
      session_id: 'ask-2', event: 'SessionStart', cwd: root, at: new Date().toISOString(),
    });
    svc.ingestSessionEvent({
      session_id: 'ask-2', event: 'Notification',
      message: 'Claude needs your permission to use WebFetch', cwd: root, at: new Date().toISOString(),
    });

    const inbox = await svc.attention();
    const item = inbox.items.find((i) => i.kind === 'session-ask');
    assert.ok(item, 'the ask is in the inbox');
    assert.equal(item?.severity, 'urgent', 'a permission prompt is a session parked dead');
    assert.match(item?.title ?? '', /permission/);
    assert.equal(item?.actions.length, 0, "no verb can answer someone else's terminal");
    assert.match(item?.need ?? '', /permission to use WebFetch/, 'the row carries the question');

    // A lane's row carries an answer: the words reach its session as a steer (TRS-6).
    runNaming(root, 2, 'lane-ask');
    svc.ingestSessionEvent({ session_id: 'lane-ask', event: 'SessionStart', owner: 'autopilot/ab12cd34', cwd: root, at: new Date().toISOString() });
    svc.ingestSessionEvent({
      session_id: 'lane-ask', event: 'Notification', notification_type: 'elicitation_dialog', owner: 'autopilot/ab12cd34',
      message: 'Which schema should I migrate first?', cwd: root, at: new Date().toISOString(),
    });
    const lane = (await svc.attention()).items.find((i) => i.kind === 'session-ask' && i.need === 'Which schema should I migrate first?');
    assert.ok(lane, 'a lane waiting on a person is a row in its own right');
    assert.equal(lane?.actions.length, 1);
    assert.equal(lane?.actions[0].verb, 'steer');
    assert.equal(lane?.actions[0].endpoint, '/api/run/alpha/steer');
    assert.deepEqual(lane?.actions[0].body, { phase: 2 });
    assert.equal(lane?.actions[0].says?.field, 'instruction');

    assert.ok(await poll(() => events.includes('inbox'), 5_000),
      'the sessions beat schedules the debounced inbox tick (INBOX_SOURCES includes sessions)');
  } finally {
    svc.close();
    cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * Phase 8 — a session knows its plan
 * ------------------------------------------------------------------ */

/** A run on disk that gave phase `phase` to `sessionId`, as a live run's record reads. */
function runNaming(root: string, phase: number, sessionId: string, status = 'running'): string {
  const state = newRun({ slug: 'alpha', root } as never);
  const record = phaseRecord(state, phase);
  record.sessionId = sessionId;
  record.status = 'running' as never;
  state.status = status as never;
  saveRun(state);
  return state.id;
}

test('a live session with NO lock is named by its run: the registry row carries the plan, the phase and the run id', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    // The incident's shape exactly: the run record names the session and the
    // phase, and there is no lock anywhere — it was released, which is what
    // anonymised the session that was still working.
    const runId = runNaming(root, 3, 's-orphan');
    const svc = service(root);
    try {
      await settle(svc);
      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-orphan', event: 'SessionStart', cwd: root,
        owner: `autopilot/${runId}`, at: new Date().toISOString(),
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));

      const list = await call(svc, 'GET', '/api/sessions/registry');
      const sessions = (list.payload as {
        sessions: { sessionId: string; kind: string; presence: string; plan?: { slug: string; phase: number; strong: boolean; runId?: string } }[];
      }).sessions;
      const row = sessions.find((x) => x.sessionId === 's-orphan')!;
      assert.equal(row.presence, 'live');
      assert.equal(row.kind, 'autopilot');
      // Was `undefined` before this phase — the row rendered plan-less and its
      // link pointed at the page the operator was already on.
      assert.deepEqual(row.plan, { slug: 'alpha', phase: 3, strong: true, runId });
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('a lock still outranks the run, and a run nobody has resolved is the only one that speaks', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const runId = runNaming(root, 3, 's-both');
    // No convergence and no `--allow-run`: nothing may adopt the run on disk,
    // so the disk copy is the only thing that can answer. A live runner's
    // in-memory state legitimately shadows it, which is a different test.
    const svc = service(root, { converge: false, allowRun: false });
    try {
      await settle(svc);
      claim(root, 1, 'sam@laptop', 3600, 's-both');
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);
      await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-both', event: 'SessionStart', cwd: root, user: 'sam', host: 'laptop', at: new Date().toISOString(),
      });

      const read = async () => {
        const list = await call(svc, 'GET', '/api/sessions/registry');
        return (list.payload as { sessions: { sessionId: string; plan?: { slug: string; phase: number; strong: boolean; runId?: string } }[] })
          .sessions.find((x) => x.sessionId === 's-both')?.plan;
      };
      // The lock's own `session=` is the first source and it names phase 1.
      assert.deepEqual(await read(), { slug: 'alpha', phase: 1, strong: true });

      // Drop the lock and the run answers instead — that is the whole point.
      rmSync(lockPath(join(root, 'docs', 'handoffs'), 'alpha', 1), { force: true });
      svc.store?.refresh([join(root, 'docs', 'handoffs', 'alpha', '.locks')]);
      assert.deepEqual(await read(), { slug: 'alpha', phase: 3, strong: true, runId });

      // Resolve the run: a run somebody has closed out makes no claim about any
      // session, so the honest answer is silence rather than a stale phase.
      const state = latestRun(root, 'alpha')!;
      assert.equal(state.id, runId);
      state.resolved = { at: new Date().toISOString(), by: 'operator', reason: 'closed' } as never;
      saveRun(state);
      assert.equal(await read(), undefined);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/* ------------------------------------------------------------------ *
 * Zero-touch phase 16 — the backlog, the inbox without a console, the peers
 * ------------------------------------------------------------------ */

const { INSTANCE_STATE_DIR } = await import('../server/config.ts');
const SESSIONS_DIR = join(INSTANCE_STATE_DIR, 'sessions');
const INBOX_DIR = join(SESSIONS_DIR, 'inbox');

/** One presence drop exactly as the hook writes it: tmp + rename, a millisecond name. */
function drop(n: number, payload: Record<string, unknown>): void {
  mkdirSync(INBOX_DIR, { recursive: true });
  const file = join(INBOX_DIR, `${Date.now()}${String(n).padStart(4, '0')}-${String(payload.session_id)}-${String(payload.event)}.json`);
  writeInbox(file, `${JSON.stringify({ version: 1, ...payload })}\n`);
}

/**
 * ACC-6.6 (SHD-7). `load()` ingests the inbox before it prunes, so on a deep
 * inbox the moves at the BACK of the construction backlog are the ingested
 * events — and the old bound dropped the newest by arrival: a `SessionEnd`
 * whose lock was debris, lost with no way to re-raise the reaction, the lock
 * standing for its two-hour lease. Now the bound bites by kind.
 */
test('ACC-6.6 (SHD-7): with the backlog exceeded during construction, every SessionEnd is applied — lock debris released — and only prune/heartbeat are ever dropped', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    // The debris the reaction exists for: a person's claim, naming its session.
    const lock = claim(root, 2, 'sam@laptop', 3600, 's-backlog-gone');
    // A run of the plan for converge to act on.
    const state = newRun({ slug: 'alpha', root, autoRecover: false });
    state.status = 'halted';
    state.halt = { at: new Date().toISOString(), reason: 'x' };
    Object.assign(phaseRecord(state, 2), { status: 'failed', attempts: 1 });
    saveRun(state);

    // 520 real moves (turns of one busy session), then the SessionEnd — the
    // 521st, the one the old bound threw away — then 30 records old enough to
    // prune, whose `prune` moves arrive last.
    const base = Date.now() - 5 * 60_000;
    for (let i = 0; i < 520; i++) {
      drop(i, { session_id: 's-backlog-busy', event: 'Stop', cwd: root, at: new Date(base + i).toISOString() });
    }
    drop(9999, { session_id: 's-backlog-gone', event: 'SessionEnd', cwd: root, reason: 'other', at: new Date(base + 60_000).toISOString() });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(SESSIONS_DIR, `s-backlog-old-${i}.json`), JSON.stringify({
        sessionId: `s-backlog-old-${i}`, kind: 'foreign', cwd: root, startedAt: old, lastSeen: old, endedAt: old, turns: 0,
      }), 'utf8');
    }

    // What reached the reaction, and when — the prototype's method, observed.
    const applied: string[] = [];
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = 3_600_000;
      const internals = s as unknown as { onPresenceChange: (record: { sessionId: string }, event: string, meta?: unknown) => void };
      const original = internals.onPresenceChange.bind(s);
      internals.onPresenceChange = (record, event, meta) => { applied.push(`${event}:${record.sessionId}`); original(record, event, meta); };
    });
    try {
      await settle(svc);
      const full = recentLog(200).filter((entry) => entry.event === 'sessions.presence-backlog-full').at(-1);
      assert.ok(full, 'the bound bit, and said so once at the flush');
      const dropped = full.data?.dropped as Record<string, number>;
      const deferred = full.data?.deferred as Record<string, number>;
      assert.deepEqual(
        Object.keys(dropped).filter((kind) => kind !== 'prune' && kind !== 'heartbeat'), [],
        `only droppable kinds appear under dropped: ${JSON.stringify(dropped)}`,
      );
      assert.equal(dropped.prune, 30, 'the prunes were the moves thrown away');
      assert.equal(deferred.SessionEnd, 1, 'the SessionEnd was deferred, never dropped');
      assert.equal(svc.sessions.presence('s-backlog-gone'), 'ended', 'its record was persisted all along');
      assert.equal(applied.filter((move) => move === 'SessionEnd:s-backlog-gone').length, 0, 'deferred: its reaction has not run yet');
      assert.equal(applied.filter((move) => move.startsWith('Stop:')).length, 500, 'the backlog held its bound of real moves');

      // The registry's poll re-applies what the backlog deferred — the reaction
      // the old bound lost for good.
      svc.sessions.poll();
      assert.equal(applied.filter((move) => move === 'SessionEnd:s-backlog-gone').length, 1, 'the SessionEnd reached the reaction');
      assert.ok(recentLog(200).some((entry) => entry.event === 'sessions.presence-reconciled'), 'journalled as reconciled');
      assert.ok(await poll(() => !existsSync(lock), 10_000), 'and its lock is released as debris');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/**
 * ACC-7.1, the REG-2 half. The inbox replays as history, not as news: a drop
 * two hours old is applied with its lateness and raises no `session-ask`,
 * while one a minute old does — and the inbox's depth is on the shutdown
 * readiness, because stopping the console stops the reading.
 */
test('ACC-7.1 (REG-2): an inbox drop two hours old applies on load() with its lateness and raises no session-ask; one a minute old does; depth is on shutdownReadiness()', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    const announced: { category: string; title: string; body: string }[] = [];
    const twoHours = Date.now() - 2 * 60 * 60_000;
    const minute = Date.now() - 60_000;
    for (const [n, id, at] of [[1, 's-late-ask', twoHours], [3, 's-fresh-ask', minute]] as const) {
      drop(n, { session_id: id, event: 'SessionStart', cwd: root, pid: process.pid, at: new Date(at - 1_000).toISOString() });
      drop(n + 1, {
        session_id: id, event: 'Notification', cwd: root, pid: process.pid, notification_type: 'permission_prompt',
        message: `${id} needs permission to use Bash`, at: new Date(at).toISOString(),
      });
    }
    const svc = service(root, {}, (s) => {
      s.prefs.convergeEveryMs = 3_600_000;
      s.push.announce = ((category: string, message: { title: string; body: string }) => {
        announced.push({ category, title: message.title, body: message.body });
      }) as typeof s.push.announce;
    });
    try {
      await settle(svc);
      const late = svc.sessions.get('s-late-ask')!;
      assert.ok(late, 'the two-hour-old drop was applied');
      assert.equal(late.lastEvent?.via, 'inbox');
      assert.ok((late.lastEvent?.lateMs ?? 0) >= 2 * 60 * 60_000 - 5_000, `lateness recorded: ${late.lastEvent?.lateMs}`);
      assert.equal(late.lastEvent?.history, true, 'past the horizon: history');
      const fresh = svc.sessions.get('s-fresh-ask')!;
      assert.equal(fresh.lastEvent?.history, undefined, 'a minute late is news');
      assert.ok((fresh.lastEvent?.lateMs ?? 0) >= 55_000);

      const asks = announced.filter((a) => a.category === 'session-ask');
      assert.ok(asks.some((a) => a.body.includes('s-fresh-ask')), `the fresh ask is pushed: ${JSON.stringify(asks)}`);
      assert.equal(asks.filter((a) => a.body.includes('s-late-ask')).length, 0, 'the two-hour-old ask raises no session-ask — asking nor unanswered');
      // Past the answer cap before it was even read, so the same load closed it
      // unanswered — a fact on the record, and still not a push.
      assert.equal(svc.sessions.get('s-late-ask')?.lastWait?.outcome, 'unanswered');

      // Depth: stop the registry's reading, write two drops, and the readiness
      // counts them — what a shutdown would leave unread.
      svc.sessions.close();
      drop(7, { session_id: 's-unread-1', event: 'Stop', cwd: root, at: new Date().toISOString() });
      drop(8, { session_id: 's-unread-2', event: 'Stop', cwd: root, at: new Date().toISOString() });
      const readiness = svc.shutdownReadiness();
      assert.equal(readiness.inventory.inboxDepth.sessions, 2);
      assert.equal(readiness.empty, false, 'unread presence is something a shutdown stops reading');
    } finally {
      svc.close();
      rmSync(INBOX_DIR, { recursive: true, force: true });
    }
  } finally { cleanup(); }
});

/**
 * ACC-7.3, the REG-3 half. Every registry consultation on a decision path was
 * reached THROUGH a lock, so a session that started and had not claimed — the
 * first minute of every hand session — was invisible to the lane about to
 * board beside it. Presence now speaks with no lock at all.
 */
test('ACC-7.3 (REG-3): a live foreign session in the plan\'s root with no lock on disk queues an admission with the peer named, spawns nothing, and is the classifier\'s registry witness', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, { converge: false });
    try {
      await settle(svc);
      // A REAL process for the peer, because this test needs it genuinely alive
      // for the first half and genuinely gone for the second (PRS-1). It used to
      // register `process.pid` — the test runner's own — and then end the
      // session while that process kept running, which is the `/clear` shape:
      // the hook says ended, the pid says otherwise, and presence is now
      // `unknown`, which blocks. Both halves of this test are about the other
      // case, so the pid has to actually die.
      const peerProc = spawnProcess('sleep', ['120'], { stdio: 'ignore' });
      const peerPid = peerProc.pid!;
      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-hand', event: 'SessionStart', cwd: root, root, pid: peerPid,
        user: 'sam', host: 'laptop', source: 'startup', at: new Date().toISOString(),
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));
      assert.equal(existsSync(lockPath(join(root, 'docs', 'handoffs'), 'alpha', 2)), false, 'no lock on disk');

      // Admission for phase 2: blocked, the holder is the SESSION, named.
      const request = { slug: 'alpha', phase: 2, runId: 'peer-test-run', scope: ['app'] };
      const holders = svc.scheduler.wouldBlock(request);
      const peer = holders.find((holder) => holder.kind === 'session');
      assert.ok(peer, `a session holder: ${JSON.stringify(holders)}`);
      assert.equal(peer.session, 's-peer-hand');
      assert.equal(peer.pid, peerPid);
      assert.equal(peer.cwd, root);
      assert.equal(peer.presence, 'live');
      assert.match(peer.owner, /^session s-peer-h/);

      // And it queues — nothing is granted, so nothing can spawn — until the
      // peer ends, which wakes the scan.
      let granted: unknown = null;
      const admission = svc.scheduler.admit(request).then((grant) => { granted = grant; return grant; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(granted, null, 'queued behind the peer: no grant, no spawn');

      // The classifier reads the same peer with no lock: `foreign-live` from presence alone.
      const { evidence, situation } = await svc.classifyPhase('alpha', 2, null, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.lock, null);
      assert.equal(evidence.registry?.peer, true);
      assert.equal(evidence.registry?.sessionId, 's-peer-hand');
      assert.equal(situation.id, 'foreign-live');

      // A second session starting in the root is told the first is there.
      const second = await call(svc, 'POST', '/hooks/session', {
        // No pid: this one exists only to read the peers sentence back, and it
        // ends immediately below. With the TEST RUNNER's pid it would end while
        // its process kept running — the `/clear` shape — and read `unknown`
        // (PRS-1), which blocks the admission just as a live peer does.
        version: 1, session_id: 's-peer-second', event: 'SessionStart', cwd: root, root, at: new Date().toISOString(),
      });
      assert.match(String((second.payload as { peers?: string }).peers), /s-peer-h/);
      await call(svc, 'POST', '/hooks/session', { version: 1, session_id: 's-peer-second', event: 'SessionEnd', cwd: root, root, at: new Date().toISOString() });

      // The peer's process really goes, and only then does its session end —
      // the ordinary "that window is closed" case, as opposed to `/clear`.
      peerProc.kill('SIGKILL');
      await new Promise((resolve) => { peerProc.on('exit', resolve); });
      await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-hand', event: 'SessionEnd', cwd: root, root, reason: 'other', at: new Date().toISOString(),
      });
      const grant = await Promise.race([admission, new Promise((resolve) => setTimeout(() => resolve('still-queued'), 5_000))]);
      assert.notEqual(grant, 'still-queued', 'the peer ended: the admission is granted');
      svc.scheduler.release(grant as never);
    } finally { svc.close(); }
  } finally { cleanup(); }
});

/**
 * REG-3's window has an END. "The first minute of every hand session" used to
 * last as long as the process: every `claude` a person left open in the root
 * held every phase in the repository, so three terminals doing unrelated work
 * kept a whole plan queued with no lock anywhere. A session that is not on THIS
 * phase is a peer only until `PEER_CLAIM_WINDOW_MS` after its newest start.
 */
test('REG-3 claim window: a session that started in the root longer ago than the window and never claimed holds nothing — a resume re-opens the window, a compaction does not', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    const svc = service(root, { converge: false });
    try {
      await settle(svc);
      const request = { slug: 'alpha', phase: 2, runId: 'window-test-run', scope: ['app'] };
      const sessionHolders = () => svc.scheduler.wouldBlock(request).filter((holder) => holder.kind === 'session');

      // A person's session, started in the root past the window: alive, no lock, correlated to nothing.
      const started = await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-idle', event: 'SessionStart', cwd: root, root, pid: process.pid,
        user: 'sam', host: 'laptop', source: 'startup', at: new Date(Date.now() - PEER_CLAIM_WINDOW_MS - 60_000).toISOString(),
      });
      assert.equal(started.status, 200, JSON.stringify(started.payload));
      assert.equal(existsSync(lockPath(join(root, 'docs', 'handoffs'), 'alpha', 2)), false, 'no lock on disk');
      assert.equal(svc.sessions.presence('s-peer-idle'), 'live', 'still live — the window lets the phase go, not presence');
      assert.deepEqual(sessionHolders(), [], 'its claim window has closed: it holds nothing');

      const { evidence, situation } = await svc.classifyPhase('alpha', 2, null, { 1: 'done', 2: 'ready', 3: 'waiting' });
      assert.equal(evidence.registry ?? null, null, 'no registry witness');
      assert.notEqual(situation.id, 'foreign-live');

      // A compaction is the same session carrying on: the window stays shut.
      await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-idle', event: 'SessionStart', cwd: root, root, pid: process.pid,
        source: 'compact', at: new Date().toISOString(),
      });
      assert.deepEqual(sessionHolders(), [], 'a compaction re-opens nothing');

      // A person resuming it may be about to claim: the window opens again, and the holder says when it shuts.
      const resumedAt = Date.now();
      await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-idle', event: 'SessionStart', cwd: root, root, pid: process.pid,
        source: 'resume', at: new Date(resumedAt).toISOString(),
      });
      const [resumed] = sessionHolders();
      assert.ok(resumed, 'a resume re-opens the window');
      assert.equal(resumed.session, 's-peer-idle');
      assert.equal(resumed.leaseUntil, resumedAt + PEER_CLAIM_WINDOW_MS, 'the hold lapses when the window shuts');
    } finally { svc.close(); }
  } finally { cleanup(); }
});

test('REG-3 claim window: a session working THIS phase holds it past the window — the window bounds who might be about to claim, never who is at work', async () => {
  const { root, cleanup } = scratch();
  try {
    gitInit(root);
    handoff(root, 1, 'schema', 'complete');
    // The person's own claim on phase 2 — no `--session`, so it names them by owner only — whose
    // lease ran out while the session that took it is still at work.
    claim(root, 2, 'sam@laptop', -60);
    const svc = service(root, { converge: false });
    try {
      await settle(svc);
      await call(svc, 'POST', '/hooks/session', {
        version: 1, session_id: 's-peer-at-work', event: 'SessionStart', cwd: root, root, pid: process.pid,
        user: 'sam', host: 'laptop', source: 'startup', at: new Date(Date.now() - PEER_CLAIM_WINDOW_MS - 60_000).toISOString(),
      });
      const holders = svc.scheduler.wouldBlock({ slug: 'alpha', phase: 2, runId: 'window-test-run', scope: ['app'] });
      const peer = holders.find((holder) => holder.kind === 'session');
      assert.ok(peer, `still a holder past the window: ${JSON.stringify(holders)}`);
      assert.equal(peer.session, 's-peer-at-work');
      assert.equal(peer.phase, 2, 'named with the phase it works');
      assert.equal(peer.leaseUntil, undefined, 'working the phase is not a window: nothing lapses');
    } finally { svc.close(); }
  } finally { cleanup(); }
});
