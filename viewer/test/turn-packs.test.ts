/**
 * The packs' words into Your turn (measured-console phase 29, §Architecture 6 D7):
 *
 *   TP-1  gstack's `GSTACK_RESULT` line — every line read, quoted or bare; the
 *         run at its gate is the LAST line saying `gate_pending`
 *   TP-2  gstack's run `decisions.jsonl` — the pending approvals of the newest
 *         gate, in file order, each option in `gate.json`'s words
 *   TP-3  a questionnaire (`to-questionnaire`'s shape) — each `###` question,
 *         its lettered choices the options, the `(recommended)` one marked
 *   TP-4  the prose-question rule's trigger — the questions a message ENDS on,
 *         each with the answer it recommended; prose after them, a fence or
 *         closing courtesy raise nothing
 *   TP-5  exit criterion 2, through the real Runner: a session whose last
 *         message ends in two questions and declares no outcome parks on ONE
 *         Decision item (birth console) with two options, the recommended one
 *         marked, journalled `phase.prose-question`
 *   TP-6  exit criterion 3: a wizard-shaped guide file is a Task guide — one
 *         step per stage with its commands; each secret says where it goes
 *         (`gh secret set`, the env file, the keychain) and is never a field
 *   TP-7  the gate as the runner reads it: a result line whose run directory
 *         holds a pending approval is an Approval; one with none, a Decision
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  closingAskOf, closingQuestionsOf, gatePendingOf, gstackResultsOf, guideFromWizard, isWizardScript, pendingApprovalsOf,
  questionnaireOf, readGstackRun, wizardStagesOf,
} = await import('../server/turn/packs.ts');
const { readGuideFile } = await import('../server/turn/guide-file.ts');
const { composeItem } = await import('../server/turn/compose.ts');
const { HumanStepLedger, declareHumanStep } = await import('../server/human-steps.ts');
const { Runner } = await import('../server/runner/runner.ts');
const { journalFile } = await import('../server/runner/state.ts');
const { stubRepo, FREE_LOCK_SH, VALIDATE_OK_SH } = await import('./fixtures/repo.ts');
type SpawnFn = import('../server/runner/spawn.ts').SpawnFn;
type HumanStep = import('../server/human-steps.ts').HumanStep;

const PACKS = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packs');
const fixture = (name: string): string => readFileSync(join(PACKS, name), 'utf8');

/* ------------------------------------------------------------------ *
 * TP-1 — the result line
 * ------------------------------------------------------------------ */

test('TP-1: every GSTACK_RESULT line is read, quoted or bare; the gate is the LAST line at gate_pending', () => {
  const text = [
    'GSTACK_RESULT: skill=autoplan status=awaiting_result run=/tmp/run-1',
    '- `GSTACK_RESULT: skill=autoplan status=gate_pending run=/tmp/run-1`',
    'GSTACK_RESULT: skill=autoplan status=gate_pending',
  ].join('\n');
  assert.deepEqual(gstackResultsOf(text), [
    { skill: 'autoplan', status: 'awaiting_result', run: '/tmp/run-1' },
    { skill: 'autoplan', status: 'gate_pending', run: '/tmp/run-1' },
  ], 'a line missing a key is not the line');
  assert.deepEqual(gatePendingOf(text), { skill: 'autoplan', status: 'gate_pending', run: '/tmp/run-1' });
  assert.equal(gatePendingOf(`${text}\nGSTACK_RESULT: skill=autoplan status=complete run=/tmp/run-1`), null, 'a later complete closes the gate');
  assert.equal(gatePendingOf('GSTACK_RESULT: skill=ship-queue status=refused run=none'), null);
  assert.equal(gatePendingOf('no result here'), null);
});

/* ------------------------------------------------------------------ *
 * TP-2 — decisions.jsonl
 * ------------------------------------------------------------------ */

test('TP-2: the pending approvals of the newest gate, each option in gate.json\'s words — auto, user challenges, answered rows and an older gate are not', () => {
  const approvals = pendingApprovalsOf(fixture('decisions.jsonl'), fixture('gate.json'));
  assert.equal(approvals.length, 1);
  const [p1] = approvals;
  assert.equal(p1!.id, 'run-1-r2-p1');
  assert.equal(p1!.label, 'P1');
  assert.equal(p1!.gateRev, 2);
  assert.equal(p1!.recommended, 'b');
  assert.deepEqual(p1!.options.map((o) => o.text), [
    'approve as-is', 'approve with the recommended changes', 'interrogate (ask questions; stays pending)', 'rerun every phase', 'reject',
  ]);
  // Without gate.json the options are their keys.
  assert.deepEqual(pendingApprovalsOf(fixture('decisions.jsonl'))[0]!.options.map((o) => o.text), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(pendingApprovalsOf(''), []);
});

test('TP-2: the run directory is read only where the line names an absolute one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-gstack-run-'));
  try {
    copyFileSync(join(PACKS, 'decisions.jsonl'), join(dir, 'decisions.jsonl'));
    copyFileSync(join(PACKS, 'gate.json'), join(dir, 'gate.json'));
    assert.equal(readGstackRun(dir)[0]?.options[1]?.text, 'approve with the recommended changes');
    assert.deepEqual(readGstackRun('relative/run'), [], 'a relative run is the session\'s cwd — never guessed');
    assert.deepEqual(readGstackRun(join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * TP-3 — the questionnaire
 * ------------------------------------------------------------------ */

test('TP-3: a questionnaire\'s questions — the lettered choices are the options, the recommended one marked', () => {
  const questions = questionnaireOf(fixture('questionnaire.md'));
  assert.deepEqual(questions, [
    {
      question: 'Which file format should the export use?', recommended: 'CSV, one row per invoice',
      choices: [{ label: 'CSV, one row per invoice', recommended: true }, { label: 'XLSX with a sheet per month' }],
    },
    { question: 'Who should receive the monthly file?', choices: [] },
  ]);
  // Two marked choices recommend nothing.
  const twice = questionnaireOf('### Which?\n- A) one (recommended)\n- B) two (Recommended)\n');
  assert.equal(twice[0]!.recommended, undefined);
  assert.ok(twice[0]!.choices.every((c) => !c.recommended));
});

/* ------------------------------------------------------------------ *
 * TP-4 — the trigger
 * ------------------------------------------------------------------ */

test('TP-4: the questions a message ENDS on, each with the answer it recommended', () => {
  assert.deepEqual(closingQuestionsOf(fixture('closing-two-questions.md')), [
    { question: 'Should the old `/export` endpoint stay for one release?', recommended: 'keeping it', choices: [] },
    { question: 'Should the migration run now?', recommended: 'yes, behind the flag', choices: [] },
  ]);
  // gstack's own ask shape: a question with lettered choices, one recommended.
  assert.deepEqual(closingQuestionsOf('Which region should it use?\n- A) eu (recommended when the data is EU)\n- B) us\n'), [
    { question: 'Which region should it use?', recommended: 'eu', choices: [{ label: 'eu', recommended: true }, { label: 'us' }] },
  ]);
  // On the same line, after the mark: "…? (Recommended: …)".
  assert.equal(closingQuestionsOf('Ship it today? (Recommended: yes)')[0]?.recommended, 'yes');
});

test('TP-4: prose after the question, a closing fence, courtesy or a question mid-message raise nothing', () => {
  assert.deepEqual(closingQuestionsOf('Should I ship it?\n\nI went ahead and shipped it.'), []);
  assert.deepEqual(closingQuestionsOf('Is this right?\n```sh\nnpm test\n```'), []);
  assert.deepEqual(closingQuestionsOf('All done. Let me know if you have any questions?'), []);
  assert.deepEqual(closingQuestionsOf('Why did it fail? The lock was stale. I cleared it and the phase is green.'), []);
  assert.deepEqual(closingQuestionsOf(''), []);
});

/* ------------------------------------------------------------------ *
 * TP-5 — exit criterion 2, through the real Runner
 * ------------------------------------------------------------------ */

const ENGINE_SH = `#!/usr/bin/env bash
set -u
slug="$1"; shift
mode="\${1:-}"; arg="\${2:-}"
case "$mode" in
  --memory-block) printf 'done: \\nin-progress: \\nstuck: \\nready: 1\\nwaiting: \\n' ;;
  --gate-status) echo "clear (no gate)" ;;
  --boot-prompt) echo "BOOT phase $arg of $slug" ;;
  --size) echo M ;;
  --qa-history) exit 0 ;;
  *) echo "unsupported stub mode: $mode" >&2; exit 2 ;;
esac
`;

async function closeOn(said: string): Promise<{ steps: HumanStep[]; announced: HumanStep[]; status: string | undefined; events: { event: string; data: Record<string, unknown> }[] }> {
  const r = stubRepo({ prefix: 'pc-prose-question-', scripts: { 'phase-graph.sh': ENGINE_SH, 'phase-lock.sh': FREE_LOCK_SH, 'validate.sh': VALIDATE_OK_SH } });
  const ledger = new HumanStepLedger(join(r.state, 'human-steps.ndjson'));
  const announced: HumanStep[] = [];
  // The session writes no outcome file: it ends on its words alone.
  const spawn: SpawnFn = async () => ({
    signal: { subtype: 'success', code: 0, text: '' }, sessionId: 'sess-closing', costUsd: 0, turns: 3,
    resultText: said, durationMs: 1, argv: ['-p', '<prompt>'],
  }) as never;
  const runner = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    humanStep: (input) => declareHumanStep({ ledger, announce: (step) => { announced.push(step); return true; } }, input),
  });
  try {
    await runner.start({ slug: 'demo', root: r.root, onlyPhases: [1], autonomy: 'keep-going', autoRecover: false } as never);
    await runner.wait();
    const state = runner.current()!;
    const events = readFileSync(journalFile(r.root, 'demo', state.id), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return { steps: ledger.all(), announced, status: state.phases['1']?.status, events };
  } finally {
    runner.close();
    r.cleanup();
  }
}

test('TP-5: a session that ends on two questions and declares nothing parks on ONE Decision item — two options, the recommended one marked', async () => {
  const { steps, announced, status, events } = await closeOn(fixture('closing-two-questions.md'));
  assert.equal(status, 'parked', 'the phase waits on a person');
  assert.equal(steps.length, 1, 'ONE item');
  const [step] = steps;
  assert.equal(step!.kind, 'decision');
  assert.equal(step!.birth, 'console', 'the console read it — the session never declared it');
  assert.deepEqual(step!.source, { kind: 'prose-question', ref: 'sess-closing' });
  assert.equal(step!.title, 'Answer the 2 questions the session ended on');
  assert.deepEqual(step!.options?.map((o) => [o.id, o.recommended ?? false]), [['recommended', true], ['my-answers', false]]);
  assert.match(String(step!.lines?.[0]), /Should the old `\/export` endpoint stay for one release\? — the session recommends: keeping it/);
  assert.match(String(step!.lines?.[1]), /Should the migration run now\? — the session recommends: yes, behind the flag/);
  assert.equal(announced.length, 1, 'ONE push');
  const asked = events.filter((e) => e.event === 'phase.prose-question');
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0]!.data, title: undefined }, { questions: 2, recommended: 2, options: 2, title: undefined });
  // The composer's card: a Decision whose recommended option is marked once.
  const card = composeItem({ source: 'session', record: 'ledger', kind: 'decision', proofType: 'answer', why: 'decision', slug: 'demo', phase: 1, step: step as never, now: Date.now() });
  assert.equal(card.options.filter((o) => o.recommended).map((o) => o.id).join(), 'recommended');
  assert.ok(card.steps.length >= 1 && /\.$/.test(card.check));
});

test('TP-5: a session that ends on prose raises nothing, and the old road holds', async () => {
  const { steps, events } = await closeOn('I wrote the reader and its tests. The handoff is next.');
  assert.equal(steps.length, 0);
  assert.equal(events.filter((e) => e.event === 'phase.prose-question').length, 0);
});

/* ------------------------------------------------------------------ *
 * TP-6 — exit criterion 3, the wizard's Task guide
 * ------------------------------------------------------------------ */

test('TP-6: a wizard-shaped guide file is a Task guide: a step per stage with its commands, each secret hidden and said by where it goes', () => {
  const text = fixture('wizard.sh');
  assert.ok(isWizardScript(text));
  const wizard = wizardStagesOf(text);
  assert.equal(wizard.title, 'Deploy setup');
  assert.equal(wizard.envFile, '.env.local');
  assert.deepEqual(wizard.stages.map((s) => s.name), ['Vercel: project id', 'Vercel: deploy token', 'Signing key passphrase']);

  const root = mkdtempSync(join(tmpdir(), 'pc-wizard-guide-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'deploy-wizard.sh'), text);
    const read = readGuideFile(root, 'scripts/deploy-wizard.sh');
    assert.ok(read.ok, read.ok ? '' : read.why);
    const guide = read.ok ? read.guide : null!;
    assert.equal(guide.steps.length, 4, 'the wizard itself, then one step per stage');
    assert.equal(guide.steps[0]!.code, 'bash scripts/deploy-wizard.sh');
    const [, id, token, passphrase] = guide.steps;
    assert.match(id!.text, /^Stage 1 of 3 · Vercel: project id\./);
    assert.match(id!.text, /it is not secret, and goes to \.env\.local as VERCEL_PROJECT_ID/);
    assert.equal(id!.code, 'open https://vercel.com/acme/web/settings');
    assert.equal(id!.warn, undefined, 'no secret, no warning');
    // The deploy token: hidden, and where it goes — the env file and the GitHub secret.
    assert.match(token!.text, /a secret: it goes to \.env\.local as VERCEL_TOKEN, which the wizard writes from its hidden prompt, and to the repository's GitHub secret VERCEL_TOKEN/);
    assert.deepEqual(token!.code!.split('\n'), ['open https://vercel.com/account/tokens', 'gh secret set VERCEL_TOKEN', 'gh variable set VERCEL_ORG']);
    assert.match(String(token!.warn), /only at a hidden prompt — never in Phase Console/);
    // Captured and written nowhere: the keychain, by name.
    assert.match(passphrase!.text, /it goes to the login keychain as SIGNING_PASSPHRASE/);
    assert.match(String(passphrase!.code), /^security add-generic-password -a "\$USER" -s SIGNING_PASSPHRASE -w$/);
    assert.match(String(passphrase!.expect), /Store it now\?/);

    // As a Task card: the guide's steps, and no field anywhere on it.
    const card = composeItem({
      source: 'plan', record: 'ledger', kind: 'operator-act', proofType: 'attest', why: 'reserved', slug: 'demo', phase: 2,
      step: { title: 'Set up the deploy', guide, guideFrom: 'guide' }, now: Date.now(),
    });
    assert.equal(card.stepsFrom, 'guide');
    assert.equal(card.steps.length, 4);
    assert.deepEqual(card.options, [], 'no option takes a value');
    assert.ok(card.steps.every((s) => !('field' in s)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TP-6: a wizard with a secret-shaped value in it is refused by the grammar\'s screen, never echoed', () => {
  const planted = fixture('wizard.sh').replace('step "Copy the Project ID under General."', 'step "Use ghp_0123456789abcdefghijABCDEFGHIJ0123456789 as the token."');
  const read = guideFromWizard(planted, 'scripts/w.sh');
  assert.equal(read.ok, false);
  assert.doesNotMatch(read.ok ? '' : read.error, /ghp_/);
  assert.equal(guideFromWizard('#!/usr/bin/env bash\necho hi\n', 'x.sh').ok, false);
});

/* ------------------------------------------------------------------ *
 * TP-7 — the gate, as the runner reads it
 * ------------------------------------------------------------------ */

test('TP-7: a gate with a pending approval is ONE Approval in gstack\'s words; a gate with none is a Decision on the gate', () => {
  const text = fixture('closing-gstack-gate.md').replace('RUN_DIR', '/tmp/run-1');
  const approval = closingAskOf(text, { ref: 's', readRun: () => pendingApprovalsOf(fixture('decisions.jsonl'), fixture('gate.json')) })!;
  assert.equal(approval.event, 'phase.pack-item');
  assert.equal(approval.step.kind, 'person-check');
  assert.equal(approval.step.title, 'Approve P1 of the autoplan run: The plan for the billing export');
  assert.equal(approval.step.recommended, 'b');
  assert.deepEqual(approval.step.options.map((o) => o.label), [
    'Approve as-is', 'Approve with the recommended changes', 'Interrogate (ask questions; stays pending)', 'Rerun every phase', 'Reject',
  ]);
  assert.deepEqual(approval.step.source, { kind: 'pack', ref: 'gstack:run-1-r2-p1' });

  const gate = closingAskOf(text, { ref: 's', readRun: () => [] })!;
  assert.equal(gate.step.kind, 'decision');
  assert.equal(gate.step.title, 'Answer the gate the autoplan run stopped at');
  assert.deepEqual(gate.step.options.map((o) => o.id), ['rec', 'walk']);
  assert.equal(gate.step.recommended, 'rec');
  // The gate outranks the prose: a message ending on the result line is the gate's.
  assert.equal(closingAskOf(`${text}\nShould I answer it for you?`, { ref: 's', readRun: () => [] })?.event, 'phase.pack-item');
  assert.equal(closingAskOf('Nothing to ask.', { ref: 's' }), null);
});
