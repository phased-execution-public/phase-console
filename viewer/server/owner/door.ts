/**
 * The owner door — who pressed, decided from what a request can PROVE
 * (control-tower phase 131, #208; §Architecture 19).
 *
 * Until this file, the console's answer to "who pressed this" was the request's
 * own say-so: `by` was the body's label, a User-Agent class stood in for a
 * person, a phone the fleet supervisor had verified was journalled
 * `operator · local`, and twelve of fifteen approval cards on the hub were
 * answered `by: script` by the run's own supervising agent. Here the door is
 * read off the transport instead, one door per request, from
 * `shared/door-model.js`'s `PRESS_DOORS`:
 *
 *   - `session` — a run token (the approval hook's bearer) or a message token;
 *     a session PROVES itself, so this outranks everything below;
 *   - `supervisor` — a live supervisor chat's bearer (the supervisor's own
 *     pass presses in-process, through `pressDoorOf`);
 *   - `device` — a person somebody verified: the fleet supervisor's asserted
 *     login (a paired device, `device:<slug>#<id6>`, or a tailnet login), the
 *     `--remote` proxy's allowlisted login, or a signed lock-screen action
 *     (stamped by the push route once its token verifies);
 *   - `local` — anything else: a script, the CLI, a browser with no owner key.
 *
 *   - `owner` — a live owner session (phase 148): the cookie a passkey
 *     assertion set in this browser, read after the agents' proofs and before
 *     the transport's, so a phone signed in as the owner presses as the owner;
 *     and a request the owner CONFIRMED, pressed again by the console itself.
 *
 * `checker` is in the vocabulary and is no request's (phase 134 writes its
 * verdicts in-process). `by` in a body is a LABEL and never changes the door.
 *
 * What this cannot do, said once: a process running as the operator can read
 * the fleet's bearer and forge a device, as it can forge the proxy's header on
 * loopback — and, below the owner key, anything: it can rewrite the console's
 * own files, the key registry among them. The console walls the paths a
 * session takes (`console-forge`), makes the door honest for everything that
 * does not forge it and announces every grant and every key; it is not a
 * boundary against the operator's own account.
 */

import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import {
  OWNER_DOOR_MODES, OWNER_DOOR_STATES, doorMay, type AuthorityRoute, type AuthorityVerb, type OwnerDoorMode,
  type OwnerDoorState, type PressDoor,
} from '../../shared/door-model.js';
import { classify, hostnameOf, isLoopbackHost, type Verdict } from '../api/access.ts';
import { isAgentDoor, pressDoorOf } from '../actor.ts';
import { INSTANCE_STATE_DIR, type Flags } from '../config.ts';
import { Ceremonies } from './passkey.ts';
import { OwnerRegistry } from './registry.ts';
import { AuthorityRequests } from './requests.ts';
import { OwnerSessions, type OwnerSessionRow } from './session.ts';

export { isAgentDoor, pressDoorOf };

/** How a door was proved — the journal's `doorProof`. */
export type DoorProof =
  | 'run-token'
  | 'message-token'
  | 'chat-bearer'
  | 'owner-session'
  | 'owner-confirm'
  | 'fleet-login'
  | 'remote-login'
  | 'push-token'
  | 'transport';

/**
 * One request's door: the word, the identity its proof names (a login, a run
 * id, an owner key's label), and the proof. An `owner` reading also says
 * whether the key was touched inside the last five minutes (`fresh`) and which
 * session and key it is.
 */
export type DoorReading = {
  door: PressDoor;
  label: string | null;
  proof: DoorProof;
  fresh?: boolean;
  sessionId?: string;
  keyId?: string;
};

/**
 * What the door reader needs from the console. The token and bearer checks are
 * the service's own (`Approvals.runIdFor`, `MsgTokens.runIdFor`, the chats'
 * bearer), handed in so this module imports no service and no Pro module.
 */
export type DoorDeps = {
  flags: Partial<Pick<Flags, 'remoteHosts' | 'remoteUsers'>>;
  /** The run a run token was minted for, else null. */
  runToken?: (authorization: string | undefined) => string | null;
  /** The run a message token was minted for, else null. */
  messageToken?: (authorization: string | undefined) => string | null;
  /** The live supervisor chat a bearer belongs to, else null. */
  chatBearer?: (authorization: string | undefined) => string | null;
  /** The live owner session this request's cookie names, else null (phase 148). */
  ownerSession?: (req: Pick<IncomingMessage, 'headers'>) => OwnerSessionRow | null;
};

/* ------------------------------------------------------------------ *
 * The owner's state: keys, sessions, requests, ceremonies, links
 * ------------------------------------------------------------------ */

/** A `phase-console owner enroll` link, by the sha256 of its token — the token itself is never kept. */
export type EnrolLink = { expiresAt: number; mintedBy: 'machine' | 'owner'; label?: string };

/**
 * Everything the owner door keeps, in one place: the key registry
 * (`owner-doors.json`), the sessions (`owner-sessions.json`), the requests
 * (`owner-requests.json`) — each 0600 beside the console's other state — and,
 * in memory only, the ceremonies in flight and the enrol links.
 */
export type OwnerState = {
  registry: OwnerRegistry;
  sessions: OwnerSessions;
  requests: AuthorityRequests;
  ceremonies: Ceremonies;
  links: Map<string, EnrolLink>;
};

export function ownerStateAt(dir: string): OwnerState {
  return {
    registry: new OwnerRegistry(join(dir, 'owner-doors.json')),
    sessions: new OwnerSessions(join(dir, 'owner-sessions.json')),
    requests: new AuthorityRequests(join(dir, 'owner-requests.json')),
    ceremonies: new Ceremonies(),
    links: new Map(),
  };
}

let OWNER: OwnerState | null = null;

/** This console's owner state — under its own state directory. */
export function ownerState(): OwnerState {
  OWNER ??= ownerStateAt(INSTANCE_STATE_DIR);
  return OWNER;
}

/** A test's own state directory (null: back to the console's). */
export function installOwnerState(state: OwnerState | null): void {
  OWNER = state;
}

/** The person-facing word for a request's door: `unlocked` when it carries a live owner session. */
export function ownerDoorState(reading: Pick<DoorReading, 'door'> | null | undefined): OwnerDoorState {
  if (ownerDoorMode() === OWNER_DOOR_MODES[0]) return OWNER_DOOR_STATES[0];
  return reading?.door === 'owner' ? OWNER_DOOR_STATES[2] : OWNER_DOOR_STATES[1];
}

/* ------------------------------------------------------------------ *
 * A confirmed request, pressed again by the console as the owner
 * ------------------------------------------------------------------ */

const REPLAYS = new WeakMap<object, DoorReading>();

/**
 * Mark a request the console builds itself to press a CONFIRMED request: it
 * reads as the owner's door (`owner-confirm`), the owner having just pressed
 * Confirm through their own. Only code in this process can mark one. Its touch
 * is the confirmer's own (control-tower phase 149): a request the asker's door
 * priced below high needs no touch to confirm, so the replay must not claim
 * one — what it presses is priced again, and a high grant is judged by it.
 */
export function markReplay(req: object, reading: DoorReading): void {
  REPLAYS.set(req, { ...reading, door: 'owner', proof: 'owner-confirm', fresh: reading.fresh === true });
}

/** The one header a session or a chat proves itself with — never a repeated one. */
function authorizationOf(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * The person-shaped half of a door, from the access layer's own verdict: a
 * login somebody verified is a `device`; nothing verified is `local`. Reuses
 * `classify` — the one reading of the proxy and the fleet's assertion — and
 * answers `local` when the request would not even be admitted, since a door is
 * a fact about a request that got in.
 */
export function transportDoor(
  req: Pick<IncomingMessage, 'headers'>, flags: DoorDeps['flags'],
): DoorReading {
  let verdict: Verdict;
  try {
    verdict = classify(req as IncomingMessage, {
      remoteHosts: flags.remoteHosts ?? [], remoteUsers: flags.remoteUsers ?? [],
    } as unknown as Flags);
  } catch {
    return { door: 'local', label: null, proof: 'transport' };
  }
  if (verdict.ok && verdict.scope === 'remote' && verdict.login) {
    // A fleet assertion arrives on loopback; the proxy's login on the host it served.
    const fleet = isLoopbackHost(hostnameOf(req.headers.host));
    return { door: 'device', label: verdict.login, proof: fleet ? 'fleet-login' : 'remote-login' };
  }
  return { door: 'local', label: null, proof: 'transport' };
}

/**
 * The door of one request. A session's token and the chat's bearer are read
 * FIRST: a request that proves it is an agent's is that agent's whatever else
 * it carries, so a session cannot borrow a device by sending the fleet's
 * headers beside its own token.
 */
export function doorOfRequest(req: Pick<IncomingMessage, 'headers'>, deps: DoorDeps): DoorReading {
  const replayed = REPLAYS.get(req);
  if (replayed) return replayed;
  const authorization = authorizationOf(req);
  if (authorization) {
    const run = deps.runToken?.(authorization) ?? null;
    if (run) return { door: 'session', label: run, proof: 'run-token' };
    const messaged = deps.messageToken?.(authorization) ?? null;
    if (messaged) return { door: 'session', label: messaged, proof: 'message-token' };
    const chat = deps.chatBearer?.(authorization) ?? null;
    if (chat) return { door: 'supervisor', label: chat, proof: 'chat-bearer' };
  }
  const owner = deps.ownerSession?.(req) ?? null;
  if (owner) {
    return {
      door: 'owner', label: owner.label, proof: 'owner-session',
      fresh: OwnerSessions.fresh(owner), sessionId: owner.id, keyId: owner.keyId,
    };
  }
  return transportDoor(req, deps.flags);
}

/* ------------------------------------------------------------------ *
 * The stamp: one reading per request
 * ------------------------------------------------------------------ */

const STAMPS = new WeakMap<object, DoorReading>();

/** Record a request's door once — the router does, before any route reads an actor. */
export function stampDoor(req: object, reading: DoorReading): DoorReading {
  STAMPS.set(req, reading);
  return reading;
}

/** The door the router stamped on this request, or null when nothing did (a test calling a route helper bare). */
export function stampedDoor(req: object): DoorReading | null {
  return STAMPS.get(req) ?? null;
}

/**
 * The `Service` methods that carry an authority verb, and the verb — what a
 * route calls when it presses one. The other half of holding `AUTHORITY_ROUTES`
 * both ways (`console-forge.test.ts`): every call of one of these in
 * `api/routes.ts` must be reached by a row's route, so a route a later phase
 * adds that presses one of them fails the suite — naming its line — until it
 * has a row, and from that day the hook guard and the door check fence it.
 */
export const AUTHORITY_METHODS: Readonly<Record<string, AuthorityVerb>> = Object.freeze({
  decideApproval: 'answer',
  extendApproval: 'answer',
  editPolicy: 'policy-widen',
  savePreferences: 'policy-widen',
  rememberRuling: 'policy-widen',
  configureRun: 'profile-raise',
  answerQuestion: 'answer',
  decidePlan: 'plan-approve',
  delegatePhase: 'trust',
  approveGate: 'gate-approve',
  checkHumanStep: 'attest',
  dismissHumanStep: 'decline',
  answerHumanStep: 'answer',
  declineHumanStep: 'decline',
  denyHumanStep: 'decline',
  convertHumanStep: 'decline',
  // The scoped grant (control-tower phase 149): the item's Grant, and the two
  // revokes — declines, since they take authority away.
  grantHumanStep: 'grant',
  revokeGrant: 'decline',
  revokeAllGrants: 'decline',
  overrideHumanStep: 'override',
  rewriteHumanStep: 'decline',
  performInboxAction: 'answer',
  // The owner key (control-tower phase 148): every press of `/api/owner/…`
  // but a read, and the owner's answer to a request.
  ownerPress: 'owner-key',
  answerOwnerRequest: 'answer',
});

/**
 * The table's mode for this console — the ONE switch the gate's person test,
 * the router's door check and `/api/state.ownerDoor` all read: `enrolled` once
 * the registry holds an owner key (phase 148), `unenrolled` before — where
 * `local` presses what it could before, and the console says so.
 */
export function ownerDoorMode(): OwnerDoorMode {
  let keys = 0;
  try { keys = ownerState().registry.count(); } catch { keys = 0; }
  return keys > 0 ? OWNER_DOOR_MODES[1] : OWNER_DOOR_MODES[0];
}

/**
 * The server's door check on one authority route: null when the door may make
 * the press, else the sentence that says why not and what to do instead. Only
 * an agent's door is ever refused on an unenrolled console — a person's press
 * is what it was — and an agent's press passes only when the plan's manifest
 * already allows it (`manifest`), exactly as the hook guard reads the row.
 */
export function authorityRefusal(
  reading: DoorReading, row: AuthorityRoute, opts: { mode?: OwnerDoorMode; manifest?: boolean } = {},
): string | null {
  const verdict = doorMay(reading.door, row.authority, {
    mode: opts.mode ?? ownerDoorMode(), manifest: opts.manifest === true,
  });
  if (verdict === 'press') return null;
  const who = reading.door === 'session'
    ? `a session's ${reading.proof === 'message-token' ? 'message' : 'run'} token`
    : reading.door === 'supervisor' ? "the supervisor's bearer" : `the ${reading.door} door`;
  return `this request carries ${who}, and ${row.summary.split(' — ')[0]} is a person's press (${row.verb}: `
    + `${row.authority}) — nothing in the plan's permission.destructive row names it for a live phase. `
    + (reading.door === 'session'
      ? `Declare it instead: phase-outcome.sh … ${row.declare.status} --needs ${row.declare.needs}.`
      : 'Ask the operator to press it.');
}
