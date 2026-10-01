/**
 * A change of brief never costs the lane (control-tower phase 86, #134).
 *
 * vca P19 won its lane after 2 h 10 min and lost it one second after starting:
 * its operator's Retry boarded `fresh`, the attempt then found the session a
 * 12:36Z usage wall had checkpointed (`resumeSessionId`, never cleared by the
 * Retry), asked the resume gate a SECOND time, was told the session was
 * cache-cold, and re-boarded — releasing the grant — so the sibling queued 5 s
 * earlier took the lane. The same shape recurred 51 minutes later on a
 * `continue` brief whose two gate asks disagreed. The operator's addendum rode
 * the aborted start and was gone from the re-board.
 *
 *   GH-1  a change of brief for a phase that holds its grant — a resume-checkpoint
 *         verdict, a `continue` brief, an account switch — swaps the brief in
 *         place before the spawn and never releases the grant;
 *   GH-2  `prepareReboard` and `resetForRetry` clear `resumeSessionId`;
 *   GH-3  the boarding asks the resume gate ONCE — `composeBrief`'s verdict is
 *         the attempt's, never asked again;
 *   GH-4  a person's `retryOverride` survives a console re-board.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boardHarness, journalled } from './lane-harness.ts';

process.env.PHASE_CONSOLE_LOG = '';

const { newRun, phaseRecord, saveRun, prepareReboard, resetForRetry } = await import('../server/runner/state.ts');
type RunState = import('../server/runner/state.ts').RunState;
type PhaseRecord = import('../server/runner/state.ts').PhaseRecord;

const MIN = 60_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function stored(root: string, over: (state: RunState) => void): RunState {
  const state = newRun({ slug: 'demo', root, autonomy: 'keep-going', autoRecover: false } as never);
  state.status = 'parked';
  phaseRecord(state, 1).status = 'done';
  over(state);
  saveRun(state);
  return state;
}

/** A session the resume policy calls cache-cold: a large context, idle for two hours. */
const cold = (sessionId: string) => [{ sessionId, endedAt: ago(2 * 60 * MIN), lastContext: 400_000, window: 1_000_000, account: 'default' }];
/** One it resumes: small, and just ended. */
const warm = (sessionId: string) => [{ sessionId, endedAt: ago(2 * MIN), lastContext: 40_000, window: 1_000_000, account: 'default' }];

/* ------------------------------------------------------------------ *
 * GH-1 — the grant is held while the brief changes
 * ------------------------------------------------------------------ */

test('GH-1: #134 — a Retry boarding fresh over a stale checkpoint keeps its lane: no re-board, one spawn, the addendum carried', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress', 3: 'ready' } });
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 2), {
      status: 'pending', attempts: 1, sessionId: 's-old', resumeSessionId: 's-old', tokens: cold('s-old'),
      boardingHint: { situation: 'work-in-progress', rung: 'reboard-fresh', brief: 'fresh', at: ago(5 * MIN), by: 'operator' },
      retryOverride: { addendum: 'THE-FIX-AND-THE-EXACT-STEPS', at: ago(5 * MIN), by: 'operator' },
    });
  });
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(journalled(h, 'phase.reboard-requested').filter((row) => row.phase === 2), [],
    'the console never re-boards a phase whose boarding already holds its grant');
  assert.deepEqual(h.spawned, [2, 3], 'phase 2 spawned once, in the lane it was admitted to');
  const prompt = h.requests.find((request) => /BOOT phase 2/.test(request.prompt))!.prompt;
  assert.match(prompt, /THE-FIX-AND-THE-EXACT-STEPS/, 'the operator\'s addendum rode the boarding that actually ran');
  assert.equal(h.requests.find((request) => /BOOT phase 2/.test(request.prompt))!.resume, undefined, 'a fresh boarding resumes nothing');
});

test('GH-1: a resume-checkpoint verdict at the spawn swaps the brief in place — the grant is held, the session boards with the resume brief', async () => {
  // Ready on the board with a checkpoint on the record: the boarding takes the
  // no-hint path, where the spawn door's gate is the one that decides.
  const h = boardHarness({ states: { 1: 'done', 2: 'ready', 3: 'ready' } });
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 2), { status: 'pending', attempts: 1, sessionId: 's-mid', resumeSessionId: 's-mid', tokens: warm('s-mid') });
  });
  // The boarding's look-ahead and the spawn door's gate disagree — the clock
  // moved between them — which is the backstop's whole reason to exist.
  const policy = (choice: 'resume' | 'fresh') => ({
    choice, reason: choice === 'fresh' ? 'cache-cold' : 'cache-warm', contextTokens: 400_000, idleMs: 3_600_000, accountChanged: false,
  });
  (h.runner as unknown as { resumePolicyFor: unknown }).resumePolicyFor =
    (_record: unknown, _session: string, opts: { quiet?: boolean } = {}) => policy(opts.quiet ? 'resume' : 'fresh');
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.deepEqual(journalled(h, 'phase.reboard-requested').filter((row) => row.phase === 2), [],
    'no re-board: the lane was never given back');
  const swapped = journalled(h, 'phase.brief').filter((row) => row.phase === 2 && row.rebrief === true);
  assert.equal(swapped.length, 1, 'the swap is on the record, once');
  assert.equal(swapped[0].grant, 'held');
  assert.deepEqual(h.spawned, [2, 3]);
  const request = h.requests.find((r) => /BOOT phase 2/.test(r.prompt))!;
  assert.equal(request.resume, undefined, 'the session it would have continued is not resumed');
  assert.match(request.prompt, /s-mid/, 'the fresh boarding is told why it starts over, naming the session');
});

/* ------------------------------------------------------------------ *
 * GH-2 — a re-board clears the checkpoint's session
 * ------------------------------------------------------------------ */

test('GH-2: prepareReboard and resetForRetry clear resumeSessionId — the hint is the one source of a resume', () => {
  const a = { phase: 2, status: 'waiting', resumeSessionId: 's-old', sessionId: 's-old' } as unknown as PhaseRecord;
  prepareReboard(a);
  assert.equal(a.resumeSessionId, undefined, 'a re-board of the same work carries no checkpoint forward');
  assert.equal(a.sessionId, 's-old', 'the phase keeps its memory of the session');
  for (const by of ['operator', 'console'] as const) {
    const b = { phase: 2, status: 'parked', resumeSessionId: 's-old' } as unknown as PhaseRecord;
    resetForRetry(b, { by, journal: () => {} });
    assert.equal(b.resumeSessionId, undefined, `a ${by} reset clears it too`);
  }
});

/* ------------------------------------------------------------------ *
 * GH-3 — one ask of the resume gate per boarding
 * ------------------------------------------------------------------ */

test('GH-3: a continue boarding asks the resume gate once — composeBrief\'s verdict is the attempt\'s, never asked again', async () => {
  const h = boardHarness({ states: { 1: 'done', 2: 'in-progress' } });
  const run = stored(h.root, (state) => {
    Object.assign(phaseRecord(state, 2), {
      status: 'pending', attempts: 1, sessionId: 's-warm', tokens: warm('s-warm'),
      boardingHint: { situation: 'work-in-progress', rung: 'resume-own-session', brief: 'continue', sessionId: 's-warm', at: ago(MIN), by: 'drive' },
    });
  });
  let asks = 0;
  const gate = (h.runner as unknown as { resumableSession: (record: PhaseRecord, session: string | undefined) => unknown });
  const original = gate.resumableSession.bind(h.runner);
  gate.resumableSession = (record, session) => { if (session) asks += 1; return original(record, session); };
  await h.runner.start({ slug: 'demo', root: h.root, resumeRunId: run.id, maxParallel: 1 } as never);
  await h.runner.wait();
  assert.equal(asks, 1, 'the boarding asked; the spawn door did not ask again');
  assert.deepEqual(journalled(h, 'phase.resume-checkpoint').filter((row) => row.phase === 2), [],
    'no second verdict for the same session');
  assert.equal(h.requests[0].resume, 's-warm', 'and it resumed the session the brief was composed for');
});

/* ------------------------------------------------------------------ *
 * GH-4 — the person's override survives the console's re-board
 * ------------------------------------------------------------------ */

test('GH-4: a console reset keeps a person\'s retryOverride; only the operator\'s own plain Retry clears it', () => {
  const override = { addendum: 'FIX', at: ago(MIN), by: 'operator' };
  const kept = { phase: 2, status: 'parked', retryOverride: { ...override } } as unknown as PhaseRecord;
  resetForRetry(kept, { by: 'console', journal: () => {} });
  assert.deepEqual(kept.retryOverride, override, 'the ladder, converge or a lock-cap re-arm never drops what a person asked for');
  const cleared = { phase: 2, status: 'parked', retryOverride: { ...override } } as unknown as PhaseRecord;
  resetForRetry(cleared, { by: 'operator', journal: () => {} });
  assert.equal(cleared.retryOverride, undefined, 'a plain Retry means "again, as the plan says"');
});
