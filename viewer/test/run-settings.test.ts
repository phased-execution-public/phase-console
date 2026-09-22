/**
 * The run's own settings (many-plans-one-repo phase 15): the seven words the
 * launch form gained, what a fresh run records for each, and what a mid-run
 * patch may do to them.
 *
 * Three readers are held together here. `shared/run-settings.js` is the LIST
 * (what the two doors read); `runner/state.ts`'s `newRun` is what a fresh run
 * WRITES (the omission conventions — an absent word is the shipped default,
 * so a run file from before the field means what it always meant);
 * `runner/runner-core.ts`'s `applySettings` is what a patch may CHANGE. The
 * doors themselves — the 400s and 409s — are exercised below through the
 * route module, the way `routes.test.ts` does.
 *
 * The patch rules, stated once:
 *   - `landing` and `conflictPolicy` move BOTH ways: they say what happens
 *     when a phase settles, which has not happened yet for the phases to come.
 *   - `baseBranch` is immutable once the run's branch EXISTS (`checkout` set):
 *     the branch was cut from it, and a new word would describe a fork that
 *     never happened. The door 409s; `applySettings` ignores it.
 *   - `issuesMode` may only TIGHTEN (`file` → `draft` → `off`): loosening it
 *     mid-run would let sessions already boarded file on a repository under a
 *     word nobody launched them with. The door 409s; `applySettings` ignores it.
 *   - `messaging`, `worktreeRetention`, `maxConcurrentPerRepo` move both ways
 *     and land on the next spawn, the next settle and the next admission.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RUN_SETTINGS_FIELDS, RUN_START_FIELDS } from '../shared/run-settings.js';
import { DEFAULT_LAND, DEFAULT_CONFLICT, DEFAULT_BASE_BRANCH } from '../shared/landing-model.js';
import { DEFAULT_MESSAGING } from '../shared/message-model.js';
import { DEFAULT_ISSUES } from '../shared/issues-model.js';
import { DEFAULT_RETENTION } from '../shared/worktree-model.js';
import { newRun } from '../server/runner/state.ts';
import { applySettings } from '../server/runner/runner-core.ts';

/** The seven, in the order the form shows them. */
const NEW_FIELDS = [
  'baseBranch', 'maxConcurrentPerRepo', 'worktreeRetention',
  'landing', 'conflictPolicy', 'messaging', 'issuesMode',
] as const;

/* ------------------------------------------------------------------ *
 * The lists
 * ------------------------------------------------------------------ */

test('the seven phase-15 words are on BOTH door lists', () => {
  for (const field of NEW_FIELDS) {
    assert.ok((RUN_START_FIELDS as readonly string[]).includes(field), `start reads ${field}`);
    assert.ok((RUN_SETTINGS_FIELDS as readonly string[]).includes(field), `settings reads ${field}`);
  }
});

/* ------------------------------------------------------------------ *
 * What a fresh run writes
 * ------------------------------------------------------------------ */

test('a fresh run records each word it was given, and omits the shipped default', () => {
  const base = { slug: 'demo', root: '/tmp/demo', gitMode: 'new-branch' as const };
  const silent = newRun(base);
  for (const field of NEW_FIELDS) {
    assert.equal(field in silent, false, `${field} is absent when nobody said it`);
  }
  // Every default spelled explicitly is still an omission on disk — a run file
  // that says `landing: hold` and one that says nothing are one fact.
  const defaults = newRun({
    ...base,
    landing: DEFAULT_LAND, conflictPolicy: DEFAULT_CONFLICT, messaging: DEFAULT_MESSAGING,
    issuesMode: DEFAULT_ISSUES,
  });
  for (const field of ['landing', 'conflictPolicy', 'messaging', 'issuesMode'] as const) {
    assert.equal(field in defaults, false, `${field} at its default is written as no key`);
  }
  const chosen = newRun({
    ...base,
    baseBranch: 'release/5.1', maxConcurrentPerRepo: 2, worktreeRetention: 'ttl:12',
    landing: 'pr', conflictPolicy: 'park', messaging: 'off', issuesMode: 'draft',
  });
  assert.equal(chosen.baseBranch, 'release/5.1');
  assert.equal(chosen.maxConcurrentPerRepo, 2);
  assert.equal(chosen.worktreeRetention, 'ttl:12');
  assert.equal(chosen.landing, 'pr');
  assert.equal(chosen.conflictPolicy, 'park');
  assert.equal(chosen.messaging, 'off');
  assert.equal(chosen.issuesMode, 'draft');
});

test('the base branch, retention and repo cap are written on a default-branch run too', () => {
  // Unlike `isolation` and `settle`, these are not about the run's OWN branch
  // alone: retention governs any tree the console mints for it, the cap counts
  // it in its repository, and the base is what a lane's `pe/<slug>-pN` is cut
  // from whether or not the run itself took a branch.
  const run = newRun({
    slug: 'demo', root: '/tmp/demo',
    baseBranch: 'main', maxConcurrentPerRepo: 1, worktreeRetention: 'prune',
  });
  assert.equal(run.baseBranch, 'main');
  assert.equal(run.maxConcurrentPerRepo, 1);
  assert.equal(run.worktreeRetention, 'prune');
});

/* ------------------------------------------------------------------ *
 * What a patch may change
 * ------------------------------------------------------------------ */

const fresh = () => newRun({ slug: 'demo', root: '/tmp/demo', gitMode: 'new-branch' });

test('landing and conflictPolicy move both ways, and the default is stored as an omission', () => {
  const state = fresh();
  applySettings(state, { landing: 'pr', conflictPolicy: 'rebase-session' });
  assert.equal(state.landing, 'pr');
  assert.equal(state.conflictPolicy, 'rebase-session');
  applySettings(state, { landing: 'integrate', conflictPolicy: 'park' });
  assert.equal(state.landing, 'integrate');
  assert.equal(state.conflictPolicy, 'park');
  applySettings(state, { landing: DEFAULT_LAND, conflictPolicy: DEFAULT_CONFLICT });
  assert.equal('landing' in state, false, 'back to hold is a delete');
  assert.equal('conflictPolicy' in state, false, 'back to halt is a delete');
});

test('messaging, retention and the repo cap move both ways', () => {
  const state = fresh();
  applySettings(state, { messaging: 'off', worktreeRetention: 'keep', maxConcurrentPerRepo: 2 });
  assert.equal(state.messaging, 'off');
  assert.equal(state.worktreeRetention, 'keep');
  assert.equal(state.maxConcurrentPerRepo, 2);
  applySettings(state, { messaging: DEFAULT_MESSAGING, worktreeRetention: null, maxConcurrentPerRepo: null });
  assert.equal('messaging' in state, false, 'on is the absent state');
  assert.equal('worktreeRetention' in state, false, 'null clears the run\'s word — the console\'s decides again');
  assert.equal('maxConcurrentPerRepo' in state, false, 'null clears the run\'s cap — the console\'s decides again');
  // A word the vocabulary lacks clears rather than stores: a typo must never
  // become the reason a tree was deleted.
  applySettings(state, { worktreeRetention: 'prun' });
  assert.equal('worktreeRetention' in state, false);
  applySettings(state, { worktreeRetention: 'ttl:36' });
  assert.equal(state.worktreeRetention, 'ttl:36', 'the parameterised member is a legal word');
});

test('baseBranch changes only while the branch does not exist yet', () => {
  const state = fresh();
  applySettings(state, { baseBranch: 'release/5.1' });
  assert.equal(state.baseBranch, 'release/5.1');
  applySettings(state, { baseBranch: '' });
  assert.equal('baseBranch' in state, false, 'an empty word clears it — the plan or the console decides again');
  applySettings(state, { baseBranch: 'main' });
  // The preamble has cut the branch: from here the word is a fact about the
  // past, and a patch is ignored here (and refused with a reason at the door).
  state.checkout = 'worktree';
  applySettings(state, { baseBranch: 'develop' });
  assert.equal(state.baseBranch, 'main', 'immutable once the branch exists');
  applySettings(state, { baseBranch: '' });
  assert.equal(state.baseBranch, 'main', 'and cannot be cleared either');
});

test('issuesMode may only tighten', () => {
  // Born at `file` — a patch could never get a run there, which is the rule.
  const state = newRun({ slug: 'demo', root: '/tmp/demo', issuesMode: 'file' });
  assert.equal(state.issuesMode, 'file');
  applySettings(state, { issuesMode: 'draft' });
  assert.equal(state.issuesMode, 'draft', 'file → draft tightens');
  applySettings(state, { issuesMode: 'file' });
  assert.equal(state.issuesMode, 'draft', 'draft → file loosens and is ignored');
  applySettings(state, { issuesMode: DEFAULT_ISSUES });
  assert.equal('issuesMode' in state, false, 'draft → off tightens, and off is the absent state');
  applySettings(state, { issuesMode: 'draft' });
  assert.equal('issuesMode' in state, false, 'off → draft loosens and is ignored');
});

/* ------------------------------------------------------------------ *
 * The doors
 * ------------------------------------------------------------------ */

type Captured = { status: number; body: unknown };

const DECIDED = { resumeOnRestart: true, relay: 'off', accounts: [{ id: 'default', minHeadroomPct: 0 }] };

async function call(service: unknown, method: string, path: string, body: Record<string, unknown> = {}): Promise<Captured> {
  const { handleApi } = await import('../server/api/routes.ts');
  const out: Captured = { status: 0, body: null };
  if (/\/start$/.test(path) && !body.resumeRunId) body = { ...DECIDED, ...body };
  const req = {
    method,
    headers: { 'x-phase-console': '1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); },
  };
  const res = {
    req,
    writeHead(status: number) { out.status = status; return this; },
    end(chunk: unknown) { try { out.body = JSON.parse(String(chunk ?? '')); } catch { out.body = String(chunk ?? ''); } },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1${path}`));
  return out;
}

function fakeService(over: Record<string, unknown> = {}) {
  const started: { slug: string; options: Record<string, unknown> }[] = [];
  const configured: Record<string, unknown>[] = [];
  return {
    flags: { allowWrites: true, allowRun: true, maxSessions: 4 },
    store: { get: () => ({}), list: () => [] },
    accounts: { has: () => false },
    startRun: async (slug: string, options: Record<string, unknown>) => { started.push({ slug, options }); return { id: 'r1' }; },
    configureRun: (_slug: string, patch: Record<string, unknown>) => { configured.push(patch); return { id: 'r1' }; },
    verificationPreflight: async () => [],
    claimPreflight: () => [],
    runFor: async () => null as Record<string, unknown> | null,
    _started: started,
    _configured: configured,
    ...over,
  };
}

const err = (out: Captured) => String((out.body as { error?: string })?.error ?? '');

test('the start door reads every one of the seven, and a word off the vocabulary is "you did not say"', async () => {
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', {
    baseBranch: ' release/5.1 ', maxConcurrentPerRepo: '2', worktreeRetention: 'TTL:6',
    landing: 'pr', conflictPolicy: 'park', messaging: 'off', issuesMode: 'draft',
  });
  assert.equal(out.status, 200, err(out));
  const options = service._started[0].options;
  assert.equal(options.baseBranch, 'release/5.1', 'trimmed');
  assert.equal(options.maxConcurrentPerRepo, 2, 'a whole number');
  assert.equal(options.worktreeRetention, 'ttl:6', 'lower-cased through the owner\'s coercer');
  assert.equal(options.landing, 'pr');
  assert.equal(options.conflictPolicy, 'park');
  assert.equal(options.messaging, 'off');
  assert.equal(options.issuesMode, 'draft');

  const typo = fakeService();
  const bad = await call(typo, 'POST', '/api/run/demo/start', {
    baseBranch: '', worktreeRetention: 'prun', landing: 'PR', conflictPolicy: 'stop',
    messaging: true, issuesMode: 'files',
  });
  assert.equal(bad.status, 200, err(bad));
  for (const field of NEW_FIELDS) {
    assert.equal(typo._started[0].options[field], undefined, `${field}: a word the vocabulary lacks decides nothing`);
  }
});

test('the start door refuses a repo cap outside 1–99 by name', async () => {
  const service = fakeService();
  const out = await call(service, 'POST', '/api/run/demo/start', { maxConcurrentPerRepo: 0 });
  assert.equal(out.status, 400);
  assert.match(err(out), /maxConcurrentPerRepo/);
  assert.equal(service._started.length, 0);
});

test('a settings patch moves landing and conflictPolicy both ways', async () => {
  const service = fakeService({ runFor: async () => ({ id: 'r1', landing: 'pr', conflictPolicy: 'park' }) });
  const out = await call(service, 'POST', '/api/run/demo/settings', { landing: 'hold', conflictPolicy: 'halt' });
  assert.equal(out.status, 200, err(out));
  assert.equal(service._configured[0].landing, 'hold');
  assert.equal(service._configured[0].conflictPolicy, 'halt');
});

test('a settings patch refuses a new base branch once the branch exists, with the reason', async () => {
  const before = fakeService({ runFor: async () => ({ id: 'r1', baseBranch: 'main' }) });
  assert.equal((await call(before, 'POST', '/api/run/demo/settings', { baseBranch: 'develop' })).status, 200);
  assert.equal(before._configured[0].baseBranch, 'develop');

  const after = fakeService({ runFor: async () => ({ id: 'r1', baseBranch: 'main', checkout: 'worktree' }) });
  const out = await call(after, 'POST', '/api/run/demo/settings', { baseBranch: 'develop' });
  assert.equal(out.status, 409);
  assert.match(err(out), /already (been )?cut/i);
  assert.equal(after._configured.length, 0, 'and nothing was changed');

  // Re-asserting what the run already has stays a 200 — a form that resubmits
  // every field must not 409 on the one it did not touch.
  const same = fakeService({ runFor: async () => ({ id: 'r1', baseBranch: 'main', checkout: 'worktree' }) });
  assert.equal((await call(same, 'POST', '/api/run/demo/settings', { baseBranch: 'main' })).status, 200);
});

test('a settings patch may tighten issuesMode and never loosen it', async () => {
  const tighten = fakeService({ runFor: async () => ({ id: 'r1', issuesMode: 'file' }) });
  assert.equal((await call(tighten, 'POST', '/api/run/demo/settings', { issuesMode: 'draft' })).status, 200);
  assert.equal(tighten._configured[0].issuesMode, 'draft');

  const loosen = fakeService({ runFor: async () => ({ id: 'r1' }) });
  const out = await call(loosen, 'POST', '/api/run/demo/settings', { issuesMode: 'draft' });
  assert.equal(out.status, 409);
  assert.match(err(out), /tighten/);
  assert.equal(loosen._configured.length, 0);

  const same = fakeService({ runFor: async () => ({ id: 'r1', issuesMode: 'draft' }) });
  assert.equal((await call(same, 'POST', '/api/run/demo/settings', { issuesMode: 'draft' })).status, 200);
});

/* ------------------------------------------------------------------ *
 * The defaults the run reads through
 * ------------------------------------------------------------------ */

test('the shipped defaults are the owners\' words, not copies', () => {
  assert.equal(DEFAULT_LAND, 'hold');
  assert.equal(DEFAULT_CONFLICT, 'halt');
  assert.equal(DEFAULT_MESSAGING, 'on');
  assert.equal(DEFAULT_ISSUES, 'off');
  assert.equal(DEFAULT_RETENTION, 'keep-on-failure');
  assert.equal(DEFAULT_BASE_BRANCH, 'origin/HEAD');
});
