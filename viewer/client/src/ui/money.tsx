import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
// Relative, not `@shared/…`: the node test suite imports the owner directly and node resolves
// no Vite alias; the client imports it by identity (vocab-owners.test.ts).
import { MONEY_WORD_MEANS, moneyOf, type MoneyWord } from '../../../shared/money-model.js';

export {
  MONEY_WORDS,
  MONEY_WORD_MEANS,
  balanceOf,
  moneyOf,
  moneyWordOfSum,
} from '../../../shared/money-model.js';
export type { MoneyWord } from '../../../shared/money-model.js';

/**
 * The one money renderer (measured-console phase 18, §Architecture 9 E5): every dollar a screen
 * shows is written here — the `$` appears in no other client file (`money.test.tsx` holds it) —
 * and every figure carries its word from `shared/money-model.js`: `reported`, `estimated` or
 * `unavailable`. An absent figure is the word `unavailable`, never `$0.00`.
 *
 * The styles are the shapes the screens already said: `cents` `$1.20` (the default), `short`
 * `$5` / `$0.25` (a chart label, a cap), `trim` `$12.5` → `$12.50`, `$5.00` → `$5`, `rate` a
 * price per million (`$0.044`, `$2`), `precise` an operator's correction to four places,
 * `grouped` `$1,000` (a default in a hint).
 */
export type UsdStyle = 'cents' | 'short' | 'trim' | 'rate' | 'precise' | 'grouped';

/** A number of dollars as text — the one place a `$` is written. */
export function formatUsd(usd: number, style: UsdStyle = 'cents'): string {
  const sign = usd < 0 ? '-' : '';
  const n = Math.abs(usd);
  switch (style) {
    case 'short':
      return `${sign}$${Number.isInteger(n) ? n : n.toFixed(2)}`;
    case 'trim':
      return `${sign}$${n.toFixed(2).replace(/\.00$/, '')}`;
    case 'rate':
      return `${sign}$${n < 1 ? Number(n.toFixed(3)) : Number(n.toFixed(2))}`;
    case 'precise':
      return `${sign}$${Number(n.toFixed(4))}`;
    case 'grouped':
      return `${sign}$${n.toLocaleString()}`;
    default:
      return `${sign}$${n.toFixed(2)}`;
  }
}

/** A figure as text: the dollars, or the word `unavailable` when nothing told it. */
export function usdText(usd: number | null | undefined, style: UsdStyle = 'cents'): string {
  return typeof usd === 'number' && Number.isFinite(usd) ? formatUsd(usd, style) : 'unavailable';
}

/** A figure with its word, for a line of prose or a tooltip: `$1.20 estimated`, `unavailable`. */
export function moneyText(
  usd: number | null | undefined,
  source?: string | null,
  style: UsdStyle = 'cents',
): string {
  const m = moneyOf({ usd, source });
  return m.word === 'unavailable' ? 'unavailable' : `${formatUsd(m.usd!, style)} ${m.word}`;
}

/**
 * A sum, in the sans with tabular numerals (design.md §2: money is not a machine value). It
 * carries its word — in its title always, and as visible text with `showWord` — from its
 * `source` (a `costSource`) or a `word` the caller already derived. Against a budget it says so
 * in its title, and reads in the failed hue only once it is over.
 */
export function Money({
  usd,
  against,
  source,
  word,
  unpricedRows,
  showWord = false,
  style = 'cents',
  className,
  title,
  ...props
}: {
  usd: number | null | undefined;
  against?: number | null;
  source?: string | null;
  word?: MoneyWord;
  unpricedRows?: number;
  showWord?: boolean;
  style?: UsdStyle;
} & HTMLAttributes<HTMLSpanElement>) {
  const derived = moneyOf({ usd, source, unpricedRows });
  const said: MoneyWord = derived.word === 'unavailable' ? 'unavailable' : (word ?? derived.word);
  if (said === 'unavailable' || derived.usd === null) {
    return (
      <span
        className={cn('text-ink-faint', className)}
        data-money="unavailable"
        title={title ?? `unavailable — ${MONEY_WORD_MEANS.unavailable}`}
        {...props}
      >
        unavailable
      </span>
    );
  }
  const value = derived.usd;
  // The word rides the title once a caller named the figure's source or word; `data-money` always.
  const told = source != null || word != null;
  const over = against != null && against > 0 && value > against;
  const budget =
    against != null && against > 0 ? ` of a ${formatUsd(against)} budget${over ? ' — over' : ''}` : '';
  return (
    <span
      className={cn('tnum', over && 'text-failed', className)}
      data-money={said}
      title={
        title ?? `${formatUsd(value, style)}${budget}${told ? ` — ${said}: ${MONEY_WORD_MEANS[said]}` : ''}`
      }
      {...props}
    >
      {formatUsd(value, style)}
      {showWord && (
        <>
          {' '}
          {/* `leading-[inherit]`: the word is set in meta size but takes its line's leading — its own
              1.45 would stand a fractional taller inline box in a line of whole-pixel leading. */}
          <span className="text-meta leading-[inherit] text-ink-muted">{said}</span>
        </>
      )}
    </span>
  );
}
