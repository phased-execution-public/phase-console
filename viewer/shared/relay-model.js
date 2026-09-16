/**
 * THE RELAY — Tier 2 of the zero-touch design, the last resort (sep-review
 * chapter 13 §1.4; QRL-5, QRL-6, TRS-2). Tiers 0 and 1 answer everything a
 * plan and a policy can; what reaches this file is a QUESTION a session raised
 * mid-run (`AskUserQuestion`) on a run whose manifest armed the relay
 * (`relay: last-resort`).
 *
 * A question is held open for a person for 60 s from `phase.question-raised`,
 * and answered by the console at 55 s — before the window closes, so the
 * answer reads as a decision and never as the silence a hook fails open on —
 * in one fixed order and with no model call: a relay rule (`RELAY_RULE_DEFAULTS`
 * merged with this console's `relayRules` preference), else the sole option
 * labelled `(Recommended)`, else the first option. A person answering inside
 * the window wins. Every answer is journalled per question
 * (`phase.question-answered {by}`) with a ruling row keyed `ambiguity`.
 *
 * Some questions are never answered by the console, whatever the rules say —
 * the exclusions, checked before any window opens: a deny-list match (the
 * call's tool, or a denied command written into an option), a multi-select
 * question, an option carrying a destructive verb, a question raised while the
 * run is halted or parked, and the second question with the same key in one
 * phase. Each is `phase.question-unanswerable {reason}`, a `needs-human` park
 * and one push. A per-phase budget bounds the rest (`budget-spent`).
 *
 * Owned here, dependency-free, because three layers read it: the server's
 * relay (`server/relay.ts`, the one call site), the inbox and the client's
 * question card (the countdown, the words for who answered and why a question
 * went to a person), and the policy editor (the rule table's shape and its
 * matcher, so the editor can say which question a rule would answer).
 *
 * Counts here are written in digits on purpose — `test/docs-parity.test.ts`
 * holds every spelled-out count in `shared/*.js` to a list.
 */

/** How long a question is held open for a person, from `phase.question-raised`. */
export const RELAY_WINDOW_MS = 60_000;

/**
 * When the console answers: 5 s before the window closes. The design's own
 * number (chapter 13 §1.4), not derived from the hook's: the hook's `timeout`
 * stays at an hour so the socket outlives the window by a wide margin, and the
 * answer lands long before the far end could give up.
 */
export const RELAY_ANSWER_MS = RELAY_WINDOW_MS - 5_000;

/**
 * How many questions one phase may put to the relay. A session asking more
 * than this is not a session with a question — it is a loop, and every one of
 * them costs a window of wall clock (chapter 13 §6 risk 9).
 */
export const RELAY_QUESTIONS_PER_PHASE = 8;

/**
 * The two hook events a question can arrive on. `pre-tool-use` fires first and
 * carries the call's `tool_use_id` (so it alone can `defer`); `permission-request`
 * is the transport phase 1 measured (spike S2) for a call that reached the
 * permission step — it carries no `tool_use_id`.
 * @type {readonly ('pre-tool-use'|'permission-request')[]}
 */
export const RELAY_MECHANISMS = Object.freeze(/** @type {const} */ (['pre-tool-use', 'permission-request']));

/** @typedef {(typeof RELAY_MECHANISMS)[number]} RelayMechanism */

/**
 * The exclusions — a question the console never answers by rule, checked in
 * this order before any window opens (chapter 13 §1.4 "Never auto-answered").
 * @type {readonly ('deny-list'|'multi-select'|'destructive-option'|'run-stopped'|'repeated-key')[]}
 */
export const QUESTION_EXCLUSIONS = Object.freeze(
  /** @type {const} */ (['deny-list', 'multi-select', 'destructive-option', 'run-stopped', 'repeated-key']),
);

/**
 * Why a question went to a person instead of being answered: the exclusions,
 * then the per-phase budget. `phase.question-unanswerable {reason}` carries one.
 */
export const QUESTION_UNANSWERABLE_REASONS = Object.freeze(
  /** @type {const} */ ([...QUESTION_EXCLUSIONS, 'budget-spent']),
);

/** @typedef {(typeof QUESTION_UNANSWERABLE_REASONS)[number]} QuestionUnanswerableReason */

/** What each reason says to a person, on the push and the errand. */
export const QUESTION_REASON_LABELS = Object.freeze(
  /** @type {Readonly<Record<QuestionUnanswerableReason, string>>} */ ({
    'deny-list': 'it touches something the deny list refuses',
    'multi-select': 'it asks for several answers at once',
    'destructive-option': 'one of its options is destructive',
    'run-stopped': 'the run is halted or parked',
    'repeated-key': 'the session asked the same question twice in one phase',
    'budget-spent': 'the phase has used its question budget',
  }),
);

/**
 * Who answered a question. `human` — a person inside the window; the other 3
 * are the console's answer order, in order.
 * @type {readonly ('human'|'rule'|'recommended'|'first-option')[]}
 */
export const QUESTION_ANSWERED_BY = Object.freeze(
  /** @type {const} */ (['human', 'rule', 'recommended', 'first-option']),
);

/** @typedef {(typeof QUESTION_ANSWERED_BY)[number]} QuestionAnsweredBy */

/** The CLI's convention for the option it recommends (CHANGELOG 2.0.62), read from the LABEL only. */
export const RECOMMENDED_MARK = /\(recommended\)/i;

/**
 * A destructive verb in an option (chapter 13 §1.4): a force-push, a hard
 * reset, a PR merge, a recursive forced delete, a publish — and the two
 * database drops. Read over each option's label and description; a hit takes
 * the question to a person, because `(Recommended)` is written by the SESSION
 * and the audit's one real question was answered against its recommendation.
 */
export const DESTRUCTIVE_OPTION_RE = new RegExp(
  [
    String.raw`\bforce[\s-]?push`,
    String.raw`\bpush\b[^\n]{0,40}\s(?:--force(?:-with-lease)?|-f)\b`,
    String.raw`\breset\s+--hard\b`,
    String.raw`\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)`,
    String.raw`\bmerge\b[^\n]{0,30}\b(?:pr|pull[\s-]request)s?\b`,
    String.raw`\bgh\s+pr\s+merge\b`,
    String.raw`\bpublish(?:es|ed|ing)?\b`,
    String.raw`\bdrop\s+(?:table|database)\b`,
  ].join('|'),
  'i',
);

/**
 * @typedef {{ label: string, description?: string }} QuestionOption
 * @typedef {{ question: string, header?: string, options: readonly QuestionOption[], multiSelect?: boolean }} QuestionShape
 */

/** @param {unknown} text @param {number} max */
function slug(text, max) {
  return String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/**
 * A question's KEY: its header and the head of its text, as one readable slug —
 * `colour:which-colour-should-the-banner-be`. Stable across a re-ask of the same
 * question, which is what the repeated-key exclusion and a relay rule both need;
 * readable, because a rule is written by a person against it.
 * @param {Partial<QuestionShape> | null | undefined} question
 * @returns {string}
 */
export function questionKey(question) {
  return `${slug(question?.header, 24) || 'question'}:${slug(question?.question, 60) || 'untitled'}`;
}

/**
 * The label of the ONE option marked `(Recommended)`, or null when none is, or
 * when more than one is — two recommendations recommend nothing.
 * @param {readonly QuestionOption[] | null | undefined} options
 * @returns {string | null}
 */
export function recommendedOption(options) {
  const marked = (options ?? []).filter((option) => RECOMMENDED_MARK.test(String(option?.label ?? '')));
  return marked.length === 1 ? marked[0].label : null;
}

/**
 * The label of the first option carrying a destructive verb, or null.
 * @param {readonly QuestionOption[] | null | undefined} options
 * @returns {string | null}
 */
export function destructiveOption(options) {
  const hit = (options ?? []).find((option) =>
    DESTRUCTIVE_OPTION_RE.test(`${option?.label ?? ''} ${option?.description ?? ''}`),
  );
  return hit ? hit.label : null;
}

/* ------------------------------------------------------------------ *
 * The rule table
 * ------------------------------------------------------------------ */

/**
 * One relay rule: for questions whose `key` matches (a glob, `*` spans
 * anything), raised through `tool`, on a run of `profile` (`*` for any), the
 * console answers `answer` — an option label, matched exactly or as the unique
 * prefix of one, case-insensitive (`Blue` answers `Blue (Recommended)`). A rule
 * whose answer names no option of the question does not apply, and the order
 * falls through to the recommendation.
 * @typedef {{ id: string, tool: string, key: string, profile: string, answer: string }} RelayRule
 */

/**
 * The rules this console ships, before the operator's own (`relayRules`). Empty
 * on purpose: a shipped rule would be the console deciding a question nobody has
 * seen, and the recommendation already answers the common case. The shape is
 * the DEFAULT_DENY/ASK/ALLOW one — a shipped list, merged under the operator's.
 * @type {readonly RelayRule[]}
 */
export const RELAY_RULE_DEFAULTS = Object.freeze([]);

/** At most this many operator rules; a table longer than this is a policy file, not a relay. */
export const MAX_RELAY_RULES = 50;

const RULE_ID_RE = /^[\w.:-]{1,64}$/;

/** @param {unknown} value @param {number} max @returns {string} */
function line(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The operator's `relayRules` preference, coerced: a rule needs a key and an
 * answer; `tool` defaults to `AskUserQuestion`, `profile` to `*`, and `id` to
 * one derived from the rest. Anything else is dropped rather than repaired,
 * because a repaired rule answers a question its author never wrote it for.
 * @param {unknown} value
 * @returns {RelayRule[]}
 */
export function sanitiseRelayRules(value) {
  if (!Array.isArray(value)) return [];
  /** @type {RelayRule[]} */
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = /** @type {Record<string, unknown>} */ (raw);
    const key = line(entry.key, 120);
    const answer = line(entry.answer, 120);
    if (!key || !answer) continue;
    const tool = line(entry.tool, 60) || 'AskUserQuestion';
    const profile = line(entry.profile, 20) || '*';
    const given = line(entry.id, 64);
    const id = given && RULE_ID_RE.test(given) ? given : `${tool}:${key}:${profile}`.slice(0, 64);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, tool, key, profile, answer });
    if (out.length >= MAX_RELAY_RULES) break;
  }
  return out;
}

/** @param {string} pattern @param {string} text */
function globMatches(pattern, text) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, 'i').test(text);
}

/**
 * Does this rule speak for this question?
 * @param {RelayRule} rule
 * @param {{ tool: string, key: string, profile: string }} subject
 */
export function relayRuleMatches(rule, subject) {
  return (
    globMatches(rule.tool || '*', subject.tool) &&
    globMatches(rule.key || '*', subject.key) &&
    (rule.profile === '*' || !rule.profile || rule.profile === subject.profile)
  );
}

/**
 * The option label a rule's answer names — exact, else the one label it is a
 * prefix of — or null when it names none, or several.
 * @param {string} answer
 * @param {readonly string[]} labels
 * @returns {string | null}
 */
export function labelFor(answer, labels) {
  const want = answer.trim().toLowerCase();
  if (!want) return null;
  const exact = labels.find((label) => label.trim().toLowerCase() === want);
  if (exact) return exact;
  const prefixed = labels.filter((label) => label.trim().toLowerCase().startsWith(want));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * The console's answer to one question, in the one order: a rule, else the sole
 * `(Recommended)` option, else the first. No model call, ever. Null only for a
 * question with no options at all, which is not a question anybody can answer.
 * @param {QuestionShape} question
 * @param {{ rules: readonly RelayRule[], tool: string, profile: string }} context
 * @returns {{ answer: string, by: Exclude<QuestionAnsweredBy, 'human'>, ruleId?: string } | null}
 */
export function pickAnswer(question, context) {
  const labels = (question.options ?? []).map((option) => String(option?.label ?? '')).filter(Boolean);
  if (!labels.length) return null;
  const key = questionKey(question);
  for (const rule of context.rules) {
    if (!relayRuleMatches(rule, { tool: context.tool, key, profile: context.profile })) continue;
    const label = labelFor(rule.answer, labels);
    if (label) return { answer: label, by: 'rule', ruleId: rule.id };
  }
  const recommended = recommendedOption(question.options);
  if (recommended) return { answer: recommended, by: 'recommended' };
  return { answer: labels[0], by: 'first-option' };
}

/**
 * How the session is told which rule answered, in `frameRelayAnswer`'s register.
 * @param {Exclude<QuestionAnsweredBy, 'human'>} by
 * @param {string} [ruleId]
 */
export function answeredByPhrase(by, ruleId) {
  if (by === 'rule') return `relay rule ${ruleId ?? 'unnamed'}`;
  if (by === 'recommended') return 'its (Recommended) option';
  return 'its first option';
}
