/**
 * The price book (measured-console phase 18, §Architecture 9 A7) — the ONE owner of what a
 * model's tokens cost. Every dollar the console estimates is a book row (or the operator's
 * `providers.priceOverrides` row) × tokens; nothing else in the tree carries a rate. It replaced
 * three tables that had drifted apart: the runner's measured rows (`runner/usage.ts`), the
 * catalog's seed prices (`providers-model.js`) and the catalog's lookup over them.
 *
 * A row is DATED: `from` is the UTC day its rates took effect (or, for the first row of a
 * model, the day the book first read them). A price changes by a NEW row with a later `from`,
 * never by editing an old one, so a ledger row is priced at its own instant (`priceAt(model,
 * at)`): the newest row whose `from` is on or before `at`, and — before a model's first row —
 * that first row, the earliest the book knows. A model the book does not know is `UNPRICED`,
 * never $0.
 *
 * Sources, every row read 2026-10-17 (`PRICE_BOOK_READ`):
 *  - Anthropic — platform.claude.com/docs/en/about-claude/pricing; the four current models are the
 *    ecosystem audit's §3 table (`docs/audits/ecosystem-integration-2026-10-17/05-…` §3) with both
 *    cache writes: five minutes at 1.25 × input, one hour at 2 × input. Claude Code writes the
 *    one-hour cache, so `cacheWritePerM` — what a call's `cache_creation_input_tokens` is priced at
 *    — is the one-hour rate. Haiku 5.5's row is its rate up to 100K of prompt; over it the rates
 *    are five times higher, a tier no reader here applies (Haiku is not a session model).
 *  - DeepSeek — api-docs.deepseek.com/quick_start/pricing: a cache write is billed as a miss, at
 *    input; the rates are the peak ones, halved off-peak (`offPeak`).
 *  - OpenAI — developers.openai.com/api/docs/pricing: the standard tier up to 272K of input; a
 *    cache write is its listed rate, whatever the lifetime.
 *
 * `measured: true` marks the rows a Claude session was FOUND to book at (control-tower phase
 * 109, #202): 126 Opus 5 sessions at a median of 1.000 × what the CLI reported, and 389 fresh
 * Opus 5.5 sessions at 1.000 with 291 within ±2 %. Only those corroborate the CLI's own figure
 * (`runner/usage.ts` `priceUsage`): a guessed price would journal a mismatch for every session it
 * got wrong.
 *
 * Dependency-free ESM (`.js` + JSDoc), free: the free tree prices Claude from it too. Imported
 * by `runner/usage.ts` (`priceOf`), `shared/providers-model.js` (the seed catalog's prices), the
 * catalog and `test/price-book.test.ts`.
 */

/** The day every row of this book was read from its provider's page. */
export const PRICE_BOOK_READ = '2026-10-17';

/** What `priceAt` answers for a model nobody prices — never a price of zero. */
export const UNPRICED = 'unpriced';

/** The providers a book row may name (`providers-model.js` `PROVIDERS` less `custom`, which the operator prices). */
export const BOOK_PROVIDERS = Object.freeze(/** @type {const} */ (['anthropic', 'deepseek', 'openai']));

/**
 * @typedef {{ factor: number; peakUtc: ReadonlyArray<readonly [number, number]>; peakDays: readonly number[] }} OffPeak
 * @typedef {{ provider: (typeof BOOK_PROVIDERS)[number]; model: string; from: string; inPerM: number; outPerM: number;
 *   cacheReadPerM: number; cacheWrite5mPerM: number; cacheWrite1hPerM: number; offPeak?: OffPeak; measured?: true }} BookRow
 * @typedef {{ inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number; offPeak?: OffPeak;
 *   from?: string; source?: 'book' | 'override' }} BookPrice
 * @typedef {{ model: string; from: string | null; source: 'book' | 'override'; inPerM: number; outPerM: number;
 *   cacheReadPerM: number; cacheWritePerM: number; offPeak: boolean }} PriceAtInstant
 */

/**
 * DeepSeek's off-peak discount (its pricing page, read 2026-10-17): half price outside
 * 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday — weekends are off-peak all day. The
 * page also exempts Chinese public holidays, which no table here can know; they read as peak,
 * the dearer side.
 * @type {OffPeak}
 */
export const DEEPSEEK_OFF_PEAK = Object.freeze({
  factor: 0.5,
  peakUtc: Object.freeze([
    Object.freeze(/** @type {const} */ ([1, 4])),
    Object.freeze(/** @type {const} */ ([6, 10])),
  ]),
  peakDays: Object.freeze([1, 2, 3, 4, 5]),
});

/**
 * @param {BookRow['provider']} provider @param {string} model
 * @param {number} inPerM @param {number} outPerM @param {number} cacheReadPerM
 * @param {number} cacheWrite5mPerM @param {number} cacheWrite1hPerM
 * @param {{ offPeak?: OffPeak; measured?: true; from?: string }} [extra]
 * @returns {Readonly<BookRow>}
 */
const row = (
  provider,
  model,
  inPerM,
  outPerM,
  cacheReadPerM,
  cacheWrite5mPerM,
  cacheWrite1hPerM,
  extra = {},
) =>
  Object.freeze({
    provider,
    model,
    from: extra.from ?? PRICE_BOOK_READ,
    inPerM,
    outPerM,
    cacheReadPerM,
    cacheWrite5mPerM,
    cacheWrite1hPerM,
    ...(extra.offPeak ? { offPeak: extra.offPeak } : {}),
    ...(extra.measured ? { measured: extra.measured } : {}),
  });

/**
 * Every row, USD per million tokens: input, output, a cache read, a five-minute and a one-hour
 * cache write. Oldest `from` first within a model.
 * @type {ReadonlyArray<Readonly<BookRow>>}
 */
export const PRICE_BOOK = Object.freeze([
  row('anthropic', 'claude-fable-5-1', 10, 50, 0.25, 12.5, 20),
  row('anthropic', 'claude-fable-5', 10, 50, 1, 12.5, 20),
  row('anthropic', 'claude-opus-5-5', 4, 20, 0.2, 5, 8, { measured: true }),
  row('anthropic', 'claude-opus-5', 5, 25, 0.5, 6.25, 10, { measured: true }),
  row('anthropic', 'claude-opus-4-8', 5, 25, 0.5, 6.25, 10),
  row('anthropic', 'claude-sonnet-5-5', 2, 10, 0.1, 2.5, 4),
  row('anthropic', 'claude-sonnet-5', 2, 10, 0.2, 2.5, 4),
  row('anthropic', 'claude-sonnet-4-6', 3, 15, 0.3, 3.75, 6),
  row('anthropic', 'claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125, 0.2),
  row('anthropic', 'claude-haiku-4-5', 1, 5, 0.1, 1.25, 2),
  row('deepseek', 'deepseek-v4-pro', 1.32, 3.96, 0.044, 1.32, 1.32, { offPeak: DEEPSEEK_OFF_PEAK }),
  row('deepseek', 'deepseek-flash', 0.3, 1.2, 0.006, 0.3, 0.3, { offPeak: DEEPSEEK_OFF_PEAK }),
  row('openai', 'gpt-6-astra', 10, 50, 1, 12.5, 12.5),
  row('openai', 'gpt-6.1-sol', 2, 10, 0.1, 2.5, 2.5),
  row('openai', 'gpt-6-luna', 0.1, 0.5, 0.01, 0.125, 0.125),
]);

/**
 * The book's key for a model id: lower case, without the `[1m]` window suffix (a window, not a
 * model — the measured sessions show no long-context rate) and without a trailing date stamp
 * (`-20251001`, how the CLI ships a dated id). The WHOLE id, never a family substring (#202).
 * @param {string | null | undefined} model
 */
export function priceKeyOf(model) {
  const id = String(model ?? '')
    .trim()
    .toLowerCase();
  return (id.endsWith('[1m]') ? id.slice(0, -4) : id).replace(/-\d{8}$/, '');
}

/** @type {ReadonlyMap<string, ReadonlyArray<Readonly<BookRow>>>} */
const ROWS_BY_MODEL = (() => {
  /** @type {Map<string, Readonly<BookRow>[]>} */
  const out = new Map();
  for (const r of PRICE_BOOK) out.set(r.model, [...(out.get(r.model) ?? []), r]);
  for (const list of out.values()) list.sort((a, b) => a.from.localeCompare(b.from));
  return out;
})();

/** @param {Date | number | string} at */
function dayOf(at) {
  const when = new Date(at);
  return Number.isNaN(when.getTime()) ? null : when.toISOString().slice(0, 10);
}

/**
 * The book row in force for a model at an instant, or null for a model the book does not know.
 * @param {string | null | undefined} model @param {Date | number | string} [at]
 * @returns {Readonly<BookRow> | null}
 */
export function bookRowOf(model, at = Date.now()) {
  const rows = ROWS_BY_MODEL.get(priceKeyOf(model));
  return rows ? rowInForce(rows, at) : null;
}

/**
 * Of one model's rows, the one in force at `at`: the newest whose `from` is on or before it,
 * else the oldest — the earliest the book knows stands for the time before it.
 * @template {{ from: string }} R
 * @param {ReadonlyArray<R>} rows @param {Date | number | string} at
 * @returns {R | null}
 */
export function rowInForce(rows, at) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.from.localeCompare(b.from));
  const day = dayOf(at);
  let hit = sorted[0];
  if (day) for (const r of sorted) if (r.from <= day) hit = r;
  return hit;
}

/**
 * A row as the price shape the catalog and the overrides share (`cacheWritePerM` the one-hour
 * write), dated.
 * @param {Readonly<BookRow>} r
 * @returns {Readonly<BookPrice>}
 */
export function bookPriceOf(r) {
  return Object.freeze({
    inPerM: r.inPerM,
    outPerM: r.outPerM,
    cacheReadPerM: r.cacheReadPerM,
    cacheWritePerM: r.cacheWrite1hPerM,
    ...(r.offPeak ? { offPeak: r.offPeak } : {}),
    from: r.from,
    source: /** @type {const} */ ('book'),
  });
}

/**
 * Is `at` in a peak hour of `offPeak`'s schedule (UTC)? An instant that will not read is peak,
 * the dearer side.
 * @param {OffPeak} offPeak @param {Date | number | string} at
 */
export function isPeak(offPeak, at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return true;
  if (!offPeak.peakDays.includes(when.getUTCDay())) return false;
  const hour = when.getUTCHours() + when.getUTCMinutes() / 60;
  return offPeak.peakUtc.some(([from, to]) => hour >= from && hour < to);
}

/**
 * A price as it applies at an instant: the off-peak factor taken off every rate outside the
 * provider's peak hours, the rates as listed otherwise. USD per million tokens.
 * @param {BookPrice} price @param {Date | number | string} at
 * @returns {{ inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number; offPeak: boolean }}
 */
export function ratesAt(price, at) {
  const off = price.offPeak && !isPeak(price.offPeak, at);
  const f = off && price.offPeak ? price.offPeak.factor : 1;
  return {
    inPerM: price.inPerM * f,
    outPerM: price.outPerM * f,
    cacheReadPerM: price.cacheReadPerM * f,
    cacheWritePerM: price.cacheWritePerM * f,
    offPeak: Boolean(off),
  };
}

/**
 * What a model's tokens cost at an instant, USD per million: the operator's override for its
 * key when there is one (`providers.priceOverrides`, already read — `readPriceOverride`), else
 * the book's row in force at `at`, with DeepSeek's off-peak half taken off; `UNPRICED` when
 * neither knows the model.
 * @param {string | null | undefined} model @param {Date | number | string} [at]
 * @param {Readonly<Record<string, BookPrice>>} [overrides]
 * @returns {PriceAtInstant | typeof UNPRICED}
 */
export function priceAt(model, at = Date.now(), overrides) {
  const key = priceKeyOf(model);
  if (!key) return UNPRICED;
  const override =
    overrides && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
  if (override)
    return { model: key, from: override.from ?? null, source: 'override', ...ratesAt(override, at) };
  const r = bookRowOf(key, at);
  if (!r) return UNPRICED;
  return { model: key, from: r.from, source: 'book', ...ratesAt(bookPriceOf(r), at) };
}

/**
 * The book's prices for one provider, keyed by model — the seed catalog's `price` column.
 * @param {string} provider @param {Date | number | string} [at]
 * @returns {Readonly<Record<string, Readonly<BookPrice>>>}
 */
export function bookPricesOf(provider, at = Date.now()) {
  /** @type {Record<string, Readonly<BookPrice>>} */
  const out = {};
  for (const model of ROWS_BY_MODEL.keys()) {
    const r = bookRowOf(model, at);
    if (r && r.provider === provider) out[model] = bookPriceOf(r);
  }
  return Object.freeze(out);
}

/**
 * The model ids whose rows a Claude session was measured to book at — the only ones the CLI's
 * own figure is corroborated against.
 * @type {readonly string[]}
 */
export const MEASURED_MODELS = Object.freeze([
  ...new Set(PRICE_BOOK.filter((r) => r.measured).map((r) => r.model)),
]);
