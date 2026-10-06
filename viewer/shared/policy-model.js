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
import { ISSUE_MODES } from './issue-modes.js';
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
    'protected-path-block',
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
  'plan-approval': Object.freeze(['hold', 'continue']),
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
  // A plan a session presents is held for a person unless the plan says
  // otherwise (control-tower phase 11, #34) — the one answer that lets a
  // plan-mode phase mean what its author wrote.
  'plan-approval': 'hold',
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
      'git push, gh pr create and gh pr merge: a card for a person that auto-grant never answers — unless this row names the command, or the branch pushed, for the running phase, and then the grant is announced. A push the row allows in another shape is refused at once, naming the bare form.',
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
    blurb:
      "A manual gate is a person's: never delegated, approved only from the Gate card or their own terminal. The gates row delegates only an overdue deadline, to the session that can evidence it.",
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
    class: 'protected-path-block',
    decisionKey: 'human-acts',
    journal: 'phase.errand',
    // The acts a plan keeps for a person joined the edit the CLI keeps for one
    // (control-tower phase 53, #54): one row, the same manifest key.
    situations: ['blocked-declared:protected-path', 'blocked-declared:human-acts'],
    automatic: [],
    blurb:
      "An edit the CLI's own wall reserves for an interactive session, or an act the plan keeps for a person: " +
      'always a person\'s, as an errand naming the act — or handed to the session with "Delegate to the session".',
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
      // Phase 62's re-opened red (a complete handoff over a red final
      // verification) raises its own ask; it is the same plan-health question.
      'verify-red:reopened',
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
 * One command a `permission.destructive` value names as an EXCEPTION, and the
 * phases it is named for (control-tower phase 107, #205).
 *
 * `rule` is the Bash rule the token reads as (`` `gh pr create` `` →
 * `Bash(gh pr create:*)`; a whole rule `` `Bash(…)` `` reads as itself);
 * `verb` is the token's leading words before its first option and `options`
 * the option words it names (`gh pr merge --squash --delete-branch` → verb
 * `gh pr merge`, options `--squash --delete-branch`) — a call is the named
 * command when it starts with the verb and carries every named option.
 * `phases` is null for every phase.
 * @typedef {object} DestructiveException
 * @property {string} rule
 * @property {string[]} verb
 * @property {string[]} options
 * @property {number[] | null} phases
 */

/**
 * The commands a `permission.destructive` value names as EXCEPTIONS, each with
 * its phases — what lets the console answer a publishing ask the carve-out pins
 * for a person (zero-touch-console phase 13, TRS-4; control-tower phase 107,
 * #205).
 *
 * The value is prose, and the one mistake that matters is reading a refusal as
 * a permission, so the grammar is narrow. A list of exceptions is OPENED by:
 *
 *   - the word `allow` at the start of a clause or right after a comma
 *     ("deny; allow `Bash(gh pr create:*)`", "deny, allow `gh pr create`") —
 *     every backticked token up to the clause's end (`;` or `.`);
 *   - or "with these allow rows:" / "the following allow rows:" (`allowed`,
 *     `commands` and `exceptions` read alike) — the tokens after the colon.
 *
 * A list opened that way CONTINUES across `;` into each following clause that
 * begins with a phase qualifier — `Phase 1 —`, `Phases 4/17/22 —`,
 * `Phases 4, 17 and 22:`, `every phase —` — and has no negation in it; a `.`
 * or a clause without one ends it. A clause's phases are its leading
 * qualifier, else one written in it ("in phases 4 and 17", "— phase 74 ONLY"),
 * else every phase. So ai-builder-v7's row — "deny, with these allow rows:
 * Phase 1 — `gh label create`, `gh issue create`; Phases 4/17/22 — `gh pr
 * create`, `gh pr merge --squash --delete-branch`, …; every phase — `git
 * push` of `pe/ai-builder-v7` …" — names `gh pr create` for phases 4, 17 and
 * 22 alone, and "deny — the wall does not allow `git push`" names nothing.
 *
 * In a list read past the classic opener, a `git push` token is never a whole
 * rule: the branches such a clause pushes are `destructivePushBranches`'s to
 * read, and reading the verb as `Bash(git push:*)` would let it push anywhere.
 * Nor is a token that does not begin with a command name (a branch, a path).
 * @param {string | null | undefined} value
 * @returns {DestructiveException[]}
 */
export function destructiveCommandExceptions(value) {
  if (typeof value !== 'string' || !value) return [];
  /** @type {DestructiveException[]} */
  const out = [];
  let listing = false;
  for (const { text, end } of clausesWithEnds(value)) {
    const plain = text.replace(/\*\*/g, '');
    const classic = /(?:^|,)\s*allow\b(.*)$/i.exec(plain);
    const opened = classic
      ? null
      : /(?:^|[,:(])\s*(?:with\s+)?(?:these|the\s+following)\s+allow(?:ed)?(?:\s+(?:rows?|commands?|exceptions?))?\s*:(.*)$/i.exec(
          plain,
        );
    const lead = leadingPhases(plain);
    /** @type {string | null} */
    let region = null;
    let continuing = false;
    if (classic) region = classic[1];
    else if (opened) region = opened[1];
    else if (listing && lead && !LIST_NEGATION.test(plain)) {
      region = plain.slice(lead.length);
      continuing = true;
    }
    if (region !== null) {
      // The clause's own leading qualifier, else one leading the list after
      // the opener ("allow rows: Phase 1 — …"), else one written in it.
      const qualifier = continuing ? lead : leadingPhases(region);
      const phases = qualifier ? qualifier.phases : writtenPhases(region);
      const body = continuing || !qualifier ? region : region.slice(qualifier.length);
      for (const [, raw] of body.matchAll(/`([^`]+)`/g)) {
        const entry = exceptionOf(raw.trim(), phases, Boolean(classic));
        if (entry) out.push(entry);
      }
    }
    listing = region !== null && end === ';';
  }
  return out;
}

/**
 * The rules a `permission.destructive` value names as exceptions, as rule
 * strings — `destructiveCommandExceptions`, narrowed to the phase when one is
 * given (`ctx.phase`). Without a phase, every named rule, whatever its phases
 * (the shape TRS-4's readers and the docs example were written against).
 * @param {string | null | undefined} value
 * @param {{ phase?: number | null }} [ctx]
 * @returns {string[]}
 */
export function destructiveExceptions(value, ctx = {}) {
  const phase = typeof ctx.phase === 'number' ? ctx.phase : null;
  return [
    ...new Set(
      destructiveCommandExceptions(value)
        .filter((entry) => phase === null || entry.phases === null || entry.phases.includes(phase))
        .map((entry) => entry.rule),
    ),
  ];
}

/** A negation that turns a continued clause into a refusal: "Phase 3 — never `gh pr merge`". */
const LIST_NEGATION = /\b(?:never|not|no|deny|denies|denied|refuse[sd]?|forbid(?:s|den)?|except)\b/i;

/** A list of phase numbers as a row writes one: `4/17/22`, `4, 17 and 22`, `4–7`. */
const PHASE_LIST = String.raw`\d+(?:\s*(?:[–-]\s*\d+))?(?:\s*(?:\/|,|&|\+|\band\b|\bor\b)\s*\d+(?:\s*(?:[–-]\s*\d+))?)*`;

/** The phase numbers in a written list, ranges expanded (bounded — a typo cannot ask for millions). */
function phaseNumbers(list) {
  /** @type {number[]} */
  const out = [];
  for (const part of list.split(/\/|,|&|\+|\band\b|\bor\b/)) {
    const range = /^\s*(\d+)\s*(?:[–-]\s*(\d+))?\s*$/.exec(part);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;
    for (let n = from; n <= to && n - from < 1000; n += 1) out.push(n);
  }
  return [...new Set(out)];
}

/**
 * A clause's LEADING phase qualifier — `Phase 1 —`, `Phases 4/17/22 —`,
 * `every phase —` — and how many characters it takes, or null.
 * @param {string} text
 * @returns {{ phases: number[] | null; length: number } | null}
 */
function leadingPhases(text) {
  const every = /^\s*(?:(?:in|for)\s+)?(?:every|each|all)\s+phases?\b\s*[—–:-]\s*/i.exec(text);
  if (every) return { phases: null, length: every[0].length };
  const named = new RegExp(
    String.raw`^\s*(?:(?:in|for)\s+)?phases?\s+(${PHASE_LIST})\s*(?:only\b)?\s*[—–:]\s*`,
    'i',
  ).exec(text);
  if (!named) return null;
  const phases = phaseNumbers(named[1]);
  return phases.length ? { phases, length: named[0].length } : null;
}

/** Phases written INSIDE a clause — "in phases 4 and 17", "— phase 74 ONLY" — or null for every phase. */
function writtenPhases(text) {
  const found = new RegExp(String.raw`(?:\b(?:in|for|during)\s+|[—–]\s*)phases?\s+(${PHASE_LIST})`, 'i').exec(
    text,
  );
  if (!found) return null;
  const phases = phaseNumbers(found[1]);
  return phases.length ? phases : null;
}

/**
 * One backticked token as an exception, or null. `classic` keeps TRS-4's
 * reading for a list the word `allow` opened: any token, `git push` included,
 * as the rule it spells.
 * @param {string} token
 * @param {number[] | null} phases
 * @param {boolean} classic
 * @returns {DestructiveException | null}
 */
function exceptionOf(token, phases, classic) {
  if (!token) return null;
  const whole = /^([A-Za-z][\w-]*)\((.*)\)$/.exec(token);
  const command = whole ? (whole[1] === 'Bash' ? whole[2].replace(/:\*$/, '').trim() : '') : token;
  const words = command.split(/\s+/).filter(Boolean);
  const verb = [];
  for (const word of words) {
    if (word.startsWith('-')) break;
    verb.push(word);
  }
  const options = words.filter((word) => word.startsWith('-'));
  if (!classic) {
    if (!/^[A-Za-z][\w.-]*$/.test(words[0] ?? '')) return null;
    if (verb[0] === 'git' && verb[1] === 'push') return null;
  }
  const rule = whole ? token : `Bash(${token}:*)`;
  return {
    rule,
    verb: whole && whole[1] !== 'Bash' ? [] : verb,
    options: whole && whole[1] !== 'Bash' ? [] : options,
    phases,
  };
}

/**
 * A row's clauses, with the separator that ended each (`;`, `.`, or `''` at the
 * end). They end at `;` or `.` OUTSIDE backticks — a rule may carry either
 * (`Bash(./scripts/publish.sh:*)`); a comma continues a list of rules.
 * @param {string} value
 * @returns {{ text: string; end: string }[]}
 */
function clausesWithEnds(value) {
  /** @type {{ text: string; end: string }[]} */
  const clauses = [];
  let current = '';
  let quoted = false;
  for (const char of value) {
    if (char === '`') quoted = !quoted;
    if (!quoted && (char === ';' || char === '.')) {
      clauses.push({ text: current, end: char });
      current = '';
      continue;
    }
    current += char;
  }
  clauses.push({ text: current, end: '' });
  return clauses;
}

/**
 * A row's clauses. They end at `;` or `.` OUTSIDE backticks — a rule may carry
 * either (`Bash(./scripts/publish.sh:*)`); a comma continues a list of rules.
 * @param {string} value
 * @returns {string[]}
 */
function clausesOf(value) {
  return clausesWithEnds(value).map((clause) => clause.text);
}

/**
 * The branch names a trunk goes by. A push to one is never answered from a
 * `permission.destructive` row, whatever the row says (control-tower phase 84,
 * #112): a row that names `main` names it for another repository as often as
 * not ("hub `main` pathspec pushes"), and a trunk push is the one publish that
 * nothing quietly undoes — it stays a person's card.
 */
export const TRUNK_BRANCHES = Object.freeze(/** @type {const} */ (['main', 'master', 'trunk']));

/** A word that turns the phrase after it into a refusal: "never push to", "deny pushes to". */
const PUSH_NEGATION =
  /\b(?:never|not|no|nor|deny|denies|denied|refuse[sd]?|forbid(?:s|den)?|without|except)\b[^`]{0,12}$/i;

/** A branch name as a row writes one: no space, no refspec colon, no glob, not an option. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/**
 * The branches a `permission.destructive` value names as ones a session may
 * push to (control-tower phase 84, #112).
 *
 * The value is prose, and the one mistake that matters is reading a refusal as
 * a permission, so the grammar is narrow: after "push to" / "pushes to" /
 * "push of" (the verb may close a backticked `git push`), either "the run
 * branch" — which is `ctx.runBranch`, when the caller knows it — or a run of
 * backticked names joined by `+`, `,`, `and`, `or` or `&`. A negation just
 * before the phrase ("never push to", "deny pushes to") names nothing, and a
 * trunk (`TRUNK_BRANCHES`) is never read. So vca-refactor's "may publish:
 * branch pushes to `pe/vca-refactor` + `fix/vca-backend-gaps`, hub `main`
 * pathspec pushes" names the two branches and not the other repository's trunk.
 *
 * With `ctx.phase`, a clause qualified for OTHER phases — `Phases 4/17 — push
 * to `release/x`` — names nothing for this one (control-tower phase 107, #205:
 * a phase-qualified list is read per phase); an unqualified clause is every
 * phase's.
 * @param {string | null | undefined} value
 * @param {{ runBranch?: string | null; phase?: number | null }} [ctx]
 * @returns {string[]}
 */
export function destructivePushBranches(value, ctx = {}) {
  if (typeof value !== 'string' || !value) return [];
  const phase = typeof ctx.phase === 'number' ? ctx.phase : null;
  /** @type {Set<string>} */
  const out = new Set();
  for (const clause of clausesOf(value)) {
    const plain = clause.replace(/\*\*/g, '');
    if (phase !== null) {
      const phases = leadingPhases(plain)?.phases ?? writtenPhases(plain);
      if (phases && !phases.includes(phase)) continue;
    }
    const phrase = /\bpush(?:es)?`?\s+(?:to|of)\s+/gi;
    for (let hit = phrase.exec(plain); hit; hit = phrase.exec(plain)) {
      if (PUSH_NEGATION.test(plain.slice(0, hit.index))) continue;
      const rest = plain.slice(hit.index + hit[0].length);
      if (/^(?:the\s+)?run\s+branch\b/i.test(rest)) {
        if (ctx.runBranch) out.add(ctx.runBranch);
        continue;
      }
      const list = /^`([^`]+)`((?:\s*(?:\+|,|&|\band\b|\bor\b)\s*`[^`]+`)*)/i.exec(rest);
      if (!list) continue;
      for (const raw of [list[1], ...[...list[2].matchAll(/`([^`]+)`/g)].map((m) => m[1])]) {
        const name = raw.trim().replace(/^refs\/heads\//, '');
        if (BRANCH_NAME.test(name) && !TRUNK_BRANCHES.includes(/** @type {never} */ (name))) out.add(name);
      }
    }
  }
  return [...out];
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
