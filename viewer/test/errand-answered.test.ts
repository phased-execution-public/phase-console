/**
 * A completed person-errand is ANSWERABLE (control-tower phase 88, #124).
 *
 * Measured on hub 4123 on 2026-09-25 (observability-plane P27): the phase parked asking the
 * operator for two production Terraform applies. The operator ran both, then pressed the most
 * prominent button on the halt card — Recover. Recover re-read the evidence, found the session's
 * declaration still saying "blocked until the operator applies" and nothing recording that the
 * operator had, and re-halted with the same text. The verb that answers the errand was Retry, named
 * only as a buried `verb: retry` field. The release phase sat 25 min past the operator's go.
 *
 * EA-1  ONE verb — `POST /api/run/:slug/phase/:n/errand-answered {note}`, "Done — continue" —
 *       journals `phase.errand-answered {by, note}` and re-boards the phase with the note
 * EA-2  the answer is evidence: it moves the phase's fingerprint (phase 51) and spends the stale
 *       declaration, so Recover no longer re-derives the ask it answered
 * EA-3  while a person-errand is open, Recover says "this needs your answer" and names the verb
 * EA-4  the holder's verb IS the card's primary button: a person-errand's holder verb is
 *       `errand-answered`, and the Ways forward lead with it
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { loadRun, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { phaseFingerprint } = await import('../server/converge.ts');
const { haltHolders } = await import('../server/runner/runner-loop.ts');
const { recoveryActionsFor, HALT_HOLDER_VERBS } = await import('../shared/recovery-model.js');
const { handleApi } = await import('../server/api/routes.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-09-25
status: active
phases: 2
---

# alpha

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | infra | — | — | app | it works |
| 2 | release | 1 | — | app | it ships |

## Phases

### Phase 1 — infra
- **Size:** S

### Phase 2 — release
- **Size:** S
`;

const NEED = 'Nothing merges before the operator runs the two Terraform applies.';

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-errand-answered-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-infra.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: infra\nstatus: complete\n---\n# done\n', 'utf8');
  return root;
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return svc;
}

/** P27's park: needs-human --needs permission, the errand standing, the run parked on it. */
function parkedOnPerson(root: string): RunState {
  const state = newRun({ slug: 'alpha', root });
  const at = new Date(Date.now() - 60_000).toISOString();
  state.status = 'parked';
  state.halt = { at, reason: `phase 2 needs a person: ${NEED}`, phase: 2, kind: 'needs-human' };
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.sessionId = 'sess-27';
  record.resumeSessionId = 'sess-27';
  record.endedAt = at;
  record.note = NEED;
  record.declared = { status: 'needs-human', needs: 'permission', reason: NEED, at };
  state.recoveries = {
    '2': {
      attempts: 0, lastAt: at,
      errand: { phase: 2, situation: 'blocked-declared:permission', tried: [], need: NEED, how: 'Run them, then answer.', at },
    },
  } as never;
  saveRun(state);
  return state;
}

const journalOf = (root: string, state: RunState) =>
  readFileSync(journalFile(root, 'alpha', state.id), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const actor = { by: 'operator@test', via: 'console' } as never;

test('EA-3: while a person-errand is open, Recover says "this needs your answer" and names Done — continue, and launches nothing', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    parkedOnPerson(root);
    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun = async (slug: string, options: unknown) => { started.push({ slug, options }); return null; };
    const report = await svc.recoverPlan('alpha', actor);
    assert.equal(report.outcome, 'errand');
    assert.equal(started.length, 0, 'Recover cannot answer a person\'s errand');
    assert.match(report.detail, /^This needs your answer/);
    assert.match(report.detail, /Done — continue on phase 2/);
    assert.match(report.detail, /Terraform applies/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('EA-1/EA-2: Done — continue journals the answer, spends the stale ask, moves the fingerprint and re-boards the phase with the note', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const stored = parkedOnPerson(root);
    const before = phaseFingerprint(stored, 2, { 1: 'done', 2: 'in-progress' }, []);
    // The press takes a Resume's doors: its own session resumed (`recoverPhase`)
    // when there is one worth resuming, else a fresh board (`startRun`).
    const pressed: { phase: number; instruction?: string }[] = [];
    const svcAny = svc as never as Record<string, unknown>;
    svcAny.recoverPhase = async (_slug: string, phase: number, _mode: string, opts: { instruction?: string }) => {
      pressed.push({ phase, instruction: opts?.instruction });
      return loadRun(root, 'alpha', stored.id, null)!;
    };
    svcAny.startRun = async (_slug: string, options: { reboard?: { phase: number; instruction?: string }[] }) => {
      pressed.push({ phase: options.reboard?.[0]?.phase ?? 0, instruction: options.reboard?.[0]?.instruction });
      return loadRun(root, 'alpha', stored.id, null)!;
    };
    svcAny.continueAfterPress = () => {};
    const answer = await svc.answerErrand('alpha', 2, 'Both applies ran: 7 added; 18 added, 1 changed.', actor);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(pressed.length, 1, 'the phase is re-boarded');
    const reboard = pressed[0];
    assert.equal(reboard.phase, 2);
    assert.match(reboard.instruction ?? '', /operator@test/);
    assert.match(reboard.instruction ?? '', /Both applies ran/, 'with the note as its addendum');
    assert.match(reboard.instruction ?? '', /Terraform applies/, 'naming the errand it answers');

    const after = loadRun(root, 'alpha', stored.id, null)!;
    const record = after.phases['2'];
    assert.equal(record.errandAnswered?.by, 'operator@test');
    assert.equal(record.errandAnswered?.note, 'Both applies ran: 7 added; 18 added, 1 changed.');
    assert.equal(record.declared, undefined, 'the answered declaration is spent — nothing re-derives it');
    assert.equal(after.recoveries?.['2']?.errand, undefined, 'the errand is answered');
    assert.notEqual(phaseFingerprint(after, 2, { 1: 'done', 2: 'in-progress' }, []), before, 'the answer is evidence (phase 51)');
    const line = journalOf(root, after).find((l: { event: string }) => l.event === 'phase.errand-answered');
    assert.ok(line, 'phase.errand-answered is journalled');
    assert.equal(line.phase, 2);
    assert.equal(line.data.by, 'operator@test');
    assert.equal(line.data.note, 'Both applies ran: 7 added; 18 added, 1 changed.');

    // A phase with no open errand has nothing to answer.
    const none = await svc.answerErrand('alpha', 1, '', actor);
    assert.equal(none.ok, false);
    assert.equal(!none.ok && none.status, 409);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('EA-1: the route is POST /api/run/:slug/phase/:n/errand-answered {note}', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    parkedOnPerson(root);
    const calls: unknown[] = [];
    (svc as never as Record<string, unknown>).answerErrand = async (slug: string, phase: number, note: string) => {
      calls.push({ slug, phase, note });
      return { ok: false, status: 409, error: 'stub' };
    };
    const body = JSON.stringify({ note: 'done by hand' });
    const req = Object.assign(new (await import('node:stream')).Readable({ read() { this.push(body); this.push(null); } }), {
      method: 'POST', url: '/api/run/alpha/phase/2/errand-answered',
      headers: { 'content-type': 'application/json', 'x-phase-console': '1', host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
    let status = 0;
    const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => {}, end: () => {}, headersSent: false };
    await handleApi({ service: svc } as never, req as never, res as never, new URL('http://127.0.0.1/api/run/alpha/phase/2/errand-answered'));
    assert.deepEqual(calls, [{ slug: 'alpha', phase: 2, note: 'done by hand' }]);
    assert.equal(status, 409);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('EA-4: a person-errand\'s holder verb is errand-answered, and the Ways forward lead with it', () => {
  assert.ok((HALT_HOLDER_VERBS as readonly string[]).includes('errand-answered'));
  const errand = { phase: 2, situation: 'blocked-declared:permission', tried: [], need: NEED, how: 'x', at: new Date().toISOString() };
  const holders = haltHolders({ readyRecords: [], errands: [{ p: 2, errand }], stuck: [], qaHolders: [] });
  assert.deepEqual(holders.map((h) => [h.phase, h.kind, h.verb]), [[2, 'errand', 'errand-answered']]);
  // A machine's errand (a spent ladder) keeps Retry.
  const machine = haltHolders({ readyRecords: [], errands: [{ p: 3, errand: { ...errand, phase: 3, situation: 'no-handoff' } }], stuck: [], qaHolders: [] });
  assert.equal(machine[0].verb, 'retry');

  const actions = recoveryActionsFor({
    record: { status: 'parked', sessionId: 'sess-27' },
    situation: { id: 'blocked-declared', sub: 'permission' },
    flags: { allowRun: true, allowWrites: true, allowAgent: true },
  } as never) as { id: string; group: string; label: string }[];
  assert.equal(actions[0]?.id, 'errand-answered');
  assert.equal(actions[0]?.group, 'primary');
  assert.equal(actions[0]?.label, 'Done — continue');
});

test('EA-5 (phase 132): an errand an item stands behind is answered on that item; a permission wall keeps Done — continue until phase 135', async () => {
  const { buildInbox } = await import('../server/inbox.ts');
  const at = '2026-10-07T10:00:00.000Z';
  const step = {
    id: 'step-ea5', kind: 'operator-act', title: 'Run the two applies', where: 'any', slug: 'alpha', phase: 2, runId: 'r5',
    birth: 'console', state: 'notified', declaredAt: at, at, opened: 0, attempts: 0, why: 'reserved', whySource: 'declared',
    proofType: 'attest', waiters: [], source: { kind: 'errand', ref: 'blocked-declared:human-acts' },
  };
  const run = (situation: string) => ({
    id: 'r5', slug: 'alpha', status: 'parked', updatedAt: at, phases: { 2: { phase: 2, status: 'parked' } },
    recoveries: { 2: { errand: { phase: 2, situation, tried: [], need: NEED, how: 'Run them.', at } } },
  });
  const rowOf = (situation: string) => buildInbox({ plans: [], flags: { allowRun: true }, humanSteps: [step], runs: [run(situation)] } as never)
    .items.find((item) => item.kind === 'errand')!;
  const item = rowOf('blocked-declared:human-acts');
  assert.equal(item.actions[0]?.endpoint, '/api/human-steps/step-ea5/check');
  assert.equal(item.actions[0]?.label, 'I\'ve done this — check');
  assert.equal(item.turn?.item, 'step-ea5');
  const wall = rowOf('blocked-declared:permission');
  assert.equal(wall.actions[0]?.verb, 'errand-answered', 'a permission wall is not an operator act — phase 135 makes it a permission item');
});
