/**
 * VT-1 (control-tower phase 98, EC1, #137 #144): `viewer/shared/verb-model.js`
 * OWNS the operator verbs — the routes and the CLI derive from it, and
 * `vocab-owners` holds its lists. This file proves the derivation both ways,
 * reading the real source of `routes.ts` and `verb-press.ts` as TEXT, the way
 * `invariants.test.ts` and `vocab-owners.test.ts` do — a table that agrees
 * with itself and disagrees with the code it is supposed to describe is worse
 * than no table at all.
 *
 * Six things are proved:
 *
 *   1. Every `case '<w>':` of the run-verb POST switch (`routes.ts`, the
 *      `switch (verb)` after `guardRun`) is exactly `RUN_SWITCH_WORDS` —
 *      neither side names a word the other does not.
 *   2. Each switch case's body calls `service.<row.method>(`, and every row
 *      whose `actor` is `press` has its case call `pressActor(`.
 *   3. Every row the switch does NOT dispatch (a read, the mailbox's own
 *      door, the queue verbs, the approval cards) names a route `routes.ts`
 *      actually answers somewhere else.
 *   4. Every `trigger: true` row has a `case` in `verb-press.ts` calling
 *      `service.<row.method>(`, and `verb-press.ts` presses nothing the
 *      table does not mark triggerable.
 *   5. Every row's `method` is a real `Service.prototype` function.
 *   6. `bin/run-verb.mjs` never spells out a route by hand — it reads
 *      `OPERATOR_VERBS` and holds no `/api/` string literal.
 *
 * Plus a row-shape check (names, kinds, editions, CLI argument shapes) and a
 * pin that `vocab-owners.test.ts` still registers this file's five lists —
 * not a re-check of ITS identity/re-declaration halves, just proof that this
 * table has not quietly stopped being one of the vocabularies it enforces.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  OPERATOR_VERBS,
  RUN_SWITCH_WORDS,
  VERB_EDITIONS,
  VERB_KINDS,
  runSwitchWord,
  verbNamed,
} from '../shared/verb-model.js';
import { Service } from '../server/service.ts';

/** One row of the table, as `OPERATOR_VERBS` actually types it. */
type Row = (typeof OPERATOR_VERBS)[number];

/* ------------------------------------------------------------------ *
 * Reading the switches as text
 * ------------------------------------------------------------------ */

const ROUTES_SRC = readFileSync(new URL('../server/api/routes.ts', import.meta.url), 'utf8');
// The queue verbs share ONE route since control-tower phase 99 (#135):
// `POST /api/queue/<verb>` answers every member of the owner's list.
const { LANE_VERBS, QUEUE_VERBS } = await import('../shared/orchestration-model.js');
const PRESS_SRC = readFileSync(new URL('../server/verb-press.ts', import.meta.url), 'utf8');

/**
 * One `switch`'s cases, as `{labels, body}` — `labels` the one-or-more case
 * words a fallthrough group shares (`case 'ask': case 'steer': { … }` is one
 * block for both), `body` the text between the LAST label of the group and
 * the next label (or `default:`), which is everything the group's own case
 * runs.
 *
 * A label line is matched by its own leading `case '<word>':` or `default:`
 * — never by brace-counting, which a `${slug}` inside a template literal
 * would not actually break (every `${…}` is its own balanced pair) but which
 * is more machinery than a switch this shape needs. Comment-skipping is not
 * attempted, for the same reason `invariants.test.ts`'s `hits()` skips
 * comments explicitly instead: a prose line that happened to start with
 * `case '` would have to open with exactly that, which nothing in either
 * file does (checked by the exact-count assertions each caller makes).
 */
function caseBlocks(region: string): { labels: string[]; body: string }[] {
  const labelRe = /^[ \t]*(?:case '([\w-]+)':|default:)/gm;
  const marks: { index: number; label: string | null }[] = [];
  for (const m of region.matchAll(labelRe)) marks.push({ index: m.index, label: m[1] ?? null });
  const blocks: { labels: string[]; body: string }[] = [];
  let pending: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].index : region.length;
    const segment = region.slice(mark.index, end);
    if (mark.label) pending.push(mark.label);
    const own = segment.replace(/^[ \t]*(?:case '[\w-]+':|default:)/, '');
    if (own.trim() === '') continue; // a fallthrough label — its body is the next one's
    if (mark.label === null) { pending = []; continue; } // `default:`'s own body, not a row's
    blocks.push({ labels: pending, body: own });
    pending = [];
  }
  return blocks;
}

/** The one `switch (verb) {` in `routes.ts` — the run-verb POST switch. */
function routesSwitchRegion(): string {
  const mark = 'switch (verb) {';
  const start = ROUTES_SRC.indexOf(mark);
  assert.notEqual(start, -1, 'routes.ts no longer has `switch (verb) {` — the run-verb switch moved or was renamed');
  assert.equal(
    ROUTES_SRC.indexOf(mark, start + 1), -1,
    'more than one `switch (verb) {` in routes.ts — this file reads the first one only',
  );
  return ROUTES_SRC.slice(start);
}

const ROUTES_BLOCKS = caseBlocks(routesSwitchRegion());

/** The one `switch (row.name) {` in `verb-press.ts`. */
function pressSwitchRegion(): string {
  const mark = 'switch (row.name) {';
  const start = PRESS_SRC.indexOf(mark);
  assert.notEqual(start, -1, 'verb-press.ts no longer has `switch (row.name) {`');
  assert.equal(
    PRESS_SRC.indexOf(mark, start + 1), -1,
    'more than one `switch (row.name) {` in verb-press.ts — this file reads the first one only',
  );
  return PRESS_SRC.slice(start);
}

const PRESS_BLOCKS = caseBlocks(pressSwitchRegion());

/** The switch's `case` block a row's own word (or run-switch word) is in, or `undefined`. */
const blockFor = (blocks: { labels: string[]; body: string }[], word: string) =>
  blocks.find((b) => b.labels.includes(word));

/* ------------------------------------------------------------------ *
 * 1–2. The run-verb switch: same words, and each case does what its row says
 * ------------------------------------------------------------------ */

test('VT-1: every case of the run-verb switch is exactly RUN_SWITCH_WORDS, in both directions', () => {
  const caseWords = new Set(ROUTES_BLOCKS.flatMap((b) => b.labels));
  const tableWords = new Set(RUN_SWITCH_WORDS);
  const inTableNotSwitch = [...tableWords].filter((w) => !caseWords.has(w));
  const inSwitchNotTable = [...caseWords].filter((w) => !tableWords.has(w));
  assert.deepEqual(
    inTableNotSwitch, [],
    `RUN_SWITCH_WORDS names a word the switch has no case for: ${inTableNotSwitch.join(', ')} — `
      + 'a row is deriving a switch word the switch does not answer; fix the row\'s route or mark it inSwitch: false',
  );
  assert.deepEqual(
    inSwitchNotTable, [],
    `the switch has a case RUN_SWITCH_WORDS does not name: ${inSwitchNotTable.join(', ')} — `
      + 'add a row for it, or the 404 lies about what the console accepts',
  );
  // The lint can still see: this switch has 37 cases today (control-tower
  // phase 98). If comment-skipping-by-anchoring ever starts eating real
  // lines, this is the number that goes red first.
  assert.ok(caseWords.size >= 30, `caseBlocks() only found ${caseWords.size} case words — the extraction broke`);
});

test("VT-1: each run-verb switch case calls its row's Service method, and every `press` row calls pressActor(", () => {
  const problems: string[] = [];
  for (const row of OPERATOR_VERBS) {
    const word = runSwitchWord(row);
    if (word === null) continue; // not dispatched by this switch — proved separately, below
    const block = blockFor(ROUTES_BLOCKS, word);
    if (!block) { problems.push(`${row.name}: no case '${word}' body found in routes.ts`); continue; }
    if (row.method && !block.body.includes(`service.${row.method}(`)) {
      problems.push(`${row.name}: case '${word}' does not call service.${row.method}(`);
    }
    if (row.actor === 'press' && !block.body.includes('pressActor(')) {
      problems.push(`${row.name}: actor is 'press' but case '${word}' never calls pressActor(`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

/* ------------------------------------------------------------------ *
 * 3. The rows the switch does not dispatch — a read, the mailbox's own door,
 *    the queue verbs, the approval cards — each names a route routes.ts
 *    really answers, matched loosely (a quoted discriminator segment
 *    appearing in an equality check) rather than by re-deriving its exact
 *    dispatch shape, which varies (`head === …`, `verb === …`, `rest[N] === …`).
 * ------------------------------------------------------------------ */

/** The route's own last non-placeholder, non-`run`/`api` path segment — what routes.ts compares by name. */
function discriminatorOf(route: string): string {
  const path = route.split(' ')[1] ?? '';
  const segments = path.split('/').filter(Boolean).filter((s) => s !== 'api' && s !== 'run');
  const meaningful = segments.filter((s) => !s.startsWith(':'));
  return meaningful[meaningful.length - 1] ?? '';
}

test('VT-1: every row the switch does not dispatch names a route routes.ts actually answers', () => {
  const notInSwitch = OPERATOR_VERBS.filter((row) => runSwitchWord(row) === null);
  // The lint can still see: reads plus the switch's own carve-outs (message,
  // errand-answered) plus the queue and approval verbs is well over a dozen.
  assert.ok(notInSwitch.length >= 10, `only ${notInSwitch.length} rows read as "not in the switch" — this scan broke`);
  const missing: string[] = [];
  for (const row of notInSwitch) {
    const disc = discriminatorOf(row.route);
    const found = disc !== '' && (
      ROUTES_SRC.includes(`=== '${disc}'`) || ROUTES_SRC.includes(`'${disc}' ===`)
      // …or a queue verb, which the one queue route dispatches by the list.
      || (row.route === `POST /api/queue/${disc}` && (QUEUE_VERBS as readonly string[]).includes(disc)
        && ROUTES_SRC.includes('QUEUE_VERBS'))
      // …or a lane verb, which the one lane route dispatches by its list (control-tower phase 100).
      || (row.route === `POST /api/lane/${disc}` && (LANE_VERBS as readonly string[]).includes(disc)
        && ROUTES_SRC.includes('LANE_VERBS'))
    );
    if (!found) missing.push(`${row.name} (${row.route}) — looked for a comparison against '${disc}'`);
  }
  assert.deepEqual(missing, [], `routes.ts answers no route for:\n${missing.join('\n')}`);
});

/* ------------------------------------------------------------------ *
 * 4. verb-press.ts: exactly the `trigger: true` rows, each pressing its own
 *    method through the one in-process door.
 * ------------------------------------------------------------------ */

test('VT-1: verb-press.ts has a case for every trigger row and none other, each calling its Service method', () => {
  const pressLabels = new Set(PRESS_BLOCKS.flatMap((b) => b.labels));
  const triggerNames = new Set(OPERATOR_VERBS.filter((row) => row.trigger).map((row) => row.name));
  const caseNotTrigger = [...pressLabels].filter((n) => !triggerNames.has(n));
  const triggerNoCase = [...triggerNames].filter((n) => !pressLabels.has(n));
  assert.deepEqual(
    caseNotTrigger, [],
    `verb-press.ts presses a verb the table does not mark trigger: ${caseNotTrigger.join(', ')}`,
  );
  assert.deepEqual(
    triggerNoCase, [],
    `these trigger rows have no case in verb-press.ts: ${triggerNoCase.join(', ')}`,
  );
  assert.equal(triggerNames.size, 12, `${triggerNames.size} rows are marked trigger today (control-tower phase 98 shipped 12)`);

  const problems: string[] = [];
  for (const row of OPERATOR_VERBS) {
    if (!row.trigger) continue;
    const block = blockFor(PRESS_BLOCKS, row.name);
    if (block && row.method && !block.body.includes(`service.${row.method}(`)) {
      problems.push(`${row.name}: verb-press.ts's case '${row.name}' does not call service.${row.method}(`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

/* ------------------------------------------------------------------ *
 * 5. Every method is real.
 * ------------------------------------------------------------------ */

test('VT-1: every row\'s method is a function on Service.prototype', () => {
  const proto = Service.prototype as unknown as Record<string, unknown>;
  const missing = OPERATOR_VERBS
    .filter((row): row is Row & { method: string } => typeof row.method === 'string')
    .filter((row) => typeof proto[row.method] !== 'function')
    .map((row) => `${row.name} -> ${row.method}`);
  assert.deepEqual(missing, [], `these rows name a method Service.prototype does not have: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * 6. The CLI reads the table; it never spells out a route.
 * ------------------------------------------------------------------ */

test('VT-1: bin/run-verb.mjs holds no /api/ string literal', () => {
  const path = new URL('../../bin/run-verb.mjs', import.meta.url);
  // Agent B (this same run) is writing this file; until it lands, this is
  // RED for the right reason — there is nothing yet to read `OPERATOR_VERBS`
  // instead of a hand-written path. Once it exists this assertion is the one
  // that matters: every route the CLI hits must come from the table.
  assert.ok(existsSync(path), 'bin/run-verb.mjs does not exist yet');
  const src = readFileSync(path, 'utf8');
  const hits = [...src.matchAll(/\/api\//g)];
  assert.equal(
    hits.length, 0,
    `bin/run-verb.mjs holds ${hits.length} "/api/" literal(s) — every route must come from OPERATOR_VERBS`,
  );
});

/* ------------------------------------------------------------------ *
 * vocab-owners — pinned as a registrant, not re-checked as a mechanism
 * ------------------------------------------------------------------ */

test("VT-1: vocab-owners.test.ts registers verb-model's five lists", () => {
  // Not a re-implementation of vocab-owners' identity/re-declaration halves —
  // this only pins that `shared/verb-model.js` is still named as the owner of
  // its five lists there, read as text exactly as that file reads others.
  const src = readFileSync(new URL('vocab-owners.test.ts', import.meta.url), 'utf8');
  const owned = ['VERB_NAMES', 'VERB_ACTOR_CLASSES', 'TRIGGER_EVENTS', 'TRIGGER_MODES', 'TRIGGER_STATES'];
  const missing = owned.filter(
    (name) => !new RegExp(`members:\\s*${name},\\s*owner:\\s*'shared/verb-model\\.js'`).test(src),
  );
  assert.deepEqual(
    missing, [],
    `vocab-owners.test.ts no longer registers these verb-model.js lists as owned there: ${missing.join(', ')}`,
  );
});

/* ------------------------------------------------------------------ *
 * Row shape
 * ------------------------------------------------------------------ */

test('VT-1: row shape — unique names, valid kind and edition, act is pro, read is free except wait', () => {
  const names = OPERATOR_VERBS.map((row) => row.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dupes, [], `duplicate verb names: ${dupes.join(', ')}`);

  const badKind = OPERATOR_VERBS.filter((row) => !(VERB_KINDS as readonly string[]).includes(row.kind)).map((r) => r.name);
  assert.deepEqual(badKind, [], `rows with a kind outside VERB_KINDS: ${badKind.join(', ')}`);

  const badEdition = OPERATOR_VERBS
    .filter((row) => !(VERB_EDITIONS as readonly string[]).includes(row.edition))
    .map((r) => r.name);
  assert.deepEqual(badEdition, [], `rows with an edition outside VERB_EDITIONS: ${badEdition.join(', ')}`);

  const actNotPro = OPERATOR_VERBS.filter((row) => row.kind === 'act' && row.edition !== 'pro').map((r) => r.name);
  assert.deepEqual(actNotPro, [], `act rows whose edition is not pro: ${actNotPro.join(', ')}`);

  // The file's own header: every read is free EXCEPT `wait`, priced like the
  // acts it can be asked to block a terminal for (the long poll's timeout is
  // seconds of a paid session's wall-clock, unlike every other read).
  const readNotFree = OPERATOR_VERBS
    .filter((row) => row.kind === 'read' && row.name !== 'wait' && row.edition !== 'free')
    .map((r) => r.name);
  assert.deepEqual(readNotFree, [], `read rows (other than wait) whose edition is not free: ${readNotFree.join(', ')}`);
  assert.equal(verbNamed('wait')?.edition, 'pro', 'wait is documented as the one Pro read — the table moved');
});

test('VT-1: row shape — cli.args names only a placeholder the route has, or a plausible body field', () => {
  const problems: string[] = [];
  for (const row of OPERATOR_VERBS) {
    const cli = row.cli;
    if (!cli) continue;
    const placeholders = [...row.route.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);
    const missingPlaceholder = placeholders.filter((p) => !cli.args.includes(p));
    if (missingPlaceholder.length) {
      problems.push(`${row.name}: cli.args is missing the route's own placeholder(s) ${missingPlaceholder.join(', ')}`);
    }
    // Anything left is read as a body field (the header: "everything else
    // rides the body or the query") — not verified against a live route,
    // which a shared case's ternary body (`targetPhase(body)`) would make a
    // false positive; only that it is a plausible field name, not a stray
    // placeholder spelling routes.ts does not have.
    const extras = cli.args.filter((a) => !placeholders.includes(a));
    const notAnIdentifier = extras.filter((a) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(a));
    if (notAnIdentifier.length) {
      problems.push(`${row.name}: cli.args names something unplaceholder-like: ${notAnIdentifier.join(', ')}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
