/**
 * The answer's road back to the session (control-tower phase 133, #210).
 *
 * A parked session has no stdin (`runner/spawn.ts` closes it at the first
 * completed turn), so whatever a person answers travels as ONE resume the
 * console composes.
 *
 *   RB-1  an answer resumes every waiter ONCE through `pressResume`, saying
 *         "The operator answered `<option>`: <note>" — the item's own lane
 *         and every other lane that met the same wall (G7).
 *   RB-2  a decline resumes every waiter once: "The operator declined:
 *         <reason>. Do not ask again; find another way inside the plan or say
 *         what remains" — and the declared step leaves the watch.
 *   RB-3  a pass (a check that proves the item) resumes once; nothing is
 *         resumed for a snooze, a question or an attachment.
 *   RB-4  an answer whose item names a `## Decisions` key is written to the
 *         plan's decision twin through `decisions.sh` FIRST — and with writes
 *         off it is refused before anything moves or resumes.
 *   OM-7  a question a person asked rides the raising session's next resume:
 *         "The person asked: …".
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DECISION, SLUG, call, harness, journal, loadRun, parked, saveRun } from './turn-harness.ts';

type WatchState = import('../server/watch-refs.ts').WatchState;

test('RB-1 — an answer resumes each waiter once, in the operator\'s words, through the one press', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, DECISION);
    // Another lane of the same run met the same wall: one item, a second waiter (G7).
    const record4 = (await import('../server/runner/state.ts')).phaseRecord(state, 4);
    record4.status = 'parked';
    record4.sessionId = 'sess-4';
    record4.endedAt = new Date().toISOString();
    saveRun(state);
    const waited = h.svc.humanStepsNow().addWaiter(step.id, { slug: SLUG, phase: 4, runId: state.id, sessionId: 'sess-4' });
    assert.ok(!('refused' in waited));

    const answered = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o1', note: 'keep it on the box' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(h.resumed.map((r) => r.phase).sort(), [3, 4], 'one resume per waiter');
    for (const resume of h.resumed) {
      assert.equal(resume.mode, 'resume', 'the phase\'s own session');
      assert.match(String(resume.instruction), /^The operator answered `Use Postgres`: keep it on the box\./);
      assert.match(String(resume.instruction), /option o1, whose consequence you wrote as: one more table on the box/);
      assert.match(String(resume.instruction), /do not ask it again/);
    }
    assert.deepEqual((answered.body.resumes as { phase: number; launched: boolean }[]).map((r) => [r.phase, r.launched]).sort(),
      [[3, true], [4, true]]);
    const pressed = journal(h.root, state).filter((l) => l.event === 'phase.resume-pressed');
    assert.equal(pressed.length, 2, 'each through pressResume, journalled as a press');
    assert.equal(loadRun(h.root, SLUG, state.id)!.phases['3'].declared?.step?.settled, 'proven', 'its proof leaves the watch');
    // A second answer finds it settled: nothing resumes twice.
    const again = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o2' });
    assert.equal(again.status, 409);
    assert.equal(h.resumed.length, 2);
  } finally { h.cleanup(); }
});

test('RB-2 — a decline resumes its waiter once: declined, with the reason, told not to ask again', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, { ...DECISION, allow_decline: true });
    const declined = await call(h.svc, 'POST', `/api/human-steps/${step.id}/decline`, { reason: 'neither — drop the cache.' });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(h.resumed.length, 1);
    assert.equal(h.resumed[0].phase, 3);
    assert.match(String(h.resumed[0].instruction),
      /^The operator declined: neither — drop the cache\. Do not ask again; find another way inside the plan or say what remains\./);
    assert.equal(loadRun(h.root, SLUG, state.id)!.phases['3'].declared?.step?.settled, 'declined');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'declined');
  } finally { h.cleanup(); }
});

test('RB-3 — a pass resumes once; a snooze, a question and an attachment resume nothing', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' });
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/snooze`, { minutes: 10 })).status, 200);
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/ask`, { text: 'Which port?' })).status, 200);
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: 'It is in.' })).status, 200);
    assert.equal(h.resumed.length, 0, 'nothing resumed for a snooze, a question or an attachment');
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(checked.status, 200);
    assert.equal(h.resumed.length, 1, 'a pass resumes once');
    assert.match(String(h.resumed[0].instruction), /person's turn this phase declared is done/);
  } finally { h.cleanup(); }
});

test('OM-7 — a question a person asked rides the raising session\'s next resume, with its time', async () => {
  const h = harness();
  try {
    const answeredItem = parked(h, DECISION).step;
    await call(h.svc, 'POST', `/api/human-steps/${answeredItem.id}/ask`, { text: 'Is Postgres already backed up?' });
    await call(h.svc, 'POST', `/api/human-steps/${answeredItem.id}/answer`, { option: 'o1' });
    assert.match(String(h.resumed[0].instruction), /The person asked: "Is Postgres already backed up\?" \(\d{4}-\d{2}-\d{2}T/);

    const proven = parked(h, { kind: 'browser-login', title: 'Sign gh in', open_url: 'https://github.com/login/device', proof: 'cmd:"gh auth status"' }, 4).step;
    await call(h.svc, 'POST', `/api/human-steps/${proven.id}/ask`, { text: 'Which account — work or personal?' });
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'landed', detail: 'exit 0' });
    await call(h.svc, 'POST', `/api/human-steps/${proven.id}/check`, {});
    assert.match(String(h.resumed[1].instruction), /The person asked: "Which account — work or personal\?"/, 'a pass carries it too');
  } finally { h.cleanup(); }
});

test('RB-4 — an answer naming a decision key is written to the plan\'s twin through decisions.sh first', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { ...DECISION, decision_key: 'credentials' });
    assert.equal(h.svc.humanStepsNow().get(step.id)!.decisionKey, 'credentials');
    const answered = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o1', note: 'the npm token only' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(answered.body.decision, { key: 'credentials', written: true });
    const twin = join(h.root, 'docs', 'handoffs', SLUG, 'decisions.md');
    assert.ok(existsSync(twin), 'decisions.sh wrote the twin');
    const row = readFileSync(twin, 'utf8').split('\n').find((line) => line.includes('`credentials`'));
    assert.ok(row, `a credentials row: ${readFileSync(twin, 'utf8')}`);
    assert.match(row!, /Use Postgres — the npm token only/);
    assert.match(row!, /answered/);
    assert.match(row!, /\| 3 \|/, 'the phase\'s own row — one item does not re-answer the key for every phase');
    assert.equal(h.resumed.length, 1, 'and then the session hears it');
  } finally { h.cleanup(); }

  const off = harness({ allowWrites: false });
  try {
    const { step } = parked(off, { ...DECISION, decision_key: 'credentials' });
    const refused = await call(off.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o1' });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /credentials row/);
    assert.equal(off.svc.humanStepsNow().get(step.id)!.state, 'notified', 'nothing moved');
    assert.equal(off.resumed.length, 0, 'and nothing resumed');
  } finally { off.cleanup(); }
});

test('RB-4 — a declaration\'s --needs is never taken for the key: an item names one only when it says so', async () => {
  const { sanitiseStep } = await import('../server/human-steps.ts');
  assert.equal(sanitiseStep({ ...DECISION }, 'session')!.step.decisionKey, undefined);
  assert.equal(sanitiseStep({ ...DECISION, decision_key: 'ambiguity' }, 'session')!.step.decisionKey, 'ambiguity');
  const clean = sanitiseStep({ ...DECISION, decision_key: 'not-a-key' }, 'session')!;
  assert.equal(clean.step.decisionKey, undefined);
  assert.ok(clean.dropped.includes('decision_key'));
});

test('RB-1 — a relayed question\'s decision item: the option the person chose reaches the parked session (phase 132\'s note)', async () => {
  const h = harness();
  try {
    const { newRun, phaseRecord } = await import('../server/runner/state.ts');
    const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [5] } as never);
    const record = phaseRecord(state, 5);
    record.status = 'parked';
    record.sessionId = 'sess-5';
    record.endedAt = new Date().toISOString();
    state.status = 'parked' as never;
    saveRun(state);
    // The relay's raise: a console-born decision that keeps the question's options, no declared step behind it.
    const item = h.svc.recordHumanStep({
      slug: SLUG, phase: 5, birth: 'console', runId: state.id, sessionId: 'sess-5',
      step: {
        kind: 'decision', title: 'Ship the migration tonight?', proof_type: 'answer', why: 'decision',
        options: [{ id: 'o1', label: 'Yes, tonight' }, { id: 'o2', label: 'Wait for Monday' }], recommended: 'o2',
        source: { kind: 'relay', ref: 'q-ship' },
      },
    });
    assert.ok(item && !('refused' in item));
    const answered = await call(h.svc, 'POST', `/api/human-steps/${(item as { id: string }).id}/answer`, { option: 'o2', note: 'the DBA is off' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(h.resumed.length, 1, 'its parked session is resumed once');
    assert.equal(h.resumed[0].phase, 5);
    assert.match(String(h.resumed[0].instruction), /^The operator answered `Wait for Monday`: the DBA is off\./);
  } finally { h.cleanup(); }
});

test('RB-5 — a resume that carried its phase on continues the run it left parked, under the watch path\'s guards (phase 141)', async () => {
  // Found by the tower rehearsal's turn group (control-tower phase 141): an
  // answered decision resumed its session, the phase finished, and the run
  // stayed `parked` for good — its next phase never boarded, and converge
  // leaves a run a person pressed. The watch path continued; the press did not.
  const h = harness();
  try {
    const svc = h.svc as unknown as Record<string, unknown> & { runners: Map<string, unknown>; prefs: Record<string, unknown> };
    const started: { slug: string; resumeRunId?: string; door?: string }[] = [];
    let current: Record<string, unknown> | null = null;
    svc.runners.set('demo', { wait: async () => {}, current: () => current });
    svc.startRun = async (slug: string, opts: { resumeRunId?: string; actor?: { door?: string } }) => {
      started.push({ slug, resumeRunId: opts.resumeRunId, door: opts.actor?.door });
      return null;
    };
    svc.liveRunner = () => null;
    svc.fleetHoldFor = () => null;
    (svc as unknown as { flags: Record<string, unknown> }).flags.allowRun = true;
    const actor = { by: 'operator', via: 'browser', origin: 'turn', door: 'operator' };
    const press = async (state: Record<string, unknown>) => {
      current = state;
      started.length = 0;
      // The class's own method: the harness stubs the instance's.
      const real = (Object.getPrototypeOf(svc) as Record<string, unknown>).continueAfterPress;
      (real as (slug: string, runId: string, phase: number, a: unknown) => void).call(svc, 'demo', 'r1', 3, actor);
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      return started.slice();
    };
    const done = { phase: 3, status: 'done' };
    assert.deepEqual(await press({ id: 'r1', slug: 'demo', status: 'parked', halt: null, phases: { 3: done } }),
      [{ slug: 'demo', resumeRunId: 'r1', door: 'operator' }], 'the run left parked with no halt is continued, in the presser\'s name');
    assert.deepEqual(await press({ id: 'r1', slug: 'demo', status: 'parked', halt: { kind: 'needs-human', at: 'x', reason: 'y' }, phases: { 3: done } }),
      [], 'a halt still standing is a person\'s, not continued');
    assert.deepEqual(await press({ id: 'r2', slug: 'demo', status: 'parked', halt: null, phases: { 3: done } }), [], 'another run is not this press\'s');
    assert.deepEqual(await press({ id: 'r1', slug: 'demo', status: 'finished', halt: null, phases: { 3: done } }), [], 'a finished run is left alone');
    svc.prefs.autoContinueRecovery = false;
    assert.deepEqual(await press({ id: 'r1', slug: 'demo', status: 'parked', halt: null, phases: { 3: done } }), [], 'autoContinueRecovery: false keeps it parked');
  } finally {
    h.cleanup();
  }
});
