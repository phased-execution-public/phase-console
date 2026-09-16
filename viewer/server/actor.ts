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
 *    fourteen `START_DOORS`, and the site that opens it says the door, what
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
 */

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
  return actor.via === 'timer' || actor.via === 'boot' || actor.via === 'event' ? 'system' : 'operator';
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
