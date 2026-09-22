/**
 * THE POLICY TABLE — Tier 1 of the zero-touch design (sep-review chapter 13
 * §1.3; ZTD-10, QRL-3): every class of intervention the console used to ask a
 * person about, named once, tied to the manifest row that answers it, with the
 * shipped default and the journal line that records the ruling.
 *
 * The audit counted 494 mid-run asks and found that two thirds of them had no
 * NAME — an `Errand` was `{need, how, tried}`, prose, so an operator could not
 * say "never ask me about X; do Y" because X did not exist. This file gives X
 * a name (`POLICY_CLASSES`), a key in the decision manifest
 * (`decisions-model.js` `DECISION_KEYS`), an answer vocabulary per key
 * (`DECISION_ANSWERS`) and a shipped answer where the operator chose one
 * (`POLICY_DEFAULTS`, operator decision 11 of the zero-touch-console plan):
 * `gates: delegated` · `qa.exhausted: waive` · `resume.on-restart: continue` ·
 * `ambiguity: ruling`.
 *
 * Three consumers, one source:
 *   - `server/runner/ladder.ts` — every `ASKS` entry carries the `decisionKey`
 *     of the class its situation belongs to, and `errandFor` refuses to write
 *     an ask whose class resolved to an AUTOMATIC answer: the caller journals
 *     `phase.policy-answered {decisionKey, answer, source}` instead. The
 *     `unknown-block` row is PINNED — a block whose key the manifest lacks is a
 *     defect report and always writes an errand.
 *   - `server/prelude.ts` — synthesises the manifest rows a plan did not write
 *     (`answered` from a default, `run` from the launch form), and refuses a
 *     start on a `MANIFEST_BLOCKING` row still `outstanding`.
 *   - the policy editor (phase 12) — the 18 rows, their key, the shipped
 *     default, this console's override (`prefs.policy[key]`) and the plan's row.
 *
 * Resolution order, per the plan: the plan's `## Decisions` row → this
 * console's `policy.<key>` preference → `POLICY_DEFAULTS`. The RUN's own
 * answer outranks plan, console and default for the keys the launch form asks
 * (`resume.on-restart`, `relay`, `accounts`): the plan row is what the form
 * defaults from, not what overrules the person who pressed Launch.
 *
 * Counts here are written in digits on purpose — `test/docs-parity.test.ts`
 * holds every spelled-out count in `shared/*.js` to a list, and these lists
 * are asserted by `test/policy-model.test.ts` directly.
 */

import { DECISION_KEYS } from './decisions-model.js';
import { ISSUE_MODES } from './issues-model.js';
import { MCP_POLICIES } from './run-lifecycle.js';
import { RELAY_MODES } from './run-settings.js';

/** @typedef {import('./decisions-model.js').DecisionKey} DecisionKey */

/**
 * The 18 intervention classes — chapter 13 §1.3's rows, in its order. The id
 * is what the editor, the journal and the tests name a row by; the situations
 * it governs are listed on `POLICY_TABLE`.
 */
export const POLICY_CLASSES = Object.freeze(
  /** @type {const} */ ([
    'tool-ask',
    'carve-out',
    'verification-prose',
    'manual-gate',
    'credential-block',
    'permission-block',
    'gate-block',
    'external-block',
    'lock-block',
    'unknown-block',
    'entitlement-wall',
    'resource-wall',
    'resume-on-restart',
    'qa-exhausted',
    'plan-health',
    'mcp-sign-in',
    'ambiguity',
    'human-only',
  ]),
);

/** @typedef {(typeof POLICY_CLASSES)[number]} PolicyClass */

/**
 * Where a resolved answer came from. `console` is this instance's
 * `policy.<key>` preference; the other 3 words mean what they mean on a
 * manifest row (`decisions-model.js` `DECISION_SOURCES` — `ruling` never
 * resolves a live answer, a promoted ruling becomes a `plan` row first).
 */
export const POLICY_SOURCES = Object.freeze(/** @type {const} */ (['run', 'plan', 'console', 'default']));

/** @typedef {(typeof POLICY_SOURCES)[number]} PolicySource */

/**
 * The 2 keys whose answer may be a person's NAME besides the closed words
 * (`waive|halt|<owner>`, `allow|halt|<owner>` — `references/plan-format.md`).
 */
export const OWNER_KEYS = Object.freeze(/** @type {const} */ (['qa.exhausted', 'verification.person-check']));

/** What an `<owner>` word may look like: a handle, an email, a team slug. */
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,63}$/;

/**
 * The closed answer vocabulary per manifest key — `null` where the value is
 * free text the console reads but never enumerates (a permission overlay, a
 * list of human acts, ceilings, notification categories). The words are the
 * ones the plan format already documents; `credentials` and `mcp` answer with
 * the policy vocabulary the MCP preflight has always used, imported by identity.
 * @type {Readonly<Record<DecisionKey, readonly string[] | null>>}
 */
export const DECISION_ANSWERS = Object.freeze({
  'permission.policy': null,
  'permission.destructive': null,
  // The plan's `**Issues:**` line, from `shared/issues-model.js` — a closed
  // vocabulary, unlike its neighbour, because "may a session open an issue"
  // has three answers and not a paragraph of them.
  issues: ISSUE_MODES,
  credentials: MCP_POLICIES,
  accounts: null,
  mcp: MCP_POLICIES,
  gates: Object.freeze(['delegated', 'operator']),
  'verification.person-check': Object.freeze(['allow', 'halt']),
  'qa.exhausted': Object.freeze(['waive', 'halt']),
  waits: Object.freeze(['window', 'refuse']),
  'human-acts': null,
  ambiguity: Object.freeze(['ruling', 'ask', 'halt']),
  budgets: null,
  'resume.on-restart': Object.freeze(['continue', 'hold', 'ask']),
  'plan-health': null,
  stop: null,
  relay: RELAY_MODES,
  announce: null,
});

/**
 * The shipped answers. The first 4 are the operator's (decision 11); the rest
 * are what the console did before it had a name for the class, written down
 * so a prelude row synthesised from silence says where its answer came from.
 * `verification.person-check: operator` is today's card — a prose check is
 * asked of the operator, not waived and not halted, until a plan says
 * otherwise. `credentials: continue` mirrors `mcp`: a missing credential is
 * reported and the phase runs, until a plan says `require`.
 * @type {Readonly<Partial<Record<DecisionKey, string>>>}
 */
export const POLICY_DEFAULTS = Object.freeze({
  gates: 'delegated',
  'qa.exhausted': 'waive',
  'resume.on-restart': 'continue',
  ambiguity: 'ruling',
  'verification.person-check': 'operator',
  credentials: 'continue',
  mcp: 'continue',
  relay: 'off',
  waits: 'window',
  // Nothing was ever filed before there was a word for it, so `off` is not a
  // policy choice here — it is the behaviour every existing plan already has.
  issues: 'off',
});

/**
 * The rows a run must not start on while `outstanding` — the plan template's
 * `blocking: yes` set (`templates/plan.md`), so a plan written from the
 * template and a plan that never wrote the section agree on what blocks.
 */
export const MANIFEST_BLOCKING = Object.freeze(
  /** @type {const} */ ([
    'permission.policy',
    'permission.destructive',
    'credentials',
    'accounts',
    'human-acts',
    'relay',
  ]),
);

/**
 * @typedef {object} PolicyRow
 * @property {PolicyClass} class
 * @property {DecisionKey} decisionKey   the manifest row that answers this class
 * @property {string} journal            the event that records the ruling when
 *                                       the console answers by policy
 * @property {readonly (string | readonly [string, DecisionKey])[]} situations
 *   the `ASKS` keys (`shared/situation-model.js` `id[:sub]`) this class
 *   governs; a tuple names a situation whose errand carries a DIFFERENT key
 *   than the class's (the budget wall inside the resource walls, the
 *   ladder-exhausted phases inside plan health)
 * @property {readonly string[]} automatic
 *   the answers under which no person is needed — `errandFor` writes no ask
 *   and the caller journals `phase.policy-answered`
 * @property {boolean} [pinned]          never suppressed, whatever the answer
 * @property {string} blurb              one line for the editor
 */

/**
 * The table. Order is the audit's; `situations` covers every `ASKS` key of
 * `server/runner/ladder.ts` exactly once (`test/policy-model.test.ts` walks
 * `SITUATIONS × SUB_KINDS` and the table together).
 * @type {readonly PolicyRow[]}
 */
export const POLICY_TABLE = Object.freeze([
  {
    class: 'tool-ask',
    decisionKey: 'permission.policy',
    journal: 'phase.tool-denied',
    situations: [],
    automatic: [],
    blurb:
      "A tool call the profile would ask about: the plan's rule, else the profile's, else deny and continue.",
  },
  {
    class: 'carve-out',
    decisionKey: 'permission.destructive',
    journal: 'phase.tool-denied',
    situations: [],
    automatic: [],
    blurb:
      'git push and gh pr create: a card for a person that auto-grant never answers — unless this row names the rule after allow, and then the grant is announced.',
  },
  {
    class: 'verification-prose',
    decisionKey: 'verification.person-check',
    journal: 'phase.verify-waived',
    situations: [],
    automatic: ['allow'],
    blurb:
      'A §Verification fragment written as prose: allow (waived by policy), halt at boarding, or ask the owner.',
  },
  {
    class: 'manual-gate',
    decisionKey: 'gates',
    journal: 'phase.gate-delegated',
    situations: ['gated-manual'],
    automatic: [],
    blurb: 'A manual gate: delegated to the session that can evidence it, else the operator approves it.',
  },
  {
    class: 'credential-block',
    decisionKey: 'credentials',
    journal: 'phase.credential-preflight',
    situations: ['blocked-declared:credential'],
    automatic: [],
    blurb:
      'A credential the plan named: require refuses the phase at boarding, continue runs it and reports the gap.',
  },
  {
    class: 'permission-block',
    decisionKey: 'permission.policy',
    journal: 'phase.widen-decided',
    situations: ['blocked-declared:permission'],
    automatic: [],
    blurb: 'A session blocked by a permission rule: one rung, widen the rule, offered as a card.',
  },
  {
    class: 'gate-block',
    decisionKey: 'gates',
    journal: 'phase.gated',
    situations: ['blocked-declared:gate'],
    automatic: [],
    blurb:
      'A session waiting on an approval: the manifest gates row; an undeclared gate is a lint failure, not an ask.',
  },
  {
    class: 'external-block',
    decisionKey: 'waits',
    journal: 'phase.waiting',
    situations: ['blocked-declared:external', 'waiting-external'],
    automatic: [],
    blurb:
      "An external clock: the waits row's window, the cap told to the session; no watch ref means refused.",
  },
  {
    class: 'lock-block',
    decisionKey: 'waits',
    journal: 'phase.queued',
    situations: ['blocked-declared:lock', 'foreign-live', 'foreign-stale'],
    automatic: ['window'],
    blurb: 'A peer holds the scope: queue behind it and name it; never force-release a live session.',
  },
  {
    class: 'unknown-block',
    decisionKey: 'ambiguity',
    journal: 'phase.errand',
    situations: ['blocked-declared', 'blocked-declared:unknown'],
    automatic: [],
    pinned: true,
    blurb: 'A block whose key the manifest lacks: always an errand, as a defect report.',
  },
  {
    class: 'entitlement-wall',
    decisionKey: 'accounts',
    journal: 'run.account-retired',
    situations: ['resource-wall:auth'],
    automatic: [],
    blurb:
      'An organisation refuses the account: retire it for the run, switch by rank, break the circuit by orgId.',
  },
  {
    class: 'resource-wall',
    decisionKey: 'accounts',
    journal: 'phase.live-wall',
    situations: [
      'resource-wall',
      'resource-wall:usage',
      'resource-wall:model',
      ['resource-wall:budget', 'budgets'],
    ],
    automatic: [],
    blurb:
      "A usage or budget wall: the accounts row's onLimit and the budgets row's ceilings; never a third none.",
  },
  {
    class: 'resume-on-restart',
    decisionKey: 'resume.on-restart',
    journal: 'phase.resume-automatic',
    situations: [],
    automatic: ['continue'],
    blurb: "A console restart stopped the run: the run's own answer — continue, hold, or ask.",
  },
  {
    class: 'qa-exhausted',
    decisionKey: 'qa.exhausted',
    journal: 'phase.qa-waived',
    situations: ['qa-failed', 'qa-pending'],
    automatic: ['waive'],
    blurb: 'The QA round budget is spent: waive naming the policy, halt, or hand the verdict to the owner.',
  },
  {
    class: 'plan-health',
    decisionKey: 'plan-health',
    journal: 'phase.rung',
    situations: [
      'plan-broken',
      'verify-red',
      'done-unrecorded',
      'superseded',
      'unknown',
      'never-started:refusal',
      'never-started:skill-missing',
      ['work-in-progress', 'budgets'],
      ['never-started', 'budgets'],
      ['never-started:sleep', 'budgets'],
    ],
    automatic: [],
    blurb: 'The plan or the phase cannot progress: the repair rungs first; a red lint refuses the boarding.',
  },
  {
    class: 'mcp-sign-in',
    decisionKey: 'mcp',
    journal: 'phase.mcp',
    situations: ['mcp-unavailable'],
    automatic: [],
    blurb: 'An MCP server will not connect: continue without it, or require it and park — as built.',
  },
  {
    class: 'ambiguity',
    decisionKey: 'ambiguity',
    journal: 'phase.ruling',
    situations: [],
    automatic: ['ruling'],
    blurb: 'The plan did not decide: record a ruling and continue, ask, or halt.',
  },
  {
    class: 'human-only',
    decisionKey: 'stop',
    journal: 'run.stop-requested',
    situations: [],
    automatic: [],
    blurb:
      "Stop, ask/steer and a foreign session's prompt are a person's; what the console owes them is a record.",
  },
]);

/** @type {Map<string, { row: PolicyRow; decisionKey: DecisionKey }>} */
const BY_SITUATION = new Map();
for (const row of POLICY_TABLE) {
  for (const entry of row.situations) {
    const [situation, key] = typeof entry === 'string' ? [entry, row.decisionKey] : entry;
    BY_SITUATION.set(situation, { row, decisionKey: key });
  }
}

/**
 * The class row governing a situation — the exact `id:sub` key first, then the
 * bare id, then `unknown-block`'s neighbour for anything the table never met
 * (a situation the classifier learns later files as plan health, the row that
 * says "a person reads the evidence").
 * @param {string} situationKey
 * @returns {{ row: PolicyRow; decisionKey: DecisionKey }}
 */
export function policyRowOf(situationKey) {
  const exact = BY_SITUATION.get(situationKey);
  if (exact) return exact;
  const head = situationKey.split(':')[0];
  const byHead = BY_SITUATION.get(head);
  if (byHead) return byHead;
  const fallback = POLICY_TABLE.find((r) => r.class === 'plan-health');
  return { row: /** @type {PolicyRow} */ (fallback), decisionKey: 'plan-health' };
}

/**
 * The manifest key an errand for `situationKey` carries.
 * @param {string} situationKey
 * @returns {DecisionKey}
 */
export function decisionKeyOfSituation(situationKey) {
  return policyRowOf(situationKey).decisionKey;
}

/**
 * Does `answer` mean "no person needed" for this situation's class? A pinned
 * row answers no whatever the word.
 * @param {string} situationKey
 * @param {string | null | undefined} answer
 */
export function isAutomaticAnswer(situationKey, answer) {
  if (!answer) return false;
  const { row } = policyRowOf(situationKey);
  if (row.pinned) return false;
  return row.automatic.includes(answer);
}

/**
 * Is `word` a legal answer for `key` — one of its closed words, or (for the 2
 * owner keys) a name?
 * @param {DecisionKey} key
 * @param {unknown} word
 * @returns {boolean}
 */
export function isAnswerWord(key, word) {
  if (typeof word !== 'string' || !word) return false;
  const words = DECISION_ANSWERS[key];
  if (words === null) return word.length <= 200;
  if (words.includes(word)) return true;
  return /** @type {readonly string[]} */ (OWNER_KEYS).includes(key) && OWNER_RE.test(word);
}

/**
 * The answer a manifest row's VALUE states, or `null` when it states none.
 *
 * A closed key answers with the first of its words found in the value
 * (backticks and bold stripped, so `` `require` `` and `**waive**` both read);
 * an owner key whose whole value is ONE name answers with that name; a
 * free-text key answers with the trimmed value. "n/a — QA off" answers nothing
 * for `qa.exhausted`: 4 tokens, no member, so the next source decides.
 * @param {DecisionKey} key
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function answerOf(key, value) {
  if (typeof value !== 'string') return null;
  const plain = value.replace(/[*`]/g, '').trim();
  if (!plain) return null;
  const words = DECISION_ANSWERS[key];
  if (words === null) return plain.slice(0, 200);
  const tokens = plain.split(/[^A-Za-z0-9._@/-]+/).filter(Boolean);
  const found = tokens.find((t) => words.includes(t));
  if (found) return found;
  if (
    /** @type {readonly string[]} */ (OWNER_KEYS).includes(key) &&
    tokens.length === 1 &&
    OWNER_RE.test(tokens[0])
  ) {
    return tokens[0];
  }
  return null;
}

/**
 * @typedef {object} ResolvedPolicy
 * @property {DecisionKey} decisionKey
 * @property {string} answer
 * @property {PolicySource} source
 */

/**
 * @typedef {object} PolicyInputs
 * @property {readonly { key: string; state: string; value: string }[]} [plan]
 *   the manifest rows as merged (`--decisions`): only an `answered` row counts
 * @property {{ policy?: Readonly<Record<string, unknown>> | null; delegateHumanGates?: unknown } | null} [prefs]
 *   this console's preferences — `policy.<key>`, and the one legacy switch
 *   that IS the `gates` answer (`delegateHumanGates`)
 * @property {{ resumeOnRestart?: boolean | null; relay?: string | null } | null} [run]
 *   the run's own answers, which outrank everything for their keys
 */

/**
 * The answer in force for `key`: run → plan → console → shipped default →
 * `null` (nothing anywhere says).
 * @param {DecisionKey} key
 * @param {PolicyInputs} inputs
 * @returns {ResolvedPolicy | null}
 */
export function resolvePolicy(key, inputs = {}) {
  const run = inputs.run ?? null;
  if (run) {
    if (key === 'resume.on-restart' && typeof run.resumeOnRestart === 'boolean') {
      return { decisionKey: key, answer: run.resumeOnRestart ? 'continue' : 'hold', source: 'run' };
    }
    if (key === 'relay' && typeof run.relay === 'string' && isAnswerWord(key, run.relay)) {
      return { decisionKey: key, answer: run.relay, source: 'run' };
    }
  }
  const row = (inputs.plan ?? []).find((r) => r.key === key && r.state === 'answered');
  const fromPlan = row ? answerOf(key, row.value) : null;
  if (fromPlan) return { decisionKey: key, answer: fromPlan, source: 'plan' };
  const prefs = inputs.prefs ?? null;
  const pref = prefs?.policy?.[key];
  if (isAnswerWord(key, pref))
    return { decisionKey: key, answer: /** @type {string} */ (pref), source: 'console' };
  if (key === 'gates' && typeof prefs?.delegateHumanGates === 'boolean') {
    return {
      decisionKey: key,
      answer: prefs.delegateHumanGates ? 'delegated' : 'operator',
      source: 'console',
    };
  }
  const shipped = POLICY_DEFAULTS[key];
  if (shipped) return { decisionKey: key, answer: shipped, source: 'default' };
  return null;
}

/**
 * A console's `policy` preference, coerced: unknown keys and words dropped,
 * owner names kept for the owner keys, nothing else invented. A free-text key
 * (`DECISION_ANSWERS[key] === null`) holds ONE LINE of at most 200 characters
 * since phase 12 — the policy editor answers every row, and the prelude shows
 * the console's line as the row's value (source `console`) where the plan is
 * silent; nothing enacts a line of prose, it is the answer in force by name.
 * @param {unknown} value
 * @returns {Partial<Record<DecisionKey, string>>}
 */
export function sanitisePolicyPrefs(value) {
  /** @type {Partial<Record<DecisionKey, string>>} */
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of DECISION_KEYS) {
    const word = /** @type {Record<string, unknown>} */ (value)[key];
    if (!isAnswerWord(key, word)) continue;
    if (DECISION_ANSWERS[key] === null && /[\r\n]/.test(/** @type {string} */ (word))) continue;
    out[key] = /** @type {string} */ (word).trim();
    if (!out[key]) delete out[key];
  }
  return out;
}

/**
 * The rules a `permission.destructive` value names as EXCEPTIONS — what lets
 * auto-grant answer a publishing ask the carve-out pins for a person
 * (zero-touch-console phase 13, TRS-4).
 *
 * The grammar is deliberately narrow, because the value is prose and the one
 * mistake that matters is reading a refusal as a permission: the word `allow`
 * opening a clause — at the start of the value or right after `;`, `.` or `,`
 * — and every backticked rule after it up to the clause's end (`;` or `.`). A backticked command prefix
 * (`` `gh pr create` ``) reads as its Bash rule; a whole rule
 * (`` `Bash(gh pr create:*)` ``) reads as itself. So
 * "deny; allow `Bash(gh pr create:*)`" names one exception, while
 * "deny — the wall does not allow `git push`" and the synthesised default
 * ("deny — … no phase publishes") name none.
 * @param {string | null | undefined} value
 * @returns {string[]}
 */
export function destructiveExceptions(value) {
  if (typeof value !== 'string' || !value) return [];
  // Clauses end at `;` or `.` OUTSIDE backticks — a rule may carry either
  // (`Bash(./scripts/publish.sh:*)`); a comma continues a list of rules.
  /** @type {string[]} */
  const clauses = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '`') quoted = !quoted;
    if (!quoted && (char === ';' || char === '.')) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  clauses.push(current);
  /** @type {Set<string>} */
  const rules = new Set();
  for (const clause of clauses) {
    const found = /(?:^|,)\s*allow\b(.*)$/i.exec(clause);
    if (!found) continue;
    for (const [, raw] of found[1].matchAll(/`([^`]+)`/g)) {
      const token = raw.trim();
      if (!token) continue;
      rules.add(/^[A-Za-z][\w-]*\(.*\)$/.test(token) ? token : `Bash(${token}:*)`);
    }
  }
  return [...rules];
}

/**
 * The payload `phase.policy-answered` carries — what an errand would have
 * asked for, answered by which source, so the journal reads like the ruling
 * it is.
 * @param {{ phase: number; situation: string; decisionKey: string; policy?: { answer: string; source: string } | null }} errand
 */
export function policyAnsweredPayload(errand) {
  return {
    phase: errand.phase,
    situation: errand.situation,
    decisionKey: errand.decisionKey,
    answer: errand.policy?.answer ?? null,
    source: errand.policy?.source ?? null,
  };
}
