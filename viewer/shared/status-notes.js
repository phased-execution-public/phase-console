/**
 * The note severities — how loudly a note about a screen speaks — and their
 * rows. The owner of `NOTE_SEVERITIES`; `shared/status-model.js` re-exports
 * both, so `WORD_ROWS.note` and every reader of the model hold these objects.
 *
 * A module of its own for first paint's sake (control-tower phase 16).
 * The banner and the toast sit in the preloaded `@/ui` barrel and draw only
 * these four; the model's other tables and the status family's 98 icons
 * belong to the pages. Tree-shaking works per module, not per chunk: a
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
 * The note severities of the banner and the toast (`ui/banner.tsx`,
 * `ui/toast.tsx`), worst first. Their paint lives in `NOTE_ROWS`: an error is
 * red, a caution is the neutral blue-grey with its warning icon (never amber —
 * a caution is not a summons), a hint is the running blue, a confirmation green.
 */
export const NOTE_SEVERITIES = Object.freeze(/** @type {const} */ (['error', 'warn', 'info', 'ok']));

/**
 * One note row — and, like every row of the model (`shared/status-meanings.js`,
 * #365), what it means and what comes next, in a sentence each. Four short
 * pairs, so they ride here rather than costing first paint a second module.
 * @param {string} label @param {string} icon @param {UiState} paint
 * @param {string} meaning @param {string} next @returns {StatusRow}
 */
const note = (label, icon, paint, meaning, next) =>
  Object.freeze({ label, icon, paint, tense: 'standing', attention: 'none', meaning, next });

/** @type {Readonly<Record<NoteSeverity, StatusRow>>} */
export const NOTE_ROWS = Object.freeze({
  error: note(
    'Error',
    'circle-x',
    'failed',
    'Something went wrong.',
    'Read the message: it says what failed and what to try.',
  ),
  warn: note(
    'Caution',
    'triangle-alert',
    'queued',
    'Worth care, though nothing is broken.',
    'Read it before you go on.',
  ),
  info: note('Note', 'info', 'running', 'A fact worth knowing.', 'Nothing to do: read it if it helps.'),
  ok: note('Done', 'circle-check', 'done', 'It worked.', 'Nothing to do: carry on.'),
});
