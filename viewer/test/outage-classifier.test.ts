/**
 * An outage is not a credential fault.
 *
 * Three measured incidents sit behind this file, and all three are the same
 * mistake made at different depths: the console read a session's PROSE as a
 * verdict about the credential that wrote it.
 *
 *  - a completed phase, with real turns and real spend, was overruled by a
 *    bare error code it quoted in its own handoff, and its whole organisation
 *    was retired for saying so;
 *  - a half-hour of no network was classified as a standing certificate fault,
 *    because the CLI's guess about a corporate proxy was promoted to a verdict;
 *  - the resulting halts were charged to the run's "this plan is broken" bound,
 *    which is a claim about the PLAN and was spent by the weather.
 *
 * ⚠️ The strings this file matches are built by CONCATENATION, never written
 * whole. The classifier under test reads the running session's own output, so
 * a literal here is a trap that arms itself the moment anyone reads the file —
 * which is exactly the failure being fixed. Prose NAMES the tokens; code
 * assembles them.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, WORKED_TURNS, type StopSignal } from '../server/runner/errors.ts';
import { Accounts } from '../server/accounts/index.ts';
import { CREDENTIAL_CLASSES, ORG_SCOPED_CLASSES } from '../shared/ops-vocab.js';
import { DISPOSITION_KINDS } from '../shared/run-lifecycle.js';
import { STATE_SANDBOX } from './state-sandbox.ts';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnClaude } from '../server/runner/spawn.ts';
import { lastWords } from '../server/runner/session-record.ts';

const RUNNER_DIR = fileURLToPath(new URL('../server/runner/', import.meta.url));

/**
 * A facade over a sandboxed registry, with nothing real behind it — and its
 * OWN learned file, because the store is machine-wide by design and two tests
 * sharing one would read each other's organisations.
 */
function makeAccounts(name: string): Accounts {
  return new Accounts({
    platform: 'linux',
    exec: async () => ({ stdout: '' }),
    registryDir: join(STATE_SANDBOX, `reg-${name}`),
    learnedFile: join(STATE_SANDBOX, `learned-${name}.json`),
  });
}

/* ------------------------------------------------------------------ *
 * The vocabulary, assembled — never spelled
 * ------------------------------------------------------------------ */

/** The CLI's own lead-in on an error line. */
const API_ERROR = `API Err${'or'}:`;
/** The CLI's own sentence for a connection it could not make. */
const CANNOT_CONNECT = `Unable to conn${'ect'} to API`;
/** The bare Node code for a certificate signed by nobody the chain trusts. */
const SELF_SIGNED = ['DEPTH', 'ZERO', 'SELF', 'SIGNED', 'CERT'].join('_');
/** The bare Node code for a chain whose leaf cannot be verified. */
const UNVERIFIED_LEAF = ['UNABLE', 'TO', 'VERIFY', 'LEAF', 'SIGNATURE'].join('_');
/** The bare Node code for a name that does not resolve. */
const NO_SUCH_HOST = ['ENOT', 'FOUND'].join('');
/** The bare Node code for a refused socket. */
const REFUSED_SOCKET = ['ECONN', 'REFUSED'].join('');

/** The CLI's certificate line, as measured — framing, the connect sentence, the guess. */
const MEASURED_CERT_LINE =
  `${API_ERROR} ${CANNOT_CONNECT}: Self-sign${'ed'} certificate detected (${SELF_SIGNED}). `
  + 'The certificate comes from an authority Claude Code does not trust, usually a '
  + 'TLS-inspecting corporate proxy.';

/** The same fault with no connect sentence — a standing interception, framed. */
const FRAMED_CERT_LINE = `${API_ERROR} certificate verif${'y'} failed (${UNVERIFIED_LEAF})`;

/** A plain offline stop: the framing plus a Node net code. */
const OFFLINE_LINE = `${API_ERROR} ${CANNOT_CONNECT}: getaddrinfo ${NO_SUCH_HOST} api.anthropic.com`;

/** The expired-login sentence the CLI prints, framed as it prints it. */
const EXPIRED_LOGIN_LINE = `${API_ERROR} 401 ${['oauth', 'token', 'expired'].join(' ')}`;

/** The billing sentence, framed. */
const BILLING_LINE = `${API_ERROR} your credit bal${'ance'} is too low`;

/** The org-refusal sentence, framed. */
const ORG_LINE = `${API_ERROR} 403 — this organizat${'ion'} has been disabled`;

/**
 * Prose a HANDOFF legitimately contains about a NETWORK incident. Every one of
 * these is a sentence a session might write about something it survived, and
 * none of them is a report of this session's own fate. Criterion 2's table.
 */
const CERT_PROSE = [
  // The sentence from the measured handoff, rebuilt.
  `that session died mid-gate on a CLI transport error (${SELF_SIGNED}), which says nothing about the work`,
  `the fix anchors the pattern on the framing rather than matching ${UNVERIFIED_LEAF} anywhere in prose`,
  `phase 3 adds a connectivity pattern for ${NO_SUCH_HOST} and ${REFUSED_SOCKET}`,
  'the test table covers the expired login sentence and the billing sentence',
  'this phase refactors the rate limiter and counts the 401 lines it sees',
];

/**
 * Prose that DOES still trip a credential pattern, because those patterns are
 * looser than this phase changes. That is allowed — what is not allowed is the
 * blast radius: a text match retires ONE credential and never the
 * organisation, whose row is reserved for a verdict the API actually returned.
 */
const ORG_SHAPED_PROSE = [
  'the module under test is the billing error path, which nobody has touched since June',
  'the organization has been disabled case is the one structured verdict that may write the org row',
];

function stop(partial: Partial<StopSignal>): StopSignal {
  return { subtype: 'error_during_execution', code: 1, ...partial };
}

/** A session that finished a real phase: turns booked, dollars spent. */
function worked(text: string, extra: Partial<StopSignal> = {}): StopSignal {
  return { subtype: 'success', code: 0, isError: false, turns: 6, costUsd: 4.12, text, ...extra };
}

/* ------------------------------------------------------------------ *
 * OC-1 — a session that did work is not overruled by what it quotes
 * ------------------------------------------------------------------ */

test('OC-1: a success with real turns and real spend outranks a certificate token in its own prose', () => {
  const said = classify(worked(CERT_PROSE[0]));
  assert.equal(said.kind, 'ok', 'a completed phase writing up an outage is a completed phase');
});

test('OC-1: turns alone are enough, and spend alone is enough', () => {
  assert.equal(classify(worked(CERT_PROSE[0], { turns: WORKED_TURNS, costUsd: 0 })).kind, 'ok');
  assert.equal(classify(worked(CERT_PROSE[0], { turns: 0, costUsd: 0.01 })).kind, 'ok');
});

test('OC-1: the same holds for the framed certificate, auth and billing lines', () => {
  for (const line of [MEASURED_CERT_LINE, FRAMED_CERT_LINE, EXPIRED_LOGIN_LINE, BILLING_LINE, ORG_LINE]) {
    assert.equal(classify(worked(line)).kind, 'ok', `a worked success quoting: ${line.slice(0, 40)}…`);
  }
});

test('OC-1: a structured verdict from the API still outranks a worked success', () => {
  // `retryCategories` is a field the CLI sets deliberately; prose is not.
  const said = classify(worked('nothing unusual in the text', { retryCategories: ['oauth_org_not_allowed'] }));
  assert.equal(said.kind, 'credential-refused');
  assert.equal(said.kind === 'credential-refused' && said.class, 'org-policy');
});

test("OC-1: a success the CLI itself marked erroneous is not a worked success", () => {
  // Since control-tower phase 54 (#57) the line has to arrive on the CLI's
  // API-error channel to be a verdict: a session that WORKED wrote prose, and
  // its result text is that prose. On the channel, the erroneous success is
  // still no success.
  const said = classify(worked('the session\'s own last words', { isError: true, apiText: EXPIRED_LOGIN_LINE }));
  assert.equal(said.kind, 'credential-refused');
  // …and the same line in the result text alone is narration, whatever ended the session.
  assert.notEqual(classify(worked(EXPIRED_LOGIN_LINE, { isError: true })).kind, 'credential-refused');
});

/* ------------------------------------------------------------------ *
 * OC-2 — the case the ordering was built for still works
 * ------------------------------------------------------------------ */

test('OC-2: the one-turn, zero-dollar expired-login session is still credential-refused', () => {
  const said = classify({ subtype: 'success', code: 0, isError: false, turns: 1, costUsd: 0, text: EXPIRED_LOGIN_LINE });
  assert.equal(said.kind, 'credential-refused');
  assert.equal(said.kind === 'credential-refused' && said.class, 'auth');
});

test('OC-2: a session that reported success having booked nothing at all is still judged on its text', () => {
  const said = classify({ subtype: 'success', code: 0, isError: false, text: BILLING_LINE });
  assert.equal(said.kind, 'credential-refused', 'no turns and no cost recorded is not evidence of work');
  assert.equal(said.kind === 'credential-refused' && said.class, 'billing');
});

/* ------------------------------------------------------------------ *
 * OC-3 — an outage has a name now, and it is checked first
 * ------------------------------------------------------------------ */

test('OC-3: a plain offline stop classifies connectivity, not a credential fault', () => {
  const said = classify(stop({ text: OFFLINE_LINE }));
  assert.equal(said.kind, 'connectivity');
  assert.equal(said.kind === 'connectivity' && said.class, undefined, 'nothing about a credential');
});

test('OC-3: the measured certificate-shaped connect failure classifies connectivity on first sighting', () => {
  const said = classify(stop({ text: MEASURED_CERT_LINE }));
  assert.equal(said.kind, 'connectivity', 'the connect sentence is read before the CLI’s guess about a proxy');
  assert.equal(said.kind === 'connectivity' && said.class, 'certificate', 'certificate-shaped: worth corroborating');
});

test('OC-3: a framed certificate fault with no connect sentence is still a credential class', () => {
  const said = classify(stop({ text: FRAMED_CERT_LINE }));
  assert.equal(said.kind, 'credential-refused');
  assert.equal(said.kind === 'credential-refused' && said.class, 'certificate');
});

test('OC-3: connectivity is a disposition kind the vocabulary owner knows', () => {
  assert.ok(DISPOSITION_KINDS.includes('connectivity'));
  assert.ok(DISPOSITION_KINDS.includes('credential-refused'), 'the kind the runner has acted on since 5.0.0');
});

/* ------------------------------------------------------------------ *
 * OC-6 — one place charges the streak
 * ------------------------------------------------------------------ */

test('OC-6: the streak is RAISED in exactly one place in the runner, and it is chargeFailure()', () => {
  // Comments are stripped first: this directory documents the counter heavily,
  // and a scan that reads its own prose as code would be exactly the mistake
  // the rest of this file is about.
  const raises: string[] = [];
  for (const name of readdirSync(RUNNER_DIR)) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(join(RUNNER_DIR, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, '');
    source.split('\n').forEach((line, index) => {
      // Every write that could make the counter LARGER. `= 0` is a reset and
      // there are several legitimate ones (a clean phase, a person's press).
      if (!/consecutiveFailures\s*(?:\+\+|\+=|=(?!=))/.test(line)) return;
      if (/consecutiveFailures\s*=\s*0\s*;/.test(line)) return;
      raises.push(`${name}:${index + 1}`);
    });
  }
  assert.equal(raises.length, 1, `exactly one raise, found: ${raises.join(', ')}`);
  assert.match(raises[0], /^runner-control\.ts:/, 'and it lives with chargeFailure()');

  // …and that one line really is inside `chargeFailure`.
  const control = readFileSync(join(RUNNER_DIR, 'runner-control.ts'), 'utf8').split('\n');
  const raisedAt = Number(raises[0].split(':')[1]) - 1;
  const owner = control.slice(0, raisedAt).reverse().find((line) => /^\s{2}(?:protected|private|public)?\s*\w+\(/.test(line));
  assert.match(owner ?? '', /chargeFailure/, 'the raise belongs to chargeFailure()');
});

/* ------------------------------------------------------------------ *
 * OC-9 — the prose table, on the FAILURE arm
 * ------------------------------------------------------------------ */

test('OC-9: the network-prose table refuses no credential and names no outage, on the failure arm', () => {
  for (const sentence of CERT_PROSE) {
    const said = classify(stop({ text: sentence }));
    assert.notEqual(said.kind, 'credential-refused', `prose must not refuse a credential: ${sentence.slice(0, 48)}…`);
    assert.notEqual(said.kind, 'connectivity', `prose must not read as an outage: ${sentence.slice(0, 48)}…`);
  }
});

test('OC-9: a FAILED attempt whose text merely matches an org or billing pattern leaves the org row untouched and retires only that credential', async () => {
  const accounts = makeAccounts('prose');
  const a = await accounts.addToken('prose-a', 'sk-ant-oat01-prosea000000000000');
  const b = await accounts.addToken('prose-b', 'sk-ant-oat01-proseb000000000000');
  // Both logins report the same organisation — the shape whose blast radius
  // took out seven accounts across two organisations and both consoles.
  accounts.noteAuthProbe(a.id, { loggedIn: true, orgId: 'org-shared', checkedAt: '' });
  accounts.noteAuthProbe(b.id, { loggedIn: true, orgId: 'org-shared', checkedAt: '' });

  for (const sentence of ORG_SHAPED_PROSE) {
    const said = classify(stop({ text: sentence }));
    assert.equal(said.kind, 'credential-refused', 'these ones do still classify — that is not what is being fixed');
    // What the runner does with it: the class, and NO structured verdict.
    accounts.leaveAccount(a.id, {
      kind: 'credential', reason: said.kind === 'credential-refused' ? said.reason : '', by: 'classifier',
      ...(said.kind === 'credential-refused' ? { class: said.class } : {}),
    });
    assert.deepEqual(accounts.learned.snapshot().orgs, {}, `no org row from: ${sentence.slice(0, 48)}…`);
    assert.notEqual(accounts.entitlementOf(b.id).state, 'retired', 'the sibling account is untouched');
    accounts.clearRetired(a.id);
  }

  // And the structured verdict — the one the API actually returned — still does.
  accounts.leaveAccount(a.id, {
    kind: 'credential', reason: 'organization policy blocks this credential', by: 'classifier',
    class: 'org-policy', structured: true,
  });
  assert.notDeepEqual(accounts.learned.snapshot().orgs, {}, 'a structured org verdict is exactly what the org row is for');
  assert.equal(accounts.entitlementOf(b.id).state, 'retired', 'and it does reach the sibling');

  await accounts.remove(a.id);
  await accounts.remove(b.id);
  accounts.stop();
});

test('OC-9: a certificate refusal never writes the org row, structured or not', async () => {
  const accounts = makeAccounts('cert');
  const a = await accounts.addToken('cert-a', 'sk-ant-oat01-certa0000000000000');
  accounts.noteAuthProbe(a.id, { loggedIn: true, orgId: 'org-cert', checkedAt: '' });
  accounts.leaveAccount(a.id, {
    kind: 'credential', reason: 'a certificate this machine does not trust', by: 'classifier',
    class: 'certificate', structured: true,
  });
  assert.deepEqual(accounts.learned.snapshot().orgs, {}, 'a certificate is a property of the network path');
  await accounts.remove(a.id);
  accounts.stop();
});

test('OC-9: only an organisation-scoped class may ever reach the org row, and it is a subset of the classes', () => {
  for (const cls of ORG_SCOPED_CLASSES) {
    assert.ok(CREDENTIAL_CLASSES.includes(cls), `${cls} is a credential class`);
  }
  assert.ok(ORG_SCOPED_CLASSES.includes('org-policy'));
  assert.ok(!ORG_SCOPED_CLASSES.includes('certificate'), 'a certificate is a property of the network path');
  assert.ok(!ORG_SCOPED_CLASSES.includes('auth'), 'one expired login says nothing about its organisation');
});

/* ------------------------------------------------------------------ *
 * OC-10 / OC-11 — an outage is remembered by what the session said
 * (control-tower phase 80, #108)
 *
 * The measured outage left four lanes whose `said` was the CLI's
 * could-not-reach sentence, so the one account of what each session had been
 * doing when it was cut off was the one thing it never wrote.
 * ------------------------------------------------------------------ */

/** A `claude` on PATH that prints the NDJSON lines it is handed, then exits. */
function fakeCli(lines: unknown[]): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-outage-words-'));
  writeFileSync(join(dir, 'lines.json'), JSON.stringify(lines));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
for (const line of JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'lines.json'))}, 'utf8'))) process.stdout.write(JSON.stringify(line) + '\\n');
process.stdin.resume();
setTimeout(() => process.exit(1), 30);
`, 'utf8');
  chmodSync(bin, 0o755);
  return { dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SID = '80808080-0000-4000-8000-000000000108';
const OWN_WORDS = 'The migration is in and its tests pass; the landing is next.';
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', session_id: SID, parent_tool_use_id: null,
  message: { id: `msg_${text.length}`, role: 'assistant', content: [{ type: 'text', text }] }, ...extra,
});

test('OC-10: the stream keeps the session\'s own last prose apart from the API\'s words — a subagent\'s line and the CLI\'s error are not it', async () => {
  const cli = fakeCli([
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', tools: [] },
    assistant(OWN_WORDS),
    { ...assistant('A subagent reporting back.'), parent_tool_use_id: 'toolu_sub' },
    assistant(MEASURED_CERT_LINE, { is_api_error_message: true }),
    { type: 'result', subtype: 'error_during_execution', session_id: SID, is_error: true, num_turns: 41,
      total_cost_usd: 6.2, result: MEASURED_CERT_LINE },
  ]);
  try {
    const outcome = await spawnClaude({ prompt: 'BOOT phase 21', cwd: cli.dir, env: cli.env });
    assert.equal(outcome.lastText, OWN_WORDS, 'the phase\'s own conversation, before the network went');
    assert.equal(classify(outcome.signal).kind, 'connectivity', 'a session that worked and then lost the API is an outage');
    const words = lastWords(outcome);
    assert.equal(words.said, OWN_WORDS);
    assert.equal(words.transportError, MEASURED_CERT_LINE);
  } finally {
    cli.cleanup();
  }
});

test('OC-11: lastWords keeps a result that is the session\'s own, and never promotes the network\'s sentence to it', () => {
  assert.deepEqual(lastWords({ resultText: 'Phase 21 is complete.', lastText: 'Writing the handoff.' }),
    { said: 'Phase 21 is complete.' }, 'a normal ending is remembered by its result, as before');
  assert.deepEqual(lastWords({ resultText: OFFLINE_LINE, lastText: OWN_WORDS }),
    { said: OWN_WORDS, transportError: OFFLINE_LINE });
  assert.deepEqual(lastWords({ resultText: OFFLINE_LINE }), { said: '', transportError: OFFLINE_LINE },
    'a session that wrote nothing of its own said nothing — the error is named, not quoted as its words');
  assert.deepEqual(lastWords({ resultText: OFFLINE_LINE, lastText: MEASURED_CERT_LINE }),
    { said: '', transportError: OFFLINE_LINE }, 'the network\'s sentence is never the session\'s words, wherever it arrived');
});

/* ------------------------------------------------------------------ *
 * OC-12 — an auth refusal names what it may be (control-tower phase 91, #131)
 * ------------------------------------------------------------------ */

test('OC-12 (#131): an auth refusal is not asserted to be a lapse — the sentence names a login signed in as somebody else too, and the runner says which', () => {
  const said = classify(stop({ retryCategories: ['authentication_failed'] }));
  assert.equal(said.kind, 'credential-refused');
  const reason = said.kind === 'credential-refused' ? said.reason : '';
  assert.doesNotMatch(reason, new RegExp(['is', 'expired', 'or', 'signed', 'out'].join(' ')), 'the classifier cannot know which it was');
  assert.match(reason, /signed in as somebody else/);
  // The prose road reads the same sentence as the structured one.
  const prose = classify({ subtype: 'success', code: 0, isError: false, turns: 1, costUsd: 0, text: EXPIRED_LOGIN_LINE });
  assert.equal(prose.kind === 'credential-refused' && prose.reason, reason);
});
