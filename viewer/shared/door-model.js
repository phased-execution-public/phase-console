/**
 * The owner door — the presses a supervised session never makes of its own
 * console. ONE table (control-tower phase 129, #218; §Architecture 19).
 *
 * A session runs as the operator's own OS user, so it reaches every route a
 * person's browser reaches: the write guard is a capability flag, the console's
 * header and a same-origin test (`api/routes.ts` `guardMutation`), and `by` is
 * the request body's own label. #218 read what one `curl` could do with that —
 * answer its own approval card, strike a deny rule, raise its run to `bypass`,
 * approve a manual gate, prove a person's step — and `gate-forge` walled only
 * the gate file. This table names those presses, and it is read by:
 *
 *   - the hook guard `console-forge` (`server/runner/approvals.ts`
 *     `consoleForgeCall`, enforced in `Service.decideToolUse` after
 *     `gate-forge`): a supervised session's call that would press a row — an
 *     HTTP client against a console's loopback address, the row's CLI twin, or
 *     a wrapper whose text carries a console address and the row's path — is
 *     denied before it runs, on every profile;
 *   - `test/console-forge.test.ts`, which holds every row to a route the router
 *     serves and every CLI form to a verb the CLI dispatches — and, since
 *     phase 131, every route that presses an authority method to a row;
 *   - the server's own door check (`api/routes.ts`, control-tower phase 131,
 *     #208): a request that PROVES it is a session's or the supervisor's never
 *     presses a row beyond what the plan's manifest already allows.
 *
 * Phase 131 adds the door each request came through (`PRESS_DOORS`, decided by
 * what the request can prove — `server/owner/door.ts`), the authority words
 * (`AUTHORITY_VERBS`), and the door × verb × risk table (`DOOR_MAY`, read
 * through `doorMay`) in each of its modes (`OWNER_DOOR_MODES`). Phase 148 adds the
 * owner key that makes the second mode real.
 *
 * A row:
 *
 *   - `verb` — the press, as `phase.tool-denied {rule: 'console-forge', verb}`
 *     journals it (one of `AUTHORITY_PRESSES`).
 *   - `authority` — the `AUTHORITY_VERBS` word the press is.
 *   - `method` — the HTTP method that presses it.
 *   - `path` — the route under the console's origin; `:name` is one segment. A
 *     request path is the row's when it STARTS with the row's segments, read
 *     the way the router reads them (`authorityRouteOf`).
 *   - `cli` — the `phase-console` verbs that press the same route, as
 *     `<group> <verb>` (`run approve`); none for a route the CLI does not press.
 *   - `declare` — what a session declares instead: the outcome and its
 *     `--needs` key.
 *   - `summary` — what the press does, in a person's words.
 *
 * ⚠️ Data only, like every `shared/` vocabulary: the client may bundle it and
 * `node --test` imports it directly. Free-safe — a Pro row is a `!pro:` region,
 * like verb-model.js's `message`.
 */

import { RISK_TIERS } from './turn-model.js';

/* ------------------------------------------------------------------ *
 * The doors, and the authority words (control-tower phase 131, #208)
 * ------------------------------------------------------------------ */

/**
 * The door a press came through — decided by what the request can PROVE,
 * never by what its body says (`server/owner/door.ts` `doorOfRequest`):
 *
 *   - `owner` — an owner key verified in this browser (phase 148);
 *   - `device` — a paired device the fleet supervisor verified, a person the
 *     `--remote` proxy vouched for, or a signed lock-screen action;
 *   - `local` — a loopback request with the console header and nothing more:
 *     a script, the CLI, an unenrolled browser, any process;
 *   - `session` — a run or message token;
 *   - `supervisor` — the supervisor's pass, and the chat's bearer;
 *   - `checker` — a checking session, for its own item (phase 134);
 *   - `console` — the console's own clocks: probes, withdrawals, timers.
 */
export const PRESS_DOORS = Object.freeze(
  /** @type {const} */ (['owner', 'device', 'local', 'session', 'supervisor', 'checker', 'console']),
);

/** @typedef {(typeof PRESS_DOORS)[number]} PressDoor */

/**
 * The presses that carry the owner's authority (§Architecture 19): a grant, an
 * answer, a decline, a person's word for a proof (`attest`), *Accept anyway*
 * (`override`), a wider policy, a higher permission profile, a gate, a
 * presented plan, a capability flag, the owner keys themselves, and trust
 * handed to an agent.
 */
export const AUTHORITY_VERBS = Object.freeze(
  /** @type {const} */ ([
    'grant',
    'answer',
    'decline',
    'attest',
    'override',
    'policy-widen',
    'profile-raise',
    'gate-approve',
    'plan-approve',
    'capability',
    'owner-key',
    'trust',
  ]),
);

/** @typedef {(typeof AUTHORITY_VERBS)[number]} AuthorityVerb */

/**
 * The table's modes. `unenrolled` — every console until phase 148, and any
 * whose person enrols no owner key — is today's console: `local` presses what
 * it could before, and `/api/state` says so (`ownerDoor`). `enrolled` is the
 * design's table as written: a press through a door that may not make it is a
 * REQUEST the owner confirms (phase 148), never applied and never dropped.
 */
export const OWNER_DOOR_MODES = Object.freeze(/** @type {const} */ (['unenrolled', 'enrolled']));

/** @typedef {(typeof OWNER_DOOR_MODES)[number]} OwnerDoorMode */

/**
 * What a console says about its owner door (`/api/state.ownerDoor`, `GET
 * /api/owner`): no key; a key, and this browser not signed in as the owner; a
 * key, and this browser inside an owner session (control-tower phase 148).
 */
export const OWNER_DOOR_STATES = Object.freeze(/** @type {const} */ (['unenrolled', 'enrolled', 'unlocked']));

/** @typedef {(typeof OWNER_DOOR_STATES)[number]} OwnerDoorState */

/** What a door may do with a press: make it, ask the owner for it, or nothing. */
export const DOOR_VERDICTS = Object.freeze(/** @type {const} */ (['press', 'request', 'refuse']));

/** @typedef {(typeof DOOR_VERDICTS)[number]} DoorVerdict */

/** The highest a press may be: `never` is no door's (§Architecture 19). */
const TOP_TIER = RISK_TIERS[RISK_TIERS.length - 2];
/** A grant a paired device may make: low and medium, at `call` or `phase` (`riskOf` prices the scope). */
const DEVICE_TIER = RISK_TIERS[1];

/* ------------------------------------------------------------------ *
 * The owner key's clocks (control-tower phase 148, #208)
 * ------------------------------------------------------------------ */

/** An owner session ends after twelve hours with no press (§Architecture 19). */
export const OWNER_SESSION_IDLE_MS = 12 * 60 * 60_000;
/** A HIGH-risk press needs a touch of the key inside the last five minutes. */
export const OWNER_FRESH_MS = 5 * 60_000;
/** A WebAuthn challenge is good once, for five minutes. */
export const OWNER_CHALLENGE_MS = 5 * 60_000;
/** `phase-console owner enroll`'s one-time link is good for ten minutes. */
export const OWNER_LINK_MS = 10 * 60_000;

/**
 * The tier an authority press carries on its own — what the door table is read
 * at for a press through an existing route. A grant prices itself by its wall,
 * its rule and its scope (`riskOf`, phase 149); everything else is priced here:
 * a raise of a run's permission profile moves every ask at once, a capability
 * flag widens the machine, the owner keys are the owner door itself, and trust
 * hands a person's authority to an agent — those four are HIGH, and through the
 * `owner` door each needs a touch of the key inside `OWNER_FRESH_MS`.
 * @type {Readonly<Record<AuthorityVerb, string>>}
 */
export const PRESS_RISK = Object.freeze({
  grant: RISK_TIERS[1],
  answer: RISK_TIERS[1],
  decline: RISK_TIERS[0],
  attest: RISK_TIERS[1],
  override: RISK_TIERS[1],
  'policy-widen': RISK_TIERS[1],
  'profile-raise': TOP_TIER,
  'gate-approve': RISK_TIERS[1],
  'plan-approve': RISK_TIERS[1],
  capability: TOP_TIER,
  'owner-key': TOP_TIER,
  trust: TOP_TIER,
});

/**
 * The tier of one authority press — `PRESS_RISK`'s, and the safe side, high,
 * for a word it does not know.
 * @param {string} authority
 * @returns {string}
 */
export function pressRiskOf(authority) {
  return /** @type {Record<string, string>} */ (PRESS_RISK)[authority] ?? TOP_TIER;
}

/**
 * The door × authority verb table: the highest risk tier each door may press
 * each verb at on its OWN authority. A verb a door's row does not name is not
 * its to press — what the plan's manifest already allows aside, which any door
 * but `checker` and `console` carries out (`doorMay`'s `manifest`).
 *
 *   - `owner` — everything grantable.
 *   - `device` — low and medium grants; answers (a card, a gate, a presented
 *     plan); declines.
 *   - `local` — declines (*Deny*, *I can't*); everything else it may ask for —
 *     the reads, open, snooze, *I've done this* and attach are not authority
 *     verbs at all, so the table never sees them.
 *   - `session`, `supervisor` — nothing on their own: a session raises,
 *     declares and records; the supervisor reads, raises and orders a re-check.
 *   - `checker` — the verdict of its own item, which is written in-process and
 *     is no route's press (phase 134).
 *   - `console` — probes, clocks and withdrawals, none of them a person's.
 *
 * @type {Readonly<Record<PressDoor, Readonly<Partial<Record<AuthorityVerb, string>>>>>}
 */
export const DOOR_MAY = Object.freeze({
  owner: Object.freeze(Object.fromEntries(AUTHORITY_VERBS.map((verb) => [verb, TOP_TIER]))),
  device: Object.freeze({
    grant: DEVICE_TIER,
    answer: DEVICE_TIER,
    decline: TOP_TIER,
    'gate-approve': DEVICE_TIER,
    'plan-approve': DEVICE_TIER,
  }),
  local: Object.freeze({ decline: TOP_TIER }),
  session: Object.freeze({}),
  supervisor: Object.freeze({}),
  checker: Object.freeze({}),
  console: Object.freeze({}),
});

/** The doors that carry out what the plan's manifest already allows — every door but the console's own and a checker. */
const MANIFEST_DOORS = new Set(['owner', 'device', 'local', 'session', 'supervisor']);

/**
 * The verbs no manifest carries out (control-tower phase 134, #211): an
 * `override` writes a verdict — the owner's *Accept anyway* — and no agent
 * marks an item passed, whatever a plan's `permission.destructive` row says;
 * and the owner keys are the owner door itself (phase 148), which no plan
 * hands to anybody; and a `grant` is a person's decision by definition
 * (phase 149) — a plan's own answer is its manifest row, which the hook
 * already carries out, never a session granting itself through the item.
 */
const NEVER_BY_MANIFEST = new Set(['override', 'owner-key', 'grant']);

/** The doors a request PROVES is not a person's: a session's tokens, the supervisor's bearer. */
export const AGENT_DOORS = Object.freeze(/** @type {const} */ (['session', 'supervisor']));

/**
 * What `door` may do with `verb` at `risk`, in `mode` — `press`, `request` or
 * `refuse`. Read in this order:
 *
 *   1. a word the table does not know, and a `never` press, are refused;
 *   2. what the plan's manifest already allows (`manifest: true`) is carried
 *      out through any door but the console's own and a checker — that is
 *      carrying out a decision, not making one — except an `override`, which
 *      writes a verdict and is never a manifest's (phase 134);
 *   3. a press inside the door's own row is made;
 *   4. on an UNENROLLED console `local` and `device` press what they could
 *      before — the owner door changes nothing for a person until a key exists;
 *   5. on an enrolled one every door a request can come through — `device`,
 *      `local`, `session` and `supervisor` — may only REQUEST (phase 148): the
 *      press is recorded for the owner to confirm, never applied and never
 *      dropped; a checker and the console are refused.
 *
 * @param {string} door
 * @param {string} verb
 * @param {{ risk?: string, mode?: string, manifest?: boolean }} [opts]
 * @returns {DoorVerdict}
 */
export function doorMay(
  door,
  verb,
  { risk = DEVICE_TIER, mode = OWNER_DOOR_MODES[0], manifest = false } = {},
) {
  const row = /** @type {Record<string, Partial<Record<string, string>>>} */ (DOOR_MAY)[door];
  if (!row || !(/** @type {readonly string[]} */ (AUTHORITY_VERBS).includes(verb))) return 'refuse';
  const rank = RISK_TIERS.indexOf(/** @type {never} */ (risk));
  if (rank < 0 || rank > RISK_TIERS.indexOf(/** @type {never} */ (TOP_TIER))) return 'refuse';
  if (manifest && MANIFEST_DOORS.has(door) && !NEVER_BY_MANIFEST.has(verb)) return 'press';
  const ceiling = row[verb];
  if (ceiling !== undefined && rank <= RISK_TIERS.indexOf(/** @type {never} */ (ceiling))) return 'press';
  if (mode === OWNER_DOOR_MODES[0]) return door === 'local' || door === 'device' ? 'press' : 'refuse';
  return MANIFEST_DOORS.has(door) ? 'request' : 'refuse';
}

/**
 * Is a press through this door a PERSON's — the manual gate's test (#174, now a
 * door rather than a User-Agent), and a chat act's confirmation? `owner` and
 * `device` always; `local` only on a console with no owner key, where a
 * person's browser cannot be told from a script and the gate card says so.
 * @param {string | null | undefined} door
 * @param {string} [mode]
 */
export function isPersonDoor(door, mode = OWNER_DOOR_MODES[0]) {
  return door === 'owner' || door === 'device' || (door === 'local' && mode === OWNER_DOOR_MODES[0]);
}

/* ------------------------------------------------------------------ *
 * The authority routes (control-tower phase 129, #218; held both ways by 131)
 * ------------------------------------------------------------------ */

/**
 * `self` marks a route that decides its own door — the owner key's routes,
 * which MAKE the owner door (enrol, sign in), end it (lock) or act as it
 * (remove a key, answer a request): the router refuses an agent's door on them
 * and records no request, and the route holds its own rule (phase 148).
 * @typedef {{
 *   verb: string, authority: AuthorityVerb, method: string, path: string, cli: readonly string[],
 *   declare: { status: 'blocked' | 'needs-human', needs: string },
 *   summary: string,
 *   self: boolean,
 * }} AuthorityRoute
 */

/** What a session declares when it needs a person's permission. */
const PERMISSION = Object.freeze({ status: /** @type {const} */ ('blocked'), needs: 'permission' });
/** …a person's gate. */
const GATES = Object.freeze({ status: /** @type {const} */ ('needs-human'), needs: 'gates' });
/** …a person's act. */
const HUMAN = Object.freeze({ status: /** @type {const} */ ('needs-human'), needs: 'human-acts' });
/** …a person's answer to its own question. */
const AMBIGUITY = Object.freeze({ status: /** @type {const} */ ('blocked'), needs: 'ambiguity' });

/**
 * @param {string} verb
 * @param {string} route `METHOD /path`
 * @param {{ authority: AuthorityVerb, cli?: string[], declare: AuthorityRoute['declare'], summary: string, self?: boolean }} rest
 * @returns {Readonly<AuthorityRoute>}
 */
function press(verb, route, { authority, cli = [], declare, summary, self = false }) {
  const [method = '', path = ''] = route.split(' ');
  return Object.freeze({ verb, authority, method, path, cli: Object.freeze(cli), declare, summary, self });
}

/**
 * Every press that carries the owner's authority — the routes the hook guard
 * fences and the server's door check holds.
 * @type {readonly Readonly<AuthorityRoute>[]}
 */
export const AUTHORITY_ROUTES = Object.freeze([
  press('answer-card', 'POST /api/approvals/:id', {
    authority: 'answer',
    cli: ['run approve', 'run deny'],
    declare: PERMISSION,
    summary: 'answer a permission card — allow it, deny it, or remember the answer as a rule',
  }),
  press('edit-policy', 'POST /api/policy', {
    authority: 'policy-widen',
    declare: PERMISSION,
    summary: 'edit the permission policy — add a rule, or strike a shipped one',
  }),
  press('edit-prefs', 'POST /api/prefs', {
    authority: 'policy-widen',
    declare: PERMISSION,
    summary: "change the console's preferences — its standing policy answers and relay rules among them",
  }),
  press('run-settings', 'POST /api/run/:slug/settings', {
    authority: 'profile-raise',
    declare: PERMISSION,
    summary: "change a run's settings — its permission profile, carve-out and auto-grant among them",
  }),
  press('answer-question', 'POST /api/run/:slug/answer', {
    authority: 'answer',
    declare: AMBIGUITY,
    summary: "answer a session's held question in a person's place",
  }),
  press('approve-plan', 'POST /api/run/:slug/plan-approval', {
    authority: 'plan-approve',
    declare: HUMAN,
    summary: 'approve or reject the plan a plan-mode phase presented',
  }),
  press('delegate-step', 'POST /api/run/:slug/delegate', {
    authority: 'trust',
    declare: HUMAN,
    summary: "hand a person's act to the session that asked for it",
  }),
  press('remember-ruling', 'POST /api/run/:slug/rulings/:id/remember', {
    authority: 'policy-widen',
    declare: PERMISSION,
    summary: 'make a ruling a standing answer — a session asks with `phase-outcome.sh … ruling --remember`',
  }),
  press('approve-gate', 'POST /api/plans/:slug/gate/:phase', {
    authority: 'gate-approve',
    declare: GATES,
    summary: "approve or revoke a phase's gate",
  }),
  press('console-write', 'POST /api/write', {
    authority: 'gate-approve',
    declare: GATES,
    summary: "write through the console's own door — a gate approval among its actions",
  }),
  press('check-step', 'POST /api/human-steps/:id/check', {
    authority: 'attest',
    declare: HUMAN,
    summary: "mark a person's step done — by a person's word when it has no proof",
  }),
  press('dismiss-step', 'POST /api/human-steps/:id/dismiss', {
    authority: 'decline',
    declare: HUMAN,
    summary: "withdraw a person's step",
  }),
  // The owner's moves (control-tower phase 133, #210): an answer and a decline
  // are the owner's to give, so the hook's forge guard fences them from the
  // day they exist. `ask` and `evidence` are not authority — a route-level
  // check keeps an agent's door off them instead.
  press('answer-step', 'POST /api/human-steps/:id/answer', {
    authority: 'answer',
    declare: HUMAN,
    summary: "answer a person's decision — one of its options, a note, or both",
  }),
  press('decline-step', 'POST /api/human-steps/:id/decline', {
    authority: 'decline',
    declare: HUMAN,
    summary: "decline a person's item with a reason, where the item allows it",
  }),
  // A permission item's two answers besides its Grant (control-tower phase
  // 135, #212): *Deny* tells the session to find another way, and *I'll do it
  // myself* turns the item into the person's own act — both a person's, so the
  // forge guard fences them from a session the day they are born.
  press('deny-step', 'POST /api/human-steps/:id/deny', {
    authority: 'decline',
    declare: HUMAN,
    summary: 'deny a permission item — the session finds another way',
  }),
  press('convert-step', 'POST /api/human-steps/:id/convert', {
    authority: 'decline',
    declare: HUMAN,
    summary: "turn a permission item into the person's own act",
  }),
  // The scoped grant (control-tower phase 149, #212): a permission item's
  // Grant — priced by its own cell (`riskOf`), never through a never cell, a
  // capability only at the machine — and the two revokes, which take authority
  // away and so are declines any person's door may press. All three fenced
  // from a session the day they are born.
  press('grant-step', 'POST /api/human-steps/:id/grant', {
    authority: 'grant',
    declare: PERMISSION,
    summary: 'grant a permission item — this call, this phase, this plan, this repository or always',
  }),
  press('revoke-grant', 'POST /api/permissions/grants/:id/revoke', {
    authority: 'decline',
    cli: ['grants revoke'],
    declare: PERMISSION,
    summary: 'revoke a grant — undo exactly what it changed',
  }),
  press('revoke-all-grants', 'POST /api/permissions/grants/revoke-all', {
    authority: 'decline',
    cli: ['grants revoke-all'],
    declare: PERMISSION,
    summary: 'revoke every live grant',
  }),
  // The ONE route that writes a verdict (control-tower phase 134, #211): the
  // owner's *Accept anyway*. A probe and the checker write theirs in-process;
  // `check` only asks for one.
  press('override-step', 'POST /api/human-steps/:id/override', {
    authority: 'override',
    declare: HUMAN,
    summary: "accept a person's item anyway — the owner's verdict, recorded as unverified",
  }),
  press('rewrite-step', 'POST /api/human-steps/:id/rewrite', {
    authority: 'decline',
    declare: HUMAN,
    summary: 'withdraw an escalated item and ask the session that raised it for a new version',
  }),
  // A signed lock-screen action proves its own door inside its route — the
  // token the console signed for a subscribed device stamps `device` (phase
  // 131) — so the router refuses only an agent's door on it (phase 148).
  press('push-action', 'POST /api/push/action', {
    authority: 'answer',
    declare: PERMISSION,
    self: true,
    summary: "press a notification's button — allow, deny, approve or check from a lock screen",
  }),
  // The owner key (control-tower phase 148, #208): the routes that make the
  // owner door, prove it, end it and act as it. Each decides its own door
  // (`self`), and the hook guard fences all five from a session — a session
  // that could enrol a key of its own would be the owner.
  press('owner-enrol', 'POST /api/owner/enroll', {
    authority: 'owner-key',
    cli: ['owner enroll'],
    declare: HUMAN,
    self: true,
    summary: "enrol an owner key — a passkey that proves a press is the owner's",
  }),
  press('owner-assert', 'POST /api/owner/assert', {
    authority: 'owner-key',
    declare: HUMAN,
    self: true,
    summary: 'sign in with an owner key — an owner session, or a fresh touch for a high-risk press',
  }),
  press('owner-lock', 'POST /api/owner/lock', {
    authority: 'owner-key',
    cli: ['owner lock'],
    declare: HUMAN,
    self: true,
    summary: 'end the owner session',
  }),
  press('owner-key-remove', 'DELETE /api/owner/keys/:id', {
    authority: 'owner-key',
    declare: HUMAN,
    self: true,
    summary: 'remove an owner key',
  }),
  press('owner-request', 'POST /api/owner/requests/:id', {
    authority: 'answer',
    declare: HUMAN,
    self: true,
    summary: 'confirm or refuse a press another door asked the owner for',
  }),
]);

/** The presses, by name — the words `phase.tool-denied`'s `verb` takes for a route. */
export const AUTHORITY_PRESSES = Object.freeze(AUTHORITY_ROUTES.map((row) => row.verb));

/**
 * The `verb` a write into the console's own files is journalled under: its
 * state and config directories, which no route fronts (`consoleForgeCall`).
 */
export const CONSOLE_FILES_VERB = 'console-files';

/** A row's path as segments, `:name` kept. */
const SEGMENTS = new Map(AUTHORITY_ROUTES.map((row) => [row, row.path.split('/').filter(Boolean)]));

/** One segment as the router reads it (`decodeURIComponent`), or as written when it does not decode. */
function decoded(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A request path's segments as the router reads them — split on `/`, empties
 * dropped, each percent-decoded — with the fleet supervisor's mount
 * (`/c/<id>/…`) taken off, since the supervisor hands the rest to that console.
 * @param {string} path
 * @returns {string[]}
 */
export function routeSegments(path) {
  const segments = String(path ?? '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)
    .map(decoded);
  return segments[0] === 'c' && segments[2] === 'api' ? segments.slice(2) : segments;
}

/**
 * The row a request presses, or null. `method` null means a method nobody can
 * read (a wrapper's, a `$METHOD`): every row's then. A path is the row's when
 * it starts with the row's segments — the router dispatches on its leading
 * segments and ignores what follows them, so a trailing segment hides nothing.
 * @param {string | null} method
 * @param {string} path
 * @returns {Readonly<AuthorityRoute> | null}
 */
export function authorityRouteOf(method, path) {
  const segments = routeSegments(path);
  const wanted = typeof method === 'string' ? method.toUpperCase() : null;
  return (
    AUTHORITY_ROUTES.find((row) => {
      if (wanted !== null && row.method !== wanted) return false;
      const own = SEGMENTS.get(row) ?? [];
      return (
        segments.length >= own.length &&
        own.every((part, i) => (part.startsWith(':') ? Boolean(segments[i]) : part === segments[i]))
      );
    }) ?? null
  );
}

/**
 * The CLI form an argv presses (`run approve`), read as the CLI reads it, or
 * null. `args` are the words after the program (`phase-console`). `run` takes
 * its global flags out first — `--json`, `--help`/`-h` (help presses nothing)
 * and `--console <name>` — and its first other word is the verb
 * (`bin/run-verb.mjs` `extractGlobalFlags`); `supervisor`'s verb is its first
 * word, and `--replay` anywhere reads (`bin/supervisor-verb.mjs`).
 * @param {readonly string[]} args
 * @returns {string | null}
 */
export function cliFormOf(args) {
  const [group, ...rest] = args;
  if (group === 'run') {
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i];
      if (word === '--help' || word === '-h') return null;
      if (word === '--json') continue;
      if (word === '--console') {
        i += 1;
        continue;
      }
      return `run ${word}`;
    }
    return null;
  }
  if (group === 'supervisor') {
    if (rest.includes('--replay') || rest.includes('--help') || rest.includes('-h') || !rest[0]) return null;
    return `supervisor ${rest[0]}`;
  }
  // `owner status` reads; `owner enroll` and `owner lock` press (phase 148).
  if (group === 'owner') {
    if (rest.includes('--help') || rest.includes('-h') || !rest[0]) return null;
    return `owner ${rest[0]}`;
  }
  // `grants list` reads; `grants revoke` and `grants revoke-all` press (phase 149).
  if (group === 'grants') {
    if (rest.includes('--help') || rest.includes('-h') || !rest[0]) return null;
    return `grants ${rest[0]}`;
  }
  return null;
}

/**
 * The row whose CLI twin an argv presses, or null.
 * @param {readonly string[]} args
 * @returns {Readonly<AuthorityRoute> | null}
 */
export function authorityCliOf(args) {
  const form = cliFormOf(args);
  return form ? (AUTHORITY_ROUTES.find((row) => row.cli.includes(form)) ?? null) : null;
}
