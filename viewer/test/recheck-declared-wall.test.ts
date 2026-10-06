/**
 * Recheck on a declared external wall asks the wall's own refs
 * (control-tower phase 111, #204).
 *
 * A phase parked by `needs-human --needs external --watch cmd:"…"` shows
 * Recheck as its card's recommended verb, and its errand says "Check its watch
 * refs; when it has landed, Re-check or Retry." Recheck never looked at the
 * refs: it ran the three done-checks, a phase waiting on the outside world is
 * not done, and the fall-through marked the record `failed` and wrote a
 * `no-handoff` halt over the declared wall — the rehearsal's halts group,
 * 2026-09-30, recovered it only with the second button, Retry.
 *
 * Now, on a declared external wall, Recheck probes the declaration's refs
 * through the watch clock — the probe the scheduler runs:
 *
 *   - landed → the phase's own session is resumed, as the scheduler's landing
 *     resumes it;
 *   - not landed → ONE `run.recheck` line naming each ref and what it read,
 *     with the wall, its halt, its errand and the record exactly as they were.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, runDir, saveRun } = await import('../server/runner/state.ts');
const { leadActionFor } = await import('../shared/recovery-model.js');

const SCRIPTS = join(SKILL_DIR, 'scripts');

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
| 1 | deploy window | — | — | app | it ships |
| 2 | after | 1 | — | app | it still ships |

## Phases

### Phase 1 — deploy window
- **Size:** S

### Phase 2 — after
- **Size:** S
`;

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-wall-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  return root;
}

type Drive = { phase: number; mode: string; by?: string; instruction?: string };

/**
 * A service whose session vehicles are recorded, never launched: a landing's
 * drive is the thing under test, and a real `claude -p` is not.
 */
function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  const drives: Drive[] = [];
  const recover = svc.recoverPhase.bind(svc);
  svc.recoverPhase = (async (slug: string, phase: number, mode: string, opts: { by?: string; instruction?: string } = {}) => {
    if (mode === 'recheck') return recover(slug, phase, mode as never, opts as never);
    drives.push({ phase, mode, by: opts.by, instruction: opts.instruction });
    return null;
  }) as typeof svc.recoverPhase;
  svc.retryPhase = (async (_slug: string, phase: number) => {
    drives.push({ phase, mode: 'retry' });
    return null;
  }) as unknown as typeof svc.retryPhase;
  return { svc, drives };
}

/** A run whose phase 1 is parked on a declared external wall watching `flag`. */
function wallRun(root: string, flag: string) {
  const state = newRun({ slug: 'alpha', root });
  state.status = 'parked';
  state.finishedReason = 'phase 1 is parked on the deploy window';
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const record = phaseRecord(state, 1);
  record.status = 'parked';
  record.attempts = 1;
  record.sessionId = 'sess-wall-1';
  record.note = 'the deploy window opens tonight';
  record.endedAt = at;
  record.declared = {
    status: 'needs-human', reason: 'the deploy window opens tonight', needs: 'external',
    watch: [`cmd:"test -f ${flag}"`], at,
  } as never;
  record.halt = { at, reason: 'phase 1 needs a person: the deploy window opens tonight', phase: 1, kind: 'needs-human' } as never;
  saveRun(state);
  return state;
}

function journalOf(root: string, runId: string): Array<{ event: string; phase?: number; data?: Record<string, unknown> }> {
  const file = join(runDir(root, 'alpha'), `run-${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** What the wall is, as a person reads it: the record's verdict-bearing fields and the run's word. */
function wallOf(root: string, runId: string) {
  const run = loadRun(root, 'alpha', runId, null)!;
  const r = run.phases['1'];
  return {
    run: run.status, halt: run.halt ?? null, finishedReason: run.finishedReason ?? null,
    status: r.status, recordHalt: r.halt ?? null, declared: r.declared ?? null, note: r.note ?? null,
    attempts: r.attempts, errand: run.recoveries?.['1']?.errand ?? null,
  };
}

test('RW-1: the card leads a declared external wall with Recheck — the verb this file holds to its promise', () => {
  assert.equal(leadActionFor('blocked-declared', 'external'), 'recheck');
});

test('RW-2: Recheck before the ref lands probes it, says what it read, and leaves the wall exactly as it was', async () => {
  const root = scratch();
  try {
    const flag = join(root, 'window.open');
    const { svc, drives } = service(root);
    const state = wallRun(root, flag);
    const before = wallOf(root, state.id);
    const halted = journalOf(root, state.id).filter((e) => e.event === 'phase.halted').length;

    await svc.recoverPhase('alpha', 1, 'recheck', { by: 'operator', settled: true });

    assert.deepEqual(drives, [], 'nothing is resumed: the ref has not landed');
    assert.deepEqual(wallOf(root, state.id), before, 'the wall, its halt, its errand and the record read exactly as before');
    const journal = journalOf(root, state.id);
    assert.equal(journal.filter((e) => e.event === 'phase.halted').length, halted, 'no new halt');
    assert.equal(journal.filter((e) => e.event === 'phase.verify').length, 0, 'the done-checks never ran');
    const rechecks = journal.filter((e) => e.event === 'run.recheck');
    assert.equal(rechecks.length, 1, 'one run.recheck line');
    assert.equal(rechecks[0].phase, 1);
    assert.equal(rechecks[0].data?.verdict, 'waiting');
    assert.equal(rechecks[0].data?.wall, true);
    const refs = rechecks[0].data?.refs as Array<{ ref: string; state: string; detail?: string }>;
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, `cmd:"test -f ${flag}"`, 'the line names the ref');
    assert.equal(refs[0].state, 'pending', 'and what it read');
    assert.match(refs[0].detail ?? '', /exit 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RW-3: Recheck after the ref lands resumes the phase\'s own session, as the scheduler\'s landing does', async () => {
  const root = scratch();
  try {
    const flag = join(root, 'window.open');
    const { svc, drives } = service(root);
    const state = wallRun(root, flag);
    writeFileSync(flag, 'open\n', 'utf8');

    await svc.recoverPhase('alpha', 1, 'recheck', { by: 'operator', settled: true });

    assert.equal(drives.length, 1, 'one delivery of the landing');
    assert.equal(drives[0].mode, 'resume', 'the phase\'s own session — its sessionId is on the record');
    assert.equal(drives[0].by, 'watch');
    assert.match(drives[0].instruction ?? '', /has landed: cmd:"test -f /);
    const journal = journalOf(root, state.id);
    const rechecks = journal.filter((e) => e.event === 'run.recheck');
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0].data?.verdict, 'landed');
    assert.equal(rechecks[0].data?.ref, `cmd:"test -f ${flag}"`);
    assert.ok(journal.some((e) => e.event === 'phase.watch-landed' && e.phase === 1), 'the landing is journalled as the scheduler journals it');
    assert.equal(journal.filter((e) => e.event === 'phase.verify').length, 0, 'the done-checks never ran');
    const after = loadRun(root, 'alpha', state.id, null)!.phases['1'];
    assert.notEqual(after.halt?.kind, 'no-handoff', 'never re-judged no-handoff');
    assert.notEqual(after.status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RW-4: a wall whose declaration names no ref is said, not re-judged', async () => {
  const root = scratch();
  try {
    const { svc, drives } = service(root);
    const state = wallRun(root, '/nonexistent');
    // The same wall with no watch ref at all.
    const run = loadRun(root, 'alpha', state.id, null)!;
    delete (run.phases['1'].declared as { watch?: string[] }).watch;
    saveRun(run);
    const before = wallOf(root, state.id);

    await svc.recoverPhase('alpha', 1, 'recheck', { by: 'operator', settled: true });

    assert.deepEqual(drives, []);
    assert.deepEqual(wallOf(root, state.id), before);
    const rechecks = journalOf(root, state.id).filter((e) => e.event === 'run.recheck');
    assert.equal(rechecks.length, 1);
    assert.equal(rechecks[0].data?.verdict, 'waiting');
    assert.deepEqual(rechecks[0].data?.refs, []);
    assert.match(String(rechecks[0].data?.why ?? ''), /names no ref/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
