/**
 * The money words (measured-console phase 18, §Architecture 9 E5) — the ONE owner of what a
 * dollar figure a person sees may claim to be — these words, no others:
 *
 *  - `reported` — the provider's own meter said it: the bridge's exact `usage` for one request,
 *    the Usage & Cost Admin API's billed figure, a balance the provider returned;
 *  - `estimated` — a client-side list price: the CLI's `total_cost_usd` (it prices its own
 *    models at list), the price book × tokens, an operator's override — and any total that mixes
 *    an estimate in, or leaves an unpriced row out;
 *  - `unavailable` — nothing told it: no balance, no meter, a model nobody prices. Drawn as the
 *    word, never as $0; "a balance of zero" is drawn only when a provider REPORTED zero.
 *
 * The rule is `shared/evidence-model.js`'s claim-against-evidence pattern: a figure's word is
 * the weakest its evidence supports, and **when in doubt the answer is the weaker word** — a
 * `reported` that turns out to have been a list price is worse than an `estimated` that was
 * exact. A source this table does not know reads `estimated`, never `reported`.
 *
 *   costSource (ledger-model.js `COST_SOURCES`, plus the readers' own)   → word
 *   `bridge`    the OpenAI bridge's exact usage                           → reported
 *   `provider`  a provider's own report (Admin API, a balance)            → reported
 *   `cli`       the CLI's `total_cost_usd`                                 → estimated
 *   `table`     the price book (or an override) × tokens                   → estimated
 *   `result`    a session's own result line (the runner's journal)        → estimated
 *   `forecast`  sessions per phase × dollars per session (phase 23)        → estimated
 *   `unpriced`  a model nobody prices                                      → unavailable
 *   no figure   (null, undefined, NaN)                                     → unavailable
 *
 * Imported by identity (`vocab-owners.test.ts`): `client/src/ui/money.tsx`, the one renderer of
 * a dollar; `server/pro/accounts/reconcile.ts` (its row's word); the tests. Dependency-free ESM.
 */

/** The words a figure may carry, strongest first. */
export const MONEY_WORDS = Object.freeze(/** @type {const} */ (['reported', 'estimated', 'unavailable']));
/** @typedef {(typeof MONEY_WORDS)[number]} MoneyWord */

/**
 * Each known source's word. A source outside this table reads `estimated`.
 * @type {Readonly<Record<string, MoneyWord>>}
 */
export const MONEY_WORD_OF_SOURCE = Object.freeze({
  bridge: 'reported',
  provider: 'reported',
  cli: 'estimated',
  table: 'estimated',
  result: 'estimated',
  forecast: 'estimated',
  unpriced: 'unavailable',
});

/** What each word tells a person, in one clause — a figure's title and its legend. */
export const MONEY_WORD_MEANS = Object.freeze({
  reported: "the provider's own meter",
  estimated: 'a list-price estimate, not the bill',
  unavailable: 'nothing reported it',
});

/**
 * @param {unknown} value
 * @returns {value is MoneyWord}
 */
export function isMoneyWord(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (MONEY_WORDS).includes(value);
}

/**
 * The word one figure carries.
 * @param {{ usd: number | null | undefined; source?: string | null; unpricedRows?: number }} figure
 * @returns {{ usd: number | null; word: MoneyWord; why: string }}
 */
export function moneyOf(figure) {
  const usd = typeof figure.usd === 'number' && Number.isFinite(figure.usd) ? figure.usd : null;
  const source = figure.source ?? null;
  if (usd === null)
    return {
      usd: null,
      word: 'unavailable',
      why: source === 'unpriced' ? 'nobody prices the model' : 'no figure was reported',
    };
  if (source === 'unpriced') return { usd: null, word: 'unavailable', why: 'nobody prices the model' };
  const unpriced = figure.unpricedRows ?? 0;
  if (unpriced > 0) {
    return {
      usd,
      word: 'estimated',
      why: `${unpriced} row${unpriced === 1 ? '' : 's'} unpriced — a floor, not a sum`,
    };
  }
  const word =
    source !== null && Object.prototype.hasOwnProperty.call(MONEY_WORD_OF_SOURCE, source)
      ? MONEY_WORD_OF_SOURCE[source]
      : 'estimated';
  return { usd, word, why: source === null ? 'its source was not named' : `from ${source}` };
}

/**
 * The word a SUM carries: the weakest of its parts' that hold a figure — a reported part beside
 * an estimated one is an estimate; an unavailable part beside a figure makes the sum a floor
 * (`estimated`); every part unavailable is `unavailable`. An empty sum reads `unavailable`.
 * @param {readonly MoneyWord[]} words
 * @returns {MoneyWord}
 */
export function moneyWordOfSum(words) {
  if (!words.length || words.every((w) => w === 'unavailable')) return 'unavailable';
  return words.every((w) => w === 'reported') ? 'reported' : 'estimated';
}

/**
 * A balance a provider may or may not have told: the figure with `reported`, or `unavailable`
 * — never a zero that means unknown.
 * @param {number | null | undefined} told
 * @returns {{ usd: number | null; word: MoneyWord; why: string }}
 */
export function balanceOf(told) {
  return typeof told === 'number' && Number.isFinite(told)
    ? { usd: told, word: 'reported', why: 'the provider reported it' }
    : { usd: null, word: 'unavailable', why: 'no provider reported a balance' };
}
