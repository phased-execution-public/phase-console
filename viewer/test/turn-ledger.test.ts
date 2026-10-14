/**
 * The record of Your turn on the human-step ledger (control-tower phase 130,
 * #207) — TL-1..3, and the ledger's half of the guard (G4 at ingest, G7).
 *
 *   TL-1  a declared item carries its reason, guide, effort, due, what it
 *         unblocks, its proof's type and words, a decision's options and its
 *         waiters — written as a version-2 line.
 *   TL-2  a line written before this phase (version 1) reads as a version-2
 *         item with defaults, and no error.
 *   TL-3  the ledger stays append-only, last state wins: `returned` and
 *         `declined` are states like any other; two lanes declaring one
 *         sign-in are ONE item with two waiters (G7).
 *   TL-4  (turn-by-turn phase 7, #261, #257) two operator acts of different
 *         phases stay TWO items, each on its own clock; a plan item names the
 *         session item that covers it — by the same act, or by its errands
 *         ref — linked, never merged; a world act moved to a successor run
 *         stands on that run's lane.
 */
import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  HUMAN_STEP_LINE_VERSION, HumanStepLedger, coverLinks, declareHumanStep, otherWaiters, readLedger,
  type HumanStep, type TurnRefused,
} from '../server/human-steps.ts';

function scratch(): { file: string; ledger: HumanStepLedger; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'turn-ledger-'));
  const file = join(dir, 'human-steps.ndjson');
  return { file, ledger: new HumanStepLedger(file), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const GUIDE = 'Only you hold the keys.\n\n## Steps\n1. Open the dashboard and press Rotate.\n   Link: [Dashboard](https://dash.example.com/keys)\n';

function asStep(raised: HumanStep | TurnRefused | null): HumanStep {
  assert.ok(raised && !('refused' in raised), JSON.stringify(raised));
  return raised as HumanStep;
}

test('TL-1: a declared item carries the whole record, on a version-2 line', () => {
  const { file, ledger, done } = scratch();
  try {
    const step = asStep(declareHumanStep({ ledger, announce: () => true }, {
      slug: 'demo', phase: 3, birth: 'session', runId: 'run1', sessionId: 'sess1',
      step: {
        kind: 'decision', title: 'Pick a region', why: 'money', why_source: 'declared',
        guide: { text: GUIDE, lang: 'en' }, effort: 5, unblocks: ['4', 'other/9'],
        proof_words: 'the region is set in the config', options: [
          { id: 'eu', label: 'Europe', consequence: 'data stays in the EU' }, { id: 'us', label: 'United States' },
        ], recommended: 'eu', allow_decline: true, due_when: 'date:2099-01-01T00:00:00Z',
      },
    }));
    assert.equal(step.why, 'money');
    assert.equal(step.whySource, 'declared');
    assert.equal(step.guide?.steps[0]?.link?.url, 'https://dash.example.com/keys');
    assert.equal(step.effortMin, 5);
    assert.deepEqual(step.unblocks, [{ slug: 'demo', phase: 4 }, { slug: 'other', phase: 9 }]);
    assert.equal(step.proofType, 'answer', 'a decision is answered');
    assert.equal(step.proofWords, 'the region is set in the config');
    assert.deepEqual(step.options, [
      { id: 'eu', label: 'Europe', consequence: 'data stays in the EU', recommended: true }, { id: 'us', label: 'United States' },
    ]);
    assert.equal(step.allowDecline, true);
    assert.equal(step.dueWhen, 'date:2099-01-01T00:00:00Z');
    assert.equal(step.state, 'upcoming');
    assert.deepEqual(step.waiters, [{ slug: 'demo', phase: 3, runId: 'run1', sessionId: 'sess1' }]);
    assert.deepEqual(step.source, { kind: 'declaration' });
    assert.equal(step.attempts, 0);
    const first = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as { v: number };
    assert.equal(first.v, HUMAN_STEP_LINE_VERSION);
    assert.equal(HUMAN_STEP_LINE_VERSION, 2);
    // What was written reads back as what was declared.
    assert.deepEqual(ledger.get(step.id), step);
  } finally { done(); }
});

test('TL-2: a version-1 line written before this phase reads with defaults and no error', () => {
  const { file, ledger, done } = scratch();
  try {
    const at = '2026-10-01T00:00:00.000Z';
    appendFileSync(file, `${JSON.stringify({
      v: 1, id: 'old1', kind: 'browser-login', title: 'Sign gh in', where: 'host', birth: 'session',
      slug: 'demo', phase: 2, runId: 'r0', proof: 'cmd:"gh auth status"', state: 'declared', declaredAt: at, at, opened: 0,
    })}\n`);
    appendFileSync(file, `${JSON.stringify({ v: 1, id: 'old1', state: 'notified', at, verb: 'notify', by: 'console' })}\n`);
    appendFileSync(file, `${JSON.stringify({
      v: 1, id: 'old2', kind: 'operator-act', title: 'Restart the box', where: 'host', birth: 'plan',
      slug: 'demo', phase: 0, state: 'declared', declaredAt: at, at, opened: 0,
    })}\n`);
    const read = readLedger(file);
    assert.equal(read.skipped, 0, 'nothing refused');
    const one = read.steps.get('old1')!;
    assert.deepEqual([one.state, one.why, one.whySource, one.proofType, one.attempts], ['notified', 'identity', 'inferred', 'probe', 0]);
    assert.deepEqual(one.waiters, [{ slug: 'demo', phase: 2, runId: 'r0' }]);
    const two = ledger.get('old2')!;
    assert.deepEqual([two.why, two.proofType, two.proofTypeSource], ['reserved', 'attest', 'inferred'], 'no proof: the person’s word, as it always was');
    // An old item moves on new lines.
    const moved = ledger.move('old1', 'opened', { verb: 'open', by: 'person' });
    assert.ok(!('refused' in moved));
  } finally { done(); }
});

test('TL-3: append-only, last state wins — returned and declined are states like any other', () => {
  const { file, ledger, done } = scratch();
  try {
    const step = asStep(declareHumanStep({ ledger, announce: () => false }, {
      slug: 'demo', phase: 5, birth: 'plan', step: { kind: 'operator-act', title: 'Rotate the key', proof_words: 'the old key is revoked' },
    }));
    assert.equal(step.state, 'notified');
    assert.ok(!('refused' in ledger.move(step.id, 'checking', { verb: 'check' })));
    assert.equal(ledger.get(step.id)!.attempts, 1, 'a check is an attempt');
    assert.ok(!('refused' in ledger.move(step.id, 'returned', { verb: 'return', note: 'the old key still answers' })));
    assert.equal(ledger.get(step.id)!.state, 'returned');
    assert.ok(!('refused' in ledger.move(step.id, 'declined', { verb: 'decline', note: 'not doing this today' })));
    const settled = ledger.move(step.id, 'notified');
    assert.ok('refused' in settled, 'nothing leaves a settled state');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { state: string });
    assert.deepEqual(lines.map((l) => l.state), ['declared', 'notified', 'checking', 'returned', 'declined'], 'one line per move, never a rewrite');
  } finally { done(); }
});

test('TL-3, G7: two lanes of one plan declaring one sign-in are ONE item with two waiters', () => {
  const { ledger, done } = scratch();
  try {
    let pushes = 0;
    const deps = { ledger, announce: () => { pushes++; return true; } };
    const signIn = { kind: 'browser-login', title: 'Sign gh in', open_command: 'gh auth login', proof: 'cmd:"gh auth status"' };
    const a = asStep(declareHumanStep(deps, { slug: 'demo', phase: 3, birth: 'session', runId: 'r1', step: signIn }));
    const b = asStep(declareHumanStep(deps, { slug: 'demo', phase: 7, birth: 'session', runId: 'r1', step: { ...signIn, title: 'Sign in to GitHub' } }));
    assert.equal(b.id, a.id, 'one item');
    assert.equal(pushes, 1, 'announced once');
    assert.deepEqual(b.waiters.map((w) => `${w.slug}/${w.phase}`), ['demo/3', 'demo/7']);
    assert.deepEqual(otherWaiters(b), [{ slug: 'demo', phase: 7, runId: 'r1' }]);
    assert.equal(ledger.open().length, 1);
    // The same lane again is no news.
    const again = asStep(declareHumanStep(deps, { slug: 'demo', phase: 7, birth: 'session', runId: 'r1', step: signIn }));
    assert.equal(again.waiters.length, 2);
    // Never across plans: another plan's lane gets an item of its own, so a
    // proof made for one plan never resumes another.
    const other = asStep(declareHumanStep(deps, { slug: 'other', phase: 7, birth: 'session', runId: 'r2', step: signIn }));
    assert.notEqual(other.id, a.id);
    assert.equal(ledger.open().length, 2);
  } finally { done(); }
});

test('the guard at ingest: an act the run may already do raises nothing; one a rule stops becomes a permission item', () => {
  const { ledger, done } = scratch();
  try {
    const deps = { ledger, announce: () => true };
    const act = (commands: string, judge: 'allow' | 'deny') => declareHumanStep(deps, {
      slug: 'demo', phase: 8, birth: 'session', runId: 'r1',
      judge: () => (judge === 'allow' ? { verdict: 'allow' } : { verdict: 'deny', rule: 'Bash(git push:*)' }),
      step: {
        kind: 'operator-act', title: 'Ship it', why: 'reserved', why_source: 'declared', proof_type: 'attest',
        guide: { text: `Why.\n\n## Steps\n1. Run\n   \`\`\`sh\n   ${commands}\n   \`\`\`\n` },
      },
    });
    const refusedRaise = act('npm test', 'allow');
    assert.ok(refusedRaise && 'refused' in refusedRaise);
    assert.equal((refusedRaise as TurnRefused).refused.exit, 4);
    assert.equal(ledger.all().length, 0, 'nothing written');
    const permission = asStep(act('git push origin main', 'deny'));
    assert.equal(permission.kind, 'permission');
    assert.equal(permission.why, 'permission');
    assert.equal(permission.proofType, 'grant');
    assert.deepEqual(permission.permission, { wall: 'deny', command: 'git push origin main', rule: 'Bash(git push:*)' });
  } finally { done(); }
});

test('TL-4, G7: two operator acts of different phases stay two items — the act of each phase, on its own clock (#261, #257)', () => {
  const { ledger, done } = scratch();
  try {
    let pushes = 0;
    const deps = { ledger, announce: () => { pushes++; return true; } };
    const act = { kind: 'operator-act', title: 'Rotate the deploy key', why: 'reserved', why_source: 'declared', proof_type: 'attest', open_command: 'deploy-keys rotate' };
    const three = asStep(declareHumanStep(deps, { slug: 'demo', phase: 3, birth: 'session', runId: 'r1', step: act }));
    const four = asStep(declareHumanStep(deps, { slug: 'demo', phase: 4, birth: 'session', runId: 'r1', step: act }));
    assert.notEqual(four.id, three.id, 'two phases, two acts');
    assert.equal(ledger.open().length, 2);
    assert.equal(pushes, 2, 'each announced on its own');
    assert.deepEqual(four.waiters.map((w) => w.phase), [4]);
    // A sign-in met by both phases is still the world's one item (G7 stands).
    const signIn = { kind: 'browser-login', title: 'Sign gh in', open_command: 'gh auth login', proof: 'cmd:"gh auth status"' };
    const s3 = asStep(declareHumanStep(deps, { slug: 'demo', phase: 3, birth: 'session', runId: 'r1', step: signIn }));
    const s4 = asStep(declareHumanStep(deps, { slug: 'demo', phase: 4, birth: 'session', runId: 'r1', step: signIn }));
    assert.equal(s4.id, s3.id);
  } finally { done(); }
});

test('TL-4: a plan item names the session item that covers it — the same act, or its errands ref in the session\'s words — linked, never merged', () => {
  const { ledger, done } = scratch();
  try {
    const deps = { ledger, announce: () => true };
    const tunnel = asStep(declareHumanStep(deps, { slug: 'demo', phase: 0, birth: 'plan', step: { kind: 'operator-act', title: 'Create the tunnel and its hostnames (E-4)', why: 'reserved' } }));
    const token = asStep(declareHumanStep(deps, { slug: 'demo', phase: 0, birth: 'plan', step: { kind: 'operator-act', title: 'Mint the service token (E-3)', why: 'reserved' } }));
    const alone = asStep(declareHumanStep(deps, { slug: 'demo', phase: 0, birth: 'plan', step: { kind: 'operator-act', title: 'Approve the release train (E-6)', why: 'reserved' } }));
    const session = asStep(declareHumanStep(deps, {
      slug: 'demo', phase: 3, birth: 'session', runId: 'r1',
      step: {
        kind: 'operator-act', title: 'Set up the tunnel, the token and the access apps', why: 'reserved', why_source: 'declared', proof_type: 'attest',
        guide: { text: 'Covers E-3 and E-4 in one pass.\n\n## Steps\n1. Open the dashboard and create the tunnel.\n' },
      },
    }));
    const elsewhere = asStep(declareHumanStep(deps, {
      slug: 'other', phase: 2, birth: 'session', runId: 'r2',
      step: { kind: 'operator-act', title: 'Approve the release train (E-6)', why: 'reserved', why_source: 'declared', proof_type: 'attest' },
    }));
    const links = coverLinks(ledger.open());
    assert.deepEqual(links.coveredBy.get(tunnel.id), { id: session.id, phase: 3, title: session.title });
    assert.deepEqual(links.coveredBy.get(token.id), { id: session.id, phase: 3, title: session.title });
    assert.deepEqual(links.covers.get(session.id)?.map((one) => one.id).sort(), [tunnel.id, token.id].sort());
    assert.equal(links.coveredBy.get(alone.id), undefined, 'another plan\'s session covers nothing here');
    assert.equal(links.covers.get(elsewhere.id), undefined);
    // Linked, never merged: every item keeps its own record.
    assert.equal(ledger.open().length, 5);
    // The same act re-raised by a session covers it too.
    const same = asStep(declareHumanStep(deps, {
      slug: 'demo', phase: 5, birth: 'session', runId: 'r1',
      step: { kind: 'operator-act', title: 'approve the release train (E-6)', why: 'reserved', why_source: 'declared', proof_type: 'attest' },
    }));
    assert.equal(coverLinks(ledger.open()).coveredBy.get(alone.id)?.id, same.id);
    // A dismissed session item covers nothing.
    ledger.move(session.id, 'dismissed', { by: 'test', verb: 'dismiss' });
    assert.equal(coverLinks([...readLedger(ledger.file).steps.values()]).coveredBy.get(tunnel.id), undefined);
  } finally { done(); }
});

test('TL-4: a world act moved to a successor run stands on its lane — its own lane and its waiters, the old session gone', () => {
  const { ledger, done } = scratch();
  try {
    const deps = { ledger, announce: () => true };
    const signIn = { kind: 'browser-login', title: 'Sign gh in', open_command: 'gh auth login', proof: 'cmd:"gh auth status"' };
    const step = asStep(declareHumanStep(deps, { slug: 'demo', phase: 3, birth: 'session', runId: 'rA', sessionId: 'sA', step: signIn }));
    asStep(declareHumanStep(deps, { slug: 'demo', phase: 4, birth: 'session', runId: 'rA', step: signIn }));
    const moved = ledger.relane(step.id, { slug: 'demo', phase: 3, from: 'rA', to: 'rB' }) as HumanStep;
    assert.equal(moved.runId, 'rB');
    assert.equal(moved.sessionId, undefined, 'the old run\'s session goes with it');
    assert.deepEqual(moved.waiters.map((w) => `${w.phase}:${w.runId}`), ['3:rB', '4:rA']);
    assert.equal(moved.state, step.state, 'a move changes no state');
    // Read back from the file, the same.
    assert.equal(readLedger(ledger.file).steps.get(step.id)?.runId, 'rB');
    // A lane it does not have is no news.
    assert.equal((ledger.relane(step.id, { slug: 'demo', phase: 9, from: 'rA', to: 'rB' }) as HumanStep).waiters.length, 2);
  } finally { done(); }
});
