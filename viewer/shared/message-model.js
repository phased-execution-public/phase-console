/**
 * The words a message between two sessions is spelled with — before any
 * message can be sent.
 *
 * A plan's phases already talk to each other through the handoff, which is a
 * letter posted at the end. What they have never had is a way to say something
 * WHILE both are alive ("the fixture you are about to write must carry the CLI
 * version"), or to leave something for a phase that has not started yet. Phase
 * 10 builds the ledger and the transports; phase 11 the forward notes. This
 * file is the vocabulary all of it is written in, so the send script, the
 * console, the hook and the inbox all read one copy.
 *
 * `scripts/messages.env` is the bash twin (the F5 pattern, like `gates.env`);
 * `viewer/test/gates-vocab.test.ts` asks bash for every list below and holds it
 * to these word for word.
 *
 * ⚠️ Data only, and ONE import: `RUN_PRIORITIES`, because a message's urgency
 * is the same three-word vocabulary a run's admission class already uses and
 * two copies that agree today are two copies that disagree the day a fourth
 * word is added. Nothing else — the client bundles this module and
 * `node --test` imports it directly. `test/vocab-owners.test.ts` registers
 * every list defined here.
 *
 * FREE, not Pro (decision 19): `phase-msg.sh` and the delivery engine are Pro,
 * but the words are read by the free engine and by the skill's own scripts.
 */

import { RUN_PRIORITIES } from './orchestration-model.js';

/* ------------------------------------------------------------------ *
 * What a message IS
 * ------------------------------------------------------------------ */

/**
 * `note` expects nothing back. `ask` wants an answer and is what the sender
 * blocks on. `reply` answers an `ask` and carries its id.
 *
 * Three kinds and not two, because a note that is silently treated as a
 * question is a session waiting on a peer that was never told to answer.
 * @typedef {(typeof MESSAGE_KINDS)[number]} MessageKind
 */
export const MESSAGE_KINDS = Object.freeze(/** @type {const} */ (['note', 'ask', 'reply']));

/**
 * Who a message is addressed to. An address is `<scheme>:<target>`.
 *
 * `session` — a Claude session id, the only address that names a process.
 * `phase`   — a phase of this plan, whoever is running it now.
 * `next`    — the phase that runs after this one, whenever that is.
 * `all`     — every live session of this run.
 * `run`     — the run itself (its journal and its inbox), nobody in particular.
 * `repo`    — every session working in one repository, across plans.
 * `operator`— a person, through the console's inbox and the announcements.
 * @typedef {(typeof MESSAGE_SCHEMES)[number]} MessageScheme
 */
export const MESSAGE_SCHEMES = Object.freeze(
  /** @type {const} */ (['session', 'phase', 'next', 'all', 'run', 'repo', 'operator']),
);

/**
 * WHEN the sender wants it to arrive — a request, not a promise.
 *
 * `now` — interrupt the recipient's turn if the transport allows it.
 * `next-turn` — wait for a turn boundary; the polite default for a note.
 * `boot` — hold it until the recipient's phase BOARDS, which is the only way
 *          to address a phase that has not started.
 * @typedef {(typeof MESSAGE_DELIVER)[number]} MessageDeliver
 */
export const MESSAGE_DELIVER = Object.freeze(/** @type {const} */ (['now', 'next-turn', 'boot']));

/**
 * How loudly — `high` is what a `needs-you` announcement is made of.
 *
 * The run-admission vocabulary, reused BY IDENTITY rather than respelled: "how
 * urgent is this" has one answer in this system, worst-first, and a second
 * copy of `high, normal, low` is precisely the drift `vocab-owners.test.ts`
 * exists to catch. The alias is kept because `MESSAGE_PRIORITIES` is what the
 * send path, the bash twin and the ledger's column all call it.
 *
 * The typedef is spelled here rather than re-exported from
 * `orchestration-model.js`: a message's priority is read as `MessagePriority`
 * by three modules, and importing `RunPriority` there would make every one of
 * them name a run.
 * @typedef {(typeof MESSAGE_PRIORITIES)[number]} MessagePriority
 */
export const MESSAGE_PRIORITIES = RUN_PRIORITIES;

/**
 * The delivery state machine, in order. A message is `queued` the instant it
 * is written, `held` while the recipient's policy will not take it yet,
 * `delivering` for exactly as long as one transport attempt lasts.
 *
 * `delivered` and `acked` are two facts, not one: the CLI's inbox writes
 * nothing back on ANY outcome (phase 1, arm S-B), so "the bytes went in" is
 * all a sender can ever learn from the connection — an ack only exists when
 * the recipient's own session records one.
 * @typedef {(typeof MESSAGE_STATES)[number]} MessageState
 */
export const MESSAGE_STATES = Object.freeze(
  /** @type {const} */ ([
    'queued',
    'held',
    'delivering',
    'delivered',
    'acked',
    'expired',
    'refused',
    'failed',
  ]),
);

/**
 * The transport that actually carried it — a fact about the past, which is
 * why it is a different list from `MESSAGE_DELIVER`, a wish about the future.
 *
 * `socket` is the CLI's cross-session messaging socket, `stdin` the frame
 * written to a session's own standard input, `boot-prompt` the block folded
 * into a phase's boarding prompt, `inbox` the console's own list when no
 * session could be reached at all.
 * @typedef {(typeof MESSAGE_VIAS)[number]} MessageVia
 */
export const MESSAGE_VIAS = Object.freeze(/** @type {const} */ (['socket', 'stdin', 'boot-prompt', 'inbox']));

/**
 * Why a message was refused. Each is a different repair, which is the only
 * reason to enumerate them rather than carry a sentence.
 * @typedef {(typeof MESSAGE_REFUSALS)[number]} MessageRefusal
 */
export const MESSAGE_REFUSALS = Object.freeze(
  /** @type {const} */ ([
    'no-recipient',
    'not-live',
    'over-budget',
    'too-large',
    'self-addressed',
    'unknown-scheme',
    'duplicate',
  ]),
);

/* ------------------------------------------------------------------ *
 * The caps
 * ------------------------------------------------------------------ */

/**
 * 8 KB. A message is a sentence a person could have said; anything longer is
 * a file, and a file belongs in the repository where the recipient can read it
 * at its own pace rather than in a prompt it pays for on every turn.
 */
export const MESSAGE_MAX_BYTES = 8192;

/**
 * 16 sends per phase. Chosen to be generous for the use the plan describes
 * (a handful of notes) and small enough that a loop cannot drain an account:
 * a session that hits it is not chatting, it is stuck.
 */
export const MESSAGE_MAX_PER_PHASE = 16;

/**
 * The plan-wide `**Messaging:**` line's two words. Since phase 15 also the
 * run's own `messaging` field, which speaks where the plan is silent.
 * @typedef {(typeof MESSAGING_WORDS)[number]} MessagingWord
 */
export const MESSAGING_WORDS = Object.freeze(/** @type {const} */ (['on', 'off']));

/** Messaging is on unless a plan turns it off — it costs nothing unused. */
export const DEFAULT_MESSAGING = 'on';

/* ------------------------------------------------------------------ *
 * Addresses
 * ------------------------------------------------------------------ */

/**
 * `<scheme>:<target>` → its parts, or `undefined` when the scheme is not one
 * of ours.
 *
 * Refusing rather than guessing is the point: an address nobody parses is a
 * message nobody receives, and a message delivered to the wrong session is
 * worse than one that was never sent. The target may be empty — `all:` and
 * `operator:` address nobody in particular — but the colon may not be missing,
 * because a bare word is a plausible session id and would silently become one.
 *
 * @param {unknown} address
 * @returns {{ scheme: MessageScheme, target: string } | undefined}
 */
export function parseAddress(address) {
  if (typeof address !== 'string') return undefined;
  const at = address.indexOf(':');
  if (at < 0) return undefined;
  const scheme = address.slice(0, at).trim().toLowerCase();
  if (!MESSAGE_SCHEMES.includes(/** @type {never} */ (scheme))) return undefined;
  return { scheme: /** @type {MessageScheme} */ (scheme), target: address.slice(at + 1).trim() };
}

/**
 * The inverse, and the only place an address is spelled — so a writer cannot
 * produce a string `parseAddress` would not take back.
 * @param {{ scheme: MessageScheme, target?: string }} parts
 */
export function formatAddress(parts) {
  return `${parts.scheme}:${parts.target ?? ''}`;
}
