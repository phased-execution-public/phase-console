/**
 * Three rejections escalate — once (control-tower phase 134, #211).
 *
 *   ES-1  the `turnEscalateAfter`-th rejection of one item (3, shipped)
 *         escalates it ONCE: one push saying so, and on the item the attempts
 *         side by side with their evidence; a fourth rejection is told as a
 *         return, never escalated again. The count is a preference.
 *   ES-2  its three ways out: *Rewrite the guide* (the item withdrawn, its
 *         raiser resumed with the rejection history and told to raise a new
 *         version), *I can't* (an errand), or the owner's *Accept anyway* —
 *         passed, recorded as the owner's and unverified, every waiter resumed.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { call, harness, journal, parked } from './turn-harness.ts';

type WatchState = import('../server/watch-refs.ts').WatchState;

const GH = { kind: 'browser-login', title: 'Sign gh in', open_url: 'https://github.com/login/device', proof: 'cmd:"gh auth status"' };

/** Reject every check, saying what the proof read this time. */
function rejecting(h: ReturnType<typeof harness>): void {
  let n = 0;
  h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'pending', detail: `exit 1 — read ${n += 1}` });
}

/** The pushes that carried an escalation, and the ones that carried a return. */
function pushWords(h: ReturnType<typeof harness>): { stuck: number; back: number } {
  const text = h.pushes.map((p) => JSON.stringify(p));
  return { stuck: text.filter((t) => /Stuck after/.test(t)).length, back: text.filter((t) => /Back to you/.test(t)).length };
}

test('ES-1 — the third rejection escalates ONCE; the item holds the attempts side by side, with their evidence', async () => {
  const h = harness();
  try {
    rejecting(h);
    const { state, step } = parked(h, GH);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: `try ${attempt}` });
      const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
      assert.equal(checked.status, 200);
      assert.equal(Boolean(checked.body.escalated), attempt === 3, `attempt ${attempt}`);
    }
    assert.deepEqual(pushWords(h), { stuck: 1, back: 3 }, 'told once per return, and the escalation once — in place of the third');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'returned');
    assert.ok(now.escalatedAt, 'the item says when it escalated');
    const view = ((await call(h.svc, 'GET', '/api/human-steps')).body.steps as { id: string; verdicts: { attempt: number; note: string }[]; evidence: { attempt: number }[] }[])
      .find((s) => s.id === step.id)!;
    assert.deepEqual(view.verdicts.map((v) => v.attempt), [1, 2, 3, 4], 'every attempt, side by side');
    assert.deepEqual(view.verdicts.map((v) => /read (\d)/.exec(v.note)?.[1]), ['1', '2', '3', '4'], 'each with what it read');
    assert.deepEqual(view.evidence.map((e) => e.attempt), [1, 2, 3, 4], 'and the evidence each was sent with');
    const escalated = journal(h.root, state).filter((l) => l.event === 'phase.human-step-escalated');
    assert.equal(escalated.length, 1);
    assert.equal(escalated[0].data.rejections, 3);
    assert.equal(h.resumed.length, 0, 'an escalation resumes nothing — the owner decides');
  } finally { h.cleanup(); }
});

test('ES-1 — the count is a preference: turnEscalateAfter 2 escalates at the second', async () => {
  const h = harness();
  try {
    rejecting(h);
    (h.svc as unknown as { prefs: Record<string, unknown> }).prefs = { ...(h.svc as unknown as { prefs: object }).prefs, turnEscalateAfter: 2 };
    const { step } = parked(h, GH);
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    const second = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(second.body.escalated, true);
    assert.deepEqual(pushWords(h), { stuck: 1, back: 1 });
  } finally { h.cleanup(); }
});

test('ES-2 — Rewrite the guide: withdrawn, and its raiser resumed once with every rejection, told to send a new version', async () => {
  const h = harness();
  try {
    rejecting(h);
    const { state, step } = parked(h, GH);
    for (let i = 0; i < 3; i += 1) await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    const rewrite = await call(h.svc, 'POST', `/api/human-steps/${step.id}/rewrite`, {});
    assert.equal(rewrite.status, 200, JSON.stringify(rewrite.body));
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'dismissed');
    assert.equal(h.resumed.length, 1, 'its raiser, once');
    const said = String(h.resumed[0].instruction);
    assert.match(said, /could not get "Sign gh in" .* past its check: it came back 3 times/);
    assert.match(said, /Attempt 1 — rejected by the probe: The proof did not hold — cmd:"gh auth status" read: pending — exit 1 — read 1/);
    assert.match(said, /Attempt 3 — rejected by the probe/);
    assert.match(said, /Raise a NEW version of the item with phase-outcome\.sh/);
    assert.match(said, /Do not raise the same item again unchanged/);
    assert.equal(state.phases['3'] !== undefined, true);
  } finally { h.cleanup(); }
});

test('ES-2 — I can\'t becomes an errand; Accept anyway passes it as the owner\'s, unverified, resuming every waiter', async () => {
  const h = harness();
  try {
    rejecting(h);
    const cannot = parked(h, GH).step;
    for (let i = 0; i < 3; i += 1) await call(h.svc, 'POST', `/api/human-steps/${cannot.id}/check`, {});
    const said = await call(h.svc, 'POST', `/api/human-steps/${cannot.id}/cannot`, { reason: 'No access to that org.' });
    assert.equal(said.status, 200);
    assert.equal(h.svc.humanStepsNow().get(cannot.id)!.state, 'cannot');

    const accepted = parked(h, { ...GH, title: 'Sign gh in to the second org' }, 4).step;
    for (let i = 0; i < 3; i += 1) await call(h.svc, 'POST', `/api/human-steps/${accepted.id}/check`, {});
    const override = await call(h.svc, 'POST', `/api/human-steps/${accepted.id}/override`, { note: 'It works from my shell.' });
    assert.equal(override.status, 200, JSON.stringify(override.body));
    const now = h.svc.humanStepsNow().get(accepted.id)!;
    assert.equal(now.state, 'proven');
    assert.deepEqual([now.verdict?.state, now.verdict?.by, now.verdict?.unverified], ['passed', 'owner', true]);
    assert.match(now.verdict!.note, /^Accepted anyway by the owner: It works from my shell/);
    assert.deepEqual(now.verdicts?.map((v) => `${v.attempt}:${v.state}:${v.by}`), ['1:rejected:probe', '2:rejected:probe', '3:rejected:probe', '3:passed:owner'],
      'recorded as the owner\'s, after the three it overrode');
    assert.equal(h.resumed.length, 1);
    assert.match(String(h.resumed[0].instruction), /the owner accepted it anyway — nothing read a proof, so it is UNVERIFIED/);
  } finally { h.cleanup(); }
});
