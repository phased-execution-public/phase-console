/**
 * The redaction floor (control-tower phase 41, criterion 5): no code, token,
 * password or URL query secret appears in the LEDGER, a JOURNAL line, a PUSH
 * payload, the LOG or a TRANSCRIPT — five sinks, planted values, scanned.
 *
 * The door (`phase-outcome.sh`) already refuses a secret-shaped flag; this is
 * the floor under it, for a declaration the script never saw — a file an
 * older script or a hand wrote. Every planted value is ASSEMBLED at run time,
 * so no secret-shaped literal sits in the tree for the scrub to find.
 *
 * And the one kind that stores something: a `secret-entry`'s secret goes to
 * the credential registry and appears in none of the five either.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { HumanStepLedger, declareHumanStep, stepJournalFields } = await import('../server/human-steps.ts');
const { readOutcome } = await import('../server/runner/outcome.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { Transcript } = await import('../server/runner/transcript.ts');
const { journalFile, transcriptFile } = await import('../server/runner/run-paths.ts');
const { humanStepPush } = await import('../server/push/catalogue.ts');
const { KIND_META } = await import('../shared/human-step-model.js');
const { log, recent } = await import('../server/log.ts');

const TOKEN = `gh${'p'}_${'T'.repeat(36)}`;
const PASSWORD = `Tr0ub4dor-${'9'.repeat(3)}x`;
const CODE = String(400000 + 93817);
const QUERY_SECRET = `Zq${'8'.repeat(2)}xk2mP0Q`;

/** Every value that must appear in no sink. */
const PLANTED = [TOKEN, PASSWORD, CODE, QUERY_SECRET];

function scan(sink: string, text: string): string[] {
  return PLANTED.filter((value) => text.includes(value)).map((value) => `${sink} holds ${value.slice(0, 6)}…`);
}

test('five sinks, planted values, scanned — none of them holds a code, a token, a password or a URL query secret', () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-redaction-root-'));
  const state = mkdtempSync(join(tmpdir(), 'pc-redaction-state-'));
  try {
    // A declaration nobody screened: every field carries a planted value.
    const declared = {
      version: 1, slug: 'demo', phase: 7, status: 'needs-human', needs: 'credential', watch: [],
      written_at: new Date().toISOString(),
      reason: `the token ${TOKEN} expired`,
      step: {
        kind: 'browser-login',
        title: `sign in — then type ${CODE} and use password=${PASSWORD}`,
        open_url: `https://example.com/callback?access_token=${QUERY_SECRET}&state=ok`,
        open_command: `gh auth login --with-token ${TOKEN}`,
        proof: `cmd:"curl -sf https://example.com/me?token=${QUERY_SECRET}"`,
        lines: [`paste ${TOKEN}`, `the code is ${CODE}`, `Password: ${PASSWORD}`],
      },
    };
    const file = join(state, 'outcome.json');
    writeFileSync(file, JSON.stringify(declared));
    const outcome = readOutcome(file, { slug: 'demo', phase: 7 })!;
    assert.ok(outcome.step, 'the step survives the reader');

    // 1. The LEDGER — and 3. the PUSH payload, captured from the announcer.
    const ledger = new HumanStepLedger(join(state, 'human-steps.ndjson'));
    const payloads: unknown[] = [];
    const step = declareHumanStep({
      ledger,
      announce: (s) => {
        const push = humanStepPush({ ...s, label: KIND_META[s.kind].label });
        payloads.push({ ...push.message, step: push.step });
        return true;
      },
    }, { slug: 'demo', phase: 7, birth: 'session', step: outcome.step, runId: 'aaaaaaaa' })!;
    assert.ok(step);
    log.info('human-steps.redaction-probe', { stepId: step.id, reason: outcome.reason });

    // 2. A JOURNAL line — the step's own, and the declaration's reason beside it.
    const journal = Journal.for(root, 'demo', 'aaaaaaaa');
    journal.append('phase.human-step', stepJournalFields(step), 7);
    journal.append('phase.outcome-needs-human', { reason: outcome.reason ?? null, watch: outcome.watch }, 7);

    // 5. A TRANSCRIPT: the session's own Bash call and a tool's output, as the stream carries them.
    const transcript = new Transcript(root, 'demo', 'aaaaaaaa');
    transcript.append('stream', {
      phase: 7, kind: 'tool_use', name: 'Bash',
      input: { command: `bash phase-outcome.sh demo 7 needs-human --step browser-login --title "type ${CODE}" --open-command "gh auth login --with-token ${TOKEN}"` },
    });
    transcript.append('stream', { phase: 7, kind: 'tool_result', text: `Logged in with token ${TOKEN}; callback https://example.com/cb?code=${QUERY_SECRET}` });
    transcript.append('stream', { phase: 7, kind: 'text', text: `password=${PASSWORD}` });

    const problems = [
      ...scan('the ledger', readFileSync(ledger.file, 'utf8')),
      ...scan('the journal', readFileSync(journalFile(root, 'demo', 'aaaaaaaa'), 'utf8')),
      ...scan('the push payload', JSON.stringify(payloads)),
      ...scan('the log', JSON.stringify(recent(500))),
      ...scan('the transcript', readFileSync(transcriptFile(root, 'demo', 'aaaaaaaa', 7), 'utf8')),
    ];
    assert.deepEqual(problems, []);

    // …and each sink still says what the step IS: redaction removed values, not meaning.
    assert.match(readFileSync(ledger.file, 'utf8'), /\[redacted\]/);
    assert.match(readFileSync(ledger.file, 'utf8'), /access_token=\[redacted\]&state=ok/, 'a URL keeps its parameter names');
    assert.match(JSON.stringify(payloads), /sign in/);
    assert.equal(payloads.length, 1);
    // A count that is not a declaration keeps its digits in a transcript.
    transcript.append('stream', { phase: 7, kind: 'text', text: 'ℹ duration_ms 4566159' });
    assert.match(readFileSync(transcriptFile(root, 'demo', 'aaaaaaaa', 7), 'utf8'), /4566159/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test('a device code is the one code a step shows on purpose — in the push and the ledger, and only on a device-code step', () => {
  const state = mkdtempSync(join(tmpdir(), 'pc-redaction-code-'));
  try {
    const ledger = new HumanStepLedger(join(state, 'human-steps.ndjson'));
    const payloads: unknown[] = [];
    const announce = (s: import('../server/human-steps.ts').HumanStep) => {
      const push = humanStepPush({ ...s, label: KIND_META[s.kind].label });
      payloads.push(push);
      return true;
    };
    declareHumanStep({ ledger, announce }, {
      slug: 'demo', phase: 2, birth: 'session', step: { kind: 'device-code', title: 'Enter the code', code: 'WDJB-MJHT' },
    });
    assert.match(readFileSync(ledger.file, 'utf8'), /WDJB-MJHT/);
    assert.match(JSON.stringify(payloads), /WDJB-MJHT/);
    const before = readFileSync(ledger.file, 'utf8');
    declareHumanStep({ ledger, announce }, {
      slug: 'demo', phase: 2, birth: 'session', step: { kind: 'one-time-code', title: 'Type the code at the prompt', code: CODE },
    });
    assert.doesNotMatch(readFileSync(ledger.file, 'utf8').slice(before.length), new RegExp(CODE), 'a one-time code is never kept');
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test('a secret sent to a secret-entry item reaches no sink at all — refused, never stored (control-tower phase 133)', async () => {
  const { Service } = await import('../server/service.ts');
  const { SKILL_DIR, INSTANCE_STATE_DIR } = await import('../server/config.ts');
  const { handleApi } = await import('../server/api/routes.ts');
  const root = mkdtempSync(join(tmpdir(), 'pc-redaction-secret-'));
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  const svc = new Service({
    port: 0, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
    scriptsDir: join(SKILL_DIR, 'scripts'), logFile: null,
  } as never);
  try {
    svc.push.announce = (() => null) as never;
    assert.equal(svc.open(root).ok, true);
    const secret = `npm_${'S'.repeat(36)}`;
    const step = svc.recordHumanStep({
      slug: 'demo', phase: 3, birth: 'session', step: { kind: 'secret-entry', title: 'Paste the npm token', credential: 'npm-token' },
    });
    assert.ok(step && !('refused' in step));
    let said = '';
    const req = {
      method: 'POST', headers: { 'x-phase-console': '1', host: '127.0.0.1:4130' }, on() { return this; },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ secret })); },
    };
    const res = { req, writeHead() { return this; }, end(chunk: unknown) { said += String(chunk ?? ''); }, on() { return this; } };
    await handleApi({ service: svc } as never, req as never, res as never, new URL(`http://127.0.0.1/api/human-steps/${(step as { id: string }).id}/check`));
    assert.match(said, /never takes a secret/);
    log.info('human-steps.redaction-probe', { stepId: (step as { id: string }).id });
    for (const [sink, text] of [
      ['the answer', said],
      ['the ledger', readFileSync(join(INSTANCE_STATE_DIR, 'human-steps.ndjson'), 'utf8')],
      ['the log', JSON.stringify(recent(500))],
      ['a journal line', JSON.stringify(stepJournalFields(svc.humanStepsNow().get((step as { id: string }).id)!))],
    ] as const) {
      assert.equal(text.includes(secret), false, `${sink} never holds it`);
    }
    const secrets = join(INSTANCE_STATE_DIR, 'secrets');
    assert.ok(!existsSync(secrets) || readdirSync(secrets).length === 0, 'and nothing was stored anywhere');
  } finally {
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a guide, proof words and what was tried never carry a planted value into the ledger or the journal (control-tower phase 130)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turn-redaction-'));
  try {
    const file = join(dir, 'human-steps.ndjson');
    const ledger = new HumanStepLedger(file);
    const guide = `Why.\n\n## Steps\n1. Paste the token\n   \`\`\`sh\n   gh auth login --with-token ${TOKEN}\n   \`\`\`\n`;
    const raised = declareHumanStep({ ledger, announce: () => true }, {
      slug: 'demo', phase: 4, birth: 'session',
      step: {
        kind: 'operator-act', title: `Rotate it, password=${PASSWORD}`, proof_type: 'attest',
        guide: { text: guide }, proof_words: `the code ${CODE} is gone`, tried: `curl https://x.example/cb?code=${QUERY_SECRET}`,
      },
    });
    assert.ok(raised && !('refused' in raised), 'the item is raised — a person’s turn is never lost to a bad field');
    const step = raised as { guide?: unknown; id: string };
    assert.equal(step.guide, undefined, 'a guide that fails the secret screen is dropped, never stored');
    assert.deepEqual(scan('ledger', readFileSync(file, 'utf8')), []);
    assert.deepEqual(scan('journal fields', JSON.stringify(stepJournalFields(raised as never))), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
