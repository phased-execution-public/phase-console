/**
 * "Undriven" is one named state (control-tower phase 79, #114, #113).
 *
 * Measured on the hub: four phases read `in-progress` on their plan boards for
 * 13–23 hours inside runs that were `running` and green on every surface, and
 * none of them had a lane, a queue entry, a halt or an errand. The board's "in
 * progress" reads as "someone is on it"; the Runs page showed them nowhere, so
 * the operator found out only because a board and a page disagreed.
 *
 *   UD-1  a phase the board reads `in-progress` or `stuck` that no lane, queue
 *         entry, boarding hint, park or errand of its live run drives is stamped
 *         `undriven` by the drive tick — board word, last situation, why, and
 *         since-when, a clock that holds for the episode — and `/api/runs`
 *         carries it, per phase and as the run's `undriven` list; anything that
 *         IS driven, and any run that is not live, carries none;
 *   UD-2  it raises one attention item after a bounded time (`STALL_META`'s
 *         `undriven` clock), with the verb that boards it now — never for a run
 *         that is not live, never before the clock.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PHASE_CONSOLE_LOG = '';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const attention = await import('../shared/attention-model.js');
const lifecycle = await import('../shared/run-lifecycle.js');
type RunState = import('../server/runner/state.ts').RunState;

const MINUTE = 60_000;

type BoardShape = {
  phased: true; states: Record<number, string>; done: number[]; inProgress: number[]; stuck: number[];
  ready: number[]; waiting: number[]; blockedBy: Record<number, number[]>; qa: Record<number, string>;
};

function board(words: Record<number, string>): BoardShape {
  const of = (word: string) => Object.entries(words).filter(([, w]) => w === word).map(([p]) => Number(p));
  return {
    phased: true, states: words, done: of('done'), inProgress: of('in-progress'), stuck: of('stuck'),
    ready: of('ready'), waiting: of('waiting'), blockedBy: {}, qa: {},
  };
}

/** A runner with a state installed and no loop — the tick's undriven pass, run for real. */
class Tick extends Runner {
  clock = Date.parse('2026-09-25T05:00:00.000Z');

  install(state: RunState, lanes: number[] = []): void {
    (this as unknown as { state: RunState }).state = state;
    const map = (this as unknown as { lanes: Map<number, unknown> }).lanes;
    for (const phase of lanes) map.set(phase, { phase });
  }

  protected override now(): Date { return new Date(this.clock); }

  /** `boarding` is what this tick is about to board. */
  mark(b: BoardShape, boarding: number[] = []): void {
    (this as unknown as { noteUndriven(b: unknown, boarding: ReadonlySet<number>): void }).noteUndriven(b, new Set(boarding));
  }
}

function tick(): Tick {
  return new Tick({ scriptsDir: '/nonexistent', verificationText: () => undefined } as never);
}

/** Every shape a phase the board reads in progress can be in, on one live run. */
function fleet(): RunState {
  const state = newRun({ slug: 'demo', root: '/nowhere', autoRecover: true });
  state.status = 'running';
  const at = new Date(Date.parse('2026-09-25T04:00:00.000Z')).toISOString();
  // 1 — pending, nothing hinted: the defect.
  Object.assign(phaseRecord(state, 1), {
    status: 'pending', attempts: 1, sessionId: 's1', resumeSessionId: 's1',
    situation: { key: 'resource-wall:usage', at, why: ['a usage limit'] },
  });
  // 2 — pending WITH a boarding hint: the next boarding takes it.
  Object.assign(phaseRecord(state, 2), {
    status: 'pending', boardingHint: { situation: 'work-in-progress', rung: 'resume-own-session', at, by: 'drive', brief: 'continue', sessionId: 's2' },
  });
  // 3 — parked on a clock.
  Object.assign(phaseRecord(state, 3), { status: 'waiting', parkedUntil: '2026-09-25T09:00:00.000Z' });
  // 4 — an errand stands: a person has been asked, on a card of its own.
  phaseRecord(state, 4).status = 'pending';
  state.recoveries = { 4: { attempts: 1, lastAt: at, errand: { situation: 'blocked-declared:human-acts', need: 'x', how: 'y', tried: [], at } as never } };
  // 5 — in a lane right now.
  phaseRecord(state, 5).status = 'running';
  // 6 — `queued` with no lane behind it: nothing will ever admit it.
  phaseRecord(state, 6).status = 'queued';
  // 7 — pending, but the board reads it ready: an ordinary candidate.
  phaseRecord(state, 7).status = 'pending';
  // 8 — pending and stuck on the board, and this tick boards it.
  phaseRecord(state, 8).status = 'pending';
  return state;
}

const WORDS = {
  1: 'in-progress', 2: 'in-progress', 3: 'in-progress', 4: 'stuck', 5: 'in-progress', 6: 'in-progress', 7: 'ready', 8: 'stuck',
};

/* ------------------------------------------------------------------ *
 * UD-1 — the tick names it; /api/runs carries it
 * ------------------------------------------------------------------ */

test('UD-1: the drive tick stamps undriven on exactly the phases nothing drives — board word, situation, why, since', () => {
  const runner = tick();
  const state = fleet();
  runner.install(state, [5]);
  // Phase 2's hint makes it a candidate of this tick (control-tower phase 86):
  // the hinted list always joins the candidates, so the tick boards it.
  runner.mark(board(WORDS), [2, 8]);

  const stamped = Object.values(state.phases).filter((r) => r.undriven).map((r) => r.phase).sort((a, b) => a - b);
  assert.deepEqual(stamped, [1, 6], 'the pending phase nothing hinted, and the queued one with no lane');
  const one = state.phases['1'].undriven!;
  assert.equal(one.board, 'in-progress');
  assert.equal(one.situation, 'resource-wall:usage', 'the last situation it was classified in');
  assert.equal(one.since, '2026-09-25T05:00:00.000Z');
  assert.ok(one.why.length > 10, 'and a sentence saying why nothing drives it');
  assert.match(state.phases['6'].undriven!.why, /queue/i, 'a queued record with no queue entry says so');

  // The episode keeps its start; a later tick moves nothing but the facts.
  runner.clock += 20 * MINUTE;
  runner.mark(board(WORDS), [2, 8]);
  assert.equal(state.phases['1'].undriven!.since, '2026-09-25T05:00:00.000Z');

  // It boards: the stamp goes.
  runner.mark(board(WORDS), [1, 2, 8]);
  assert.equal(state.phases['1'].undriven, undefined, 'boarding this tick is being driven');
  // …and a board that no longer reads it in progress clears it too.
  runner.mark(board({ ...WORDS, 6: 'done' }), [2, 8]);
  assert.equal(state.phases['6'].undriven, undefined);
});

test('UD-1: a hint alone is not being driven — a hinted phase no candidate pass takes is undriven, named with its hint (control-tower phase 86, #114)', () => {
  const runner = tick();
  const state = fleet();
  runner.install(state, [5]);
  // This tick does not take phase 2 (a fence, a verification hold): its hint
  // is a request nobody is acting on — the P78/P79/P81/P83 shape of 2026-09-26.
  runner.mark(board(WORDS), [8]);
  const two = state.phases['2'].undriven;
  assert.ok(two, 'the hinted phase is stamped');
  assert.match(two!.why, /hinted resume-own-session since 2026-09-25T04:00:00.000Z/, 'naming the hint and its time');
  // The next tick takes it: the stamp goes.
  runner.mark(board(WORDS), [2, 8]);
  assert.equal(state.phases['2'].undriven, undefined);
});

test('UD-1: the shared helper lists a live run\'s undriven phases and none of a run that is not live', () => {
  const { undrivenPhases } = lifecycle as unknown as {
    undrivenPhases: (run: unknown) => { phase: number; since: string; board: string; why: string; situation: string | null }[];
  };
  assert.equal(typeof undrivenPhases, 'function', 'one reader, in the shared vocabulary');
  const runner = tick();
  const state = fleet();
  runner.install(state, [5]);
  runner.mark(board(WORDS), [2, 8]);
  assert.deepEqual(undrivenPhases(state).map((row) => row.phase), [1, 6]);
  for (const status of ['parked', 'halted', 'finished', 'paused']) {
    assert.deepEqual(undrivenPhases({ ...state, status }), [], `a ${status} run drives nothing — its phases are its halt's story, not this state`);
  }
});

test('UD-1: GET /api/runs carries the state — per phase, and as the run\'s undriven list', async () => {
  const runner = tick();
  const state = fleet();
  runner.install(state, [5]);
  runner.mark(board(WORDS), [2, 8]);
  const service = { root: null, store: { list: () => [] }, allRuns: async () => [state] };
  const { status, body } = await call(service, '/api/runs');
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body[0].phases['1'].undriven.board, 'in-progress');
  assert.deepEqual(body[0].undriven.map((row: { phase: number }) => row.phase), [1, 6]);
  assert.equal(body[0].undriven[0].since, '2026-09-25T05:00:00.000Z');
});

/** A minimal `handleApi` caller — the fake needs `res.req`, as `debug-routes.test.ts` explains. */
async function call(service: unknown, path: string): Promise<{ status: number; body: any }> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out = { status: 0, body: null as any };
  const req = {
    method: 'GET',
    headers: { 'x-phase-console': '1' } as Record<string, string>,
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { /* no body */ },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
      try { out.body = JSON.parse(text); } catch { out.body = text; }
    },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

/* ------------------------------------------------------------------ *
 * UD-2 — an attention item after a bounded time
 * ------------------------------------------------------------------ */

test('UD-2: undriven is a stall kind with its own clock — the one place the bound lives', () => {
  const { STALL_KINDS, STALL_META } = attention as unknown as {
    STALL_KINDS: readonly string[]; STALL_META: Record<string, { afterMs: number; severity: string; label: string }>;
  };
  assert.ok(STALL_KINDS.includes('undriven'));
  assert.equal(STALL_META.undriven.afterMs, 30 * MINUTE);
  assert.equal(STALL_META.undriven.severity, 'needs-you');
});

test('UD-2: the inbox raises one row once the bound has passed, with Retry — never sooner, never for a run that is not live', async () => {
  const { buildInbox } = await import('../server/inbox.ts');
  const runner = tick();
  const state = fleet();
  runner.install(state, [5]);
  runner.mark(board(WORDS), [2, 8]);
  const since = Date.parse(state.phases['1'].undriven!.since);
  const rows = (run: RunState, now: number) => buildInbox({ runs: [run as never], flags: { allowRun: true } } as never, now)
    .items.filter((item) => item.kind === 'stall' && item.id.endsWith(':undriven')); // `subject` never leaves the server: the id carries it

  assert.deepEqual(rows(state, since + 29 * MINUTE), [], 'not before the clock');
  const raised = rows(state, since + 31 * MINUTE);
  assert.deepEqual(raised.map((row) => row.phase).sort(), [1, 6]);
  const one = raised.find((row) => row.phase === 1)!;
  assert.equal(one.severity, 'needs-you');
  assert.match(one.title, /phase 1/);
  assert.match(one.need, /in-progress|in progress/);
  assert.equal(one.since, state.phases['1'].undriven!.since, 'the row\'s clock is the episode\'s');
  const retry = one.actions.find((action) => action.verb === 'retry');
  assert.ok(retry);
  assert.equal(retry!.endpoint, '/api/run/demo/retry');
  assert.deepEqual(retry!.body, { phase: 1 });

  assert.deepEqual(rows({ ...state, status: 'parked' } as RunState, since + 31 * MINUTE), [], 'a stopped run asks through its halt, not here');
});
