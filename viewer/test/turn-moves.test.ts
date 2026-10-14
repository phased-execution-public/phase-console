/**
 * The owner's moves (control-tower phase 133, #210) — through the real routes
 * and the real Service.
 *
 *   OM-1  `answer {option?, note?}` records a decision's answer — an option id
 *         of the item (or its exact label), a note, or both — and proves the
 *         item; an option the item does not offer, an empty answer and an item
 *         that is no decision are refused by name.
 *   OM-2  `decline {reason}` settles an item that allows it as `declined`
 *         (never `dismissed`, the console's withdrawal); one that does not
 *         allow it, or a decline with no reason, is refused.
 *   OM-3  `ask {text}` records a question on the item with its time, and moves
 *         nothing — the item stays where it was.
 *   OM-4  `evidence` stores a note, an image or a file and records it on the
 *         item — by content hash, never its bytes.
 *   OM-5  `check`, `snooze` and `cannot` keep their routes.
 *   OM-6  `check` no longer takes a secret: a body carrying one is refused with
 *         a sentence naming where the value goes, the value never echoed or
 *         stored; a `secret-entry` item is proven by presence BY NAME.
 *   OM-7  *Undo* (turn-by-turn phase 5) takes a running check back: the item
 *         returns to To do — Redo when an earlier check sent it back — and a
 *         verdict that arrives after it is dropped by its attempt; only a
 *         `checking` item is undone, and never by an agent's door.
 *   OM-8  a check's note is kept on its attempt for EVERY proof type and
 *         returned on the item (turn-by-turn phase 5).
 *   OM-9  a gate-bound item (its proof reads a gate's row) is not proven by an
 *         answer or a note: its press is the gate's Approve (turn-by-turn
 *         phase 5).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECISION, INSTANCE_STATE_DIR, JUDGED, SLUG, call, harness, journal, judged, ledgerText, parked, verdictText,
} from './turn-harness.ts';

type WatchState = import('../server/watch-refs.ts').WatchState;

test('OM-1 — answer: an option, a note, or both; the item is proven by the answer, journalled with its door', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, DECISION);
    const answered = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o1', note: 'keep it on the box' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.deepEqual(
      { ...(answered.body.answered as Record<string, unknown>), at: undefined },
      { option: 'o1', label: 'Use Postgres', note: 'keep it on the box', by: 'script', door: 'local', at: undefined },
    );
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'proven', 'the answer IS the result');
    assert.equal(now.answer?.option, 'o1');
    const line = journal(h.root, state).find((l) => l.event === 'phase.human-step-answered');
    assert.ok(line, 'phase.human-step-answered');
    assert.equal(line!.data.option, 'o1');
    assert.equal(line!.data.door, 'local');

    // By its exact label, and a note alone.
    const second = parked(h, DECISION, 4);
    const byLabel = await call(h.svc, 'POST', `/api/human-steps/${second.step.id}/answer`, { option: 'Use Redis' });
    assert.equal(byLabel.status, 200);
    assert.equal((byLabel.body.answered as { option: string }).option, 'o2');
    const third = parked(h, { kind: 'decision', title: 'Name the release', proof_type: 'answer' }, 5);
    const noteOnly = await call(h.svc, 'POST', `/api/human-steps/${third.step.id}/answer`, { note: 'Call it Lark' });
    assert.equal(noteOnly.status, 200);
    assert.equal((noteOnly.body.answered as { note: string }).note, 'Call it Lark');
  } finally { h.cleanup(); }
});

test('OM-1 — answer refuses an option the item does not offer, an empty answer, and an item that is no decision', async () => {
  const h = harness();
  try {
    const { step } = parked(h, DECISION);
    const unknown = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'o9' });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /o1 \(Use Postgres\), o2 \(Use Redis\)/, 'it names the options');
    const empty = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { note: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'notified', 'nothing moved');
    const act = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' }, 4).step;
    const notADecision = await call(h.svc, 'POST', `/api/human-steps/${act.id}/answer`, { note: 'done' });
    assert.equal(notADecision.status, 409);
    assert.match(String(notADecision.body.error), /not a decision/);
  } finally { h.cleanup(); }
});

test('OM-2 — decline: declined with the reason where the item allows it; refused where it does not, or with no reason', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, { ...DECISION, allow_decline: true });
    const silent = await call(h.svc, 'POST', `/api/human-steps/${step.id}/decline`, { reason: ' ' });
    assert.equal(silent.status, 400);
    const declined = await call(h.svc, 'POST', `/api/human-steps/${step.id}/decline`, { reason: 'neither — the cache goes' });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'declined', 'a person\'s "not doing this" — never the console\'s dismissed');
    assert.equal(now.note, 'neither — the cache goes');
    assert.equal(journal(h.root, state).filter((l) => l.event === 'phase.human-step-declined').length, 1);

    const strict = parked(h, DECISION, 4).step;
    const refused = await call(h.svc, 'POST', `/api/human-steps/${strict.id}/decline`, { reason: 'no' });
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /does not allow declining/);
    assert.equal(h.svc.humanStepsNow().get(strict.id)!.state, 'notified');
  } finally { h.cleanup(); }
});

test('OM-3 — ask: a question recorded with its time; the item stays where it was and nothing resumes', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, DECISION);
    const before = h.svc.humanStepsNow().get(step.id)!.state;
    const asked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/ask`, { text: 'Does Redis survive a reboot here?' });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, before, 'a question moves no state');
    assert.equal(now.question?.length, 1);
    assert.equal(now.question![0].text, 'Does Redis survive a reboot here?');
    assert.ok(Date.parse(now.question![0].at) > 0, 'with its time');
    assert.equal(h.resumed.length, 0, 'nothing resumed for a question');
    assert.equal(journal(h.root, state).filter((l) => l.event === 'phase.human-step-asked').length, 1);
    const blank = await call(h.svc, 'POST', `/api/human-steps/${step.id}/ask`, { text: '' });
    assert.equal(blank.status, 400);
  } finally { h.cleanup(); }
});

test('OM-4 — evidence: a note is stored and recorded on the item by its hash; nothing resumes', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' });
    const attached = await call(h.svc, 'POST', `/api/human-steps/${step.id}/evidence`, { kind: 'note', text: 'The light went green.' });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const piece = attached.body.attached as { ref: string; kind: string; attempt: number };
    assert.match(piece.ref, /^sha256:[0-9a-f]{64}$/);
    assert.equal(piece.attempt, 1, 'it belongs to the next check');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.evidence?.[0]?.ref, piece.ref);
    assert.equal(now.state, 'notified', 'evidence moves no state');
    assert.ok(existsSync(join(INSTANCE_STATE_DIR, 'turn-evidence', piece.ref.slice('sha256:'.length))));
    assert.equal(ledgerText().includes('The light went green.'), false, 'the ledger keeps the record, never the bytes');
    assert.equal(h.resumed.length, 0);
  } finally { h.cleanup(); }
});

test('OM-5 — check, snooze and cannot keep their routes', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'physical', title: 'Plug the key in', proof_type: 'attest' });
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${step.id}/snooze`, { minutes: 30 })).status, 200);
    const second = parked(h, { kind: 'physical', title: 'Turn the box on', proof_type: 'attest' }, 4).step;
    assert.equal((await call(h.svc, 'POST', `/api/human-steps/${second.id}/cannot`, { reason: 'the box is at home' })).status, 200);
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(checked.status, 200);
    assert.equal((checked.body.check as { landed: boolean }).landed, true, 'a person\'s word on an attest item');
  } finally { h.cleanup(); }
});

test('OM-6 — check takes no secret: refused naming where the value goes, never echoed, nothing stored or moved', async () => {
  const SECRET = 'npm_Zq8vXw2LmN4pR6tY1uI3oP5aS7dF9gH0jK2l';
  const h = harness({ allowAccounts: true });
  try {
    const { state, step } = parked(h, { kind: 'secret-entry', title: 'Paste the npm publish token', credential: 'npm-token' });
    for (const body of [{ secret: SECRET }, { secret: '' }, { note: `here it is: ${SECRET}` }]) {
      const refused = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.match(String(refused.body.error), /never takes a secret, and nothing was stored/);
      assert.match(String(refused.body.error), /phase-console-npm-token|npm-token/, 'it names where the value goes');
      assert.equal(JSON.stringify(refused.body).includes(SECRET), false, 'never echoed');
    }
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'notified', 'nothing moved');
    assert.equal(ledgerText().includes(SECRET), false, 'the ledger never holds it');
    const journalled = (() => { try { return JSON.stringify(journal(h.root, state)); } catch { return ''; } })();
    assert.equal(journalled.includes(SECRET), false, 'nor the journal');
    const secrets = join(INSTANCE_STATE_DIR, 'secrets');
    assert.ok(!existsSync(secrets) || readdirSync(secrets).length === 0, 'nothing was written anywhere');
    // The other moves refuse a secret the same way.
    for (const verb of ['answer', 'ask']) {
      const other = await call(h.svc, 'POST', `/api/human-steps/${step.id}/${verb}`, { note: SECRET, text: SECRET });
      assert.equal(other.status, 400, verb);
      assert.equal(JSON.stringify(other.body).includes(SECRET), false);
    }
  } finally { h.cleanup(); }
});

test('OM-6 — a secret-entry item is proven by presence BY NAME, where its value goes', async () => {
  const h = harness();
  try {
    const { step } = parked(h, { kind: 'secret-entry', title: 'Paste the npm publish token', credential: 'npm-token' });
    const asked: string[] = [];
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => {
      asked.push(ref);
      return { ref, state: 'landed', detail: 'held' };
    };
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^credential:(keychain:phase-console-npm-token|file:.*\/secrets\/npm-token)$/, 'a credential: ref, read by name');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
    const view = await call(h.svc, 'GET', '/api/human-steps');
    const row = (view.body.steps as { id: string; secretWhere?: string }[]).find((s) => s.id === step.id);
    assert.match(String(row?.secretWhere), /npm-token/, 'the item says where the value goes');
  } finally { h.cleanup(); }
});


test('OM-3 — a question or evidence line never moves a step: one naming another state is skipped as torn history', async () => {
  const { appendFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { HumanStepLedger, declareHumanStep, readLedger } = await import('../server/human-steps.ts');
  const dir = mkdtempSync(join(tmpdir(), 'pc-still-moves-'));
  try {
    const ledger = new HumanStepLedger(join(dir, 'human-steps.ndjson'));
    const step = declareHumanStep({ ledger, announce: () => true }, {
      slug: 'demo', phase: 2, birth: 'session', step: { kind: 'decision', title: 'Pick one', proof_type: 'answer' },
    });
    assert.ok(step && !('refused' in step));
    const id = (step as { id: string }).id;
    const asked = ledger.record(id, 'ask', { by: 'person', question: { at: new Date().toISOString(), text: 'Which?' } });
    assert.ok(!('refused' in asked) && asked.state === 'notified' && asked.question?.length === 1);
    appendFileSync(ledger.file, `${JSON.stringify({ v: 2, id, state: 'proven', at: new Date().toISOString(), verb: 'ask', question: { at: 'x', text: 'forged' } })}\n`);
    const read = readLedger(ledger.file);
    assert.equal(read.steps.get(id)!.state, 'notified', 'a question proves nothing');
    assert.equal(read.steps.get(id)!.question?.length, 1);
    assert.equal(read.skipped, 1);
    ledger.move(id, 'proven', { by: 'person', verb: 'answer', answer: { option: 'a', at: new Date().toISOString() } });
    assert.ok('refused' in ledger.record(id, 'attach', { by: 'person' }), 'nothing is attached to a settled step');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A probe item whose proof the test reads when it says so — the check holds until then. */
const PROBED = {
  kind: 'browser-login', title: 'Sign the gh CLI in to the acme org', open_url: 'https://github.com/login/device',
  proof: 'cmd:"gh auth status"', where: 'host',
};

/** A probe that answers only when the test lets it. */
function heldProbe(h: ReturnType<typeof harness>): { land: (state: WatchState['state']) => void } {
  let release: (state: WatchState['state']) => void = () => {};
  const read = new Promise<WatchState['state']>((resolve) => { release = resolve; });
  h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: await read, detail: 'exit 0' });
  return { land: (state) => release(state) };
}

/** Wait until an item reads `state` — the check's own move lands a tick after the press. */
async function until(h: ReturnType<typeof harness>, id: string, state: string): Promise<void> {
  for (let i = 0; i < 200 && h.svc.humanStepsNow().get(id)?.state !== state; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.svc.humanStepsNow().get(id)?.state, state);
}

test('OM-7 — Undo while a probe reads: back to To do, and the verdict that lands after it is dropped', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, PROBED);
    const probe = heldProbe(h);
    const checking = call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    await until(h, step.id, 'checking');
    const undone = await call(h.svc, 'POST', `/api/human-steps/${step.id}/undo`);
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.deepEqual(undone.body.undo, { to: 'opened', attempt: 1 });
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'opened', 'To do again');
    const turn = await h.svc.turnAnswer();
    const item = Object.values(turn.groups).flat().find((one) => one.item === step.id);
    assert.equal(item?.personStatus, 'todo');
    // The proof lands after the undo: its verdict answers an attempt nobody is checking.
    probe.land('landed');
    const late = await checking;
    assert.equal((late.body.check as { state?: string }).state, 'superseded');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'opened', 'never proven on a check the person took back');
    assert.equal(now.verdict, undefined);
    assert.equal(h.resumed.length, 0, 'nothing resumed');
    const lines = journal(h.root, state);
    assert.equal(lines.filter((l) => l.event === 'phase.human-step-undone').length, 1);
    assert.deepEqual(lines.find((l) => l.event === 'phase.human-step-check-skipped')?.data.why, 'superseded');
    // A fresh check is a new attempt, and its verdict counts.
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'landed', detail: 'exit 0' });
    const again = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    assert.equal((again.body.check as { attempt?: number }).attempt, 2);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
  } finally { h.cleanup(); }
});

test('OM-7 — Undo on a judgement an earlier check sent back: Redo, the session stopped, its verdict dropped', async () => {
  const h = harness();
  try {
    const { step } = parked(h, JUDGED);
    // The first check sends it back.
    const spawn = h.svc as unknown as { checkerSpawn: (request: unknown) => Promise<unknown> };
    spawn.checkerSpawn = async () => ({
      signal: {}, costUsd: 0.1, turns: 2, durationMs: 10, argv: [], injected: 0,
      resultText: verdictText({ state: 'rejected', note: 'The summary still reads false.', redo: ['Turn it on, then send a screenshot.'], read: ['the note'] }),
    });
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'done, I think' });
    await judged(h, step.id);
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'returned');
    // The second check is held until the test lets it answer — and is undone first.
    let answer: (text: string) => void = () => {};
    const held = new Promise<string>((resolve) => { answer = resolve; });
    let aborted = false;
    spawn.checkerSpawn = async (request: unknown) => {
      (request as { signal?: AbortSignal }).signal?.addEventListener('abort', () => { aborted = true; });
      return { signal: {}, costUsd: 0.1, turns: 2, durationMs: 10, argv: [], injected: 0, resultText: await held };
    };
    const pressed = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'it reads true now' });
    assert.equal((pressed.body.check as { state?: string }).state, 'checking');
    const undone = await call(h.svc, 'POST', `/api/human-steps/${step.id}/undo`);
    assert.deepEqual(undone.body.undo, { to: 'returned', attempt: 2 }, 'Redo: an earlier check sent it back');
    answer(verdictText({ state: 'passed', note: 'It reads true.', read: ['the note'] }));
    const late = await judged(h, step.id);
    assert.equal((late?.check as { state?: string } | undefined)?.state, 'superseded');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'returned', 'still Redo — the late pass answered nothing');
    assert.equal(now.verdicts?.length, 1, 'no second verdict was written');
    assert.equal(h.resumed.length, 0);
    assert.equal(aborted, true, 'the checking session it no longer needs was stopped');
  } finally { h.cleanup(); }
});

test('OM-7 — Undo refuses an item that is not being checked, and a settled one by name', async () => {
  const h = harness();
  try {
    const { step } = parked(h, PROBED);
    const idle = await call(h.svc, 'POST', `/api/human-steps/${step.id}/undo`);
    assert.equal(idle.status, 409);
    assert.match(String(idle.body.error), /^Only a check that is still running can be taken back — this item is notified\.$/);
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'landed', detail: 'exit 0' });
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    const settled = await call(h.svc, 'POST', `/api/human-steps/${step.id}/undo`);
    assert.equal(settled.status, 409, 'a proven item stays proven');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
  } finally { h.cleanup(); }
});

test('OM-8 — a check\'s note is kept on its attempt for every proof type, and returned on the item', async () => {
  const h = harness();
  try {
    const { step } = parked(h, PROBED);
    h.svc.watchClock.probeNow = async (ref: string): Promise<WatchState> => ({ ref, state: 'pending', detail: 'exit 1' });
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'signed in from the laptop' });
    await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, { note: 'and again from the desk' });
    const notes = h.svc.humanStepsNow().get(step.id)!.notes ?? [];
    assert.deepEqual(notes.map((note) => [note.attempt, note.text]), [[1, 'signed in from the laptop'], [2, 'and again from the desk']]);
    const turn = await h.svc.turnAnswer();
    const item = Object.values(turn.groups).flat().find((one) => one.item === step.id);
    assert.deepEqual(item?.step?.notes?.map((note) => note.text), ['signed in from the laptop', 'and again from the desk']);
    // An attest item's note is kept too — once only a judgement's was.
    const own = parked(h, { kind: 'operator-act', title: 'Restart the build box', why: 'physical', proof_type: 'attest' }, 4).step;
    await call(h.svc, 'POST', `/api/human-steps/${own.id}/check`, { note: 'power-cycled at 09:10' });
    assert.deepEqual(h.svc.humanStepsNow().get(own.id)!.notes?.map((note) => note.text), ['power-cycled at 09:10']);
  } finally { h.cleanup(); }
});

test('OM-9 — a gate-bound item takes no answer or note: its one way on is the gate\'s Approve, bound to its run', async () => {
  const h = harness();
  try {
    const { state } = parked(h, PROBED, 5);
    const gated = h.svc.recordHumanStep({
      slug: SLUG, phase: 5, birth: 'plan', runId: state.id,
      step: {
        kind: 'decision', title: "Approve the release train on Phase 11's Gate card", why: 'decision',
        proof: `cmd:"grep -q '| 11 |' docs/handoffs/${SLUG}/gate-status.md"`,
        options: [{ id: 'yes', label: 'Approved' }],
      },
    });
    assert.ok(gated && !('refused' in gated), JSON.stringify(gated));
    const id = (gated as { id: string }).id;
    for (const body of [{ note: 'approved it' }, { option: 'yes' }]) {
      const answered = await call(h.svc, 'POST', `/api/human-steps/${id}/answer`, body);
      assert.equal(answered.status, 409, JSON.stringify(body));
      assert.match(String(answered.body.error), /done when the gate on Phase 11 opens — approve the gate/);
    }
    assert.notEqual(h.svc.humanStepsNow().get(id)!.state, 'proven', 'the gate is still shut, so the item is not done');
    const turn = await h.svc.turnAnswer();
    const item = Object.values(turn.groups).flat().find((one) => one.item === id)!;
    assert.deepEqual(item.options?.map((option) => [option.id, option.verb.endpoint, option.verb.body]), [
      ['approve-gate', `/api/plans/${SLUG}/gate/11`, { approve: true, continueRun: true, expectRunId: state.id }],
    ]);
    const inbox = await h.svc.attention(true);
    const row = inbox.items.find((one) => one.kind === 'human-step' && one.turn?.item === id)!;
    assert.equal(row.actions[0]?.endpoint, `/api/plans/${SLUG}/gate/11`, 'the row leads with the gate\'s Approve');
    assert.ok(!row.actions.some((action) => action.verb === 'check'), 'and offers no check a note could pass');
  } finally { h.cleanup(); }
});

test('OM-7 — a session\'s door takes back no person\'s check, and a press with no door none either', async () => {
  const h = harness();
  try {
    const { state, step } = parked(h, PROBED);
    const probe = heldProbe(h);
    const checking = call(h.svc, 'POST', `/api/human-steps/${step.id}/check`);
    await until(h, step.id, 'checking');
    const token = h.svc.approvals.arm(state.id);
    const agent = await call(h.svc, 'POST', `/api/human-steps/${step.id}/undo`, {}, { authorization: `Bearer ${token}` });
    assert.equal(agent.status, 403);
    assert.equal(agent.body.door, 'session');
    const bare = h.svc.undoHumanStep(step.id, {}, { by: 'nobody' });
    assert.equal(bare.ok, false, 'no actor is no door');
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'checking', 'still being checked');
    probe.land('landed');
    await checking;
    assert.equal(h.svc.humanStepsNow().get(step.id)!.state, 'proven', 'the check nobody took back stands');
  } finally { h.cleanup(); }
});

test('OM-10 — an ack-bound option a session presses marks the row seen and moves nothing to Done', async () => {
  const h = harness();
  try {
    const { state } = parked(h, PROBED);
    const settled: unknown[] = [];
    (h.svc as unknown as { settleAnsweredRow: (...args: unknown[]) => Promise<void> }).settleAnsweredRow = async (...args) => { settled.push(args); };
    const token = h.svc.approvals.arm(state.id);
    await call(h.svc, 'POST', '/api/inbox/ack', { id: 'conflict:alpha:::zone', answer: 'leave' }, { authorization: `Bearer ${token}` });
    assert.equal(settled.length, 0, 'a session\'s ack settles nothing');
    await call(h.svc, 'POST', '/api/inbox/ack', { id: 'conflict:alpha:::zone', answer: 'leave' });
    assert.equal(settled.length, 1, 'a person\'s answer is kept');
  } finally { h.cleanup(); }
});

