/**
 * Does a plan already order its own reviewer inside the building session?
 * (autopilot-token-drain phase 5, H5)
 *
 * Run `deadaff9` paid for two reviews of every phase it finished: the plan's own
 * §Adversarial review, which each builder dispatched, and the console's
 * `reviewEachPhase` session on top ($9.62 on P1, $7.26 on P8). Nothing linked the
 * two. The launch form now advises when both are on, and this is the reading it
 * advises from — deliberately narrow, because an advisory that fires on a plan
 * merely TALKING about reviewers teaches an operator to ignore it.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DOCUMENT_PLAN_FIELDS } from '../shared/projection.js';
import { inPlanReviewers } from '../shared/run-settings.js';

const { parsePlan } = await import('../server/parse/plan.ts');

/** `ai-builder-v4` as run `deadaff9` launched it (hub `e99703bf6`), cut to the section. */
const ADVERSARIAL = `## Session budget

**Target model:** opus

### Adversarial review (the review that needs no human)

At phase-finish, before the handoff: dispatch ONE fresh-context reviewer (\`Agent\`, \`subagent_type: feature-dev:code-reviewer\`; \`general-purpose\` if unavailable) with this brief — *"Review the diff of the train branch against \`origin/main\` in \`<repo>\` (\`git diff origin/main...HEAD\`), plus the phase's §Exit criteria."* The finishing session fixes every P0/P1, re-runs §Verification after the last commit, and records the verdict in the handoff.

### Checkout discipline

- Never \`git stash\`.
`;

/** The same plan after its owner removed the review (2026-09-17), verbatim. */
const REMOVED = `### No review rounds (owner decision 2026-09-17)

The per-phase adversarial review is **removed from every phase**. Phase 5's review — dispatched
before the decision — is the plan's last: P5 fixes its P0/P1 findings, and its artefact stays under
\`docs/handoffs/ai-builder-v4/reviews/\` as history beside the earlier ones (a P0/P1 any of them
recorded is still a defect to fix, never a finding to re-review). No remaining phase (7, 9–24)
dispatches a reviewer agent, writes a review artefact or runs a delta round; P20's former security
review is now its red-proved security test matrix (§Phase 20).
`;

test("deadaff9's plan: its §Adversarial review is found, with the section and the words that order it", () => {
  const found = inPlanReviewers(ADVERSARIAL);
  assert.equal(found.length, 1);
  assert.equal(found[0].section, 'Adversarial review (the review that needs no human)');
  assert.match(found[0].excerpt, /dispatch ONE fresh-context reviewer/);
  assert.ok(found[0].excerpt.length <= 240, 'an excerpt, not the brief');
});

test('a plan that says no phase dispatches a reviewer orders none', () => {
  assert.deepEqual(inPlanReviewers(REMOVED), []);
});

test("the wait procedure's rule 2 mentions a reviewer's verdict and orders nothing", () => {
  const rule = "2. You need a subagent's answer (a reviewer's verdict) → dispatch the `Agent` in the FOREGROUND; " +
    'the call returns with the answer and costs nothing while it runs.';
  assert.deepEqual(inPlanReviewers(rule), []);
});

test('a subagent_type that names a reviewer orders one; a subagent_type that explores does not', () => {
  const ordered = '### Phase 2 — api\n- **Steps:** 4. Before the handoff, run `Agent` with `subagent_type: superpowers:code-reviewer` over the diff.';
  assert.deepEqual(inPlanReviewers(ordered).map((m) => m.section), ['Phase 2 — api']);
  assert.deepEqual(inPlanReviewers('Sweep the tree with `Agent` (`subagent_type: Explore`) and keep only its conclusion.'), []);
});

test('a reviewer dispatched across a wrapped line is still found, under its phase', () => {
  const text = '### Phase 3 — the api\n- **Steps:**\n  1. Build it.\n  2. At phase-finish, dispatch an independent\n     reviewer with the exit criteria.\n';
  assert.deepEqual(inPlanReviewers(text).map((m) => m.section), ['Phase 3 — the api']);
});

test('one mention per section, and never more than five', () => {
  const section = (n: number) => `### S${n}\n\nDispatch a reviewer. Then dispatch a reviewer again.\n`;
  const found = inPlanReviewers(Array.from({ length: 7 }, (_, i) => section(i)).join('\n'));
  assert.deepEqual(found.map((m) => m.section), ['S0', 'S1', 'S2', 'S3', 'S4']);
});

test('the parsed plan carries it, and the board projection keeps it without ?include=document', () => {
  const plan = parsePlan(`---\nslug: demo\n---\n# demo\n\n${ADVERSARIAL}`, 'demo', 'docs/plans/demo.md');
  assert.equal(plan.reviewers.length, 1);
  assert.equal(parsePlan(`# demo\n\n${REMOVED}`, 'demo', 'docs/plans/demo.md').reviewers.length, 0);
  assert.ok(!DOCUMENT_PLAN_FIELDS.includes('reviewers'), 'the run page reads it from the board projection');
});
