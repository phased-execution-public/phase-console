/**
 * The situation model: ONE vocabulary for "why is this phase not done, and
 * who can do something about it".
 *
 * The autopilot used to choose its remedy from the HALT KIND assigned at the
 * halt site — a word about where the runner stopped, not about the phase. The
 * three measured dead ends (the 2026-08-19 design investigation) were all the
 * same mistake: a never-started phase read as "interrupted" and parked; an
 * in-progress handoff read as "missing paperwork" and closed out twice; a
 * declared blocker read as "no handoff" and re-confirmed for $68. A situation
 * is a claim about the PHASE, computed from evidence (board, handoff, record,
 * lock, working tree, declared outcome, gate, MCP, health) by
 * `server/runner/situation.ts` — this file is only the words.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `recovery-model.js` precedent: the
 * client imports it as `@shared/situation-model.js`, the server as
 * `../../shared/situation-model.js`, and the node tests directly — so one
 * parity test can hold every layer to the same ids by import identity.
 *
 * The list is in PRECEDENCE ORDER: the classifier walks it top to bottom and
 * the first situation whose evidence holds wins. The order is a decision,
 * not an accident — a phase whose board reads done is superseded whatever
 * its record says; a foreign live session outranks everything that would
 * spend; a declared wait outranks a declared blocker; the plan being broken
 * outranks the phase being red, because the repair is cheaper and the red
 * may be its symptom.
 *
 * `blocked-declared` moved ABOVE `plan-broken` on 2026-08-30
 * (`console-unattended-autopilot` P1, register R2/R3). A session that declared
 * a blocker is TESTIMONY about the phase; a plan-health error is the console's
 * own claim about the paperwork — and the most common of those claims,
 * `stale-handoff`, is raised BY the blocked handoff the session deliberately
 * wrote. The console was answering the session's honest "the box is
 * unreachable" with "your plan is broken, run validate.sh" 92 times, for plans
 * whose `validate.sh` was green. Testimony wins.
 *
 * The classifier's `plan-broken` arms still run early in code — before
 * `mcp-unavailable` and `resource-wall`, as this list says — because a broken
 * plan really is cheaper to repair than a wall is to wait out. What changed is
 * that all three of them are guarded by "nothing declared a park or a blocker",
 * which is what puts `plan-broken` below `blocked-declared` here.
 */

/**
 * @typedef {'superseded'|'qa-failed'|'qa-pending'|'foreign-live'|'foreign-stale'
 *   |'waiting-external'|'gated-manual'|'mcp-unavailable'|'resource-wall'
 *   |'blocked-declared'|'plan-broken'|'verify-red'|'done-unrecorded'|'work-in-progress'
 *   |'never-started'|'unknown'} SituationId
 */

/** Every situation, in classifier precedence. Frozen: it is a vocabulary. */
export const SITUATIONS = Object.freeze(
  /** @type {const} */ ([
    'superseded',
    'qa-failed',
    'qa-pending',
    'foreign-live',
    'foreign-stale',
    'waiting-external',
    'gated-manual',
    'mcp-unavailable',
    'resource-wall',
    'blocked-declared',
    'plan-broken',
    'verify-red',
    'done-unrecorded',
    'work-in-progress',
    'never-started',
    'unknown',
  ]),
);

/**
 * Sub-kinds for the situations that branch. `blocked-declared` and
 * `resource-wall` are closed lists (the ladder has a rung table per sub-kind);
 * `plan-broken` names the first issue kind and is open — a new health check
 * adds a word without editing this file.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
/**
 * The three shapes a session that produced NOTHING has actually taken.
 *
 * 40 of 226 sessions (18%) exited with `turns: 0` and `costUsd: 0`, and the
 * exit text named three distinct causes — a laptop lid, a content filter, and
 * a skill that would not load. All three read as `never-started`, whose one
 * rung is `reboard-fresh`, so the ladder answered a lid, a refusal and a
 * broken install with the identical act: board it again and hope. Three
 * consecutive AUP refusals on one phase were re-boarded three times.
 *
 *   - `sleep`         — the machine suspended mid-response. Nothing is wrong
 *     with the phase and the session's TRANSCRIPT IS INTACT, so the remedy is
 *     to resume that session; a fresh reboard throws away the context that a
 *     sleeping laptop did not.
 *   - `refusal`       — a content/usage-policy refusal. No amount of
 *     re-boarding changes it: the same prompt gets the same answer. It is a
 *     person's, at once, and the refusal text goes with the errand verbatim
 *     because it is the only evidence of what was refused.
 *   - `skill-missing` — the CLI could not load the skill the boot prompt
 *     invokes (`Unknown command: /…`). An environment fault on this machine,
 *     not a phase fault; re-boarding runs the same broken install again.
 *
 * Anything else stays unclassified and takes today's path — a fourth shape
 * must be MEASURED before it earns a word.
 * @type {readonly string[]}
 */
export const EXIT_SUB_KINDS = Object.freeze(['sleep', 'refusal', 'skill-missing']);

/**
 * WHY a `refusal` refused — the cause beside the sub-kind, never a fourth
 * sub-kind (the rung table is keyed `never-started:refusal` and stays empty
 * for every cause, because none of them changes on a re-board).
 *
 * `aup` is the content refusal the sub-kind was written for. The other three
 * are the ones the audit found the reader could not see (RCV-2): of 49
 * zero-cost sessions, 16 signed off with "Your organization has disabled
 * Claude subscription access for Claude Code" and 2 with "Self-signed
 * certificate detected", and every one of them landed in bare `never-started`
 * and was re-boarded into the same wall — `reboard-fresh`, the exact act this
 * sub-kind exists to stop. The runner's own halt sentence for the third
 * ("organization policy blocks this credential") joins them so a record from a
 * console that halted on it reads the same way on any console.
 * @type {readonly string[]}
 */
export const REFUSAL_CAUSES = Object.freeze(['aup', 'org-policy', 'org-subscription', 'certificate']);

/**
 * The cause a refusal names, or undefined when the words name none — in which
 * case `classifyExitSaid` answers no `refusal` either: the two are one read.
 *
 * Order matters only where the phrases could overlap: the organisation's
 * SUBSCRIPTION ("disabled … subscription access") is asked before the
 * organisation's POLICY, because the CLI's subscription sentence also
 * contains the word "organization".
 *
 * @param {string|null|undefined} said
 * @returns {'aup'|'org-policy'|'org-subscription'|'certificate'|undefined}
 */
export function refusalCauseOf(said) {
  const text = String(said ?? '');
  if (!text.trim()) return undefined;
  if (/organization has (?:been )?disabled|disabled claude subscription/i.test(text))
    return 'org-subscription';
  if (/organization policy blocks|oauth_org_not_allowed|disabled api key authentication/i.test(text))
    return 'org-policy';
  if (
    /self.signed certificate|certificate (?:verify|verification|validation) failed|unable to (?:get local issuer|verify the first) certificate|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(
      text,
    )
  ) {
    return 'certificate';
  }
  // The AUP refusal carried the `[reasoning_extraction]` marker. The two
  // phrases beside it are the CLI's standard refusal openings; nothing looser
  // belongs here, because a session that merely QUOTED a policy is not one
  // that was refused by it.
  if (
    /\[reasoning_extraction\]/i.test(text) ||
    /\b(usage policies|acceptable use policy)\b/i.test(text) ||
    /\bI (?:can(?:'|’)?t|cannot|won(?:'|’)?t) (?:help with|assist with|comply)\b/i.test(text)
  ) {
    return 'aup';
  }
  return undefined;
}

/**
 * Read a zero-turn exit's own words. Returns undefined when they name none of
 * the known shapes — which is a `never-started` with no sub-kind, exactly as
 * before this existed.
 *
 * Order is precedence, not taste: `Unknown command:` is a verbatim CLI string
 * and cannot be anything else, so it is asked first; sleep before refusal
 * because a machine that suspended mid-refusal is still a machine that
 * suspended, and resuming the session is the cheaper, reversible reading.
 *
 * @param {string|null|undefined} said
 * @returns {'sleep'|'refusal'|'skill-missing'|undefined}
 */
export function classifyExitSaid(said) {
  const text = String(said ?? '');
  if (!text.trim()) return undefined;
  // The CLI's own words when a slash command does not resolve — two sessions
  // died to `Unknown command: /phased-execution` with a working plan.
  if (/\bunknown command:/i.test(text)) return 'skill-missing';
  // The measured wording is "computer went to sleep mid-response"; the others
  // are the same event as macOS and the CLI variously report it.
  if (/\b(went to sleep|sleep mid-response|machine (?:was )?suspended|system went to sleep)\b/i.test(text)) {
    return 'sleep';
  }
  // A refusal is whatever `refusalCauseOf` can name — the content policy, or
  // the three walls RCV-2 found the reader blind to.
  if (refusalCauseOf(text)) return 'refusal';
  return undefined;
}

export const SUB_KINDS = Object.freeze({
  // `permission` joined 2026-09-02 (console-parallel-repaint P12): a tool the
  // run's own permission policy refused, which two real sessions had declared
  // as `unknown` and spent an unblock session walking into the same wall.
  // `const`-typed so the runner's `BlockerSubKind` and the decision manifest's
  // `NEED_CLASSES` (`decisions-model.js`) DERIVE from it instead of spelling it.
  'blocked-declared': Object.freeze(
    /** @type {const} */ (['lock', 'permission', 'credential', 'gate', 'external', 'unknown']),
  ),
  'resource-wall': Object.freeze(['usage', 'auth', 'budget', 'model']),
  'plan-broken': Object.freeze(['lint', 'unreadable', 'verification', 'issue']),
  'never-started': EXIT_SUB_KINDS,
});

/**
 * Who the situation is for — the thing the UI colours by and the ladder
 * decides with:
 *   - `machine`: the ladder has rungs; a person is asked only when they are
 *     exhausted (an Errand);
 *   - `person`: intrinsically human (a manual gate, a QA verdict, a credential
 *     the session named); the Errand is written at once, nothing spends;
 *   - `wait`: time or someone else settles it (a foreign live session, an
 *     external clock the park machinery already owns); nothing is launched;
 *   - `none`: nothing is wrong — the board already settled it.
 * @type {Readonly<Record<SituationId, 'machine'|'person'|'wait'|'none'>>}
 */
export const SITUATION_ACTOR = Object.freeze({
  superseded: 'none',
  // QA climbs. It read `person` until 2026-08-22, and a `pending` verdict that
  // nothing ever dispatches is not a person's decision — it is a deadlock:
  // `new-handoff.sh` writes the row, `_is_verified` accepts only pass|waived,
  // and no process in the system gives the verdict. Six phases of a real plan
  // were held behind one, for ever, with no defect recorded anywhere. The
  // independence QA needs comes from the fresh-context SUBAGENT the session
  // dispatches (SKILL.md §QA), not from the session being a different one, so
  // the ladder has something honest to climb. A verdict it cannot produce is
  // still a person's — that is what rung exhaustion and the errand are for.
  'qa-failed': 'machine',
  'qa-pending': 'machine',
  'foreign-live': 'wait',
  'foreign-stale': 'machine',
  'waiting-external': 'wait',
  'gated-manual': 'person',
  'plan-broken': 'machine',
  'mcp-unavailable': 'machine',
  'resource-wall': 'machine',
  'blocked-declared': 'machine',
  'verify-red': 'machine',
  'done-unrecorded': 'machine',
  'work-in-progress': 'machine',
  'never-started': 'machine',
  unknown: 'person',
});

/**
 * The sub-kinds whose actor DIFFERS from their parent's — and only those.
 *
 * Four tables are empty on purpose and each is a person's from the start: a
 * credential or a gate the session named, a policy refusal, a skill this
 * machine cannot load. Their parent situations are `machine` (the other
 * sub-kinds climb), so `nextRung` read them as a machine's with "no automatic
 * rung exists", `loop.md` called them a person's, and the errand's reason
 * disagreed with both (LFC-3's third clause). One table, three readers —
 * the classifier's `Situation.actor`, `nextRung`, the client's ladder view —
 * through `actorFor`, so an empty sub-table is a person's everywhere or
 * nowhere. `blocked-declared:permission` is deliberately NOT here: it has a
 * rung (`widen-rule`), so it is the machine's until that rung is answered.
 * @type {Readonly<Record<string, 'machine'|'person'|'wait'|'none'>>}
 */
export const SITUATION_SUB_ACTOR = Object.freeze({
  'blocked-declared:credential': 'person',
  'blocked-declared:gate': 'person',
  'never-started:refusal': 'person',
  'never-started:skill-missing': 'person',
});

/**
 * Who a situation is for, sub-kind applied — `SITUATION_SUB_ACTOR` first, the
 * parent's word otherwise. An unknown id answers `person`, never throws: a
 * word from a newer build should reach a person rather than a crash.
 * @param {string|null|undefined} id
 * @param {string|null|undefined} [sub]
 * @returns {'machine'|'person'|'wait'|'none'}
 */
export function actorFor(id, sub) {
  const key = sub ? `${id}:${sub}` : String(id ?? '');
  const override = /** @type {Record<string, 'machine'|'person'|'wait'|'none'>} */ (SITUATION_SUB_ACTOR)[key];
  if (override) return override;
  return (
    /** @type {Record<string, 'machine'|'person'|'wait'|'none'>} */ (SITUATION_ACTOR)[String(id ?? '')] ??
    'person'
  );
}

/**
 * What a card, a chip and a journal line call each situation — a short noun
 * phrase, never a sentence.
 * @type {Readonly<Record<SituationId, string>>}
 */
export const SITUATION_LABELS = Object.freeze({
  superseded: 'Superseded',
  'qa-failed': 'QA failed',
  'qa-pending': 'QA pending',
  'foreign-live': 'Another session is in it',
  'foreign-stale': 'Stale foreign claim',
  'waiting-external': 'Waiting on the outside',
  'gated-manual': 'Gate needs a person',
  'plan-broken': 'Plan needs repair',
  'mcp-unavailable': 'MCP server unreachable',
  'resource-wall': 'Resource wall',
  'blocked-declared': 'Declared blocked',
  'verify-red': 'Verification red',
  'done-unrecorded': 'Done, unrecorded',
  'work-in-progress': 'Work in progress',
  'never-started': 'Never started',
  unknown: 'Unclassified',
});

/**
 * One line each: what the situation MEANS and what the autopilot does about
 * it. The tooltip contract, as for recovery actions — a reader should be able
 * to predict the next automatic act from the blurb alone.
 * @type {Readonly<Record<SituationId, string>>}
 */
export const SITUATION_BLURBS = Object.freeze({
  superseded:
    'The board already reads this phase done — the record is stale and closes itself. Nothing to run.',
  'qa-failed':
    "The handoff is complete but the recorded QA verdict is fail, so dependents are held. The phase's own session is resumed with the report to fix what QA named and re-record; a fresh agent at a stronger model second; then an errand.",
  'qa-pending':
    "The handoff is complete but the plan gates on QA and no verdict is recorded. The phase's own session is resumed to dispatch the fresh-context QA subagent and record the verdict; then an errand. Dependents wait until it does.",
  'foreign-live':
    'A live session that is not this run holds the phase lock. The autopilot stands down and re-evaluates when the session ends.',
  'foreign-stale':
    'An expired claim from a session that is gone, over unfinished work. The claim is taken over and the work continued.',
  'waiting-external':
    'The session declared it is waiting on something outside (CI, a PR, a deploy window). The park re-checks and resumes its own session.',
  'gated-manual':
    "A manual gate only a person can clear stands before this phase. The errand is the gate's own numbered steps.",
  'plan-broken':
    'The plan, its handoffs or its §Verification fail a structural check. Deterministic repair first, a plan-repair agent second, then an errand.',
  'mcp-unavailable':
    'A server the phase requires under policy require cannot connect. The run waits for it to heal, then continues without it and records an errand.',
  'resource-wall':
    'A usage window, a sign-in, a budget or a model limit stopped the work. The ladder switches account or model, raises once, or waits for the window.',
  'blocked-declared':
    'The session itself said it was blocked — in its handoff or its declared outcome. The sub-kind decides: queue behind a lock, poll an external ref, one bounded unblock session, or an errand.',
  'verify-red':
    "The phase's own §Verification fails. Its session is resumed with the failure, then a stronger fresh agent, then an errand.",
  'done-unrecorded':
    'Verification is green and work landed, but no complete handoff exists. The own session is asked to close out; a fresh agent if it cannot.',
  'work-in-progress':
    'Real work exists and is unfinished — an in-progress handoff, commits, a dirty tree. The own session continues the work; else a fresh session boards with a resume brief.',
  'never-started':
    'No handoff, nothing on disk, a session that ended before it began. The phase re-boards fresh — no closeout, no person.',
  unknown: 'The evidence fits no named situation. A person reads it, and the classifier gains a case.',
});

/** @param {unknown} value */
export function isSituation(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (SITUATIONS).includes(value);
}

/**
 * The journal/record key for a situation with its sub-kind — `blocked-declared:unknown`.
 * @param {SituationId|string} id
 * @param {string} [sub]
 */
export function situationKey(id, sub) {
  return sub ? `${id}:${sub}` : String(id);
}

/**
 * The inverse of `situationKey`. An unknown id parses to `unknown`, never
 * throws — records written by a later version still read.
 * @param {string|null|undefined} key
 * @returns {{ id: SituationId, sub?: string }}
 */
export function parseSituationKey(key) {
  const [id, ...rest] = String(key ?? '').split(':');
  const sub = rest.join(':') || undefined;
  if (!isSituation(id)) return { id: 'unknown' };
  return sub ? { id: /** @type {SituationId} */ (id), sub } : { id: /** @type {SituationId} */ (id) };
}

/**
 * The human label with the sub-kind folded in — "Declared blocked · credential".
 * @param {SituationId|string} id
 * @param {string} [sub]
 */
export function situationLabel(id, sub) {
  const base = /** @type {Record<string, string>} */ (SITUATION_LABELS)[id] ?? SITUATION_LABELS.unknown;
  return sub ? `${base} · ${sub}` : base;
}
