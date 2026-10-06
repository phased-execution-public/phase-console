/**
 * A child that outlives its console (#21, #23).
 *
 * When a console dies and launchd brings it back, the `claude -p` children it
 * spawned survive at PPID 1 and keep working — committing, pushing, writing a
 * handoff. The new console adopts their hook tokens and parks their runs, which
 * is by design; what was not right is everything around it. The token proved
 * which run was calling and the lookup searched only LIVE runners, so ninety
 * hook calls in forty-five minutes were answered under the strictest profile
 * with no run context at all: cards nobody could attribute, no auto-grant, an
 * hour lost per ask. A Recover press wrote an errand about abandoned work while
 * the pid was producing commits. The relaunch deleted the orphan's own outcome
 * declaration before reading it. And Stop refused with "kill the pid yourself".
 *
 * Six cases, OR-1..OR-6, one per seam — and OR-7 (control-tower phase 110,
 * #175): a child record from before launchers were recorded is still an
 * orphan on the read path, and that park is journalled. The same-console rule
 * itself is `orphan-same-console.test.ts` (OR-8..OR-11).
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { log } = await import('../server/log.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { forgetPid } = await import('../server/pid.ts');
const { journalFile, runFile } = await import('../server/runner/run-paths.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { outcomeFileFor } = await import('../server/runner/outcome.ts');
type RunState = import('../server/runner/state.ts').RunState;
type Approval = import('../server/runner/approvals.ts').Approval;

/** The run journal, as lines. */
function journalOf(root: string, id: string): { event: string; data?: Record<string, unknown> }[] {
  return readFileSync(journalFile(root, 'alpha', id), 'utf8')
    .split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> });
}

const PLAN = `---
slug: alpha
created: 2026-09-22
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
  const root = mkdtempSync(join(tmpdir(), 'pc-orphan-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  return root;
}

function handoff(root: string, phase: number, title: string, status: string): void {
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', `phase-0${phase}-${title}.md`), `---
plan: docs/plans/alpha.md
phase: ${phase}
title: ${title}
status: ${status}
---
# Phase ${phase}
`, 'utf8');
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    allowAccounts: true, scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/**
 * A run parked on an orphan: phase 2 `running`, a recorded child, and — unless
 * the caller says otherwise — a pid that is still alive. `process.pid` is the
 * one pid a test can be certain of; it is never signalled here.
 */
function orphanedRun(root: string, over: Partial<RunState> = {}, childPid = process.pid): RunState {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.activePhase = 2;
  state.halt = {
    at: new Date().toISOString(), kind: 'orphaned-session', phase: 2,
    reason: `a session from an earlier console is still running (pid ${childPid}, phase 2). `
      + 'Let it finish or stop it, then continue this run.',
  };
  const record = phaseRecord(state, 2);
  record.status = 'running';
  record.sessionId = 'sess-2';
  record.startedAt = new Date().toISOString();
  record.attemptStartedAt = record.startedAt;
  state.children = {
    2: {
      pid: childPid, phase: 2, sessionId: 'sess-2', startedAt: record.startedAt,
      // The identity half of the `(pid, start-time)` tuple. This process's own
      // start, so the probe can confirm the pid really is what the record says.
      procStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
  };
  Object.assign(state, over);
  saveRun(state);
  return state;
}

function decision(reply: Record<string, unknown>): { permissionDecision: string; permissionDecisionReason: string } {
  return (reply as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } })
    .hookSpecificOutput;
}

/** The queue, as the hook path fills it. */
function pending(svc: InstanceType<typeof Service>): Approval[] {
  return (svc as unknown as { approvals: { pending(): Approval[] } }).approvals.pending();
}

/** Poll `read` until `ready` says so, or give up and let the assertion say what was there. */
async function until<T>(read: () => T, ready: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    value = read();
  }
  return value;
}

/** Collect the log events written while `fn` runs, without losing them from the log. */
async function warnings(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const real = log.warn;
  log.warn = (event: string, data?: Record<string, unknown>) => { seen.push(event); real(event, data); };
  try { await fn(); } finally { log.warn = real; }
  return seen;
}

const READ = { tool_name: 'Read', tool_input: { file_path: '/tmp/anything' } };
const WRAPPED = { tool_name: 'Bash', tool_input: { command: 'flock /tmp/lock ./job.sh' } };

test('OR-1: an adopted token is answered under the STORED run\'s profile, not the guarded fallback', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = orphanedRun(root, { permissionProfile: 'bypass' });
    // Nothing drives this run: its console is gone. The token still names it,
    // and the record on disk still says what it was launched as.
    const answer = decision(await svc.decideToolUse(READ, run.id));
    assert.equal(answer.permissionDecision, 'allow');
    assert.match(
      answer.permissionDecisionReason, /bypass profile/,
      'a call from an orphan was classified under `guarded` instead of the profile its own record names',
    );
  } finally {
    svc.close();
  }
});

test('OR-2: the card an orphan raises carries its slug and phase', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    // `guarded`, auto-grant off for this phase: the wrapper is the one shape
    // held back for a person even with auto-grant on, and this is the queue
    // entry an operator has to be able to attribute.
    const run = orphanedRun(root, {
      permissionProfile: 'guarded',
      phaseOptions: { 2: { autoApprove: false } },
    });
    const asked = svc.decideToolUse(WRAPPED, run.id);
    // The card goes up once the evidence behind it has been gathered, which
    // shells out to the engine — so this waits for it rather than guessing.
    const cards = await until(() => pending(svc), (list) => list.length > 0);
    assert.equal(cards.length, 1, 'the orphan\'s ask raised no card');
    assert.equal(cards[0]!.slug, 'alpha');
    assert.equal(cards[0]!.runId, run.id);
    assert.equal(cards[0]!.phase, 2);
    (svc as unknown as { approvals: { disarm(runId?: string): void } }).approvals.disarm(run.id);
    await asked;
  } finally {
    svc.close();
  }
});

test('OR-3: hook.run-unknown is reserved for a token no record explains', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = orphanedRun(root, { permissionProfile: 'bypass' });
    const explained = await warnings(async () => { await svc.decideToolUse(READ, run.id); });
    assert.equal(
      explained.includes('hook.run-unknown'), false,
      'a token whose run is on disk was reported as a run this console knows nothing about',
    );
    const stranger = await warnings(async () => { await svc.decideToolUse(READ, 'deadbeefcafe'); });
    assert.equal(stranger.includes('hook.run-unknown'), true);
  } finally {
    svc.close();
  }
});

test('OR-4: Recover on a run whose orphan is running answers waiting, and writes no errand', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    const run = orphanedRun(root);
    const answer = await svc.recoverPlan('alpha', { by: 'operator' } as never);
    assert.equal(answer.outcome, 'waiting', `Recover answered ${answer.outcome} about a pid that is still working`);
    assert.equal(answer.pid, process.pid);
    assert.equal(answer.sessionId, 'sess-2');
    assert.equal(answer.errand, undefined, 'an errand was written about work that is still in flight');
    const after = JSON.parse(readFileSync(runFile(root, 'alpha', run.id), 'utf8')) as RunState;
    assert.equal(after.errand, undefined);
  } finally {
    svc.close();
  }
});

test('OR-5: the armed outcome file is read and journalled before it is consumed', () => {
  const root = scratch();
  const run = orphanedRun(root, {}, 1);   // pid 1 never holds a session's work
  // The orphan declared and exited. Its word is still in the file the next
  // spawn is about to arm.
  const file = outcomeFileFor(root, 'alpha', run.id, 2);
  writeFileSync(file, `${JSON.stringify({
    version: 1, slug: 'alpha', phase: 2, status: 'complete',
    reason: 'phase 2 verified and handed off', watch: [],
    written_at: new Date().toISOString(), session_id: 'sess-2',
  })}\n`, 'utf8');

  const runner = new Runner({ scriptsDir: '/nonexistent', verificationText: () => undefined });
  Object.assign(runner as unknown as { state: RunState; journal: unknown }, {
    state: run, journal: new Journal(root, 'alpha', run.id),
  });
  const armed = (runner as unknown as { armOutcomeFile(phase: number): string }).armOutcomeFile(2);
  assert.equal(armed, file);
  assert.equal(existsSync(file), false, 'the file is still armed — the delete is the point of the helper');

  const outcome = journalOf(root, run.id).find((line) => line.event === 'phase.outcome');
  assert.ok(outcome, 'the declaration was deleted without being read');
  assert.equal(outcome!.data?.via, 'armed-file');
  assert.equal(outcome!.data?.status, 'complete');
});

test('OR-6: Stop on a foreign console\'s child goes through the kill ladder, and a mismatched identity is refused', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    handoff(root, 2, 'cart-api', 'in-progress');
    const run = orphanedRun(root);
    const signalled: number[] = [];
    (svc as unknown as { killForeignChild: unknown }).killForeignChild =
      (pid: number) => { signalled.push(pid); return Promise.resolve('killed' as const); };

    await svc.stopRun('alpha', 2, { by: 'operator' } as never);
    assert.deepEqual(signalled, [process.pid], 'the console refused instead of signalling a pid it can identify');

    const stop = journalOf(root, run.id).find((line) => line.event === 'run.stop-requested');
    assert.ok(stop, 'the stop was not journalled');
    assert.equal(stop!.data?.foreign, true);
  } finally {
    svc.close();
  }
});

test('OR-6: a recorded child whose process identity does not match is refused, not signalled', async () => {
  const root = scratch();
  const svc = service(root);
  try {
    // The recorded start time is not this process's: the pid has been recycled,
    // and signalling it would reach a stranger.
    orphanedRun(root, {
      children: {
        2: {
          pid: process.pid, phase: 2, sessionId: 'sess-2',
          startedAt: new Date().toISOString(), procStartedAt: '1999-01-01T00:00:00.000Z',
        },
      },
    });
    forgetPid();
    const signalled: number[] = [];
    (svc as unknown as { killForeignChild: unknown }).killForeignChild =
      (pid: number) => { signalled.push(pid); return Promise.resolve('killed' as const); };

    await assert.rejects(
      () => svc.stopRun('alpha', 2, { by: 'operator' } as never),
      /identit/i,
      'a pid whose start time disagrees with the record was signalled anyway',
    );
    assert.deepEqual(signalled, []);
  } finally {
    svc.close();
  }
});

test('OR-7: a child no launcher was recorded for is still an orphan on the read path — and the park is journalled (#175)', async () => {
  const { clearRunFileCache, flushRunSaves, listRuns } = await import('../server/runner/state.ts');
  const root = scratch();
  // A record an older console wrote: a live session, and no word on who launched
  // it. "I cannot tell" is never "it is mine" — the run is parked, as before.
  const state = orphanedRun(root, { status: 'running', halt: null });
  clearRunFileCache();
  const [read] = listRuns(root, 'alpha', null);
  assert.equal(read?.status, 'parked');
  assert.equal(read?.halt?.kind, 'orphaned-session');
  flushRunSaves();
  const parks = journalOf(root, state.id).filter((line) => line.event === 'run.orphaned');
  assert.equal(parks.length, 1, 'the park is a journal line, not a record edit nobody can date');
  assert.deepEqual(parks[0]!.data?.pids, [process.pid]);
  assert.equal(parks[0]!.data?.launcher, 'unknown', 'it says why it could not tell this console\'s own session from an orphan');
});
