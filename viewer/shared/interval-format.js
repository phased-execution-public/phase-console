/**
 * One way to write an interval, in three registers (#28).
 *
 * The console printed the same 119 seconds as `1:59`, `2m` and `1m 59s`, from
 * three client helpers with three rounding rules — and a reader looking at a
 * phase row, a card and a sentence about ONE phase could not tell whether
 * three surfaces disagreed or three renderings agreed. The fix keeps the
 * three registers, because they answer different questions, and gives them
 * ONE rounding rule over ONE input:
 *
 * - **The rule: floor to the whole second.** Every register is a truncation
 *   of the same stopwatch, so no register can ever read AHEAD of another: a
 *   table's `2m` over a stopwatch's `1:59` was the whole bug.
 * - **The registers differ only in precision** — which units they show:
 *   - `clock` — a stopwatch for something still running: `1:59`, `1:02:03`.
 *   - `prose` — the stopwatch read out loud, padded so a live sentence does
 *     not jitter in width: `47s`, `1m 59s`, `12m 03s`, `1h 04m`.
 *   - `table` — a settled figure in a column, unpadded, a zero tail dropped:
 *     `47s`, `1m 59s`, `10m`, `1h 4m`, `2h`.
 *
 * An unmeasurable interval (not finite, or negative) is the em-dash in the
 * word registers and `0:00` on the clock, which is what a stopwatch that
 * has not started shows.
 *
 * Dependency-free ESM. The client's `lib/format.ts` delegates to it; the
 * server prints no intervals of its own, so the file is not in the tarball
 * (`assert-tarball.sh`'s never-ship list) until something there imports it.
 */

/** @typedef {'clock'|'prose'|'table'} IntervalRegister */

/** @type {readonly IntervalRegister[]} */
export const INTERVAL_REGISTERS = Object.freeze(/** @type {const} */ (['clock', 'prose', 'table']));

/** What a register prints for an interval nobody could measure. */
const UNMEASURED = Object.freeze({ clock: '0:00', prose: '—', table: '—' });

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The parts of an interval after the one rounding rule.
 *
 * @param {number} ms
 * @returns {{ total: number, hours: number, minutes: number, seconds: number } | null}
 */
export function intervalParts(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  return {
    total,
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/**
 * Write `ms` in `register`.
 *
 * @param {number} ms
 * @param {IntervalRegister} [register]
 * @returns {string}
 */
export function formatInterval(ms, register = 'prose') {
  const parts = intervalParts(ms);
  if (!parts) return UNMEASURED[register] ?? UNMEASURED.prose;
  const { total, hours, minutes, seconds } = parts;
  if (register === 'clock') {
    return hours ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
  }
  if (register === 'table') {
    if (total < 60) return `${seconds}s`;
    if (!hours) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (total < 60) return `${seconds}s`;
  if (!hours) return `${minutes}m ${pad2(seconds)}s`;
  return `${hours}h ${pad2(minutes)}m`;
}
