/**
 * `GET /api/run/:slug/proofs?phase=` and `GET /api/run/:slug/verifications
 * ?phase=&run=&limit=` (quiet-console phase 25, §Architecture 5): what a
 * plan's sessions proved (`proofs.ndjson` — the last proof of each command, by
 * phase) and every run of its §Verification lines (`verifications.ndjson` —
 * verdicts and baselines, newest first). Both ledgers were written and read by
 * the console for its own decisions; no route returned them.
 *
 * Read from the FILES, like the rulings, so a finished run answers too. Below
 * the "no source directory" wall, and a slug that is not one is refused before
 * it reaches `runDir()`'s bare `join`.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bareService, call, scratch, service } from './thin-read-harness.ts';
import { runDir } from '../server/runner/state.ts';
import { VERIFICATIONS_PAGE, VERIFICATIONS_PAGE_MAX, ledgerPage, type LedgerRow } from '../server/runner/verify-ledger.ts';
import { proofRows, readProofs } from '../server/runner/proofs.ts';

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);
const ndjson = (rows: unknown[]): string => `${rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n')}\n`;

/** A scratch library whose plan `alpha` has both ledgers on file. */
function library(): string {
  const root = scratch();
  const dir = runDir(root, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proofs.ndjson'), ndjson([
    { type: 'proof', slug: 'alpha', phase: 1, command: 'npm   test', code: 1, tree: TREE_A, at: '2026-10-10T10:00:00Z', session_id: 's-1' },
    { type: 'proof', slug: 'alpha', phase: 2, command: 'npm run lint', code: 0, tree: TREE_B, head: 'c'.repeat(40), at: '2026-10-10T10:05:00Z' },
    // The same command re-run after the fix: it supersedes its own red.
    { type: 'proof', slug: 'alpha', phase: 1, command: 'npm test', code: 0, tree: TREE_B, at: '2026-10-10T10:10:00Z', session_id: 's-1' },
    { type: 'proof', slug: 'beta', phase: 1, command: 'npm test', code: 0, tree: TREE_A, at: '2026-10-10T10:11:00Z' },
    { type: 'proof', slug: 'alpha', phase: 3, command: 'npm test', code: 0, tree: 'not-a-tree', at: '2026-10-10T10:12:00Z' },
    '{ torn',
  ]));
  writeFileSync(join(dir, 'verifications.ndjson'), ndjson([
    { type: 'verification', slug: 'alpha', phase: 1, run: 'r1', at: '2026-10-10T09:00:00Z', kind: 'baseline', command: 'npm test', code: 0, ms: 900, ok: true },
    {
      type: 'verification', slug: 'alpha', phase: 1, run: 'r1', at: '2026-10-10T11:00:00Z', kind: 'verify', command: 'npm test',
      code: 1, ms: 1200, ok: false, failures: ['suite > case'], tail: 'not ok 1 - case', own: ['suite > case'],
    },
    { type: 'verification', slug: 'beta', phase: 1, run: 'r9', at: '2026-10-10T11:30:00Z', kind: 'verify', command: 'npm test', code: 0, ms: 5, ok: true },
    { type: 'verification', slug: 'alpha', phase: 2, run: 'r2', at: '2026-10-10T12:00:00Z', kind: 'verify', command: 'npm run lint', code: 0, ms: 300, ok: true },
    'not json',
  ]));
  return root;
}

test('both are a 409 with no source directory open, like every plan route', async () => {
  const svc = await bareService();
  try {
    for (const verb of ['proofs', 'verifications']) {
      const out = await call(svc, 'GET', `/api/run/alpha/${verb}`);
      assert.equal(out.status, 409, verb);
    }
  } finally {
    svc.close();
  }
});

test('proofs: the last proof of each command, by phase, from the file — `?phase=` narrows it', async () => {
  const svc = await service(library());
  try {
    const all = await call(svc, 'GET', '/api/run/alpha/proofs');
    assert.equal(all.status, 200);
    assert.equal(all.body.slug, 'alpha');
    assert.equal(all.body.phase, null);
    assert.deepEqual(all.body.proofs, [
      { phase: 1, command: 'npm test', code: 0, tree: TREE_B, at: '2026-10-10T10:10:00Z', session: 's-1' },
      { phase: 2, command: 'npm run lint', code: 0, tree: TREE_B, head: 'c'.repeat(40), at: '2026-10-10T10:05:00Z' },
    ], "the re-run superseded the red, another plan's line and a line with no tree are not this plan's proofs");

    const two = await call(svc, 'GET', '/api/run/alpha/proofs?phase=2');
    assert.equal(two.body.phase, 2);
    assert.deepEqual(two.body.proofs.map((p: { command: string }) => p.command), ['npm run lint']);

    const none = await call(svc, 'GET', '/api/run/gamma/proofs');
    assert.deepEqual(none.body, { slug: 'gamma', phase: null, proofs: [] }, 'a plan with no ledger proved nothing');

    for (const bad of ['0', 'x', '1.5', '-2']) {
      const refused = await call(svc, 'GET', `/api/run/alpha/proofs?phase=${bad}`);
      assert.equal(refused.status, 400, `?phase=${bad}`);
    }
  } finally {
    svc.close();
  }
});

test('the runner reads one phase exactly as before: `readProofs` is `proofRows` for that phase', () => {
  const file = join(runDir(library(), 'alpha'), 'proofs.ndjson');
  const one = readProofs(file, 'alpha', 1);
  assert.deepEqual([...one.keys()], ['npm test']);
  assert.deepEqual(one.get('npm test'), { command: 'npm test', code: 0, tree: TREE_B, at: '2026-10-10T10:10:00Z', session: 's-1' });
  assert.equal(proofRows(file, 'alpha', 1).length, 1);
  assert.deepEqual(readProofs(file, 'alpha', 3), new Map(), 'a proof with no tree is no proof');
});

test('verifications: every run of the lines, newest first — `?phase=`, `?run=` and `?limit=` narrow it', async () => {
  const svc = await service(library());
  try {
    const all = await call(svc, 'GET', '/api/run/alpha/verifications');
    assert.equal(all.status, 200);
    assert.equal(all.body.slug, 'alpha');
    assert.equal(all.body.total, 3);
    assert.equal(all.body.limit, VERIFICATIONS_PAGE);
    assert.deepEqual(all.body.rows.map((r: LedgerRow) => `${r.phase}/${r.run}/${r.kind}`), ['2/r2/verify', '1/r1/verify', '1/r1/baseline']);
    const red = all.body.rows[1] as LedgerRow;
    assert.equal(red.ok, false);
    assert.deepEqual(red.failures, ['suite > case']);
    assert.equal(red.tail, 'not ok 1 - case', 'what the red line said rides with it');

    const phase = await call(svc, 'GET', '/api/run/alpha/verifications?phase=1');
    assert.deepEqual(phase.body.rows.map((r: LedgerRow) => r.kind), ['verify', 'baseline']);
    const run = await call(svc, 'GET', '/api/run/alpha/verifications?run=r2');
    assert.deepEqual(run.body.rows.map((r: LedgerRow) => r.command), ['npm run lint']);
    const page = await call(svc, 'GET', '/api/run/alpha/verifications?limit=1');
    assert.equal(page.body.rows.length, 1);
    assert.equal(page.body.rows[0].run, 'r2', 'the newest survives the cut');
    assert.equal(page.body.total, 3, 'and the count says how many matched before it');

    for (const query of ['limit=all', 'limit=-1', 'phase=one']) {
      const refused = await call(svc, 'GET', `/api/run/alpha/verifications?${query}`);
      assert.equal(refused.status, 400, query);
    }
  } finally {
    svc.close();
  }
});

test('a slug that is not one never reaches the ledger files', async () => {
  const svc = await service(library());
  try {
    for (const verb of ['proofs', 'verifications']) {
      const out = await call(svc, 'GET', `/api/run/..%2F..%2Fsecret/${verb}`);
      assert.equal(out.status, 400, verb);
      assert.match(String(out.body.error), /slug/);
    }
  } finally {
    svc.close();
  }
});

test('ledgerPage holds its limit between one row and the maximum', () => {
  const rows = Array.from({ length: 5 }, (_, i): LedgerRow => ({
    type: 'verification', slug: 'alpha', phase: 1, run: 'r1', at: `2026-10-10T0${i}:00:00Z`, kind: 'verify',
    command: 'npm test', code: 0, ms: 1, ok: true,
  }));
  assert.equal(ledgerPage(rows, { limit: 0 }).rows.length, 1, 'zero rows is one row');
  assert.equal(ledgerPage(rows, { limit: 10 ** 9 }).limit, VERIFICATIONS_PAGE_MAX);
  assert.deepEqual(ledgerPage(rows, { limit: 2 }).rows.map((r) => r.at), ['2026-10-10T04:00:00Z', '2026-10-10T03:00:00Z']);
});
