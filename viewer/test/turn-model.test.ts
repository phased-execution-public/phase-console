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
 *   TM-4..7  the card contract (turn-by-turn phase 1) — see its block below.
 */
import './state-sandbox.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HUMAN_STEP_BIRTHS, HUMAN_STEP_KINDS, HUMAN_STEP_STATES } from '../shared/human-step-model.js';
import {
  G4_REASONS, GRANT_RISK, GRANT_SCOPES, GRANT_STATES, GUARD_REFUSAL_EXIT, HANDLED_SOURCES, KIND_REASONS,
  PROOF_TYPES, PROOF_TYPES_SELF, REASON_META, RISK_TIERS, TURN_GROUPS, TURN_GROUP_LABEL, TURN_OPEN_GROUPS, VERDICTS, WALLS,
  WHY_PERSON, WHY_SOURCES, defaultReason, groupOf, inferProofType, reasonAllowed, riskOf, whyPersonWords,
  CHECKED_BY_LABEL, ITEM_TYPES, KIND_TYPE, PERSON_STATUSES, PERSON_STATUS_LABEL, READINESS, READINESS_LABEL, ROUTE_META,
  ROUTE_TO, SOURCE_APPROVES, SOURCE_ROUTE, STATE_PERSON_STATUS, TURN_RECORDS, TURN_SOURCES, TYPE_META, personStatusOf,
  readinessOf, readinessShown, routeOf, typeOf,
} from '../shared/turn-model.js';

test('TM-1: the lists, frozen, each word once, in the plan’s order', () => {
  const lists: [string, readonly string[], string[]][] = [
    ['WHY_PERSON', WHY_PERSON, ['permission', 'identity', 'secret', 'money', 'legal', 'decision', 'physical', 'reach', 'third-party', 'reserved']],
    ['PROOF_TYPES', PROOF_TYPES, ['probe', 'answer', 'judgement', 'attest', 'grant']],
    ['VERDICTS', VERDICTS, ['passed', 'rejected', 'needs-info']],
    ['GRANT_SCOPES', GRANT_SCOPES, ['call', 'phase', 'plan', 'repository', 'always']],
    ['RISK_TIERS', RISK_TIERS, ['low', 'medium', 'high', 'never']],
    ['GRANT_STATES', GRANT_STATES, ['live', 'spent', 'expired', 'revoked']],
    ['TURN_GROUPS', TURN_GROUPS, ['approve', 'now', 'decide', 'checking', 'upcoming', 'done']],
    ['HANDLED_SOURCES', HANDLED_SOURCES, ['guard', 'auto-grant', 'relay-rule', 'ladder', 'supervisor', 'session', 'console']],
    ['WALLS', WALLS, ['deny', 'ask', 'allow-list', 'mcp', 'capability', 'credential', 'guard', 'sandbox', 'classifier']],
  ];
  for (const [name, list, words] of lists) {
    assert.ok(Object.isFrozen(list), `${name} is frozen`);
    assert.deepEqual([...list], words, `${name} is the plan's words, in its order`);
    assert.equal(new Set(list).size, list.length, `${name} names each word once`);
  }
  assert.deepEqual([...WHY_SOURCES], ['declared', 'inferred']);
  assert.deepEqual(Object.keys(TURN_GROUP_LABEL), [...TURN_GROUPS], 'every group has its page label');
  // The groups v2 (turn-by-turn phase 9): the plan's six labels, in its order; the open three first.
  assert.deepEqual(Object.values(TURN_GROUP_LABEL), ['Approve', 'Do now', 'Decide', 'Being checked', 'Coming up', 'Done']);
  assert.deepEqual([...TURN_OPEN_GROUPS], ['approve', 'now', 'decide']);
  assert.ok(Object.isFrozen(TURN_OPEN_GROUPS));
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
  // The groups v2 (turn-by-turn phase 9): by type — a check by eye, a permission and a grant are approvals.
  assert.equal(groupOf({ state: 'opened', kind: 'person-check', proofType: 'answer' }), 'approve');
  assert.equal(groupOf({ state: 'notified', kind: 'permission', proofType: 'grant' }), 'approve');
  assert.equal(groupOf({ kind: 'decision', source: 'gate', record: 'projected', proofType: 'answer' }), 'approve', 'a gate is a yes or no');
  assert.equal(groupOf({ kind: 'decision', source: 'qa', record: 'projected', proofType: 'answer' }), 'decide');
  // …by the card's words when they are given: the type, the readiness, the person's status.
  assert.equal(groupOf({ type: 'approve' }), 'approve');
  assert.equal(groupOf({ type: 'decide' }), 'decide');
  assert.equal(groupOf({ type: 'do' }), 'now');
  assert.equal(groupOf({ type: 'do', readiness: 'not-yet' }), 'upcoming', 'NOT YET is coming up');
  assert.equal(groupOf({ type: 'approve', personStatus: 'checking' }), 'checking');
  for (const status of ['passed', 'not-doing', 'closed']) {
    assert.equal(groupOf({ type: 'decide', personStatus: status }), 'done', `${status} is done`);
  }
  assert.equal(groupOf({ type: 'approve', personStatus: 'owner' }), 'approve', 'waiting for the owner is still an approval');
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

/* ------------------------------------------------------------------ *
 * The card contract (turn-by-turn phase 1, §Architecture 2) — TM-4..7
 *
 *   TM-4  the five tables: members, labels, frozen, keyed by exactly their lists.
 *   TM-5  totality: every kind × source × record × proof type × state answers
 *         exactly one word from each derivation, in both editions.
 *   TM-6  the plan's edge cases, one assertion each.
 *   TM-7  the ledger's states told as a person's status; readiness and its clock.
 * ------------------------------------------------------------------ */

test('TM-4: the card contract’s tables — members, labels, each keyed by exactly its list', () => {
  const lists: [string, readonly string[], string[]][] = [
    ['ITEM_TYPES', ITEM_TYPES, ['approve', 'do', 'decide', 'know']],
    ['PERSON_STATUSES', PERSON_STATUSES, ['todo', 'checking', 'passed', 'redo', 'not-doing', 'closed', 'owner']],
    ['READINESS', READINESS, ['now', 'not-yet']],
    ['ROUTE_TO', ROUTE_TO, ['phase', 'supervisor', 'run', 'gate', 'console']],
    ['TURN_RECORDS', TURN_RECORDS, ['ledger', 'projected', 'request']],
    ['TURN_SOURCES', TURN_SOURCES, [
      'plan', 'session', 'errand', 'preflight', 'relay', 'stall', 'supervisor',
      'approval', 'gate', 'plan-approval', 'qa', 'question', 'person-check', 'sign-in', 'mcp-auth', 'conflict', 'session-ask',
      'request', 'run-request',
    ]],
  ];
  for (const [name, list, words] of lists) {
    assert.ok(Object.isFrozen(list), `${name} is frozen`);
    assert.deepEqual([...list], words, `${name} is the plan's words, in its order`);
    assert.equal(new Set(list).size, list.length, `${name} names each word once`);
  }
  assert.deepEqual(Object.fromEntries(ITEM_TYPES.map((type) => [type, TYPE_META[type].label])),
    { approve: 'Approval', do: 'Task', decide: 'Decision', know: 'Heads-up' });
  for (const type of ITEM_TYPES) assert.ok(TYPE_META[type].sense.endsWith('.'), `${type}: a one-line sense`);
  assert.deepEqual({ ...PERSON_STATUS_LABEL }, {
    todo: 'To do', checking: 'Checking', passed: 'Passed', redo: 'Redo', 'not-doing': 'Not doing', closed: 'Closed',
    owner: 'Waiting for the owner',
  });
  assert.deepEqual({ ...READINESS_LABEL }, { now: 'Now', 'not-yet': 'Not yet' });
  assert.deepEqual(Object.keys(ROUTE_META), [...ROUTE_TO]);
  for (const route of ROUTE_TO) assert.ok(ROUTE_META[route].label && ROUTE_META[route].resumes, `${route}: a label and who resumes`);
  // *Checked by* is a label map over the proof types — never a second list.
  assert.deepEqual(Object.keys(CHECKED_BY_LABEL), [...PROOF_TYPES]);
  assert.deepEqual(Object.keys(KIND_TYPE).sort(), [...HUMAN_STEP_KINDS].sort(), 'KIND_TYPE keyed by exactly the kinds');
  assert.deepEqual(Object.keys(STATE_PERSON_STATUS), [...HUMAN_STEP_STATES], 'STATE_PERSON_STATUS keyed by exactly the states');
  assert.deepEqual(Object.keys(SOURCE_APPROVES), [...TURN_SOURCES], 'SOURCE_APPROVES keyed by exactly the sources');
  assert.deepEqual(Object.keys(SOURCE_ROUTE), [...TURN_SOURCES], 'SOURCE_ROUTE keyed by exactly the sources');
  for (const route of Object.values(SOURCE_ROUTE)) assert.notEqual(route, 'supervisor', 'the edition, not the table, says supervisor');
});

test('TM-5: every kind × source × record × proof type × state answers exactly one word, in both editions', () => {
  const births = [undefined, ...HUMAN_STEP_BIRTHS];
  let cells = 0;
  for (const kind of HUMAN_STEP_KINDS) {
    for (const source of TURN_SOURCES) {
      for (const record of TURN_RECORDS) {
        for (const proofType of [undefined, ...PROOF_TYPES]) {
          for (const hasOptions of [false, true]) {
            const type = typeOf({ kind, source, record, proofType, hasOptions });
            assert.ok((ITEM_TYPES as readonly string[]).includes(type), `${kind}/${source}/${record}/${proofType}: ${type}`);
            assert.notEqual(type, 'know', 'only an unbound row is a heads-up');
            cells += 1;
          }
        }
        for (const birth of births) {
          for (const edition of ['free', 'pro']) {
            for (const waiters of [[], [{ phase: 0 }], [{ phase: 3 }]]) {
              const route = routeOf({ birth, source, record, waiters, phase: 2, edition });
              assert.ok((ROUTE_TO as readonly string[]).includes(route), `${birth}/${source}/${record}/${edition}: ${route}`);
              if (edition === 'free') assert.notEqual(route, 'supervisor', 'Free has no supervisor: it answers the run');
              if (edition === 'pro') assert.notEqual(route, 'run', 'Pro tells the run-level route as the supervisor');
            }
          }
        }
      }
    }
  }
  assert.ok(cells > 1000, 'the walk actually walked');
  for (const state of [...HUMAN_STEP_STATES, undefined, null, 'nonsense']) {
    for (const record of TURN_RECORDS) {
      for (const verdict of [undefined, ...VERDICTS]) {
        const status = personStatusOf({ state, verdict, record });
        assert.ok((PERSON_STATUSES as readonly string[]).includes(status), `${state}/${record}/${verdict}: ${status}`);
      }
    }
    for (const dueWhen of [undefined, 'phase:alpha/1']) {
      for (const startAt of [undefined, '2026-10-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z']) {
        const readiness = readinessOf({ state, dueWhen, startAt, now: Date.parse('2026-10-12T00:00:00.000Z') });
        assert.ok((READINESS as readonly string[]).includes(readiness), `${state}/${dueWhen}/${startAt}: ${readiness}`);
      }
    }
  }
  assert.equal(typeOf({ bound: false, kind: 'operator-act', source: 'plan', record: 'ledger' }), 'know', 'an unbound errand row is a heads-up');
});

test('TM-6: the edge cases the plan pins', () => {
  // A projected errand on a run-level halt — the ladder's own ask — is a
  // decision, and goes to the run (Free) or the supervisor (Pro).
  const errand = { kind: 'operator-act', source: 'errand', record: 'projected', proofType: 'answer' } as const;
  assert.equal(typeOf(errand), 'decide');
  assert.equal(routeOf({ ...errand, edition: 'free' }), 'run');
  assert.equal(routeOf({ ...errand, edition: 'pro' }), 'supervisor');
  // …while a person errand the console raised as a ledger item resumes its phase.
  assert.equal(routeOf({ source: 'errand', record: 'ledger', birth: 'console', edition: 'pro' }), 'phase');
  // A plan's `operator-act` is a task: the console's when its waiter is phase 0
  // (the plan's own errand), the phase's otherwise.
  const planAct = { kind: 'operator-act', source: 'plan', record: 'ledger', birth: 'plan', proofType: 'attest' } as const;
  assert.equal(typeOf(planAct), 'do');
  assert.equal(routeOf({ ...planAct, waiters: [{ phase: 0 }] }), 'console');
  assert.equal(routeOf({ ...planAct, waiters: [], phase: 0 }), 'console', 'no waiter: its own phase speaks');
  assert.equal(routeOf({ ...planAct, waiters: [{ phase: 4 }] }), 'phase');
  assert.equal(routeOf({ ...planAct, waiters: [{ phase: 0 }, { phase: 4 }] }), 'phase', 'a phase waits on it: that phase resumes');
  // A manual gate is an approval, and goes to the gate.
  const gate = { kind: 'decision', source: 'gate', record: 'projected', proofType: 'answer' } as const;
  assert.equal(typeOf(gate), 'approve');
  assert.equal(routeOf(gate), 'gate');
  // An owner request waits for the owner, is an approval, and the console presses it.
  assert.equal(personStatusOf({ record: 'request' }), 'owner');
  assert.equal(typeOf({ kind: 'decision', source: 'request', record: 'request', proofType: 'answer' }), 'approve');
  assert.equal(routeOf({ source: 'request', record: 'request', edition: 'pro' }), 'console');
  // An upcoming step is not yet due.
  assert.equal(readinessOf({ state: 'upcoming', dueWhen: 'phase:alpha/1' }), 'not-yet');
  assert.equal(readinessOf({ state: 'declared', dueWhen: 'phase:alpha/1' }), 'now', 'its ref landed: it is due');
  // The rest of the type table, by source.
  assert.equal(typeOf({ kind: 'permission', source: 'approval', record: 'projected', proofType: 'grant' }), 'approve');
  assert.equal(typeOf({ kind: 'permission', source: 'session', record: 'ledger', proofType: 'grant' }), 'approve');
  assert.equal(typeOf({ kind: 'decision', source: 'plan-approval', record: 'projected', proofType: 'answer' }), 'approve');
  assert.equal(typeOf({ kind: 'person-check', source: 'person-check', record: 'projected', proofType: 'answer' }), 'approve');
  assert.equal(typeOf({ kind: 'operator-act', source: 'supervisor', record: 'projected', proofType: 'attest' }), 'approve',
    'a supervisor suggestion card is a yes or no');
  assert.equal(typeOf({ kind: 'operator-act', source: 'supervisor', record: 'ledger', proofType: 'attest' }), 'do',
    'the supervisor raising an act for a person is a task');
  assert.equal(typeOf({ kind: 'decision', source: 'qa', record: 'projected', proofType: 'answer' }), 'decide');
  assert.equal(typeOf({ kind: 'decision', source: 'conflict', record: 'projected', proofType: 'answer' }), 'decide');
  assert.equal(typeOf({ kind: 'decision', source: 'relay', record: 'ledger', proofType: 'answer', hasOptions: true }), 'decide');
  assert.equal(typeOf({ kind: 'claude-login', source: 'sign-in', record: 'projected', proofType: 'probe' }), 'do');
  assert.equal(typeOf({ kind: 'browser-login', source: 'session', record: 'ledger', proofType: 'probe' }), 'do');
  assert.equal(typeOf({ kind: 'secret-entry', source: 'preflight', record: 'ledger', proofType: 'probe' }), 'do');
  assert.equal(typeOf({ kind: 'operator-act', source: 'session', record: 'ledger', proofType: 'attest', hasApproval: true }), 'approve');
  // The rest of the route table.
  assert.equal(routeOf({ source: 'session', birth: 'session', record: 'ledger' }), 'phase');
  assert.equal(routeOf({ source: 'preflight', birth: 'console', record: 'ledger' }), 'console');
  assert.equal(routeOf({ source: 'sign-in', record: 'projected' }), 'console');
  assert.equal(routeOf({ source: 'approval', record: 'projected', edition: 'pro' }), 'phase');
  assert.equal(routeOf({ source: 'conflict', record: 'projected', edition: 'free' }), 'run');
  assert.equal(routeOf({ source: 'supervisor', birth: 'supervisor', record: 'ledger', edition: 'pro' }), 'supervisor');
  assert.equal(routeOf({ source: 'supervisor', birth: 'supervisor', record: 'ledger', edition: 'free' }), 'run');
});

test('TM-7: the eleven states told as a person’s status; readiness and its clock', () => {
  assert.deepEqual(Object.fromEntries(HUMAN_STEP_STATES.map((state) => [state, personStatusOf({ state, record: 'ledger' })])), {
    upcoming: 'todo', declared: 'todo', notified: 'todo', opened: 'todo', checking: 'checking', returned: 'redo',
    proven: 'passed', declined: 'not-doing', expired: 'closed', cannot: 'not-doing', dismissed: 'closed',
  });
  // A projected card has no ledger state: its verdict speaks, else it is to do.
  assert.equal(personStatusOf({ record: 'projected' }), 'todo');
  assert.equal(personStatusOf({ record: 'projected', verdict: 'passed' }), 'passed');
  assert.equal(personStatusOf({ record: 'projected', verdict: 'rejected' }), 'redo');
  assert.equal(personStatusOf({ record: 'projected', verdict: 'needs-info' }), 'redo');
  assert.equal(personStatusOf({ state: 'proven', verdict: 'rejected', record: 'ledger' }), 'passed', 'the ledger state outranks an old verdict');
  const now = Date.parse('2026-10-12T12:00:00.000Z');
  assert.equal(readinessOf({ state: 'notified', now }), 'now');
  assert.equal(readinessOf({ dueWhen: 'date:2026-10-13T00:00:00Z', now }), 'not-yet', 'a stateless item still waiting on its ref');
  assert.equal(readinessOf({ state: 'notified', startAt: '2026-10-13T00:00:00.000Z', now }), 'not-yet', 'its start is ahead');
  assert.equal(readinessOf({ state: 'notified', startAt: '2026-10-11T00:00:00.000Z', now }), 'now', 'its start has passed');
  assert.equal(readinessOf({ state: 'notified', startAt: 'not a date', now }), 'now');
  assert.deepEqual(PERSON_STATUSES.filter(readinessShown), ['todo', 'redo'], 'readiness is drawn only while the act is still theirs');
});

test('#332: why only a person fits an item is said ONCE — the sentence, capitalised, never the label before it', () => {
  for (const why of WHY_PERSON) {
    const words = whyPersonWords(why);
    const { label, sentence } = REASON_META[why];
    assert.equal(words, `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`, why);
    assert.ok(!words.includes(`${label}:`), `${why}: the label is not said before the sentence`);
  }
  assert.equal(whyPersonWords('secret'), 'Only you hold the secret it needs.');
  assert.equal(whyPersonWords('nonsense'), 'Its reason is nonsense.');
});
