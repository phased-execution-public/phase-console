/**
 * "Recover & continue" — the plan-level button, held to its three honest steps.
 *
 * Step 1 CONFIRMS the stop against the board and stands down whatever the
 * board already settled (the observed shape: phase 7 halted on the banner,
 * done on the list). Step 2 continues a run that has nothing wrong. Step 3
 * arms bounded auto-recovery and runs the SAME healer the unattended path
 * uses — so the button cannot corrupt the orchestration — and anything only
 * a person can settle comes back named.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { listRuns, newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;

const PLAN = `---
slug: alpha
created: 2026-08-06
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
  const root = mkdtempSync(join(tmpdir(), 'pc-recover-plan-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, 'docs', 'handoffs', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'alpha.md'), PLAN, 'utf8');
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

function haltedRun(root: string, over: Partial<RunState> = {}): RunState {
  // Phase 1 finished, so the board reads phase 2 — the phase these runs halt on
  // — as `ready` rather than `waiting`. 2 depends on 1, so a run cannot reach
  // it otherwise, and the healer now declines to work a phase the board is
  // still waiting on.
  writeFileSync(
    join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'),
    '---\nplan: docs/plans/alpha.md\nphase: 1\ntitle: schema\nstatus: complete\n---\n# done\n',
    'utf8',
  );
  const state = newRun({ slug: 'alpha', root });
  state.status = 'halted';
  state.halt = {
    at: new Date().toISOString(),
    reason: 'phase 2 did not verify: 1 of 2 command(s) failed',
    phase: 2, kind: 'verify-failed',
  };
  state.finishedReason = state.halt.reason;
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  record.sessionId = 'sess-2';
  Object.assign(state, over);
  saveRun(state);
  return state;
}

test('a halt the board has moved past is stood down and the run resumes', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = haltedRun(root);
    // The work landed outside the run: BOTH phases read done… no — phase 1
    // stays open so there is something to continue into. So drop the finished
    // phase 1 the helper writes: this is the one test here that needs the
    // EARLIER phase open, and a phase-2 handoff reads `done` on its own merits
    // whatever phase 1 says.
    rmSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'), { force: true });
    handoff(root, 2, 'cart-api', 'complete');

    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun =
      async (slug: string, options: unknown) => { started.push({ slug, options }); return state; };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'resumed');
      assert.equal(started.length, 1, 'the run continues under normal admission');
      assert.ok(report.steps.some((step) => /moved past phase 2/.test(step)), report.steps.join(' | '));

      // The story moved with the halt — read back OFF DISK, not through the
      // stub (which returns the stale pre-reconcile object).
      const after = listRuns(root, 'alpha')[0]!;
      assert.equal(after.halt, null);
      assert.equal(after.phases['2'].status, 'done');
      assert.match(after.finishedReason ?? '', /the board has since closed it/);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the honest headline replaces the dead blocker sentence when the halt dissolves', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root, {
      finishedReason: 'phase 2 declared itself blocked: CI is down',
      halt: { at: new Date().toISOString(), reason: 'phase 2 declared itself blocked: CI is down', phase: 2, kind: 'phase-blocked' },
    });
    handoff(root, 1, 'schema', 'complete');
    handoff(root, 2, 'cart-api', 'complete');
    (svc as never as Record<string, unknown>).startRun = async () => { throw new Error('nothing left to start'); };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'nothing-to-do');
      assert.match(report.run!.finishedReason ?? '', /the board has since closed it/);
      assert.doesNotMatch(report.run!.finishedReason ?? '', /declared itself blocked/);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a REAL halt arms bounded auto-recovery and runs the same healer, once, now', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root); // board still reads phase 2 open — the halt is real
    const healed: string[] = [];
    (svc as never as Record<string, unknown>).maybeAutoRecover =
      async (slug: string) => { healed.push(slug); return { launched: true }; };

    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'recovering');
      assert.deepEqual(healed, ['alpha'], 'the unattended healer IS the vehicle — no second orchestration');
      assert.ok(report.steps.some((step) => /armed auto-recovery/.test(step)));
      // Arming is a BOOLEAN, and since 3.5.0 it is written as one. The bound is
      // the operator's `ladderPerPhaseRungs` (default 3), never a number stored
      // beside the arming: `attempts` was a second per-phase ceiling that
      // silently beat the pref (P6/D5), was left in the file for a release so
      // an older console still read the run as armed, and is now not written at
      // all. Every reader asks the object's PRESENCE, which is what the empty
      // object still says.
      assert.deepEqual(report.run!.autoRecover, {});
      assert.ok(report.steps.some((step) => /3 bounded rungs per phase/.test(step)),
        'the step names the ceiling that actually applies');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a needs-you carries the errand when the ladder wrote one — need and how, not a bare refusal', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    // A declared credential blocker: the session said what it lacks; no rung
    // exists for it, so the errand is written at once and the answer repeats it.
    haltedRun(root, {
      autoRecover: { attempts: 2 },
      halt: {
        at: new Date().toISOString(),
        reason: 'phase 2 declared itself blocked: the deploy needs the SSH key for the box, which no session holds',
        phase: 2, kind: 'phase-blocked',
      },
    });
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'errand', 'an unresolvable stop is an errand, never a bare needs-you');
      assert.ok(report.steps.some((step) => /phase 2 reads Declared blocked · credential/.test(step)), report.steps.join(' | '));
      assert.match(report.detail, /Needed: .*credential/i);
      assert.match(report.detail, /How: /);
      // A person's ask: Recover says it needs their answer and names the verb
      // that gives it (control-tower phase 88, #124 — EA-3).
      assert.match(report.detail, /^This needs your answer/);
      assert.match(report.detail, /Done — continue on phase 2/);
      assert.equal(report.errand?.situation, 'blocked-declared:credential', 'the Errand body rides the answer');
      assert.equal(report.errand?.phase, 2);
      assert.ok(report.errand?.need && report.errand?.how);
      assert.equal(report.run?.recoveries?.['2']?.errand?.situation, 'blocked-declared:credential');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('what only a person can settle comes back named, never blindly retried', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    haltedRun(root, {
      halt: {
        at: new Date().toISOString(),
        reason: 'phase 2 needs a person: the deploy window must be confirmed',
        phase: 2, kind: 'needs-human',
      },
    });
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'errand');
      assert.match(report.detail, /not auto-recoverable|needs a person|auto-recovery|Needed:/i);
      assert.ok(report.errand, 'the errand body is always there on an errand outcome');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a live run is left alone', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = haltedRun(root);
    (svc as never as Record<string, unknown>).liveRunner =
      () => ({ current: () => state, busy: () => true });
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'running');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ *
 * FS-10 — Recover over a halt the board has superseded (control-tower phase 45, #45)
 * ------------------------------------------------------------------ */

/**
 * The #45 second defect: two runs halted `failure-streak` on phases the board
 * read done. Recover answered "superseded — nothing to launch" and left each
 * run halted with ready phases, `consecutiveFailures: 2`, until somebody made
 * the start call by hand. The anchor's record is one this run ADJUDICATED, so
 * reconcile — rightly — never closes it; the press is what must see past it.
 */
function streakHalted(root: string, anchor: Partial<import('../server/runner/state.ts').PhaseRecord>): RunState {
  const state = haltedRun(root, {
    halt: { at: new Date().toISOString(), reason: '2 phases failed in a row: phase 1, then phase 2', phase: 2, kind: 'failure-streak' },
    consecutiveFailures: 2, failureStreak: [1, 2], maxConsecutiveFailures: 2,
  });
  Object.assign(phaseRecord(state, 2), {
    status: 'failed', attempts: 1,
    halt: { at: new Date().toISOString(), reason: 'phase 2 did not verify', phase: 2, kind: 'verify-failed' },
    ...anchor,
  });
  saveRun(state);
  // Phase 1 is still open — something to continue into — and phase 2's own
  // handoff reads complete, so the board shows the halt's anchor done.
  rmSync(join(root, 'docs', 'handoffs', 'alpha', 'phase-01-schema.md'), { force: true });
  handoff(root, 2, 'cart-api', 'complete');
  return state;
}

test('FS-10: Recover on a failure-streak halt whose anchor the board shows done clears the halt and continues — one press', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = streakHalted(root, {
      // A red this run RAN and adjudicated: reconcile holds the record (D27).
      verification: { ok: false, reason: '`npm test` exited 1', notRun: [],
        ran: [{ command: 'npm test', ok: false, code: 1, ms: 5, output: '' }, { command: 'npm test', ok: false, code: 1, ms: 5, output: '', retry: true }] },
    });
    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun =
      async (slug: string, options: unknown) => { started.push({ slug, options }); return state; };
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'resumed', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 1, 'the run continues in the same press');
      assert.ok(report.steps.some((s) => /phase 2 done — the failure-streak stop anchored on it no longer stands/.test(s)),
        report.steps.join(' | '));
      const after = listRuns(root, 'alpha')[0]!;
      assert.equal(after.halt, null, 'the halt is cleared on disk, not only in the answer');
      assert.equal(after.phases['2'].status, 'failed', 'the adjudicated verdict itself is not rewritten');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('FS-10: the exact #45 record — a verify-failed halt over a GREEN verification — closes, and the run resumes', async () => {
  const root = scratch();
  try {
    const svc = service(root);
    const state = streakHalted(root, {
      verification: { ok: true, reason: '4 commands green; `pnpm verify:local` green on retry (first exited 1)', notRun: [],
        ran: [{ command: 'pnpm verify:local', ok: false, code: 1, ms: 5, output: '' }, { command: 'pnpm verify:local', ok: true, code: 0, ms: 5, output: '', retry: true }] },
    });
    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun =
      async (slug: string, options: unknown) => { started.push({ slug, options }); return state; };
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'resumed', `${report.outcome}: ${report.detail}`);
      assert.equal(started.length, 1);
      const after = listRuns(root, 'alpha')[0]!;
      assert.equal(after.halt, null);
      assert.equal(after.phases['2'].status, 'done', 'its own verdict was green — the board\'s done stands');
      assert.deepEqual(after.failureStreak, [1], 'and it left the streak; phase 1\'s failure stands');
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#97 beside FS-10: a stop that is not about the plan is not held to the lint — step 1b still clears it, and validate.sh is never asked', async () => {
  // Recover asks the lint for a stop about the PLAN, or for a mark an OLDER
  // reading left on the run — never because this press's own resolve just
  // wrote one over a failure-streak anchored on a done phase (control-tower
  // phase 81): that stop is the board's to answer, and a clean lint saying it
  // was "answered" would be the wrong reason on the record.
  const root = scratch();
  try {
    const svc = service(root);
    const state = streakHalted(root, {});
    let asked = 0;
    (svc as never as Record<string, unknown>).lint = async () => {
      asked += 1;
      return { ok: true, issues: [], summary: 'VALIDATE OK: alpha', timedOut: false, crashed: false };
    };
    const started: unknown[] = [];
    (svc as never as Record<string, unknown>).startRun =
      async (slug: string, options: unknown) => { started.push({ slug, options }); return state; };
    try {
      const report = await svc.recoverPlan('alpha');
      assert.equal(report.outcome, 'resumed', `${report.outcome}: ${report.detail}`);
      assert.equal(asked, 0, 'the lint answers a stop about the plan, not this one');
      assert.ok(report.steps.some((s) => /the failure-streak stop anchored on it no longer stands/.test(s)), report.steps.join(' | '));
      assert.equal(started.length, 1);
    } finally { svc.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
