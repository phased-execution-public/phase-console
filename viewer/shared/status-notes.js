/**
 * The note severities — how loudly a note about a screen speaks — and their
 * rows. The owner of `NOTE_SEVERITIES`; `shared/status-model.js` re-exports
 * both, so `WORD_ROWS.note` and every reader of the model hold these objects.
 *
 * A module of its own for first paint's sake (control-tower phase 16).
 * `StatusStack` and the toast sit in the preloaded `@/components/ui` barrel and
 * draw only these four; the model's other tables and the badge family's 98
 * icons belong to the pages. Tree-shaking works per module, not per chunk: a
 * module that a first-paint file and a page both import lands whole in a chunk
 * first paint loads. `scripts/check-dist.mjs` holds the tables out.
 *
 * Dependency-free ESM, like the model.
 *
 * @typedef {import('./status-vocab.js').UiState} UiState
 * @typedef {import('./status-model.js').StatusRow} StatusRow
 * @typedef {(typeof NOTE_SEVERITIES)[number]} NoteSeverity
 */

/**
 * The note severities of `components/ui/status-stack.tsx`, worst first. Their
 * paint lives in `NOTE_ROWS`: an error is red, a caution is the neutral
 * blue-grey with its warning icon (never amber — a caution is not a summons),
 * a hint is the running blue, a confirmation green.
 */
export const NOTE_SEVERITIES = Object.freeze(/** @type {const} */ (['error', 'warn', 'info', 'ok']));

/** @param {string} label @param {string} icon @param {UiState} paint @returns {StatusRow} */
const note = (label, icon, paint) =>
  Object.freeze({ label, icon, paint, tense: 'standing', attention: 'none' });

/** @type {Readonly<Record<NoteSeverity, StatusRow>>} */
export const NOTE_ROWS = Object.freeze({
  error: note('Error', 'circle-x', 'failed'),
  warn: note('Caution', 'triangle-alert', 'queued'),
  info: note('Note', 'info', 'running'),
  ok: note('Done', 'circle-check', 'done'),
});
