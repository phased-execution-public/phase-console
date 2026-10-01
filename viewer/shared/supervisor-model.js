/**
 * The supervisor's ONE table (control-tower phase 101, #145; §Architecture 8).
 *
 * For two days an outside watchdog read every run of two consoles every
 * fifteen minutes, fixed what had stopped and escalated the rest — nothing in
 * the console did that job. The supervisor does it, and this file is what it
 * does, as data:
 *
 *   - `CHAT_TOOLS` — every tool the supervisor chat (phase 27) will offer: its
 *     name, `read` or `act`, whether it is destructive, the capability flag it
 *     needs (`--allow-run`, …, or `null` for a read) and the operator verb
 *     (`shared/verb-model.js`) it presses when it has one. Phase 27 EXTENDS this
 *     table and builds its tools host from it; nothing else lists the tools.
 *   - `REMEDIES` — one row per SITUATION the detect pass raises: the evidence
 *     that proves it, the remedy in words, the verb it presses (a
 *     `trigger`-pressable row of the verb table, or `null`), its autonomy
 *     CLASS and its hourly cap. The class is the MOST the supervisor may do:
 *     `press` (pressed under `act`), `suggest` (a standing card at most, even
 *     under `act`), `escalate` (an operator-only act: an inbox row and a push
 *     carrying the exact `phase-console run …` command) and `none` (detected,
 *     and the right move is to leave it alone). `defect` marks a situation
 *     that is the console's own bug — it becomes an issue draft on the
 *     console's own repository.
 *   - `SUPERVISOR_POLICIES` — the autonomy words `off · observe · suggest ·
 *     act`, which map onto the chat's `confirm` (act ≈ `never`, suggest ≈
 *     `always`). The shipped default is `suggest`.
 *   - `SUPERVISOR_INVARIANTS` — what the supervisor may never do, each held by
 *     a table test (`test/supervisor-remedy.test.ts`, `test/invariants.test.ts`).
 *
 * ⚠️ Data only, like every `shared/` vocabulary: `node --test` imports it
 * directly and the client may bundle it. Free-safe — it names no Pro module;
 * the pass that reads it lives in `server/pro/supervisor/`.
 */

import { RELAY_MODES } from './run-settings.js';
import { VERB_KINDS, verbNamed } from './verb-model.js';

/* ------------------------------------------------------------------ *
 * Autonomy
 * ------------------------------------------------------------------ */

/**
 * How much the supervisor may do, from nothing to everything a remedy row
 * allows. `off` detects only (the status and the digest still show what it
 * sees); `observe` journals every would-be act and presses nothing (a dry run
 * a person can read); `suggest` raises a standing card per remedy; `act`
 * presses, inside its caps.
 */
export const SUPERVISOR_POLICIES = Object.freeze(/** @type {const} */ (['off', 'observe', 'suggest', 'act']));

/** @typedef {(typeof SUPERVISOR_POLICIES)[number]} SupervisorPolicy */

/** What a console that never chose runs — a card per remedy, nothing pressed (operator decision 11). */
export const SUPERVISOR_SHIPPED_POLICY = 'suggest';

/** The chat's `confirm` word for each policy (§Architecture 8): act ≈ never, suggest ≈ always. */
export const POLICY_CONFIRM = Object.freeze({ off: null, observe: null, suggest: 'always', act: 'never' });

/** Is this word a policy? */
export function isSupervisorPolicy(word) {
  return typeof word === 'string' && /** @type {readonly string[]} */ (SUPERVISOR_POLICIES).includes(word);
}

/** The most a remedy row lets the supervisor do — see the header. */
export const REMEDY_CLASSES = Object.freeze(/** @type {const} */ (['press', 'suggest', 'escalate', 'none']));

/** @typedef {(typeof REMEDY_CLASSES)[number]} RemedyClass */

/**
 * What became of one detection — the decision table, `outcomeFor`. `detected`
 * is the floor: journalled and shown, nothing else.
 */
export const SUPERVISOR_OUTCOMES = Object.freeze(
  /** @type {const} */ (['detected', 'observed', 'suggested', 'escalated', 'acted']),
);

/**
 * The decision table: a policy and a row's class in, what the supervisor does
 * out. `observe` answers `observed` for anything it would have done; a row whose
 * class is `none` is only ever detected.
 * @param {SupervisorPolicy} policy
 * @param {RemedyClass} autonomy
 * @returns {(typeof SUPERVISOR_OUTCOMES)[number]}
 */
export function outcomeFor(policy, autonomy) {
  if (policy === 'off' || autonomy === 'none') return 'detected';
  if (policy === 'observe') return 'observed';
  if (autonomy === 'escalate') return 'escalated';
  if (autonomy === 'suggest' || policy === 'suggest') return 'suggested';
  return 'acted';
}

/* ------------------------------------------------------------------ *
 * The journal
 * ------------------------------------------------------------------ */

/** Every journal line the supervisor writes. `docs/journal-events.md` holds a row for each. */
export const SUPERVISOR_EVENTS = Object.freeze(
  /** @type {const} */ ([
    'supervisor.detected',
    'supervisor.suggested',
    'supervisor.acted',
    'supervisor.escalated',
    'supervisor.policy-changed',
  ]),
);

/* ------------------------------------------------------------------ *
 * What it detects, and what it does about each
 * ------------------------------------------------------------------ */

/**
 * The situations, in the watchdog's catalogue order (#145 A; its NOTES.md is
 * the acceptance corpus) and then the two #145 adds.
 */
export const SUPERVISOR_SITUATIONS = Object.freeze(
  /** @type {const} */ ([
    'hinted-not-queued',
    'ahead-of-dependency',
    'lane-lost-at-start',
    'hot-account',
    'stale-credential',
    'checkout-refused',
    'replay-at-cap',
    'approval-timed-out',
    'quiet-not-stalled',
    'machine-load',
    'streak-near-max',
    'halted-with-ready-work',
  ]),
);

/** @typedef {(typeof SUPERVISOR_SITUATIONS)[number]} SupervisorSituation */

/**
 * The families the Tower's annunciator counts DETECTIONS under (control-tower
 * phase 102, #145 E) — the supervisor's own, drawn beside the halt families
 * rather than inside them: a detection is as often about a run still working
 * (a hot account, a quiet lane, a loaded machine) as about one that stopped,
 * and the halt lamps count stops. Each remedy row names its one category.
 */
export const SUPERVISOR_CATEGORIES = Object.freeze(
  /** @type {const} */ (['queue', 'lanes', 'accounts', 'checkout', 'approvals', 'machine', 'stops']),
);

/** @typedef {(typeof SUPERVISOR_CATEGORIES)[number]} SupervisorCategory */

/**
 * The shipped bounds. A remedy row carries its own hourly cap; these hold the
 * sums: acts on one run per sliding hour, and how long one ROOT CAUSE is
 * remembered as acted on (a second act on the same cause is a suggestion, so a
 * remedy that did not work is never pressed in a loop).
 */
export const SUPERVISOR_CAPS = Object.freeze({
  perRunPerHour: 6,
  rootCauseMs: 6 * 60 * 60_000,
  /** The machine-wide cap the fleet supervisor holds unless it says otherwise. */
  machinePerHour: 30,
});

/** How often the pass runs on its own clock; a run's journal line also wakes it (debounced). */
export const SUPERVISOR_PASS_MS = 60_000;

/**
 * @typedef {{
 *   situation: SupervisorSituation,
 *   evidence: string,
 *   remedy: string,
 *   verb: string|null,
 *   autonomy: RemedyClass,
 *   cap: { perHour: number },
 *   defect: boolean,
 *   category: SupervisorCategory,
 * }} RemedyRow
 */

/**
 * @param {SupervisorSituation} situation
 * @param {Omit<RemedyRow, 'situation'|'defect'> & { defect?: boolean }} rest
 * @returns {Readonly<RemedyRow>}
 */
const remedy = (situation, rest) =>
  Object.freeze({ situation, defect: false, ...rest, cap: Object.freeze({ ...rest.cap }) });

/** One row per situation, in `SUPERVISOR_SITUATIONS` order. */
export const REMEDIES = Object.freeze([
  remedy('hinted-not-queued', {
    category: 'queue',
    evidence:
      'a re-board or resume asked for the phase (`phase.reboard-requested`, a hint) and no `phase.queued`, `phase.admitted` or `phase.start` followed within 3 minutes',
    remedy: 'board it at the next boundary, so the next lane that frees is its own',
    verb: 'board-at-boundary',
    autonomy: 'press',
    cap: { perHour: 4 },
    defect: true,
  }),
  remedy('ahead-of-dependency', {
    category: 'queue',
    evidence:
      'the phase is queued or boarding while a phase it depends on is not done and is queued behind it (the plan graph beside the queue)',
    remedy: 'bump the dependency to the front of its class',
    verb: 'bump',
    autonomy: 'press',
    cap: { perHour: 4 },
    defect: true,
  }),
  remedy('lane-lost-at-start', {
    category: 'lanes',
    evidence:
      'a session ended or its lane was lost within 90 s of `phase.start`, before any tool call or output',
    remedy: 'retry the phase once, with an addendum naming the loss',
    verb: 'retry',
    autonomy: 'press',
    cap: { perHour: 2 },
    defect: true,
  }),
  remedy('hot-account', {
    category: 'accounts',
    evidence:
      'the run spends an account whose 5-hour or weekly meter reads 90 % or more, or is forecast to wall, while another account has room',
    remedy:
      'move the run to the account with the most room at its next boundary — never while a session is live, never onto one at 97 % or more',
    verb: 'switch-account',
    autonomy: 'press',
    cap: { perHour: 1 },
  }),
  remedy('stale-credential', {
    category: 'accounts',
    evidence:
      'the account the run spends has no usage reading for 30 minutes while the run works, or its login was refused, expired or changed identity',
    remedy: 'a re-login is a person’s act: sign the account in again, then read the accounts',
    verb: 'accounts',
    autonomy: 'escalate',
    cap: { perHour: 1 },
  }),
  remedy('checkout-refused', {
    category: 'checkout',
    evidence:
      'the run’s checkout or mirror was refused, quarantined or failed (`phase.isolation-refused`, `phase.worktree-failed`, `run.mount-quarantined`)',
    remedy:
      'prepare the errand tree for the phase; moving foreign content aside is a person’s act — move, never delete',
    verb: 'errand-tree',
    autonomy: 'escalate',
    cap: { perHour: 1 },
  }),
  remedy('replay-at-cap', {
    category: 'lanes',
    evidence: 'the phase’s replay reached its cap (`phase.replay-limit`) while the phase is still live',
    remedy:
      'note it on the run; the replay sheds per phase, and the session’s own log still reads the live lane',
    verb: 'note',
    autonomy: 'suggest',
    cap: { perHour: 1 },
  }),
  remedy('approval-timed-out', {
    category: 'approvals',
    evidence:
      'a permission card timed out (`phase.approval-decided` with `timeout`) and the phase stopped on it, with nothing live on the phase since',
    remedy: 'retry the phase, with an addendum saying which approval timed out',
    verb: 'retry',
    autonomy: 'press',
    cap: { perHour: 2 },
  }),
  remedy('quiet-not-stalled', {
    category: 'lanes',
    evidence:
      'the lane has been silent for 20 minutes or more while a tool call of its own is open (a suite, a build — its own job)',
    remedy:
      'leave it alone: a quiet lane running its own job is working, and a checkpoint would kill the job',
    verb: null,
    autonomy: 'none',
    cap: { perHour: 0 },
  }),
  remedy('machine-load', {
    category: 'machine',
    evidence: 'the machine’s 5-minute load average is 1.5 × its cores or more',
    remedy: 'hold the run’s new admissions until the load falls — live lanes carry on',
    verb: 'hold',
    autonomy: 'suggest',
    cap: { perHour: 1 },
  }),
  remedy('streak-near-max', {
    category: 'stops',
    evidence:
      'the run’s failure streak is one short of its ceiling and the failures were declared blocks, not reds',
    remedy: 'clearing a streak is a person’s press by design: clear it if the blocks are answered',
    verb: 'clear-streak',
    autonomy: 'escalate',
    cap: { perHour: 1 },
  }),
  remedy('halted-with-ready-work', {
    category: 'stops',
    evidence:
      'the run is halted or parked, its halt is not one only a person may lift, and the board has ready phases',
    remedy: 'resume the run',
    verb: 'resume',
    autonomy: 'press',
    cap: { perHour: 2 },
  }),
]);

/** A situation's row. */
export function remedyFor(situation) {
  return REMEDIES.find((row) => row.situation === situation);
}

/**
 * The category a situation's detections count under on the Tower (phase 102).
 * @param {SupervisorSituation} situation
 * @returns {SupervisorCategory}
 */
export function supervisorCategoryOf(situation) {
  return /** @type {SupervisorCategory} */ (remedyFor(situation)?.category);
}

/* ------------------------------------------------------------------ *
 * What it may never do
 * ------------------------------------------------------------------ */

/**
 * The invariants (#145 G), each held by a table test. The verbs a remedy may
 * PRESS are the trigger-pressable rows of the verb table minus the ones that
 * could break one of these.
 */
export const SUPERVISOR_INVARIANTS = Object.freeze([
  Object.freeze({
    id: 'no-only-phases',
    rule: 'never `onlyPhases` on a run meant to continue — no remedy starts a run',
  }),
  Object.freeze({
    id: 'no-stash',
    rule: 'never `git stash` or `--autostash` in a shared tree — no remedy runs git',
  }),
  Object.freeze({
    id: 'no-orphan-kill',
    rule: 'never kill an orphaned child — no remedy stops, freezes or checkpoints',
  }),
  Object.freeze({
    id: 'move-never-delete',
    rule: 'move, never delete — no remedy releases a lock, skips a phase or clears an account',
  }),
  Object.freeze({
    id: 'never-block',
    rule: 'never block on a question — an escalation is sent and the pass goes on',
  }),
  Object.freeze({
    id: 'press-only-halts',
    rule: 'never widen `PRESS_ONLY_HALT_KINDS` — a run halted by one is escalated, never pressed',
  }),
  Object.freeze({
    id: 'no-live-switch',
    rule: 'never switch an account while a session is live — a switch waits for the boundary',
  }),
  Object.freeze({ id: 'never-onto-walled', rule: 'never move a run onto an account at 97 % or walled' }),
  Object.freeze({
    id: 'never-main',
    rule: 'never merge, deploy or push `main` — no such verb is in the table',
  }),
]);

/** Verbs no remedy row may name, whatever its class — each would break an invariant above. */
export const NEVER_PRESSED = Object.freeze([
  'start',
  'stop',
  'freeze',
  'skip',
  'recover',
  'closeout',
  'isolate',
  'delegate',
  'settings',
  'wait',
]);

/** The account ceiling a move may never land on (`never-onto-walled`). */
export const ACCOUNT_TARGET_MAX_PCT = 97;

/* ------------------------------------------------------------------ *
 * The exact command an escalation carries
 * ------------------------------------------------------------------ */

/** A word the shell reads as itself, else single-quoted. */
function shellWord(value) {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `phase-console run …` line for a verb row (phase 98): its positional
 * arguments in the row's `cli.args` order, then `--flag value` for each field
 * given — composed from the row, never by hand. `null` for a verb with no CLI
 * shape (the escalation then names the route instead).
 * @param {string} name
 * @param {Record<string, unknown>} values the positional words and body fields by name
 */
export function commandFor(name, values = {}) {
  const row = verbNamed(name);
  if (!row?.cli) return null;
  const words = ['phase-console', 'run', row.name];
  for (const arg of row.cli.args) {
    const value = values[arg];
    if (value === undefined || value === null || value === '') return null;
    words.push(shellWord(value));
  }
  for (const [flag, field] of Object.entries(row.cli.flags)) {
    const value = field === true ? values[flag.replace(/^--/, '')] : values[field];
    if (value === undefined || value === null || value === '' || value === false) continue;
    words.push(flag);
    if (field !== true) words.push(shellWord(value));
  }
  return words.join(' ');
}

/* ------------------------------------------------------------------ *
 * The chat (§Architecture 8) — control-tower phase 27 extends the table
 * ------------------------------------------------------------------ */

/**
 * Where one chat stands. `starting` — its process is being spawned; `idle` —
 * alive and waiting for the operator; `working` — a turn is in flight;
 * `confirming` — an act waits on a person's card (`confirm` is not `never`);
 * `dormant` — no process (a console restart, an interrupt, a spent cap): the
 * operator's next message resumes it through the one resume gate, or starts a
 * new thread; `ended` — the operator closed it, and it never runs again.
 */
export const CHAT_STATES = Object.freeze(
  /** @type {const} */ (['starting', 'idle', 'working', 'confirming', 'dormant', 'ended']),
);

/** @typedef {(typeof CHAT_STATES)[number]} ChatState */

/**
 * When an act waits for a person (operator decision 4): `never` acts at once,
 * `destructive` raises a standing card for the destructive tools, `always`
 * for every act. A console that never chose follows its supervisor word
 * through `POLICY_CONFIRM` (act ≈ never, suggest ≈ always) — `chatConfirmFor`.
 */
export const CHAT_CONFIRM_MODES = Object.freeze(/** @type {const} */ (['never', 'destructive', 'always']));

/** @typedef {(typeof CHAT_CONFIRM_MODES)[number]} ChatConfirm */

/** A tool's kind is a verb's kind: the chat reads, or it acts. */
export const CHAT_TOOL_KINDS = VERB_KINDS;

/**
 * Every journal and log line the chat writes. `docs/journal-events.md` holds a
 * row for each. `supervisor.act` is the one a reader of a run's journal meets:
 * an act the chat pressed on that run.
 */
export const CHAT_EVENTS = Object.freeze(
  /** @type {const} */ ([
    'supervisor.act',
    'supervisor.chat-started',
    'supervisor.chat-thread',
    'supervisor.chat-cap-raised',
    'supervisor.chat-ended',
  ]),
);

/** The tools host's name in a chat's `--mcp-config` — short and plain: it becomes part of every tool's name. */
export const CHAT_TOOL_SERVER = 'pcchat';

/** Does this word name a confirm mode? */
export function isChatConfirm(word) {
  return typeof word === 'string' && /** @type {readonly string[]} */ (CHAT_CONFIRM_MODES).includes(word);
}

/**
 * The confirm mode a chat runs under: the operator's own `chatConfirm` when
 * they chose one, else the console's supervisor word through `POLICY_CONFIRM`,
 * else `always` — a console whose supervisor only watches (`off`, `observe`)
 * never lets the chat act unasked.
 * @param {unknown} chosen
 * @param {string|null|undefined} policy
 * @returns {ChatConfirm}
 */
export function chatConfirmFor(chosen, policy) {
  if (isChatConfirm(chosen)) return chosen;
  const mapped = isSupervisorPolicy(policy) ? POLICY_CONFIRM[policy] : null;
  return mapped ?? 'always';
}

/**
 * Does this act wait for a person's card under `confirm`? Reads never do.
 * @param {ChatConfirm} confirm
 * @param {{ kind: string, destructive: boolean }} tool
 */
export function needsConfirm(confirm, tool) {
  if (tool.kind !== 'act') return false;
  if (confirm === 'always') return true;
  return confirm === 'destructive' && tool.destructive;
}

/**
 * What *Ask the supervisor* carries into a chat (control-tower phase 28): the
 * thing a person pressed it on — a run (a strip), one phase of a run (the
 * phase drawer), or the stop that halted it (a halt card). The client draws
 * it as a chip over the composer and sends it beside the message; the server
 * turns it into a framed preamble ahead of the operator's words
 * (`pro/supervisor/prompt.ts` `contextPreamble`), so the chat reads what the
 * operator was looking at before it answers.
 */
export const CHAT_CONTEXT_KINDS = Object.freeze(/** @type {const} */ (['run', 'phase', 'halt', 'detection']));

/** @typedef {(typeof CHAT_CONTEXT_KINDS)[number]} ChatContextKind */

/**
 * A `detection` (control-tower phase 102) is one thing the supervisor saw, and
 * names its situation — the words the chat is told to read before it answers.
 * @typedef {{ kind: ChatContextKind, slug: string, phase?: number, runId?: string, situation?: SupervisorSituation }} ChatContext
 */

const CONTEXT_SLUG_RE = /^[\w.-]{1,128}$/;
const CONTEXT_RUN_RE = /^[\w.-]{1,64}$/;

/**
 * A context as a request body or an address carries it, or null when it is
 * not one. Strict, because the words reach a prompt: a kind the list lacks, a
 * slug or run id with anything but word characters, dots and dashes, or a
 * phase that is not a whole number is no context at all — never a guess.
 * @param {unknown} value
 * @returns {ChatContext | null}
 */
export function chatContextOf(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  const kind = /** @type {readonly unknown[]} */ (CHAT_CONTEXT_KINDS).includes(raw.kind)
    ? /** @type {ChatContextKind} */ (raw.kind)
    : null;
  if (!kind || typeof raw.slug !== 'string' || !CONTEXT_SLUG_RE.test(raw.slug)) return null;
  const phase =
    typeof raw.phase === 'number' && Number.isInteger(raw.phase) && raw.phase >= 0 ? raw.phase : null;
  if (raw.phase !== undefined && raw.phase !== null && phase === null) return null;
  if (kind === 'phase' && phase === null) return null;
  const runId = typeof raw.runId === 'string' && CONTEXT_RUN_RE.test(raw.runId) ? raw.runId : null;
  const situation = /** @type {readonly unknown[]} */ (SUPERVISOR_SITUATIONS).includes(raw.situation)
    ? /** @type {SupervisorSituation} */ (raw.situation)
    : null;
  if (kind === 'detection' && !situation) return null;
  return {
    kind,
    slug: raw.slug,
    ...(phase !== null ? { phase } : {}),
    ...(runId ? { runId } : {}),
    ...(kind === 'detection' && situation ? { situation } : {}),
  };
}

/** The capability flags a tool may need — the console's own switches, spelled as the CLI spells them. */
export const TOOL_CAPABILITIES = Object.freeze(
  /** @type {const} */ (['--allow-run', '--allow-writes', '--allow-accounts', '--allow-publish']),
);

/**
 * @typedef {{
 *   name: string, type: 'string'|'integer'|'number'|'boolean', required: boolean, summary: string,
 *   values?: readonly string[],
 * }} ChatToolArg
 */

/**
 * @typedef {{
 *   name: string, kind: 'read'|'act', destructive: boolean,
 *   capability: (typeof TOOL_CAPABILITIES)[number]|null, verb: string|null, summary: string,
 *   method: string, route: string|null, args: readonly ChatToolArg[], untrusted: boolean,
 * }} ChatTool
 */

/**
 * @param {string} name
 * @param {ChatToolArg['type']} type
 * @param {boolean} required
 * @param {string} summary
 * @param {readonly string[]} [values]
 * @returns {Readonly<ChatToolArg>}
 */
const arg = (name, type, required, summary, values) =>
  Object.freeze({ name, type, required, summary, ...(values ? { values: Object.freeze([...values]) } : {}) });

const SLUG = arg('slug', 'string', true, 'the plan’s slug');
const PHASE = arg('phase', 'integer', true, 'the phase number');
const ONE_PHASE = arg('phase', 'integer', false, 'one phase only, when given; else the whole run');
const INSTRUCTION = arg('instruction', 'string', false, 'what the session is told as it boards');
const STEP = arg('id', 'string', true, 'the human step’s id, as `human-steps` lists it');

/**
 * @param {string} name
 * @param {'read'|'act'} kind
 * @param {Partial<ChatTool>} rest
 * @returns {Readonly<ChatTool>}
 */
const tool = (name, kind, rest = {}) =>
  Object.freeze({
    name,
    kind,
    destructive: false,
    capability: kind === 'read' ? null : '--allow-run',
    verb: null,
    summary: '',
    method: '',
    route: null,
    untrusted: false,
    ...rest,
    args: Object.freeze([...(rest.args ?? [])]),
  });

/**
 * Every tool the chat offers: the reads first, then the acts, then phase 41's
 * human steps. `method` is the `Service` method the route calls — the chat
 * calls the SAME one (`server/pro/supervisor/tools.ts`), under `pressActor`
 * with `via: 'supervisor-chat'`, behind the SAME capability flag;
 * `test/supervisor-tools.test.ts` holds every row to `api/routes.ts`. A read
 * marked `untrusted` returns text a session, an issue's author or a plan wrote,
 * and the chat is handed it framed as data, never as instruction.
 */
export const CHAT_TOOLS = Object.freeze([
  /* ---- reads ---- */
  tool('plans', 'read', {
    method: 'summaries',
    route: 'GET /api/plans',
    untrusted: true,
    summary: 'every plan this console holds',
  }),
  tool('boards', 'read', {
    method: 'detail',
    route: 'GET /api/plans/:slug',
    args: [SLUG],
    untrusted: true,
    summary: 'a plan’s live board: done, ready, waiting',
  }),
  tool('runs', 'read', {
    verb: 'runs',
    method: 'slimRunFor',
    route: 'GET /api/runs',
    args: [arg('slug', 'string', false, 'one plan only')],
    summary: 'every run, slim',
  }),
  tool('why-halted', 'read', {
    verb: 'explain',
    method: 'phaseReport',
    route: 'GET /api/run/:slug/phase/:phase/report',
    args: [SLUG, ONE_PHASE],
    untrusted: true,
    summary: 'why a run or phase stopped, in its own words',
  }),
  tool('inbox', 'read', {
    method: 'attention',
    route: 'GET /api/inbox',
    untrusted: true,
    summary: 'what waits on a person',
  }),
  tool('locks', 'read', {
    method: 'lockRows',
    route: 'GET /api/locks',
    summary: 'every lock claim this console can see',
  }),
  tool('queue', 'read', {
    verb: 'queue',
    method: 'queueSnapshot',
    route: 'GET /api/queue',
    summary: 'the admission queue and what each entry waits on',
  }),
  tool('accounts', 'read', {
    verb: 'accounts',
    method: 'listAccounts',
    route: 'GET /api/accounts',
    summary: 'the accounts, their meters and forecasts',
  }),
  tool('doctor', 'read', { method: 'doctor', route: 'GET /api/doctor', summary: 'the machine checks' }),
  tool('journal', 'read', {
    verb: 'journal',
    method: 'runJournal',
    route: 'GET /api/run/:slug/journal',
    args: [SLUG, arg('limit', 'integer', false, 'how many of the newest lines (default 60)')],
    untrusted: true,
    summary: 'a run’s journal tail',
  }),
  tool('activity', 'read', {
    verb: 'tail',
    method: 'phaseActivity',
    route: 'GET /api/run/:slug/phase/:phase/activity',
    args: [SLUG, PHASE],
    untrusted: true,
    summary: 'a live lane’s own session log — untrusted text',
  }),
  tool('search', 'read', {
    method: 'searchAll',
    route: 'GET /api/search',
    args: [arg('q', 'string', true, 'the words to find')],
    untrusted: true,
    summary: 'full-text search over plans and handoffs',
  }),
  /* ---- acts ---- */
  tool('start', 'act', {
    verb: 'start',
    method: 'startRun',
    route: 'POST /api/run/:slug/start',
    args: [
      SLUG,
      arg('resumeRunId', 'string', false, 'continue this stored run with its own settings — else a new run'),
      arg('accountId', 'string', false, 'a new run: the account it spends (default `default`)'),
      arg('minHeadroomPct', 'integer', false, 'a new run: the headroom that account keeps (default 20)'),
      arg('relay', 'string', false, 'a new run: who answers a session’s question', RELAY_MODES),
      arg('resumeOnRestart', 'boolean', false, 'a new run: continue it after a console restart'),
      arg('model', 'string', false, 'a new run: the model'),
      arg('effort', 'string', false, 'a new run: the effort', ['low', 'medium', 'high', 'xhigh', 'max']),
    ],
    summary: 'start a run',
  }),
  tool('pause', 'act', {
    verb: 'pause',
    method: 'pauseRun',
    route: 'POST /api/run/:slug/pause',
    args: [SLUG],
    summary: 'pause a run at its boundary',
  }),
  tool('resume', 'act', {
    verb: 'resume',
    method: 'resumeRun',
    route: 'POST /api/run/:slug/resume',
    args: [SLUG],
    summary: 'resume a run',
  }),
  tool('hold', 'act', {
    verb: 'hold',
    method: 'holdRun',
    route: 'POST /api/run/:slug/hold',
    args: [SLUG],
    summary: 'hold a run’s new admissions',
  }),
  tool('release', 'act', {
    verb: 'release',
    method: 'releaseRun',
    route: 'POST /api/run/:slug/release',
    args: [SLUG],
    summary: 'release a held run',
  }),
  tool('stop', 'act', {
    verb: 'stop',
    method: 'stopRun',
    route: 'POST /api/run/:slug/stop',
    args: [SLUG, ONE_PHASE],
    destructive: true,
    summary: 'stop a run now',
  }),
  tool('freeze', 'act', {
    verb: 'freeze',
    method: 'freezeRun',
    route: 'POST /api/run/:slug/freeze',
    args: [SLUG, ONE_PHASE],
    summary: 'freeze a run where it stands',
  }),
  tool('thaw', 'act', {
    verb: 'thaw',
    method: 'thawRun',
    route: 'POST /api/run/:slug/thaw',
    args: [SLUG, ONE_PHASE],
    summary: 'thaw a frozen run',
  }),
  tool('retry', 'act', {
    verb: 'retry',
    method: 'pressRetry',
    route: 'POST /api/run/:slug/retry',
    args: [SLUG, PHASE, arg('addendum', 'string', false, 'what the retried session is told first')],
    summary: 'retry a phase, with an addendum',
  }),
  tool('skip', 'act', {
    verb: 'skip',
    method: 'skipPhase',
    route: 'POST /api/run/:slug/skip',
    args: [SLUG, PHASE],
    destructive: true,
    summary: 'skip a phase',
  }),
  tool('recover', 'act', {
    verb: 'recover',
    method: 'recoverPlan',
    route: 'POST /api/run/:slug/recover',
    args: [SLUG],
    summary: 'recover a plan',
  }),
  tool('recheck', 'act', {
    verb: 'recheck',
    method: 'recoverPhase',
    route: 'POST /api/run/:slug/recheck',
    args: [SLUG, PHASE],
    summary: 're-check a phase’s evidence',
  }),
  tool('closeout', 'act', {
    verb: 'closeout',
    method: 'pressResume',
    route: 'POST /api/run/:slug/closeout',
    args: [SLUG, PHASE, INSTRUCTION],
    summary: 'close a phase out',
  }),
  tool('resume-phase', 'act', {
    verb: 'resume-phase',
    method: 'pressResume',
    route: 'POST /api/run/:slug/resume-phase',
    args: [SLUG, PHASE, INSTRUCTION],
    summary: 'resume one phase, with a note',
  }),
  tool('switch-account', 'act', {
    verb: 'switch-account',
    method: 'switchAccountRun',
    route: 'POST /api/run/:slug/switch-account',
    args: [
      SLUG,
      arg('accountId', 'string', true, 'the account to move to'),
      arg('when', 'string', false, 'now, or at the run’s next boundary', ['now', 'boundary']),
    ],
    summary: 'move a run to another account, at its boundary',
  }),
  tool('settings', 'act', {
    verb: 'settings',
    method: 'configureRun',
    route: 'POST /api/run/:slug/settings',
    args: [
      SLUG,
      arg('maxParallel', 'integer', false, 'how many lanes at once'),
      arg('maxConsecutiveFailures', 'integer', false, 'the failure-streak ceiling'),
      arg('phaseBudgetUsd', 'number', false, 'the per-phase dollar budget'),
      arg('runBudgetUsd', 'number', false, 'the whole run’s dollar budget'),
      arg('model', 'string', false, 'the model new sessions board with'),
      arg('effort', 'string', false, 'the effort new sessions board with', [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]),
    ],
    summary: 'change a run’s settings',
  }),
  tool('raise-budget', 'act', {
    verb: 'raise-budget',
    method: 'raiseBudget',
    route: 'POST /api/run/:slug/raise-budget',
    args: [
      SLUG,
      arg('budget', 'string', true, 'which budget stopped the work', [
        'wait',
        'phase-usd',
        'run-usd',
        'ladder',
      ]),
      arg('phase', 'integer', false, 'the phase it stopped'),
      arg('add', 'number', false, 'raise it by this much'),
      arg('to', 'number', false, 'raise it to this'),
    ],
    summary: 'raise a run’s budget',
  }),
  tool('clear-streak', 'act', {
    verb: 'clear-streak',
    method: 'clearFailureStreak',
    route: 'POST /api/run/:slug/clear-streak',
    args: [SLUG],
    destructive: true,
    summary: 'clear a run’s failure streak',
  }),
  tool('approve-gate', 'act', {
    method: 'approveGate',
    route: 'POST /api/plans/:slug/gate/:phase',
    capability: '--allow-writes',
    destructive: true,
    args: [
      SLUG,
      PHASE,
      arg('note', 'string', false, 'the evidence the approval rests on'),
      arg('continueRun', 'boolean', false, 'continue the run once the gate is clear'),
    ],
    summary: 'approve a phase’s gate',
  }),
  tool('answer-approval', 'act', {
    verb: 'approve',
    method: 'decideApproval',
    route: 'POST /api/approvals/:id',
    destructive: true,
    args: [
      arg('id', 'string', true, 'the card’s id'),
      arg('decision', 'string', true, 'the answer', ['allow', 'deny']),
      arg('reason', 'string', false, 'why'),
    ],
    summary: 'answer a permission card',
  }),
  tool('release-lock', 'act', {
    method: 'releaseLock',
    route: 'POST /api/locks/release',
    capability: '--allow-writes',
    destructive: true,
    args: [SLUG, PHASE, arg('force', 'boolean', false, 'release a lock that is not stale')],
    summary: 'release a phase lock',
  }),
  tool('clear-retired', 'act', {
    method: 'clearRetiredAccount',
    route: 'POST /api/accounts/:id/clear-retired',
    capability: '--allow-accounts',
    destructive: true,
    args: [arg('accountId', 'string', true, 'the account')],
    summary: 'clear an account’s retirement',
  }),
  tool('qa-recover', 'act', {
    verb: 'qa-recover',
    method: 'qaRecover',
    route: 'POST /api/run/:slug/qa-recover',
    args: [SLUG, PHASE],
    summary: 'recover a phase’s QA',
  }),
  tool('qa-rerun', 'act', {
    verb: 'qa-rerun',
    method: 'qaRecover',
    route: 'POST /api/run/:slug/qa-rerun',
    args: [SLUG, PHASE],
    summary: 're-run a phase’s QA',
  }),
  tool('draft-an-issue', 'act', {
    method: 'draftIssue',
    capability: '--allow-writes',
    args: [
      SLUG,
      PHASE,
      arg('title', 'string', true, 'one line'),
      arg('where', 'string', true, 'a path, a line, a run'),
      arg('evidence', 'string', true, 'what shows it'),
      arg('whyUnrelated', 'string', true, 'why it is not the phase’s own work'),
      arg('fix', 'string', true, 'what would fix it'),
      arg('repo', 'string', false, 'the estate key (default `console`, the console’s own repository)'),
    ],
    summary: 'draft an issue — filed only under --allow-publish, after a person’s Approve',
  }),
  /* ---- phase 41's human steps: the chat may list, reopen and re-check one, never COMPLETE it ---- */
  tool('human-steps', 'read', {
    method: 'humanStepsView',
    route: 'GET /api/human-steps',
    untrusted: true,
    summary: 'the human steps a plan is waiting on',
  }),
  tool('human-step-open-again', 'read', {
    method: 'openHumanStep',
    route: 'POST /api/human-steps/:id/open',
    args: [STEP],
    summary: 'reopen a human step: its link or command, shown again to the person',
  }),
  tool('human-step-check-now', 'read', {
    method: 'checkHumanStep',
    route: 'POST /api/human-steps/:id/check',
    args: [STEP],
    summary: 're-run a human step’s proof now — a step with no proof stays open',
  }),
]);

/** Every verb the table names exists in the verb table — `test/supervisor-model.test.ts` holds it. */
export const CHAT_TOOL_VERBS = Object.freeze([...new Set(CHAT_TOOLS.map((row) => row.verb).filter(Boolean))]);

/** A tool's row. */
export function chatToolNamed(name) {
  return CHAT_TOOLS.find((row) => row.name === name);
}

/**
 * The human-step routes the chat may reach — exactly these three, all reads
 * (§Architecture 12's safety floor): it lists, reopens and re-checks a step,
 * and nothing it holds completes, proves, snoozes or dismisses one.
 */
export const CHAT_HUMAN_STEP_TOOLS = Object.freeze([
  'human-steps',
  'human-step-open-again',
  'human-step-check-now',
]);
