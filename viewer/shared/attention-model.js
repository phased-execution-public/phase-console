/**
 * The attention model: ONE vocabulary for "something needs a person right
 * now", and the two rules every surface that shows one must agree on — what
 * makes two asks the SAME ask, and what order they are read in.
 *
 * Before the unified inbox, eight places each decided in their own words that
 * something was waiting on a person: the dashboard's `demands()`, the push
 * catalogue's `needs-you` category, the ladder's errands, the approval cards,
 * the accounts page's signed-out banner, the MCP status chips, the per-plan
 * health issues and the lock table. Nothing could count them, because nothing
 * could say whether a halted-run card, the errand under it and the push that
 * announced it were three asks or one; and nothing could be dismissed, because
 * an ask had no name to dismiss. `GET /api/inbox` answers that list once. This
 * file is the part of the answer that cannot live in one layer: the kinds, the
 * severities, the identity an acknowledgement is keyed on, and the order.
 *
 * Read by (import identity, never a copy):
 *
 *   - `viewer/server/inbox.ts` — gathers the facts and builds the items; it
 *     mints every `InboxItem.id` with `inboxItemId` and returns
 *     `sortInbox(items)`. It owns WHICH facts raise an item; this file owns
 *     what those items are called, what they are worth and who they are;
 *   - `viewer/server/api/routes.ts` — `GET /api/inbox`, `POST /api/inbox/ack`,
 *     `DELETE /api/inbox/ack`. The acks file is keyed by the id minted here,
 *     so the id IS the ack key and the stability rules below are load-bearing;
 *   - `viewer/client/src/lib/api/inbox.ts` — the wire TYPES, agreed in Phase 3
 *     (`InboxKind`, `InboxSeverity`, `InboxAction`, `InboxItem`, `InboxView`).
 *     TypeScript types erase at runtime, so that file cannot carry the values
 *     and this one cannot carry the types; `viewer/test/attention-model.test.ts`
 *     reads that file's unions and holds the two identical, word for word and
 *     in the same order, so the pair can never drift;
 *   - the client surfaces that group, filter and count the inbox import the
 *     vocabulary as `@shared/attention-model.js` — the alias `vite.config.ts`
 *     and `client/tsconfig.json` already resolve to this directory.
 *
 * Dependency-free ESM (`.js` + JSDoc), the `situation-model.js` /
 * `ladder-model.js` precedent: the only import allowed is another `shared/`
 * module, so the node tests, the server and the browser all get THE SAME
 * objects rather than three equal copies that pass `deepEqual` today. There is
 * exactly one, `fact-map.js`, and it is the reason `deriveAttention` below can
 * live here at all: the tables say what a situation TURNS INTO, this file says
 * which rows therefore exist, and no consumer gets to have an opinion about
 * either. (`fact-map.js` does not import back — see its header.)
 *
 * ------------------------------------------------------------------
 * The two rules
 * ------------------------------------------------------------------
 *
 * **1. Identity is WHAT is asking, never WHEN it asked.** `inboxItemId` is
 * built from `kind`, `slug`, `phase`, `runId` and a per-kind `subject`, and
 * from nothing else — no timestamp, no attempt counter, no hash of the prose,
 * no array index. Two reasons, both measured:
 *
 *   - an ack is stored under this id in a file that outlives the process, so
 *     an id that moves silently un-acks the item and the operator is asked the
 *     same question again after a restart. The console's existing dedupe maps
 *     (`notifiedRun` / `notifiedPhase`, `server/service.ts`) are in-memory
 *     only and re-announce after a restart on purpose — an inbox may not,
 *     because an inbox accumulates;
 *   - an id that moves on every poll makes the ack useless entirely and grows
 *     a line per sweep. That is the shape of the failure the notification
 *     suite already pins ("that is how an inbox reaches 182 unread
 *     notifications"). `Approvals.request` mints its ids from `Date.now()`,
 *     which is exactly right for a card raised once and answered once, and
 *     exactly wrong here: the same wall, re-detected a minute later, would be
 *     a second id, a second ack and a second row.
 *
 * **2. Identity is injective.** Every component is escaped and the join has
 * fixed arity, so two genuinely different asks can never share an id — a
 * collision would let acknowledging one silence the other, which is worse than
 * a duplicate row. The only collapses are the deliberate ones documented on
 * `inboxItemId`: absent ≡ empty ≡ blank, and a non-positive phase ≡ no phase
 * (the ladder writes `phase: 0` on a run-level errand to mean exactly that).
 *
 * Two items that ARE the same ask must therefore collapse to one row by
 * construction: the builder raises one item per subject, and the id is what
 * makes that a property a test can check rather than a habit.
 */

import { STALL_SIGNAL_KIND, factsFor, splitSituation } from './fact-map.js';

/* ------------------------------------------------------------------ *
 * Kinds
 * ------------------------------------------------------------------ */

/**
 * @typedef {'errand'|'approval'|'gate'|'sign-in'|'mcp-auth'|'qa'|'lock'
 *   |'health'|'stall'|'ruling'|'session-ask'|'conflict'|'question'|'policy'} InboxKind
 */

/**
 * What kind of thing is asking. Frozen: it is a vocabulary, and the order is
 * the client contract's own union order — which `sortInbox` then reuses as its
 * third tie-break, so the list has a total order that does not depend on the
 * order the server happened to gather its facts in.
 *
 * `stall` and `ruling` were declared here before anything produced them (the
 * stall vocabulary is at the foot of this file). A ruling that names its
 * decision key now carries `remember: 'plan'|'global'` as its two actions —
 * a decision that should outlive the session that made it, written as a
 * `## Decisions` row or as this console's own policy answer (zero-touch
 * phase 12). They were in the list from the first day so that the wire type,
 * the labels, the filter chips and the ack file never needed a migration
 * when the producers landed.
 *
 * @type {readonly InboxKind[]}
 */
export const INBOX_KINDS = Object.freeze(
  /** @type {const} */ ([
    /** The ladder is spent and left ONE ask: what is needed, how to give it, what was tried. */
    'errand',
    /** A permission card: a session is parked dead until someone answers it. */
    'approval',
    /** A manual gate on a phase the board would otherwise call ready. */
    'gate',
    /** The machine login or a console account is signed out; nothing runs under it. */
    'sign-in',
    /** An MCP server this work names is signed out or failing, and only a person can sign it in. */
    'mcp-auth',
    /** A QA verdict a person owes, or a QA failure recorded against a phase. */
    'qa',
    /** A phase lock nothing will release by itself — debris, or a claim in the way. */
    'lock',
    /** The console's own health: a broken watcher, a bad PATH, a degraded subsystem. */
    'health',
    /** Phase 5. Something nominally in flight that has not moved. */
    'stall',
    /** A decision worth remembering — keyed, it offers to be. */
    'ruling',
    /**
     * A Claude session outside the autopilot — an agent, or someone's own CLI
     * — stopped at a permission prompt or waiting for input at its own
     * terminal. Appended at the end (2026-08-23) so every earlier kind keeps
     * its rank; the rank is only the third sort tie-break.
     */
    'session-ask',
    /**
     * Two branches with live checkouts would not merge — the radar's
     * `conflicted` verdict, raised while serializing them is still cheap.
     * Appended at the end (2026-08-27) for `session-ask`'s reason: every
     * earlier kind keeps its rank, and the rank is only the third sort
     * tie-break.
     */
    'conflict',
    /**
     * A question a session raised on a run whose relay is armed (zero-touch
     * phase 14): one row per question, one action per option, and a window —
     * a person who picks inside it wins, and the console answers by rule when
     * it closes. Appended at the end for `session-ask`'s reason.
     */
    'question',
    /**
     * What the console decided BY ITSELF (zero-touch phase 19): a
     * `phase.policy-answered` line — a situation a person would once have been
     * asked about, answered by the policy table (phase 11) instead. `fyi`, with
     * the decision key, the answer, where it came from and the shipped default,
     * so the operator can see the console acting in their name and change the
     * answer. Appended at the end for `session-ask`'s reason.
     */
    'policy',
  ]),
);

/**
 * What a card, a chip and a filter call each kind — a short noun phrase, never
 * a sentence. `SITUATION_LABELS` precedent: the words live once so a filter
 * chip, a group heading and a push title cannot disagree.
 * @type {Readonly<Record<InboxKind, string>>}
 */
export const INBOX_KIND_LABELS = Object.freeze({
  errand: 'Errand',
  approval: 'Permission',
  gate: 'Gate',
  'sign-in': 'Sign-in',
  'mcp-auth': 'MCP sign-in',
  qa: 'QA',
  lock: 'Lock',
  health: 'Health',
  stall: 'Stall',
  ruling: 'Ruling',
  'session-ask': 'Session ask',
  conflict: 'Conflict',
  question: 'Question',
  policy: 'Policy answered',
});

/**
 * The kinds that are somebody ASKING right now — a session stopped dead until
 * a person answers: a permission card (`approval`), a session blocked at its
 * own prompt (`session-ask`), or a relayed question inside its window
 * (`question`, phase 14). What the top bar's "waiting on
 * you" indicator counts, and what the drawer's own section gathers. A subset
 * of `INBOX_KINDS` by identity — a test pins that.
 *
 * @type {readonly InboxKind[]}
 */
export const ASK_KINDS = Object.freeze(/** @type {const} */ (['approval', 'session-ask', 'question']));

/**
 * How many of `items` are live asks — the indicator's number. Unknown kinds
 * count as not-asks, the same benefit of the doubt every unknown word gets.
 *
 * @param {readonly {kind?: string}[]} [items]
 * @returns {number}
 */
export function askCount(items) {
  return (items ?? []).filter((item) =>
    /** @type {readonly string[]} */ (ASK_KINDS).includes(String(item?.kind ?? '')),
  ).length;
}

/* ------------------------------------------------------------------ *
 * Severities
 * ------------------------------------------------------------------ */

/**
 * @typedef {'urgent'|'needs-you'|'fyi'} InboxSeverity
 */

/**
 * How loudly, WORST FIRST — the `UI_STATES` convention, so index is rank and
 * `sortInbox` needs no second table:
 *
 *   - `urgent`   — something is stopped dead and costing: a session parked on
 *                  a permission card, a sign-out that blocks every run;
 *   - `needs-you`— waiting on a person, but nothing is burning while it waits;
 *   - `fyi`      — worth knowing, worth nobody's interruption.
 *
 * @type {readonly InboxSeverity[]}
 */
export const INBOX_SEVERITIES = Object.freeze(/** @type {const} */ (['urgent', 'needs-you', 'fyi']));

/**
 * Does this severity count toward the badge?
 *
 * "A badge counts everything but `fyi`" is the rule, and it was written out
 * three times against a bare string — in Now's model, in the client's query
 * layer and in the plans model — none of which could see the others. The rule
 * belongs next to the vocabulary it is about: a fourth severity added above
 * `fyi` is then counted by every surface at once, and demoting one to quiet is
 * one edit rather than a search.
 *
 * @param {string | undefined} severity
 * @returns {boolean}
 */
export function countsTowardAttention(severity) {
  return severity !== 'fyi';
}

/**
 * How many of these want a person. The shape every caller actually wanted.
 *
 * @param {ReadonlyArray<{ severity?: string }> | undefined | null} items
 * @returns {number}
 */
export function attentionCount(items) {
  return (items ?? []).filter((item) => countsTowardAttention(item.severity)).length;
}

/**
 * Which UI state paints each severity.
 *
 * The console has ONE status vocabulary (`shared/status-vocab.js`): eight
 * states, each with its own hue token, read by `StatusBadge` and `.state-<ui>`
 * and by nothing else. Severity is a new word family, so it maps into that
 * vocabulary here rather than growing a ninth colour — and `needs-you` maps to
 * the state of the same name, which is not a coincidence but the point.
 *
 * The values are plain strings and `status-vocab.js` is deliberately NOT
 * imported — a paint table is a different layer from a vocabulary, and
 * `test/attention-model.test.ts` holds every value to a real `UI_STATES`
 * member instead.
 * @type {Readonly<Record<InboxSeverity, string>>}
 */
export const SEVERITY_UI = Object.freeze({
  urgent: 'failed',
  'needs-you': 'needs-you',
  fyi: 'queued',
});

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The identifying half of an item — what `inboxItemId` reads, and all it reads.
 *
 * `subject` is the discriminator WITHIN a (kind, slug, phase, runId): the
 * approval id, the MCP server id, the account id, the health issue kind, the
 * situation key of an errand, the stall kind. It is not on the wire — the id
 * it produces is — because a client that could re-derive an id would be a
 * second implementation of this rule.
 *
 * @typedef {Object} InboxSubject
 * @property {string} kind
 * @property {string} [slug]
 * @property {number|string|null} [phase]
 * @property {string} [runId]
 * @property {string} [subject]
 */

/**
 * Percent-escape the two characters that could forge another tuple's id: the
 * separator itself, and the escape. Every other byte is left readable, because
 * the ack file is a thing an operator may have to read: `errand:my-plan:4::verify-red`
 * says what it is, where a sha would say nothing.
 * @param {unknown} value
 */
const escapePart = (value) => String(value).replace(/%/g, '%25').replace(/:/g, '%3A');

/**
 * A text component, normalised: absent, `null`, empty and blank all mean "this
 * item is not about one of those" and collapse to the same empty slot.
 * @param {unknown} value
 */
function textPart(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text ? escapePart(text) : '';
}

/**
 * The phase component.
 *
 * A non-positive, non-integer or absent phase all collapse to "no phase" — the
 * ladder writes `phase: 0` on a RUN-level errand (a wall with no phase to hang
 * it on) and the dashboard already reads `0` as "no phase" when it decides
 * whether to say "phase 4 needs you". If `0` and `undefined` minted different
 * ids, the same run-level errand would be two rows depending on which of the
 * two producers wrote it.
 * @param {unknown} phase
 */
function phasePart(phase) {
  const n = Number(phase);
  return Number.isInteger(n) && n > 0 ? String(n) : '';
}

/**
 * The stable dedupe identity of an item — the ack key, and the only thing that
 * makes "the same ask" a checkable claim.
 *
 * Stable across restarts, because every component is read from a persisted
 * record (a plan slug, a phase number, a run id, an approval id, a server id),
 * never from process memory or a clock. Injective over
 * `(kind, slug, phase, runId, subject)`: fixed arity, and `:`/`%` escaped in
 * every component, so `{slug: 'a:b'}` and `{slug: 'a', phase: …}` cannot land
 * on the same string. The deliberate collapses — and only these — are:
 * absent ≡ `null` ≡ `''` ≡ blank, and phase `0`/negative/non-integer ≡ no
 * phase.
 *
 * A missing `kind` mints `unknown` rather than throwing: an inbox that 500s
 * because one builder branch forgot a field is worse than an inbox with one
 * oddly-named row, and the row is visible where an exception is not.
 *
 * Mint, do not re-derive: a finished `InboxItem` carries no `subject`, so
 * calling this on one fetched from the wire will NOT reproduce its id. Read
 * `item.id`.
 *
 * @param {InboxSubject} item
 * @returns {string}
 */
export function inboxItemId(item) {
  return [
    textPart(item?.kind) || 'unknown',
    textPart(item?.slug),
    phasePart(item?.phase),
    textPart(item?.runId),
    textPart(item?.subject),
  ].join(':');
}

/**
 * The inverse of `inboxItemId`, for the ONE caller that needs it: the ack
 * route, which has an id and has to know whether it names a ruling (and which
 * one) so the acknowledgement can be appended to that plan's ledger as well as
 * to the acks file.
 *
 * It lives here rather than in the route because it is the same rule read
 * backwards, and a second implementation of the escaping would break silently
 * the day `escapePart` changed. It is deliberately NOT a way to reconstruct an
 * item: an id names a subject, and a subject is not an ask.
 *
 * Returns null for anything that is not a five-part id, so a garbage parameter
 * off an HTTP body degrades to "not a ruling" rather than to an exception.
 *
 * @param {string} id
 * @returns {{ kind: string, slug: string, phase: number|null, runId: string, subject: string }|null}
 */
export function parseInboxItemId(id) {
  const parts = String(id ?? '').split(':');
  if (parts.length !== 5) return null;
  const [kind, slug, phase, runId, subject] = parts.map(unescapePart);
  if (!kind) return null;
  const n = Number(phase);
  return {
    kind,
    slug,
    phase: phase && Number.isInteger(n) && n > 0 ? n : null,
    runId,
    subject,
  };
}

/**
 * Undo `escapePart`. The order matters and is the reverse of the escape's: the
 * separator first, then the escape character, so `%253A` comes back as the
 * literal `%3A` it was rather than as a colon.
 * @param {string} value
 */
function unescapePart(value) {
  return value.replace(/%3A/g, ':').replace(/%25/g, '%');
}

/* ------------------------------------------------------------------ *
 * Order
 * ------------------------------------------------------------------ */

/** Index is rank: worst severity first, unknown last. */
const SEVERITY_RANK = new Map(INBOX_SEVERITIES.map((severity, i) => [severity, i]));

/** Index is rank: the contract's own kind order, unknown last. */
const KIND_RANK = new Map(INBOX_KINDS.map((kind, i) => [kind, i]));

/**
 * A word a newer console wrote and this one does not know sorts LAST in its
 * column, never first. An unrecognised severity that sorted worst-first would
 * let a future release put an item at the top of every operator's screen by
 * accident; sorting it last is the same failure mode as a category that is off.
 * @param {Map<string, number>} ranks
 * @param {unknown} word
 */
function rankOf(ranks, word) {
  const rank = ranks.get(String(word ?? ''));
  return rank === undefined ? ranks.size : rank;
}

/**
 * When it started asking, in ms. An unparseable or missing `since` sorts LAST
 * within its severity rather than first: a malformed clock is not the oldest
 * thing in the list, and treating it as one would pin a broken row to the top
 * of the inbox forever.
 * @param {{ since?: string }} item
 */
function sinceMs(item) {
  const at = Date.parse(item?.since ?? '');
  return Number.isFinite(at) ? at : Infinity;
}

/**
 * @typedef {Object} InboxItemLike
 * @property {string} [id]
 * @property {string} [kind]
 * @property {string} [severity]
 * @property {string} [since]
 */

/**
 * Total, deterministic order: severity worst-first, then OLDEST FIRST within a
 * severity, then kind, then id.
 *
 * Oldest-first is the whole point of the second key — the ask that has been
 * waiting longest is the one most likely to have been scrolled past, and a
 * newest-first inbox buries exactly the item that needed the person most.
 *
 * The third and fourth keys are not decoration. `Array.prototype.sort` is
 * stable, so ties would otherwise keep the order the SERVER gathered its facts
 * in — which changes when a plan is added, a run finishes or a directory is
 * read in a different order — and the operator's list would reshuffle under
 * their cursor between two identical polls. Kind then id makes the order a
 * function of the items alone.
 *
 * Returns a NEW array: the caller's list may be a cached fact set, and an
 * in-place sort of one of those is a bug that only shows up on the second
 * request.
 *
 * @template {InboxItemLike} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function sortInbox(items) {
  return [...(items ?? [])].sort((a, b) => {
    const severity = rankOf(SEVERITY_RANK, a?.severity) - rankOf(SEVERITY_RANK, b?.severity);
    if (severity !== 0) return severity;

    // Comparison, not subtraction: two items with no usable clock are both
    // `Infinity`, and `Infinity - Infinity` is NaN — a NaN comparator makes
    // the whole sort implementation-defined.
    const at = sinceMs(a);
    const bt = sinceMs(b);
    if (at !== bt) return at < bt ? -1 : 1;

    const kind = rankOf(KIND_RANK, a?.kind) - rankOf(KIND_RANK, b?.kind);
    if (kind !== 0) return kind;

    const ai = String(a?.id ?? '');
    const bi = String(b?.id ?? '');
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

/* ------------------------------------------------------------------ *
 * Stall — declared here, detected in Phase 5
 * ------------------------------------------------------------------ */

/**
 * @typedef {'session-silent'|'session-retrying'|'queued-behind-lock'|'park-overdue'
 *   |'plan-idle'|'verify-hanging'} StallKind
 */

/**
 * The six ways something can be nominally in flight and not moving.
 *
 * DECLARED, NOT DETECTED. Phase 5 writes the detector (it needs the run
 * records, the scheduler snapshot and the session registry, none of which
 * belong in a dependency-free module); this file is the words and the clocks,
 * for the same reason `sizing.env` is one file: a detector that fires at
 * twenty minutes while the card says "half an hour" is a bug report nobody can
 * reproduce.
 *
 * @type {readonly StallKind[]}
 */
export const STALL_KINDS = Object.freeze(
  /** @type {const} */ ([
    'session-silent',
    'session-retrying',
    'queued-behind-lock',
    'park-overdue',
    'plan-idle',
    'verify-hanging',
  ]),
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * What each stall IS, how long it has to be true before it is one, and how
 * loudly it asks.
 *
 * `afterMs` is a floor, not a promise: the detector may only ever be as
 * precise as the clock it reads (a stream's last byte, a lease, a park's
 * `parkedUntil`, a plan's last activity), and every one of those is a
 * timestamp on disk rather than a subscription.
 *
 * @type {Readonly<Record<StallKind, { label: string, blurb: string, afterMs: number, severity: InboxSeverity }>>}
 */
export const STALL_META = Object.freeze({
  'session-silent': Object.freeze({
    label: 'Session silent',
    blurb:
      'A run is in flight and its session has produced nothing for half an hour. It is still spending. Phase 5: exempt a phase whose record says it is inside a §Verification command — a build is silent and fine.',
    afterMs: 30 * MINUTE,
    severity: 'needs-you',
  }),
  'session-retrying': Object.freeze({
    label: 'Session retrying',
    blurb:
      "A session has spent a quarter of an hour inside the CLI's own retry watchdog — 429s absorbed every thirty seconds, no turn, no tool call, no exit. It looks alive from every angle the console has and it is producing nothing; the run's on-limit policy has either already acted or had nowhere to move it to.",
    afterMs: 15 * MINUTE,
    severity: 'needs-you',
  }),
  'queued-behind-lock': Object.freeze({
    label: 'Queued behind a lock',
    blurb:
      "A lane has waited an hour on another owner's phase lock. Deliberately half of the runner's two-hour lock-wait cap: past the cap the wait becomes a halt with its own card, so this one has to arrive while it is still a queue.",
    afterMs: HOUR,
    severity: 'needs-you',
  }),
  'park-overdue': Object.freeze({
    label: 'Park overdue',
    blurb:
      'A phase parked on an external clock is ten minutes past the time it said it would come back, and nothing resumed it — the arming, not the waiting, is what failed.',
    afterMs: 10 * MINUTE,
    severity: 'needs-you',
  }),
  'plan-idle': Object.freeze({
    label: 'Plan idle',
    blurb:
      'A plan with ready phases that nothing has touched for a week. The same seven days `server/analysis/stats.ts` already filters its `stalled` list on — Phase 5 should read that computation rather than re-derive it, and if the two ever disagree, that one wins.',
    afterMs: 7 * DAY,
    severity: 'fyi',
  }),
  'verify-hanging': Object.freeze({
    label: 'Verification hanging',
    blurb:
      "A §Verification command still running after a quarter of an hour — the runtime half of lint F16, which warns at plan time about a check that waits on an external clock (`gh run watch`, a `--watch` flag, a long sleep). Runnable, unfinishable inside a session's turn.",
    afterMs: 15 * MINUTE,
    severity: 'needs-you',
  }),
});

/* ------------------------------------------------------------------ *
 * Stall SIGNALS — what the runner sees on a lane that is still alive
 * ------------------------------------------------------------------ */

/**
 * @typedef {'stalemate'|'retrying'|'external-wait'|'silent'|'spinning'} StallSignal
 */

/**
 * The four ways a LIVE lane stops being work.
 *
 * Not the same list as `STALL_KINDS` above, and deliberately so — the two
 * answer different questions from different evidence:
 *
 *   - `STALL_KINDS` is what an INBOX row is about. It is computed on read,
 *     from timestamps on disk, and it covers things no lane can see: a park
 *     whose resume never fired, a plan nobody has touched in a week, a lock a
 *     lane has been queued behind for an hour. Most of them describe a phase
 *     with no session at all;
 *   - `STALL_SIGNALS` is what the RUNNER sees while a session is running,
 *     from the event stream it is already reading. It has one clock per
 *     signal, a preference each, and it fires at most once per episode.
 *
 * The bridge between them is two signal/kind pairs: a lane whose signal is
 * `silent` is what eventually raises the `session-silent` row, and one whose
 * signal is `retrying` raises `session-retrying` — each at that row's own
 * (longer) clock. Everything else in either list stands alone.
 *
 * Worst-first, the `UI_STATES` / `INBOX_SEVERITIES` convention — index is
 * rank, and `evaluateStall` returns the first that holds:
 *
 *   - `stalemate` — the strongest claim, and the only one settled at an
 *     attempt's END rather than during it: N attempts in a row have finished
 *     with nothing committed and a clean tree. Nothing is happening AND
 *     re-running has stopped helping;
 *   - `retrying`  — N API retries in a row with no turn and no tool call
 *     between them: the session is pinned inside the CLI's own retry
 *     watchdog. It outranks `silent` because a retrying lane IS silent and
 *     this says WHY — the difference between "go and look at it" and "it
 *     cannot reach the API, move it or wait";
 *   - `external-wait` — a Bash call matching the `EXTERNAL_WAIT` vocabulary
 *     (`scripts/verify.env`) has been open past `stallExternalWaitMs`: the
 *     session is polling a clock it does not control from INSIDE its turn,
 *     while holding an exclusive lock nothing can see it holding. It outranks
 *     `silent` for the same reason `retrying` does — the lane IS silent and
 *     this names the cause — and ranks below `retrying` because a session that
 *     cannot reach the API at all is the harder fact. It is the one signal
 *     whose remedy is neither steer nor stop but PARK: the waiting is fine,
 *     the squatting is not;
 *   - `silent`    — the lane has produced nothing at all for `stallSilentMs`
 *     and is still spending. It outranks `spinning` because it is the newer,
 *     harder fact: a session that was turning and then went quiet has stopped
 *     doing even that;
 *   - `spinning`  — turns are going by with no tool call in any of them. The
 *     session is talking, not working.
 *
 * @type {readonly StallSignal[]}
 */
export const STALL_SIGNALS = Object.freeze(
  /** @type {const} */ (['stalemate', 'retrying', 'external-wait', 'silent', 'spinning']),
);

/**
 * What each signal is called, what it means, and which preference sets its
 * threshold — the `STALL_META` shape, minus a clock this file can state: two
 * of the three thresholds are counts rather than durations, so the number
 * lives in `STALL_DEFAULTS` under the key named here and nowhere else.
 *
 * `severity` is the inbox severity a row raised for this signal carries.
 *
 * @type {Readonly<Record<StallSignal, { label: string, blurb: string, pref: string, severity: InboxSeverity }>>}
 */
export const STALL_SIGNAL_META = Object.freeze({
  stalemate: Object.freeze({
    label: 'Stalemate',
    blurb:
      'Three attempts in a row ended with nothing committed and a clean tree. Re-running has stopped being a remedy; the phase needs a different instruction, not another try.',
    pref: 'stallStalemateAttempts',
    severity: 'needs-you',
  }),
  retrying: Object.freeze({
    label: 'Retrying',
    blurb:
      "Five API retries in a row with no turn and no tool call between them. The session is pinned inside the CLI's own retry watchdog — alive, spending, and unable to reach the API. This is the shape a rate-limit wall takes when the child never exits, which is why the run's on-limit policy acts on the stream rather than waiting for a corpse.",
    pref: 'stallRetryBurst',
    severity: 'needs-you',
  }),
  'external-wait': Object.freeze({
    label: 'Waiting on an external clock',
    blurb:
      "A Bash call that by construction waits — `gh run watch`, an `until … sleep` poll, a `--watch` flag — has been open too long. The session is not working, it is watching, and while it watches it holds an exclusive phase lock that looks perfectly healthy from outside: the lease keepalive is a timer, so the claim refreshes every ten minutes whether or not anything is happening. Measured: a phase sat 35+ minutes in two concurrent poll loops holding `scope=all`, blocking every other lane. WHOSE clock it is decides what happens next. Somebody else's (a CI run, a deploy) — after `stallExternalWaitMs` the console does what the skill already documents: park, release the lock, resume when the window elapses. Its OWN background job — a suite, a build, a log it started — and it is between two halves of one job, so it gets one nudge telling it to background the job and carry on, and the park only after the far longer `stallLocalJobMs`, carrying the loop's own condition out as a `cmd:` watch ref.",
    pref: 'stallExternalWaitMs',
    severity: 'needs-you',
  }),
  silent: Object.freeze({
    label: 'Session silent',
    blurb:
      'The session has produced no output for ten minutes and is still spending. Suppressed while the phase is inside its own §Verification — a build is silent and fine — and it names the tool call that has been open longest, which is usually the answer.',
    pref: 'stallSilentMs',
    severity: 'needs-you',
  }),
  spinning: Object.freeze({
    label: 'Spinning',
    blurb:
      'Six turns have gone by without a single tool call. The session is talking rather than working — usually a phase whose next step is not actually available to it.',
    pref: 'stallSpinTurns',
    severity: 'needs-you',
  }),
});

/**
 * The shipped thresholds, keyed by the preference name that overrides each.
 *
 * One source, the `sizing.env` rule: `config.ts` seeds `DEFAULT_PREFS` from
 * here, `runner/liveness.ts` falls back to it when a caller hands it nothing,
 * and Settings ▸ Automation renders the same numbers. A detector that fires at
 * twenty minutes while the card says half an hour is a bug report nobody can
 * reproduce — and it is the reason `STALL_META`'s clocks live in this file
 * too.
 *
 * @type {Readonly<{ stallSilentMs: number, stallSpinTurns: number,
 *   stallStalemateAttempts: number, stallRetryBurst: number,
 *   stallExternalWaitMs: number }>}
 */
export const STALL_DEFAULTS = Object.freeze({
  /**
   * No output at all for this long — ten minutes.
   *
   * **Ten here, thirty in the inbox, and that is deliberate — this is the one
   * owner comment for the split.** `server/inbox.ts` `STALL_META` raises its
   * `session-silent` row at half an hour, and the two numbers are answers to
   * two different questions: a notification is cheap and dismissable, so it
   * fires as soon as "it is thinking" becomes doubtful; an inbox row is a list
   * of things a person still owes an answer to, and at ten minutes the honest
   * answer is usually "wait". `test/attention-model.test.ts` pins the
   * ordering (the inbox row must be the slower of the two) so the split cannot
   * silently invert. What was missing was neither number but the third clock:
   * see `STALL_ESCALATE_MS`.
   */
  stallSilentMs: 10 * MINUTE,
  /** This many consecutive assistant turns with no tool call in any of them. */
  stallSpinTurns: 6,
  /** This many consecutive attempts that committed nothing and left a clean tree. */
  stallStalemateAttempts: 3,
  /**
   * This many API retries in a row with nothing productive between them.
   *
   * Five, because the CLI's watchdog retries roughly every thirty seconds: a
   * blip it absorbs is one or two and then the work resumes, so five is about
   * two and a half minutes of nothing but retries — long enough that "it will
   * clear by itself" has stopped being the likely explanation, short enough
   * that the run's on-limit policy still has most of the window to act in.
   * Deliberately NOT the same number as the runner's own action debounce
   * (`LIMIT_RETRY_BURST`, three inside two minutes): noticing is cheap and
   * dismissable, and killing a live child to move it is not.
   */
  stallRetryBurst: 5,
  /**
   * How long a Bash call matching `EXTERNAL_WAIT` may stay open before the
   * lane reads as waiting rather than working.
   *
   * Five minutes, and deliberately SHORTER than `stallSilentMs` — the two
   * would otherwise race and `silent` would win, which is the wrong sentence
   * for a lane whose command says exactly what it is waiting on. The evidence
   * here is far stronger than silence: the vocabulary has already established
   * that this command cannot finish on the session's own clock, so the only
   * question is whether it is a short wait or a squat. Five minutes is longer
   * than any CI job's queue-to-first-log and short enough that the measured
   * 35-minute squat is caught at minute five.
   */
  stallExternalWaitMs: 5 * MINUTE,
});

/**
 * How long a stall may go on before it is said again, once, and urgently.
 *
 * Deliberately NOT a member of `STALL_DEFAULTS`, which is exactly the detector
 * thresholds — one per `STALL_SIGNAL`, and pinned as a bijection by
 * `attention-model.test.ts` and by `stallThresholds()`. This is not a
 * detector threshold: nothing about it changes what a stall IS. It is the
 * clock on the announcement, and it belongs beside the others rather than
 * inside them.
 *
 * Why it exists: of the 26 stall cards this console has ever issued, every
 * single one was `urgent: false` and none was ever re-said. That policy is
 * right for minute ten — nothing is blocked on the operator, the run has not
 * stopped, and a card that buzzed a wrist for it would be muted inside a week,
 * taking the signal with it. It is wrong for minute seventy, which is what
 * actually happened: a lane hung for 70 minutes and the whole cost of that
 * was one quiet buzz an hour earlier. Forty-five minutes is past every benign
 * explanation the quiet one covers (a long build, a big Read, an API retry
 * burst) and comfortably inside the hour where a hung lane is still only
 * expensive rather than a wasted evening.
 *
 * ONE re-announcement, never a loop: the vocabulary of "we do not buzz for
 * every stall" survives intact, and a second alarm about a stall that already
 * alarmed is a channel being muted.
 *
 * Overridable per console as the `stallEscalateMs` preference (Settings ▸
 * Automation), like the detector thresholds.
 */
export const STALL_ESCALATE_MS = 45 * MINUTE;

/**
 * How long a wait on the session's OWN background job may stay open before the
 * `external-wait` park applies to it too — 45 minutes.
 *
 * Beside `STALL_DEFAULTS` and deliberately NOT in it, for the reason
 * `STALL_ESCALATE_MS` is not: that object is exactly the detector thresholds,
 * ONE per `STALL_SIGNAL`, pinned as a bijection by `attention-model.test.ts`
 * and by `stallThresholds()`. This is a SECOND clock on one signal — nothing
 * about it changes what `external-wait` IS, only what happens to a lane that
 * is in one.
 *
 * Nine times `stallExternalWaitMs`, and the gap is the point. Both clocks
 * measure a Bash call that is not going to return soon; they differ in who can
 * end it. Somebody else's CI run ends when it ends, and a session holding an
 * exclusive lock to watch it is pure loss — five minutes is already generous.
 * A suite the session itself started ends when the machine finishes it, and
 * the session is the only thing that will read the result: parking that is not
 * releasing a lock, it is throwing away 40 minutes of work and doing it again
 * (measured: 26 park→resume cycles, median 70 min). The number is a long local
 * suite plus room, not a measurement of patience.
 *
 * Overridable per console as the `stallLocalJobMs` preference (Settings ▸
 * Automation), like the detector thresholds.
 */
export const STALL_LOCAL_JOB_MS = 45 * MINUTE;

/**
 * How long after an auto-nudge a still-silent lane is recycled.
 *
 * The second clock of the silent-session watchdog, and — like
 * `STALL_ESCALATE_MS` — deliberately NOT a member of `STALL_DEFAULTS`, which is
 * exactly the detector thresholds, one per `STALL_SIGNAL`, pinned as a
 * bijection by `attention-model.test.ts` and by `stallThresholds()`. Nothing
 * about this number changes what a stall IS; it is the clock on the remedy.
 *
 * Five minutes, because the nudge is one line written to a live session's
 * stdin. A session that is thinking answers it inside a turn; a session wedged
 * before its first tool call never reads it at all, and five minutes is far
 * past the CLI's own retry cadence (~30 s) and its startup. Longer would mean
 * paying for a wedged session for a quarter of an hour before anything acts;
 * shorter would recycle sessions that were about to speak.
 */
export const STALL_NUDGE_GRACE_MS = 5 * MINUTE;

/**
 * How long a freshly spawned session may produce NO stream event at all —
 * `spawn.ts`'s own backstop, independent of every runner-level remedy.
 *
 * The runner's watchdog needs a lane, a liveness ticker and a console that is
 * still driving. This one needs only the child: it is armed from `startedAt`
 * the moment the process exists and it fires only when **zero** events have
 * ever arrived, which is the one shape `armIdle` by construction cannot see
 * (it refuses to arm until `phaseTurnDone`, and a session hung before its first
 * result never sets it). Measured: 7 of 8 boarding gaps over fifteen minutes
 * had no timer of any kind behind them.
 *
 * The silent threshold plus TWO nudge graces, so it is by construction the LAST
 * of the three clocks and strictly later than the recycle rather than level
 * with it: the runner's nudge at ten minutes, its recycle at fifteen, and only
 * a lane with no runner behind it — no lane, no liveness ticker, no console
 * driving — ever reaches this at twenty. One grace would have made the second
 * and third clocks race, and a backstop that wins that race takes the remedy
 * away from the only layer that can keep the session.
 */
export const SPAWN_FIRST_EVENT_MS = STALL_DEFAULTS.stallSilentMs + 2 * STALL_NUDGE_GRACE_MS;

/**
 * How long a session may be silent between its `init` and its first `result`
 * — `spawn.ts`'s second bound of its own, over the stretch where a phase's
 * work actually happens (the sep-review audit's SES-10).
 *
 * The backstop above is cleared by the `init` every session emits in its first
 * second, and the idle close waits for a `result`, so a session that
 * initialised and then wedged had nothing inside `spawn.ts` bounding it — only
 * the runner's nudge-then-recycle, which needs a lane, a liveness ticker and a
 * console still driving, the very things absent when a session outlives its
 * supervisor.
 *
 * The local-job clock plus TWO nudge graces, for the reason the backstop is
 * the silent threshold plus two: by construction it is the last clock on a
 * session that is quiet between tool results. A long local suite the runner
 * parks at `STALL_LOCAL_JOB_MS` never reaches it; only a session with no runner
 * behind it does, and one that initialised and wedged stops holding its lock
 * inside the hour.
 */
export const SPAWN_INIT_IDLE_MS = STALL_LOCAL_JOB_MS + 2 * STALL_NUDGE_GRACE_MS;

/**
 * How long a retry storm is parked when the CLI reported no reset window.
 *
 * `overloaded` (529) is CAPACITY, not quota: there is no usage window to be
 * told about, another account does not help, and the only honest answer is
 * "later". Ten minutes is chosen against the two failure directions — shorter
 * and the resume is a spin that re-enters the same storm, much longer and a
 * capacity blip that cleared in ninety seconds costs an afternoon. A quota wall
 * never uses this: it parks on `state.limits.resetsAt`, the meter's own clock.
 */
export const RETRY_STORM_PARK_MS = 10 * MINUTE;

/* ------------------------------------------------------------------ *
 * Rulings — a decision worth remembering
 * ------------------------------------------------------------------ */

/**
 * @typedef {'ambiguity'|'deviation'|'deferral'} RulingKind
 */

/**
 * What kind of decision a session is recording.
 *
 * A ruling is NOT an outcome and never becomes one: the outcome protocol
 * (`scripts/phase-outcome.sh <slug> <N> <status>`) says how a session ENDED
 * and the runner acts on it; a ruling says what a session DECIDED along the
 * way and nothing acts on it at all. That is the whole point — a decision the
 * plan did not make for you is the thing the next session most needs and the
 * thing a handoff most often omits, because at the time it felt obvious.
 *
 * Three kinds, because the three need different things from a reader:
 *
 *   - `ambiguity` — the plan admitted two readings and the session picked one.
 *     The reader needs to know a choice was made at all;
 *   - `deviation` — the plan said one thing and the session did another, with
 *     a reason. The reader needs to know the plan and the tree disagree;
 *   - `deferral`  — something in scope was deliberately left. The reader needs
 *     it on a list, not in prose.
 *
 * `ambiguity` is the default when a session names no kind: it is the weakest
 * claim of the three, and guessing `deviation` for a session that simply chose
 * between two readings would put a disagreement in the record that never
 * happened.
 *
 * @type {readonly RulingKind[]}
 */
export const RULING_KINDS = Object.freeze(/** @type {const} */ (['ambiguity', 'deviation', 'deferral']));

/** @type {Readonly<Record<RulingKind, string>>} */
export const RULING_KIND_LABELS = Object.freeze({
  ambiguity: 'Ambiguity',
  deviation: 'Deviation',
  deferral: 'Deferral',
});

/* ------------------------------------------------------------------ *
 * ONE DERIVATION — which rows a situation actually raises
 * ------------------------------------------------------------------ */

/**
 * The `waiting.kind`s that mean a session is STOPPED at a prompt.
 *
 * The CLI's `Notification` hook fires for more than a prompt, and until this
 * list existed every one of them became a "session waiting on you" row and an
 * urgent push — including the ones that are the CLI talking to itself. A row
 * that fires for everything is a row that gets ignored, and the one it gets
 * ignored for is the permission card holding a lane dead.
 *
 * `elicitation` is here and `input` is not: an elicitation dialog is a question
 * with no default, so nothing proceeds until it is answered, while an idle
 * prompt is a session that has finished its turn and is simply waiting — which
 * is what a terminal looks like when it is fine.
 *
 * @type {readonly string[]}
 */
export const SESSION_ASK_WAIT_KINDS = Object.freeze(/** @type {const} */ (['permission', 'elicitation']));

/**
 * @typedef {object} AttentionFacts
 * @property {string} [situation]  The classifier's key — `id` or `id:sub`.
 * @property {boolean} [errand]    An errand is stored against this phase.
 * @property {string} [board]      The engine's bucket for the phase.
 * @property {{kind?: string, clear?: boolean, delegated?: boolean, approved?: boolean}} [gate]
 * @property {{signal?: string}} [record]  The phase record's own stall signal.
 * @property {{waiting?: {kind?: string}|null, presence?: string, kind?: string}} [session]
 * @property {{live?: boolean}} [run]
 */

/**
 * @typedef {object} InboxDraft
 * @property {InboxKind} kind
 * @property {InboxSeverity} severity
 * @property {string} subject
 * @property {string} [situation]  The key this row was derived FROM.
 * @property {boolean} [recheck]   Offer the "I did it — look again" action.
 */

/**
 * WHICH ROWS EXIST, decided once.
 *
 * Every caller used to answer this for itself out of whatever it happened to
 * hold — `run.halt.kind` here, `plan.issues` there, `record.status` on the
 * chips — and the three disagreed in front of the operator. This is the answer;
 * `server/inbox.ts` renders it (titles, hrefs, actions) and decides nothing.
 *
 * Four rules, each one a measured defect:
 *
 *   1. **A gate row only for a gate a PERSON must clear.** `ai`, delegated and
 *      already-approved gates all raise nothing — a session clears the first
 *      two itself and the third is done. And only while the board would call
 *      the phase ready: a gate on a phase still waiting on its dependencies is
 *      asking for an act that changes nothing today.
 *   2. **A declared park raises its errand and NEVER a health row.** The
 *      classifier's most common wrong answer was `plan-broken:stale-handoff`
 *      over a session that had honestly declared a wait — 92 times. Only
 *      `plan-broken` may raise `health`, and the fact map is what says so.
 *   3. **The errand is offered on a live run too**, with the recheck action.
 *      The loop used to visit stopped runs alone, so a pointer to a QA hold sat
 *      invisible for sixteen hours while its run drove on around it.
 *   4. **A `session-ask` only for a real prompt** — see
 *      `SESSION_ASK_WAIT_KINDS`.
 *
 * @param {AttentionFacts} [facts]
 * @returns {InboxDraft[]}
 */
export function deriveAttention(facts = {}) {
  /** @type {InboxDraft[]} */
  const out = [];
  const key = String(facts.situation ?? '');
  const mapped = key ? factsFor(...splitSituation(key)) : null;

  const gate = facts.gate;
  if (
    gate &&
    facts.board === 'ready' &&
    gate.kind === 'human' &&
    gate.clear === false &&
    !gate.delegated &&
    !gate.approved
  ) {
    out.push({ kind: 'gate', severity: 'needs-you', subject: 'gated-manual', situation: 'gated-manual' });
  }

  if (facts.errand && mapped?.inboxKind && mapped.inboxKind !== 'gate') {
    out.push({
      kind: /** @type {InboxKind} */ (mapped.inboxKind),
      severity: 'needs-you',
      subject: key,
      situation: key,
      // Rule 3: offered whether or not the run is live. A live run cannot be
      // recovered or dismissed, but "I did what it asked — look again" is
      // exactly what a person does about an errand, and it is the only verb
      // that is true in both states.
      recheck: true,
    });
  }

  const signal = facts.record?.signal;
  if (signal) {
    const stallKind = STALL_SIGNAL_KIND[signal];
    if (stallKind) out.push({ kind: 'stall', severity: 'needs-you', subject: stallKind });
  }

  const waiting = facts.session?.waiting;
  if (waiting && SESSION_ASK_WAIT_KINDS.includes(String(waiting.kind ?? ''))) {
    out.push({
      kind: 'session-ask',
      // A permission prompt is a session parked dead and costing; an
      // elicitation is a question with no default. Both stop the session, and
      // the first is the one that stops it mid-spend.
      severity: waiting.kind === 'permission' ? 'urgent' : 'needs-you',
      subject: 'session-ask',
    });
  }

  return out;
}

/**
 * May a situation raise a row of this kind at all?
 *
 * The negative half of `deriveAttention`, exported because two producers need
 * to ask it about a fact they already hold rather than rebuild the whole input:
 * `health` rows guard on `plan-broken`, `qa` rows on the two QA situations.
 *
 * @param {InboxKind} kind
 * @param {string|null|undefined} situation  The classifier's key, `id` or `id:sub`.
 * @returns {boolean}
 */
export function situationRaises(kind, situation) {
  const key = String(situation ?? '');
  if (!key) return false;
  return factsFor(...splitSituation(key)).inboxKind === kind;
}
