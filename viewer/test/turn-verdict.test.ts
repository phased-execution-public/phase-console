/**
 * The check — a verdict per submission (control-tower phase 134, #211).
 *
 *   TV-1  a verdict is `{state: passed|rejected|needs-info, note, redo[],
 *         read[], at, by, attempt}`, shaped and bounded whoever offered it — a
 *         state or a writer the vocabulary lacks is no verdict, and neither is a
 *         rejection that says nothing to redo.
 *   TV-2  a rejected or needs-info verdict moves the item to `returned` and
 *         tells the person ONCE what to redo; a passed one moves it to
 *         `proven`.
 *   TV-3  each attempt keeps its evidence and its verdict, and the item counts
 *         the attempts.
 *   TV-4  `probe` runs `probeNow`, and a miss is a rejection quoting what the
 *         proof read.
 *   TV-5  `answer` passes on a valid answer — a check of a decision with none
 *         is needs-info.
 *   TV-6  `attest` passes only through a person's door, marked unverified — the
 *         supervisor's re-check proves nothing, and neither does a call that
 *         names no door (fail closed); the lock screen's button proves it by
 *         the `device` door its press carries.
 *   TV-7  `judgement` runs the checker; with `checkJudgement` off it falls back
 *         to `attest`.
 *   TV-8  a pass resumes every waiter once, through the one gate, with what was
 *         proven, by whom and what the check read; nothing is resumed on a
 *         rejection (exit criterion 6).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JUDGED, SLUG, call, harness, journal, judged, parked, saveRun, scriptedChecker, verdictText } from './turn-harness.ts';

const { shapeVerdict, checkRouteOf, returnedSentence } = await import('../server/turn/verdict.ts');
const { phaseRecord } = await import('../server/runner/state.ts');
type WatchState = import('../server/watch-refs.ts').WatchState;

const AT = '2026-10-07T10:00:00.000Z';
const GH = { kind: 'browser-login', title: 'Sign gh in', open_url: 'https://github.com/login/device', proof: 'cmd:"gh auth status"' };

test('TV-1 — a verdict is the record the ledger keeps: shaped, bounded, redacted, never invented', () => {
  const passed = shapeVerdict({ state: 'passed', note: 'It reads true.', read: ['the summary'] }, { by: 'checker', attempt: 2, at: AT });
  assert.deepEqual(passed, { state: 'passed', note: 'It reads true.', redo: [], read: ['the summary'], at: AT, by: 'checker', attempt: 2 });
  const rejected = shapeVerdict({ state: 'Rejected', note: 'It reads false.', redo: ['Save the page first', '', 7] }, { by: 'probe', attempt: 1, at: AT });
  assert.equal(rejected?.state, 'rejected', 'the state is read in any case');
  assert.deepEqual(rejected?.redo, ['Save the page first'], 'empties and non-strings are dropped');
  assert.equal(shapeVerdict({ state: 'maybe', note: 'x' }, { by: 'probe', attempt: 1, at: AT }), null, 'a state the vocabulary lacks');
  assert.equal(shapeVerdict({ state: 'passed' }, { by: 'session' as never, attempt: 1, at: AT }), null, 'a writer that is not probe, checker or owner');
  assert.equal(shapeVerdict({ state: 'rejected', redo: [] }, { by: 'checker', attempt: 1, at: AT }), null, 'a "no" with no "what instead"');
  assert.equal(shapeVerdict('passed', { by: 'checker', attempt: 1, at: AT }), null);
  const needs = shapeVerdict({ state: 'needs-info', note: 'Send the screenshot of the summary.' }, { by: 'checker', attempt: 3, at: AT })!;
  assert.deepEqual(needs.redo, ['Send the screenshot of the summary.'], 'the note is what to send when nothing else is');
  const secret = shapeVerdict({ state: 'rejected', note: 'It used ghp_abcdefghijklmnopqrstuvwxyz0123456789', redo: ['x'.repeat(900)] },
    { by: 'checker', attempt: 1, at: AT })!;
  assert.doesNotMatch(secret.note, /ghp_abcdef/, 'a secret-shaped value never reaches the record');
  assert.equal(secret.redo[0].length, 300, 'each line is bounded');
  const owner = shapeVerdict({ state: 'passed', note: 'Accepted.' }, { by: 'owner', attempt: 0, at: AT, unverified: true })!;
  assert.equal(owner.unverified, true);
  assert.match(returnedSentence(rejected!), /^Back to you \(attempt 1\): .*Redo: Save the page first\.$/);
  assert.match(returnedSentence(needs), /^Needs more from you \(attempt 3\): .*Send: Send the screenshot/);
});

test('TV-4 / TV-2 — a probe that misses is a rejection quoting what it read: returned, told once, nothing resumed', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, GH);
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'pending', detail: 'exit 1 — not logged in' });
    const pushesBefore = h.pushes.length;
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    const verdict = checked.body.verdict as { state: string; by: string; note: string; redo: string[]; read: string[]; attempt: number };
    assert.equal(verdict.state, 'rejected');
    assert.equal(verdict.by, 'probe');
    assert.equal(verdict.attempt, 1);
    assert.match(verdict.note, /The proof did not hold — cmd:"gh auth status" read: pending — exit 1 — not logged in/);
    assert.ok(verdict.redo.length >= 1, 'it says what to redo');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'returned');
    assert.equal(now.attempts, 1);
    assert.deepEqual(now.verdicts?.map((v) => v.state), ['rejected']);
    assert.equal(h.resumed.length, 0, 'nothing is resumed on a rejection');
    assert.equal(h.pushes.length - pushesBefore, 1, 'the person is told ONCE');
    assert.match(JSON.stringify(h.pushes.at(-1)), /Back to you/);
    assert.ok(journal(h.root, state).some((l) => l.event === 'phase.human-step-returned' && l.data.verdict === 'rejected'));
  } finally { h.cleanup(); }
});

test('TV-3 — each attempt keeps its evidence and its verdict; the item counts the attempts', async () => {
  const h = harness();
  try {
    const { step } = parked(h, GH);
    const reads = ['exit 1 — not logged in', 'exit 1 — token expired'];
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'pending', detail: reads.shift() ?? 'exit 1' });
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: 'I ran gh auth login.' })).status, 200);
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: 'Again, with --web.' })).status, 200);
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.attempts, 2);
    assert.deepEqual(now.verdicts?.map((v) => [v.attempt, v.state]), [[1, 'rejected'], [2, 'rejected']]);
    assert.deepEqual(now.evidence?.map((e) => e.attempt), [1, 2], 'each piece belongs to the attempt it was sent for');
    assert.match(now.verdicts![1].note, /token expired/, 'the second verdict quotes the second read');
    const view = (await call(h.svc, 'GET', '/api/human-steps')).body.steps as { id: string; moves: { verb: string; verdict?: unknown }[] }[];
    const moves = view.find((s) => s.id === step.id)!.moves.filter((m) => m.verb === 'return');
    assert.equal(moves.length, 2, 'the history shows each return');
    assert.ok(moves.every((m) => m.verdict), 'with its verdict');
  } finally { h.cleanup(); }
});

test('TV-5 — an answer item: a check with no answer is needs-info; the answer is the result', async () => {
  const h = harness();
  try {
    const decision = {
      kind: 'decision', title: 'Which database?', proof_type: 'answer',
      options: [{ id: 'o1', label: 'Postgres', consequence: 'a table' }, { id: 'o2', label: 'Redis', consequence: 'a service' }],
    };
    const { step } = parked(h, decision);
    assert.equal(checkRouteOf(step, { judgement: true }), 'answer');
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal((checked.body.verdict as { state: string }).state, 'needs-info');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'returned');
    assert.equal(h.resumed.length, 0);
    const answered = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o1' });
    assert.equal(answered.status, 200, 'a returned item is answered like any open one');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
  } finally { h.cleanup(); }
});

test('TV-6 — attest passes through a person\'s door only, marked unverified; the supervisor\'s re-check proves nothing', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' });
    assert.equal(checkRouteOf(step, { judgement: true }), 'attest');
    const bySupervisor = await h.svc.checkHumanStep(step.id, { by: 'operator', byPerson: false });
    assert.equal(bySupervisor.ok, true);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'notified', 'the supervisor asked; nothing was proven');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.verdict, undefined, 'and no verdict was written');
    const viaSessionDoor = await h.svc.checkHumanStep(step.id, {
      by: 'phase-3', actor: { by: 'phase-3', via: 'api', pressDoor: 'session' } as never,
    });
    assert.equal(viaSessionDoor.ok, true);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'notified', 'a session\'s door is no person\'s');
    // Fail closed: a call that names no door is nobody's word — saying so included.
    for (const bare of [{ by: 'operator' }, { by: 'operator', byPerson: true }]) {
      assert.equal((await h.svc.checkHumanStep(step.id, bare)).ok, true);
      const after = h.svc.humanStepsNow().get(step.id)!;
      assert.deepEqual([after.state, after.verdict], ['notified', undefined], `${JSON.stringify(bare)} proves nothing`);
    }
    const byPerson = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(byPerson.status, 200);
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'proven');
    assert.deepEqual([now.verdict?.state, now.verdict?.by, now.verdict?.unverified], ['passed', 'owner', true]);
    assert.match(String(h.resumed[0].instruction), /person said it is done \(unverified\)/);
  } finally { h.cleanup(); }
});

test('TV-6 — the lock screen\'s "I did it" proves an attest by the device door its press carries, never a session\'s', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' });
    const row = (await h.svc.attention(true)).items.find((item) => item.humanStep?.stepId === step.id);
    assert.ok(row?.actions.some((action) => action.verb === 'check'), 'the row offers the check');
    const press = (door: string) => ({ by: 'notification', via: 'api', origin: 'test', remoteUser: null, pressDoor: door }) as never;
    const viaSession = await h.svc.performInboxAction(row!.id, 'check', 'notification', press('session'));
    assert.equal(viaSession.ok, true);
    assert.deepEqual([h.svc.humanStepsNow().get(step.id)!.state, h.resumed.length], ['notified', 0], 'a session\'s door proves nothing, whatever button it presses');
    const fromDevice = await h.svc.performInboxAction(row!.id, 'check', 'notification', press('device'));
    assert.equal(fromDevice.ok, true, JSON.stringify(fromDevice));
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.deepEqual([now.state, now.verdict?.by, now.verdict?.unverified], ['proven', 'owner', true]);
    assert.equal(h.resumed.length, 1);
  } finally { h.cleanup(); }
});

test('TV-7 — judgement runs the checker; switched off, it falls back to attest and spawns nothing', async () => {
  const h = harness();
  try {
    const calls = scriptedChecker(h, [verdictText({ state: 'passed', note: 'The summary reads learning_enabled: true.', read: ['the attached note'] })]);
    const { step } = parked(h, JUDGED);
    assert.equal(checkRouteOf(step, { judgement: true }), 'judgement');
    assert.equal(checkRouteOf(step, { judgement: false }), 'attest');
    const asked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'Done — the summary says true.' });
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.body.check, { state: 'checking', by: 'checker', attempt: 1 }, 'the press only ASKS; the checker answers');
    await judged(h, step.id);
    assert.equal(calls.length, 1, 'one checking session');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.deepEqual([now.state, now.verdict?.state, now.verdict?.by], ['proven', 'passed', 'checker']);

    (h.svc as unknown as { prefs: Record<string, unknown> }).prefs = { ...(h.svc as unknown as { prefs: object }).prefs, checkJudgement: false };
    const second = parked(h, { ...JUDGED, title: 'Turn Insights on' }, 4).step;
    const off = await call(h.svc, 'POST', `/api/human-steps/${second.id}/check`, {});
    assert.equal(off.status, 200);
    assert.equal(calls.length, 1, 'no checking session with judgement off');
    const fallback = h.svc.humanStepsNow().get(second.id)!;
    assert.deepEqual([fallback.state, fallback.verdict?.by, fallback.verdict?.unverified], ['proven', 'owner', true]);
    assert.match(fallback.verdict!.note, /judgement checks are switched off/);
  } finally { h.cleanup(); }
});

test('TV-8 — a pass resumes every waiter once, saying what was proven, by whom and what the check read', async () => {
  const h = harness();
  try {
    scriptedChecker(h, [verdictText({ state: 'passed', note: 'The summary reads learning_enabled: true.', read: ['the screenshot', 'the note'] })]);
    const { state, step } = parked(h, JUDGED);
    const record4 = phaseRecord(state, 4);
    record4.status = 'parked';
    record4.sessionId = 'sess-4';
    record4.endedAt = new Date().toISOString();
    saveRun(state);
    assert.ok(!('refused' in h.svc.humanStepsNow().addWaiter(step.id, { slug: SLUG, phase: 4, runId: state.id, sessionId: 'sess-4' })));
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'Saved — the summary shows learning_enabled: true.' });
    await judged(h, step.id);
    assert.deepEqual(h.resumed.map((r) => r.phase).sort(), [3, 4], 'one resume per waiter');
    for (const resume of h.resumed) {
      assert.match(String(resume.instruction), /PROVEN/);
      assert.match(String(resume.instruction), /the checking session read the screenshot; the note against "the Learning summary reads learning_enabled: true"/);
      assert.match(String(resume.instruction), /passed it: The summary reads learning_enabled: true/);
    }
  } finally { h.cleanup(); }
});
