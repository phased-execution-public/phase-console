/**
 * The verification door: every reader of a plan's §Verification says what
 * boarding will do — the start response, the plan page's report, plan health,
 * the repair gate, and the launch door itself.
 *
 * Run f0da619a (2026-09-18) halted on a `bats` line under `Person-check: halt`.
 * Every one of these readers had called that plan fine, because each asked a
 * weaker question than boarding. They now ask the same one
 * (`runner/verify-review.ts`), with the same answers.
 *
 * One fixture, four phases, each a shape that matters:
 *   1. clean under halt — nothing to say;
 *   2. an unknown command under halt — it parks, and one exact approval
 *      answers it: never a paid repair session;
 *   3. a deny-wall command under halt — it parks, no approval can carve it,
 *      so it IS a plan defect a repair may fix;
 *   4. an unknown command under the shipped `operator` — a person may be asked
 *      on a red, which is not a park.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { healthIssues } = await import('../server/analysis/stats.ts');
const { commandFingerprint } = await import('../server/runner/verify.ts');

const PLAN = `---
slug: door
created: 2026-09-18
status: active
phases: 4
---

# door

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | clean | — | — | app | green |
| 2 | unknown | 1 | — | app | green |
| 3 | defect | 2 | — | app | green |
| 4 | owner | 3 | — | app | green |

## Phases

### Phase 1 — clean
- **Size:** S
- **Person-check:** halt
- **Verification:**
  - **Verify in:** app
  - \`npm test\`

### Phase 2 — unknown
- **Size:** S
- **Person-check:** halt
- **Verification:**
  - **Verify in:** app
  - \`npm test\`
  - \`frobnicate --check tests/\`

### Phase 3 — defect
- **Size:** S
- **Person-check:** halt
- **Verification:**
  - **Verify in:** app
  - \`npm test\`
  - \`git push origin main\`

### Phase 4 — owner
- **Size:** S
- **Verification:**
  - **Verify in:** app
  - \`npm test\`
  - \`frobnicate --check tests/\`
`;

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'pc-verification-door-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'door'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'door.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false, allowRun: false,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  return { svc, cleanup: () => { svc.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Ctx = Parameters<typeof healthIssues>[0];
const contextOf = (svc: unknown) =>
  (svc as { context: (record: unknown) => Promise<Ctx>; store: { get: (slug: string) => unknown } });

test('the start response names each phase boarding will park, and why — and nothing else', async () => {
  const { svc, cleanup } = scratch();
  try {
    const advisories = await svc.verificationPreflight('door');
    assert.equal(advisories.length, 2, advisories.join(' | '));
    assert.match(advisories[0], /phase 2's §Verification holds 1 check the runner will not run/);
    assert.match(advisories[0], /`frobnicate` is not a recognised command/);
    assert.match(advisories[1], /phase 3's §Verification holds 1 check the runner will not run/);
    assert.match(advisories[1], /git push origin main/);
  } finally { cleanup(); }
});

test('the plan page says "will park" under halt, "may ask" under an owner, and which answer is one click', async () => {
  const { svc, cleanup } = scratch();
  try {
    const report = await svc.verifyPreflightReport('door');
    assert.ok(report);
    const byPhase = new Map(report!.phases.map((row) => [row.phase, row.warnings]));
    assert.equal(byPhase.get(1), undefined);
    const [two] = byPhase.get(2) ?? [];
    assert.equal(two?.parks, true);
    assert.equal(two?.approvable, true);
    assert.equal(two?.fp, commandFingerprint('frobnicate --check tests/'));
    assert.match(two?.message ?? '', /will PARK the run at boarding/);
    const [three] = byPhase.get(3) ?? [];
    assert.equal(three?.parks, true);
    assert.equal(three?.approvable, false);
    const [four] = byPhase.get(4) ?? [];
    assert.equal(four?.parks, undefined);
    assert.match(four?.message ?? '', /asks only if nothing else proves the phase/);
  } finally { cleanup(); }
});

test('plan health: a plan defect under halt is a warning naming the command and why; an approval is information', async () => {
  const { svc, cleanup } = scratch();
  try {
    const service = contextOf(svc);
    const issues = healthIssues(await service.context(service.store.get('door')));
    const unrunnable = issues.filter((issue) => issue.kind === 'verification-unrunnable');
    assert.deepEqual(unrunnable.map((issue) => issue.phase), [3]);
    assert.equal(unrunnable[0].severity, 'warning');
    assert.match(unrunnable[0].message, /git push origin main — .*mutates/);
    const approval = issues.filter((issue) => issue.kind === 'verification-approval');
    assert.deepEqual(approval.map((issue) => [issue.phase, issue.severity]), [[2, 'info']]);
    assert.match(approval[0].message, /frobnicate --check tests\//);
  } finally { cleanup(); }
});

test('the repair gate repairs a plan defect, and answers an approval with the approval — never a paid session', async () => {
  const { svc, cleanup } = scratch();
  try {
    const defect = await svc.resolveRecovery({ class: 'plan-repair', slug: 'door', phase: 3 });
    assert.equal(defect.ok, true);
    if (defect.ok) {
      assert.ok(defect.facts.issues?.some((issue) =>
        issue.kind === 'verification-unrunnable' && /git push origin main/.test(issue.message)));
    }
    const approval = await svc.resolveRecovery({ class: 'plan-repair', slug: 'door', phase: 2 });
    assert.equal(approval.ok, false);
    if (!approval.ok) {
      assert.equal(approval.status, 409);
      assert.match(approval.error, /needs your approval, not a repair/);
      assert.match(approval.error, /frobnicate --check tests\//);
    }
  } finally { cleanup(); }
});

test('the launch door: probe 5 blocks on phases 2 and 3 until each is answered, and resolves the answers to exact texts', async () => {
  const { svc, cleanup } = scratch();
  try {
    const open = await svc.prelude('door', {});
    assert.equal(open.probes.verification.status, 'fail');
    const block = open.blocking.find((b) => b.key === 'verification.person-check');
    assert.match(block?.why ?? '', /2 phases would stop for a person — phase 2: frobnicate --check tests\//);

    const frob = commandFingerprint('frobnicate --check tests/');
    const push = commandFingerprint('git push origin main');
    const answered = await svc.prelude('door', {
      // The deny wall is not approvable (phase 3's push) — only waivable.
      verifyAnswers: { approve: [frob, push], waive: [`3:${push}`] },
    });
    assert.equal(answered.probes.verification.status, 'ok', answered.probes.verification.reason);
    assert.ok(!answered.blocking.some((b) => b.key === 'verification.person-check'));
    assert.deepEqual(answered.verifyApprovals, {
      approve: [{ fp: frob, text: 'frobnicate --check tests/' }],
      waive: [{ phase: 3, fp: push, text: 'git push origin main' }],
    });

    // A run scoped to phase 1 is not held by phases it will not drive.
    const scoped = await svc.prelude('door', { onlyPhases: [1] });
    assert.equal(scoped.probes.verification.status, 'ok');
  } finally { cleanup(); }
});

test('the start door refuses a run its §Verification would stop, and carries the answers to the runner as exact texts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-verification-start-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'door'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'door.md'), PLAN, 'utf8');
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null, defaultSkills: [],
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  svc.savePreferences({ attachDefaultSkills: false, qaByDefault: false });
  try {
    assert.equal(svc.open(root).ok, true);
    const captured: Record<string, unknown>[] = [];
    (svc as never as { runnerFor: (slug: string) => unknown }).runnerFor = () => ({
      start: async (options: Record<string, unknown>) => {
        captured.push(options);
        return { id: 'run-1', slug: 'door', status: 'running', phases: {} };
      },
    });
    // Unanswered: refused at the door, naming the row and the phase.
    await assert.rejects(
      svc.startRun('door', { acknowledgedWaivers: ['announce'] }),
      (error: Error) => error.name === 'PreludeRefusal' && /verification\.person-check: 2 phases would stop/.test(error.message),
    );
    assert.equal(captured.length, 0, 'nothing started');

    const frob = commandFingerprint('frobnicate --check tests/');
    const push = commandFingerprint('git push origin main');
    await svc.startRun('door', {
      acknowledgedWaivers: ['announce'],
      verifyAnswers: { approve: [frob], waive: [`3:${push}`] },
      actor: { kind: 'operator', by: 'operator', door: 'operator' } as never,
    });
    const answers = captured[0]?.verifyApprovals as { approve: unknown[]; waive: unknown[]; by: string };
    assert.deepEqual(answers.approve, [{ fp: frob, text: 'frobnicate --check tests/' }]);
    assert.deepEqual(answers.waive, [{ phase: 3, fp: push, text: 'git push origin main' }]);
    assert.equal(answers.by, 'operator');
    assert.equal('verifyAnswers' in captured[0]!, true, 'the draft rides along, harmlessly');
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
