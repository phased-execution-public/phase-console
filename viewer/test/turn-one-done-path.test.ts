/**
 * One done path, one announcer (control-tower phase 132, #209; audit OD-4, OD-5):
 *
 *   TD-1  a person errand and its step are ONE item: the errand row's action is
 *         *I've done this — check* on that item, and a step answered that way
 *         — from the errand row, or through "Done — continue" — ends `proven`,
 *         never `dismissed`
 *   TD-2  the clock no longer withdraws a step its own phase resumed past; a
 *         closed phase still withdraws one
 *   TD-3  one turn is announced ONCE: the step's push, one tag per item, and
 *         the reminders under that tag — the errand that IS the step pushes
 *         nothing of its own
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { turnTagOf } = await import('../server/service-base.ts');
const { newRun, phaseRecord, saveRun, loadRun } = await import('../server/runner/state.ts');
const { journalFile } = await import('../server/runner/run-paths.ts');
const { STEP_WITHDRAW_GRACE_MS } = await import('../server/human-steps.ts');
const { asActor, pressActor } = await import('../server/actor.ts');
type RunState = import('../server/runner/state.ts').RunState;
type HumanStep = import('../server/human-steps.ts').HumanStep;

const PLAN = `---
slug: alpha
created: 2026-10-07
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

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'pc-turn-done-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
  writeFileSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-infra.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: infra\nstatus: complete\n---\n# done\n', 'utf8');
  return root;
}

type Pushed = { title: string; body: string; tag?: string };

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAgent: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  const pushed: Pushed[] = [];
  svc.push.announce = ((_category: string, message: Pushed) => { pushed.push(message); }) as never;
  assert.equal(svc.open(root).ok, true);
  return { svc, pushed };
}

/** A session declared a step; the runner parked its phase on it and wrote the errand that IS it. */
function parkedOnStep(svc: InstanceType<typeof Service>, root: string): { state: RunState; step: HumanStep } {
  const state = newRun({ slug: 'alpha', root });
  const raised = svc.raiseTurn({
    slug: 'alpha', phase: 2, birth: 'session', runId: state.id, sessionId: 'sess-2',
    step: { kind: 'browser-login', title: 'Sign the gh CLI in to acme', proof_type: 'attest', open_command: 'gh auth login' },
  });
  assert.ok(raised && !('refused' in raised), JSON.stringify(raised));
  const at = new Date(Date.now() - 60_000).toISOString();
  state.status = 'parked';
  state.halt = { at, reason: 'phase 2 needs a person: sign in', phase: 2, kind: 'needs-human' };
  const record = phaseRecord(state, 2);
  record.status = 'parked';
  record.sessionId = 'sess-2';
  record.resumeSessionId = 'sess-2';
  record.endedAt = at;
  record.note = 'sign in';
  record.declared = { status: 'needs-human', reason: 'sign in', at, step: { id: raised.id, kind: raised.kind } };
  state.recoveries = {
    '2': {
      attempts: 0, lastAt: at,
      errand: { phase: 2, situation: 'blocked-declared:human-acts', tried: [], need: `Your turn — sign in: ${raised.title}`, how: 'At the machine.', at, stepId: raised.id },
    },
  } as never;
  saveRun(state);
  return { state, step: raised };
}

const actor = { by: 'operator@test', via: 'console' } as never;

/** The press doors a resume takes, stubbed — what they were asked is the evidence. */
function stubPress(svc: InstanceType<typeof Service>, root: string, state: RunState): { phase: number; instruction?: string }[] {
  const pressed: { phase: number; instruction?: string }[] = [];
  const svcAny = svc as never as Record<string, unknown>;
  svcAny.recoverPhase = async (_slug: string, phase: number, _mode: string, opts: { instruction?: string }) => {
    pressed.push({ phase, instruction: opts?.instruction });
    return loadRun(root, 'alpha', state.id, null)!;
  };
  svcAny.startRun = async (_slug: string, options: { reboard?: { phase: number; instruction?: string }[] }) => {
    pressed.push({ phase: options.reboard?.[0]?.phase ?? 0, instruction: options.reboard?.[0]?.instruction });
    return loadRun(root, 'alpha', state.id, null)!;
  };
  svcAny.continueAfterPress = () => {};
  return pressed;
}

test('TD-1: the errand row presses its step — I\'ve done this — check — and "Done — continue" ends the step proven, never dismissed', async () => {
  const root = scratch();
  try {
    const { svc } = service(root);
    const { state, step } = parkedOnStep(svc, root);
    const inbox = await svc.attention(true);
    const row = inbox.items.find((item) => item.kind === 'errand' && item.phase === 2);
    assert.ok(row, 'the errand row stands');
    assert.equal(row!.turn?.item, step.id, 'its item IS the step');
    assert.equal(row!.turn?.record, 'ledger');
    assert.deepEqual(
      { verb: row!.actions[0]?.verb, label: row!.actions[0]?.label, endpoint: row!.actions[0]?.endpoint },
      { verb: 'check', label: 'I\'ve done this — check', endpoint: `/api/human-steps/${step.id}/check` },
    );
    assert.ok(!row!.actions.some((action) => action.verb === 'errand-answered'), 'no second done path');
    // The older door — "Done — continue" — checks the same item.
    const pressed = stubPress(svc, root, state);
    const answer = await svc.answerErrand('alpha', 2, 'signed in as acme-bot', actor);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(pressed.length, 1, 'the phase is re-boarded once');
    assert.match(pressed[0]!.instruction ?? '', /the check proved it/);
    assert.match(pressed[0]!.instruction ?? '', /signed in as acme-bot/);
    assert.equal(svc.humanStepsNow().get(step.id)?.state, 'proven', 'the step the person did is proven');
    const after = loadRun(root, 'alpha', state.id, null)!;
    assert.equal(after.phases['2']!.errandAnswered?.by, 'operator@test');
    // …and the clock, long after, leaves it proven — never `dismissed`.
    (svc as never as { humanStepClockTick(now: number): unknown }).humanStepClockTick(Date.now() + STEP_WITHDRAW_GRACE_MS + 3_600_000);
    assert.equal(svc.humanStepsNow().get(step.id)?.state, 'proven');
    const journal = readFileSync(journalFile(root, 'alpha', state.id), 'utf8');
    assert.ok(!/phase\.human-step-dismissed/.test(journal), 'nothing withdrew it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TD-1: checked from its own row, the session step is proven and its session resumed — the same item', async () => {
  const root = scratch();
  try {
    const { svc } = service(root);
    const { step } = parkedOnStep(svc, root);
    const resumes: unknown[] = [];
    (svc as never as Record<string, unknown>).resumeOnWatchLanded = (...args: unknown[]) => { resumes.push(args); return { launched: true }; };
    // A person's press carries its door (phase 134: a check that names none proves nothing).
    const checked = await svc.checkHumanStep(step.id, { by: 'operator@test', actor: pressActor(asActor('operator@test', 'TD-1')) });
    assert.equal(checked.ok, true);
    assert.equal((checked as { check?: { landed: boolean } }).check?.landed, true);
    assert.deepEqual((checked as { resumed?: unknown }).resumed, { launched: true });
    assert.equal(resumes.length, 1, 'its own session, resumed once');
    assert.equal(svc.humanStepsNow().get(step.id)?.state, 'proven');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TD-2: the clock no longer withdraws a step its own phase resumed past — a closed phase still does', () => {
  const root = scratch();
  try {
    const { svc } = service(root);
    const tick = (now: number) => (svc as never as { humanStepClockTick(now: number): unknown }).humanStepClockTick(now);
    const later = Date.now() + STEP_WITHDRAW_GRACE_MS + 3_600_000;
    // Resumed past: Retried, the declaration spent, the phase running again.
    const { state, step } = parkedOnStep(svc, root);
    const record = state.phases['2']!;
    record.status = 'running';
    delete record.declared;
    state.status = 'running';
    saveRun(state);
    tick(later);
    assert.notEqual(svc.humanStepsNow().get(step.id)?.state, 'dismissed', 'a phase resumed past it does not withdraw it');
    assert.ok(['notified', 'declared', 'opened'].includes(svc.humanStepsNow().get(step.id)?.state ?? ''), 'it stands');
    // An errand's item stands while its phase is parked on the errand.
    const errandItem = svc.raiseTurn({
      slug: 'alpha', phase: 2, birth: 'console', runId: state.id,
      step: { kind: 'operator-act', title: 'Run the applies', source: { kind: 'errand', ref: 'blocked-declared:human-acts' } },
    });
    assert.ok(errandItem && !('refused' in errandItem));
    tick(later);
    assert.notEqual(svc.humanStepsNow().get(errandItem.id)?.state, 'dismissed');
    // The phase closes: nobody needs either any more.
    record.status = 'done';
    saveRun(state);
    tick(later + 60_000);
    assert.equal(svc.humanStepsNow().get(step.id)?.state, 'dismissed', 'a closed phase withdraws it, as before');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TD-3: one turn, one push — the errand that IS the step is not announced again, and reminders ride the item\'s tag', () => {
  const root = scratch();
  try {
    const { svc, pushed } = service(root);
    const { state, step } = parkedOnStep(svc, root);
    assert.equal(pushed.length, 1, 'the step\'s own push');
    assert.equal(pushed[0]!.tag, turnTagOf(step));
    const announceErrand = (svc as never as { announceErrand(data: unknown): void }).announceErrand.bind(svc);
    announceErrand({ slug: 'alpha', runId: state.id, phase: 2, errand: state.recoveries!['2']!.errand });
    assert.equal(pushed.length, 1, 'the errand that IS the step pushes nothing of its own');
    (svc as never as { announceHumanStep(step: HumanStep, n: number): boolean }).announceHumanStep(step, 1);
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1]!.tag, pushed[0]!.tag, 'a reminder replaces the notification — one per item');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
