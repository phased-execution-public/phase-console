/**
 * The round (control-tower phase 136, #213, exit criteria 1 and 2) — RD-1..6:
 *
 *   RD-1  a round runs its passes in order; the counter rises ONLY when the
 *         turn changed, with ONE `turn` event — a reminder or a grant ending
 *         is no change; a pass that throws is logged and the rest still run;
 *   RD-2  a journal line wakes a round, debounced — a burst is one round, and
 *         the round's own lines wake nothing; one round at a time;
 *   RD-3  on a real console, with the round's clock: an act with a due-when ref
 *         is *Coming up* until the ref lands, then ONE push and *Do now*; a
 *         second round changes nothing;
 *   RD-4  an open proof the console reads is re-read by the round, and a landed
 *         one proves its item;
 *   RD-5  an item returned `turnEscalateAfter` times that never escalated
 *         escalates once, with its one push;
 *   RD-6  the headline is composed by RULES — a fixture table of sentences;
 *   RD-7  on a fake clock, the real passes: a closed window expires, an orphan is withdrawn;
 *   RD-8  the round's proof pass never RUNS a proof (no `cmd:`, no `unit:`, whatever raised the
 *         item), and a landed proof is settled as the console's act — its door
 *         `watch-landed`, never the operator's.
 *   RD-10 (turn-by-turn phase 7) the stale pass closes ONLY the run-specific items of a
 *         superseded run, each with its reason under Handled, and a world act on the
 *         old run reappears on the successor's lane — open; a run a disjoint scoped
 *         run follows is not superseded, and its items stand.
 *   RD-11 (#290) a session's decision card whose phase moved past it — the supervisor
 *         applied an option and resumed it, or a person Retried — closes as settled by
 *         that act, and the supervisor's `turn-unopened` never sees it; a sign-in the
 *         phase moved past still stands (control-tower phase 132's rule).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { harness, call, SLUG } from './turn-harness.ts';

const { TurnRound, ROUND_DEBOUNCE_MS } = await import('../server/turn/round.ts');
const { headlineOf } = await import('../server/turn/headline.ts');
const { shapeVerdict } = await import('../server/turn/verdict.ts');
const stateModule = await import('../server/runner/state.ts');
const stateOf = () => stateModule;

type Passes = ConstructorParameters<typeof TurnRound>[0];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakePasses(over: Partial<Passes> = {}, order: string[] = []): Passes {
  const note = <T>(name: string, value: T) => { order.push(name); return value; };
  return {
    grants: () => note('grants', 0),
    clock: () => note('clock', { reminded: [], expired: [], dismissed: [] }),
    stale: async () => note('stale', { closed: [], moved: [] }),
    covered: () => note('covered', []),
    escalate: () => note('escalate', []),
    due: async () => note('due', { due: [], proven: [] }),
    proofs: async () => note('proofs', []),
    ...over,
  };
}

test('RD-1: the passes run in order; the counter rises only when the turn changed, with ONE turn event; a failing pass is logged and the rest run', async () => {
  const order: string[] = [];
  const emitted: number[] = [];
  const failed: string[] = [];
  let due: string[] = [];
  const round = new TurnRound(fakePasses({ due: async () => { order.push('due'); return { due, proven: [] }; } }, order), {
    emit: (state) => emitted.push(state.n), failed: (pass) => failed.push(pass), now: () => Date.parse('2026-10-07T10:00:00Z'),
  });
  let state = await round.run('clock');
  assert.deepEqual(order, ['grants', 'clock', 'stale', 'covered', 'escalate', 'due', 'proofs']);
  assert.equal(state.n, 0, 'nothing changed: the counter stays');
  assert.equal(state.at, '2026-10-07T10:00:00.000Z');
  assert.deepEqual(emitted, []);
  due = ['st1'];
  state = await round.run('clock');
  assert.equal(state.n, 1);
  assert.equal(state.changedAt, '2026-10-07T10:00:00.000Z');
  assert.deepEqual(state.last, { due: 1, proven: 0, expired: 0, withdrawn: 0, closed: 0, moved: 0, escalated: 0, reminded: 0, grantsEnded: 0 });
  assert.deepEqual(emitted, [1], 'ONE event for the round that changed something');
  // A reminder and a grant ending move nothing on the page.
  due = [];
  const quiet = new TurnRound(fakePasses({ grants: () => 2, clock: () => ({ reminded: ['st2'], expired: [], dismissed: [] }) }), { emit: (s) => emitted.push(s.n) });
  assert.equal((await quiet.run()).n, 0);
  assert.deepEqual(emitted, [1]);
  // A pass that throws: logged by name, and the passes after it still run.
  const after: string[] = [];
  const shaky = new TurnRound(fakePasses({
    covered: () => { throw new Error('boom'); },
    proofs: async () => { after.push('proofs'); return ['st3']; },
  }), { emit: () => {}, failed: (pass) => failed.push(pass) });
  assert.equal((await shaky.run()).n, 1);
  assert.deepEqual(failed, ['covered']);
  assert.deepEqual(after, ['proofs']);
});

test('RD-2: a journal line wakes a round, debounced; the round\'s own lines wake nothing; one round at a time', async () => {
  let runs = 0;
  const round = new TurnRound(fakePasses({ proofs: async () => { runs += 1; await sleep(5); return []; } }), { emit: () => {}, debounceMs: 25 });
  round.poke('phase.human-step-proven');
  round.poke('policy.grant-ended');
  await sleep(60);
  assert.equal(runs, 0, 'the round\'s own lines never wake another round');
  for (let i = 0; i < 5; i += 1) round.poke('phase.tool-denied');
  await sleep(80);
  assert.equal(runs, 1, 'a burst of lines is one round');
  // Asked for during a round: the same promise, and one round after it.
  const first = round.run('event');
  const second = round.run('event');
  assert.equal(first, second);
  await first;
  // The round after it is waited for by its count, not a fixed sleep: under
  // load a 30 ms window read 2 (control-tower phase 142's free-tree run). A
  // round that never comes still fails, at the bound; a fourth still shows.
  for (const until = Date.now() + 2_000; runs < 3 && Date.now() < until;) await sleep(5);
  await sleep(30);
  assert.equal(runs, 3, 'the round, and ONE more for what was asked during it');
  round.stop();
  assert.equal(ROUND_DEBOUNCE_MS, 2_000);
});

test('RD-3: an act with a due-when ref is Coming up until the ref lands — then ONE push and Do now; the next round changes nothing', async () => {
  const h = harness();
  try {
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown> & { emit: (name: string, data: unknown) => boolean };
    const events: unknown[] = [];
    const emit = svc.emit.bind(h.svc);
    svc.emit = (name: string, data: unknown) => { if (name === 'turn') events.push(data); return emit(name, data); };
    const step = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console',
      step: { kind: 'operator-act', title: 'Rotate the deploy key', why: 'reserved', due_when: 'date:2020-01-01T00:00:00Z', source: { kind: 'console', ref: 'rd3' } },
    });
    assert.ok(step);
    assert.equal(step!.state, 'upcoming');
    const before = await call(h.svc, 'GET', '/api/turn');
    assert.equal((before.body.counts as { upcoming: number }).upcoming, 1);
    assert.equal((before.body.counts as { now: number }).now, 0);
    assert.match(String(before.body.headline), /^Nothing needs you now · 1 coming up\.$/);
    const pushesBefore = h.pushes.length;
    const round = svc.turnRoundNow() as InstanceType<typeof TurnRound>;
    const state = await round.run('clock');
    assert.equal(state.n, 1);
    assert.deepEqual(state.last && { due: state.last.due }, { due: 1 });
    assert.equal(h.pushes.length - pushesBefore, 1, 'its ONE push');
    assert.equal(events.length, 1, 'ONE turn event');
    const after = await call(h.svc, 'GET', '/api/turn');
    assert.equal((after.body.counts as { now: number }).now, 1);
    assert.equal((after.body.round as { n: number }).n, 1);
    // The headline counts, and never quotes a title (#377).
    assert.match(String(after.body.headline), /^1 to do now\.$/);
    const again = await round.run('clock');
    assert.equal(again.n, 1, 'nothing changed: the counter stays');
    assert.equal(h.pushes.length - pushesBefore, 1, 'and nothing is pushed again');
    assert.equal(events.length, 1);
  } finally {
    h.cleanup();
  }
});

test('RD-4: an open proof the console reads is re-read by the round, and a landed one proves its item', async () => {
  const h = harness();
  try {
    const step = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console',
      step: { kind: 'operator-act', title: 'Wait for the window', why: 'reserved', proof: 'date:2020-01-01T00:00:00Z', source: { kind: 'console', ref: 'rd4' } },
    })!;
    assert.ok(step && step.state !== 'proven');
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    const state = await (svc.turnRoundNow() as InstanceType<typeof TurnRound>).run('clock');
    assert.equal(state.last?.proven, 1);
    const ledger = h.svc.humanStepsNow();
    assert.equal(ledger.get(step.id)?.state, 'proven');
    assert.equal(ledger.get(step.id)?.verdict?.by, 'probe');
    // A proof that has not landed is read again later and says nothing to the person.
    const later = h.svc.recordHumanStep({
      slug: SLUG, phase: 4, birth: 'console',
      step: { kind: 'operator-act', title: 'Wait for the future', why: 'reserved', proof: 'date:2999-01-01T00:00:00Z', source: { kind: 'console', ref: 'rd4b' } },
    })!;
    const pushes = h.pushes.length;
    await (svc.turnProofPass as (now?: number) => Promise<string[]>).call(h.svc, Date.now());
    assert.notEqual(ledger.get(later.id)?.state, 'proven');
    assert.notEqual(ledger.get(later.id)?.state, 'returned', 'a miss is never sent back to the person');
    assert.equal(h.pushes.length, pushes);
  } finally {
    h.cleanup();
  }
});

test('RD-8: the round\'s proof pass never RUNS a proof — no command and no unit is asked, whatever raised the item — and a landed proof is settled as the console\'s own act, never a person\'s press', async () => {
  const h = harness();
  try {
    const svc = h.svc as unknown as Record<string, unknown> & { watchClock: { probeNow: (ref: string) => Promise<unknown> } };
    const asked: string[] = [];
    const probe = svc.watchClock.probeNow.bind(svc.watchClock);
    svc.watchClock.probeNow = async (ref: string) => { asked.push(ref); return probe(ref); };
    const settled: { by?: string; actor?: { door?: string; via?: string } }[] = [];
    svc.settleCheck = async (_id: string, _verdict: unknown, _read: string, opts: { by?: string; actor?: { door?: string; via?: string } }) => {
      settled.push(opts);
      return { ok: true };
    };
    for (const [phase, proof] of [[1, 'cmd:"/usr/bin/true"'], [4, 'unit:box/nightly.service'], [5, 'date:2020-01-01T00:00:00Z']] as const) {
      const step = h.svc.recordHumanStep({
        slug: SLUG, phase, birth: 'console',
        step: { kind: 'operator-act', title: `Proof ${phase}`, why: 'reserved', proof, source: { kind: 'console', ref: `rd8-${phase}` } },
      });
      assert.ok(step && !('refused' in step), `the item is recorded: ${JSON.stringify(step)}`);
    }
    await (svc.turnProofPass as (now?: number) => Promise<string[]>).call(h.svc, Date.now());
    assert.deepEqual(asked, ['date:2020-01-01T00:00:00Z'], 'only a ref the console READS is asked');
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.by, 'watch');
    assert.equal(settled[0]!.actor?.door, 'watch-landed', 'what it resumes goes through the console\'s own door');
    assert.equal(settled[0]!.actor?.via, 'timer');
  } finally {
    h.cleanup();
  }
});

test('RD-9: on a console without --allow-run, the round\'s landed proof resumes nothing — not through an errand\'s answer either (gate parity with the road back)', async () => {
  const h = harness({ allowRun: false });
  try {
    const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
    const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [3] } as never);
    const record = phaseRecord(state, 3);
    record.status = 'parked' as never;
    record.sessionId = 'sess-3';
    record.endedAt = new Date().toISOString();
    const at = new Date().toISOString();
    state.recoveries = { 3: { attempts: 1, lastAt: at, errand: { phase: 3, situation: 'credentials-missing', at, tried: [], need: 'sign gh in', how: 'run gh auth login' } } } as never;
    state.status = 'parked' as never;
    saveRun(state);
    const step = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console', runId: state.id,
      step: { kind: 'operator-act', title: 'Sign gh in', why: 'reserved', proof: 'date:2020-01-01T00:00:00Z', source: { kind: 'console', ref: 'rd9' } },
    })!;
    assert.ok(step && !('refused' in step));
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    let answered = 0;
    const answer = svc.resumeAnsweredErrand.bind(h.svc);
    svc.resumeAnsweredErrand = (...args: unknown[]) => { answered += 1; return answer(...args); };
    await (svc.turnProofPass as (now?: number) => Promise<string[]>).call(h.svc, Date.now());
    assert.equal(h.svc.humanStepsNow().get(step.id)?.state, 'proven', 'the proof still proves its item');
    assert.equal(answered, 0, 'the errand is not answered by the console\'s own clock');
    assert.deepEqual(h.resumed, []);
  } finally {
    h.cleanup();
  }
});

test('RD-5: an item returned turnEscalateAfter times that never escalated escalates once, with its one push', async () => {
  const h = harness();
  try {
    const step = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console',
      step: { kind: 'operator-act', title: 'Sign the release', why: 'reserved', source: { kind: 'console', ref: 'rd5' } },
    })!;
    const ledger = h.svc.humanStepsNow();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      ledger.move(step.id, 'checking', { by: 'test', verb: 'check' });
      const verdict = shapeVerdict({ state: 'rejected', note: 'not yet', redo: ['do it'], read: ['x'] }, { by: 'probe', attempt, at: new Date().toISOString() })!;
      ledger.move(step.id, 'returned', { by: 'test', verb: 'return', verdict });
    }
    assert.equal(ledger.get(step.id)?.escalatedAt, undefined, 'returned three times with no escalation — the preference was higher then');
    const pushes = h.pushes.length;
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    const round = svc.turnRoundNow() as InstanceType<typeof TurnRound>;
    const state = await round.run('clock');
    assert.equal(state.last?.escalated, 1);
    assert.ok(ledger.get(step.id)?.escalatedAt, 'escalated');
    assert.equal(ledger.get(step.id)?.state, 'notified', 'back to the person\'s turn');
    assert.equal(h.pushes.length - pushes, 1);
    assert.equal((await round.run('clock')).last?.escalated, 1, 'the last CHANGED round is still that one');
    assert.equal(h.pushes.length - pushes, 1, 'once');
  } finally {
    h.cleanup();
  }
});

test('RD-6: the headline is composed by rules — a fixture table: it counts, never quotes (#377)', () => {
  const base = { open: 0, checking: 0, upcoming: 0, done: 0, handled: 0, handledSince: 'seen' as const };
  const table: [Parameters<typeof headlineOf>[0], string][] = [
    [base, 'Nothing needs you now.'],
    [{ ...base, handled: 4 }, 'Nothing needs you now · 4 handled since you last looked.'],
    [{ ...base, handled: 1, handledSince: 'day' }, 'Nothing needs you now · 1 handled in the last day.'],
    [{ ...base, upcoming: 2 }, 'Nothing needs you now · 2 coming up.'],
    [{ ...base, open: 1, upcoming: 5, done: 6 }, '1 to do now · 5 coming up · 6 done today.'],
    [{ ...base, open: 2, checking: 1, handled: 4 }, '2 to do now · 1 being checked · 4 handled since you last looked.'],
    [{ ...base, open: 3, checking: 2, upcoming: 1 }, '3 to do now · 2 being checked · 1 coming up.'],
    [{ ...base, done: 3 }, 'Nothing needs you now · 3 done today.'],
    [{ ...base, open: 2 }, '2 to do now.'],
  ];
  for (const [facts, sentence] of table) assert.equal(headlineOf(facts), sentence);
});

test('RD-7: on a fake clock, the real passes: a window that closed expires, and an item whose phase closed is withdrawn — one change each, counted once', async () => {
  const h = harness();
  try {
    const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
    const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [4] } as never);
    phaseRecord(state, 4).status = 'done' as never;
    saveRun(state);
    const windowed = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console',
      step: { kind: 'operator-act', title: 'Approve within the hour', why: 'reserved', window_minutes: 60, source: { kind: 'console', ref: 'rd7a' } },
    })!;
    const orphan = h.svc.recordHumanStep({
      slug: SLUG, phase: 4, birth: 'console', runId: state.id,
      step: { kind: 'operator-act', title: 'Nobody needs this now', why: 'reserved', source: { kind: 'console', ref: 'rd7b' } },
    })!;
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    const later = Date.now() + 2 * 60 * 60_000;
    const emitted: number[] = [];
    // The console's own passes, on a clock two hours ahead.
    const round = new TurnRound({
      grants: () => svc.sweepGrants.call(h.svc) as number,
      clock: (now) => svc.humanStepClockTick.call(h.svc, now) as { reminded: string[]; expired: string[]; dismissed: string[] },
      stale: (now) => svc.turnStalePass.call(h.svc, now) as Promise<{ closed: string[]; moved: string[] }>,
      covered: (now) => svc.turnCoveredPass.call(h.svc, now) as string[],
      escalate: (now) => svc.turnEscalatePass.call(h.svc, now) as string[],
      due: (now) => svc.humanStepDuePass.call(h.svc, now) as Promise<{ due: string[]; proven: string[] }>,
      proofs: (now) => svc.turnProofPass.call(h.svc, now) as Promise<string[]>,
    }, { emit: (state) => emitted.push(state.n), now: () => later });
    const first = await round.run('clock');
    assert.equal(first.n, 1);
    assert.equal(first.last?.expired, 1);
    assert.equal(first.last?.withdrawn, 1);
    const ledger = h.svc.humanStepsNow();
    assert.equal(ledger.get(windowed.id)?.state, 'expired');
    assert.equal(ledger.get(orphan.id)?.state, 'dismissed');
    assert.deepEqual(emitted, [1]);
    assert.equal((await round.run('clock')).n, 1, 'nothing left to move');
    assert.deepEqual(emitted, [1]);
  } finally {
    h.cleanup();
  }
});


test('RD-10: the stale pass closes only a superseded run\'s run-specific items, each with its reason under Handled — a world act moves to the successor\'s lane, open', async () => {
  const h = harness();
  try {
    const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
    // Run A: stopped by the operator "relaunch isolated"; run B started after it, unscoped.
    const a = newRun({ slug: SLUG, root: h.root } as never);
    a.createdAt = '2026-10-10T17:00:00.000Z';
    a.status = 'halted' as never;
    a.stoppedBy = 'operator';
    a.halt = { at: '2026-10-10T17:20:00.000Z', reason: 'stopped — relaunch isolated', phase: 3, kind: 'operator-stop' } as never;
    phaseRecord(a, 3).status = 'parked' as never;
    saveRun(a);
    const b = newRun({ slug: SLUG, root: h.root } as never);
    b.createdAt = '2026-10-10T17:31:00.000Z';
    b.status = 'halted' as never;
    saveRun(b);
    // Run C: an older run of the plan whose only successor is a scoped run of OTHER phases.
    const raise = (phase: number, runId: string, step: Record<string, unknown>) => {
      const raised = h.svc.recordHumanStep({ slug: SLUG, phase, birth: 'console', runId, step });
      assert.ok(raised && !('refused' in raised), JSON.stringify(raised));
      return raised as { id: string };
    };
    const question = raise(3, a.id, { kind: 'decision', title: 'Which branch?', why: 'decision', options: [{ id: 'o1', label: 'main' }, { id: 'o2', label: 'dev' }], source: { kind: 'relay', ref: 'q-1' } });
    const errand = raise(3, a.id, { kind: 'operator-act', title: 'Clear the failure streak', why: 'reserved', source: { kind: 'errand', ref: 'failure-streak' } });
    const signIn = raise(3, a.id, { kind: 'mcp-login', title: 'Sign the MCP server docs in', where: 'host', source: { kind: 'preflight', ref: 'mcp:docs' } });
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    const pass = await (svc.turnStalePass as (now?: number) => Promise<{ closed: string[]; moved: string[] }>).call(h.svc, Date.now());
    assert.deepEqual(new Set(pass.closed), new Set([question.id, errand.id]), 'only the run-specific items close');
    assert.deepEqual(pass.moved, [signIn.id], 'the world act moves');
    const ledger = h.svc.humanStepsNow();
    for (const id of [question.id, errand.id]) {
      assert.equal(ledger.get(id)?.state, 'dismissed');
      assert.match(ledger.get(id)?.note ?? '', new RegExp(`nobody needs it any more: run ${a.id} was superseded by run ${b.id}`));
    }
    const moved = ledger.get(signIn.id)!;
    assert.ok(['declared', 'notified'].includes(moved.state), `still open: ${moved.state}`);
    assert.equal(moved.runId, b.id, 'it stands on the successor\'s lane');
    assert.deepEqual(moved.waiters.map((w) => w.runId), [b.id], 'the old run\'s lane is gone');
    // Each with its reason under Handled — the console's own close.
    const turn = await call(h.svc, 'GET', '/api/turn');
    const rows = (turn.body.handled as { source: string; what: string }[]).filter((row) => row.source === 'console');
    // Three items, and the read itself resolved run A "superseded by run B" — its asks closed with it.
    assert.equal(rows.length, 4, JSON.stringify(rows));
    assert.ok(rows.some((row) => row.what === `Closed what run ${a.id} asked — it was superseded by run ${b.id}, so nobody needs it any more`));
    const { loadRun } = await import('../server/runner/state.ts');
    const after = loadRun(h.root, SLUG, a.id, null)!;
    assert.equal(after.resolved?.reason, `superseded by run ${b.id}`);
    assert.equal(after.resolved?.auto, true);
    assert.equal(after.stoppedBy, 'operator', 'the operator\'s stop is kept');
    assert.ok(rows.some((row) => /Closed “Which branch\?” — nobody needs it any more: run .* was superseded by run /.test(row.what)));
    assert.ok(rows.some((row) => new RegExp(`Moved “Sign the MCP server docs in” to run ${b.id}`).test(row.what)));
    // A second pass moves nothing: the moved act is the successor's now.
    const again = await (svc.turnStalePass as (now?: number) => Promise<{ closed: string[]; moved: string[] }>).call(h.svc, Date.now());
    assert.deepEqual(again, { closed: [], moved: [] });
  } finally {
    h.cleanup();
  }
});

test('RD-10: a run followed only by a scoped run of OTHER phases is not superseded — its items stand', async () => {
  const h = harness();
  try {
    const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
    const a = newRun({ slug: SLUG, root: h.root, onlyPhases: [3] } as never);
    a.createdAt = '2026-10-10T17:00:00.000Z';
    a.status = 'halted' as never;
    phaseRecord(a, 3).status = 'parked' as never;
    saveRun(a);
    const c = newRun({ slug: SLUG, root: h.root, onlyPhases: [4, 5] } as never);
    c.createdAt = '2026-10-10T18:00:00.000Z';
    saveRun(c);
    const raised = h.svc.recordHumanStep({
      slug: SLUG, phase: 3, birth: 'console', runId: a.id,
      step: { kind: 'decision', title: 'Which tag?', why: 'decision', options: [{ id: 'o1', label: 'v1' }, { id: 'o2', label: 'v2' }], source: { kind: 'relay', ref: 'q-2' } },
    }) as { id: string };
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    const pass = await (svc.turnStalePass as (now?: number) => Promise<{ closed: string[]; moved: string[] }>).call(h.svc, Date.now());
    assert.deepEqual(pass, { closed: [], moved: [] });
    assert.notEqual(h.svc.humanStepsNow().get(raised.id)?.state, 'dismissed');
  } finally {
    h.cleanup();
  }
});

test('RD-11 (#290): a decision card its phase moved past closes as settled by that act — and turn-unopened never sees it', () => {
  const h = harness();
  try {
    const { newRun, phaseRecord, saveRun } = stateOf();
    const state = newRun({ slug: SLUG, root: h.root } as never);
    const decision = h.svc.raiseTurn({
      slug: SLUG, phase: 3, birth: 'session', runId: state.id, sessionId: 'sess-3',
      step: {
        kind: 'decision', title: 'Amend the plan, or ask the owner?', why: 'decision', why_source: 'declared', proof_type: 'answer',
        options: [{ id: 'amend', label: 'Amend' }, { id: 'owner', label: 'Ask the owner' }], recommended: 'amend',
      },
    });
    assert.ok(decision && !('refused' in decision), JSON.stringify(decision));
    const signIn = h.svc.raiseTurn({
      slug: SLUG, phase: 3, birth: 'session', runId: state.id, sessionId: 'sess-3',
      step: { kind: 'browser-login', title: 'Sign gh in', proof_type: 'attest', open_command: 'gh auth login' },
    });
    assert.ok(signIn && !('refused' in signIn));
    const record = phaseRecord(state, 3);
    // Parked on the decision: it stands, and the supervisor sees it.
    record.status = 'parked' as never;
    record.declared = { status: 'needs-human', reason: 'amend or ask', at: new Date().toISOString(), step: { id: decision.id, kind: 'decision' } } as never;
    state.status = 'parked' as never;
    saveRun(state);
    const svc = h.svc as unknown as Record<string, (...args: unknown[]) => unknown>;
    // The supervisor's facts are Pro's (`turnFactsForSupervisor`); the Free tree has no supervisor to keep it from.
    const pro = typeof svc.turnFactsForSupervisor === 'function';
    const facts = () => (pro ? (svc.turnFactsForSupervisor.call(h.svc) as { id: string }[]).map((one) => one.id) : []);
    if (pro) assert.ok(facts().includes(decision.id));
    const later = Date.now() + 60_000;
    svc.humanStepClockTick.call(h.svc, later);
    assert.notEqual(h.svc.humanStepsNow().get(decision.id)?.state, 'dismissed', 'while its phase waits on it, it stands');
    // The supervisor applied "amend" and resumed the phase: a new attempt, no longer declaring it.
    delete record.declared;
    record.status = 'running' as never;
    record.attemptStartedAt = new Date(Date.now() + 1_000).toISOString();
    state.status = 'running' as never;
    saveRun(state);
    if (pro) assert.ok(!facts().includes(decision.id), 'turn-unopened never pins a note about it');
    svc.humanStepClockTick.call(h.svc, later);
    const closed = h.svc.humanStepsNow().get(decision.id)!;
    assert.equal(closed.state, 'dismissed');
    assert.match(closed.note ?? '', /settled by the act that resumed phase 3 at .* — the phase moved past it/);
    assert.notEqual(h.svc.humanStepsNow().get(signIn.id)?.state, 'dismissed', 'a sign-in the phase moved past still stands');
  } finally {
    h.cleanup();
  }
});
