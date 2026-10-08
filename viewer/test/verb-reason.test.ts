/**
 * A reason on every operator verb (control-tower phase 96, #142).
 *
 * The watchdog's log of 2026-09-26 reads "06:53 paused trade, to resume on P66
 * with a fresh replay writer"; the console's record of the same act is
 * `run.pause-requested` with no why. Bump, pause, retry, steer and the rest
 * took a request body with nowhere to put a reason, so the one party that knew
 * why kept it somewhere the console could not see.
 *
 * RE-1: the request's `reason` rides the DERIVED actor — trimmed, capped, and
 *       absent when nobody gave one — so every line that spreads the actor
 *       carries it, `journalStoredEdit`'s included.
 * RE-2: each verb's own journal line carries it: bump, pause, resume-phase,
 *       retry, steer, clear-streak, switch-account, hold and release; and an
 *       approval's decided line keeps the reason the decision was given.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { actorOfRequest, ACTOR_REASON_MAX } = await import('../server/api/actor.ts');
type RunState = import('../server/runner/state.ts').RunState;
type JournalEntry = import('../server/runner/journal.ts').JournalEntry;
type Actor = import('../server/runner/state.ts').Actor;

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const PLAN = `---
slug: alpha
created: 2026-09-26
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | schema | — | — | app | it works |
| 2 | cart api | 1 | — | app | it still works |

## Phases

### Phase 1 — schema
- **Size:** S

### Phase 2 — cart api
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-verb-reason-'));
  trash.push(root);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

function storedRun(root: string, over: Partial<RunState> = {}): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.activePhase = 2;
  state.accounts = [{ id: 'default', minHeadroomPct: 15 }];
  phaseRecord(state, 2).status = 'parked';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

type Captured = { status: number; body: Record<string, unknown> };

async function post(svc: unknown, path: string, body: unknown): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: {} };
  const payload = JSON.stringify(body);
  const req = {
    method: 'POST',
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' },
    socket: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(payload, 'utf8'); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text) as Record<string, unknown>; } catch { out.body = { text }; }
    },
    setHeader() { return this; },
    on() { return this; },
  };
  await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

function lines(root: string, runId: string, event: string): JournalEntry[] {
  return readFileSync(journalFile(root, 'alpha', runId), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEntry)
    .filter((entry) => entry.event === event);
}

const BROWSER = { headers: { host: '127.0.0.1:4130', 'user-agent': 'Mozilla/5.0' } };
const WHY = 'P67 depends on P66 and was queued ahead of it';
const PRESS: Actor = { by: 'mobin', via: 'api', origin: 'local', remoteUser: null, reason: WHY };

/* ------------------------------------------------------------------ *
 * RE-1 — the reason rides the derived actor
 * ------------------------------------------------------------------ */

test('RE-1: actorOfRequest carries the body\'s reason — trimmed, capped, and absent when there is none', () => {
  assert.equal(actorOfRequest(BROWSER, {}, { reason: `  ${WHY}  ` }).reason, WHY);
  for (const none of [{}, { reason: '   ' }, { reason: 42 }, { reason: null }]) {
    assert.equal('reason' in actorOfRequest(BROWSER, {}, none), false,
      `a key with nothing in it reads as a reason somebody gave: ${JSON.stringify(none)}`);
  }
  assert.equal(actorOfRequest(BROWSER, {}, { reason: 'x'.repeat(5_000) }).reason?.length, ACTOR_REASON_MAX);
  // The who is unchanged by the why.
  const actor = actorOfRequest(BROWSER, {}, { by: 'mobin', reason: WHY });
  assert.deepEqual({ ...actor }, { by: 'mobin', via: 'api', origin: 'local', remoteUser: null, pressDoor: 'local', reason: WHY });
});

/* ------------------------------------------------------------------ *
 * RE-2 — each verb's own line carries it
 * ------------------------------------------------------------------ */

test('RE-2: hold, release and clear-streak on a stored run journal the reason they were given', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root, { consecutiveFailures: 2, maxConsecutiveFailures: 2 });
    assert.equal((await post(svc, '/api/run/alpha/hold', { reason: 'let P66 finish first' })).status, 200);
    assert.equal((await post(svc, '/api/run/alpha/release', { reason: 'P66 landed' })).status, 200);
    const cleared = await post(svc, '/api/run/alpha/clear-streak', { reason: 'an outage spent it' });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));

    assert.deepEqual(lines(root, run.id, 'run.held').map((line) => [line.data?.reason, line.data?.by]), [['let P66 finish first', 'operator']]);
    assert.deepEqual(lines(root, run.id, 'run.released').map((line) => line.data?.reason), ['P66 landed']);
    assert.deepEqual(lines(root, run.id, 'run.failure-streak-reset').map((line) => line.data?.reason), ['an outage spent it']);
  } finally {
    svc.close();
  }
});

test('RE-2: a stored switch-account carries the reason through journalStoredEdit', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    assert.equal(svc.switchAccountRun('alpha', 'acct-b', PRESS as never).ok, true);
    const [line] = lines(root, run.id, 'run.account-switch');
    assert.equal(line?.data?.reason, WHY);
    assert.equal(line?.data?.stored, true);
  } finally {
    svc.close();
  }
});

test('RE-2: a bump journals on the bumped entry\'s run, with its reason', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    // One queued entry of this run, without admitting a real session.
    const scheduler = (svc as unknown as {
      scheduler: { bump: (id: string) => boolean; entry: (id: string) => unknown };
    }).scheduler;
    scheduler.entry = (id: string) => (id === 'e-66' ? { id, slug: 'alpha', runId: run.id, phase: 2 } : undefined);
    scheduler.bump = (id: string) => id === 'e-66';
    const out = await post(svc, '/api/queue/bump', { entryId: 'e-66', reason: WHY });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const [line] = lines(root, run.id, 'phase.queue-bumped');
    assert.ok(line, 'a bump is an operator\'s decision, and it left nothing in the run\'s history');
    assert.equal(line!.phase, 2);
    assert.equal(line!.data?.entryId, 'e-66');
    assert.equal(line!.data?.reason, WHY);
    assert.equal(line!.data?.by, 'operator');
    assert.equal((await post(svc, '/api/queue/bump', { entryId: 'gone' })).status, 404);
  } finally {
    svc.close();
  }
});

test('RE-2: resume-phase journals the press and its reason before it acts', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    // No real session may board from a test: the press is refused past the
    // point where it has been recorded.
    (svc as unknown as { startRun: () => Promise<never> }).startRun = async () => { throw new Error('no boarding in a test'); };
    await post(svc, '/api/run/alpha/resume-phase', { phase: 2, instruction: 'carry on from the schema', reason: 'the lock was released' });
    const [line] = lines(root, run.id, 'phase.resume-pressed');
    assert.ok(line, 'the press left no line');
    assert.equal(line!.phase, 2);
    assert.equal(line!.data?.mode, 'resume');
    assert.equal(line!.data?.reason, 'the lock was released');
    assert.equal(line!.data?.by, 'operator');
  } finally {
    svc.close();
  }
});

test('RE-2: an approval\'s decided line keeps the reason it was decided with', () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = storedRun(root);
    const now = new Date().toISOString();
    (svc as unknown as { journalApproval: (event: string, approval: Record<string, unknown>) => void }).journalApproval('decided', {
      id: 'ap-22', runId: run.id, slug: 'alpha', phase: 2, kind: 'tool', title: 'git pull --rebase --autostash',
      status: 'deny', decidedBy: 'mobin', createdAt: now, decidedAt: now, expiresAt: now,
      reason: 'not in the shared checkout',
    });
    const [line] = lines(root, run.id, 'phase.approval-decided');
    assert.equal(line?.data?.decision, 'deny');
    assert.equal(line?.data?.reason, 'not in the shared checkout');
  } finally {
    svc.close();
  }
});

/** A runner holding a live run, its journal open — the verbs asked directly. */
function live(root: string) {
  const runner = new Runner({ scriptsDir: join(SKILL_DIR, 'scripts'), spawn: async () => { throw new Error('no spawn'); } } as never);
  const state = newRun({ slug: 'alpha', root });
  state.status = 'running';
  state.activePhase = 2;
  phaseRecord(state, 2).status = 'running';
  saveRun(state);
  const inner = runner as unknown as { state: RunState; journal: unknown; driving: boolean; handle: unknown };
  inner.state = state;
  inner.journal = Journal.for(root, 'alpha', state.id);
  inner.driving = true;
  return { runner, state };
}

test('RE-2: a live run\'s pause, hold, release, clear-streak, steer and retry each journal their reason', () => {
  const root = scratch();
  const { runner, state } = live(root);

  assert.equal(runner.hold('mobin', 'let the other plan go first'), true);
  assert.equal(runner.releaseHold('mobin', 'it went'), true);
  runner.clearStreak('mobin', 'clear-streak', 'the outage is over');
  runner.retry(2, undefined, { press: true, reason: 'the flake is fixed on main' });

  (runner as unknown as { handle: unknown }).handle = { open: () => true, send: () => true, pid: 1 };
  const steered = runner.steer('keep the old schema', 'mobin', undefined, null, 'phase 3 reads it');
  assert.equal(steered.ok, true, steered.reason);

  assert.equal(runner.pause(PRESS), true);

  const of = (event: string) => lines(root, state.id, event).map((line) => line.data?.reason);
  assert.deepEqual(of('run.held'), ['let the other plan go first']);
  assert.deepEqual(of('run.released'), ['it went']);
  assert.deepEqual(of('run.failure-streak-reset'), ['the outage is over']);
  assert.deepEqual(of('phase.retry-requested'), ['the flake is fixed on main']);
  assert.deepEqual(of('phase.steered'), ['phase 3 reads it']);
  assert.deepEqual(of('run.pause-requested'), [WHY]);
  // …and a verb given no reason writes no key, rather than an empty one.
  assert.equal(runner.hold('mobin'), true);
  const held = lines(root, state.id, 'run.held');
  assert.equal(held.length, 2);
  assert.equal('reason' in (held[1]!.data ?? {}), false);
});
