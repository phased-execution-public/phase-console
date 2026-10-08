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

import { HUMAN_STEP_KINDS, HUMAN_STEP_SETTLED_STATES } from './human-step-model.js';

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
 * *Do now* · *Needs one detail from you* · *Coming up* · *Being checked* ·
 * *Done* — derived by `groupOf(step)`, never stored.
 * @typedef {(typeof TURN_GROUPS)[number]} TurnGroup
 */
export const TURN_GROUPS = Object.freeze(
  /** @type {const} */ (['now', 'decide', 'upcoming', 'checking', 'done']),
);

/** What each group is called on the page. @type {Readonly<Record<TurnGroup, string>>} */
export const TURN_GROUP_LABEL = Object.freeze({
  now: 'Do now',
  decide: 'Needs one detail from you',
  upcoming: 'Coming up',
  checking: 'Being checked',
  done: 'Done',
});

/**
 * The group an item is drawn in — total over the states: a settled one
 * is done, an upcoming one is coming up, one being checked is being checked,
 * an open decision needs one detail, and every other open one (a returned one
 * included — it has to be redone) is the person's to do now.
 * @param {{state?: string, kind?: string, proofType?: string}} step
 * @returns {TurnGroup}
 */
export function groupOf(step) {
  const state = String(step?.state ?? '');
  if (state === 'upcoming') return 'upcoming';
  if (state === 'checking') return 'checking';
  if (SETTLED.has(state)) return 'done';
  if (step?.kind === 'decision' || step?.proofType === 'answer') return 'decide';
  return 'now';
}

/** The settled states, read once from the human-step model. */
const SETTLED = new Set(/** @type {readonly string[]} */ (HUMAN_STEP_SETTLED_STATES));

/** Who handled something instead of asking a person. */
export const HANDLED_SOURCES = Object.freeze(
  /** @type {const} */ (['guard', 'auto-grant', 'relay-rule', 'ladder', 'supervisor', 'session']),
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

/** The rules, by name, in the order the door runs them. */
export const GUARD_RULES = Object.freeze(/** @type {const} */ (['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']));

/** Every kind has a reason list — asserted at load, so a kind added without one fails the first import. */
for (const kind of HUMAN_STEP_KINDS) {
  if (!(/** @type {Record<string, unknown>} */ (KIND_REASONS)[kind])) {
    throw new Error(`turn-model: KIND_REASONS has no row for the kind ${kind}`);
  }
}
