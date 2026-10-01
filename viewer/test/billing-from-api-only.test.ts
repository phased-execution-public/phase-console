/**
 * A credential is retired on a verdict the API gave, never on words a session
 * happened to print (control-tower phase 54, #57).
 *
 * Measured: a phase building an app's purchase flow quoted its own test
 * fixtures — the HTTP 402 title and a "not enough credits" sentence — and the
 * console read its result text with the billing pattern, returned a
 * credential refusal and retired the whole organisation. The transcript held
 * no API error at all. Phase 3 made a WORKED success outrank prose; this closes
 * the same channel for a session that FAILED.
 *
 * ⚠️ Every product word below is built by CONCATENATION and named, never
 * spelled, in prose. This file is what a session reading it would print, and
 * until phase 57's restart the console running this plan still reads a failed
 * session's prose (the plan's narrowed prose-token rule).
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classify, structuredRefusal, type StopSignal } from '../server/runner/errors.ts';
import { spawnClaude, type SpawnFn, type SpawnOutcome } from '../server/runner/spawn.ts';
import { Runner } from '../server/runner/runner.ts';
import type { LeaveReason, LeaveResult } from '../server/accounts/index.ts';

/* The words, assembled — the billing sentence, the 402 title, the credits line, the auth sentences. */
const PAY_TITLE = ['Pay', 'ment Req', 'uired'].join('');
const CREDITS = ['insuff', 'icient cre', 'dits'].join('');
const BALANCE = ['Credit bal', 'ance is too low'].join('');
const AUTH = ['Failed to auth', 'enticate: OAuth session exp', 'ired'].join('');
const LOGIN = ['Please run /lo', 'gin'].join('');
const ORG = ['Your organiz', 'ation has been dis', 'abled'].join('');

/** The #57 shape: a session that worked for a while, then failed, having quoted its fixtures. */
const PURCHASE_FLOW_PROSE = [
  "Added the checkout guard: the API answers `{ title: '" + PAY_TITLE + "', status: 402 }` and the page shows",
  `"${CREDITS}" to the buyer. ${BALANCE} is the copy for the empty wallet; ${LOGIN} is the auth banner,`,
  `${AUTH} the refresh test, and ${ORG} the admin fixture.`,
].join('\n');

function worked(partial: Partial<StopSignal>): StopSignal {
  return { turns: 41, costUsd: 6.2, ...partial };
}

/* ------------------------------------------------------------------ *
 * BA-1 — a FAILED session's prose retires nothing
 * ------------------------------------------------------------------ */

test('BA-1: the #57 shape — a failed session whose result text quotes the product words is no credential verdict', () => {
  const shapes: StopSignal[] = [
    worked({ subtype: 'error_max_turns', text: PURCHASE_FLOW_PROSE }),
    worked({ subtype: 'error_during_execution', code: 1, text: PURCHASE_FLOW_PROSE }),
    worked({ subtype: 'success', isError: true, text: PURCHASE_FLOW_PROSE }),
    worked({ subtype: 'success', terminalReason: 'aborted_tools', text: PURCHASE_FLOW_PROSE }),
    worked({ code: 1, text: PURCHASE_FLOW_PROSE }),
    // Real turns and no dollar figure reported: the prose is still the model's.
    { turns: 12, subtype: 'error_during_execution', code: 1, text: PURCHASE_FLOW_PROSE },
    // …and dollars with a single booked turn: the model wrote it and was paid for it.
    { turns: 1, costUsd: 0.4, subtype: 'success', isError: true, text: PURCHASE_FLOW_PROSE },
  ];
  for (const signal of shapes) {
    const d = classify(signal);
    assert.notEqual(d.kind, 'credential-refused', JSON.stringify({ subtype: signal.subtype, code: signal.code }));
  }
  // The max-turns one is exactly what it was before the words were read: a resume.
  assert.equal(classify(shapes[0]).kind, 'resume');
});

test('BA-1: the org-policy sentence in prose is narration too — the same channel, the same rule', () => {
  const d = classify(worked({ subtype: 'error_during_execution', code: 1, text: `the admin page renders "${ORG}"` }));
  assert.notEqual(d.kind, 'credential-refused');
});

/* ------------------------------------------------------------------ *
 * BA-2 — the stream keeps its channels apart
 * ------------------------------------------------------------------ */

type Bench = { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void };

/** A `claude` on PATH that prints the NDJSON lines it is handed, then the stderr, then exits. */
function bench(lines: unknown[], stderr = '', code = 1): Bench {
  const dir = mkdtempSync(join(tmpdir(), 'pc-api-only-'));
  const script = join(dir, 'lines.json');
  writeFileSync(script, JSON.stringify(lines));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
for (const line of JSON.parse(fs.readFileSync(${JSON.stringify(script)}, 'utf8'))) process.stdout.write(JSON.stringify(line) + '\\n');
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
process.stdin.resume();
setTimeout(() => process.exit(${code}), 30);
`, 'utf8');
  chmodSync(bin, 0o755);
  return {
    dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SID = '54545454-0000-4000-8000-000000000057';
const init = { type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', tools: [] };
const said = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', session_id: SID, parent_tool_use_id: null,
  message: { id: `msg_${text.length}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, ...extra,
});

test('BA-2: assistant text and tool output never reach the API channel — the classifier cannot retire on them', async () => {
  const b = bench([
    init,
    said(PURCHASE_FLOW_PROSE),
    { type: 'assistant', session_id: SID, parent_tool_use_id: null, message: { id: 'msg_tool', role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', session_id: SID, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: `✓ renders ${PAY_TITLE} (402)\n✓ ${BALANCE}` }] } },
    { type: 'result', subtype: 'error_max_turns', session_id: SID, is_error: true, num_turns: 41, total_cost_usd: 6.2,
      result: PURCHASE_FLOW_PROSE },
  ]);
  try {
    const outcome = await spawnClaude({ prompt: 'BOOT phase 23', cwd: b.dir, env: b.env });
    assert.match(outcome.signal.text ?? '', /checkout guard/, 'the result text still reaches `text` — the limit patterns read it');
    assert.equal(outcome.signal.apiText ?? '', '', 'nothing the model wrote or a tool printed is on the API channel');
    assert.deepEqual(outcome.signal.apiErrors ?? [], []);
    assert.notEqual(classify(outcome.signal).kind, 'credential-refused');
  } finally { b.cleanup(); }
});

test('BA-2: an assistant message the CLI flags as an API error IS the channel — its kind and its words', async () => {
  const b = bench([
    init,
    said('Looking at the checkout module now.'),
    said(BALANCE, { error: 'billing_error' }),
    { type: 'result', subtype: 'success', session_id: SID, is_error: true, num_turns: 3, total_cost_usd: 0.9, result: BALANCE },
  ]);
  try {
    const outcome = await spawnClaude({ prompt: 'BOOT phase 23', cwd: b.dir, env: b.env });
    assert.deepEqual(outcome.signal.apiErrors, ['billing_error']);
    assert.match(outcome.signal.apiText ?? '', new RegExp(BALANCE));
    assert.doesNotMatch(outcome.signal.apiText ?? '', /checkout module/, 'the model\'s own line stays off the channel');
    const d = classify(outcome.signal);
    assert.equal(d.kind, 'credential-refused');
    if (d.kind === 'credential-refused') {
      assert.equal(d.class, 'billing');
      assert.equal(d.evidence?.source, 'api', 'a kind the API returned as data');
      assert.equal(d.evidence?.matched, 'billing_error');
    }
    assert.equal(structuredRefusal(outcome.signal), true, 'the typed kind is a structured verdict — it may reach the org row');
  } finally { b.cleanup(); }
});

test('BA-2: `is_api_error_message` flags the channel too, and so does stderr', async () => {
  const b = bench([
    init,
    said(`API Error: 401 ${AUTH}`, { is_api_error_message: true }),
    { type: 'result', subtype: 'success', session_id: SID, is_error: true, num_turns: 5, total_cost_usd: 1.1, result: 'x' },
  ], `${LOGIN}\n`);
  try {
    const outcome = await spawnClaude({ prompt: 'BOOT phase 23', cwd: b.dir, env: b.env });
    assert.match(outcome.signal.apiText ?? '', /API Error: 401/);
    assert.match(outcome.signal.apiText ?? '', new RegExp(LOGIN.replace('/', '\\/')), 'stderr is an API channel');
    const d = classify(outcome.signal);
    assert.equal(d.kind, 'credential-refused');
    if (d.kind === 'credential-refused') {
      assert.equal(d.class, 'auth');
      assert.equal(d.evidence?.source, 'text', 'a sentence matched on an API channel, not a kind');
      assert.ok(d.evidence?.matched && d.evidence.matched.length <= 200);
    }
  } finally { b.cleanup(); }
});

/* ------------------------------------------------------------------ *
 * BA-3 — the same words through an API channel still retire
 * ------------------------------------------------------------------ */

test('BA-3: a channel fix, not a disarmed classifier — every API channel still answers', () => {
  // A typed kind on a session that WORKED and then failed.
  const typed = classify(worked({ subtype: 'success', isError: true, text: PURCHASE_FLOW_PROSE, apiErrors: ['authentication_failed'] }));
  assert.equal(typed.kind, 'credential-refused');
  if (typed.kind === 'credential-refused') { assert.equal(typed.class, 'auth'); assert.equal(typed.evidence?.source, 'api'); }

  // The API-error message's own sentence, on a worked failed session.
  const sentence = classify(worked({ subtype: 'error_during_execution', code: 1, text: PURCHASE_FLOW_PROSE, apiText: `API Error: 400 ${BALANCE}` }));
  assert.equal(sentence.kind, 'credential-refused');
  if (sentence.kind === 'credential-refused') {
    assert.equal(sentence.class, 'billing');
    assert.equal(sentence.evidence?.source, 'text');
    assert.match(sentence.evidence?.matched ?? '', new RegExp(BALANCE, 'i'));
  }

  // A session that spent NOTHING produced no prose: its result text can only
  // be the CLI's own — the expired-login shape (success, one turn, $0).
  const unspent = classify({ subtype: 'success', turns: 1, costUsd: 0, text: AUTH });
  assert.equal(unspent.kind, 'credential-refused');
  if (unspent.kind === 'credential-refused') assert.equal(unspent.class, 'auth');

  // An api_retry category still outranks everything, success included (phase 3).
  const retried = classify(worked({ subtype: 'success', retryCategories: ['billing_error'] }));
  assert.equal(retried.kind, 'credential-refused');
  if (retried.kind === 'credential-refused') { assert.equal(retried.evidence?.source, 'api'); assert.equal(retried.evidence?.matched, 'billing_error'); }
});

test('BA-3: a worked SUCCESS is still believed over an API-channel sentence (phase 3 stands)', () => {
  const d = classify(worked({ subtype: 'success', text: 'done', apiText: `API Error: 400 ${BALANCE}` }));
  assert.equal(d.kind, 'ok');
});

/* ------------------------------------------------------------------ *
 * BA-6 (the runner's half) — the halt, the cause and the switch say why
 * ------------------------------------------------------------------ */

type Repo = { root: string; markDone: (phase: number) => void; scripts: string; cleanup: () => void };

function repo(): Repo {
  const root = mkdtempSync(join(tmpdir(), 'pc-ba-runner-'));
  const scripts = join(root, 'scripts');
  const stub = join(root, '.stub');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stub, { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'demo.md'), '# demo\n');
  writeFileSync(join(stub, 'done'), '');
  const exe = (path: string, body: string) => { writeFileSync(path, body, 'utf8'); chmodSync(path, 0o755); };
  exe(join(scripts, 'phase-graph.sh'), `#!/usr/bin/env bash
S="${stub}"; mode="\${2:-}"; arg="\${3:-}"
case "$mode" in
  --memory-block)
    if grep -qx 1 "$S/done"; then echo "done: 1"; echo "ready: "; else echo "done: "; echo "ready: 1"; fi
    echo "in-progress: "; echo "stuck: "; echo "waiting: " ;;
  --gate-status) echo "clear (no gate)" ;;
  --qa-history) exit 0 ;;
  --boot-prompt) echo "BOOT phase $arg" ;;
  --size) echo M ;;
  *) exit 0 ;;
esac
`);
  exe(join(scripts, 'phase-lock.sh'), '#!/usr/bin/env bash\n[ "${2:-}" = "status" ] && echo "phase ${3:-?}: free"\nexit 0\n');
  exe(join(scripts, 'validate.sh'), '#!/usr/bin/env bash\necho "VALIDATE OK"\n');
  return {
    root, scripts,
    markDone: (phase) => writeFileSync(join(stub, 'done'), `${phase}\n`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const journalled = (events: { event: string; data: Record<string, unknown> }[], name: string) => events
  .filter((e) => e.event === 'run:journal' && e.data.event === name)
  .map((e) => (e.data.data ?? {}) as Record<string, unknown>);

function leaveStub(accountId: string | undefined, leaving: LeaveReason): LeaveResult {
  return { accountId: accountId ?? 'default', credential: 'stub', state: leaving.kind === 'credential' ? 'retired' : 'cooling', throttleUntilMs: null };
}

test('BA-6: the halt, the phase\'s cause and the retirement carry what the refusal stood on and whose stop it was', async () => {
  const r = repo();
  const left: LeaveReason[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const refused: SpawnFn = async () => ({
    signal: {
      subtype: 'success', isError: true, code: 0, turns: 1, costUsd: 0,
      text: BALANCE, apiText: BALANCE, apiErrors: ['billing_error'],
    },
    sessionId: 'sess-57', costUsd: 0, turns: 1, resultText: BALANCE, durationMs: 10, argv: [],
  } as SpawnOutcome);
  const instance = new Runner({
    scriptsDir: r.scripts, spawn: refused, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    leaveAccount: (accountId, leaving) => { left.push(leaving); return leaveStub(accountId, leaving); },
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going' });
    await instance.wait();
    const state = instance.current()!;
    assert.equal(state.halt?.kind, 'credential-refused');
    const want = { source: 'api', matched: 'billing_error', session: 'sess-57', phase: 1, slug: 'demo', runId: state.id };
    assert.deepEqual(state.halt?.evidence, want, 'the halt says why');
    assert.deepEqual(state.phases['1'].cause?.evidence, want, 'the phase\'s cause too');
    assert.deepEqual(journalled(events, 'run.halt').at(-1)?.evidence, want, 'and the journal line');
    const retirement = left.find((leaving) => leaving.kind === 'credential');
    assert.deepEqual(retirement?.evidence, want, 'the retirement keeps it — the account view reads it there');
  } finally { r.cleanup(); }
});

test('BA-6: a switch away from a retired account journals the retirement\'s evidence', async () => {
  const r = repo();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const evidence = { source: 'text' as const, matched: `API Error: 400 ${BALANCE}`, session: 'sess-57', phase: 23 };
  const spawn: SpawnFn = async () => {
    r.markDone(1);
    return { signal: { subtype: 'success', code: 0, text: '' }, sessionId: 's', costUsd: 0.02, turns: 3, resultText: 'done', durationMs: 5, argv: [] } as SpawnOutcome;
  };
  const instance = new Runner({
    scriptsDir: r.scripts, spawn, verificationText: () => '`true`',
    onEvent: (event, data) => events.push({ event, data }),
    accountEnv: async (accountId) => (accountId === 'spare' ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok-spare' } : null),
    checkAuth: async () => ({ loggedIn: true, checkedAt: '' }),
    accountHeadroom: (accountId) => (accountId === 'work'
      ? { ok: false, accountId: 'work', kind: 'retired', reason: 'work is retired', evidence }
      : { ok: true, accountId: accountId ?? 'default' }),
    rankAccounts: (excluding) => ['work', 'spare'].filter((id) => id !== excluding),
    leaveAccount: (accountId, leaving) => leaveStub(accountId, leaving),
  });
  try {
    await instance.start({ slug: 'demo', root: r.root, autonomy: 'keep-going', accountId: 'work' });
    await instance.wait();
    const switched = journalled(events, 'run.account-switched');
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0].evidence, evidence);
  } finally { r.cleanup(); }
});
