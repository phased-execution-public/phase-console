/**
 * The healer dedupes on each phase's OWN evidence (control-tower phase 51, #84).
 *
 * RCV-9 meant "one situation line per phase per piece of evidence", but it
 * compared a phase's stored fingerprint with the RUN-wide one — every record,
 * the whole board, every lock, the QA verdicts, the watch schedule — so any
 * change anywhere re-journalled every candidate, and a standing needs-human
 * declaration was re-derived on every pass. Measured over one week: 82 % of
 * the convergence passes launched nothing, 77 of them re-reading one
 * needs-human declaration, and one console wrote 657 situation lines.
 *
 *   HD-1  after ONE phase's evidence changes, only that phase's situation line
 *         is written again; its siblings' stand.
 *   HD-2  a standing needs-human declaration is not re-examined — not even
 *         classified — until what it names changes (it is re-declared, or a
 *         ref it watches moves); a pass with nothing changed for any of them
 *         says so and reads nothing.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, runDir, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const SCRIPTS = join(SKILL_DIR, 'scripts');

const THREE_ROOTS = `---
slug: beta
created: 2026-09-24
status: active
phases: 3
---

# beta

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | one | — | 2, 3 | app | it works |
| 2 | two | — | 1, 3 | app | it works |
| 3 | three | — | 1, 2 | app | it works |

## Phases

### Phase 1 — one
- **Size:** S

### Phase 2 — two
- **Size:** S

### Phase 3 — three
- **Size:** S
`;

type Line = { event: string; phase?: number; data: Record<string, unknown> };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pc-healer-dedupe-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  // The plan is on disk BEFORE the console opens the root — the store reads once.
  writeFileSync(join(root, 'docs', 'plans', 'beta.md'), THREE_ROOTS, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  // Nothing here may start a session: the pty and the session door record.
  const t = svc.terminals as never as Record<string, unknown>;
  t.availability = () => 'yes';
  t.mint = async () => ({ ok: true, sessionId: 'sess-auto', token: 'tok' });
  (svc as never as Record<string, unknown>).recoverPhase = async () => null;
  // Which phases a pass CLASSIFIED — through the evidence seam every
  // classification reads a phase's handoff through.
  const classified: number[] = [];
  const real = (svc as never as { evidenceDeps: (slug: string) => Record<string, unknown> }).evidenceDeps.bind(svc);
  (svc as never as Record<string, unknown>).evidenceDeps = (slug: string) => {
    const deps = real(slug) as { handoff?: (s: string, p: number) => unknown };
    return {
      ...deps,
      handoff: (s: string, p: number) => { classified.push(p); return deps.handoff?.(s, p) ?? null; },
      git: async () => '',
    };
  };
  const cleanup = async () => { await svc.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, svc, classified, cleanup };
}

/** A halted run of `beta` with three open records, every one a declared needs-human park. */
function threeParks(root: string): RunState {
  const state = newRun({ slug: 'beta', root, autoRecover: true });
  state.status = 'halted';
  state.activePhase = 1;
  state.halt = { at: new Date().toISOString(), reason: 'phase 1 asked for a person', phase: 1, kind: 'needs-human' };
  state.finishedReason = state.halt.reason;
  for (const phase of [1, 2, 3]) {
    const record = phaseRecord(state, phase);
    record.status = 'parked';
    record.note = `phase ${phase} asked for a person`;
    record.declared = { status: 'needs-human', reason: 'a person must look', needs: 'credential', at: '2026-09-24T09:00:00.000Z' };
  }
  saveRun(state);
  return state;
}

function situations(root: string, runId: string): Line[] {
  const file = join(runDir(root, 'beta'), `run-${runId}.jsonl`);
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
    .filter((l) => l.event === 'phase.situation');
}

/** Edit the stored run the way a session's re-declaration does. */
function redeclare(root: string, runId: string, phase: number, over: Record<string, unknown>): void {
  const state = loadRun(root, 'beta', runId, null)!;
  const record = state.phases[String(phase)];
  record.declared = { ...record.declared!, ...over } as never;
  saveRun(state);
}

test('HD-1: after one phase\'s evidence changes, only that phase\'s situation is journalled again', async () => {
  const { root, svc, cleanup } = harness();
  try {
    const state = threeParks(root);
    await svc.maybeAutoRecover('beta', { trigger: 'timer' });
    const first = situations(root, state.id);
    assert.deepEqual(first.map((l) => l.phase).sort(), [1, 2, 3], 'the first pass: one line per candidate');

    // Phase 2's session declares again, naming something new. Nothing about
    // phases 1 and 3 moved — but the RUN's evidence did.
    redeclare(root, state.id, 2, { reason: 'a person must rotate the deploy key', at: '2026-09-24T09:30:00.000Z' });
    await svc.maybeAutoRecover('beta', { trigger: 'change' });
    const second = situations(root, state.id).slice(first.length);
    assert.deepEqual(second.map((l) => l.phase), [2], `only the phase whose evidence moved (${JSON.stringify(second.map((l) => l.phase))})`);
    assert.equal(second[0].data.trigger, 'change');

    // Each record carries its OWN evidence, not the run's.
    const disk = loadRun(root, 'beta', state.id, null)!;
    const prints = [1, 2, 3].map((p) => disk.phases[String(p)].situation?.fingerprint ?? '');
    assert.equal(new Set(prints).size, 3, 'three phases, three fingerprints');
    for (const [i, print] of prints.entries()) {
      assert.equal(JSON.parse(print)[0], i + 1, `phase ${i + 1}'s fingerprint is about phase ${i + 1}`);
    }
  } finally { await cleanup(); }
});

test('HD-2: a standing needs-human declaration is re-examined only when what it names changes', async () => {
  const { root, svc, classified, cleanup } = harness();
  try {
    const state = threeParks(root);
    await svc.maybeAutoRecover('beta', { trigger: 'timer' });
    assert.deepEqual([...new Set(classified)].sort(), [1, 2, 3], 'the first pass reads all three');
    const errands = loadRun(root, 'beta', state.id, null)!.recoveries ?? {};
    assert.deepEqual(Object.keys(errands).filter((k) => errands[k]?.errand).sort(), ['1', '2', '3'], 'each ask stands');

    // Nothing named changed: nothing is read, and the pass says why.
    classified.length = 0;
    const quiet = await svc.maybeAutoRecover('beta', { trigger: 'timer' });
    assert.deepEqual(classified, [], 'no declaration is re-derived over evidence that did not move');
    assert.equal(quiet.launched, false);
    assert.match(quiet.reason ?? '', /needs-human — nothing they name has changed/);

    // Phase 2 names something new: phase 2 alone is read again.
    redeclare(root, state.id, 2, { needs: 'permission', at: '2026-09-24T09:30:00.000Z' });
    classified.length = 0;
    await svc.maybeAutoRecover('beta', { trigger: 'change' });
    assert.deepEqual([...new Set(classified)], [2], `only the re-declared phase (${JSON.stringify(classified)})`);

    // A ref a declaration watches moving is a change of what it names.
    const moved = loadRun(root, 'beta', state.id, null)!;
    moved.phases['3'].declared = { ...moved.phases['3'].declared!, watch: ['gh:acme/app#pr/7'] };
    moved.phases['3'].watch = ['gh:acme/app#pr/7'];
    saveRun(moved);
    classified.length = 0;
    await svc.maybeAutoRecover('beta', { trigger: 'change' });
    assert.deepEqual([...new Set(classified)], [3], `only the phase whose refs moved (${JSON.stringify(classified)})`);
  } finally { await cleanup(); }
});
