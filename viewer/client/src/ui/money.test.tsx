/**
 * The one money renderer (measured-console phase 18, E5): every dollar is written by
 * `ui/money.tsx`, carries its word, and an absent figure is `unavailable` — never `$0.00`.
 *
 * The tree scan is the exit criterion's grep, made exact: a `$` that FORMATS a number — a
 * template's `$${…}`, a JSX text `${…}`, a bare `'$'` joined to a figure — appears in no client
 * source file but `ui/money.tsx`. A `$` inside a comment or a sentence of copy ("capped at
 * $0.10") is a word, not a formatter, and is not counted.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { money } from '@/lib/format';
import { MONEY_WORDS as OWNER_WORDS, moneyOf as ownerMoneyOf } from '../../../shared/money-model.js';
import {
  MONEY_WORDS,
  Money,
  balanceOf,
  formatUsd,
  moneyOf,
  moneyText,
  moneyWordOfSum,
  usdText,
} from './money';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../');

/**
 * The lines of a source that write a `$` before a figure — the exit criterion's grep, three
 * shapes: a template's `$${…}`, a JSX text `>…${…}`, a bare `'$'` / `"$"`. A comment line (`//`,
 * a JSDoc ` * `) is prose and is skipped.
 */
const TEMPLATE_DOLLAR = /\$\$\{/;
/** A dollar opening an element's text: `<span …>${…}` — the `>` closes a tag (after a quote or a name). */
const JSX_DOLLAR = /["\w]>\s*\$\{/;
const BARE_DOLLAR = /(['"])\$\1/;
function formatters(text: string): number[] {
  const hits: number[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
    if (TEMPLATE_DOLLAR.test(line) || JSX_DOLLAR.test(line) || BARE_DOLLAR.test(line)) hits.push(i + 1);
  });
  return hits;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|test-|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe('the one money renderer', () => {
  it('no client file but ui/money.tsx writes a $ before a figure', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (rel === join('ui', 'money.tsx')) continue;
      for (const line of formatters(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees each shape it exists to refuse, and lets copy and comments through', () => {
    expect(formatters('const a = `$${n}`;')).toEqual([1]);
    expect(formatters('const a = <b>${n}</b>;')).toEqual([1]);
    expect(formatters('const a = <span className="x">${n.toFixed(4)}</span>;')).toEqual([1]);
    expect(formatters("const a = '$' + n;")).toEqual([1]);
    expect(formatters('// costs $5\nconst a = `capped at $0.10 ${n} sessions`;')).toEqual([]);
    expect(
      formatters("const a = 'capped at $0.10';\nconst b = <p>it's {n}</p>;\nconst c = `${a}>${b}`;"),
    ).toEqual([]);
    expect(formatters('/**\n * $${n} in a comment\n */')).toEqual([]);
  });

  it('formats every style the screens use, and an absent figure is unavailable — never $0.00', () => {
    expect(formatUsd(1.2)).toBe('$1.20');
    expect(formatUsd(5, 'short')).toBe('$5');
    expect(formatUsd(0.25, 'short')).toBe('$0.25');
    expect(formatUsd(5, 'trim')).toBe('$5');
    expect(formatUsd(12.5, 'trim')).toBe('$12.50');
    expect(formatUsd(0.044, 'rate')).toBe('$0.044');
    expect(formatUsd(0.0375, 'precise')).toBe('$0.0375');
    expect(formatUsd(-2, 'short')).toBe('-$2');
    expect(usdText(null)).toBe('unavailable');
    expect(money(undefined)).toBe('unavailable');
    expect(money(0)).toBe('$0.00');
    expect(moneyText(1.5, 'cli')).toBe('$1.50 estimated');
    expect(moneyText(1.5, 'bridge')).toBe('$1.50 reported');
    expect(moneyText(null, 'unpriced')).toBe('unavailable');
  });

  it('the words are the shared owner’s, by identity', () => {
    expect(MONEY_WORDS).toBe(OWNER_WORDS);
    expect(moneyOf).toBe(ownerMoneyOf);
    expect([...MONEY_WORDS]).toEqual(['reported', 'estimated', 'unavailable']);
  });

  it('the rule: the weakest word the evidence supports', () => {
    expect(moneyOf({ usd: 1, source: 'bridge' }).word).toBe('reported');
    expect(moneyOf({ usd: 1, source: 'provider' }).word).toBe('reported');
    expect(moneyOf({ usd: 1, source: 'cli' }).word).toBe('estimated');
    expect(moneyOf({ usd: 1, source: 'table' }).word).toBe('estimated');
    expect(moneyOf({ usd: 1, source: 'something-new' }).word).toBe('estimated');
    expect(moneyOf({ usd: 1 }).word).toBe('estimated');
    expect(moneyOf({ usd: 1, source: 'bridge', unpricedRows: 2 }).word).toBe('estimated');
    expect(moneyOf({ usd: 0, source: 'unpriced' }).word).toBe('unavailable');
    expect(moneyOf({ usd: null, source: 'bridge' }).word).toBe('unavailable');
    expect(moneyWordOfSum(['reported', 'estimated'])).toBe('estimated');
    expect(moneyWordOfSum(['reported', 'reported'])).toBe('reported');
    expect(moneyWordOfSum(['unavailable', 'reported'])).toBe('estimated');
    expect(moneyWordOfSum([])).toBe('unavailable');
    expect(balanceOf(undefined)).toMatchObject({ usd: null, word: 'unavailable' });
    expect(balanceOf(0)).toMatchObject({ usd: 0, word: 'reported' });
  });

  it('draws a figure with its word, and nothing told as the word unavailable', () => {
    render(
      <>
        <Money usd={2.5} source="cli" showWord data-testid="est" />
        <Money usd={null} data-testid="none" />
        <Money usd={0} source="unpriced" data-testid="unpriced" />
        <Money usd={0} source="provider" showWord data-testid="zero" />
      </>,
    );
    expect(screen.getByTestId('est').textContent).toBe('$2.50 estimated');
    expect(screen.getByTestId('est').getAttribute('data-money')).toBe('estimated');
    expect(screen.getByTestId('est').getAttribute('title')).toMatch(/list-price estimate/);
    expect(screen.getByTestId('none').textContent).toBe('unavailable');
    expect(screen.getByTestId('unpriced').textContent).toBe('unavailable');
    expect(screen.getByTestId('zero').textContent).toBe('$0.00 reported');
  });
});
