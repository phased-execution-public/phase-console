/**
 * Your turn's vocabulary (control-tower phase 130, #207) — TM-1..3.
 *
 *   TM-1  the lists, each frozen, each word once, in the plan's order.
 *   TM-2  `KIND_REASONS` is total over the eighteen kinds, every reason a
 *         `WHY_PERSON` word, the first the kind's default; `G4_REASONS` is the
 *         three that claim the AI cannot, derived from `REASON_META`.
 *   TM-3  `groupOf` is total over the eleven states; the risk table names only
 *         its own words and answers the plan's tiers; a proof type is inferred
 *         from what an item carries.
 */
import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HUMAN_STEP_KINDS, HUMAN_STEP_STATES } from '../shared/human-step-model.js';
import {
  G4_REASONS, GRANT_RISK, GRANT_SCOPES, GRANT_STATES, GUARD_REFUSAL_EXIT, HANDLED_SOURCES, KIND_REASONS,
  PROOF_TYPES, PROOF_TYPES_SELF, REASON_META, RISK_TIERS, TURN_GROUPS, TURN_GROUP_LABEL, VERDICTS, WALLS,
  WHY_PERSON, WHY_SOURCES, defaultReason, groupOf, inferProofType, reasonAllowed, riskOf,
} from '../shared/turn-model.js';

test('TM-1: the lists, frozen, each word once, in the plan’s order', () => {
  const lists: [string, readonly string[], string[]][] = [
    ['WHY_PERSON', WHY_PERSON, ['permission', 'identity', 'secret', 'money', 'legal', 'decision', 'physical', 'reach', 'third-party', 'reserved']],
    ['PROOF_TYPES', PROOF_TYPES, ['probe', 'answer', 'judgement', 'attest', 'grant']],
    ['VERDICTS', VERDICTS, ['passed', 'rejected', 'needs-info']],
    ['GRANT_SCOPES', GRANT_SCOPES, ['call', 'phase', 'plan', 'repository', 'always']],
    ['RISK_TIERS', RISK_TIERS, ['low', 'medium', 'high', 'never']],
    ['GRANT_STATES', GRANT_STATES, ['live', 'spent', 'expired', 'revoked']],
    ['TURN_GROUPS', TURN_GROUPS, ['now', 'decide', 'upcoming', 'checking', 'done']],
    ['HANDLED_SOURCES', HANDLED_SOURCES, ['guard', 'auto-grant', 'relay-rule', 'ladder', 'supervisor', 'session']],
    ['WALLS', WALLS, ['deny', 'ask', 'allow-list', 'mcp', 'capability', 'credential', 'guard', 'sandbox', 'classifier']],
  ];
  for (const [name, list, words] of lists) {
    assert.ok(Object.isFrozen(list), `${name} is frozen`);
    assert.deepEqual([...list], words, `${name} is the plan's words, in its order`);
    assert.equal(new Set(list).size, list.length, `${name} names each word once`);
  }
  assert.deepEqual([...WHY_SOURCES], ['declared', 'inferred']);
  assert.deepEqual(Object.keys(TURN_GROUP_LABEL), [...TURN_GROUPS], 'every group has its page label');
  assert.equal(GUARD_REFUSAL_EXIT, 4, 'exit 4: the AI can do this itself — never 2 (usage) or 3 (already true)');
});

test('TM-2: KIND_REASONS is total over the eighteen kinds; the first reason is the default', () => {
  assert.equal(HUMAN_STEP_KINDS.length, 18);
  assert.deepEqual(Object.keys(KIND_REASONS).sort(), [...HUMAN_STEP_KINDS].sort(), 'keyed by exactly the kinds');
  for (const kind of HUMAN_STEP_KINDS) {
    const reasons = KIND_REASONS[kind];
    assert.ok(reasons.length > 0, `${kind}: at least one reason`);
    assert.equal(new Set(reasons).size, reasons.length, `${kind}: each reason once`);
    for (const why of reasons) assert.ok((WHY_PERSON as readonly string[]).includes(why), `${kind}: ${why} is a WHY_PERSON word`);
    assert.equal(defaultReason(kind), reasons[0], `${kind}: the default is the first`);
    assert.ok(reasonAllowed(kind, reasons[0]!));
  }
  // An operator's act is the general act on the person's side: any reason.
  assert.deepEqual([...KIND_REASONS['operator-act']].sort(), [...WHY_PERSON].sort());
  assert.deepEqual([...KIND_REASONS.permission], ['permission']);
  // A sign-in is identity — never a reason G4 judges.
  assert.equal(defaultReason('browser-login'), 'identity');
  assert.equal(reasonAllowed('browser-login', 'money'), false);
  assert.equal(reasonAllowed('no-such-kind', 'identity'), false);
  assert.equal(reasonAllowed('decision', 'no-such-reason'), false);
  // Every reason says what it means, and which side of G4 it is on.
  assert.deepEqual(Object.keys(REASON_META).sort(), [...WHY_PERSON].sort());
  assert.deepEqual([...G4_REASONS], ['permission', 'reach', 'reserved'], 'the three that claim the AI cannot, in WHY_PERSON order');
  for (const why of WHY_PERSON) {
    assert.equal(REASON_META[why].cannot, (G4_REASONS as readonly string[]).includes(why), `${why}: G4 judges exactly the "cannot" reasons`);
    assert.ok(REASON_META[why].label && REASON_META[why].sentence, `${why}: a label and a sentence`);
  }
});

test('TM-3: groupOf is total over the eleven states, and derived — never stored', () => {
  assert.equal(HUMAN_STEP_STATES.length, 11);
  for (const state of HUMAN_STEP_STATES) {
    assert.ok((TURN_GROUPS as readonly string[]).includes(groupOf({ state, kind: 'browser-login' })), `${state}: a group`);
  }
  assert.equal(groupOf({ state: 'upcoming', kind: 'operator-act' }), 'upcoming');
  assert.equal(groupOf({ state: 'checking', kind: 'browser-login' }), 'checking');
  assert.equal(groupOf({ state: 'notified', kind: 'browser-login' }), 'now');
  assert.equal(groupOf({ state: 'returned', kind: 'operator-act' }), 'now', 'sent back: the person redoes it');
  assert.equal(groupOf({ state: 'notified', kind: 'decision' }), 'decide');
  assert.equal(groupOf({ state: 'opened', kind: 'person-check', proofType: 'answer' }), 'decide');
  for (const state of ['proven', 'declined', 'expired', 'cannot', 'dismissed']) {
    assert.equal(groupOf({ state, kind: 'decision' }), 'done', `${state} is done`);
  }
  assert.equal(groupOf({ state: 'nonsense' }), 'now', 'an unknown word is still drawn somewhere');
});

test('TM-3: the risk table speaks only its own words and answers the plan’s tiers', () => {
  for (const row of GRANT_RISK) {
    assert.ok(row.wall === '*' || (WALLS as readonly string[]).includes(row.wall), `wall ${row.wall}`);
    assert.ok(row.scope === '*' || (GRANT_SCOPES as readonly string[]).includes(row.scope), `scope ${row.scope}`);
    assert.ok((RISK_TIERS as readonly string[]).includes(row.tier), `tier ${row.tier}`);
  }
  // never — forced pushes, the host family, every guard, a protected path, a secret's value
  for (const family of ['force-push', 'host', 'protected-path', 'secret-value']) {
    for (const scope of GRANT_SCOPES) assert.equal(riskOf({ wall: 'ask', family, scope }), 'never', `${family} at ${scope}`);
  }
  assert.equal(riskOf({ wall: 'guard', scope: 'call' }), 'never');
  // high — any deny-wall rule, any `always`, a capability
  assert.equal(riskOf({ wall: 'deny', scope: 'call' }), 'high');
  assert.equal(riskOf({ wall: 'ask', scope: 'always' }), 'high');
  assert.equal(riskOf({ wall: 'capability', scope: 'phase' }), 'high');
  // low and medium — one press
  assert.equal(riskOf({ wall: 'ask', scope: 'call' }), 'low');
  assert.equal(riskOf({ wall: 'allow-list', scope: 'plan' }), 'medium');
  assert.equal(riskOf({ wall: 'mcp', scope: 'repository' }), 'medium');
  assert.equal(riskOf({ wall: 'nonsense', scope: 'call' }), 'high', 'a combination no row names is the safe side');
});

test('TM-3: a proof type is inferred from what an item carries; three need nothing to read', () => {
  assert.deepEqual([...PROOF_TYPES_SELF], ['answer', 'attest', 'grant']);
  assert.equal(inferProofType({ kind: 'permission' }), 'grant');
  assert.equal(inferProofType({ kind: 'browser-login', proof: 'cmd:"gh auth status"' }), 'probe');
  assert.equal(inferProofType({ kind: 'decision' }), 'answer');
  assert.equal(inferProofType({ kind: 'person-check' }), 'answer');
  assert.equal(inferProofType({ kind: 'operator-act', proofWords: 'the DNS record resolves' }), 'judgement');
  assert.equal(inferProofType({ kind: 'operator-act' }), null, 'nothing to read: the door refuses it (G2)');
});
