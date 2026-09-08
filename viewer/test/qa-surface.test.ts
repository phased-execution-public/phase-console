/**
 * One QA surface — what the plan detail says about each phase's QA, and the
 * report itself (2026-09-07).
 *
 * Measured before this: the report was only ever a PATH on every surface and
 * no route served it; the plan-level mode was one bare word with its reason
 * flattened away; and the PER-PHASE regime never reached the client at all —
 * resolved server-side for `deriveEvidence` only — so three surfaces judged
 * "is this phase held?" with the PLAN's word, wrong for a phase carrying its
 * own `- **QA:** off`. Held dependents existed only as client-side prose.
 *
 * The fixture is `tests/fixtures/plans/qa-per-phase.md` — phase 2 opts out,
 * phase 3 opts in, the rest inherit the plan's `on` — with a two-table ledger
 * (phase 3 failed twice) and the two report files on disk.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PHASE_CONSOLE_LOG = '';

const { SKILL_DIR } = await import('../server/config.ts');
const { Service } = await import('../server/service.ts');
const { qaHeldBy } = await import('../server/service-core.ts');

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'plans', 'qa-per-phase.md');
const SLUG = 'qa-per-phase';

const handoff = (phase: number, title: string) => `---
plan: docs/plans/${SLUG}.md
phase: ${phase}
title: ${title}
status: complete
completed: 2026-09-01
---

# Phase ${phase} — ${title}

## What this phase did
It did the thing.
`;

const LEDGER = `# QA / test status — ${SLUG}

## QA status

| Phase | Result | Report |
|------:|--------|--------|
| 1 | pass | reports/phase-01-qa.md |
| 2 | waived | - |
| 3 | fail | reports/phase-03-qa-round2.md |

## QA rounds

Every round recorded for this plan, appended.

| Phase | Round | Result | Report | Recorded |
|------:|------:|--------|--------|----------|
| 3 | 1 | fail | reports/phase-03-qa.md | 2026-09-05 |
| 3 | 2 | fail | reports/phase-03-qa-round2.md | 2026-09-06 |
`;

const OPEN = new Map<string, InstanceType<typeof Service>[]>();

function scratch(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'pc-qa-surface-'));
  const dir = join(root, 'docs', 'handoffs', SLUG);
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  copyFileSync(FIXTURE, join(root, 'docs', 'plans', `${SLUG}.md`));
  writeFileSync(join(dir, 'phase-01-inherits.md'), handoff(1, 'inherits'), 'utf8');
  writeFileSync(join(dir, 'phase-02-qa-off.md'), handoff(2, 'qa-off'), 'utf8');
  writeFileSync(join(dir, 'phase-03-qa-on.md'), handoff(3, 'qa-on'), 'utf8');
  writeFileSync(join(dir, 'test-status.md'), LEDGER, 'utf8');
  writeFileSync(join(dir, 'reports', 'phase-03-qa.md'), '# Round 1\n\nfindings one\n', 'utf8');
  writeFileSync(join(dir, 'reports', 'phase-03-qa-round2.md'), '# Round 2\n\nfindings two\n', 'utf8');
  return {
    root,
    cleanup: () => {
      for (const svc of OPEN.get(root) ?? []) svc.close();
      OPEN.delete(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function service(root: string) {
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: false,
    scriptsDir: SCRIPTS, logFile: null,
  } as never);
  svc.push.announce = (() => {}) as typeof svc.push.announce;
  assert.equal(svc.open(root).ok, true);
  OPEN.set(root, [...(OPEN.get(root) ?? []), svc]);
  return svc;
}

test('each phase carries ITS regime and where it came from, and the plan keeps its reason', async () => {
  const { root, cleanup } = scratch();
  try {
    const detail = (await service(root).detail(SLUG))!;
    const by = new Map(detail.phases.map((p) => [p.phase, p]));
    assert.deepEqual(by.get(2)?.qaMode, { mode: 'off', source: 'phase' }, 'phase 2 opted out itself');
    assert.deepEqual(by.get(3)?.qaMode, { mode: 'on', source: 'phase' }, 'phase 3 opted in itself');
    assert.deepEqual(by.get(1)?.qaMode, { mode: 'on', source: 'plan' }, 'phase 1 inherits the plan');
    assert.deepEqual(by.get(5)?.qaMode, { mode: 'on', source: 'plan' });
    assert.equal(detail.summary.qaMode, 'on');
    assert.match(detail.summary.qaModeReason ?? '', /plan directive/, 'the reason is not flattened away');
  } finally { cleanup(); }
});

test('the rounds ledger reaches each phase — how many, and the latest — and the board says whom a verdict holds', async () => {
  const { root, cleanup } = scratch();
  try {
    const detail = (await service(root).detail(SLUG))!;
    const by = new Map(detail.phases.map((p) => [p.phase, p]));
    assert.deepEqual(by.get(3)?.qaRounds, {
      count: 2,
      latest: { round: 2, result: 'fail', report: 'reports/phase-03-qa-round2.md' },
    });
    // A status row alone is not a round on the ledger.
    assert.equal(by.get(1)?.qaRounds, undefined);
    assert.equal(by.get(2)?.qaRounds, undefined);
    // Phase 3's fail holds phase 5; phase 2's waiver (and its own `off`) holds
    // nothing — phase 4 is ready. The ENGINE's word, not a client's prose.
    assert.deepEqual(detail.qaHeld, { 3: [5] });
    assert.ok(detail.summary.ready.includes(4), `phase 4 is ready: ${JSON.stringify(detail.summary.ready)}`);
  } finally { cleanup(); }
});

test('qaHeldBy joins the two board maps and answers only what is actually held', () => {
  assert.deepEqual(qaHeldBy({ qa: { 3: 'fail', 2: 'pending' }, blockedBy: { 5: [3], 6: [3, 4], 4: [2] } }), { 2: [4], 3: [5, 6] });
  // A verdict that holds nothing is absent, never an empty list.
  assert.deepEqual(qaHeldBy({ qa: { 3: 'fail' }, blockedBy: { 5: [4] } }), {});
  assert.deepEqual(qaHeldBy({}), {});
});

test('the report is served by (phase, round) from the handoff folder only, latest round by default', async () => {
  const { root, cleanup } = scratch();
  try {
    const svc = service(root);
    const two = svc.qaReport(SLUG, 3, 2);
    assert.equal(two?.path, 'reports/phase-03-qa-round2.md');
    assert.equal(two?.round, 2);
    assert.match(two?.text ?? '', /findings two/);
    assert.match(svc.qaReport(SLUG, 3, 1)?.text ?? '', /findings one/);
    // No round: the latest the ledger records.
    assert.equal(svc.qaReport(SLUG, 3)?.round, 2);
    // A status row naming a report that is not on disk is a miss, not an error.
    assert.equal(svc.qaReport(SLUG, 1), null);
    // Refusals: a round nobody wrote, an impossible phase, a plan that is not here.
    assert.equal(svc.qaReport(SLUG, 3, 9), null);
    assert.equal(svc.qaReport(SLUG, 0, 1), null);
    assert.equal(svc.qaReport(SLUG, 3, 0), null);
    assert.equal(svc.qaReport('no-such-plan', 3), null);
  } finally { cleanup(); }
});
