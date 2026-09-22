/**
 * THE DECISION MANIFEST — every decision a run can need, named once, so a plan
 * can answer it BEFORE the run starts and nothing has to ask a person mid-run.
 *
 * The sep-review audit (chapter 10, ZTD-1/3/12; chapter 13 §1.1) measured 494
 * mid-run asks and found that every one of them was a decision that had an
 * answer before the money was spent — a credential nobody held, an account an
 * organisation policy blocked, a gate nobody had categorised, a wait nobody
 * had bounded. The fix is a `## Decisions` table in the plan: one row per key
 * of this closed vocabulary, read by BOTH engines (`scripts/phase-graph.sh
 * --decisions` and `server/parse/plan.ts`), held identical by
 * `test/engine-parity.test.ts`, and overridable by a mutable twin
 * (`docs/handoffs/<slug>/decisions.md`) that only `scripts/decisions.sh`
 * writes — the `qa-mode.sh` rule: the writer emits exactly the shape the
 * readers parse.
 *
 * `scripts/decisions.env` is this file's bash twin (the F5 pattern, like
 * `gates.env`); `test/decisions-model.test.ts` asks bash for its lists and
 * holds them to these, word for word.
 *
 * ------------------------------------------------------------------
 * The row
 * ------------------------------------------------------------------
 *
 * `| key | value | owner | state | blocking | source | evidence |` — plus an
 * optional `phase` column, which the twin always writes (`—` = plan-wide).
 * Columns are located BY HEADER NAME, never by position, the way the Phase
 * graph's `Depends on` and `Repos` are (F20). `key`, `owner`, `state`,
 * `blocking` and `source` are read with bold and backticks stripped;
 * `value` and `evidence` are kept as written, trimmed.
 *
 *   - `state` — `answered` (a value stands), `outstanding` (somebody still owes
 *     it — `owner` says who; an outstanding row with NO owner is lint F25),
 *     `waived` (deliberately left open, with the reason as its value).
 *   - `blocking` — `yes` when a run must not start while the row is
 *     `outstanding` (phase 11's prelude refuses with 409); anything but
 *     `yes`/`true`/`y` reads as `no`.
 *   - `source` — where the answer came from: `plan` (the table), `run` (a
 *     `decisions.sh answer` at run time), `default` (the Tier-1 policy table
 *     answered it), `ruling` (promoted from a session's ruling).
 *
 * Merge order, lowest to highest: the plan's plan-wide row → the twin's
 * plan-wide row → the plan's row for phase N → the twin's row for phase N.
 * A later row REPLACES the earlier one whole.
 */

import { SUB_KINDS } from './situation-model.js';

/**
 * The eighteen keys — a closed vocabulary (chapter 13 §1.1's seventeen, plus
 * `issues` in 5.1.0). Also the value a ruling, an errand and a `needs-human`
 * reason carry as its `decisionKey`, and what `phase-outcome.sh …
 * blocked|needs-human --needs <key>` is validated against (together with
 * `NEED_CLASSES` below).
 *
 * `issues` sits beside `permission.destructive` because it is the same kind of
 * question asked about a different verb: what may this run write OUTWARD, to a
 * place no `git reset` takes back. A plan that answered the push question and
 * never answered this one is exactly the plan whose sessions opened four
 * copies of one issue.
 */
export const DECISION_KEYS = Object.freeze(
  /** @type {const} */ ([
    'permission.policy',
    'permission.destructive',
    'issues',
    'credentials',
    'accounts',
    'mcp',
    'gates',
    'verification.person-check',
    'qa.exhausted',
    'waits',
    'human-acts',
    'ambiguity',
    'budgets',
    'resume.on-restart',
    'plan-health',
    'stop',
    'relay',
    'announce',
  ]),
);

/** @typedef {(typeof DECISION_KEYS)[number]} DecisionKey */

export const DECISION_STATES = Object.freeze(/** @type {const} */ (['answered', 'outstanding', 'waived']));

/** @typedef {(typeof DECISION_STATES)[number]} DecisionState */

export const DECISION_SOURCES = Object.freeze(/** @type {const} */ (['plan', 'run', 'default', 'ruling']));

/** @typedef {(typeof DECISION_SOURCES)[number]} DecisionSource */

/**
 * The blocker classes a session may name as the SHORT form of a decision key
 * in `--needs`: the classifier's `blocked-declared:*` sub-kinds
 * (`shared/situation-model.js` `SUB_KINDS`), DERIVED, minus `unknown` — which
 * is never something a session needs, only what the classifier says when it
 * was not told. `lock` names no manifest row: a peer holding the scope is
 * nobody's decision, the session queues behind it.
 */
export const NEED_CLASSES = Object.freeze(SUB_KINDS['blocked-declared'].filter((k) => k !== 'unknown'));

/** @typedef {Exclude<(typeof SUB_KINDS)['blocked-declared'][number], 'unknown'>} NeedClass */

/** Which manifest row each blocker class points at (`lock` → none). */
export const DECISION_KEY_OF_NEED = Object.freeze({
  lock: null,
  permission: 'permission.policy',
  credential: 'credentials',
  gate: 'gates',
  external: 'waits',
});

/**
 * Is `word` something `--needs` accepts — a decision key, or a blocker class?
 * @param {string | undefined | null} word
 * @returns {boolean}
 */
export function isNeedWord(word) {
  if (typeof word !== 'string') return false;
  return (
    /** @type {readonly string[]} */ (DECISION_KEYS).includes(word) ||
    /** @type {readonly string[]} */ (NEED_CLASSES).includes(word)
  );
}

/**
 * The manifest row a `--needs` word points at: a key answers itself, a blocker
 * class answers through `DECISION_KEY_OF_NEED`, anything else is `null`.
 * @param {string | undefined | null} word
 * @returns {DecisionKey | null}
 */
export function decisionKeyOfNeed(word) {
  if (typeof word !== 'string') return null;
  if (/** @type {readonly string[]} */ (DECISION_KEYS).includes(word)) {
    return /** @type {DecisionKey} */ (word);
  }
  if (Object.prototype.hasOwnProperty.call(DECISION_KEY_OF_NEED, word)) {
    return /** @type {DecisionKey | null} */ (DECISION_KEY_OF_NEED[/** @type {NeedClass} */ (word)]);
  }
  return null;
}

/**
 * The classifier's sub-kind for a `--needs` word — read BEFORE the prose
 * regexes in `server/runner/situation.ts` (ZTD-3): a blocker class is its own
 * sub-kind; a decision key answers through the class that points at it
 * (`credentials` → `credential`, either permission key → `permission`,
 * `gates` → `gate`, `waits` → `external`); a key no class points at (say
 * `budgets`) returns `null` and the prose cascade decides, as it always did.
 * @param {string | undefined | null} word
 * @returns {NeedClass | null}
 */
export function subKindOfNeed(word) {
  if (typeof word !== 'string') return null;
  if (/** @type {readonly string[]} */ (NEED_CLASSES).includes(word)) {
    return /** @type {NeedClass} */ (word);
  }
  if (word === 'permission.destructive') return 'permission';
  for (const cls of NEED_CLASSES) {
    if (DECISION_KEY_OF_NEED[cls] === word) return cls;
  }
  return null;
}

/**
 * @typedef {object} DecisionRow
 * @property {string} key       one of `DECISION_KEYS` — or not: an unknown key
 *                              is kept so the lint can name it (F25)
 * @property {string} value
 * @property {string} owner
 * @property {string} state     one of `DECISION_STATES` — or not, same reason
 * @property {'yes' | 'no'} blocking
 * @property {string} source    one of `DECISION_SOURCES`, or `''` when unstated
 * @property {string} evidence
 * @property {number | null} phase  `null` = plan-wide
 */

/** The column names a decisions table may carry, in the canonical order. */
export const DECISION_COLUMNS = Object.freeze(
  /** @type {const} */ (['key', 'value', 'owner', 'state', 'blocking', 'source', 'evidence', 'phase']),
);

/**
 * A cell with bold and backticks stripped, trimmed — the same rule as
 * `server/parse/markdown.ts` `plainCell`, spelled here because `shared/` may
 * not import the server's parsers.
 * @param {string} cell
 */
function plain(cell) {
  return cell.replace(/[*`]/g, '').trim();
}

/**
 * One pipe row's cells — the leading and trailing pipes dropped, the rest split
 * on `|` and trimmed (the `tableAfter` rule, so the two engines see the same
 * cells).
 * @param {string} line
 * @returns {string[]}
 */
export function splitPipeRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** @param {string[]} cells */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * The bash engine strips tabs and newlines out of a cell before printing TSV;
 * so does this, so the two agree byte for byte.
 * @param {string} s
 */
function flat(s) {
  return s.replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Build rows from a header row and its data rows. Columns are found by name;
 * a table with no `key` column yields nothing. Rows with an empty key are
 * skipped (a blank line somebody left in the table).
 * @param {string[]} header  the header row's cells
 * @param {string[][]} rows  the data rows' cells
 * @returns {DecisionRow[]}
 */
export function decisionRowsFromCells(header, rows) {
  const names = header.map((h) => plain(h).toLowerCase());
  /** @param {string} name */
  const at = (name) => names.indexOf(name);
  const iKey = at('key');
  if (iKey < 0) return [];
  const iValue = at('value');
  const iOwner = at('owner');
  const iState = at('state');
  const iBlocking = at('blocking');
  const iSource = at('source');
  const iEvidence = at('evidence');
  const iPhase = at('phase');
  /** @param {string[]} cells @param {number} i */
  const cell = (cells, i) => (i >= 0 && i < cells.length ? cells[i] : '');
  /** @type {DecisionRow[]} */
  const out = [];
  for (const cells of rows) {
    if (isSeparatorRow(cells)) continue;
    const key = plain(cell(cells, iKey));
    if (!key) continue;
    const blockingWord = plain(cell(cells, iBlocking)).toLowerCase();
    const phaseWord = plain(cell(cells, iPhase));
    out.push({
      key,
      value: flat(cell(cells, iValue)),
      owner: plain(cell(cells, iOwner)),
      state: plain(cell(cells, iState)).toLowerCase(),
      blocking: blockingWord === 'yes' || blockingWord === 'true' || blockingWord === 'y' ? 'yes' : 'no',
      source: plain(cell(cells, iSource)).toLowerCase(),
      evidence: flat(cell(cells, iEvidence)),
      phase: /^\d+$/.test(phaseWord) ? Number(phaseWord) : null,
    });
  }
  return out;
}

/**
 * Parse the first pipe table in `text` — or, with `after`, the first pipe
 * table below the first line matching it (a heading). Fences are respected:
 * a table drawn inside a code block is an example, not a manifest.
 * @param {string} text
 * @param {{ after?: RegExp }} [opts]
 * @returns {DecisionRow[]}
 */
export function parseDecisionsTable(text, opts = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  let armed = !opts.after;
  let inFence = false;
  /** @type {string[][]} */
  const rows = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!armed) {
      if (opts.after && opts.after.test(line)) armed = true;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      rows.push(splitPipeRow(line));
      continue;
    }
    if (rows.length) break;
  }
  if (!rows.length) return [];
  const [header, ...data] = rows;
  return decisionRowsFromCells(header, data);
}

/**
 * The rows that hold for the plan (no phase) or for phase N — the plan's table
 * and the twin merged, in the order documented above. Output is in
 * `DECISION_KEYS` order, unknown keys after in first-seen order.
 * @param {readonly DecisionRow[]} planRows
 * @param {readonly DecisionRow[]} twinRows
 * @param {number | null} [phase]
 * @returns {DecisionRow[]}
 */
export function mergeDecisions(planRows, twinRows, phase = null) {
  /** @type {Map<string, DecisionRow>} */
  const byKey = new Map();
  /** @param {readonly DecisionRow[]} rows @param {number | null} want */
  const layer = (rows, want) => {
    for (const row of rows) if (row.phase === want) byKey.set(row.key, row);
  };
  layer(planRows, null);
  layer(twinRows, null);
  if (phase !== null && phase !== undefined) {
    layer(planRows, phase);
    layer(twinRows, phase);
  }
  const known = /** @type {readonly string[]} */ (DECISION_KEYS);
  const out = [];
  for (const key of known) {
    const row = byKey.get(key);
    if (row) out.push(row);
  }
  for (const [key, row] of byKey) if (!known.includes(key)) out.push(row);
  return out;
}

/**
 * The line `phase-graph.sh --decisions [N]` prints per row —
 * `key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value` — so the parity
 * test compares bytes, not interpretations.
 * @param {readonly DecisionRow[]} rows
 * @returns {string}
 */
export function formatDecisionsTsv(rows) {
  return rows
    .map((r) => [r.key, r.state, r.owner, r.blocking, r.source, r.value].map(flat).join('\t'))
    .join('\n');
}

/**
 * The inverse: rows from the engine's TSV (what `server/engine.ts
 * readDecisions` does with a result). `evidence` is not on the wire and reads
 * as `''`; `phase` is whatever the caller asked for.
 * @param {string} tsv
 * @param {number | null} [phase]
 * @returns {DecisionRow[]}
 */
export function parseDecisionsTsv(tsv, phase = null) {
  /** @type {DecisionRow[]} */
  const out = [];
  for (const line of String(tsv ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [key = '', state = '', owner = '', blocking = '', source = '', ...rest] = line.split('\t');
    if (!key) continue;
    out.push({
      key,
      state,
      owner,
      blocking: blocking === 'yes' ? 'yes' : 'no',
      source,
      value: rest.join('\t'),
      evidence: '',
      phase,
    });
  }
  return out;
}
