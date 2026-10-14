/**
 * What each source says (turn-by-turn phase 4, §Architecture 3): ONE table —
 * the ladder's `ASKS` — gives every errand a person can receive its title,
 * its steps, its check and its ways on, each bound to the verb that takes it.
 *
 *   TA-1  every receivable situation has a title, at least one step and a
 *         check; the ones nobody is asked about (`NOT_RECEIVABLE`) carry none,
 *         and every situation the classifier knows falls to a row that does
 *   TA-2  every option's verb names a route the router serves — read from the
 *         router's own text (`route-parse.ts`), never a list kept here — and a
 *         live run or a stopped one is offered at most one recommended
 *   TA-3  no card word of the table is a machine word (a ref's scheme, a
 *         route, phase 0, the old frames)
 *   TA-4  an option is bound where the errand stands: `:slug` and `:phase`
 *         filled; one that needs a phase falls back to looking again on a
 *         run-level errand
 *   TA-5  the options the inbox binds itself — the identity park's, the
 *         ack — name served routes too
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NOT_RECEIVABLE, askFor, askOptionsFor, askTable } from '../server/runner/ladder.ts';
import { MACHINE_WORDS, identityAsk } from '../server/turn/compose.ts';
import { SITUATIONS, situationKey } from '../shared/situation-model.js';
import { DISPATCHER, routesOf } from './route-parse.ts';

const ROUTES = routesOf(DISPATCHER);

/** Does the router serve this path? Its head, and — past it — a segment the router branches on as that head's verb. */
function served(endpoint: string): boolean {
  if (!endpoint.startsWith('/api/')) return false;
  const segments = endpoint.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
  const head = segments[0]!;
  if (!ROUTES.has(head)) return false;
  if (segments.length === 1) return true;
  return segments.slice(1).some((segment) => ROUTES.has(`${head}/${segment}`));
}

const table = askTable();
const receivable = Object.keys(table).filter((key) => !(NOT_RECEIVABLE as readonly string[]).includes(key));

test('TA-1: every receivable situation has a title, at least one step and a check', () => {
  assert.ok(receivable.length >= 25, `the table holds the ladder's asks (${receivable.length})`);
  for (const key of receivable) {
    const words = askFor(key);
    assert.ok(words, `${key}: a person can receive it, so it has card words`);
    assert.ok(words!.title.trim(), `${key}: a title`);
    assert.ok(words!.steps.length >= 1 && words!.steps.every((step) => step.trim()), `${key}: at least one step`);
    assert.ok(words!.check.trim(), `${key}: a check`);
  }
});

test('TA-1: the situations nobody is asked about keep need and how alone — and the table names which', () => {
  assert.deepEqual([...NOT_RECEIVABLE], ['superseded', 'foreign-live']);
  for (const key of NOT_RECEIVABLE) {
    const row = table[key]!;
    assert.match(row.need, /^Nothing/, `${key}: its need is "Nothing"`);
    assert.equal(askFor(key), null, `${key}: no card words`);
    assert.equal(row.title, undefined);
  }
});

test('TA-1: every situation the classifier knows falls to a row — receivable ones with card words', () => {
  for (const id of SITUATIONS) {
    const key = situationKey(id);
    if ((NOT_RECEIVABLE as readonly string[]).includes(key)) continue;
    assert.ok(askFor(key), `${key}: a situation a person can receive has card words`);
  }
});

test('TA-2: every option of the table names a route the router serves, POST, with a label and a consequence', () => {
  let count = 0;
  for (const [key, row] of Object.entries(table)) {
    for (const option of row.options ?? []) {
      count += 1;
      assert.equal(option.verb.method, 'POST', `${key}/${option.id}`);
      assert.ok(served(option.verb.endpoint.replace(':slug', 'demo').replace(':phase', '3')), `${key}/${option.id}: ${option.verb.endpoint} is served`);
      assert.ok(option.label.trim() && option.consequence.trim(), `${key}/${option.id}: its words`);
    }
  }
  assert.ok(count >= 20, `the table binds its options (${count})`);
});

test('TA-2: a live run and a stopped one are each offered at most one recommended option', () => {
  for (const key of receivable) {
    for (const live of [true, false]) {
      const options = askOptionsFor(key, { slug: 'demo', phase: 3, live });
      assert.ok(options.length >= 1, `${key} (${live ? 'live' : 'stopped'}): a way on`);
      assert.ok(options.filter((option) => option.recommended).length <= 1, `${key} (${live ? 'live' : 'stopped'}): at most one recommended`);
      assert.ok(options.every((option) => served(option.verb.endpoint)), `${key}: bound to served routes`);
    }
  }
});

test('TA-3: no card word of the table is a machine word', () => {
  for (const key of receivable) {
    const words = askFor(key)!;
    const options = askOptionsFor(key, { slug: 'demo', phase: 3, live: false });
    for (const text of [words.title, ...words.steps, words.check, ...options.flatMap((o) => [o.label, o.consequence])]) {
      assert.ok(!MACHINE_WORDS.test(text), `${key}: "${text}" holds a machine word`);
    }
  }
});

test('TA-4: an option is bound where the errand stands; one that needs a phase falls back on a run-level errand', () => {
  const [recheck] = askOptionsFor('verify-red', { slug: 'a plan', phase: 7, live: true });
  assert.equal(recheck!.id, 'recheck');
  assert.equal(recheck!.verb.endpoint, '/api/run/a%20plan/recheck', 'the slug encoded');
  assert.deepEqual(recheck!.verb.body, { phase: 7 }, 'the phase a number');
  const [answered] = askOptionsFor('blocked-declared:credential', { slug: 'demo', phase: 4, live: false });
  assert.equal(answered!.verb.endpoint, '/api/run/demo/phase/4/errand-answered');
  assert.deepEqual(askOptionsFor('blocked-declared:credential', { slug: 'demo', phase: null, live: false }).map((o) => o.id), ['recover'],
    'a person\'s answer needs the phase it re-boards: a run-level errand looks again instead');
  assert.deepEqual(askOptionsFor('qa-failed', { slug: 'demo', phase: 2, live: false }).map((o) => o.id),
    ['qa-recover', 'qa-rerun', 'qa-waive', 'recover']);
});

test('TA-5: the identity park\'s two options and the ack name served routes', () => {
  const { ask, options } = identityAsk('demo', 'admin@example.com', 'new@example.com');
  assert.ok(ask.title && ask.steps.length && ask.check);
  assert.deepEqual(options.map((o) => o.id), ['continue', 'move']);
  for (const option of options) assert.ok(served(option.verb.endpoint), option.verb.endpoint);
  assert.ok(served('/api/inbox/ack'), 'the ack an option marks a row seen with');
  assert.ok(!served('/api/run/demo/no-such-verb'), 'and the check can say no');
});
