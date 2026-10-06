/**
 * The Issues desk reads a repository's WHOLE issue list (control-tower phase
 * 118, exit criterion 1).
 *
 * Until 6.0 the board asked `gh` for 101 rows and showed a hundred, so a
 * repository with 195 issues was a board that silently stopped at #96 — the
 * desk a person triages from has to hold all of them. `gh issue list` pages
 * GraphQL by itself, so one call with a large `--limit` is the whole list; the
 * cap exists so a runaway repository cannot hold a request open forever, and
 * past it the list says `truncated` rather than pretending to be complete.
 *
 *   DK-1  195 issues come back as 195, with author, createdAt and closedAt
 *         read, and never a field that returns a body (`comments`, `body`).
 *   DK-2  past the cap the list is cut AT the cap and says `truncated` — in
 *         the fetch, in the cache and in the payload a browser reads.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GH_LIST_TIMEOUT_MS, GH_TIMEOUT_MS, ISSUE_LIST_CAP, ISSUE_LIST_FIELDS, cacheDir, cacheFileName,
  fetchIssues, type GhRunner,
} from '../server/issues/fetch.ts';
import { IssuesStore } from '../server/issues/index.ts';

const trash: string[] = [];
process.on('exit', () => {
  for (const dir of trash) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trash.push(dir);
  return dir;
};

const REMOTE = { owner: 'acme', repo: 'widget', nameWithOwner: 'acme/widget' };

/** One row the way `gh issue list --json` spells it. */
function ghRow(n: number) {
  return {
    number: n,
    title: `issue ${n}`,
    state: n % 3 === 0 ? 'CLOSED' : 'OPEN',
    labels: [{ name: n % 2 ? 'bug' : 'enhancement' }],
    assignees: [],
    author: { login: `author${n % 4}`, name: 'Somebody', is_bot: false },
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    closedAt: n % 3 === 0 ? '2026-09-02T10:00:00Z' : null,
    url: `https://github.com/acme/widget/issues/${n}`,
  };
}

/**
 * A repository of `total` issues behind a `gh` that honours `--limit` the way
 * the real one does — it returns at most that many, newest first — and records
 * every argv it was handed.
 */
function repository(total: number): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    const at = args.indexOf('--limit');
    const limit = at >= 0 ? Number(args[at + 1]) : 30;
    const rows = Array.from({ length: Math.min(limit, total) }, (_, i) => ghRow(total - i));
    return { ok: true, stdout: JSON.stringify(rows), stderr: '' };
  };
  return { run, calls };
}

test('DK-1: a repository of 195 issues answers 195 — the whole list, not the first hundred', async () => {
  const { run, calls } = repository(195);
  const outcome = await fetchIssues(REMOTE, run);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.issues.length, 195);
  assert.equal(outcome.truncated, false, 'a list that fit under the cap is complete, and says so');
  assert.deepEqual(outcome.issues.slice(0, 2).map((i) => i.number), [195, 194]);
  assert.equal(calls.length, 1, 'one call — gh pages GraphQL by itself');
});

test('DK-1: the list is asked for with a cap of at least 2,000, measured one over', async () => {
  assert.ok(ISSUE_LIST_CAP >= 2000, `the cap is ${ISSUE_LIST_CAP}`);
  const { run, calls } = repository(3);
  await fetchIssues(REMOTE, run);
  assert.deepEqual(calls[0].slice(0, 8), [
    'issue', 'list', '--repo', 'acme/widget', '--state', 'all', '--limit', String(ISSUE_LIST_CAP + 1),
  ]);
});

test('DK-1: author, createdAt and closedAt are read — and no field that returns every body', async () => {
  const fields = ISSUE_LIST_FIELDS.split(',');
  for (const wanted of ['number', 'title', 'state', 'labels', 'assignees', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url']) {
    assert.ok(fields.includes(wanted), `${wanted} is asked for`);
  }
  // `comments` answers every comment's whole body, and `body` the issue's: a
  // list of two thousand issues must stay a list, not a library.
  assert.ok(!fields.includes('comments'), 'never `comments`');
  assert.ok(!fields.includes('body'), 'never `body` — a body is one `issue view` each, on demand');

  const { run } = repository(6);
  const outcome = await fetchIssues(REMOTE, run);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const closed = outcome.issues.find((i) => i.number === 6)!;
  const open = outcome.issues.find((i) => i.number === 5)!;
  assert.equal(closed.author, 'author2', 'the author is the LOGIN, not the object gh answers');
  assert.equal(closed.createdAt, '2026-08-01T10:00:00Z');
  assert.equal(closed.closedAt, '2026-09-02T10:00:00Z');
  assert.equal(open.closedAt, undefined, 'an open issue has no close time — absent, never an empty string');
});

test('DK-2: past the cap the list is cut AT the cap and says truncated', async () => {
  const { run } = repository(ISSUE_LIST_CAP + 40);
  const outcome = await fetchIssues(REMOTE, run);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.issues.length, ISSUE_LIST_CAP);
  assert.equal(outcome.truncated, true);
});

test('DK-2: exactly the cap is complete — truncation is measured, never assumed', async () => {
  const { run } = repository(ISSUE_LIST_CAP);
  const outcome = await fetchIssues(REMOTE, run);
  assert.ok(outcome.ok && outcome.issues.length === ISSUE_LIST_CAP);
  assert.equal(outcome.ok && outcome.truncated, false);
});

test('DK-2: the store keeps the whole list and the truncation, in the cache and in the payload', async () => {
  const root = temp('p118-root-');
  const stateDir = temp('p118-state-');
  // A root with no `.git` is a repository with no remote; the store is given
  // one GitHub repository the way the desk's picker adds one.
  const { run } = repository(ISSUE_LIST_CAP + 1);
  const store = new IssuesStore({ root: () => root, stateDir, run, added: () => ['acme/widget'] });
  const payload = await store.refresh('github:acme/widget');
  assert.notEqual(payload, 'unknown-repo');
  if (payload === 'unknown-repo') return;
  const row = payload.repos.find((r) => r.key === 'github:acme/widget')!;
  assert.equal(row.issues.length, ISSUE_LIST_CAP);
  assert.equal(row.truncated, true);
  const cached = JSON.parse(readFileSync(join(cacheDir(stateDir), cacheFileName('acme/widget')), 'utf8'));
  assert.equal(cached.issues.length, ISSUE_LIST_CAP);
  assert.equal(cached.truncated, true);
  assert.equal(cached.issues[0].author, 'author1', 'the cache keeps the author it read');
});

test('DK-2: the list call gets a budget a two-thousand-issue answer can meet', () => {
  // Twenty-one GraphQL pages do not answer inside one `issue view`'s budget.
  assert.ok(GH_LIST_TIMEOUT_MS >= 60_000);
  assert.ok(GH_LIST_TIMEOUT_MS > GH_TIMEOUT_MS);
});
