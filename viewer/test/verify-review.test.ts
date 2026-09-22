/**
 * The verification REVIEW: one prediction of what boarding and verification
 * will do with a phase's §Verification, asked by every reader before a session
 * is bought.
 *
 * Run f0da619a (2026-09-18) halted because five readers of one rule asked five
 * weaker questions — lint F14 ("any lettered backtick span"), the start
 * response ("nothing runnable"), the plan page ("a person MAY be asked"), plan
 * health ("zero commands") and the launch door (nothing at all) — while
 * boarding parked on ANY fragment under `Person-check: halt`. This module is
 * the one question; its park sentences are the ones boarding writes.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandFingerprint } from '../server/runner/verify.ts';
import { VERIFICATION_PARK_NOTE } from '../server/runner/runner-core.ts';
import { VERIFICATION_PARK_RE } from '../server/runner/situation.ts';

const review = async (input: Record<string, unknown>) => {
  const { reviewPhase } = await import('../server/runner/verify-review.ts');
  return reviewPhase({ phase: 2, declared: true, personCheck: null, autonomy: 'keep-going', ...input } as never);
};

/** Every lead resolves, so a test is about the plan text and never this machine's PATH. */
const everyLead = () => true;
const PHASE_2 = '- `npm test`\n- `frobnicate --check tests/`';

function parksLikeBoarding(park: string | undefined) {
  assert.ok(park, 'a park sentence');
  assert.match(park!, VERIFICATION_PARK_NOTE, 'the drive loop recognises it');
  assert.match(park!, VERIFICATION_PARK_RE, 'the situation classifier recognises it');
}

test('halt + a command the runner does not know parks — and says which command and why', async () => {
  const out = await review({ verification: PHASE_2, personCheck: 'halt', canExecute: everyLead });
  assert.equal(out.verdict, 'parks');
  parksLikeBoarding(out.park);
  assert.match(out.park!, /frobnicate --check tests\/ — `frobnicate` is not a recognised command/);
  assert.deepEqual(out.runs, ['npm test']);
  assert.equal(out.items[0].approvable, true);
  assert.equal(out.items[0].fp, commandFingerprint('frobnicate --check tests/'));
});

test('its exact approval boards it; a waiver sets it aside; neither touches anything else', async () => {
  const fp = commandFingerprint('frobnicate --check tests/');
  const approved = await review({
    verification: PHASE_2, personCheck: 'halt', canExecute: everyLead, approvals: { approve: new Set([fp]) },
  });
  assert.equal(approved.verdict, 'clear');
  assert.deepEqual(approved.runs, ['npm test', 'frobnicate --check tests/']);

  const waived = await review({
    verification: PHASE_2, personCheck: 'halt', canExecute: everyLead, approvals: { waive: new Set([fp]) },
  });
  assert.equal(waived.verdict, 'clear');
  assert.equal(waived.waived.length, 1);
  assert.deepEqual(waived.items, []);
});

test('a mutating command is never approvable, and an approval of its text changes nothing', async () => {
  const text = '- `npm test`\n- `npm test > /etc/passwd`';
  const out = await review({ verification: text, personCheck: 'halt', canExecute: everyLead });
  assert.equal(out.verdict, 'parks');
  assert.equal(out.items[0].approvable, false);
  const again = await review({
    verification: text, personCheck: 'halt', canExecute: everyLead,
    approvals: { approve: new Set([commandFingerprint('npm test > /etc/passwd')]) },
  });
  assert.equal(again.verdict, 'parks');
});

test('allow records; an owner may ask only on a red; halt-on-everything always asks', async () => {
  const allow = await review({ verification: PHASE_2, personCheck: 'allow', canExecute: everyLead });
  assert.equal(allow.verdict, 'records');
  assert.equal(allow.park, undefined);

  const owner = await review({ verification: PHASE_2, personCheck: null, canExecute: everyLead });
  assert.equal(owner.verdict, 'may-ask');

  const strict = await review({
    verification: PHASE_2, personCheck: 'operator', autonomy: 'halt-on-everything', canExecute: everyLead,
  });
  assert.equal(strict.verdict, 'asks');
});

test('nothing runnable parks whatever the Person-check says', async () => {
  const out = await review({ verification: 'run the suite by hand and eyeball it', personCheck: 'allow' });
  assert.equal(out.verdict, 'parks');
  parksLikeBoarding(out.park);
  assert.match(out.park!, /contains nothing the runner can execute/);
  assert.equal(out.items[0].code, 'prose');
});

test('a declared bullet it cannot read, an omitted one, and the opt-in that waives an omitted one', async () => {
  const unread = await review({ verification: '', declared: true });
  assert.equal(unread.verdict, 'parks');
  assert.match(unread.park!, /exists in the plan but the console could not read a runnable command/);

  const omitted = await review({ verification: '', declared: false });
  assert.equal(omitted.verdict, 'parks');
  assert.match(omitted.park!, /the plan states no verification for phase 2/);
  parksLikeBoarding(omitted.park);

  const optedIn = await review({ verification: '', declared: false, allowUnverified: true });
  assert.equal(optedIn.verdict, 'clear');
  assert.equal(optedIn.unverified, true, 'the caller journals the waiver');
});

test('every lead missing from the PATH parks; some missing is a warning', async () => {
  const none = await review({ verification: '- `rg -c x src`', canExecute: () => false });
  assert.equal(none.verdict, 'parks');
  parksLikeBoarding(none.park);
  assert.match(none.park!, /cannot run on this machine — every command's lead is missing from the PATH \(rg\)/);

  const some = await review({
    verification: '- `npm test`\n- `rg -c x src`', canExecute: (lead: string) => lead !== 'rg',
  });
  assert.equal(some.verdict, 'clear');
  assert.deepEqual(some.missing, ['rg']);
});

test('a refused Setup command is shown, and is never a park', async () => {
  const out = await review({
    verification: '- `npm test`', setup: '- `frobnicate --serve`', personCheck: 'halt', canExecute: everyLead,
  });
  assert.equal(out.verdict, 'clear');
  assert.equal(out.setup.length, 1);
  assert.equal(out.setup[0].approvable, true);
});

test('the bats line that halted run f0da619a is clear today', async () => {
  const out = await review({
    verification: '- **Verify in:** phased-execution\n'
      + '  - `node --test viewer/test/engine-parity.test.ts viewer/test/state-isolation.test.ts`\n'
      + '  - `bats tests/unit/landing.bats tests/unit/directives.bats tests/unit/gates.bats`\n'
      + '  - `bash scripts/validate.sh many-plans-one-repo`',
    personCheck: 'halt', canExecute: everyLead,
  });
  assert.equal(out.verdict, 'clear', JSON.stringify(out.items));
  assert.equal(out.runs.length, 3);
});

test('a reader that must not probe this machine asks the plan alone', async () => {
  // Plan health describes the PLAN; a missing binary is a fact about this
  // machine, and a health pass that stat()ed every PATH directory per render
  // would be paying for the wrong question.
  const out = await review({
    verification: '- `rg -c x src`', skipPathProbe: true,
    canExecute: () => { throw new Error('the PATH must not be probed'); },
  });
  assert.equal(out.verdict, 'clear');
  assert.deepEqual(out.missing, []);
});

test('a draft\'s answers resolve to exact texts — an fp that names no approvable command answers nothing', async () => {
  const { resolveVerifyAnswers, reviewPhase } = await import('../server/runner/verify-review.ts');
  const reviews = [
    reviewPhase({ phase: 2, verification: PHASE_2, personCheck: 'halt', declared: true, canExecute: everyLead }),
    reviewPhase({
      phase: 3, verification: '- `npm test`\n- `npm test > /etc/passwd`', personCheck: 'halt', declared: true, canExecute: everyLead,
    }),
  ];
  const frob = commandFingerprint('frobnicate --check tests/');
  const write = commandFingerprint('npm test > /etc/passwd');
  const answers = resolveVerifyAnswers(reviews, {
    approve: [frob, write, 'not-a-fingerprint'],
    waive: [`3:${write}`, `2:${write}`, 'garbage'],
  });
  // The deny wall is not approvable, whatever the draft sends.
  assert.deepEqual(answers?.approve, [{ fp: frob, text: 'frobnicate --check tests/' }]);
  // A waiver names ITS phase's fragment; the same fp under another phase is nothing.
  assert.deepEqual(answers?.waive, [{ phase: 3, fp: write, text: 'npm test > /etc/passwd' }]);
  assert.equal(resolveVerifyAnswers(reviews, {}), undefined);
  assert.equal(resolveVerifyAnswers(reviews, undefined), undefined);
});
