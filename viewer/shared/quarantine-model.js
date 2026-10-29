/**
 * The quarantine (measured-console phase 15) — owner of its vocabulary. The
 * rows live in `scripts/quarantine.env` (bash sources it for `gates.sh`); this
 * module reads them for the phase tier's selection (`runner/verify-select.ts`)
 * and the client suite (`vite.config.ts`). A flaky test is set aside BY NAME,
 * with an owner and an expiry, and a row past its expiry fails the gate.
 */

/** The suites a row may name, as the `<suite>:` of its id. */
export const QUARANTINE_SUITES = Object.freeze(['node', 'bats', 'vitest', 'playwright']);

/** The four fields of a row, in the file's order. */
export const QUARANTINE_FIELDS = Object.freeze(['id', 'owner', 'expires', 'why']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rows of `quarantine.env`'s `QUARANTINE_ROWS` (its whole text), each with
 * the reason it is malformed when it is: a suite not in the list, a field
 * missing, an expiry that is not a day.
 * @param {string} text
 * @returns {{ id: string, suite: string, path: string, owner: string, expires: string, why: string, problem?: string }[]}
 */
export function parseQuarantine(text) {
  const match = /^QUARANTINE_ROWS='([^']*)'/m.exec(text);
  const rows = [];
  for (const line of (match ? match[1] : '').split('\n')) {
    if (!line.trim()) continue;
    const [id = '', owner = '', expires = '', why = ''] = line.split('\t').map((cell) => cell.trim());
    const colon = id.indexOf(':');
    const suite = colon > 0 ? id.slice(0, colon) : '';
    const path = colon > 0 ? id.slice(colon + 1) : '';
    const problem =
      !QUARANTINE_SUITES.includes(suite) || !path
        ? `the id names no suite of ${QUARANTINE_SUITES.join(', ')}`
        : !owner
          ? 'no owner'
          : !DAY.test(expires)
            ? 'the expiry is not a YYYY-MM-DD day'
            : !why
              ? 'no reason'
              : undefined;
    rows.push({ id, suite, path, owner, expires, why, ...(problem ? { problem } : {}) });
  }
  return rows;
}

/**
 * Is the row past its expiry at `now`? The expiry is the LAST day it stands,
 * in UTC — a row expiring 2026-10-31 still holds all of that day.
 * @param {{ expires: string }} row
 * @param {number} now ms since the epoch
 */
export function isExpired(row, now) {
  return new Date(now).toISOString().slice(0, 10) > row.expires;
}

/**
 * The paths of one suite a quarantine sets aside at `now` — standing, well-formed rows only.
 * @param {ReturnType<typeof parseQuarantine>} rows
 * @param {string} suite
 * @param {number} now
 */
export function quarantinedPaths(rows, suite, now) {
  return rows
    .filter((row) => row.suite === suite && !row.problem && !isExpired(row, now))
    .map((row) => row.path);
}
