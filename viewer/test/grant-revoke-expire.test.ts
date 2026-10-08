/**
 * RE-1..5 (control-tower phase 149, #212, §Architecture 19) — every grant is a
 * row, and every row ends: spent, expired or revoked.
 *
 * RE-1  A grant is a row — who, which door, the item, the wall, the rule, the
 *       scope, the end and EXACTLY what it changed — journalled on the run it
 *       reached (`policy.grant-applied`), the reason kept.
 * RE-2  Its end is journalled with how (`policy.grant-ended {how}`).
 * RE-3  `GET /api/permissions/grants` lists them; a revoke undoes exactly what
 *       the row says it changed, and needs no owner door.
 * RE-4  *Revoke all* ends every live grant.
 * RE-5  An expiry is swept on the console's clock — its 24 hours, or its phase
 *       settled — and the ledger is a retention sink (`retention.test.ts`).
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SLUG, call, harness, journal, type Harness } from './turn-harness.ts';

const { Grants } = await import('../server/permissions/grants.ts');
type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;
const { newRun, phaseRecord, saveRun } = await import('../server/runner/state.ts');
const { loadPolicyFor } = await import('../server/runner/approvals.ts');
const { GRANT_PHASE_MAX_MS, GRANT_ENDINGS } = await import('../shared/turn-model.js');

const AT = '2026-10-07T10:00:00.000Z';
const WALL: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(docker push:*)', command: 'docker push acme/web:1.2', at: AT, source: 'hook' };

function parked(h: Harness, wall = WALL, phase = 3) {
  const state = newRun({ slug: SLUG, root: h.root, onlyPhases: [phase] } as never);
  const record = phaseRecord(state, phase);
  record.status = 'parked';
  record.sessionId = `sess-${phase}`;
  record.endedAt = AT;
  record.walls = [wall];
  state.status = 'parked' as never;
  saveRun(state);
  const id = h.svc.raisePermissionItem({ slug: SLUG, runId: state.id, phase, sessionId: `sess-${phase}`, wall, need: 'ship the image' })!;
  return { state, id };
}

test('RE-1: a grant is a row — who, which door, the item, the wall, the rule, the scope, the end, exactly what it changed — journalled with its reason', async () => {
  const h = harness();
  try {
    const { state, id } = parked(h);
    const answer = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'phase', rule: 'Bash(docker push:*)', reason: 'the release image only' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const [row] = h.svc.grantsNow().list();
    assert.ok(row);
    assert.deepEqual(
      { by: row.by, door: row.door, item: row.item, wall: row.wall, rule: row.rule, scope: row.scope, slug: row.slug, phase: row.phase, runId: row.runId, reason: row.reason, state: row.state },
      { by: 'script', door: 'local', item: id, wall: 'deny', rule: 'Bash(docker push:*)', scope: 'phase', slug: SLUG, phase: 3, runId: state.id, reason: 'the release image only', state: 'live' },
    );
    assert.equal(Date.parse(row.until!) - Date.parse(row.at), GRANT_PHASE_MAX_MS, 'until: 24 hours at most');
    assert.deepEqual(row.changed, [
      { kind: 'hook', rule: 'Bash(docker push:*)', runId: state.id, phase: 3 },
      { kind: 'settings', runId: state.id, list: 'deny', rule: 'Bash(docker push:*)' },
    ]);
    const line = journal(h.root, state).find((one) => one.event === 'policy.grant-applied');
    assert.ok(line, 'journalled on the run it reached');
    assert.equal(line.data.id, row.id);
    assert.equal(line.data.reason, 'the release image only');
    assert.deepEqual(line.data.changed, row.changed);
  } finally { h.cleanup(); }
});

test('RE-2 / RE-3: GET lists the grants; a revoke undoes exactly what the row changed, needs no owner door, and is journalled with how', async () => {
  const h = harness();
  try {
    const { state, id } = parked(h, { ...WALL, rule: 'Bash(kubectl apply:*)', command: 'kubectl apply -f deploy.yaml' });
    assert.ok(loadPolicyFor(SLUG).deny.includes('Bash(kubectl apply:*)'));
    const granted = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'plan', rule: 'Bash(kubectl apply:*)' });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.ok(!loadPolicyFor(SLUG).deny.includes('Bash(kubectl apply:*)'), 'struck for the plan');
    const listed = await call(h.svc, 'GET', '/api/permissions/grants');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.live, 1);
    const [row] = listed.body.grants as { id: string; changed: { kind: string; op?: string }[] }[];
    assert.deepEqual(row!.changed.map((change) => `${change.kind}:${change.op}`), ['policy:strike']);
    const revoked = await call(h.svc, 'POST', `/api/permissions/grants/${row!.id}/revoke`, { reason: 'the deploy is done' });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.ok(loadPolicyFor(SLUG).deny.includes('Bash(kubectl apply:*)'), 'exactly the strike is undone');
    assert.equal((await call(h.svc, 'POST', `/api/permissions/grants/${row!.id}/revoke`, {})).status, 409, 'a revoked grant is revoked');
    assert.equal((await call(h.svc, 'POST', '/api/permissions/grants/nope/revoke', {})).status, 404);
    const ended = journal(h.root, state).find((one) => one.event === 'policy.grant-ended');
    assert.ok(ended, 'journalled');
    assert.equal(ended.data.how, 'revoked');
    assert.equal(ended.data.reason, 'the deploy is done');
    assert.deepEqual(ended.data.undone, row!.changed, 'what it undid is the row\'s change');
    assert.equal((await call(h.svc, 'POST', `/api/permissions/grants/${row!.id}/revoke`, { reason: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).status, 400, 'a secret in a body is refused whole');
  } finally { h.cleanup(); }
});

test('RE-4: Revoke all ends every live grant', async () => {
  const h = harness();
  try {
    const grants = h.svc.grantsNow();
    for (const rule of ['Bash(make a:*)', 'Bash(make b:*)', 'Bash(make c:*)']) {
      assert.ok(grants.apply({ scope: 'plan', wall: 'ask', tool: 'Bash', rule, slug: SLUG, phase: 3, runId: 'r', by: 'me', door: 'local' }).ok);
    }
    assert.equal(grants.live().length, 3);
    const answer = await call(h.svc, 'POST', '/api/permissions/grants/revoke-all', {});
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.revoked, 3);
    assert.equal(grants.live().length, 0);
    for (const rule of ['Bash(make a:*)', 'Bash(make b:*)', 'Bash(make c:*)']) assert.ok(!loadPolicyFor(SLUG).always!.includes(rule), rule);
    assert.ok(grants.list().every((row) => row.state === 'revoked'));
  } finally { h.cleanup(); }
});

test('RE-5: an expiry is swept on the console\'s clock — its 24 hours on a fake clock, or its phase settled', () => {
  let clock = Date.parse(AT);
  const file = join(mkdtempSync(join(tmpdir(), 'pc-grant-expire-')), 'grants.ndjson');
  const ended: string[] = [];
  const grants = new Grants({ file, now: () => clock, onEnded: (row) => { ended.push(`${row.id}:${row.state}`); } });
  const applied = grants.apply({ scope: 'phase', wall: 'ask', tool: 'Bash', rule: 'Bash(make e:*)', slug: SLUG, phase: 3, runId: 'r', by: 'me', door: 'local' });
  assert.ok(applied.ok);
  clock += GRANT_PHASE_MAX_MS - 1;
  assert.deepEqual(grants.sweep(() => false), [], 'a minute before its end it lives');
  clock += 2;
  const [gone] = grants.sweep(() => false);
  assert.equal(gone?.state, 'expired');
  assert.deepEqual(ended, [`${applied.row.id}:expired`]);
  assert.ok(GRANT_ENDINGS.includes(gone!.state as never));
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; how?: string });
  assert.deepEqual(lines.map((line) => line.type), ['grant', 'end'], 'append-only: the grant line, then its end');
  assert.equal(lines[1]!.how, 'expired');
});

test('RE-5: the service sweeps on its clock — a lane grant whose phase settled expires, a plan grant does not', () => {
  const h = harness();
  try {
    const { state } = parked(h);
    const grants = h.svc.grantsNow();
    const lane = grants.apply({ scope: 'phase', wall: 'ask', tool: 'Bash', rule: 'Bash(make f:*)', slug: SLUG, phase: 3, runId: state.id, by: 'me', door: 'local' });
    const plan = grants.apply({ scope: 'plan', wall: 'ask', tool: 'Bash', rule: 'Bash(make g:*)', slug: SLUG, phase: 3, runId: state.id, by: 'me', door: 'local' });
    assert.ok(lane.ok && plan.ok);
    const sweep = () => (h.svc as unknown as { sweepGrants(): void }).sweepGrants();
    sweep();
    assert.equal(grants.get(lane.row.id)?.state, 'live', 'a parked phase has not settled');
    phaseRecord(state, 3).status = 'done';
    saveRun(state);
    sweep();
    assert.equal(grants.get(lane.row.id)?.state, 'expired');
    assert.equal(grants.get(lane.row.id)?.endReason, 'its phase settled');
    assert.equal(grants.get(plan.row.id)?.state, 'live', 'a plan grant lives until it is revoked');
    grants.revokeAll('test');
  } finally { h.cleanup(); }
});
