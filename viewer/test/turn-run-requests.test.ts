/**
 * Run requests (turn-by-turn phase 6, #286, §Architecture 5.1): an act only the
 * RUN can take — relaunch isolated, switch account, raise the budget, stop,
 * hold — asked by a phase reaches the run, never a guard refusal into the void.
 *
 *   RR-1  the vocabulary: `RUN_ACTS` are operator verbs by name, none an
 *         authority verb; the bash twin says the same words.
 *   RR-2  the compatibility rule, from recorded facts only.
 *   RR-3  the declaration: `run_act` is read beside `needs: run` and nowhere
 *         else; three permission declarations with no rule or command on a
 *         shared checkout are three `run.run-requested` lines, each `isolate`.
 *   RR-4  Free's ONE approval per (run, act): three declaring phases are three
 *         waiters on one item, an approval type with its block; Deny resumes
 *         every waiter told no; Approve takes the act (isolate at the next
 *         boundary) and resumes them told yes.
 *   RR-5  (Pro) the supervisor presses `isolate` once for three phases, and
 *         logs it under Handled by the AI.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { harness, journal, loadRun, SLUG, type Harness, type RunState } from './turn-harness.ts';

const { RUN_ACTS, RUN_ACT_META, verbNamed } = await import('../shared/verb-model.js');
const { AUTHORITY_ROUTES, AUTHORITY_VERBS, NEVER_GRANT } = await import('../shared/door-model.js').then((m) => ({
  AUTHORITY_ROUTES: m.AUTHORITY_ROUTES, AUTHORITY_VERBS: m.AUTHORITY_VERBS, NEVER_GRANT: (m as Record<string, unknown>).NEVER_GRANT,
}));
const { isolateCompat } = await import('../server/turn/run-requests.ts');
const { readOutcome, needsOf } = await import('../server/runner/outcome.ts');
const { RunnerBase } = await import('../server/runner/runner-base.ts');
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { SKILL_DIR } = await import('../server/config.ts');

const REPO = join(SKILL_DIR);

describe('RR-1: the run acts are operator verbs by name', () => {
  test('five acts, each a verb of the table, none an authority verb; the bash twin agrees', () => {
    assert.deepEqual([...RUN_ACTS], ['isolate', 'switch-account', 'raise-budget', 'stop', 'hold']);
    for (const act of RUN_ACTS) {
      assert.ok(verbNamed(act), `${act} is an operator verb`);
      assert.ok(!(AUTHORITY_VERBS as readonly string[]).includes(act), `${act} is no authority verb`);
      assert.ok(RUN_ACT_META[act].title && RUN_ACT_META[act].ifApproved && RUN_ACT_META[act].ifDenied, `${act} has its words`);
    }
    if (Array.isArray(NEVER_GRANT)) for (const act of RUN_ACTS) assert.ok(!NEVER_GRANT.includes(act));
    const bash = execFileSync('/bin/bash', ['-c', `. "${join(REPO, 'scripts', 'turn.env')}"; printf '%s' "$RUN_ACTS"`], { encoding: 'utf8' });
    assert.equal(bash, RUN_ACTS.join(' '));
  });
});

describe('RR-2: the compatibility rule reads recorded facts only', () => {
  const base = { slug: 'demo', shared: true, branch: 'main' };
  test('a permission block naming no rule or command, on a shared checkout whose lane is not on pe/<slug>, is isolate', () => {
    for (const needs of ['permission', 'permission.policy']) {
      assert.equal(isolateCompat({ ...base, declared: { status: 'blocked', needs } }), true, needs);
    }
    assert.equal(isolateCompat({ ...base, branch: undefined, declared: { status: 'blocked', needs: 'permission' } }), true,
      'a default-branch run whose claim named no branch is not on pe/<slug>');
  });
  test('anything else stays what it said', () => {
    const d = { status: 'blocked', needs: 'permission.policy' };
    assert.equal(isolateCompat({ ...base, declared: { ...d, rule: 'Bash(git push:*)' } }), false, 'a rule cites a wall');
    assert.equal(isolateCompat({ ...base, declared: { ...d, command: 'git push' } }), false, 'a command cites a wall');
    assert.equal(isolateCompat({ ...base, shared: false, declared: d }), false, 'an isolated checkout');
    assert.equal(isolateCompat({ ...base, branch: 'pe/demo', declared: d }), false, 'a lane on the run branch');
    assert.equal(isolateCompat({ ...base, declared: { status: 'blocked', needs: 'credential' } }), false, 'another need');
    assert.equal(isolateCompat({ ...base, declared: { status: 'needs-human', needs: 'permission' } }), false, 'not blocked');
  });
});

/** A fake lane for `RunnerBase.noteRunRequest`: its run's checkout and its claim's branch. */
function lane(state: { slug: string; checkout?: string }, branch: string | undefined) {
  const lines: { event: string; data: Record<string, unknown>; phase?: number }[] = [];
  const self = {
    state,
    worktreeFor: () => undefined,
    scopeFor: async () => ['root'],
    qualificationFor: () => (branch ? { branch } : {}),
    record: (event: string, data: Record<string, unknown>, phase?: number) => { lines.push({ event, data, phase }); return lines.length; },
  };
  const note = (RunnerBase.prototype as unknown as { noteRunRequest: (phase: number, record: unknown) => Promise<void> }).noteRunRequest;
  return { lines, note: (phase: number, record: unknown) => note.call(self, phase, record) };
}

describe('RR-3: the declaration the runner records', () => {
  test('run_act rides beside needs: run and nowhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-outcome-'));
    const file = join(dir, 'outcome.json');
    const write = (extra: Record<string, unknown>) => writeFileSync(file, JSON.stringify({
      version: 1, slug: 'demo', phase: 3, status: 'blocked', watch: [], written_at: '2026-10-13T00:00:00Z', ...extra,
    }));
    write({ needs: 'run', run_act: 'isolate' });
    const read = readOutcome(file, { slug: 'demo', phase: 3 })!;
    assert.equal(read.run_act, 'isolate');
    assert.deepEqual(needsOf(read), { needs: 'run', runAct: 'isolate' });
    write({ needs: 'run', run_act: 'relaunch' });
    assert.equal(readOutcome(file, { slug: 'demo', phase: 3 })!.run_act, undefined, 'an unknown act is dropped');
    write({ needs: 'permission', run_act: 'isolate' });
    assert.equal(readOutcome(file, { slug: 'demo', phase: 3 })!.run_act, undefined, 'an act beside another need is dropped');
  });

  test('three permission.policy declarations with no rule or command on a shared checkout are three isolate requests', async () => {
    const state = { slug: 'demo', checkout: 'shared' };
    const { lines, note } = lane(state, 'main');
    const records = [3, 4, 5].map(() => ({ declared: { status: 'blocked', needs: 'permission.policy', reason: 'Operator: stop this run and start it again isolated', at: 'x' } as Record<string, unknown> }));
    for (const [i, record] of records.entries()) await note(3 + i, record);
    assert.deepEqual(lines.map((line) => [line.event, line.phase, line.data.act, line.data.compat, line.data.askedAs]), [
      ['run.run-requested', 3, 'isolate', true, 'permission.policy'],
      ['run.run-requested', 4, 'isolate', true, 'permission.policy'],
      ['run.run-requested', 5, 'isolate', true, 'permission.policy'],
    ]);
    for (const record of records) {
      assert.equal(record.declared.needs, 'run', 'the classifier reads blocked-declared:run, never a permission wall');
      assert.equal(record.declared.runAct, 'isolate');
    }
  });

  test('an explicit request is recorded as it is; an isolated run or a lane on pe/<slug> keeps its permission', async () => {
    const explicit = lane({ slug: 'demo', checkout: 'worktree' }, 'pe/demo');
    await explicit.note(2, { declared: { status: 'blocked', needs: 'run', runAct: 'hold', at: 'x' } });
    assert.deepEqual(explicit.lines.map((l) => [l.data.act, l.data.compat]), [['hold', false]]);
    for (const [checkout, branch] of [['worktree', 'main'], ['shared', 'pe/demo']] as const) {
      const kept = lane({ slug: 'demo', checkout }, branch);
      const record = { declared: { status: 'blocked', needs: 'permission', at: 'x' } as Record<string, unknown> };
      await kept.note(2, record);
      assert.equal(kept.lines.length, 0);
      assert.equal(record.declared.needs, 'permission');
    }
  });
});

/** A stored shared-checkout run whose phases 3, 4 and 5 are parked on an isolate request. */
function requested(h: Harness, phases = [3, 4, 5]): RunState {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: phases } as never);
  (state as unknown as Record<string, unknown>).gitMode = 'new-branch';
  for (const phase of phases) {
    const record = phaseRecord(state, phase);
    record.status = 'parked';
    record.sessionId = `sess-${phase}`;
    record.endedAt = new Date().toISOString();
    record.declared = {
      status: 'blocked', needs: 'run', runAct: 'isolate', compat: true, askedAs: 'permission.policy',
      reason: 'Operator: stop this run and start it again isolated', at: record.endedAt,
    } as never;
    // The errand the ladder wrote on its park — the row the inbox draws for it.
    ((state as unknown as { recoveries: Record<string, unknown> }).recoveries ??= {})[String(phase)] = {
      attempts: 0, lastAt: record.endedAt,
      errand: { phase, situation: 'blocked-declared:run', at: record.endedAt, tried: [], need: 'An act only the run can take', how: 'x' },
    };
  }
  state.status = 'parked' as never;
  saveRun(state);
  const bag = h.svc as unknown as { announceErrand: (data: unknown) => void };
  for (const phase of phases) {
    bag.announceErrand({
      slug: SLUG, runId: state.id, phase,
      errand: { at: `${phase}`, situation: 'blocked-declared:run', need: 'An act only the run can take', how: 'x', tried: [] },
    });
  }
  return state;
}

describe('RR-4: ONE approval per (run, act), the declaring phases its waiters', () => {
  test('three phases asking to isolate are ONE item — an approval naming all three — pushed once', async () => {
    const h = harness();
    try {
      requested(h);
      const open = h.svc.humanStepsNow().open();
      assert.equal(open.length, 1, 'one item for three phases');
      const [item] = open;
      assert.equal(item!.source?.kind, 'run-request');
      assert.equal(item!.source?.ref, 'isolate');
      assert.deepEqual(item!.waiters.map((w) => Number(w.phase)).sort(), [3, 4, 5]);
      assert.equal(h.pushes.length, 1, 'announced once');
      const turn = await h.svc.turnAnswer();
      const all = Object.values(turn.groups).flat();
      const shown = all.filter((i) => i.source === 'run-request');
      assert.equal(shown.length, 1);
      assert.equal(all.length, 1, 'each phase\'s errand row folds into the one item — nothing beside it');
      assert.equal(shown[0]!.type, 'approve');
      assert.equal(shown[0]!.title, RUN_ACT_META.isolate.title);
      assert.equal(shown[0]!.approval?.askedBy, 'Phases 3, 4 and 5');
      assert.deepEqual(shown[0]!.options.map((o) => o.id), ['approve', 'deny']);
      assert.ok(!/permission item/i.test(JSON.stringify(shown[0])), 'it never claims a permission item');
    } finally { h.cleanup(); }
  });

  test('Deny resumes every waiter told no, and the request is decided', async () => {
    const h = harness();
    try {
      const state = requested(h);
      const answer = await h.svc.answerRunRequest(SLUG, { phase: 4, answer: 'deny' }, { by: 'ana' });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.deepEqual(h.resumed.map((r) => r.phase).sort(), [3, 4, 5]);
      for (const r of h.resumed) assert.match(r.instruction ?? '', /denied by ana/);
      assert.equal(h.svc.humanStepsNow().open().length, 0);
      const decided = journal(h.root, state).filter((l) => l.event === 'run.run-request-decided');
      assert.equal(decided.length, 1);
      assert.equal(decided[0]!.data.answer, 'deny');
      assert.equal(loadRun(h.root, SLUG, state.id)?.isolateAtBoundary, undefined, 'nothing was taken');
    } finally { h.cleanup(); }
  });

  test('Approve takes the act — isolate at the next boundary — and resumes them told yes, through the route', async () => {
    const h = harness();
    try {
      const state = requested(h);
      const { call } = await import('./turn-harness.ts');
      const pressed = await call(h.svc, 'POST', `/api/run/${SLUG}/run-request`, { phase: 3, answer: 'approve', expectRunId: state.id });
      assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
      assert.ok(loadRun(h.root, SLUG, state.id)?.isolateAtBoundary, 'the run takes its own checkout at its next boundary');
      assert.deepEqual(h.resumed.map((r) => r.phase).sort(), [3, 4, 5]);
      for (const r of h.resumed) assert.match(r.instruction ?? '', /approved by/);
      const stale = await call(h.svc, 'POST', `/api/run/${SLUG}/run-request`, { phase: 3, answer: 'approve', expectRunId: 'another-run' });
      assert.equal(stale.status, 409, 'a press bound to another run is refused');
    } finally { h.cleanup(); }
  });

  test('an approved stop resumes nobody; a budget raise needs the note to BE the amount', async () => {
    const h = harness();
    try {
      const stopping = requested(h, [3]);
      const stopItem = h.svc.humanStepsNow().open()[0]!;
      // Re-aim the one item at `stop` and `raise-budget` through fresh requests of their own.
      const bag = h.svc as unknown as { raiseRunRequest: (slug: string, runId: string, phase: number) => boolean };
      const stored = loadRun(h.root, SLUG, stopping.id)!;
      (stored.phases['3']!.declared as Record<string, unknown>).runAct = 'stop';
      saveRun(stored);
      h.svc.humanStepsNow().move(stopItem.id, 'dismissed', { by: 'test', verb: 'dismiss' });
      assert.equal(bag.raiseRunRequest(SLUG, stopping.id, 3), true);
      const stopAnswer = await h.svc.answerRunRequest(SLUG, { phase: 3, answer: 'approve' }, { by: 'ana' });
      assert.equal(stopAnswer.ok, true, JSON.stringify(stopAnswer));
      assert.deepEqual(h.resumed, [], 'resuming a waiter would undo the stop');

      const again = loadRun(h.root, SLUG, stopping.id)!;
      (again.phases['3']!.declared as Record<string, unknown>).runAct = 'raise-budget';
      again.status = 'parked' as never;
      saveRun(again);
      assert.equal(bag.raiseRunRequest(SLUG, stopping.id, 3), true);
      for (const note of ['phase 3 add 10', 'ticket 4521, add 10', '-5', '1,000']) {
        const refused = await h.svc.answerRunRequest(SLUG, { phase: 3, answer: 'approve', note }, { by: 'ana' });
        assert.equal(refused.status, 400, `"${note}" is not an amount`);
      }
      assert.equal(h.svc.humanStepsNow().open().length, 1, 'still open for the amount');
    } finally { h.cleanup(); }
  });

  test('the answer route is fenced from a session, its CLI form included', () => {
    const route = AUTHORITY_ROUTES.find((row) => row.path === '/api/run/:slug/run-request');
    assert.ok(route, 'an authority route');
    assert.equal(route!.authority, 'answer');
    assert.deepEqual([...route!.cli], ['run run-request'], 'the CLI line a session could type is fenced too');
  });

  test('a run that cannot switch in place answers 409 with its sentence, and the item stays open', async () => {
    const h = harness();
    try {
      const state = requested(h);
      const stored = loadRun(h.root, SLUG, state.id)!;
      delete (stored as unknown as Record<string, unknown>).gitMode;
      saveRun(stored);
      const answer = await h.svc.answerRunRequest(SLUG, { phase: 3, answer: 'approve' }, { by: 'ana' });
      assert.equal(answer.ok, false);
      assert.equal(answer.status, 409);
      assert.match(String(answer.error), /start it again isolated/);
      assert.equal(h.svc.humanStepsNow().open().length, 1);
      assert.equal(h.resumed.length, 0);
    } finally { h.cleanup(); }
  });
});


describe('RR-6: a LIVE run\'s request raises its item before the run reaches the disk', () => {
  test('the errand announced on the runner\'s event reads the live record, not the stored one (turn-by-turn phase 11)', () => {
    const h = harness();
    const runners = (h.svc as unknown as { runners: Map<string, unknown> }).runners;
    try {
      // On disk the phase still runs and has declared nothing — the runner
      // announces its park before it saves (the tower rehearsal's run-request trip).
      const stored = newRun({ slug: SLUG, root: h.root, onlyPhases: [2] } as never);
      phaseRecord(stored, 2).status = 'running' as never;
      stored.status = 'running' as never;
      saveRun(stored);
      const live = structuredClone(stored) as RunState;
      const record = live.phases['2']!;
      record.status = 'parked' as never;
      record.sessionId = 'sess-2';
      record.endedAt = new Date().toISOString();
      record.declared = { status: 'blocked', needs: 'run', runAct: 'hold', reason: 'the release waits for the freeze', at: record.endedAt } as never;
      runners.set(SLUG, { current: () => live });
      const bag = h.svc as unknown as { announceErrand: (data: unknown) => void };
      bag.announceErrand({
        slug: SLUG, runId: stored.id, phase: 2,
        errand: { at: record.endedAt, situation: 'blocked-declared:run', need: 'An act only the run can take', how: 'x', tried: [] },
      });
      const open = h.svc.humanStepsNow().open().filter((step) => step.source?.kind === 'run-request');
      assert.equal(open.length, 1, 'ONE run request item, raised from the live record');
      assert.equal(open[0]!.source?.ref, 'hold');
      assert.equal(open[0]!.runId, stored.id);
    } finally {
      runners.delete(SLUG);
      h.cleanup();
    }
  });
});

describe('RR-7: an answer that arrives before the item is raised raises it, then answers it', () => {
  test('the supervisor pressing on the journal line, ahead of the park\'s errand, is not a 404 (turn-by-turn phase 11)', async () => {
    const h = harness();
    try {
      const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [4] } as never);
      const record = phaseRecord(state, 4);
      record.status = 'parked' as never;
      record.sessionId = 'sess-4';
      record.endedAt = new Date().toISOString();
      record.declared = { status: 'blocked', needs: 'run', runAct: 'hold', reason: 'wait for the freeze', at: record.endedAt } as never;
      state.status = 'parked' as never;
      saveRun(state);
      assert.equal(h.svc.humanStepsNow().open().length, 0, 'no item yet — the errand is not announced');
      const answered = await h.svc.answerRunRequest(SLUG, { phase: 4, answer: 'deny', act: 'hold' }, { by: 'supervisor' });
      assert.equal(answered.ok, true, JSON.stringify(answered));
      const items = h.svc.humanStepsNow().all().filter((step) => step.source?.kind === 'run-request');
      assert.equal(items.length, 1, 'ONE item, raised by the answer');
      assert.equal(items[0]!.state, 'proven', 'and answered');
      const none = await h.svc.answerRunRequest(SLUG, { phase: 2, answer: 'approve' }, { by: 'supervisor' });
      assert.equal(none.status, 404, 'a phase that declared nothing still has no run request');
    } finally { h.cleanup(); }
  });
});


describe('RR-9: releasing a held run whose loop parked resumes a person\'s board it still holds', () => {
  test('the hold\'s waiter is not lost with the loop that parked (turn-by-turn phase 11)', () => {
    const h = harness();
    const svc = h.svc as unknown as { startRun: (slug: string, opts: Record<string, unknown>) => Promise<unknown>; releaseRun: (slug: string, who: unknown) => unknown };
    const started: Record<string, unknown>[] = [];
    svc.startRun = async (_slug, opts) => { started.push(opts); return null; };
    try {
      const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [1] } as never);
      const record = phaseRecord(state, 1);
      record.status = 'pending' as never;
      (record as unknown as Record<string, unknown>).boardingHint = { situation: 'person', rung: 'resume-own-session', brief: 'continue', sessionId: 's-1', at: new Date().toISOString(), by: 'operator' };
      (state as unknown as Record<string, unknown>).hold = { at: new Date().toISOString(), by: 'supervisor' };
      state.status = 'parked' as never;
      saveRun(state);
      svc.releaseRun(SLUG, 'ana');
      assert.equal(started.length, 1, 'the release resumed the run');
      assert.equal(started[0]!.resumeRunId, state.id);
      assert.equal(loadRun(h.root, SLUG, state.id)!.hold ?? null, null, 'and the hold is off');
      // A release with no person's board standing changes the hold alone.
      const again = loadRun(h.root, SLUG, state.id)!;
      (again.phases['1'] as unknown as Record<string, unknown>).boardingHint = undefined;
      (again as unknown as Record<string, unknown>).hold = { at: new Date().toISOString(), by: 'supervisor' };
      saveRun(again);
      svc.releaseRun(SLUG, 'ana');
      assert.equal(started.length, 1, 'nothing else is started');
    } finally { h.cleanup(); }
  });
});

describe('RR-10: an answer pressed while the lane that parked on it winds down is pressed again once it leaves', () => {
  test('the waiter is resumed, not handed an errand (turn-by-turn phase 11)', async () => {
    const h = harness();
    const svc = h.svc as unknown as {
      liveRunner: (slug: string) => unknown; pressResume: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>;
    };
    try {
      requested(h, [3]);
      let lane = true;
      const presses: boolean[] = [];
      const realLive = svc.liveRunner.bind(h.svc);
      svc.liveRunner = (slug: string) => (lane ? { laneHeld: () => lane, current: () => null } : realLive(slug));
      svc.pressResume = async () => { presses.push(lane); return lane ? { ok: false, error: 'phase 3 is running now' } : { ok: true }; };
      setTimeout(() => { lane = false; }, 600);
      const answered = await h.svc.answerRunRequest(SLUG, { phase: 3, answer: 'deny' }, { by: 'supervisor' });
      assert.equal(answered.ok, true, JSON.stringify(answered));
      assert.deepEqual(presses, [true, false], 'refused while the lane stood, pressed again once it left');
      assert.equal((answered as { resumes?: { launched: boolean }[] }).resumes?.[0]?.launched, true, 'the waiter was resumed');
    } finally { h.cleanup(); }
  });
});
