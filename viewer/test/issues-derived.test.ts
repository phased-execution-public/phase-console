/**
 * What the Issues desk reads off an issue (control-tower phase 118, exit
 * criterion 2): its category, its severity and where it stands in a plan —
 * derived ONCE, in `shared/issues-model.js`, from its labels, its state and
 * the local plans' `Fixes:` lines, and read by the server and the client
 * alike.
 *
 *   DK-3  the derivation table: a label set → category, severity, plan state.
 *   DK-4  the server joins the derivation onto each row it serves — with the
 *         phase a local plan's `Fixes:` line names — and never writes it into
 *         the cache, which is GitHub's answer and nothing else.
 *   DK-5  a repository the operator added is read, refreshed and marked
 *         outside this console; a name that is not GitHub's shape is not one.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISSUE_CATEGORIES, ISSUE_PLAN_STATES, ISSUE_REPOS_MAX, ISSUE_SEVERITIES, ISSUE_SEVERITY_WORDS,
  addedRepoKey, categoryOf, fixesNumbers, issueRepoName, issueReposOf, planStateOf, severityOf, triageOf,
} from '../shared/issues-model.js';
import { cacheDir, cacheFileName, type GhRunner } from '../server/issues/fetch.ts';
import { fixesIndexOf } from '../server/issues/fixes.ts';
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

/* ------------------------------------------------------------------ *
 * DK-3 — the derivation table
 * ------------------------------------------------------------------ */

test('DK-3: the three vocabularies, in the order the desk sorts them', () => {
  assert.deepEqual([...ISSUE_CATEGORIES], ['bug', 'enhancement', 'documentation', 'question', 'other']);
  assert.deepEqual([...ISSUE_SEVERITY_WORDS], [...ISSUE_SEVERITIES, 'none']);
  assert.deepEqual([...ISSUE_PLAN_STATES], ['needs-plan', 'planned', 'deferred', 'fixed', 'none']);
});

test('DK-3: a category is the first type label it carries, in the vocabulary order', () => {
  const table: [string[], string][] = [
    [['bug'], 'bug'],
    [['Enhancement'], 'enhancement'],
    [['documentation', 'from-session'], 'documentation'],
    [['question'], 'question'],
    [['enhancement', 'bug'], 'bug'],
    [['wontfix', 'awaiting-plan'], 'other'],
    [[], 'other'],
  ];
  for (const [labels, category] of table) assert.equal(categoryOf(labels), category, labels.join(','));
});

test('DK-3: a severity is its `severity:` label, the worst when there are two, none when there is none', () => {
  const table: [string[], string][] = [
    [['severity:high'], 'high'],
    [['Severity:Medium'], 'medium'],
    [['severity:low', 'severity:critical'], 'critical'],
    [['severity:urgent'], 'none'],
    [['bug'], 'none'],
    [[], 'none'],
  ];
  for (const [labels, severity] of table) assert.equal(severityOf(labels), severity, labels.join(','));
});

test('DK-3: the plan state reads awaiting-plan, plan:<slug>, plan:<slug>-deferred and a close', () => {
  const fixes = (slug: string, number: number) =>
    slug === 'control-tower' && number === 203 ? [118] : slug === 'control-tower' && number === 40 ? [14, 121] : undefined;
  const open = (number: number, labels: string[]) => ({ number, state: 'OPEN', labels });
  const closed = (number: number, labels: string[]) => ({ number, state: 'CLOSED', labels });

  assert.deepEqual(planStateOf(open(1, ['bug', 'awaiting-plan']), fixes), { state: 'needs-plan' });
  assert.deepEqual(planStateOf(open(203, ['bug', 'plan:control-tower']), fixes),
    { state: 'planned', slug: 'control-tower', phases: [118] });
  assert.deepEqual(planStateOf(open(40, ['plan:control-tower']), fixes),
    { state: 'planned', slug: 'control-tower', phases: [14, 121] });
  assert.deepEqual(planStateOf(open(77, ['plan:control-tower'])), { state: 'planned', slug: 'control-tower' },
    'a plan this console cannot read still names the plan — just not the phase');
  assert.deepEqual(planStateOf(open(164, ['plan:control-tower-deferred']), fixes),
    { state: 'deferred', slug: 'control-tower' });
  assert.deepEqual(planStateOf(open(5, ['awaiting-plan', 'plan:zero-touch']), fixes),
    { state: 'planned', slug: 'zero-touch' }, 'the plan label wins: the amendment that plans it relabels');
  assert.deepEqual(planStateOf(open(6, ['plan:a-deferred', 'plan:b']), fixes), { state: 'planned', slug: 'b' });
  assert.deepEqual(planStateOf(closed(203, ['plan:control-tower']), fixes),
    { state: 'fixed', slug: 'control-tower', phases: [118] });
  assert.deepEqual(planStateOf(closed(9, ['awaiting-plan']), fixes), { state: 'none' },
    'a closed issue that names no fix is closed, not fixed');
  assert.deepEqual(planStateOf(open(2, ['bug']), fixes), { state: 'none' });
});

test('DK-3: triageOf is the three together', () => {
  assert.deepEqual(
    triageOf({ number: 203, state: 'OPEN', labels: ['bug', 'plan:control-tower', 'severity:low'] },
      () => [118]),
    { category: 'bug', severity: 'low', plan: { state: 'planned', slug: 'control-tower', phases: [118] } },
  );
});

test('DK-3: a Fixes line names its issues by #number, and nothing else is a number', () => {
  assert.deepEqual(fixesNumbers('#38, #35, #37.'), [38, 35, 37]);
  assert.deepEqual(fixesNumbers('#203.'), [203]);
  assert.deepEqual(fixesNumbers('none by number — the operator\'s ask 4, act half.'), []);
  assert.deepEqual(fixesNumbers('carries `many-plans-one-repo` phase 19.'), []);
  assert.deepEqual(fixesNumbers('#40 (re-opened), #40'), [40]);
});

test('DK-3: the fixes index maps an issue number to every phase whose Fixes line names it', () => {
  const phase = (body: string | null) => ({ bullets: body === null ? [] : [{ label: 'Fixes', body }] });
  const index = fixesIndexOf({ 14: phase('#40.'), 118: phase('#203.'), 121: phase('#181, #182, #40.'), 7: phase(null) });
  assert.deepEqual(index.get(203), [118]);
  assert.deepEqual(index.get(40), [14, 121]);
  assert.equal(index.get(7), undefined);
});

/* ------------------------------------------------------------------ *
 * DK-4 — joined on serving, never cached
 * ------------------------------------------------------------------ */

const ROWS = [
  { number: 203, title: 'a repo tag at zero width', state: 'OPEN',
    labels: [{ name: 'bug' }, { name: 'plan:control-tower' }, { name: 'severity:low' }],
    assignees: [], author: { login: 'zsarir' }, createdAt: '2026-10-03T16:00:00Z',
    updatedAt: '2026-10-03T16:47:30Z', closedAt: null, url: 'https://github.com/acme/widget/issues/203' },
  { number: 219, title: 'a false alarm', state: 'OPEN',
    labels: [{ name: 'awaiting-plan' }, { name: 'severity:medium' }, { name: 'enhancement' }],
    assignees: [], author: { login: 'console' }, createdAt: '2026-10-05T01:00:00Z',
    updatedAt: '2026-10-05T01:00:00Z', closedAt: null, url: 'https://github.com/acme/widget/issues/219' },
];
const answer: GhRunner = async () => ({ ok: true, stdout: JSON.stringify(ROWS), stderr: '' });

test('DK-4: every served row carries its triage — with the phase the local plan names — and the cache does not', async () => {
  const stateDir = temp('p118-state-');
  const store = new IssuesStore({
    root: () => temp('p118-root-'),
    stateDir,
    run: answer,
    added: () => ['acme/widget'],
    fixes: (slug, number) => (slug === 'control-tower' && number === 203 ? [118] : undefined),
  });
  await store.refresh('github:acme/widget');
  const row = store.list().repos.find((r) => r.nameWithOwner === 'acme/widget')!;
  const [tag, alarm] = row.issues;
  assert.deepEqual(tag.triage, {
    category: 'bug', severity: 'low', plan: { state: 'planned', slug: 'control-tower', phases: [118] },
  });
  assert.deepEqual(alarm.triage, { category: 'enhancement', severity: 'medium', plan: { state: 'needs-plan' } });
  const disk = readFileSync(join(cacheDir(stateDir), cacheFileName('acme/widget')), 'utf8');
  assert.ok(!disk.includes('triage'), 'the cache is GitHub\'s answer; a derivation is joined on read');
});

/* ------------------------------------------------------------------ *
 * DK-5 — a repository the operator added
 * ------------------------------------------------------------------ */

test('DK-5: an owner/name is GitHub\'s alphabet or nothing, and the list is bounded and deduplicated', () => {
  assert.equal(issueRepoName(' acme/widget '), 'acme/widget');
  assert.equal(issueRepoName('acme/wid get'), '');
  assert.equal(issueRepoName('-acme/widget'), '');
  assert.equal(issueRepoName('acme/../x'), '');
  assert.equal(issueRepoName('https://github.com/acme/widget'), '');
  assert.equal(issueRepoName(42), '');
  assert.deepEqual(issueReposOf(['acme/a', 'bad name', 'acme/a', 'acme/b']), ['acme/a', 'acme/b']);
  assert.deepEqual(issueReposOf('acme/a'), []);
  const many = Array.from({ length: ISSUE_REPOS_MAX + 5 }, (_, i) => `acme/r${i}`);
  assert.equal(issueReposOf(many).length, ISSUE_REPOS_MAX);
  assert.equal(addedRepoKey('acme/widget'), 'github:acme/widget');
});

test('DK-5: an added repository is listed, never fetched until asked, refreshed by its key, and marked outside', async () => {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => { calls.push(args); return answer(args); };
  const store = new IssuesStore({
    root: () => temp('p118-root-'), stateDir: temp('p118-state-'), run,
    added: () => ['acme/widget', 'not a repo'],
  });
  const before = store.list();
  const added = before.repos.filter((r) => r.kind === 'added');
  assert.deepEqual(added.map((r) => r.key), ['github:acme/widget'], 'a malformed name is no repository');
  assert.equal(added[0].label, 'acme/widget');
  assert.equal(added[0].reason, 'never-fetched');
  await store.sweep();
  assert.equal(calls.length, 0, 'the idle sweep keeps warm; it never discovers, outside or in');
  const after = await store.refresh('github:acme/widget');
  assert.notEqual(after, 'unknown-repo');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['issue', 'list', '--repo', 'acme/widget']);
  assert.equal(store.list().repos.find((r) => r.kind === 'added')?.issues.length, 2);
  assert.equal(await store.refresh('github:acme/other'), 'unknown-repo', 'only a name the operator added');
});

test('DK-5: an added repository that IS part of the estate is not listed twice', () => {
  // A root whose origin is acme/widget — the config file is all the inventory reads.
  const root = temp('p118-root-');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/widget.git\n');
  const store = new IssuesStore({
    root: () => root, stateDir: temp('p118-state-'), run: answer,
    added: () => ['acme/widget', 'acme/elsewhere'],
  });
  const repos = store.list().repos;
  assert.deepEqual(repos.filter((r) => r.nameWithOwner === 'acme/widget').map((r) => r.kind), ['root']);
  assert.deepEqual(repos.filter((r) => r.kind === 'added').map((r) => r.key), ['github:acme/elsewhere']);
});
