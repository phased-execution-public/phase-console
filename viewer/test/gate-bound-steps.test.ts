/**
 * A Your turn item bound to a gate settles when the gate opens (one-pool
 * phase 13, #371).
 *
 *   GB-1  approving the gate through the console moves every open item whose
 *         proof reads that gate's row (`stepGateOf`) to Passed — "Gate
 *         approved by …" — in the same press, and leaves an item bound to
 *         another gate open.
 *   GB-2  a gate approved OUTSIDE the console (`gate-approve.sh` in a
 *         terminal, an AI session's row) settles its items too: the round's
 *         proof pass reads the gate clear and passes them, once.
 *   GB-3  a gate-bound card never tells a person to press a button it does
 *         not show: its words end on the gate's Approve, and no
 *         *I've done this — check* is offered beside it.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SLUG, call, harness } from './turn-harness.ts';

const { SKILL_DIR } = await import('../server/config.ts');
type HumanStep = import('../server/human-steps.ts').HumanStep;

/** Phases 4 and 5 gated — a person's to clear, or an AI session's. */
function gatePlan(root: string, check = 'manual the owner'): void {
  const file = join(root, 'docs', 'plans', `${SLUG}.md`);
  let text = readFileSync(file, 'utf8');
  for (const n of [4, 5]) {
    text = text.replace(
      `### Phase ${n} — ${n === 4 ? 'four' : 'five'}\n`,
      `### Phase ${n} — ${n === 4 ? 'four' : 'five'} *(GATED)*\n- **Gates (must clear first):** the owner approves the release\n- **Gate-check:** ${check}\n`,
    );
  }
  writeFileSync(file, text);
}

/** A plan-born step whose proof greps the gate's row — the shape every "approve on Phase N's Gate card" errand takes. */
function gateStep(h: ReturnType<typeof harness>, phase: number, eref: string): HumanStep {
  const status = join(h.root, 'docs', 'handoffs', SLUG, 'gate-status.md');
  const step = h.svc.recordHumanStep({
    slug: SLUG, phase: 3, birth: 'plan',
    step: {
      kind: 'decision', title: `Approve Release H on Phase ${phase}'s Gate card (${eref})`, where: 'any', why: 'decision',
      proof: `cmd:"grep -Eq '^[|] *${phase} *[|]' ${status}"`,
    },
  });
  assert.ok(step && !('refused' in step), JSON.stringify(step));
  return step as HumanStep;
}

function itemsOf(body: Record<string, unknown>): { item: string; actions?: { verb: string; endpoint?: string }[]; how?: string; steps?: { text: string }[] }[] {
  return Object.values(body.groups as Record<string, never[]>).flat();
}

test('GB-1 — the gate\'s Approve settles every item bound to it, in the same press', async () => {
  const h = harness();
  try {
    gatePlan(h.root);
    (h.svc as unknown as { reread: (slug: string) => void }).reread(SLUG);
    const four = gateStep(h, 4, 'E-2');
    const five = gateStep(h, 5, 'E-3');
    const approved = await call(h.svc, 'POST', `/api/plans/${SLUG}/gate/4`, { approve: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((approved.body as { ok?: boolean }).ok, true, JSON.stringify(approved.body));
    const now = h.svc.humanStepsNow().get(four.id)!;
    assert.equal(now.state, 'proven', 'the item bound to Phase 4\'s gate is Passed');
    assert.equal(now.verdict?.state, 'passed');
    assert.match(now.verdict?.note ?? '', /^Gate approved by .+ at \d{4}-\d\d-\d\d \d\d:\d\d UTC — the gate on Phase 4 of alpha is open\.$/);
    assert.notEqual(h.svc.humanStepsNow().get(five.id)!.state, 'proven', 'an item bound to another gate stays open');
  } finally { h.cleanup(); }
});

test('GB-2 — a gate approved outside the console settles its items on the round', async () => {
  const h = harness();
  try {
    // An AI-cleared gate: the row an AI session writes with gate-approve.sh.
    gatePlan(h.root, 'ai the release notes are written');
    (h.svc as unknown as { reread: (slug: string) => void }).reread(SLUG);
    const four = gateStep(h, 4, 'E-2');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PE_|CLAUDE)/.test(key)));
    const run = spawnSync('/bin/bash', [join(SKILL_DIR, 'scripts', 'gate-approve.sh'), SLUG, '4', '--by', 'ai-session', '--note', 'notes written'], {
      env: { ...env, DOCS_ROOT: h.root }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(join(h.root, 'docs', 'handoffs', SLUG, 'gate-status.md'), 'utf8'), /\|\s*4\s*\|/);
    (h.svc as unknown as { reread: (slug: string) => void }).reread(SLUG);
    const pass = (h.svc as unknown as { turnProofPass: () => Promise<string[]> }).turnProofPass.bind(h.svc);
    const settled = await pass();
    assert.deepEqual(settled, [four.id], 'the round settles it, once');
    assert.equal(h.svc.humanStepsNow().get(four.id)!.state, 'proven');
    assert.deepEqual(await pass(), [], 'and never twice');
  } finally { h.cleanup(); }
});

test('GB-3 — a gate-bound card says Approve the gate and offers no check beside it', async () => {
  const h = harness();
  try {
    gatePlan(h.root);
    (h.svc as unknown as { reread: (slug: string) => void }).reread(SLUG);
    const four = gateStep(h, 4, 'E-2');
    const turn = await call(h.svc, 'GET', '/api/turn');
    assert.equal(turn.status, 200);
    const item = itemsOf(turn.body).find((one) => one.item === four.id);
    assert.ok(item, 'the item is on Your turn');
    const verbs = (item!.actions ?? []).map((action) => action.verb);
    assert.ok(!verbs.includes('check'), `no check on a gate-bound card: ${verbs.join(',')}`);
    assert.ok((item!.actions ?? []).some((action) => action.endpoint === `/api/plans/${SLUG}/gate/4`), 'its act is the gate\'s Approve');
    const words = JSON.stringify(item);
    assert.ok(!/press I've done this — check/.test(words), 'it never tells a person to press a button it does not show');
    assert.match(words, /Approve the gate on Phase 4/);
  } finally { h.cleanup(); }
});
