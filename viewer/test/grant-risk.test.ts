/**
 * GR-1..5 (control-tower phase 149, #212, §Architecture 19) — risk gates the
 * press, by the grant's OWN cell (`GRANT_RISK`: wall × family × scope).
 *
 * GR-1  Low and medium are one press, through a door the table allows.
 * GR-2  High needs the rule's own text typed back; pressed without it the
 *       answer is the rule to type and the blast radius the server computed —
 *       and nothing is written. On a console with no owner key the typed rule
 *       alone does, and the item says the console has no owner key.
 * GR-3  On a console with a key, high needs the owner door touched inside five
 *       minutes: another door may only ask, a stale touch is asked again.
 * GR-4  Never is refused through every door, at every scope.
 * GR-5  A capability is granted at the machine only — phase 115's unit verb and
 *       a restart when idle — and refused through a paired device, with why.
 */

import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SLUG, call, harness } from './turn-harness.ts';

type RecordedWall = import('../server/permissions/walls.ts').RecordedWall;
const { CAPABILITY_DEVICE_REFUSAL, Grants } = await import('../server/permissions/grants.ts');
const { doorOfRequest, markReplay } = await import('../server/owner/door.ts');
const { PRESS_DOORS, AUTHORITY_ROUTES, doorMay } = await import('../shared/door-model.js');
const { GRANT_SCOPES } = await import('../shared/turn-model.js');
const { planPolicyPath, policyExtras } = await import('../server/runner/approvals.ts');

const AT = '2026-10-07T10:00:00.000Z';
const GRANT_ROW = AUTHORITY_ROUTES.find((row) => row.verb === 'grant-step')!;

function item(h: ReturnType<typeof harness>, wall: RecordedWall, phase = 3): string {
  return h.svc.raisePermissionItem({ slug: SLUG, runId: `r-${phase}`, phase, wall })!;
}

test('GR-1: low and medium are one press — no rule typed, no owner key', async () => {
  const h = harness();
  try {
    const id = item(h, { wall: 'ask', tool: 'Bash', rule: 'Bash(make lint:*)', command: 'make lint', at: AT, source: 'broker' });
    const low = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'call' });
    assert.equal(low.status, 200, JSON.stringify(low.body));
    assert.equal((low.body.granted as { risk: string }).risk, 'low');
    const other = item(h, { wall: 'mcp', tool: 'mcp__github__create_issue', rule: 'mcp__github', at: AT, source: 'cli' }, 4);
    const medium = await call(h.svc, 'POST', `/api/human-steps/${other}/grant`, { scope: 'plan' });
    assert.equal(medium.status, 200, JSON.stringify(medium.body));
    assert.equal((medium.body.granted as { risk: string }).risk, 'medium');
    h.svc.grantsNow().revokeAll('test');
  } finally { h.cleanup(); }
});

test('GR-2: high needs the rule typed back — without it, the rule and its blast radius, and nothing written', async () => {
  const h = harness();
  try {
    const id = item(h, { wall: 'deny', tool: 'Bash', rule: 'Bash(npm publish:*)', command: 'npm publish', at: AT, source: 'hook' });
    const lines = h.svc.humanStepsNow().get(id)!.lines ?? [];
    assert.ok(lines.some((line) => /This console has no owner key/.test(line)), `the item says so: ${lines.join(' | ')}`);
    const bare = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'plan' });
    assert.equal(bare.status, 400);
    assert.equal(bare.body.rule, 'Bash(npm publish:*)', 'the rule to type');
    const blast = bare.body.blast as { plans: string[]; until: string | null; sentence: string };
    assert.deepEqual(blast.plans, [SLUG]);
    assert.equal(blast.until, null);
    assert.match(blast.sentence, /every phase of alpha/);
    assert.equal(h.svc.grantsNow().list().length, 0, 'nothing recorded');
    assert.ok(!existsSync(planPolicyPath(SLUG)) || !policyExtras(planPolicyPath(SLUG)).removed.deny.includes('Bash(npm publish:*)'), 'nothing struck');
    const wrong = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'plan', rule: 'Bash(npm:*)' });
    assert.equal(wrong.status, 400, 'a different rule is not the rule');
    const typed = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope: 'plan', rule: 'Bash(npm publish:*)' });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    const row = typed.body.granted as { risk: string; unkeyed?: true; blast?: { sentence: string } };
    assert.equal(row.risk, 'high');
    assert.equal(row.unkeyed, true, 'made on a console with no owner key');
    assert.ok(row.blast?.sentence, 'the row keeps its blast radius');
    h.svc.grantsNow().revokeAll('test');
  } finally { h.cleanup(); }
});

test('GR-3: with an owner key, a high grant is the owner\'s — touched inside five minutes; another door may only ask', () => {
  const h = harness();
  try {
    const ask = {
      scope: 'phase' as const, wall: 'deny' as const, tool: 'Bash', rule: 'Bash(terraform apply:*)', slug: SLUG, phase: 3, runId: 'r', by: 'me',
      typed: 'Bash(terraform apply:*)', enrolled: true,
    };
    const grants = h.svc.grantsNow();
    const local = grants.apply({ ...ask, door: 'local' });
    assert.equal(!local.ok && local.status, 403);
    const stale = grants.apply({ ...ask, door: 'owner', fresh: false });
    assert.equal(!stale.ok && stale.status, 401);
    assert.equal(!stale.ok && stale.reassert, true);
    const fresh = grants.apply({ ...ask, door: 'owner', fresh: true });
    assert.ok(fresh.ok, JSON.stringify(fresh));
    assert.equal(fresh.row.unkeyed, undefined);
    grants.end(fresh.row.id, 'revoked', 'me');

    // The door check prices a grant by its cell, not the verb's flat tier.
    const id = item(h, { wall: 'deny', tool: 'Bash', rule: 'Bash(terraform apply:*)', command: 'terraform apply', at: AT, source: 'hook' });
    const path = `/api/human-steps/${id}/grant`;
    const priced = h.svc.pressRiskFor({ door: 'device', label: null, proof: 'push-token' } as never, GRANT_ROW, path, { scope: 'call' });
    assert.deepEqual(priced, { risk: 'high' });
    assert.equal(doorMay('owner', 'grant', { risk: 'high', mode: 'enrolled' }), 'press');
    assert.equal(doorMay('device', 'grant', { risk: 'high', mode: 'enrolled' }), 'request', 'a device may only ask for a high grant');
    const lowId = item(h, { wall: 'ask', tool: 'Bash', rule: 'Bash(make lint:*)', command: 'make lint', at: AT, source: 'broker' }, 4);
    assert.deepEqual(h.svc.pressRiskFor({ door: 'device', label: null, proof: 'push-token' } as never, GRANT_ROW, `/api/human-steps/${lowId}/grant`, { scope: 'call' }), { risk: 'low' });
    assert.equal(doorMay('device', 'grant', { risk: 'low', mode: 'enrolled' }), 'press', 'a low grant is one press from a device');
    // A card's Allow that writes a rule is priced by its cell too: remembered
    // for every plan on this machine it is high — a device may only ask.
    const { approval } = h.svc.approvals.request({
      runId: 'r-card', slug: SLUG, phase: 3, kind: 'tool', title: 'Bash: make ship', detail: 'Phase 3 wants to ship.',
      evidence: [], tool: { name: 'Bash', input: { command: 'make ship' } }, suggestedRule: 'Bash(make ship:*)',
    } as never);
    const CARD_ROW = AUTHORITY_ROUTES.find((one) => one.verb === 'answer-card')!;
    const device = { door: 'device', label: null, proof: 'push-token' } as never;
    assert.deepEqual(h.svc.pressRiskFor(device, CARD_ROW, `/api/approvals/${approval.id}`, { decision: 'allow', remember: 'global', rule: 'Bash(make ship:*)' }), { risk: 'high' });
    assert.deepEqual(h.svc.pressRiskFor(device, CARD_ROW, `/api/approvals/${approval.id}`, { decision: 'allow', remember: 'plan', rule: 'Bash(make ship:*)' }), { risk: 'medium' });
    assert.equal(h.svc.pressRiskFor(device, CARD_ROW, `/api/approvals/${approval.id}`, { decision: 'allow' }), null, 'a plain Allow is the card\'s own answer');
    // Nothing is remembered beside a card that is not up.
    const ghost = h.svc.decideApproval('no-such-card', 'allow', 'me', undefined, { scope: 'global', rule: 'Bash(make ghost:*)' });
    assert.equal(ghost.ok, false);
    assert.equal(h.svc.grantsNow().list().some((one) => one.rule === 'Bash(make ghost:*)'), false, 'no grant, no rule');
    h.svc.approvals.disarm();
  } finally { h.cleanup(); }
});

test('GR-3: the engine reads the owner key itself and fails closed — a press that proves no fresh touch makes no high grant, a card\'s included', () => {
  const h = harness();
  try {
    const grants = new Grants({ file: join(h.root, 'gr3-grants.ndjson'), enrolled: () => true });
    const ask = {
      scope: 'phase' as const, wall: 'deny' as const, tool: 'Bash', rule: 'Bash(terraform apply:*)', slug: SLUG, phase: 3, runId: 'r', by: 'me',
      typed: 'Bash(terraform apply:*)',
    };
    const silent = grants.apply({ ...ask, door: null });
    assert.equal(!silent.ok && silent.status, 403, 'a caller that names no door and says nothing of the key meets the owner door');
    const unproven = grants.apply({ ...ask, door: 'owner' });
    assert.equal(!unproven.ok && unproven.status, 401, 'an owner press whose touch is unknown is asked again — never let by');
    assert.equal(!unproven.ok && unproven.reassert, true);
    const saidAway = grants.apply({ ...ask, door: 'owner', enrolled: false });
    assert.equal(!saidAway.ok && saidAway.status, 401, 'a caller cannot say the key away');
    // A card's Allow (the widen card, a remember) skips the typed echo — never the owner door or its touch.
    const card = { ...ask, typed: null, via: 'card' as const, card: 'card-1' };
    assert.equal((r => !r.ok && r.status)(grants.apply({ ...card, door: 'device' })), 403, 'a lock-screen Allow from a device strikes nothing');
    assert.equal((r => !r.ok && r.status)(grants.apply({ ...card, door: 'owner' })), 401, 'a card answered through the owner door without a fresh touch strikes nothing');
    assert.equal(grants.list().length, 0, 'nothing refused wrote a row');
    const proven = grants.apply({ ...card, door: 'owner', fresh: true });
    assert.ok(proven.ok, JSON.stringify(proven));
    assert.equal(proven.row.unkeyed, undefined);
    grants.end(proven.row.id, 'revoked', 'me');
  } finally { h.cleanup(); }
});

test('GR-3: a press is never under-priced — read as the router reads its path, a widen card\'s Allow at its strike, an unreadable grant as high', () => {
  const h = harness();
  try {
    const local = { door: 'local', label: null, proof: 'loopback' } as never;
    const id = item(h, { wall: 'deny', tool: 'Bash', rule: 'Bash(terraform apply:*)', command: 'terraform apply', at: AT, source: 'hook' });
    assert.deepEqual(h.svc.pressRiskFor(local, GRANT_ROW, `/api/human-steps/${id}/grant`, { scope: 'plan' }), { risk: 'high' });
    assert.deepEqual(h.svc.pressRiskFor(local, GRANT_ROW, `/api//human-steps/${id}/grant`, { scope: 'plan' }), { risk: 'high' }, 'an empty segment reaches the same item, at the same price');
    assert.deepEqual(h.svc.pressRiskFor(local, GRANT_ROW, '/api/human-steps/no-such-item/grant', { scope: 'call' }), { risk: 'high' }, 'an item the pricing cannot read is priced as high');
    const CARD_ROW = AUTHORITY_ROUTES.find((one) => one.verb === 'answer-card')!;
    const widen = h.svc.approvals.offer({
      runId: 'r-widen', slug: SLUG, phase: 3, kind: 'tool', title: 'Widen Bash(terraform apply:*)', detail: 'Strike the rule for this plan.',
      evidence: [], suggestedRule: 'Bash(terraform apply:*)',
    } as never);
    for (const path of [`/api/approvals/${widen.approval.id}`, `/api//approvals/${widen.approval.id}`]) {
      assert.deepEqual(h.svc.pressRiskFor(local, CARD_ROW, path, { decision: 'allow' }), { risk: 'high' }, `the strike: ${path}`);
      assert.deepEqual(h.svc.pressRiskFor(local, CARD_ROW, path, { decision: 'allow', remember: 'plan', rule: 'Bash(make lint:*)' }), { risk: 'high' },
        'a remember for this plan rides beside the strike — priced at the higher of the two');
    }
  } finally { h.svc.approvals.disarm(); h.cleanup(); }
});

test('GR-3: a confirmed request is pressed again with the CONFIRMER\'s touch — a confirm that needed none claims none', () => {
  const touched = { door: 'owner', label: 'owner', proof: 'passkey', fresh: true } as never;
  const stale = { door: 'owner', label: 'owner', proof: 'passkey', fresh: false } as never;
  const replayOf = (reading: never) => {
    const fake = { headers: {} };
    markReplay(fake, reading);
    return doorOfRequest(fake as never, {} as never);
  };
  assert.equal(replayOf(touched).fresh, true);
  assert.equal(replayOf(touched).proof, 'owner-confirm');
  assert.equal(replayOf(stale).door, 'owner');
  assert.equal(replayOf(stale).fresh, false, 'a stale confirmer presses stale — a high grant it reaches asks for the key again');
});

test('GR-3: a card\'s answer carries its door and — for the owner\'s — whether the press proved a fresh touch, to the waiter that makes its grant', async () => {
  const h = harness();
  try {
    const card = (n: number) => h.svc.approvals.request({
      runId: 'r-card', slug: SLUG, phase: 3, kind: 'tool', title: `Bash: make ship ${n}`, detail: 'Phase 3 wants to ship.',
      evidence: [], tool: { name: 'Bash', input: { command: `make ship ${n}` } }, suggestedRule: 'Bash(make ship:*)',
    } as never);
    const owner = card(1);
    h.svc.decideApproval(owner.approval.id, 'allow', 'me', undefined, undefined, { by: 'me', via: 'api', origin: 'local', remoteUser: null, pressDoor: 'owner' } as never, true);
    const proven = await owner.decided;
    assert.equal(proven.door, 'owner');
    assert.equal(proven.fresh, true, 'the owner press proved its touch');
    const stale = card(2);
    h.svc.decideApproval(stale.approval.id, 'allow', 'me', undefined, undefined, { by: 'me', via: 'api', origin: 'local', remoteUser: null, pressDoor: 'owner' } as never);
    assert.equal((await stale.decided).fresh, undefined, 'unproven is not fresh');
    const device = card(3);
    h.svc.decideApproval(device.approval.id, 'allow', 'phone', undefined, undefined, { by: 'phone', via: 'api', origin: 'local', remoteUser: 'phone', pressDoor: 'device' } as never, true);
    const fromDevice = await device.decided;
    assert.equal(fromDevice.door, 'device');
    assert.equal(fromDevice.fresh, undefined, 'only the owner door carries a touch');
  } finally { h.svc.approvals.disarm(); h.cleanup(); }
});

test('GR-4: never is refused through every door, at every scope', async () => {
  const h = harness();
  try {
    const forced: RecordedWall = { wall: 'deny', tool: 'Bash', rule: 'Bash(git push:*)', command: 'git push --force origin main', at: AT, source: 'hook' };
    const id = item(h, forced);
    const step = h.svc.humanStepsNow().get(id)!;
    assert.equal(step.permission?.risk, 'never');
    assert.deepEqual(step.permission?.scopes, []);
    for (const scope of GRANT_SCOPES) {
      const answer = await call(h.svc, 'POST', `/api/human-steps/${id}/grant`, { scope, rule: 'Bash(git push:*)' });
      assert.equal(answer.status, 403, `${scope}: ${JSON.stringify(answer.body)}`);
      assert.match(String(answer.body.error), /No grant is offered through any door/);
    }
    for (const door of PRESS_DOORS) {
      for (const scope of GRANT_SCOPES) {
        for (const enrolled of [false, true]) {
          const refused = h.svc.grantsNow().apply({
            scope, wall: 'deny', family: 'force-push', tool: 'Bash', rule: 'Bash(git push --force:*)', slug: SLUG, phase: 3, runId: 'r',
            by: door, door, typed: 'Bash(git push --force:*)', enrolled, fresh: true,
          });
          assert.equal(!refused.ok && refused.status, 403, `${door} × ${scope}`);
        }
      }
    }
    for (const wall of ['guard', 'credential', 'sandbox', 'classifier'] as const) {
      const refused = h.svc.grantsNow().apply({ scope: 'call', wall, tool: 'Bash', rule: 'Bash(make x:*)', slug: SLUG, phase: 3, runId: 'r', by: 'me', door: 'owner', typed: 'Bash(make x:*)' });
      assert.equal(!refused.ok && refused.status, 403, wall);
    }
    const priced = h.svc.pressRiskFor({ door: 'owner', label: 'k', proof: 'owner-session', fresh: true } as never, GRANT_ROW, `/api/human-steps/${id}/grant`, { scope: 'call' });
    assert.equal(priced?.risk, 'never');
    assert.match(priced?.refusal ?? '', /No grant is offered through any door/);
    assert.equal(h.svc.grantsNow().list().length, 0, 'nothing was ever recorded');
  } finally { h.cleanup(); }
});

test('GR-5: a capability is granted at the machine only — the unit verb and a restart when idle — never from a paired device', async () => {
  const h = harness();
  try {
    const id = item(h, { wall: 'capability', tool: 'Bash', rule: '--allow-publish', command: 'git push origin pe/alpha', at: AT, source: 'landing' });
    const step = h.svc.humanStepsNow().get(id)!;
    assert.deepEqual(step.permission?.scopes, ['always'], 'its one scope is the machine');
    const device = await h.svc.grantHumanStep(id, { scope: 'always', rule: '--allow-publish' }, { by: 'phone', door: 'device' });
    assert.equal(!device.ok && device.status, 403);
    assert.equal(!device.ok && device.error, CAPABILITY_DEVICE_REFUSAL);
    assert.match(CAPABILITY_DEVICE_REFUSAL, /at the machine only — never from a paired device/);
    const priced = h.svc.pressRiskFor({ door: 'device', label: null, proof: 'push-token' } as never, GRANT_ROW, `/api/human-steps/${id}/grant`, { scope: 'always' });
    assert.equal(priced?.refusal, CAPABILITY_DEVICE_REFUSAL, 'the door check refuses it before the route');
  } finally { h.cleanup(); }
});
