/**
 * The price book (measured-console phase 18, §Architecture 9 A7): ONE dated source for every rate.
 *
 * What is pinned: every model the catalog's seed knows has a book row, dated, with both cache
 * writes; the four current Claude models carry the ecosystem audit's §3 rates (2026-10-17); a
 * model the book does not know is `unpriced`, never $0; a later row takes over on its own day and
 * never before; the operator's override wins; DeepSeek halves off-peak; `priceOf` is the book's
 * row per token; only the measured rows corroborate the CLI; and no file under `server/` or
 * `shared/` carries a rate of its own.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOOK_PROVIDERS, MEASURED_MODELS, PRICE_BOOK, PRICE_BOOK_READ, UNPRICED, bookPricesOf, bookRowOf, priceAt, priceKeyOf, rowInForce,
} from '../shared/price-book.js';
import { measuredRatesOf, priceOf, priceRowOf, priceUsage } from '../server/runner/usage.ts';

const VIEWER = fileURLToPath(new URL('..', import.meta.url));
const MONDAY_0200Z = '2026-10-19T02:00:00Z'; // DeepSeek's first peak window
const SATURDAY_0300Z = '2026-10-17T03:00:00Z';

test('PB-1: every model the seed catalog knows has one dated book row with both cache writes', () => {
  assert.equal(PRICE_BOOK.length, 15, 'ten Claude, two DeepSeek, three OpenAI');
  assert.equal(PRICE_BOOK_READ, '2026-10-17');
  for (const r of PRICE_BOOK) {
    assert.ok(BOOK_PROVIDERS.includes(r.provider), `${r.model} names a book provider`);
    assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
    for (const key of ['inPerM', 'outPerM', 'cacheReadPerM', 'cacheWrite5mPerM', 'cacheWrite1hPerM'] as const) {
      assert.ok(Number.isFinite(r[key]) && r[key] >= 0, `${r.model} ${key}`);
    }
  }
});

test('PB-2: the four current Claude models carry §3\'s rates — input, the 5 m and 1 h writes, a read, output', () => {
  const table: Record<string, [number, number, number, number, number]> = {
    'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
    'claude-opus-5-5': [4, 5, 8, 0.2, 20],
    'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
    'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5],
  };
  for (const [model, [input, w5, w1, read, output]] of Object.entries(table)) {
    const r = bookRowOf(model)!;
    assert.deepEqual([r.inPerM, r.cacheWrite5mPerM, r.cacheWrite1hPerM, r.cacheReadPerM, r.outPerM], [input, w5, w1, read, output], model);
  }
  // Claude Code writes the one-hour cache: the price a call's cache write is charged at.
  assert.equal(bookPricesOf('anthropic')['claude-opus-5-5']!.cacheWritePerM, 8);
});

test('PB-3: an id the book does not know is unpriced — never a price of zero', () => {
  assert.equal(priceAt('glm-4.6'), UNPRICED);
  assert.equal(priceAt(''), UNPRICED);
  assert.equal(priceAt(null), UNPRICED);
  assert.equal(priceAt('opus'), UNPRICED, 'an alias names no version');
  assert.equal(priceOf('glm-4.6'), null);
  assert.equal(priceKeyOf('Claude-Opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(priceKeyOf('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  const priced = priceAt('claude-opus-5-5[1m]', SATURDAY_0300Z);
  assert.notEqual(priced, UNPRICED);
  assert.equal((priced as Exclude<typeof priced, typeof UNPRICED>).from, '2026-10-17');
});

test('PB-4: a later row takes over on its own day and never before; before the first row the first stands', () => {
  const rows = [{ from: '2026-10-17', inPerM: 4 }, { from: '2026-12-01', inPerM: 3 }];
  assert.equal(rowInForce(rows, '2026-11-30T23:59:59Z')!.inPerM, 4);
  assert.equal(rowInForce(rows, '2026-12-01T00:00:00Z')!.inPerM, 3);
  assert.equal(rowInForce(rows, '2026-01-01T00:00:00Z')!.inPerM, 4, 'the earliest the book knows');
  assert.equal(rowInForce([...rows].reverse(), '2027-01-01T00:00:00Z')!.inPerM, 3, 'order-free');
  assert.equal(rowInForce([], Date.now()), null);
});

test('PB-5: the operator\'s override wins over the book; DeepSeek halves off-peak; OpenAI never does', () => {
  const over = priceAt('deepseek-v4-pro', MONDAY_0200Z, { 'deepseek-v4-pro': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 1, source: 'override' } });
  assert.notEqual(over, UNPRICED);
  assert.equal((over as Exclude<typeof over, typeof UNPRICED>).source, 'override');
  assert.equal((over as Exclude<typeof over, typeof UNPRICED>).inPerM, 1);
  const peak = priceAt('deepseek-v4-pro', MONDAY_0200Z) as Exclude<ReturnType<typeof priceAt>, typeof UNPRICED>;
  const weekend = priceAt('deepseek-v4-pro', SATURDAY_0300Z) as Exclude<ReturnType<typeof priceAt>, typeof UNPRICED>;
  assert.equal(peak.inPerM, 1.32);
  assert.equal(peak.offPeak, false);
  assert.equal(weekend.inPerM, 0.66);
  assert.equal(weekend.offPeak, true);
  const sol = priceAt('gpt-6.1-sol', SATURDAY_0300Z) as Exclude<ReturnType<typeof priceAt>, typeof UNPRICED>;
  assert.equal(sol.inPerM, 2);
  assert.equal(sol.offPeak, false);
});

test('PB-6: priceOf is the book\'s row per token; only the measured rows corroborate the CLI', () => {
  const rate = priceOf('claude-sonnet-5-5', SATURDAY_0300Z)!;
  const want = { input: 2e-6, cacheWrite: 4e-6, cacheRead: 0.1e-6, output: 10e-6 };
  for (const key of Object.keys(want) as (keyof typeof want)[]) assert.ok(Math.abs(rate[key] - want[key]) < 1e-15, key);
  assert.deepEqual([...MEASURED_MODELS].sort(), ['claude-opus-5', 'claude-opus-5-5']);
  assert.equal(priceRowOf('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(priceRowOf('claude-sonnet-5-5'), null, 'priced, but never measured against the CLI');
  assert.equal(priceUsage('claude-sonnet-5-5', { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }), null);
  assert.deepEqual(measuredRatesOf('claude-opus-5-5'), priceOf('claude-opus-5-5'));
});

test('PB-7: no file under server/ or shared/ carries a rate of its own — the book is the one source', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!/\.(ts|js|mjs)$/.test(name) || name === 'price-book.js') continue;
      const text = readFileSync(path, 'utf8');
      if (/\b(inPerM|outPerM|cacheReadPerM|cacheWritePerM)\s*:\s*\d/.test(text) || /TOKEN_PRICES_USD|PRICE_SEED/.test(text)) {
        offenders.push(relative(VIEWER, path));
      }
    }
  };
  walk(join(VIEWER, 'server'));
  walk(join(VIEWER, 'shared'));
  assert.deepEqual(offenders, []);
});
