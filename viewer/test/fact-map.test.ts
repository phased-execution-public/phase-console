/**
 * THE FACT MAP IS TOTAL, OR IT IS A SECOND DERIVATION.
 *
 * A lookup table that answers for MOST situations is worse than no table: every
 * caller then needs a fallback, and a fallback is a derivation — which is the
 * thing `shared/fact-map.js` exists to delete. So the bar here is totality in
 * three directions at once, asserted against the OWNERS of each vocabulary
 * rather than against a list copied into this file:
 *
 *   1. every situation id has facts, and every `SITUATIONS × SUB_KINDS` pair
 *      resolves through `factsFor` to a mapped answer;
 *   2. every halt kind names a situation, and that situation exists;
 *   3. every inbox kind is `derived` or `independent`, and every kind the map
 *      can produce is a real inbox kind.
 *
 * The fourth assertion is the negative one and the easiest to forget: the map
 * must not invent a word. A `pushCategory` that is not in the catalogue is a
 * notification that silently never sends, and a `haltKind` that is not a halt
 * kind is a card that paints nothing.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DECLARED_SITUATION,
  HALT_KIND_SITUATION,
  INBOX_KIND_SOURCE,
  SITUATION_FACTS,
  SITUATION_SUB_FACTS,
  STALL_SIGNAL_KIND,
  factsFor,
} from '../shared/fact-map.js';
import { INBOX_KINDS, STALL_KINDS, STALL_SIGNALS } from '../shared/attention-model.js';
import { HALT_KINDS } from '../shared/recovery-model.js';
import { SITUATIONS, SUB_KINDS, situationKey } from '../shared/situation-model.js';
import { OUTCOME_STATUSES } from '../shared/run-lifecycle.js';
import { CATEGORIES } from '../server/push/catalogue.ts';

const sorted = (xs: readonly string[]) => [...xs].sort();
const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as readonly string[];

test('every situation is mapped exactly once, and nothing else is', () => {
  assert.deepEqual(sorted(Object.keys(SITUATION_FACTS)), sorted(SITUATIONS));
});

test('every SITUATIONS x SUB_KINDS row resolves to a mapped answer', () => {
  for (const id of SITUATIONS) {
    const subs = SUB_KINDS[id] ?? [];
    // The bare id first — a situation with sub-kinds is still reachable without
    // one (the classifier only names a sub-kind when it can).
    const bare = factsFor(id);
    assert.ok(bare, `${id} resolves to nothing`);
    assert.equal(bare, SITUATION_FACTS[id], `${id} must resolve to its own row, not a fallback`);
    for (const sub of subs) {
      const facts = factsFor(id, sub);
      assert.ok(facts, `${situationKey(id, sub)} resolves to nothing`);
      // Whether or not a sub-kind overrides, the resolved row must carry every
      // field the parent did — an override is a PATCH, never a replacement.
      for (const field of ['inboxKind', 'pushCategory'] as const) {
        assert.ok(field in facts, `${situationKey(id, sub)} lost \`${field}\``);
      }
    }
  }
});

test('every sub-kind override names a real situation and a real sub-kind', () => {
  for (const key of Object.keys(SITUATION_SUB_FACTS)) {
    const [id, sub] = key.split(':');
    assert.ok((SITUATIONS as readonly string[]).includes(id), `${key}: ${id} is not a situation`);
    assert.ok(
      (SUB_KINDS[id] ?? []).includes(sub),
      `${key}: ${sub} is not a sub-kind of ${id}`,
    );
  }
});

test('the map invents no inbox kind, push category or halt kind', () => {
  const rows = [
    ...Object.entries(SITUATION_FACTS),
    ...Object.entries(SITUATION_SUB_FACTS),
  ] as [string, Record<string, unknown>][];
  for (const [key, facts] of rows) {
    const kind = facts.inboxKind as string | null | undefined;
    if (kind != null) {
      assert.ok((INBOX_KINDS as readonly string[]).includes(kind), `${key}: '${kind}' is not an inbox kind`);
    }
    const category = facts.pushCategory as string | null | undefined;
    if (category != null) {
      assert.ok(CATEGORY_IDS.includes(category), `${key}: '${category}' is not a push category`);
    }
    const halt = facts.haltKind as string | undefined;
    if (halt != null) {
      assert.ok((HALT_KINDS as readonly string[]).includes(halt), `${key}: '${halt}' is not a halt kind`);
    }
  }
});

test('every halt kind names a situation that exists', () => {
  assert.deepEqual(
    sorted(Object.keys(HALT_KIND_SITUATION)),
    sorted(HALT_KINDS),
    'HALT_KIND_SITUATION must be total over HALT_KINDS — a halt with no situation is a stop nothing can classify',
  );
  for (const [halt, id] of Object.entries(HALT_KIND_SITUATION)) {
    assert.ok((SITUATIONS as readonly string[]).includes(id), `${halt} maps to '${id}', which is not a situation`);
  }
});

test('every declarable outcome that PARKS names a situation', () => {
  // `no-defect` is a RECOVERY session's word — an ordinary phase session cannot
  // declare it — so it is deliberately not in this table. The other five are.
  assert.deepEqual(
    sorted(Object.keys(DECLARED_SITUATION)),
    sorted(OUTCOME_STATUSES.filter((s) => s !== 'no-defect')),
  );
  for (const [status, id] of Object.entries(DECLARED_SITUATION)) {
    assert.ok((SITUATIONS as readonly string[]).includes(id), `${status} maps to '${id}', which is not a situation`);
  }
});

test('every stall signal has an entry, and each named kind is a real stall kind', () => {
  assert.deepEqual(sorted(Object.keys(STALL_SIGNAL_KIND)), sorted(STALL_SIGNALS));
  for (const [signal, kind] of Object.entries(STALL_SIGNAL_KIND)) {
    if (kind === null) continue;
    assert.ok((STALL_KINDS as readonly string[]).includes(kind), `${signal} maps to '${kind}', which is not a stall kind`);
  }
  // `null` is a mapped answer, not a hole: it says a detector does not exist
  // yet. Asserting WHICH ones are null keeps that a decision — a signal that
  // silently went null would be a row that stopped being raised.
  const unmapped = Object.entries(STALL_SIGNAL_KIND).filter(([, k]) => k === null).map(([s]) => s);
  // `looping` (phase 13) is null by design rather than by omission: the one
  // signal with no remedy, said once as `phase.suspect` for a person to judge.
  assert.deepEqual(sorted(unmapped), sorted(['stalemate', 'spinning', 'looping']));
});

test('every inbox kind declares where its rows come from', () => {
  assert.deepEqual(sorted(Object.keys(INBOX_KIND_SOURCE)), sorted(INBOX_KINDS));
  for (const [kind, source] of Object.entries(INBOX_KIND_SOURCE)) {
    assert.ok(source === 'derived' || source === 'independent', `${kind}: '${source}' is not a source`);
  }
  // Every kind the situation map can PRODUCE must be one it calls derived —
  // otherwise the map is handing out a kind whose producer does not consult it.
  const produced = new Set<string>();
  for (const facts of [...Object.values(SITUATION_FACTS), ...Object.values(SITUATION_SUB_FACTS)]) {
    const kind = (facts as { inboxKind?: string | null }).inboxKind;
    if (kind) produced.add(kind);
  }
  for (const kind of produced) {
    assert.equal(INBOX_KIND_SOURCE[kind], 'derived', `the map produces '${kind}' but calls it independent`);
  }
});

test('an unknown situation degrades to `unknown` rather than throwing', () => {
  // This runs on the SSE path. A word from a newer build must not take the
  // inbox down; "a person should look" is the safe direction.
  assert.equal(factsFor('a-word-from-2027'), SITUATION_FACTS.unknown);
  assert.equal(factsFor(undefined), SITUATION_FACTS.unknown);
  assert.equal(factsFor(null, 'nonsense'), SITUATION_FACTS.unknown);
});

test('a declared park is an errand and NEVER a plan-health row', () => {
  // The defect this whole file exists for: 92 of 34 runs' classifications read
  // `plan-broken:stale-handoff` while the session had honestly declared a wait.
  assert.equal(SITUATION_FACTS['waiting-external'].inboxKind, 'errand');
  assert.notEqual(SITUATION_FACTS['waiting-external'].inboxKind, 'health');
  assert.equal(SITUATION_FACTS['blocked-declared'].inboxKind, 'errand');
  // `plan-broken` is the ONE situation allowed to raise a health row.
  const healthy = Object.entries(SITUATION_FACTS)
    .filter(([, f]) => f.inboxKind === 'health')
    .map(([id]) => id);
  assert.deepEqual(healthy, ['plan-broken']);
});
