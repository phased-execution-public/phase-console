/**
 * Why a run stopped, in one of nine words — and what that word says to do.
 *
 * A stopped run used to be explained four times, four ways: the status strip
 * printed the halt's reason, the Ways-forward card derived prose of its own,
 * the errand card quoted the ladder's ask, and the inbox row quoted the
 * server's `need`. Each was true and none of them said what KIND of stop it
 * was, so a person reading "the API refused the connection" could not tell a
 * signed-out login from an outage from a spent budget without reading the
 * sentence twice. This module is the one answer, for every surface:
 *
 *   - `HALT_CATEGORIES` — eight families plus the operator's own stop, the
 *     table in control-tower §Architecture 4;
 *   - `HALT_KIND_CATEGORY` — TOTAL over `HALT_KINDS` by construction: built on
 *     `fact-map.js` `HALT_KIND_SITUATION` (each situation has a category), with
 *     the kinds whose situation is too coarse overridden by name;
 *   - `SUB_KIND_CATEGORY` — the `id:sub` situation keys that move a stop to
 *     another family (a declared block that is really a CI wait is `external`);
 *   - `CAUSE_SENTENCE` — one plain sentence per kind, the card's headline;
 *   - `haltSentence(halt)` — that sentence for a surface that prints it
 *     without the card; `haltView(run, ctx)`, everything the card draws, is in
 *     `halt-view.js` beside it, because it asks the recovery model for the
 *     recommended verb and this module is on the first-paint path.
 *
 * A `nothing-ready` park is UNPACKED: its `halt.holders` become one row each,
 * with the one action that clears that holder. And the unpacking is what
 * fixes the situation such a park is read as — a stop held only by automatic
 * gates is a wait, never `gated-manual` (`nothingReadySituation`, #48).
 *
 * Dependency-free ESM like its neighbours: the client imports it as
 * `@shared/halt-categories.js`, the server as `../shared/halt-categories.js`.
 */

import { HALT_KIND_SITUATION } from './fact-map.js';

/* ------------------------------------------------------------------ *
 * The categories
 * ------------------------------------------------------------------ */

/**
 * The nine families a stop falls into, in the order the card reads them:
 * what needs a person first, then the walls, then the machinery, then the
 * operator's own act.
 * @typedef {(typeof HALT_CATEGORIES)[number]} HaltCategory
 */
export const HALT_CATEGORIES = Object.freeze(
  /** @type {const} */ ([
    'decision',
    'credentials',
    'limits',
    'environment',
    'plan',
    'verification',
    'external',
    'conflict',
    'operator',
  ]),
);

/** @param {unknown} value @returns {value is HaltCategory} */
export function isHaltCategory(value) {
  return typeof value === 'string' && HALT_CATEGORIES.includes(/** @type {HaltCategory} */ (value));
}

/** What each family is called on the card. @type {Readonly<Record<HaltCategory, string>>} */
export const HALT_CATEGORY_LABELS = Object.freeze({
  decision: 'Needs your decision',
  credentials: 'Credentials and accounts',
  limits: 'Usage limits and budget',
  environment: 'Environment and network',
  plan: 'Plan defect',
  verification: 'Verification and unfinished work',
  external: 'External wait',
  conflict: 'Conflicts, locks and restarts',
  operator: 'Stopped by you',
});

/**
 * What usually moves each family — the third column of §Architecture 4, said
 * once under the card's sentence. It describes the fix; the BUTTON is the
 * recovery model's first verb for this exact stop.
 * @type {Readonly<Record<HaltCategory, string>>}
 */
export const HALT_CATEGORY_FIX = Object.freeze({
  decision: 'Answer what it asks — approve, re-run or waive QA — then continue.',
  credentials: 'Sign in again, then clear the account’s retirement.',
  limits: 'Switch account, or raise the budget by minutes or dollars.',
  environment: 'Continue once the network or the server is back, or continue without it.',
  plan: 'Repair the plan file, then continue.',
  verification: 'Resume the phase with the failure, close it out, or retry it.',
  external: 'Look again once the thing it waits on has happened.',
  conflict: 'Release the lock, continue, or retry the phase that holds it.',
  operator: 'Start the run again when you want it to carry on.',
});

/**
 * Every situation → its family. TOTAL over `SITUATIONS` (the test holds it),
 * so every halt kind — each of which names a situation — has a family by
 * construction.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
export const SITUATION_CATEGORY = Object.freeze({
  superseded: 'operator',
  'qa-failed': 'decision',
  'qa-pending': 'decision',
  'foreign-live': 'conflict',
  'foreign-stale': 'conflict',
  'waiting-external': 'external',
  'gated-manual': 'decision',
  'mcp-unavailable': 'environment',
  'resource-wall': 'limits',
  'blocked-declared': 'decision',
  'plan-broken': 'plan',
  'verify-red': 'verification',
  'done-unrecorded': 'verification',
  'work-in-progress': 'verification',
  'never-started': 'environment',
  unknown: 'environment',
});

/**
 * The situation keys (`id:sub`) whose family is not their situation's. A
 * refused credential is a resource wall to the ladder and a sign-in to a
 * person; a declared block on CI is a wait; one on a lock is a conflict.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
export const SUB_KIND_CATEGORY = Object.freeze({
  'resource-wall:auth': 'credentials',
  'blocked-declared:credential': 'credentials',
  'blocked-declared:external': 'external',
  'blocked-declared:lock': 'conflict',
  'never-started:refusal': 'credentials',
});

/**
 * The family each kind of person's turn lights on the Tower's annunciator
 * (control-tower phase 42): a sign-in is a credential, an act at the machine
 * is its environment, somebody else's dashboard is an external wait, a check
 * by eye is verification, and a decision or a protected edit is a decision.
 * Keyed by exactly `HUMAN_STEP_KINDS` (`shared/human-step-model.js`) — the
 * client's card test holds the two together.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
export const HUMAN_STEP_CATEGORY = Object.freeze({
  'browser-login': 'credentials',
  'device-code': 'credentials',
  'one-time-code': 'credentials',
  'secret-entry': 'credentials',
  'claude-login': 'credentials',
  'mcp-login': 'credentials',
  'os-prompt': 'environment',
  'os-permission': 'environment',
  'third-party-approval': 'external',
  physical: 'environment',
  'person-check': 'verification',
  decision: 'decision',
  'protected-path': 'decision',
  'interactive-prompt': 'environment',
  captcha: 'external',
  'email-link': 'external',
  // A command or a click path only the operator runs (control-tower phase 121).
  // Its family is its REASON's (phase 130, `humanStepCategory`); this row is
  // the default reason's — `reserved`, a decision only a person may make.
  'operator-act': 'decision',
  // A wall the AI met (control-tower phase 130): granting it is a decision.
  permission: 'decision',
});

/**
 * The family an item's REASON names (control-tower phase 130, §Architecture
 * 19): a sign-in or a secret is a credential, hands at a device the
 * environment, an unreachable system or somebody else's approval an external
 * wait, and every other reason a decision. Keyed by exactly `WHY_PERSON`.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
export const REASON_CATEGORY = Object.freeze({
  permission: 'decision',
  identity: 'credentials',
  secret: 'credentials',
  money: 'decision',
  legal: 'decision',
  decision: 'decision',
  physical: 'environment',
  reach: 'external',
  'third-party': 'external',
  reserved: 'decision',
});

/**
 * The family an item lights: an `operator-act` — the general act on the
 * person's side — by its reason; every other kind by its kind.
 * @param {string} kind
 * @param {string} [why]
 * @returns {HaltCategory}
 */
export function humanStepCategory(kind, why) {
  const byReason = kind === 'operator-act' && why ? REASON_CATEGORY[why] : undefined;
  return byReason ?? HUMAN_STEP_CATEGORY[kind] ?? 'decision';
}

/**
 * The kinds whose situation is too coarse to name the family: the crash-shaped
 * `unknown` holds a merge conflict, a streak and a refused checkout alike, and
 * a refused credential's `resource-wall` is a sign-in, not a budget.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
const KIND_CATEGORY_OVERRIDE = Object.freeze({
  'credential-refused': 'credentials',
  'identity-changed': 'credentials',
  'run-preflight': 'credentials',
  'failure-streak': 'verification',
  'verify-timeout': 'verification',
  'worktree-merge': 'conflict',
  'landing-conflict': 'conflict',
  'isolation-refused': 'conflict',
  unlanded: 'conflict',
  'interrupted-by-restart': 'conflict',
  'nothing-ready': 'conflict',
  'operator-stop': 'operator',
});

/**
 * Every halt kind → its family. Built, not written: the kind's situation's
 * family, unless the kind is overridden above. Total because
 * `HALT_KIND_SITUATION` is (fact-map.test) and `SITUATION_CATEGORY` is.
 * @type {Readonly<Record<string, HaltCategory>>}
 */
export const HALT_KIND_CATEGORY = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ Object.fromEntries(
    Object.keys(HALT_KIND_SITUATION).map((kind) => [
      kind,
      KIND_CATEGORY_OVERRIDE[kind] ?? SITUATION_CATEGORY[HALT_KIND_SITUATION[kind]] ?? 'environment',
    ]),
  ),
);

/**
 * One sentence per halt kind: what happened, in the words of the person
 * reading it. The runner's own reason stays one press away, verbatim.
 * @type {Readonly<Record<string, string>>}
 */
export const CAUSE_SENTENCE = Object.freeze({
  'verify-failed': 'The phase finished its work, but its verification did not pass.',
  'no-handoff': 'The session ended without writing the handoff that marks the phase done.',
  'phase-blocked': 'The session stopped on something it could not do itself and wrote a blocked handoff.',
  'waiting-external-timeout':
    'The phase waited on something outside the console, and the wait ran out first.',
  'needs-human': 'The phase needs a step only a person can take.',
  'plan-approval':
    'A plan-mode session presented its plan, and the plan waits for you to approve or reject it.',
  'plan-lint': 'The plan file fails its lint, so the console will not run it.',
  'phase-crashed': 'The phase’s session crashed before it finished.',
  budget: 'The run spent all the money it was allowed.',
  'plan-unreadable': 'The console could not read the plan file.',
  'failure-streak': 'Too many phases failed in a row, so the run stopped itself.',
  'models-exhausted': 'Every model this run may use is at its usage limit.',
  'verification-preflight': 'A verification line in the plan is one the console will not run as written.',
  'mcp-preflight': 'An MCP server this phase requires could not connect.',
  'run-preflight': 'The run could not start: its account or configuration failed the checks.',
  'recovery-failed': 'An automatic recovery attempt crashed or could not finish.',
  'orphaned-session': 'A session left by an earlier console still holds this phase.',
  'runner-crashed': 'The console’s drive loop crashed while it ran this plan.',
  'worktree-merge': 'Two lanes changed the same lines, and git would not merge them.',
  'landing-conflict': 'The phase is done, but its work would not merge onto the run branch.',
  'plan-deadlocked': 'A QA verdict holds every phase that is left.',
  'nothing-ready': 'Nothing is ready to run: every phase that is left is held by one of the things below.',
  'interrupted-by-restart': 'The console restarted while this run was working.',
  'operator-stop': 'You stopped this run.',
  'awaiting-person': 'A card asked a person, and nobody answered it in time.',
  'credential-refused': 'The run’s Claude account was refused.',
  'identity-changed': 'The run’s account now signs in as somebody else.',
  'verify-timeout': 'A verification command ran past its time limit twice.',
  'isolation-refused': 'The run asked for a checkout of its own and could not have one.',
  unlanded: 'Every phase is done, but the run’s branch is not on its trunk yet.',
});

/**
 * The sentence for a halt written before kinds existed AND without a reason.
 * A kindless halt WITH one reads in its own words — they are all it has.
 */
export const UNKINDED_SENTENCE = 'The run stopped without saying why.';

/* ------------------------------------------------------------------ *
 * Holders — a `nothing-ready` park, unpacked
 * ------------------------------------------------------------------ */

/**
 * What each holder is called on its row.
 * @type {Readonly<Record<string, string>>}
 */
export const HOLDER_LABELS = Object.freeze({
  gate: 'Gate',
  errand: 'Needs you',
  cap: 'Recovery cap',
  retry: 'Stopped',
  lock: 'Lock',
  blocked: 'Blocked handoff',
  qa: 'QA verdict',
  mcp: 'MCP server',
  verification: 'Verification line',
});

/** Each holder's family. @type {Readonly<Record<string, HaltCategory>>} */
export const HOLDER_CATEGORY = Object.freeze({
  gate: 'decision',
  errand: 'decision',
  cap: 'limits',
  retry: 'verification',
  lock: 'conflict',
  blocked: 'decision',
  qa: 'decision',
  mcp: 'environment',
  verification: 'plan',
});

/**
 * The one action per holder verb: a PRESS names the recovery verb the
 * console runs; a holder with no press is a door a person opens — the gate
 * card, the run settings, the QA verdict — and the row links there.
 * @type {Readonly<Record<string, { label: string, press: string | null }>>}
 */
export const HOLDER_ACTIONS = Object.freeze({
  'approve-gate': { label: 'Open the gate', press: null },
  retry: { label: 'Retry', press: 'retry' },
  settings: { label: 'Raise the cap', press: null },
  'qa-recover': { label: 'Open the QA verdict', press: null },
  'mcp-continue': { label: 'Continue without the server', press: 'mcp-continue' },
  'errand-answered': { label: 'Done — continue', press: 'errand-answered' },
});

/** An automatic gate that has not cleared is a wait: it is looked at again, never approved. */
export const AUTOMATIC_GATE_ACTION = Object.freeze({ label: 'Look again', press: 'recheck' });

/**
 * The gate verdicts that are a PERSON's to clear — `--gate-status`'s `manual:`
 * (and a deadline gone `OVERDUE:`). A holder whose gate reads anything else
 * (`blocked:` on a phase, plan, date or cmd gate; `unevaluated:`) waits on a
 * machine. A holder written before the verdict was carried has none, and is
 * read the old way — as a person's.
 * @param {string | undefined | null} gateKind
 */
export function isPersonGate(gateKind) {
  return gateKind == null || gateKind === 'manual' || gateKind === 'OVERDUE' || gateKind === 'human';
}

/**
 * @typedef {{ label: string, phasesLeft?: number, eta?: string }} ChainLink
 * @typedef {{ phase: number, kind: string, verb: string, why: string, setting?: string, gate?: string, gateKind?: string, situation?: string, chain?: readonly ChainLink[] }} HolderLike
 * @typedef {{
 *   phase: number, kind: string, verb: string, why: string,
 *   label: string, category: HaltCategory, automatic: boolean,
 *   setting?: string, gate?: string, chain?: ChainLink[],
 *   action: { label: string, press: string | null },
 * }} HolderView
 */

/**
 * One row per holder, each with its own action. Unknown holder kinds (a newer
 * server) still get a row — the server's `why` and a Retry.
 * @param {readonly HolderLike[] | null | undefined} holders
 * @returns {HolderView[]}
 */
export function holderViews(holders) {
  return (holders ?? []).map((h) => {
    const automatic = h.kind === 'gate' && !isPersonGate(h.gateKind);
    return {
      phase: h.phase,
      kind: h.kind,
      verb: h.verb,
      why: h.why,
      label: HOLDER_LABELS[h.kind] ?? h.kind,
      // An errand says what kind of wall it is; a sub-kind that moves the family
      // moves the row too (control-tower phase 33).
      category: automatic
        ? 'external'
        : ((h.situation ? SUB_KIND_CATEGORY[h.situation] : undefined) ??
          HOLDER_CATEGORY[h.kind] ??
          'conflict'),
      automatic,
      ...(h.setting ? { setting: h.setting } : {}),
      ...(h.gate ? { gate: h.gate } : {}),
      ...(h.chain?.length ? { chain: h.chain.map((link) => ({ ...link })) } : {}),
      action: automatic ? AUTOMATIC_GATE_ACTION : (HOLDER_ACTIONS[h.verb] ?? HOLDER_ACTIONS.retry),
    };
  });
}

/** Which situation a holder puts its phase in, for the run's reading of the park. */
const HOLDER_SITUATION = Object.freeze({
  gate: 'gated-manual',
  errand: 'blocked-declared',
  cap: 'resource-wall:budget',
  retry: 'unknown',
  lock: 'foreign-live',
  blocked: 'blocked-declared',
  qa: 'qa-pending',
  mcp: 'mcp-unavailable',
  verification: 'plan-broken:verification',
});

/**
 * The situation a `nothing-ready` park IS, read from its holders (#48).
 *
 * The fact map's static answer is `gated-manual` — a gate is the door the
 * corpus shows most — and it was wrong for the stop #48 measured: a plan held
 * only by AUTOMATIC gates (another plan's phases, a date, a command) was read
 * as a person's gate, so the recover verb raised an errand asking somebody to
 * approve what no person can. Held only by gates that clear themselves, the
 * park is a wait. Any person's gate makes it `gated-manual`; otherwise the
 * first holder names it. No holders (a park written before they existed)
 * keeps the old reading.
 * @param {{ holders?: readonly HolderLike[] | null } | null | undefined} halt
 * @returns {string}
 */
export function nothingReadySituation(halt) {
  const holders = halt?.holders ?? [];
  if (!holders.length) return HALT_KIND_SITUATION['nothing-ready'];
  const gates = holders.filter((h) => h.kind === 'gate');
  if (gates.length === holders.length && gates.every((h) => !isPersonGate(h.gateKind))) {
    return 'waiting-external';
  }
  if (gates.some((h) => isPersonGate(h.gateKind))) return 'gated-manual';
  const first = holders.find((h) => h.kind !== 'gate') ?? holders[0];
  // An errand names its own situation — a declared external wall is one, not
  // any block (control-tower phase 33).
  if (first.kind === 'errand' && first.situation) return first.situation;
  return HOLDER_SITUATION[/** @type {keyof typeof HOLDER_SITUATION} */ (first.kind)] ?? 'unknown';
}

/* ------------------------------------------------------------------ *
 * Reading a stop
 * ------------------------------------------------------------------ */

/**
 * A word `HALT_KINDS` holds. Read through the fact map, which is total over
 * that list (fact-map.test), so this module never loads the recovery model:
 * it is on the first-paint path (the runs ledger's sentence), and the model
 * is not (`check-dist`, 190 KB served).
 * @param {unknown} value
 */
export function isHaltKind(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HALT_KIND_SITUATION, value);
}

/**
 * The family of a situation key (`id` or `id:sub`), sub-kind first.
 * @param {string | null | undefined} key
 * @returns {HaltCategory | null}
 */
export function categoryOfSituation(key) {
  if (!key) return null;
  if (SUB_KIND_CATEGORY[key]) return SUB_KIND_CATEGORY[key];
  const id = key.split(':')[0];
  return SITUATION_CATEGORY[id] ?? null;
}

/**
 * The family of a halt: its kind's, unless the phase's situation is sharper
 * (a `phase-blocked` whose sub-kind is `external` waits; one on `lock` is a
 * conflict). A kindless legacy halt falls to its situation, else environment.
 * @param {string | null | undefined} kind
 * @param {string | null | undefined} [situationKey]
 * @returns {HaltCategory}
 */
export function categoryOfHalt(kind, situationKey) {
  const sub = situationKey && SUB_KIND_CATEGORY[situationKey];
  if (sub) return sub;
  // A park held only by gates that clear themselves is a wait (#48).
  if (kind === 'nothing-ready' && situationKey === 'waiting-external') return 'external';
  if (kind && isHaltKind(kind)) return HALT_KIND_CATEGORY[kind];
  return categoryOfSituation(situationKey) ?? 'environment';
}

/**
 * The situation a run halt reads as, for the card: the fact map's word, a
 * `nothing-ready` park read from its holders.
 * @param {{ kind?: string, holders?: readonly HolderLike[] | null } | null | undefined} halt
 */
export function haltSituation(halt) {
  if (!halt?.kind || !isHaltKind(halt.kind)) return 'unknown';
  if (halt.kind === 'nothing-ready') return nothingReadySituation(halt);
  return HALT_KIND_SITUATION[halt.kind];
}

/**
 * Whether a halt reads as a sign-in problem — the one test every surface that
 * offers "Sign in again" used to spell out against the reason on its own.
 * The kind first; a halt written before kinds existed falls to its words.
 * @param {{ kind?: string, reason?: string } | null | undefined} halt
 */
export function isAuthHalt(halt) {
  if (!halt) return false;
  if (halt.kind === 'credential-refused' || halt.kind === 'run-preflight') return true;
  return /sign(ed)? in|authenticat/i.test(halt.reason ?? '');
}

/**
 * The runner's own words for a stop, verbatim — for the one place that shows
 * them (the halt card's details) and the few readers that quote them as a
 * hint. Never the card's headline: that is `CAUSE_SENTENCE`.
 * @param {{ reason?: string } | null | undefined} halt
 */
export function haltReasonOf(halt) {
  return typeof halt?.reason === 'string' && halt.reason.trim() ? halt.reason : undefined;
}

/**
 * The card's one sentence for a halt, and nothing else — for a surface that
 * prints the sentence without drawing the card (the runs ledger, the plan's
 * health banner). A kindless halt reads in its own words; they are all it has.
 * @param {{ kind?: string, reason?: string } | null | undefined} halt
 */
export function haltSentence(halt) {
  if (!halt) return undefined;
  if (halt.kind && isHaltKind(halt.kind)) return CAUSE_SENTENCE[halt.kind];
  return haltReasonOf(halt) ?? UNKINDED_SENTENCE;
}
