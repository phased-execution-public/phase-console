/**
 * A decision is checked, not passed on the press (one-pool phase 13, #367 #368).
 *
 *   DC-1  a plan-born decision with options whose proof greps a file for
 *         `<key>: answered` passes after ONE press: *Send my decision* writes
 *         the answer where the proof reads it, the item goes through
 *         `checking` and ends Passed — and the file holds the answer.
 *   DC-2  a decision whose proof the answer cannot satisfy comes back Redo,
 *         carrying its source's steps; the answer stays on the item.
 *   DC-3  the card offers ONE act for a decision with options — no
 *         *I've done this — check* beside *Send my decision* — and its words
 *         never tell a person to press a button the card does not show.
 *   DC-4  a plan item's proof is read from the plan's bullet as it is NOW
 *         when the bullet changed after launch (`turn.proof-reread`, #345).
 *   DC-5  a decision whose proof names a file outside the plan's own
 *         handoffs folder is not written: the press is refused with why, and
 *         nothing moves.
 *   DC-6  the write goes through no link and a `test -f` file is created,
 *         never overwritten; another plan's folder and the plan file are not
 *         the answers folder.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SLUG, call, harness } from './turn-harness.ts';

type HumanStep = import('../server/human-steps.ts').HumanStep;

const OPTIONS = [
  { id: 'prune', label: 'Prune once, then pause the sync', consequence: 'the store shrinks today' },
  { id: 'accept', label: 'Accept the growth until Release H', consequence: 'nothing changes now' },
];

const GUIDE = 'Why it matters.\n\n## Steps\n1. Open the answers file.\n2. Write the line the proof looks for.\n   ```\n   printf "approved: yes" >> answers.md\n   ```\n';

/** A plan-born decision on phase 3, as the launch door raises one. */
function planDecision(h: ReturnType<typeof harness>, proof: string, extra: Record<string, unknown> = {}): HumanStep {
  const step = h.svc.recordHumanStep({
    slug: SLUG, phase: 3, birth: 'plan',
    step: {
      kind: 'decision', title: 'Stop the store growing now (E-1)', where: 'any', proof, why: 'decision',
      options: OPTIONS, recommended: 'prune', ...extra,
    },
  });
  assert.ok(step && !('refused' in step), JSON.stringify(step));
  return step as HumanStep;
}

/** The plan file, with phase 3's Human step bullet carrying `proof`. */
function writePlanBullet(root: string, proof: string): void {
  const file = join(root, 'docs', 'plans', `${SLUG}.md`);
  const text = readFileSync(file, 'utf8').replace(
    '### Phase 3 — three\n',
    `### Phase 3 — three\n- **Human step:** decision · Stop the store growing now (E-1) · proof: \`${proof}\` · why: decision · options: prune=Prune once, then pause the sync | accept=Accept the growth until Release H · recommended: prune\n`,
  );
  writeFileSync(file, text);
}

test('DC-1 — one press: the answer is written where the proof reads it, checked, and Passed', async () => {
  const h = harness();
  try {
    const answers = join(h.root, 'docs', 'handoffs', SLUG, 'owner-answers.md');
    mkdirSync(join(h.root, 'docs', 'handoffs', SLUG), { recursive: true });
    writeFileSync(answers, '# Owner answers — pending\n');
    const step = planDecision(h, `cmd:"grep -qi '^store: answered' ${answers}"`);
    const pressed = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'prune', note: 'go ahead' });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    const check = pressed.body.check as { state: string; landed: boolean };
    assert.equal(check.state, 'passed', JSON.stringify(pressed.body));
    assert.equal(check.landed, true);
    assert.match(readFileSync(answers, 'utf8'), /^store: answered — Prune once, then pause the sync: go ahead$/m, 'the proof file holds the answer');
    assert.equal(pressed.body.wrote, `docs/handoffs/${SLUG}/owner-answers.md`);
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'proven');
    assert.equal(now.answer?.option, 'prune', 'the answer is kept on the item');
    const states = h.svc.humanStepsNow().history(step.id).map((move) => `${move.verb}:${move.state}`);
    assert.ok(states.includes('answer:checking'), `it read Checking after the press: ${states.join(' ')}`);
    assert.equal(states.at(-1), 'prove:proven', 'Passed only once the proof read true');
    assert.equal(now.verdict?.state, 'passed');
    assert.equal(now.verdict?.by, 'probe', 'the proof checked it, not the click');
  } finally { h.cleanup(); }
});

test('DC-2 — an answer its proof does not see comes back Redo with the source\'s steps', async () => {
  const h = harness();
  try {
    const answers = join(h.root, 'docs', 'handoffs', SLUG, 'answers.md');
    mkdirSync(join(h.root, 'docs', 'handoffs', SLUG), { recursive: true });
    writeFileSync(answers, 'pending\n');
    const step = planDecision(h, `cmd:"grep -q '^approved: yes' ${answers}"`, { guide: { text: GUIDE } });
    const pressed = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'accept' });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    const verdict = pressed.body.verdict as { state: string; redo: string[]; note: string };
    assert.equal(verdict.state, 'rejected');
    assert.match(verdict.redo[0]!, /Your decision \("Accept the growth until Release H"\) was sent, but the console still cannot see that/);
    assert.ok(verdict.redo.some((line) => /^1\. Open the answers file\./.test(line)), `the guide's steps ride the Redo: ${verdict.redo.join(' | ')}`);
    assert.ok(verdict.redo.some((line) => /^2\. Write the line the proof looks for\. Run: printf/.test(line)), 'each with its command');
    assert.ok(!/cmd:|pending —/.test(`${verdict.note} ${verdict.redo.join(' ')}`), 'no ref and no state word reach a person');
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.state, 'returned');
    assert.equal(now.answer?.option, 'accept');
    assert.equal(readFileSync(answers, 'utf8'), 'pending\n', 'a proof that names no answer line is not written to');
  } finally { h.cleanup(); }
});

test('DC-3 — a decision with options offers ONE act, and its words name no button it lacks', async () => {
  const h = harness();
  try {
    const answers = join(h.root, 'docs', 'handoffs', SLUG, 'owner-answers.md');
    const step = planDecision(h, `cmd:"grep -qi '^store: answered' ${answers}"`);
    const turn = await call(h.svc, 'GET', '/api/turn');
    assert.equal(turn.status, 200);
    type Item = { item: string; actions?: { verb: string }[]; options?: unknown[] };
    const items = Object.values(turn.body.groups as Record<string, Item[]>).flat();
    const item = items.find((one) => one.item === step.id);
    assert.ok(item, `the item is on Your turn: ${items.map((one) => one.item).join(',')}`);
    assert.ok(!(item!.actions ?? []).some((action) => action.verb === 'check'), `no check beside Send my decision: ${JSON.stringify(item!.actions)}`);
    assert.ok((item!.options ?? []).length === 2, 'the two options are the act');
    const words = JSON.stringify(item);
    assert.ok(!/press I've done this — check/.test(words), 'its guide never ends "press I\'ve done this — check"');
    assert.match(words, /send your decision/i);
  } finally { h.cleanup(); }
});

test('DC-4 — a proof fixed in the plan after launch is the one the check reads (turn.proof-reread)', async () => {
  const h = harness();
  try {
    const answers = join(h.root, 'docs', 'handoffs', SLUG, 'owner-answers.md');
    mkdirSync(join(h.root, 'docs', 'handoffs', SLUG), { recursive: true });
    writeFileSync(answers, 'store: answered — earlier\n');
    // Raised with a proof that can never read (a relative path) …
    const step = planDecision(h, 'cmd:"grep -qi \'^store: answered\' docs/handoffs/alpha/owner-answers.md"');
    // … and the plan fixed afterwards.
    const fixed = `cmd:"grep -qi '^store: answered' ${answers}"`;
    writePlanBullet(h.root, fixed);
    (h.svc as unknown as { reread: (slug: string) => void }).reread(SLUG);
    const checked = await call(h.svc, 'POST', `/api/human-steps/${step.id}/check`, {});
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal((checked.body.check as { state: string }).state, 'passed', JSON.stringify(checked.body));
    const now = h.svc.humanStepsNow().get(step.id)!;
    assert.equal(now.proof, fixed, 'the item reads the plan\'s proof from now on');
    assert.equal(now.state, 'proven');
  } finally { h.cleanup(); }
});

test('DC-5 — an answer file outside the plan\'s handoffs folder is never written; the press is refused with why', async () => {
  const h = harness();
  try {
    mkdirSync(join(h.root, 'docs', 'handoffs', SLUG), { recursive: true });
    const outside = join(h.root, '..', `pc-outside-${process.pid}.md`);
    const step = planDecision(h, `cmd:"grep -qi '^store: answered' ${outside}"`);
    const pressed = await call(h.svc, 'POST', `/api/human-steps/${step.id}/answer`, { option: 'prune' });
    assert.equal(pressed.status, 409, JSON.stringify(pressed.body));
    assert.match(String(pressed.body.error), /is not in the plan's own handoffs folder/);
    assert.equal(existsSync(outside), false);
    assert.notEqual(h.svc.humanStepsNow().get(step.id)!.state, 'proven');
  } finally { h.cleanup(); }
});

test('DC-6 — only the plan\'s own handoffs folder, through no link, and a test -f file is created, never overwritten', async () => {
  const { answerTargetOf, writeAnswer } = await import('../server/turn/answer-target.ts');
  const h = harness();
  try {
    const own = join(h.root, 'docs', 'handoffs', SLUG);
    mkdirSync(own, { recursive: true });
    mkdirSync(join(h.root, 'docs', 'handoffs', 'other'), { recursive: true });
    const answer = { label: 'Prune once' };
    // Another plan's folder, and the plan file itself, are not this plan's answers folder.
    for (const file of [join(h.root, 'docs', 'handoffs', 'other', 'a.md'), join(h.root, 'docs', 'plans', `${SLUG}.md`)]) {
      const target = answerTargetOf(`cmd:"grep -q '^k: answered' ${file}"`)!;
      const wrote = writeAnswer(target, own, h.root, answer);
      assert.equal(wrote.ok, false, file);
    }
    // A link in the answer file's place is refused, never followed.
    const victim = join(h.root, 'docs', 'plans', `${SLUG}.md`);
    const before = readFileSync(victim, 'utf8');
    symlinkSync(victim, join(own, 'linked.md'));
    const linked = writeAnswer(answerTargetOf(`cmd:"grep -q '^k: answered' ${join(own, 'linked.md')}"`)!, own, h.root, answer);
    assert.equal(linked.ok, false);
    assert.match(linked.ok ? '' : linked.why, /is a link/);
    assert.equal(readFileSync(victim, 'utf8'), before, 'the link\'s target is untouched');
    // `test -f` creates the file once and never overwrites it.
    const made = join(own, 'decided.md');
    assert.equal(writeAnswer(answerTargetOf(`cmd:"test -f ${made}"`)!, own, h.root, answer).ok, true);
    assert.match(readFileSync(made, 'utf8'), /^answered — Prune once\n$/);
    const again = writeAnswer(answerTargetOf(`cmd:"test -f ${made}"`)!, own, h.root, { label: 'Other' });
    assert.equal(again.ok, false);
    assert.match(readFileSync(made, 'utf8'), /Prune once/, 'never overwritten');
    // A line is appended after a file that does not end in a newline.
    const lines = join(own, 'answers.md');
    writeFileSync(lines, 'pending');
    assert.equal(writeAnswer(answerTargetOf(`cmd:"grep -q '^store: answered' ${lines}"`)!, own, h.root, answer).ok, true);
    assert.equal(readFileSync(lines, 'utf8'), 'pending\nstore: answered — Prune once\n');
  } finally { h.cleanup(); }
});
