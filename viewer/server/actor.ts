/**
 * Who did it, from where, through which door.
 *
 * One attribution shape — `shared/run-lifecycle.js`'s `Actor`, owned there
 * since zero-touch-console phase 2 — built here in the four ways the console
 * needs one, so that "why did this `claude` start" and "who stopped this run"
 * are one question with one answer wherever it is asked (chapter 02 SLF-1,
 * chapter 01 LFC-6, chapter 06 SHD-3, chapter 11 ACT-11).
 *
 * Two rules the builders are shaped by.
 *
 *  - **A door names itself.** Every automatic start goes through one of the
 *    sixteen `START_DOORS`, and the site that opens it says the door, what
 *    fired it, which guard let it through and which counter it spent. A verb
 *    several doors share (`retryPhase`, `recoverPhase`) carries its CALLER's
 *    actor through rather than inventing one — the door is where the decision
 *    was made, not where the spawn happens. `test/invariants.test.ts` holds
 *    every `startRun(` site to this.
 *
 *  - **A request's actor is DERIVED, never supplied.** Client and server both
 *    used to write the literal `'console'`, so a click, a script, a replayed
 *    request and a tailnet caller were one record. `actorOfRequest` reads the
 *    transport instead: the User-Agent class decides `api` against `cli`, the
 *    Host header decides `origin` (`local`, or the hostname the proxy served),
 *    and the proxy's identity header fills `remoteUser`. A body may still
 *    offer a LABEL for `by` (`bin/btw` says `btw`, a test says what it is);
 *    the three derived fields it cannot touch, and a body offering nothing
 *    gets `operator` for a browser or the CLI and `script` for anything else.
 *    That half lives in `api/actor.ts`, beside the access layer it reads; this
 *    file is the pure part the runner imports.
 *
 *  - **The press door is proved, never claimed** (control-tower phase 131,
 *    #208). `by` is a label; `pressDoor` is what the request could prove — a
 *    session's token, the supervisor's bearer, a device somebody verified, or
 *    nothing (`local`). An in-process actor's door is read off its transport
 *    (`pressDoorOf`), so the supervisor's pass is never a person's press.
 */

import { AGENT_DOORS, type PressDoor } from '../shared/door-model.js';
import { OPERATOR_DOOR, START_DOORS } from '../shared/run-lifecycle.js';
import type { Actor, ActorVia, AnyDoor, StartDoor } from './runner/state.ts';

/** An actor that names a door — what every `startRun` carries. */
export type StartActor = Actor & { door: AnyDoor };

/** The fields a door site fills beside the door word itself. */
export type DoorFields = {
  by: string;
  via: ActorVia;
  origin: string;
  trigger?: string;
  guard?: string;
  counter?: string;
};

/**
 * An automatic door's actor. The door is the first argument so the word is
 * visible at the call site — that is what the lint reads, and what a person
 * scanning a site for "which door is this" sees first.
 */
export function doorActor(door: StartDoor, fields: DoorFields): StartActor {
  return {
    by: fields.by,
    via: fields.via,
    origin: fields.origin,
    remoteUser: null,
    door,
    ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
    ...(fields.guard !== undefined ? { guard: fields.guard } : {}),
    ...(fields.counter !== undefined ? { counter: fields.counter } : {}),
  };
}

/** A person's press — the request's derived actor, through the one non-automatic door. */
export function pressActor(actor: Actor): StartActor {
  return { ...actor, door: OPERATOR_DOOR };
}

/**
 * What a caller that reached a start with no actor at all is recorded as.
 *
 * No production path produces this: every door names itself and every press
 * derives from its request. It exists so a harness that calls `Runner.start`
 * or `Service.retryPhase` bare still writes a `run.start` with a non-null
 * `by` — and so that a journal line reading `unattributed` is a defect to
 * chase, never a word a door may choose.
 */
export function unattributedActor(origin: string): Actor {
  return { by: 'unattributed', via: 'cli', origin, remoteUser: null };
}

/**
 * An actor from whatever a verb was handed: the shape itself, a bare label
 * (an older caller, a test's `pause('console')`), or nothing. A label is
 * recorded as offered, with the transport unknown-but-local — better than
 * refusing a caller that predates the shape, and still never the literal
 * `'console'` from nowhere.
 */
export function asActor(input: Actor | string | null | undefined, origin: string): Actor {
  if (input && typeof input === 'object') return input;
  return typeof input === 'string' && input.trim()
    ? { by: input.trim().slice(0, 64), via: 'cli', origin, remoteUser: null }
    : unattributedActor(origin);
}

/** Did an automatic door open this start (the ceiling's question), or a person? */
export function isAutomatic(actor: Actor | StartActor): actor is StartActor & { door: StartDoor } {
  return typeof actor.door === 'string' && (START_DOORS as readonly string[]).includes(actor.door);
}

/**
 * The two-word fold `stoppedBy` keeps.
 *
 * `RunState.stoppedBy` is `'operator' | 'system'` and load-bearing for the
 * convergence loop (an operator's stop is never resumed by itself), so the
 * actor does not replace it — it DECIDES it. The question the two words ask
 * is "did anything outside the console ask for this": a request (`api`,
 * `cli`), a signal or a hook body did; the console's own clocks, its boot
 * and its observations did not.
 */
export function stoppedByOf(actor: Actor): 'operator' | 'system' {
  return actor.via === 'timer' || actor.via === 'boot' || actor.via === 'event' || actor.via === 'supervisor' ? 'system' : 'operator';
}

/**
 * Was this act a PERSON's (control-tower phase 78, #106)? `stoppedByOf`'s
 * `operator`, and no automatic door: a press over the API — or a script acting
 * for one — names none, while the console's own movers (the ladder's rung
 * through converge, a watch landing) name theirs even when a person's button
 * set them going. Only a person's account switch is remembered as a choice.
 */
export function isPersonsAct(actor: Actor): boolean {
  const door = (actor as { door?: string }).door;
  return stoppedByOf(actor) === 'operator' && (!door || door === OPERATOR_DOOR) && !isAgentDoor(pressDoorOf(actor));
}

/**
 * The door an actor pressed through (control-tower phase 131, #208). A
 * request-derived actor carries its own (`actorOfRequest` stamps it); an
 * in-process one is read off its transport: the supervisor's pass is the
 * supervisor's, a hook body is a session's, the console's clocks are the
 * console's, and anything else asked from outside — a signal, an older
 * caller's bare label — is `local`.
 */
export function pressDoorOf(actor: (Pick<Actor, 'via'> & { pressDoor?: PressDoor }) | null | undefined): PressDoor {
  if (actor?.pressDoor) return actor.pressDoor;
  // `supervisor-chat` is the chat's own transport (`pro/supervisor/tools.ts`), outside `ACTOR_VIAS`.
  switch (actor?.via as string | undefined) {
    case 'supervisor':
    case 'supervisor-chat':
      return 'supervisor';
    case 'hook': return 'session';
    case 'timer':
    case 'boot':
    case 'event':
      return 'console';
    default:
      return 'local';
  }
}

/** Did a press come through an agent's door — a session's or the supervisor's — rather than a person's? */
export function isAgentDoor(door: PressDoor): boolean {
  return (AGENT_DOORS as readonly string[]).includes(door);
}

/**
 * The convergence loop's trigger word as a transport: `boot` is the console
 * starting, `button` is a press that arrived over the API, and the docs
 * watcher, the sweep timer and the minute-after-a-halt are all clocks of the
 * console's own.
 */
export function viaOfTrigger(trigger: string): ActorVia {
  if (trigger === 'boot') return 'boot';
  if (trigger === 'button') return 'api';
  return 'timer';
}

/**
 * One line for a push body or a log sentence: who, how, from where — and the
 * proxy's user when there was one. "asked for by console" was every record;
 * this is "asked for by operator over api from local".
 */
export function describeActor(actor: Actor): string {
  const who = actor.remoteUser && actor.remoteUser !== actor.by ? `${actor.by} (${actor.remoteUser})` : actor.by;
  return `asked for by ${who} over ${actor.via} from ${actor.origin}`;
}

/** The actor for a process signal — the sender of a SIGTERM is nobody the console can name. */
export function signalActor(signal: string): Actor {
  return { by: 'unknown', via: 'signal', origin: signal, remoteUser: null };
}
