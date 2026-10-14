/**
 * Your turn — the words a person's task is told in (control-tower phase 130,
 * §Architecture 19, #207).
 *
 * A human step (`shared/human-step-model.js`) says WHAT a person must do. This
 * module owns the rest of the language every item on the page speaks: WHY only
 * a person fits it, how it is PROVEN, how a check of it can come back, and the
 * words of a permission a person grants — its scope, its risk tier and its
 * state — plus which wall stopped the AI, who handled something instead of
 * asking, and the five groups the page lays the items out in. Phases 131–149
 * draw, check and grant with these words; none of them re-spells one.
 *
 * `scripts/turn.env` is the bash twin of the lists a script reads
 * (`phase-outcome.sh`, `phase-graph.sh`); `viewer/test/gates-vocab.test.ts`
 * holds it word for word, and `viewer/test/vocab-owners.test.ts` registers
 * every list below.
 *
 * ⚠️ No imports but the human-step model — the client bundles this module and
 * `node --test` imports it directly.
 *
 * FREE, not Pro (operator decision 6): the language is both editions.
 */

import { HUMAN_STEP_KINDS, HUMAN_STEP_SETTLED_STATES, HUMAN_STEP_STATES } from './human-step-model.js';

/* ------------------------------------------------------------------ *
 * Why a person — required on every item
 * ------------------------------------------------------------------ */

/**
 * The reasons only a person fits an act. Every item carries one: the
 * session names it (`--why`), or the item is given its kind's default and
 * marked `inferred`.
 * @typedef {(typeof WHY_PERSON)[number]} WhyPerson
 */
export const WHY_PERSON = Object.freeze(
  /** @type {const} */ ([
    'permission',
    'identity',
    'secret',
    'money',
    'legal',
    'decision',
    'physical',
    'reach',
    'third-party',
    'reserved',
  ]),
);

/** Where an item's reason came from: the declaration named it, or its kind's default was taken. */
export const WHY_SOURCES = Object.freeze(/** @type {const} */ (['declared', 'inferred']));

/**
 * What each reason says, and whether it CLAIMS THE AI CANNOT (`cannot: true`)
 * rather than that only a person MAY. The guard's G4 judges only the first
 * kind — a sign-in is the person's even when policy would let the command run.
 * @type {Readonly<Record<WhyPerson, Readonly<{label: string, sentence: string, cannot: boolean}>>>}
 */
export const REASON_META = Object.freeze({
  permission: reason('The AI is not allowed', 'the AI lacks a permission it would need to do this', true),
  identity: reason('Only you can sign in', 'only you can sign in as yourself', false),
  secret: reason('Only you hold the secret', 'only you hold the secret it needs', false),
  money: reason('It spends money', 'it spends money, which is your call', false),
  legal: reason('It accepts terms', 'it accepts terms on your behalf', false),
  decision: reason('It is your decision', 'it is your decision to make', false),
  physical: reason('It needs hands at a device', 'it needs hands at a device', false),
  reach: reason('The AI cannot reach it', 'the AI cannot reach the system it happens on', true),
  'third-party': reason('Somebody else must approve', 'somebody else must approve it', false),
  reserved: reason('A rule reserves it for a person', 'a rule reserves it for a person', true),
});

/**
 * @param {string} label @param {string} sentence @param {boolean} cannot
 */
function reason(label, sentence, cannot) {
  return Object.freeze({ label, sentence, cannot });
}

/**
 * Why only a person fits an item, said ONCE (#332): the reason's sentence,
 * capitalised, as the inspector's *Only you* row reads it — the row already
 * labels it, so the label is never said before it ("Only you hold the secret:
 * only you hold the secret it needs." was the same reason twice). A word no
 * reason holds is named as it is.
 * @param {string|null|undefined} why
 * @returns {string}
 */
export function whyPersonWords(why) {
  const meta = /** @type {Record<string, {sentence: string}>} */ (REASON_META)[String(why ?? '')];
  if (!meta) return `Its reason is ${String(why ?? 'unknown')}.`;
  return `${meta.sentence.charAt(0).toUpperCase()}${meta.sentence.slice(1)}.`;
}

/**
 * The reasons G4 judges — the ones that claim the AI CANNOT do the act. A
 * declared reason from this list must survive the question "could the AI have
 * done it itself?"; the other seven say only a person MAY, and G4 never asks.
 * Derived from `REASON_META` so the two cannot disagree.
 * @type {readonly WhyPerson[]}
 */
export const G4_REASONS = Object.freeze(
  /** @type {WhyPerson[]} */ (WHY_PERSON.filter((word) => REASON_META[word].cannot)),
);

/**
 * The reasons each kind may carry — the FIRST is the kind's default, the reason
 * an item that names none is given (marked `inferred`). Total over the kinds. An `operator-act` is the general act on the person's side, so it may
 * carry any reason; a `permission` item carries exactly one.
 * @type {Readonly<Record<import('./human-step-model.js').HumanStepKind, readonly WhyPerson[]>>}
 */
export const KIND_REASONS = Object.freeze({
  'browser-login': Object.freeze(/** @type {WhyPerson[]} */ (['identity', 'secret'])),
  'device-code': Object.freeze(/** @type {WhyPerson[]} */ (['identity'])),
  'one-time-code': Object.freeze(/** @type {WhyPerson[]} */ (['identity', 'secret'])),
  'secret-entry': Object.freeze(/** @type {WhyPerson[]} */ (['secret', 'identity', 'money'])),
  'claude-login': Object.freeze(/** @type {WhyPerson[]} */ (['identity'])),
  'mcp-login': Object.freeze(/** @type {WhyPerson[]} */ (['identity', 'secret'])),
  'os-prompt': Object.freeze(/** @type {WhyPerson[]} */ (['physical', 'identity', 'secret'])),
  'os-permission': Object.freeze(/** @type {WhyPerson[]} */ (['physical', 'permission'])),
  'third-party-approval': Object.freeze(/** @type {WhyPerson[]} */ (['third-party', 'decision'])),
  physical: Object.freeze(/** @type {WhyPerson[]} */ (['physical'])),
  'person-check': Object.freeze(/** @type {WhyPerson[]} */ (['decision', 'reserved'])),
  decision: Object.freeze(/** @type {WhyPerson[]} */ (['decision', 'money', 'legal', 'reserved'])),
  'protected-path': Object.freeze(/** @type {WhyPerson[]} */ (['reserved', 'permission'])),
  'interactive-prompt': Object.freeze(
    /** @type {WhyPerson[]} */ (['identity', 'secret', 'decision', 'physical']),
  ),
  captcha: Object.freeze(/** @type {WhyPerson[]} */ (['identity'])),
  'email-link': Object.freeze(/** @type {WhyPerson[]} */ (['identity', 'reach'])),
  'operator-act': Object.freeze(
    /** @type {WhyPerson[]} */ ([
      'reserved',
      'permission',
      'identity',
      'secret',
      'money',
      'legal',
      'decision',
      'physical',
      'reach',
      'third-party',
    ]),
  ),
  permission: Object.freeze(/** @type {WhyPerson[]} */ (['permission'])),
});

/**
 * The reason a kind is given when its item names none.
 * @param {string} kind
 * @returns {WhyPerson}
 */
export function defaultReason(kind) {
  const allowed = /** @type {Record<string, readonly WhyPerson[]>} */ (KIND_REASONS)[kind];
  return allowed?.[0] ?? 'decision';
}

/**
 * May an item of `kind` carry `why`? Unknown words answer no.
 * @param {string} kind
 * @param {string} why
 * @returns {boolean}
 */
export function reasonAllowed(kind, why) {
  const allowed = /** @type {Record<string, readonly string[]>} */ (KIND_REASONS)[kind];
  return Array.isArray(allowed) && allowed.includes(why);
}

/* ------------------------------------------------------------------ *
 * How an item is proven, and how a check comes back
 * ------------------------------------------------------------------ */

/**
 * `probe` — the console reads a ref · `answer` — the person's answer is the
 * result · `judgement` — a checking session reads evidence against the proof's
 * words · `attest` — the person's word, recorded as unverified (only when asked
 * for by name) · `grant` — a permission item ends by a grant or a denial.
 * @typedef {(typeof PROOF_TYPES)[number]} ProofType
 */
export const PROOF_TYPES = Object.freeze(
  /** @type {const} */ (['probe', 'answer', 'judgement', 'attest', 'grant']),
);

/**
 * The proof types that need neither a ref nor words: the answer IS the result,
 * the person's word was asked for by name, a grant or a denial ends it (G2).
 * @type {readonly ProofType[]}
 */
export const PROOF_TYPES_SELF = Object.freeze(/** @type {ProofType[]} */ (['answer', 'attest', 'grant']));

/**
 * The proof type an item is given when it names none: a ref is read
 * (`probe`), words are judged (`judgement`), a decision is answered, a
 * permission is granted. An item with none of those has no proof at all — the
 * door refuses it (G2); a ledger line written before the door asked reads as
 * `attest`, which is what its *I did it* always was.
 * @param {{kind?: string, proof?: string, proofWords?: string}} item
 * @returns {ProofType|null}
 */
export function inferProofType(item) {
  if (item.kind === 'permission') return 'grant';
  if (typeof item.proof === 'string' && item.proof.trim()) return 'probe';
  if (item.kind === 'decision' || item.kind === 'person-check') return 'answer';
  if (typeof item.proofWords === 'string' && item.proofWords.trim()) return 'judgement';
  return null;
}

/** How a check of an item can come back. @typedef {(typeof VERDICTS)[number]} Verdict */
export const VERDICTS = Object.freeze(/** @type {const} */ (['passed', 'rejected', 'needs-info']));

/**
 * Who may write a verdict (control-tower phase 134, #211): a `probe` and the
 * `checker` spawned for THAT item, in-process — and the `owner`'s *Accept
 * anyway*, over the one route that writes one (`POST
 * /api/human-steps/:id/override`). Never a session, never the supervisor: no
 * other route, no CLI verb and no chat tool writes a verdict, and `check` only
 * ASKS for one.
 * @typedef {(typeof VERDICT_BY)[number]} VerdictBy
 */
export const VERDICT_BY = Object.freeze(/** @type {const} */ (['probe', 'checker', 'owner']));

/* ------------------------------------------------------------------ *
 * Permissions — the scope, the risk and the life of a grant
 * ------------------------------------------------------------------ */

/**
 * How far a grant reaches: this one call · until this phase settles · this
 * plan · every plan of this console's root · every console of this machine.
 * @typedef {(typeof GRANT_SCOPES)[number]} GrantScope
 */
export const GRANT_SCOPES = Object.freeze(
  /** @type {const} */ (['call', 'phase', 'plan', 'repository', 'always']),
);

/**
 * One press · one press · the rule typed, its blast radius shown and the owner
 * door · no grant offered: why, and the manual path.
 * @typedef {(typeof RISK_TIERS)[number]} RiskTier
 */
export const RISK_TIERS = Object.freeze(/** @type {const} */ (['low', 'medium', 'high', 'never']));

/** @typedef {(typeof GRANT_STATES)[number]} GrantState */
export const GRANT_STATES = Object.freeze(/** @type {const} */ (['live', 'spent', 'expired', 'revoked']));

/**
 * How a grant ends — every state but `live`: a `call` grant is spent on use,
 * a `phase` (or an unspent `call`) grant expires when its phase settles or its
 * clock runs out, and any grant is revoked by a person (control-tower phase 149).
 * @typedef {Exclude<GrantState, (typeof GRANT_STATES)[0]>} GrantEnding
 */
export const GRANT_ENDINGS = Object.freeze(/** @type {readonly GrantEnding[]} */ (GRANT_STATES.slice(1)));

/**
 * The longest a grant below plan scope lives: a `phase` grant ends when its
 * phase settles and at most this long after it was given; an unspent `call`
 * grant the same (§Architecture 19).
 */
export const GRANT_PHASE_MAX_MS = 24 * 60 * 60_000;

/**
 * What each scope reaches, in the words a grant's row, its push and the
 * resumed session's sentence say.
 * @type {Readonly<Record<GrantScope, string>>}
 */
export const GRANT_SCOPE_WORDS = Object.freeze({
  call: 'this one call',
  phase: 'this phase',
  plan: 'this plan',
  repository: "every plan of this console's repository",
  always: 'every plan on this machine',
});

/**
 * Which wall stopped the AI: a deny-wall rule, an ask with nobody to ask, a
 * tool outside the allow list, an MCP tool not granted, a capability flag that
 * is off, a missing credential, the console's own guard, a sandbox or network
 * wall, Claude Code's own classifier.
 * @typedef {(typeof WALLS)[number]} Wall
 */
export const WALLS = Object.freeze(
  /** @type {const} */ ([
    'deny',
    'ask',
    'allow-list',
    'mcp',
    'capability',
    'credential',
    'guard',
    'sandbox',
    'classifier',
  ]),
);

/**
 * The rule families the risk table tells apart. `force-push` (a forced or
 * deleting push — `PUSH_DENY_CARVED`), `host` (`HOST_COMMANDS`),
 * `protected-path` and `secret-value` are never granted through any door;
 * `profile` is a raise of the run's permission profile, which moves every ask
 * at once (high, control-tower phase 135); `any` is every other rule.
 * @typedef {(typeof RULE_FAMILIES)[number]} RuleFamily
 */
export const RULE_FAMILIES = Object.freeze(
  /** @type {const} */ (['force-push', 'host', 'protected-path', 'secret-value', 'profile', 'any']),
);

/**
 * The host family: commands that act on the MACHINE rather than a repository.
 * Each has its own `DEFAULT_DENY` rule (`Bash(<word>:*)`, `runner/approvals.ts`)
 * and none is ever granted — a test holds the two lists together.
 */
export const HOST_COMMANDS = Object.freeze(
  /** @type {const} */ (['sudo', 'shutdown', 'reboot', 'mkfs', 'dd']),
);

/**
 * Wall × rule family × scope → tier (§Architecture 19, control-tower phase
 * 135). The first row that matches wins (`*` matches anything). The rows are
 * TOTAL over `WALLS` × `RULE_FAMILIES` × `GRANT_SCOPES` — every cell is named by
 * a row, which `permission-item.test.ts` walks — so the fallback in `riskOf`
 * answers only a word outside the three lists, and answers `high`, the safe
 * side. **never** — every guard, a missing credential, a sandbox or network
 * wall, Claude Code's own classifier, a forced or deleting push, the host
 * family, a protected path, a secret's value; **high** — a profile raise, a
 * capability, any other deny-wall rule, any `always`; low and medium the rest.
 * @type {ReadonlyArray<Readonly<{wall: Wall|'*', family: RuleFamily|'*', scope: GrantScope|'*', tier: RiskTier}>>}
 */
export const GRANT_RISK = Object.freeze([
  riskRow('guard', '*', '*', 'never'),
  riskRow('credential', '*', '*', 'never'),
  riskRow('sandbox', '*', '*', 'never'),
  riskRow('classifier', '*', '*', 'never'),
  riskRow('*', 'force-push', '*', 'never'),
  riskRow('*', 'host', '*', 'never'),
  riskRow('*', 'protected-path', '*', 'never'),
  riskRow('*', 'secret-value', '*', 'never'),
  riskRow('*', 'profile', '*', 'high'),
  riskRow('capability', '*', '*', 'high'),
  riskRow('deny', '*', '*', 'high'),
  riskRow('*', '*', 'always', 'high'),
  riskRow('ask', '*', 'call', 'low'),
  riskRow('ask', '*', 'phase', 'low'),
  riskRow('ask', '*', 'plan', 'medium'),
  riskRow('ask', '*', 'repository', 'medium'),
  riskRow('allow-list', '*', 'call', 'low'),
  riskRow('allow-list', '*', 'phase', 'low'),
  riskRow('allow-list', '*', 'plan', 'medium'),
  riskRow('allow-list', '*', 'repository', 'medium'),
  riskRow('mcp', '*', 'call', 'low'),
  riskRow('mcp', '*', 'phase', 'low'),
  riskRow('mcp', '*', 'plan', 'medium'),
  riskRow('mcp', '*', 'repository', 'medium'),
]);

/**
 * @param {Wall|'*'} wall @param {RuleFamily|'*'} family @param {GrantScope|'*'} scope @param {RiskTier} tier
 */
function riskRow(wall, family, scope, tier) {
  return Object.freeze({ wall, family, scope, tier });
}

/**
 * The row of `GRANT_RISK` that names a cell, or undefined for a word outside
 * the three lists.
 * @param {{wall: string, family?: string, scope: string}} grant
 */
export function riskRowOf(grant) {
  const family = grant.family ?? 'any';
  return GRANT_RISK.find(
    (row) =>
      (row.wall === '*' || row.wall === grant.wall) &&
      (row.family === '*' || row.family === family) &&
      (row.scope === '*' || row.scope === grant.scope),
  );
}

/**
 * The tier of granting `family` past `wall` at `scope`.
 * @param {{wall: string, family?: string, scope: string}} grant
 * @returns {RiskTier}
 */
export function riskOf(grant) {
  return riskRowOf(grant)?.tier ?? 'high';
}

/**
 * The scopes a person may be OFFERED for a wall and family — every scope
 * whose tier is not `never`, narrowest first. Empty means no grant through any
 * door: the item says why, and the manual path (`neverReason`).
 * @param {{wall: string, family?: string}} cell
 * @returns {GrantScope[]}
 */
export function grantScopesOf(cell) {
  return GRANT_SCOPES.filter((scope) => riskOf({ ...cell, scope }) !== 'never');
}

/**
 * The tier an item SHOWS: the narrowest offer's tier, or `never` when none is
 * offered — what a person is asked about at the least they could grant.
 * @param {{wall: string, family?: string}} cell
 * @returns {RiskTier}
 */
export function itemRiskOf(cell) {
  const [narrowest] = grantScopesOf(cell);
  return narrowest ? riskOf({ ...cell, scope: narrowest }) : 'never';
}

/**
 * Why a never cell offers no grant, and what a person does instead — one row
 * per never cause, in `GRANT_RISK`'s order: a wall first, then a family.
 * @type {Readonly<Record<string, Readonly<{why: string, manual: string}>>>}
 */
export const NEVER_REASONS = Object.freeze({
  guard: Object.freeze({
    why: "the console's own guard refused it — standing policy that no profile, strike or grant reaches",
    manual:
      'Do what the refusal told the session to do instead; if the act must happen, do it yourself in a terminal.',
  }),
  credential: Object.freeze({
    why: 'a credential is provided, never granted — no session is handed one',
    manual: "Store it where the item says (it is read by name, never shown), then press I've done this.",
  }),
  sandbox: Object.freeze({
    why: "a sandbox or network wall is the machine's, not this console's — no policy here can lift it",
    manual: "Run the step yourself where it can reach what it needs, then press I've done this.",
  }),
  classifier: Object.freeze({
    why: "Claude Code's own classifier decided — the console never writes your settings",
    manual:
      'Add the rule shown to your own Claude Code settings if you want it allowed, or run the step yourself.',
  }),
  'force-push': Object.freeze({
    why: 'a forced or deleting push rewrites or removes what a remote already holds',
    manual:
      'Push it yourself from a terminal if you mean it; the session can push a new branch without force.',
  }),
  host: Object.freeze({
    why: 'a host command acts on the machine, not the repository',
    manual: 'Run it yourself at the machine if it is really needed.',
  }),
  'protected-path': Object.freeze({
    why: 'Claude Code reserves this path for an interactive session — no console policy can allow it',
    manual:
      "Make the edit by hand (or in an interactive session) and commit it on the run branch, then press I've done this.",
  }),
  'secret-value': Object.freeze({
    why: "a secret's value is never handed to a session",
    manual: 'Store it where the item says; the session reads it by name.',
  }),
});

/**
 * Why a cell is `never`, or null when it is grantable at some scope.
 * @param {{wall: string, family?: string}} cell
 * @returns {Readonly<{why: string, manual: string}>|null}
 */
export function neverReason(cell) {
  if (grantScopesOf(cell).length) return null;
  const reasons = /** @type {Record<string, Readonly<{why: string, manual: string}>>} */ (NEVER_REASONS);
  return reasons[cell.wall] ?? reasons[cell.family ?? 'any'] ?? reasons.guard;
}

/* ------------------------------------------------------------------ *
 * The page's groups, and what the AI handled instead of asking
 * ------------------------------------------------------------------ */

/**
 * The page's groups, v2 (turn-by-turn phase 9): *Approve* · *Do now* ·
 * *Decide* · *Being checked* · *Coming up* · *Done* — derived by
 * `groupOf(item)` from the item's type and readiness, never stored. *Handled
 * by the AI* is a section of the page, never a group, and a heads-up is in none.
 * @typedef {(typeof TURN_GROUPS)[number]} TurnGroup
 */
export const TURN_GROUPS = Object.freeze(
  /** @type {const} */ (['approve', 'now', 'decide', 'checking', 'upcoming', 'done']),
);

/** What each group is called on the page. @type {Readonly<Record<TurnGroup, string>>} */
export const TURN_GROUP_LABEL = Object.freeze({
  approve: 'Approve',
  now: 'Do now',
  decide: 'Decide',
  checking: 'Being checked',
  upcoming: 'Coming up',
  done: 'Done',
});

/** The groups that are the person's to act on now — what the headline and the strip count as to do. */
export const TURN_OPEN_GROUPS = Object.freeze(/** @type {const} */ (['approve', 'now', 'decide']));

/**
 * The group an item is drawn in — total over the states, and by type and
 * readiness: a settled one (or one whose person's status says it is over) is
 * done, one being checked is being checked, one NOT YET due is coming up; of
 * the rest an approval is to approve, a decision to decide, and every other
 * open one (a returned one included — it has to be redone) is the person's to
 * do now. With no `type` given, the type is derived from what the item carries.
 * @param {{state?: string|null, kind?: string, proofType?: string|null, source?: string, record?: string,
 *   hasOptions?: boolean, hasApproval?: boolean, type?: string, readiness?: string, personStatus?: string}} item
 * @returns {TurnGroup}
 */
export function groupOf(item) {
  const state = String(item?.state ?? '');
  const status = String(item?.personStatus ?? '');
  if (SETTLED.has(state) || status === 'passed' || status === 'not-doing' || status === 'closed')
    return 'done';
  if (state === 'checking' || status === 'checking') return 'checking';
  if (state === 'upcoming' || item?.readiness === 'not-yet') return 'upcoming';
  const type = item?.type ?? typeOf(item ?? {});
  if (type === 'approve') return 'approve';
  if (type === 'decide') return 'decide';
  return 'now';
}

/** The settled states, read once from the human-step model. */
const SETTLED = new Set(/** @type {readonly string[]} */ (HUMAN_STEP_SETTLED_STATES));

/**
 * Who handled something instead of asking a person. `console` (turn-by-turn
 * phase 7) is the console's own close: an item nobody needs any more — its run
 * superseded, resolved or finished, its phase done on the board, its cause gone,
 * or settled by the supervisor's act — closed or moved with its reason.
 */
export const HANDLED_SOURCES = Object.freeze(
  /** @type {const} */ (['guard', 'auto-grant', 'relay-rule', 'ladder', 'supervisor', 'session', 'console']),
);

/**
 * What a handled row may link to (control-tower phase 136, #213): the commit,
 * the pull request, the issue or the journal line that shows it — never a URL
 * of any other shape. `phase-outcome.sh … handled --link` and the ledger's
 * reader hold a link to these four (`server/turn/handled.ts`).
 */
export const HANDLED_LINK_KINDS = Object.freeze(/** @type {const} */ (['commit', 'pr', 'issue', 'journal']));

/* ------------------------------------------------------------------ *
 * The guard's own words (G1–G7, §Architecture 19)
 * ------------------------------------------------------------------ */

/**
 * The exit a declaration refused by G4 ends with — distinct from 2 (a
 * malformed call) and 3 (a proof already true) so a session can tell "you
 * could do this yourself" from both.
 */
export const GUARD_REFUSAL_EXIT = 4;

/**
 * G5's refusal (control-tower phase 135): a permission declaration that cites
 * no wall this console recorded for its lane — nothing refused it.
 */
export const G5_SENTENCE =
  'nothing refused this — run it: this console recorded no wall for this lane that the declaration names, so the call was never ' +
  'refused. Run the command; if it is refused, the refusal is recorded and a declaration citing it raises an item.';

/**
 * What a permission errand says when G5 refused its declaration at ingest
 * (turn-by-turn phase 6, the honest path): no item was raised, so the errand
 * names none — never "Your turn holds a permission item for it".
 */
export const G5_ERRAND_HOW =
  'Nothing refused the command the session named: this console recorded no wall for its lane, so Your turn holds no ' +
  'permission item for it. Recover & continue resumes the phase to run the command itself; if it is refused then, the ' +
  'refusal is recorded and a declaration citing it raises the item.';

/** The rules, by name, in the order the door runs them. */
export const GUARD_RULES = Object.freeze(/** @type {const} */ (['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']));

/* ------------------------------------------------------------------ *
 * The card contract (turn-by-turn phase 1, §Architecture 2)
 *
 * Every card is drawn from the same words, each derived ONCE here from what the
 * item already carries — its kind, where it came from, which record holds it,
 * how it is proven, its ledger state — and carried on every `GET /api/turn`
 * item: the TYPE (what the person is asked for), the PERSON'S STATUS (where
 * the item stands for them), the READINESS (whether it is due) and the ROUTE
 * (where a press goes, and who resumes). `category` stays the status lamp's
 * family (`humanStepCategory`) and is never drawn as the type.
 * ------------------------------------------------------------------ */

/**
 * Where an item came from — one word each (control-tower phase 132). The
 * ledger's: a plan bullet, a session's declaration, a person errand, a
 * credential or MCP preflight, an unanswerable relay question, a converted
 * stall, the supervisor's raise. The projected: the approval broker's card, a
 * gate, a plan-approval hold, a QA ask, a live relay question, a
 * person-check, a sign-in, an MCP sign-in, a conflict, a session's ask. And an
 * authority press another door asked the owner for (control-tower phase 148).
 * @typedef {(typeof TURN_SOURCES)[number]} TurnSource
 */
export const TURN_SOURCES = Object.freeze(
  /** @type {const} */ ([
    'plan',
    'session',
    'errand',
    'preflight',
    'relay',
    'stall',
    'supervisor',
    'approval',
    'gate',
    'plan-approval',
    'qa',
    'question',
    'person-check',
    'sign-in',
    'mcp-auth',
    'conflict',
    'session-ask',
    'request',
    // A phase's run request (turn-by-turn phase 6, #286): ONE approval per run and act.
    'run-request',
  ]),
);

/**
 * Which record holds an item: the human-step ledger, another record the item
 * is projected from (a card, a gate, a question), or an owner request.
 * @typedef {(typeof TURN_RECORDS)[number]} TurnRecord
 */
export const TURN_RECORDS = Object.freeze(/** @type {const} */ (['ledger', 'projected', 'request']));

/**
 * What the person is asked for. `approve` — a yes or no on something an AI, a
 * plan or a session wants to do; `do` — an act only a person can do; `decide`
 * — choose among named options; `know` — nothing to do (an unbound errand
 * row, never counted).
 * @typedef {(typeof ITEM_TYPES)[number]} ItemType
 */
export const ITEM_TYPES = Object.freeze(/** @type {const} */ (['approve', 'do', 'decide', 'know']));

/** What each type is called, and what it asks, in one line. @type {Readonly<Record<ItemType, Readonly<{label: string, sense: string}>>>} */
export const TYPE_META = Object.freeze({
  approve: Object.freeze({
    label: 'Approval',
    sense: 'Say yes or no to something the AI, a plan or a session wants to do.',
  }),
  do: Object.freeze({ label: 'Task', sense: 'Something only you can do.' }),
  decide: Object.freeze({ label: 'Decision', sense: 'Choose one of the options.' }),
  know: Object.freeze({ label: 'Heads-up', sense: 'Nothing to do — it is here so you know.' }),
});

/**
 * The type a kind asks for when nothing else decides it: a decision is
 * decided, a check by eye or a permission is a yes or no, every other kind is
 * an act. Total over the kinds.
 * @type {Readonly<Record<import('./human-step-model.js').HumanStepKind, ItemType>>}
 */
export const KIND_TYPE = Object.freeze({
  'browser-login': 'do',
  'device-code': 'do',
  'one-time-code': 'do',
  'secret-entry': 'do',
  'claude-login': 'do',
  'mcp-login': 'do',
  'os-prompt': 'do',
  'os-permission': 'do',
  'third-party-approval': 'do',
  physical: 'do',
  'person-check': 'approve',
  decision: 'decide',
  'protected-path': 'do',
  'interactive-prompt': 'do',
  captcha: 'do',
  'email-link': 'do',
  'operator-act': 'do',
  permission: 'approve',
});

/**
 * The sources whose PROJECTED card is a yes or no — a gate, a permission card,
 * a held plan, a check by eye, an owner request, a supervisor's suggestion
 * card — keyed by every source, so a source added without an answer is a type
 * error. A ledger item's source never makes it an approval: the supervisor's
 * raised escalation is an act, its standing suggestion card a yes or no.
 * @type {Readonly<Record<TurnSource, boolean>>}
 */
export const SOURCE_APPROVES = Object.freeze({
  plan: false,
  session: false,
  errand: false,
  preflight: false,
  relay: false,
  stall: false,
  supervisor: true,
  approval: true,
  gate: true,
  'plan-approval': true,
  qa: false,
  question: false,
  'person-check': true,
  'sign-in': false,
  'mcp-auth': false,
  conflict: false,
  'session-ask': false,
  request: true,
  'run-request': true,
});

/**
 * The item's type, derived once. In order: an unbound row is a heads-up; an
 * owner request, an approval block, a grant, or a projected card of an
 * approving source is an approval; options, an answer for proof or a decision
 * kind are a decision; otherwise the kind's own type.
 * @param {{kind?: string, source?: string, record?: string, proofType?: string|null, hasOptions?: boolean, hasApproval?: boolean, bound?: boolean}} item
 * @returns {ItemType}
 */
export function typeOf(item) {
  if (item.bound === false) return 'know';
  if (item.record === 'request' || item.source === 'request') return 'approve';
  if (item.hasApproval || item.proofType === 'grant') return 'approve';
  const kindType = /** @type {Record<string, ItemType>} */ (KIND_TYPE)[String(item.kind ?? '')];
  if (kindType === 'approve') return 'approve';
  const approves = /** @type {Record<string, boolean>} */ (SOURCE_APPROVES)[String(item.source ?? '')];
  if (item.record !== 'ledger' && approves) return 'approve';
  if (item.hasOptions || item.proofType === 'answer' || kindType === 'decide') return 'decide';
  return 'do';
}

/**
 * Where an item stands for the PERSON — the ledger's states told in a
 * person's words, plus the owner's: to do, being checked, passed, sent back to
 * redo, not doing it, closed without them, and waiting for the owner (an
 * owner-door request).
 * @typedef {(typeof PERSON_STATUSES)[number]} PersonStatus
 */
export const PERSON_STATUSES = Object.freeze(
  /** @type {const} */ (['todo', 'checking', 'passed', 'redo', 'not-doing', 'closed', 'owner']),
);

/** What each person's status is called. @type {Readonly<Record<PersonStatus, string>>} */
export const PERSON_STATUS_LABEL = Object.freeze({
  todo: 'To do',
  checking: 'Checking',
  passed: 'Passed',
  redo: 'Redo',
  'not-doing': 'Not doing',
  closed: 'Closed',
  owner: 'Waiting for the owner',
});

/**
 * The ledger's states, each told as a person's status. Total over the states
 * (a state added without a row is a type error): every open state before a
 * check is to do — `upcoming` included, which its readiness says is not yet
 * due — a returned one is to redo, a declined one or one the person cannot do
 * is theirs not to do, and one that expired or was withdrawn closed without them.
 * @type {Readonly<Record<import('./human-step-model.js').HumanStepState, PersonStatus>>}
 */
export const STATE_PERSON_STATUS = Object.freeze({
  upcoming: 'todo',
  declared: 'todo',
  notified: 'todo',
  opened: 'todo',
  checking: 'checking',
  returned: 'redo',
  proven: 'passed',
  declined: 'not-doing',
  expired: 'closed',
  cannot: 'not-doing',
  dismissed: 'closed',
});

/**
 * The person's status, derived once: an owner request waits for the owner; a
 * ledger state answers by its row; an item with no state (a projected card)
 * answers by its last verdict, else it is to do.
 * @param {{state?: string|null, verdict?: string|null, record?: string}} item
 * @returns {PersonStatus}
 */
export function personStatusOf(item) {
  if (item.record === 'request') return 'owner';
  const byState = /** @type {Record<string, PersonStatus>} */ (STATE_PERSON_STATUS)[String(item.state ?? '')];
  if (byState) return byState;
  if (item.verdict === 'passed') return 'passed';
  if (item.verdict === 'rejected' || item.verdict === 'needs-info') return 'redo';
  return 'todo';
}

/**
 * Whether the act is due: NOW, or NOT YET (an `upcoming` step, or one whose
 * start is ahead). A card shows it only while the person has the act to do.
 * @typedef {(typeof READINESS)[number]} Readiness
 */
export const READINESS = Object.freeze(/** @type {const} */ (['now', 'not-yet']));

/** What each readiness is called. @type {Readonly<Record<Readiness, string>>} */
export const READINESS_LABEL = Object.freeze({ now: 'Now', 'not-yet': 'Not yet' });

/**
 * The readiness, derived once — always one word: an `upcoming` step is not
 * yet due, so is a stateless item still waiting on its due-when ref, and so is
 * one whose start is ahead of `now`; everything else is due now.
 * @param {{state?: string|null, dueWhen?: string|null, startAt?: string|null, now?: number}} item
 * @returns {Readiness}
 */
export function readinessOf(item) {
  if (item.state === 'upcoming') return 'not-yet';
  if (!item.state && typeof item.dueWhen === 'string' && item.dueWhen) return 'not-yet';
  const start = typeof item.startAt === 'string' ? Date.parse(item.startAt) : NaN;
  if (Number.isFinite(start) && start > (item.now ?? Date.now())) return 'not-yet';
  return 'now';
}

/** Is the readiness drawn for a person's status — only while the act is still theirs to do. */
export function readinessShown(/** @type {string} */ personStatus) {
  return personStatus === 'todo' || personStatus === 'redo';
}

/**
 * Where a press goes — *Goes to*: the PHASE (its session resumes), the
 * SUPERVISOR (Pro) or the RUN (Free) — the run applies the act and resumes —
 * the GATE (it opens and its phase boards), or the CONSOLE (it checks; the
 * phases that wait on it board).
 * @typedef {(typeof ROUTE_TO)[number]} RouteTo
 */
export const ROUTE_TO = Object.freeze(
  /** @type {const} */ (['phase', 'supervisor', 'run', 'gate', 'console']),
);

/** What each route is called, and who resumes, in words. @type {Readonly<Record<RouteTo, Readonly<{label: string, resumes: string}>>>} */
export const ROUTE_META = Object.freeze({
  phase: Object.freeze({ label: 'The phase', resumes: 'its session picks up where it stopped' }),
  supervisor: Object.freeze({
    label: 'The supervisor',
    resumes: 'the supervisor applies it and the run carries on',
  }),
  run: Object.freeze({ label: 'The run', resumes: 'the run applies it and carries on' }),
  gate: Object.freeze({ label: 'The gate', resumes: 'the gate opens and its phase starts' }),
  console: Object.freeze({
    label: 'The console',
    resumes: 'the console checks it, and the phases waiting on it start',
  }),
});

/**
 * Where each source's press goes, before the edition and the birth speak —
 * total over the sources. `run` is the run-level word; Pro tells it as the
 * supervisor (`routeOf`). A preflight, a sign-in and an owner request are
 * checked by the console before anything boards; a conflict and the
 * supervisor's own items are the run's; everything else resumes its phase.
 * @type {Readonly<Record<TurnSource, Exclude<RouteTo, 'supervisor'>>>}
 */
export const SOURCE_ROUTE = Object.freeze({
  plan: 'phase',
  session: 'phase',
  errand: 'phase',
  preflight: 'console',
  relay: 'phase',
  stall: 'phase',
  supervisor: 'run',
  approval: 'phase',
  gate: 'gate',
  'plan-approval': 'phase',
  qa: 'phase',
  question: 'phase',
  'person-check': 'phase',
  'sign-in': 'console',
  'mcp-auth': 'console',
  conflict: 'run',
  'session-ask': 'phase',
  request: 'console',
  // The run takes it — the supervisor, in Pro (`routeOf`).
  'run-request': 'run',
});

/**
 * The route, derived once. In order: an item the supervisor raised is the
 * run's; a plan's own act (every waiter at phase 0 — the plan's `## Operator
 * errands`) is the console's; an errand no ledger step stands behind is the
 * ladder's ask on a halt — the run's; otherwise the source's row. The run is
 * the supervisor in Pro; Free has no supervisor and answers `run`.
 * @param {{birth?: string|null, source?: string, record?: string, waiters?: ReadonlyArray<{phase?: number|string}>|null, phase?: number|string|null, edition?: string}} item
 * @returns {RouteTo}
 */
export function routeOf(item) {
  /** @type {Exclude<RouteTo, 'supervisor'>} */
  let route =
    /** @type {Record<string, Exclude<RouteTo, 'supervisor'>>} */ (SOURCE_ROUTE)[String(item.source ?? '')] ??
    'phase';
  if (item.birth === 'supervisor') route = 'run';
  else if (item.source === 'errand' && item.record === 'projected') route = 'run';
  else if (item.birth === 'plan' || item.source === 'plan') {
    const phases = item.waiters?.length
      ? item.waiters.map((waiter) => Number(waiter.phase))
      : [Number(item.phase)];
    route = phases.every((phase) => phase === 0) ? 'console' : 'phase';
  }
  return route === 'run' && item.edition === 'pro' ? 'supervisor' : route;
}

/**
 * *Checked by* — who or what decides the item is done, in words, keyed by the
 * proof types (no second list).
 * @type {Readonly<Record<ProofType, string>>}
 */
export const CHECKED_BY_LABEL = Object.freeze({
  probe: 'The console runs a check',
  answer: 'Your answer is the result',
  judgement: 'A checking session reads your evidence',
  attest: 'Your word',
  grant: 'Your grant',
});

/**
 * Where an item's steps came from (turn-by-turn phase 3, `server/turn/compose.ts`),
 * first that exists: an authored guide, the plan's errands row, the step's own
 * lines, the situation's ask, or a minimal guide from what it opens and its proof.
 * @typedef {(typeof STEPS_FROM)[number]} StepsFrom
 */
export const STEPS_FROM = Object.freeze(
  /** @type {const} */ (['guide', 'errand', 'lines', 'ask', 'minimal']),
);

/**
 * Does a kind's act outlive the run that raised it (turn-by-turn phase 7,
 * §Architecture 5.2)? A WORLD act — a sign-in, a secret stored, a tunnel
 * built, a third party's approval, hands at a device — is still owed by the
 * plan when the run that met it is replaced, so the round's stale pass moves
 * it to the successor's lane (`server/turn/stale.ts`). Anything else is
 * RUN-SPECIFIC — a code a session printed, a dialog it raised, a decision or a
 * permission its session asked for, a protected edit on its tree — and closes
 * with the run. One row per kind, asserted at load.
 * @type {Readonly<Record<import('./human-step-model.js').HumanStepKind, boolean>>}
 */
export const KIND_OUTLIVES_RUN = Object.freeze({
  'browser-login': true,
  'device-code': false,
  'one-time-code': false,
  'secret-entry': true,
  'claude-login': true,
  'mcp-login': true,
  'os-prompt': false,
  'os-permission': true,
  'third-party-approval': true,
  physical: true,
  'person-check': false,
  decision: false,
  'protected-path': false,
  'interactive-prompt': false,
  captcha: false,
  'email-link': true,
  'operator-act': true,
  permission: false,
});

/**
 * The sources whose items are about the RUN itself, whatever their kind: an
 * errand, a relayed question, a stall, a run request — each closes with its run.
 */
export const RUN_BOUND_SOURCES = Object.freeze(
  /** @type {const} */ (['errand', 'relay', 'stall', 'console', 'run-request']),
);

/**
 * Is this item a world act — one the stale pass moves to a successor run
 * rather than closes? A supervisor's item and one raised from a run-bound
 * source are the run's; any other follows its kind.
 * @param {{ kind: string; birth?: string; source?: { kind?: string } | null }} step
 */
export function outlivesRun(step) {
  if (step.birth === 'supervisor') return false;
  if (
    step.birth === 'console' &&
    RUN_BOUND_SOURCES.includes(/** @type {never} */ (step.source?.kind ?? 'console'))
  )
    return false;
  return /** @type {Record<string, boolean>} */ (KIND_OUTLIVES_RUN)[step.kind] === true;
}

/** Every kind has a reason list — asserted at load, so a kind added without one fails the first import. */
for (const kind of HUMAN_STEP_KINDS) {
  // …and says whether its act outlives its run (turn-by-turn phase 7).
  if (typeof (/** @type {Record<string, unknown>} */ (KIND_OUTLIVES_RUN)[kind]) !== 'boolean') {
    throw new Error(`turn-model: KIND_OUTLIVES_RUN has no row for the kind ${kind}`);
  }
  if (!(/** @type {Record<string, unknown>} */ (KIND_REASONS)[kind])) {
    throw new Error(`turn-model: KIND_REASONS has no row for the kind ${kind}`);
  }
  // …and a type (turn-by-turn phase 1).
  if (!(/** @type {Record<string, unknown>} */ (KIND_TYPE)[kind])) {
    throw new Error(`turn-model: KIND_TYPE has no row for the kind ${kind}`);
  }
}

/** Every state is told as a person's status — a state added without a row fails the first import. */
for (const state of HUMAN_STEP_STATES) {
  if (!(/** @type {Record<string, unknown>} */ (STATE_PERSON_STATUS)[state])) {
    throw new Error(`turn-model: STATE_PERSON_STATUS has no row for the state ${state}`);
  }
}
