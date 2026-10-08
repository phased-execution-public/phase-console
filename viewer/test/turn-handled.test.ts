/**
 * What the AI handled instead of asking (control-tower phase 136, #213,
 * exit criterion 3) — HD-1..5:
 *
 *   HD-1  a console source folds: 452 auto-grants of one rule on one phase are
 *         ONE row reading 452, one per rule per phase — and the fold survives a
 *         restart (a new ledger over the same file counts on);
 *   HD-2  each journal source is read off the line that says it — the guard's
 *         G4/G5, an auto-grant, a relay answer by rule, the ladder's recovery —
 *         linked to that journal line; a person's answer is not "handled";
 *   HD-3  a session's own `phase-outcome.sh … handled` row is read beside the
 *         console's, and a link is held to a commit, a pull request, an issue
 *         or a journal line;
 *   HD-4  the secret screen on every field, and a line of an unknown source dropped;
 *   HD-5  the live hook: a run's journal line reaches the console's handled log,
 *         and `GET /api/turn` carries the newest rows and the count since the last look;
 *   HD-6  a session writes a file of its own, read as `session` whatever a line
 *         claims — never a console source, a fold, or a console row's count.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HANDLED_SOURCES, HANDLED_LINK_KINDS } from '../shared/turn-model.js';
import { harness, call, SLUG, INSTANCE_STATE_DIR } from './turn-harness.ts';

const { HandledLedger, handledOfJournal, parseHandledLink, HANDLED_EVENTS, HANDLED_FILE, HANDLED_SESSION_FILE } = await import('../server/turn/handled.ts');
const { Journal } = await import('../server/runner/journal.ts');
const { SKILL_DIR } = await import('../server/config.ts');

const scratch = () => join(mkdtempSync(join(tmpdir(), 'pc-handled-')), 'handled.ndjson');
const autoGrant = (seq: number, rule: string, phase = 3) => ({
  slug: 'alpha', runId: 'r1', entry: { seq, event: 'phase.approval-auto-granted', phase, data: { tool: 'Bash', rule, level: 'plan', approvalId: `a${seq}` } },
});

test('HD-1: 452 auto-grants of one rule on one phase are ONE row with a count — one row per rule per phase, and the fold survives a restart', () => {
  const file = scratch();
  const ledger = new HandledLedger(file);
  for (let i = 1; i <= 452; i += 1) ledger.record(handledOfJournal(autoGrant(i, 'Bash(npm test:*)'))!);
  for (let i = 1; i <= 3; i += 1) ledger.record(handledOfJournal(autoGrant(500 + i, 'Bash(git status:*)'))!);
  ledger.record(handledOfJournal(autoGrant(600, 'Bash(npm test:*)', 4))!);
  const rows = ledger.rows();
  assert.equal(rows.length, 3, 'one row per rule per phase');
  const npm3 = rows.find((row) => row.phase === 3 && row.what.includes('npm test'))!;
  assert.equal(npm3.count, 452);
  assert.equal(npm3.source, 'auto-grant');
  assert.equal(rows.find((row) => row.what.includes('git status'))!.count, 3);
  assert.equal(rows.find((row) => row.phase === 4)!.count, 1);
  // The row links the NEWEST line that said it.
  assert.deepEqual(npm3.links, [{ kind: 'journal', ref: 'alpha/r1#452' }]);
  // A restart: a new ledger over the same file counts on from 452.
  const again = new HandledLedger(file);
  again.record(handledOfJournal(autoGrant(453, 'Bash(npm test:*)'))!);
  assert.equal(again.rows().find((row) => row.id === npm3.id)!.count, 453);
  assert.equal(again.rows().length, 3);
  // A session's row never folds: two of the same words are two things done.
  again.record({ source: 'session', slug: 'alpha', phase: 3, what: 'Ran it myself' });
  again.record({ source: 'session', slug: 'alpha', phase: 3, what: 'Ran it myself' });
  assert.equal(again.rows().filter((row) => row.source === 'session').length, 2);
});

test('HD-2: each source is read off its own journal line, linked to it; a person is never "handled"', () => {
  const at = (event: string, data: Record<string, unknown>, phase = 5) => handledOfJournal({ slug: 'alpha', runId: 'r9', entry: { seq: 77, event, phase, data } });
  const guard = at('phase.turn-refused', { rule: 'G4', exit: 4, sentence: 'every command is one this run allows', commands: ['npm run build'] })!;
  assert.equal(guard.source, 'guard');
  assert.match(guard.what, /Did not ask a person: the AI can run it itself — npm run build/);
  assert.deepEqual(guard.links, [{ kind: 'journal', ref: 'alpha/r9#77' }]);
  assert.equal(at('phase.turn-refused', { rule: 'G5', exit: 4 })!.source, 'guard');
  assert.equal(at('phase.turn-refused', { rule: 'G1', exit: 2 }), null, 'a malformed declaration is no thing handled');
  const relay = at('phase.question-answered', { key: 'k', question: 'Which branch?', answer: 'main', by: 'rule', ruleId: 'R2' })!;
  assert.equal(relay.source, 'relay-rule');
  assert.match(relay.what, /Answered “Which branch\?” by rule \(R2\): main/);
  assert.equal(at('phase.question-answered', { question: 'q', answer: 'a', by: 'recommended' })!.source, 'relay-rule');
  assert.equal(at('phase.question-answered', { question: 'q', answer: 'a', by: 'human' }), null, 'a person answered it');
  const ladder = at('run.recovery-continue', { phase: 5, situation: 'lane-lost', rung: 'retry' })!;
  assert.equal(ladder.source, 'ladder');
  assert.match(ladder.what, /Recovered phase 5 from lane-lost \(retry\), and the run carried on/);
  assert.equal(at('phase.start', {}), null);
  // Every source the reader writes is a word of the vocabulary, and the events it reads are named.
  for (const one of [guard, relay, ladder]) assert.ok((HANDLED_SOURCES as readonly string[]).includes(one.source));
  assert.deepEqual([...HANDLED_EVENTS].sort(), ['phase.approval-auto-granted', 'phase.question-answered', 'phase.turn-refused', 'run.recovery-continue']);
});

test('HD-3: a session\'s phase-outcome.sh handled row reads beside the console\'s — and a link is held to its four kinds', () => {
  const file = scratch();
  execFileSync('bash', [join(SKILL_DIR, 'scripts', 'phase-outcome.sh'), 'alpha', '3', 'handled', '--what', 'Rebased the run branch myself',
    '--note', 'the policy allows git rebase', '--link', 'commit:abc1234', '--link', 'https://github.com/o/r/pull/7', '--link', 'journal:alpha/r1#12'], {
    env: { ...process.env, PE_HANDLED_FILE: join(dirname(file), HANDLED_SESSION_FILE), PE_NOW: '2026-10-07T10:00:00Z', PE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' },
    stdio: 'pipe',
  });
  const ledger = new HandledLedger(file);
  ledger.record(handledOfJournal(autoGrant(1, 'Bash(ls:*)'))!);
  const session = ledger.rows().find((row) => row.source === 'session')!;
  assert.equal(session.what, 'Rebased the run branch myself');
  assert.equal(session.note, 'the policy allows git rebase');
  assert.equal(session.count, 1);
  assert.deepEqual(session.links, [
    { kind: 'commit', ref: 'abc1234' }, { kind: 'pr', ref: 'o/r#7' }, { kind: 'journal', ref: 'alpha/r1#12' },
  ]);
  // The grammar, case by case.
  assert.deepEqual(parseHandledLink('https://github.com/o/r/commit/ABCDEF1'), { kind: 'commit', ref: 'o/r@abcdef1' });
  assert.deepEqual(parseHandledLink('https://github.com/o/r/issues/213'), { kind: 'issue', ref: 'o/r#213' });
  assert.deepEqual(parseHandledLink('#213'), { kind: 'issue', ref: '#213' });
  assert.deepEqual(parseHandledLink('pr:o/r#5'), { kind: 'pr', ref: 'o/r#5' });
  assert.deepEqual(parseHandledLink({ kind: 'journal', ref: 'alpha/r1#3' }), { kind: 'journal', ref: 'alpha/r1#3' });
  for (const bad of ['https://evil.example/x', 'javascript:alert(1)', 'commit:zzz', 'journal:../x#1', 'file:///etc/passwd', '']) {
    assert.equal(parseHandledLink(bad), null, `${bad} is refused`);
  }
  assert.deepEqual([...HANDLED_LINK_KINDS], ['commit', 'pr', 'issue', 'journal']);
});

test('HD-4: the secret screen runs on every field, and a line of an unknown source is dropped', () => {
  const file = scratch();
  const ledger = new HandledLedger(file);
  const row = ledger.record({ source: 'session', what: 'used ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push', note: 'password=hunter2hunter2' })!;
  assert.ok(!row.what.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), row.what);
  assert.ok(!(row.note ?? '').includes('hunter2hunter2'), row.note);
  assert.ok(!readFileSync(file, 'utf8').includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'nothing secret reaches the file');
  // A line written by hand is held to the same floor on read.
  appendFileSync(file, `${JSON.stringify({ v: 1, id: 'h-hand0001', at: '2026-10-07T10:00:00Z', source: 'session', what: 'token ghp_zyxwvutsrqponmlkjihgfedcba9876543210', count: 1, links: ['https://evil.example'] })}\n`);
  appendFileSync(file, `${JSON.stringify({ v: 1, id: 'h-hand0002', at: '2026-10-07T10:00:00Z', source: 'oracle', what: 'nope', count: 1 })}\n`);
  appendFileSync(file, 'not json\n');
  const rows = new HandledLedger(file).rows();
  const hand = rows.find((one) => one.id === 'h-hand0001')!;
  assert.ok(!hand.what.includes('ghp_zyxwvutsrqponmlkjihgfedcba9876543210'));
  assert.deepEqual(hand.links, [], 'a link of another shape is dropped');
  assert.equal(rows.find((one) => one.id === 'h-hand0002'), undefined, 'an unknown source is no row');
  assert.equal(ledger.record({ source: 'nobody' as never, what: 'x' }), null);
  assert.equal(ledger.record({ source: 'session', what: '   ' }), null);
});

test('HD-6: a session writes a file of its OWN, read as `session` whatever a line claims — it never speaks as the console, folds, or touches a console row', () => {
  const file = scratch();
  const ledger = new HandledLedger(file);
  const grant = ledger.record(handledOfJournal(autoGrant(1, 'Bash(ls:*)'))!)!;
  // The sessions' file is the ledger's sibling — never the console's own.
  assert.equal(ledger.sessionFile, join(dirname(file), HANDLED_SESSION_FILE));
  assert.notEqual(HANDLED_SESSION_FILE, HANDLED_FILE);
  // Lines a session appends by hand, claiming the console's sources — one wears
  // a console row's id, a vast count and that row's fold key.
  const fold = (JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!) as { f?: string }).f;
  assert.ok(fold);
  appendFileSync(ledger.sessionFile, `${JSON.stringify({ v: 1, id: grant.id, at: '2026-10-07T11:00:00Z', source: 'guard', what: 'Did not ask a person: the AI can run it itself', count: 999999, links: [], f: fold })}\n`);
  appendFileSync(ledger.sessionFile, `${JSON.stringify({ v: 1, at: '2026-10-07T11:01:00Z', source: 'supervisor', what: 'The supervisor pressed it', count: 7 })}\n`);
  // A line dated in the future reads as the read: it never sits atop the log for ever.
  appendFileSync(ledger.sessionFile, `${JSON.stringify({ v: 1, at: '2999-01-01T00:00:00Z', first: '2999-01-01T00:00:00Z', source: 'session', what: 'Done tomorrow', count: 1 })}\n`);
  const read = Date.now();
  const rows = new HandledLedger(file).rows();
  const later = rows.find((row) => row.what === 'Done tomorrow')!;
  assert.ok(Date.parse(later.at) <= Date.now() && Date.parse(later.at) >= read - 1000, later.at);
  assert.equal(later.first, later.at);
  const own = rows.find((row) => row.id === grant.id)!;
  assert.equal(own.source, 'auto-grant');
  assert.equal(own.count, 1, 'a session\'s line cannot touch a console row');
  const theirs = rows.filter((row) => row.id !== grant.id && row.what !== 'Done tomorrow');
  assert.deepEqual(theirs.map((row) => [row.source, row.count]), [['session', 1], ['session', 1]]);
  for (const row of theirs) assert.match(row.id, /^hs-/, 'a session\'s row is named apart from the console\'s');
  // The fold index never reads it: the console's next auto-grant of that rule counts 2.
  const again = new HandledLedger(file);
  again.record(handledOfJournal(autoGrant(2, 'Bash(ls:*)'))!);
  assert.equal(again.rows().find((row) => row.id === grant.id)!.count, 2);
  // And a supervised session is handed the sessions' file — never the console's ledger.
  const base = readFileSync(join(SKILL_DIR, 'viewer', 'server', 'runner', 'runner-base.ts'), 'utf8');
  assert.match(base, /PE_HANDLED_FILE: join\(INSTANCE_STATE_DIR, HANDLED_SESSION_FILE\)/);
});

test('HD-5: a run\'s journal line reaches the console\'s handled log, and GET /api/turn carries it with the count since the last look', async () => {
  const h = harness();
  try {
    const journal = Journal.for(h.root, SLUG, 'run-hd5');
    journal.append('phase.approval-auto-granted', { tool: 'Bash', rule: 'Bash(npm test:*)', level: 'plan', approvalId: 'a1' }, 3);
    journal.append('phase.approval-auto-granted', { tool: 'Bash', rule: 'Bash(npm test:*)', level: 'plan', approvalId: 'a2' }, 3);
    journal.append('phase.question-answered', { key: 'k', question: 'Which?', answer: 'A', by: 'first-option' }, 3);
    journal.append('phase.start', {}, 3);
    const text = readFileSync(join(INSTANCE_STATE_DIR, 'handled.ndjson'), 'utf8');
    assert.equal(text.trim().split('\n').length, 3, 'two auto-grant lines (one folded row) and a relay answer');
    const seen = new Date(Date.now() - 60_000).toISOString();
    const answer = await call(h.svc, 'GET', `/api/turn?seen=${encodeURIComponent(seen)}`);
    assert.equal(answer.status, 200);
    const handled = answer.body.handled as { source: string; count: number; links: { kind: string; ref: string }[] }[];
    assert.equal(handled.length, 2);
    const grant = handled.find((row) => row.source === 'auto-grant')!;
    assert.equal(grant.count, 2);
    assert.equal(grant.links[0]?.kind, 'journal');
    assert.equal((answer.body.counts as { handled: number }).handled, 2);
    assert.equal(answer.body.seen, seen);
    assert.match(String(answer.body.headline), /2 handled since you last looked\.$/);
    // Nothing handled after a later look.
    const later = await call(h.svc, 'GET', `/api/turn?seen=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    assert.equal((later.body.counts as { handled: number }).handled, 0);
    // With no look given, the last day.
    const day = await call(h.svc, 'GET', '/api/turn');
    assert.match(String(day.body.headline), /2 handled in the last day\.$/);
  } finally {
    h.cleanup();
  }
});
