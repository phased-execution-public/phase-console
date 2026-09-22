/**
 * The resume policy (autopilot-token-drain phase 4): whether the one resume gate
 * hands a session to `--resume`, or has the phase boarded FRESH with the resume
 * brief because resuming it would cost more than starting over.
 *
 * A resume re-reads the whole conversation. Warm, that read is a cache hit; cold
 * — the prompt cache outlived, or the account paying is not the one that wrote
 * it — the first call writes all of it again. The shapes below are run
 * `deadaff9`'s, measured: P8 declared `partial (budget)` at 681k and its session
 * was resumed 3 h 55 m later, writing 554,419 on the first call; P3's session was
 * carried to another account at 824k and wrote 824,343. A fresh boot costs the
 * bootstrap (105–115k) and the brief.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESUME_CACHE_COLD_MS, RESUME_FRESH_MIN_CONTEXT, resumePolicy, type TokenAttempt,
} from '../server/runner/usage.ts';
import type { ResumeVerdict, RunnerDeps } from '../server/runner/runner-core.ts';
import type { PhaseRecord, RunState } from '../server/runner/state.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-16T16:30:20Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** One session's counters as the record keeps them — only the fields the policy reads matter. */
const attempt = (sessionId: string, lastContext: number, endedAgoMs: number, extra: Partial<TokenAttempt> = {}): TokenAttempt => ({
  mode: 'phase', attempt: 1, sessionId, resumed: false, model: 'claude-opus-5[1m]', window: 1_000_000,
  calls: 200, lastContext, peakContext: lastContext, input: 400, cacheWrite: 700_000, cacheRead: 80_000_000,
  output: 150_000, rebuilds: 0, endedAt: ago(endedAgoMs), account: 'default', ...extra,
});

test('the thresholds are the plan\'s numbers, in one place', () => {
  assert.equal(RESUME_FRESH_MIN_CONTEXT, 250_000);
  assert.equal(RESUME_CACHE_COLD_MS, 55 * MIN, 'the usage shows a one-hour cache; five minutes of margin');
});

/* ---- the five measured shapes ---- */

test('P8: 681k, idle 3 h 55 m, same account — fresh, the cache is cold', () => {
  const record = { tokens: [attempt('sess-p8', 681_000, 3 * HOUR + 55 * MIN)] };
  assert.deepEqual(resumePolicy(record, 'sess-p8', { now: NOW, paying: 'default' }), {
    choice: 'fresh', reason: 'cache-cold', contextTokens: 681_000, idleMs: 3 * HOUR + 55 * MIN, accountChanged: false,
  });
});

test('P3: 824k, the account changed — fresh, whatever the idle time', () => {
  const record = { tokens: [attempt('sess-p3', 824_343, 30_000, { account: 'default' })] };
  assert.deepEqual(resumePolicy(record, 'sess-p3', { now: NOW, paying: 'account' }), {
    choice: 'fresh', reason: 'account-changed', contextTokens: 824_343, idleMs: 30_000, accountChanged: true,
  });
});

test('warm and small: 120k, idle 2 min — resumed', () => {
  const record = { tokens: [attempt('sess-w', 120_000, 2 * MIN)] };
  assert.deepEqual(resumePolicy(record, 'sess-w', { now: NOW, paying: 'default' }), {
    choice: 'resume', reason: 'small', contextTokens: 120_000, idleMs: 2 * MIN, accountChanged: false,
  });
});

test('partial --reason budget or context — fresh at ANY size; another reason is no reason', () => {
  const tokens = [attempt('sess-w', 120_000, 2 * MIN)];
  for (const reason of ['budget', 'context'] as const) {
    const record = { tokens, lastPartial: { sessionId: 'sess-w', reason, at: ago(2 * MIN) } };
    const policy = resumePolicy(record, 'sess-w', { now: NOW, paying: 'default' });
    assert.equal(policy.choice, 'fresh', reason);
    assert.equal(policy.reason, `partial-${reason}`);
    assert.equal(policy.contextTokens, 120_000);
  }
  const other = { tokens, lastPartial: { sessionId: 'sess-w', reason: 'other', at: ago(2 * MIN) } };
  assert.equal(resumePolicy(other, 'sess-w', { now: NOW, paying: 'default' }).choice, 'resume');
  const unmeasured = { lastPartial: { sessionId: 'sess-x', reason: 'budget', at: ago(MIN) } };
  assert.equal(resumePolicy(unmeasured, 'sess-x', { now: NOW, paying: 'default' }).reason, 'partial-budget',
    'the session said so itself — no counters needed');
  const someoneElse = { tokens, lastPartial: { sessionId: 'sess-older', reason: 'budget', at: ago(HOUR) } };
  assert.equal(resumePolicy(someoneElse, 'sess-w', { now: NOW, paying: 'default' }).choice, 'resume',
    'a partial another session declared says nothing about this one');
});

test('a waiting-external resume at 600k after 70 min — fresh (operator decision 2026-09-16)', () => {
  const record = { tokens: [attempt('sess-wait', 600_000, 70 * MIN)] };
  assert.deepEqual(resumePolicy(record, 'sess-wait', { now: NOW, paying: 'default' }), {
    choice: 'fresh', reason: 'cache-cold', contextTokens: 600_000, idleMs: 70 * MIN, accountChanged: false,
  });
});

/* ---- the edges ---- */

test('the lines: under 250k stays resumable however cold; at 250k a warm session resumes, a 55-min-idle one does not', () => {
  const at = (context: number, idle: number) =>
    resumePolicy({ tokens: [attempt('s', context, idle)] }, 's', { now: NOW, paying: 'default' });
  assert.deepEqual([at(249_999, 10 * HOUR).choice, at(249_999, 10 * HOUR).reason], ['resume', 'small']);
  assert.deepEqual([at(250_000, 55 * MIN - 1).choice, at(250_000, 55 * MIN - 1).reason], ['resume', 'cache-warm']);
  assert.deepEqual([at(250_000, 55 * MIN).choice, at(250_000, 55 * MIN).reason], ['fresh', 'cache-cold']);
});

test('the session the console checkpointed at 0.8 × is never resumed — by any path', () => {
  const record = {
    tokens: [attempt('sess-cp', 812_000, 30_000)],
    contextCheckpoint: { sessionId: 'sess-cp', at: ago(30_000), context: 812_000, window: 1_000_000 },
  };
  const policy = resumePolicy(record, 'sess-cp', { now: NOW, paying: 'default' });
  assert.equal(policy.choice, 'fresh');
  assert.equal(policy.reason, 'context-checkpoint');
  assert.equal(resumePolicy({ ...record, tokens: [attempt('sess-next', 90_000, 30_000)] }, 'sess-next',
    { now: NOW, paying: 'default' }).choice, 'resume', 'a later session of the same phase is its own');
});

test('a session with no counters is resumed as it always was — a hand session, a record from before phase 3', () => {
  assert.deepEqual(resumePolicy({}, 'sess-hand', { now: NOW, paying: 'default' }), {
    choice: 'resume', reason: 'unmeasured', contextTokens: null, idleMs: null, accountChanged: false,
  });
});

test('the NEWEST run of the session is what counts — a closeout that grew it, not the phase attempt before', () => {
  const record = {
    tokens: [
      attempt('sess-a', 180_000, 3 * HOUR),
      attempt('sess-other', 900_000, 2 * HOUR),
      attempt('sess-a', 420_000, 2 * MIN, { mode: 'closeout', resumed: true }),
    ],
  };
  const policy = resumePolicy(record, 'sess-a', { now: NOW, paying: 'default' });
  assert.deepEqual([policy.choice, policy.reason, policy.contextTokens, policy.idleMs], ['resume', 'cache-warm', 420_000, 2 * MIN]);
});

test('the account: from the counters; from where the transcript lives for counters written before they named one; unjudged when the caller does not know who pays', () => {
  const unnamed = attempt('s', 500_000, MIN, { account: undefined });
  assert.equal(resumePolicy({ tokens: [unnamed], sessionAccountId: 'spare' }, 's', { now: NOW, paying: 'default' }).reason,
    'account-changed');
  assert.equal(resumePolicy({ tokens: [unnamed] }, 's', { now: NOW, paying: 'default' }).reason, 'cache-warm',
    'no account anywhere is the machine login');
  const named = attempt('s', 500_000, MIN, { account: 'spare' });
  const unknown = resumePolicy({ tokens: [named] }, 's', { now: NOW, paying: null });
  assert.deepEqual([unknown.choice, unknown.accountChanged], ['resume', false]);
});

/* ---- the gate: every --resume asks it ---- */

type Gate = {
  state: RunState;
  resumableSession(record: PhaseRecord, sessionId: string | undefined): ResumeVerdict;
};

/** A runner holding `state`, its gate reachable, its journal lines collected. */
function gateOf(state: RunState, deps: Partial<RunnerDeps> = {}) {
  const lines: { event: string; phase?: number; data: Record<string, unknown> }[] = [];
  const instance = new Runner({
    scriptsDir: '/nonexistent',
    now: () => new Date(NOW),
    onEvent: (event, data) => {
      if (event === 'run:journal') lines.push(data as { event: string; phase?: number; data: Record<string, unknown> });
    },
    ...deps,
  } as RunnerDeps);
  const gate = instance as unknown as Gate;
  gate.state = state;
  return { gate, policyLines: () => lines.filter((line) => line.event === 'phase.resume-policy') };
}

test('the gate refuses a session not worth resuming — `fresh`, with the policy — and never ports its transcript', () => {
  const state = newRun({ slug: 'demo', root: '/nonexistent' });
  state.accountId = 'account';
  const record = phaseRecord(state, 3);
  record.sessionId = 'sess-p3';
  record.tokens = [attempt('sess-p3', 824_343, 30_000, { account: 'default' })];
  const ports: string[] = [];
  const { gate, policyLines } = gateOf(state, {
    portTranscript: (sessionId) => { ports.push(sessionId); return { findable: true, ported: true, why: 'copied' as const }; },
  });

  const verdict = gate.resumableSession(record, 'sess-p3');
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.why, 'fresh');
  assert.equal(!verdict.ok && verdict.policy?.reason, 'account-changed');
  assert.deepEqual(ports, [], 'a transcript nobody will resume is not carried anywhere');
  assert.deepEqual(policyLines().map((line) => ({ phase: line.phase, ...line.data })), [{
    phase: 3, sessionId: 'sess-p3', choice: 'fresh', reason: 'account-changed',
    contextTokens: 824_343, idleMs: 30_000, accountChanged: true,
  }]);

  gate.resumableSession(record, 'sess-p3');
  assert.equal(policyLines().length, 1, 'the same decision about the same run of a session is journalled once');
});

test('the gate resumes a warm session as before, and says why', () => {
  const state = newRun({ slug: 'demo', root: '/nonexistent' });
  const record = phaseRecord(state, 1);
  record.sessionId = 'sess-w';
  record.tokens = [attempt('sess-w', 120_000, 2 * MIN)];
  const { gate, policyLines } = gateOf(state);
  const verdict = gate.resumableSession(record, 'sess-w');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.resume.sessionId, 'sess-w');
  assert.deepEqual(policyLines().map((line) => [line.data.choice, line.data.reason]), [['resume', 'small']]);
});

test('a hand session\'s `partial --reason budget` reaches the gate too — the declared session is not resumed', async () => {
  const state = newRun({ slug: 'demo', root: '/nonexistent' });
  const record = phaseRecord(state, 2);
  record.status = 'failed';
  const { gate } = gateOf(state);
  const declare = gate as unknown as {
    declareOutcome(phase: number, declared: Record<string, unknown>, by?: string): Promise<string | null>;
  };
  const verdict = await declare.declareOutcome(2, {
    version: 1, slug: 'demo', phase: 2, status: 'partial', reason: 'budget', watch: [],
    written_at: new Date(NOW).toISOString(), session_id: 'sess-hand',
  }, 'unsupervised');
  assert.equal(verdict, 'boarding');
  assert.deepEqual([record.lastPartial?.sessionId, record.lastPartial?.reason], ['sess-hand', 'budget']);
  assert.equal(record.boardingHint?.brief, 'continue', 'the ladder still asks for the session…');
  const answer = gate.resumableSession(record, 'sess-hand');
  assert.equal(!answer.ok && answer.policy?.reason, 'partial-budget', '…and the gate answers fresh');
});

test('a LIVE session is held, not boarded fresh beside — presence is asked before the policy', () => {
  const state = newRun({ slug: 'demo', root: '/nonexistent' });
  const record = phaseRecord(state, 1);
  record.sessionId = 'sess-live';
  record.tokens = [attempt('sess-live', 681_000, 4 * HOUR)];
  const { gate, policyLines } = gateOf(state, { sessionPresence: () => ({ presence: 'live' as const, pid: 7 }) });
  const verdict = gate.resumableSession(record, 'sess-live');
  assert.equal(!verdict.ok && verdict.why, 'session-live');
  assert.deepEqual(policyLines(), []);
});


/**
 * console-open-findings O5 — the closeout's refusal note says WHY in the words
 * a person can act on, not the gate's internal union member.
 *
 * `(${gate.why})` interpolated the verdict's own vocabulary, so a session the
 * policy declined told the operator it "cannot be resumed (fresh)" — a sentence
 * that reads like a malfunction and names none of the three facts the policy
 * actually weighed. `resumePolicyWhy` already says it in English everywhere else.
 */
test('O5: a closeout declined by the POLICY explains itself; the other refusals still say what they are', async () => {
  const { closeoutSkipNote } = await import('../server/runner/runner-core.ts');
  const policy = {
    choice: 'fresh' as const, reason: 'cache-cold' as const,
    contextTokens: 612_000, idleMs: 4 * 60 * 60_000, accountChanged: false,
  };
  const declined = closeoutSkipNote({ ok: false, why: 'fresh', sessionId: 'sess-a', policy }, 'sess-a');
  assert.ok(!/\(fresh\)/.test(declined), `never the raw union member: ${declined}`);
  assert.match(declined, /612k/, 'the size it would have re-read');
  assert.match(declined, /cache|ago/, 'and why that was not worth it');

  const live = closeoutSkipNote({ ok: false, why: 'session-live', sessionId: 'sess-b' }, 'sess-b');
  assert.match(live, /still running/, 'the one refusal that is about a live session');

  for (const why of ['gone', 'unported', 'none'] as const) {
    const note = closeoutSkipNote({ ok: false, why, sessionId: 'sess-c' }, 'sess-c');
    assert.ok(note.length > 0, `${why} says something`);
    assert.ok(!new RegExp(`\\(${why}\\)`).test(note), `${why}: not the raw union member either`);
  }
});
