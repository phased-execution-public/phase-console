/**
 * The words for an issue a SESSION wants filed — before anything can file one.
 *
 * A session that finds a real defect outside its phase's scope has, today, one
 * place to put it: a sentence in its handoff, which nothing reads. The estate
 * has a repository page and `gh` is signed in, so the missing piece is not
 * capability but restraint — an unattended session that can open issues will
 * open the same one four times from four phases. Everything that restraint is
 * made of is a word, and the words are here: what a session may ask for, what
 * the console may be doing about it, what it costs, and what makes two drafts
 * the same issue.
 *
 * `scripts/issues.env` is the bash twin (the F5 pattern, like `gates.env`);
 * `viewer/test/gates-vocab.test.ts` asks bash for every list below and holds it
 * to these word for word.
 *
 * ⚠️ Data only, no imports — the client bundles this module and `node --test`
 * imports it directly. `test/vocab-owners.test.ts` registers every list.
 *
 * FREE, not Pro (decision 19): the filing engine is Pro and arrives in phase
 * 12; `phase-graph.sh --issues` reads these words and the free tree ships it.
 */

/* ------------------------------------------------------------------ *
 * What a plan allows
 * ------------------------------------------------------------------ */

/**
 * How far a plan lets its sessions go.
 *
 * `off`   — they may not ask. The default: a plan that never considered the
 *           question must not start opening issues on somebody's repository.
 * `draft` — they write drafts; the console holds them in the inbox and a
 *           person presses Approve. The recommended setting.
 * `file`  — they file at once, still through the console's one allow-listed
 *           writer and still inside the budgets.
 * @typedef {(typeof ISSUE_MODES)[number]} IssueMode
 */
export const ISSUE_MODES = Object.freeze(/** @type {const} */ (['off', 'draft', 'file']));

/** Silence means off — outward writes are never a default. */
export const DEFAULT_ISSUES = 'off';

/**
 * What each issues word is CALLED, decided once (phase 15) — the launch
 * form's picker and its review row.
 * @type {Readonly<Record<IssueMode, string>>}
 */
export const ISSUE_MODE_LABELS = Object.freeze({
  off: 'Off — a finding goes under Outstanding in the handoff',
  draft: 'Draft — the console holds it in the inbox for a person to approve',
  file: 'File — the console files it at once, inside the budgets',
});

/**
 * What a session may ask for. `close` is deliberately in the list and
 * deliberately the one the console holds longest: a phase that believes it
 * fixed something has not proved it until its work has LANDED, so a close is
 * held until the landing ledger says so.
 * @typedef {(typeof ISSUE_ACTIONS)[number]} IssueAction
 */
export const ISSUE_ACTIONS = Object.freeze(/** @type {const} */ (['file', 'comment', 'close']));

/**
 * Where a draft has got to. Eleven states because each one is a different thing
 * for a person to do — and because "it did not appear on GitHub" has five
 * distinct causes that a single `failed` would hide.
 *
 * `drafted` → `pending-approval` → `filing` → `filed` is the ordinary road.
 * `duplicate` is the fingerprint already seen; `discarded` a person's No;
 * `over-budget` the cap, which is a refusal the SESSION should learn about
 * and not a failure of the issue. `pending-landing` (phase 12) is the one
 * hold with a clock of its own: a `close` whose phase has not LANDED yet — a
 * fix a session believes in is not a fix until it is on the branch that
 * matters — and it moves to `pending-approval` by itself the moment the
 * landing ledger says so.
 * @typedef {(typeof ISSUE_STATES)[number]} IssueState
 */
export const ISSUE_STATES = Object.freeze(
  /** @type {const} */ ([
    'drafted',
    'duplicate',
    'pending-landing',
    'pending-approval',
    'filing',
    'filed',
    'commented',
    'closed',
    'discarded',
    'over-budget',
    'failed',
  ]),
);

/**
 * Three per phase, ten per run.
 *
 * Small on purpose. A phase with four things to report has found a class of
 * problem, and a class of problem is one issue with four bullets — which is
 * also the issue a person can act on. The cap is what turns the second shape
 * into the first.
 */
export const ISSUE_BUDGETS = Object.freeze({ phase: 3, run: 10 });

/**
 * The fields a session's draft carries, in the order `phase-issue.sh` takes
 * them. `number` is empty for `file` and required for `comment`/`close`.
 */
export const ISSUE_FIELDS = Object.freeze(
  /** @type {const} */ (['action', 'title', 'body', 'labels', 'repo', 'number']),
);

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/** FNV-1a, 32 bits, seeded — not cryptographic, and never asked to be. */
function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    // The FNV prime, 16777619, multiplied without losing the low bits to a float.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A title as the dedupe reads it: case folded, whitespace collapsed, and the
 * punctuation a rewording adds at the edges dropped — `Phase-lock.sh drops
 * the lease!` and `phase-lock.sh drops the lease` are one finding. The ONE
 * rule, used by `issueFingerprint` below and by the engine's match against
 * the cached estate, so a title dedupes the same way against a draft and
 * against an issue (phase 12).
 *
 * @param {string | undefined} title
 */
export function normaliseIssueTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;,\s]+$/, '');
}

/**
 * What makes two drafts the SAME issue: the repository, the action and the
 * title — never the body.
 *
 * The body is excluded because the thing being deduplicated is a session's
 * rewording. Two phases that trip over one broken lock will describe it at
 * different lengths with different stack traces and mean one issue; if the
 * body counted, the dedupe would catch none of them, which is the failure the
 * budget alone cannot prevent. The cost of the choice is the opposite error —
 * two genuinely different findings under one title collapse into one — and
 * that one is visible (a person reads the draft) where the other is not.
 *
 * Twelve hex characters, the shape a ruling id already uses, so the two read
 * alike in a journal line.
 *
 * @param {{ repo?: string, action?: string, title?: string }} draft
 */
export function issueFingerprint(draft) {
  const identity = [draft?.repo ?? '', draft?.action ?? '']
    .map((part) => String(part).trim().toLowerCase().replace(/\s+/g, ' '))
    .concat(normaliseIssueTitle(draft?.title))
    .join('');
  const a = fnv1a(identity, 0x811c9dc5);
  const b = fnv1a(identity, 0x01000193);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0').slice(0, 4);
}
