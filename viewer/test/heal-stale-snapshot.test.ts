/**
 * A delayed heal acts on the run as it is NOW (control-tower phase 110, #178).
 *
 * Measured on this plan's P33, 2026-09-30: attempt 2 parked at 22:22:25Z, the
 * operator's Retry boarded attempt 3 at 22:24:14Z, and the halt-triggered heal
 * — due a minute after the halt, 5.7 minutes late under load — classified
 * attempt 2's snapshot at 22:28:09Z, climbed `unblock-session`, was refused
 * ("in progress"), and saved its snapshot over the live run: the file read
 * `parked`, attempts 2, `children: {}`, while attempt 3 worked.
 *
 *   HS-1  the operator's retry lands while the pass reads: the pass is dropped —
 *         the run file still reads `running` with attempt N+1, and no `rung`
 *         line is written.
 *   HS-2  the run is live again under this console's own loop: dropped too.
 *   HS-3  what a pass must record is MERGED into the record as it stands — a
 *         person's note written while the pass read survives, and a refused
 *         rung settles on the current record, never on the snapshot.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { clearRunFileCache, flushRunSaves, loadRun, newRun, phaseRecord, runDir, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');
const BOOTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

const PLAN = `---
slug: gamma
created: 2026-10-04
status: active
phases: 2
---

# gamma

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | 2 | app | it works |
| 2 | two | — | 1 | app | it works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S
`;

type Line = { event: string; phase?: number; data: Record<string, unknown> };

function harness(onClassify: (phase: number) => void) {
  const root = mkdtempSync(join(tmpdir(), 'pc-heal-stale-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'gamma.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const t = svc.terminals as never as Record<string, unknown>;
  t.availability = () => 'yes';
  t.mint = async () => ({ ok: true, sessionId: 'sess-auto', token: 'tok' });
  // The incident's refusal: the run is in progress, so the recovery is refused.
  const recovered: number[] = [];
  (svc as never as Record<string, unknown>).recoverPhase = async (_slug: string, phase: number) => {
    recovered.push(phase);
    throw new Error('gamma is in progress. Pause or stop it before recovering a phase.');
  };
  // The classification reads each phase's handoff through this seam: the
  // moment it does, the pass has read its snapshot and is still working.
  const real = (svc as never as { evidenceDeps: (slug: string) => Record<string, unknown> }).evidenceDeps.bind(svc);
  (svc as never as Record<string, unknown>).evidenceDeps = (slug: string) => {
    const deps = real(slug) as { handoff?: (s: string, p: number) => unknown };
    return {
      ...deps,
      handoff: (s: string, p: number) => { onClassify(p); return deps.handoff?.(s, p) ?? null; },
      git: async () => '',
    };
  };
  const cleanup = async () => { await svc.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, svc, recovered, cleanup };
}

/** Attempt 2 of phase 2 parked on a declared block — the halt the heal is due for. */
function parkedAttempt2(root: string): RunState {
  const state = newRun({ slug: 'gamma', root, autoRecover: true });
  state.status = 'parked';
  state.activePhase = 2;
  state.halt = { at: new Date().toISOString(), reason: 'the model declined the task', phase: 2, kind: 'phase-blocked' };
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.attempts = 2;
  record.sessionId = 'sess-2b';
  record.startedAt = new Date(Date.now() - 600_000).toISOString();
  record.note = 'the model declined the task';
  record.declared = { status: 'blocked', reason: 'the model declined the task', needs: 'unknown', at: new Date().toISOString() } as never;
  saveRun(state);
  return state;
}

/** The operator's Retry, as it lands on disk: attempt 3 boarded, its session alive, launched by this console. */
function retryBoards(root: string, id: string, pid: number): void {
  const live = loadRun(root, 'gamma', id, null)!;
  live.status = 'running';
  live.halt = null;
  live.activePhase = 2;
  const record = live.phases['2']!;
  record.status = 'running';
  record.attempts = 3;
  record.sessionId = 'sess-2c';
  delete record.declared;
  record.note = undefined;
  live.children = {
    2: {
      pid, phase: 2, sessionId: 'sess-2c', startedAt: new Date().toISOString(), procStartedAt: new Date().toISOString(),
      launcher: { pid: process.pid, bootedAt: BOOTED_AT },
    } as never,
  };
  saveRun(live);
  clearRunFileCache();
}

function lines(root: string, id: string): Line[] {
  const file = join(runDir(root, 'gamma'), `run-${id}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
}

function disk(root: string, id: string): RunState {
  flushRunSaves();
  return JSON.parse(readFileSync(join(runDir(root, 'gamma'), `run-${id}.json`), 'utf8')) as RunState;
}

function session(): ChildProcess {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(child.pid);
  return child;
}

test('HS-1: a retry that boards attempt N+1 while the heal reads drops the pass — the file reads running with attempt N+1, and no rung is written', async () => {
  const child = session();
  let state!: RunState;
  let retried = false;
  const { root, svc, recovered, cleanup } = harness(() => {
    if (retried) return;
    retried = true;
    retryBoards(root, state.id, child.pid!);
  });
  try {
    state = parkedAttempt2(root);
    const result = await svc.maybeAutoRecover('gamma', { trigger: 'halt', fingerprint: 'attempt-2' });
    assert.ok(retried, 'the pass classified a phase, so the retry landed mid-pass');

    assert.equal(result.launched, false, 'nothing is launched over a run that moved on');
    assert.match(result.reason ?? '', /newer attempt|moved on|live/, `the pass says why it stood down (${result.reason})`);
    assert.equal((result as { stale?: boolean }).stale, true, 'and marks itself stale, so converge writes no latch');
    assert.deepEqual(recovered, [], 'no recovery was attempted beside the live attempt');

    const after = disk(root, state.id);
    assert.equal(after.status, 'running', 'the file still reads the live attempt');
    assert.equal(after.phases['2']!.attempts, 3);
    assert.equal(after.phases['2']!.status, 'running');
    assert.equal(after.children?.['2']?.pid, child.pid, 'its session is still the record\'s');
    assert.equal(lines(root, state.id).filter((l) => l.event === 'phase.rung').length, 0, 'no rung line');
    assert.equal(lines(root, state.id).filter((l) => l.event === 'phase.rung-settled').length, 0, 'and nothing settled against it');
  } finally {
    child.kill('SIGKILL');
    await cleanup();
  }
});

test('HS-2: the run is live again under this console\'s own loop while the heal reads — dropped, and its snapshot is not written', async () => {
  let state!: RunState;
  let live: RunState | null = null;
  const { root, svc, recovered, cleanup } = harness(() => {
    if (live) return;
    // The operator pressed Continue: this console's runner drives the run now.
    live = loadRun(root, 'gamma', state.id, null)!;
    live.status = 'running';
    live.halt = null;
    live.phases['2']!.status = 'queued';
    saveRun(live);
    const runners = (svc as never as { runners: Map<string, unknown> }).runners;
    runners.set('gamma', { busy: () => true, current: () => live, isSpending: () => false });
  });
  try {
    state = parkedAttempt2(root);
    const result = await svc.maybeAutoRecover('gamma', { trigger: 'halt', fingerprint: 'attempt-2' });
    assert.ok(live, 'the loop took the run mid-pass');
    assert.equal(result.launched, false);
    assert.equal((result as { stale?: boolean }).stale, true);
    assert.deepEqual(recovered, []);
    const after = disk(root, state.id);
    assert.equal(after.status, 'running', 'the loop\'s record stands');
    assert.equal(after.phases['2']!.status, 'queued');
    assert.equal(lines(root, state.id).filter((l) => l.event === 'phase.rung').length, 0);
  } finally {
    (svc as never as { runners: Map<string, unknown> }).runners.delete('gamma');
    await cleanup();
  }
});

test('HS-3: what a pass records is merged into the record as it stands — a note written mid-pass survives, and the refused rung settles on the current record', async () => {
  let state!: RunState;
  let noted = false;
  const { root, svc, recovered, cleanup } = harness(() => {
    if (noted) return;
    noted = true;
    // A person writes on the run while the pass is reading — nothing the
    // pass's evidence is about, so it carries on and climbs.
    const out = svc.noteRun('gamma', { text: 'Leave phase 1 for the morning.', pinned: true },
      { by: 'ana', via: 'api', origin: 'local', remoteUser: null });
    assert.equal(out.ok, true);
  });
  try {
    state = parkedAttempt2(root);
    const result = await svc.maybeAutoRecover('gamma', { trigger: 'halt', fingerprint: 'attempt-2' });
    assert.ok(noted);
    assert.equal(result.launched, true, `the pass climbs over evidence that did not move (${result.reason ?? ''})`);
    // The vehicle's refusal lands on the next tick.
    for (let i = 0; i < 50 && !lines(root, state.id).some((l) => l.event === 'phase.rung-settled'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(recovered, [2]);
    const after = disk(root, state.id);
    assert.deepEqual(after.notes?.map((n) => n.text), ['Leave phase 1 for the morning.'], 'the person\'s note was not written over');
    const rungs = after.recoveries?.['2']?.rungs ?? [];
    assert.equal(rungs.length, 1, 'the rung the pass climbed is on the record');
    assert.equal(rungs[0]!.outcome, 'failed', 'and its refusal settled it there');
    assert.match(rungs[0]!.note ?? '', /in progress/);
    assert.equal(after.phases['2']!.situation?.key?.startsWith('blocked-declared'), true, 'the situation stamp was merged too');
  } finally {
    await cleanup();
  }
});
