/**
 * SearchIndex — the full-text index behind the ⌘K palette and /api/search.
 *
 * 196 lines of index and query logic that no test imported. That is how a
 * `size` counting tombstones as live documents survived: its only reader is a
 * number on the Settings page and in the palette footer, and a number nobody
 * asserts is a number nobody notices.
 *
 * The fixtures are hand-built PlanRecords rather than a live Store because the
 * index reads exactly four things off one — `slug`, `plan.title`,
 * `plan.sections` + `plan.phases`, and `handoffs[].{phase,title,body}`. A
 * fixture that filled in the other fifteen fields would be pinning the parser.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them — the
// console's state directory holds the operator's real push subscriptions.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePlan } from '../server/parse/plan.ts';
import { SearchIndex, type SearchResult } from '../server/search.ts';
import type { PlanRecord } from '../server/store.ts';

const PLAN = `---
slug: alpha
created: 2026-08-01
status: active
phases: 2
---

# Alpha Plan

## Context

The widget subsystem needs kestrel indexing, and the database schema follows.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | first | — | — | app | green |
| 2 | second | 1 | — | app | green |

## Phases

### Phase 1 — first
- **Size:** S
- **Goal:** ptarmigan work

### Phase 2 — second
- **Size:** S
- **Goal:** something else
`;

type Handoffish = PlanRecord['handoffs'][number];

/** The three fields the index reads; the rest of `Handoff` belongs to the parser. */
function handoff(phase: number, title: string, body: string): Handoffish {
  return { phase, title, body } as unknown as Handoffish;
}

function planRecord(over: Partial<PlanRecord> = {}): PlanRecord {
  return {
    slug: 'alpha',
    kind: 'plan',
    plan: parsePlan(PLAN, 'alpha', '/tmp/alpha.md'),
    planMtime: 0,
    handoffs: [handoff(1, 'first', 'Landed the ptarmigan migration and the kestrel index.')],
    index: [], qa: [], locks: [],
    activity: 0, bytes: 0, revision: 1,
    ...over,
  };
}

/** A record with no plan — the `document` shape, indexed through its handoffs alone. */
function docRecord(slug: string, bodies: string[]): PlanRecord {
  return {
    slug, kind: 'document', planMtime: 0,
    handoffs: bodies.map((body, i) => handoff(i + 1, `H${i}`, body)),
    index: [], qa: [], locks: [], activity: 0, bytes: 0, revision: 1,
  };
}

const sectionsOf = (result: SearchResult): string[] =>
  result.groups.flatMap((group) => group.hits.map((hit) => hit.section));

/** The document array, reached on purpose: "the slot is empty" IS the fix. */
const slotsOf = (index: SearchIndex): ({ text: string } | undefined)[] =>
  (index as unknown as { docs: ({ text: string } | undefined)[] }).docs;

test('rebuild indexes every non-empty section, phase and handoff, and an exact term finds them', () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  // Three `##` sections + two phases + one handoff. `add()` drops a blank
  // body, so the count is a fact about the index and not just the file.
  assert.equal(index.size, 6);

  const found = index.search('kestrel');
  assert.equal(found.total, 2);
  assert.deepEqual(found.groups.map((group) => group.slug), ['alpha']);
  assert.deepEqual(sectionsOf(found), ['Handoff 01 — first', 'Context']);
  // The group title is the plan's, not the slug — `plan?.title ?? record.slug`.
  assert.equal(found.groups[0].title, 'Alpha Plan');
});

test('a prefix shorter than three characters matches nothing; three is the floor', () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  // 'database' is in §Context. Two characters never reach prefixMatch…
  assert.equal(index.search('da').total, 0);
  // …and one character is not even a token — `tokenize` needs two.
  assert.equal(index.search('k').total, 0);

  const three = index.search('dat');
  assert.equal(three.total, 1);
  assert.deepEqual(sectionsOf(three), ['Context']);
});

test('a query of nothing but stop words is not a query', () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  for (const query of ['', 'the and for', 'that this with from']) {
    assert.deepEqual(index.search(query), { query, total: 0, groups: [] });
  }
});

test('a phase and a handoff outrank a plan section carrying the same single occurrence', () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  // 'ptarmigan' appears once in phase 1's body, once in the handoff, and once
  // in the §Phases section that CONTAINS phase 1 — same count, three kinds, so
  // the only thing separating the scores is the +1 kind bonus.
  const hits = index.search('ptarmigan').groups[0].hits;
  assert.deepEqual(hits.map((hit) => [hit.kind, hit.section, hit.score]), [
    ['phase', 'Phase 1 — first', 2],
    ['handoff', 'Handoff 01 — first', 2],
    ['plan', 'Phases', 1],
  ]);
  assert.equal(hits[0].phase, 1);
});

test('two terms intersect: only a document holding both survives', () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  const both = index.search('kestrel ptarmigan');
  assert.equal(both.total, 1);
  assert.deepEqual(sectionsOf(both), ['Handoff 01 — first']);
  assert.equal(both.groups[0].hits[0].score, 3, 'one occurrence of each, plus the handoff bonus');
  // One term matching nothing empties the intersection, however common the other is.
  assert.equal(index.search('kestrel zzzznothing').total, 0);
});

test('the snippet is elided at whichever end it was cut', () => {
  const index = new SearchIndex();
  const long = `${'x'.repeat(100)} kestrel ${'y'.repeat(400)}`;
  index.rebuild([
    docRecord('long', [long]),
    docRecord('short', ['kestrel at the start of a short body.']),
  ]);
  const snippets = new Map(index.search('kestrel').groups.map((g) => [g.slug, g.hits[0].snippet]));

  // The match sits at 101, so the 180-wide window opens at 41 and closes at
  // 221 of 509 — cut at both ends, elided at both ends.
  const cut = snippets.get('long') ?? '';
  assert.ok(cut.startsWith('…'), cut);
  assert.ok(cut.endsWith('…'), cut);
  assert.ok(cut.includes(' kestrel '), cut);

  // A body that fits inside the window keeps both ends bare.
  assert.equal(snippets.get('short'), 'kestrel at the start of a short body.');
});

test('total counts every hit; limit only caps what is handed back', () => {
  const index = new SearchIndex();
  index.rebuild([
    docRecord('alpha', ['kestrel once']),
    docRecord('beta', ['kestrel kestrel twice', 'kestrel once too']),
  ]);
  const all = index.search('kestrel');
  assert.equal(all.total, 3);
  // A group ranks by its best hit, so beta's double occurrence puts it first.
  assert.deepEqual(all.groups.map((group) => group.slug), ['beta', 'alpha']);
  assert.deepEqual(all.groups[0].hits.map((hit) => hit.score), [3, 2]);

  const capped = index.search('kestrel', 1);
  assert.equal(capped.total, 3, 'total is the whole answer, not the page');
  assert.equal(capped.groups.length, 1);
  assert.equal(capped.groups[0].hits.length, 1);
});

test("update replaces a plan's documents instead of stacking a stripped copy beside them", () => {
  const index = new SearchIndex();
  index.rebuild([planRecord()]);
  assert.equal(index.size, 6);

  // `Service.forget` runs this on every docs change — a lock keepalive, a
  // handoff write, an edit — and a structural change runs it for every plan.
  // Five of them used to leave 36 "documents indexed" and 30 dead sections.
  for (let i = 0; i < 5; i++) index.update(planRecord());
  assert.equal(index.size, 6, 'size must count live documents, not every slot ever used');

  // Nothing the index still holds is a zero-text husk.
  assert.ok(
    slotsOf(index).every((slot) => slot === undefined || slot.text !== ''),
    'a stripped tombstone object is still holding a section body alive',
  );
  // The slots a re-index empties are HANDED BACK, so the array stops growing.
  // This assertion used to read `length > size` — the leak stated as a design
  // trade. It was real: `nextId` only ever went up, so every `update()` of a
  // plan appended its whole document count to `docs` and abandoned the slots it
  // had just vacated. `Service.forget` runs `update()` on every watcher event,
  // so five re-indexes of one six-document plan left an array of 36. `size`
  // filters, so it went on reporting 6 throughout and hid the growth entirely
  // — which is why `capacity` exists and why this is asserted on it.
  assert.equal(index.capacity, index.size, 'a re-index must reuse the ids it freed, not abandon them');

  // Ids still stay stable while they are HELD — the point of the free list is
  // that a slot is only reused once nothing refers to it. Proven by the two
  // searches below, which would cross-match the wrong documents otherwise.

  // And the index answers exactly as it did before the churn.
  assert.equal(index.search('ptarmigan').total, 3);
  assert.equal(index.search('kestrel').total, 2);
});

test('a word the last document dropped stops suppressing its prefix siblings', () => {
  const index = new SearchIndex();
  index.rebuild([docRecord('a', ['kestrel here']), docRecord('b', ['kestrelize here'])]);
  // An exact posting wins outright; prefixMatch is never consulted for it.
  assert.equal(index.search('kestrel').total, 1);
  assert.deepEqual(index.search('kestrel').groups.map((group) => group.slug), ['a']);

  // Plan a loses the word. Its posting set empties — and an empty set left in
  // the map reads as "no match" without ever reaching the prefix fallback, so
  // 'kestrelize' in plan b disappeared from the results with it.
  index.update(docRecord('a', ['nothing left here']));
  const after = index.search('kestrel');
  assert.equal(after.total, 1, 'the emptied posting key short-circuited the prefix fallback');
  assert.deepEqual(after.groups.map((group) => group.slug), ['b']);
});
