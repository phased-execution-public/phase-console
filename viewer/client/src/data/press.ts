/**
 * A press — any write a person makes — through the owner door, in ONE place.
 *
 * A console with an owner key answers a press three ways besides doing it
 * (`server/api/routes.ts` `doorCheck`, control-tower phase 148):
 *
 *   - **202 `{requested: true, request}`** — this door may not make the press,
 *     so the server wrote it down as a request the owner confirms. Nothing was
 *     done, and a 2xx must not read as done: the press is `asked`, carrying the
 *     request the owner will see, with the server's own words for it.
 *   - **401 `{reassert: true}`** — the owner's door, a high-risk press, and the
 *     key last touched over five minutes ago. Touch it, then press ONCE more; a
 *     second refusal is the server's answer.
 *   - **403 `{door}`** — the door that pressed may not make this press at all.
 *     The refusal names the door, so the page can say how it was seen.
 *
 * And a policy write refused by a rule answers **400 `{rules}`** (or `{rule}`):
 * the refusal carries them, so the page can point at the rule rather than
 * repeat a sentence. A press bound to a run that moved on (turn-by-turn phase
 * 5: an option's body names `expectRunId`) answers **409 `{error, stale}`** —
 * the run it was asked of and the run that stands now: nothing was pressed,
 * and the item says the server's sentence where the press was made.
 *
 * Before this file each card that pressed an authority verb handled the first
 * two itself (`features/turn/owner-key.ts`), and every other press read a 202
 * as done. New screens press through `press()`; the touch is the passkey
 * ceremony, fetched only when a press asks for it.
 */

import { ApiError } from './http';
import type { AuthorityRequest } from './owner';

/** What a press came to: done, with the route's answer, or asked of the owner. */
export type Pressed<T> =
  | { state: 'done'; result: T }
  | {
      state: 'asked';
      /** The request as the owner will see it — the method, path and body it will replay. */
      request: AuthorityRequest;
      /** The server's sentence for what happened. */
      words: string;
    };

/** The run a bound press was asked of, and the run that stands now (none, when no run does). */
export type StaleBinding = { expected: string; current: string | null };

/** A 409's `stale` block, when the body carries a well-formed one. */
function staleOf(cause: ApiError): StaleBinding | null {
  if (cause.status !== 409) return null;
  const stale = (cause.body as { stale?: unknown } | undefined)?.stale as
    { expected?: unknown; current?: unknown } | null | undefined;
  if (!stale || typeof stale !== 'object' || typeof stale.expected !== 'string') return null;
  return { expected: stale.expected, current: typeof stale.current === 'string' ? stale.current : null };
}

/** A press the server refused, with the door that pressed, the rules that stopped it, or the run it went stale on. */
export class PressRefusal extends ApiError {
  /** The door the press came through, when the door is why (403). */
  readonly door: string | null;
  /** The rules a policy write broke (400). */
  readonly rules: readonly string[];
  /** The run the press was bound to, and the one that stands now, when it went stale (409). */
  readonly stale: StaleBinding | null;

  constructor(cause: ApiError) {
    super(cause.message, cause.status, cause.path, cause.body);
    this.name = 'PressRefusal';
    const body = (cause.body ?? {}) as { door?: unknown; rules?: unknown; rule?: unknown };
    this.door = cause.status === 403 && typeof body.door === 'string' ? body.door : null;
    const rules = Array.isArray(body.rules) ? body.rules : body.rule === undefined ? [] : [body.rule];
    this.rules = cause.status === 400 ? rules.filter((rule): rule is string => typeof rule === 'string') : [];
    this.stale = staleOf(cause);
  }
}

/**
 * What a request will REPLAY, in the owner's own words (#277): who asked and
 * through which door, then the method, the path and the body exactly as the
 * server holds them. The confirm prompt once composed a label of its own, and
 * a label composed on the page is a label that can misstate the press — the
 * body is what the server will send, so the body is what the owner reads.
 */
export function replayWords(
  request: Pick<AuthorityRequest, 'method' | 'path' | 'body' | 'label' | 'door'>,
): string {
  const body = request.body && Object.keys(request.body).length ? ` ${JSON.stringify(request.body)}` : '';
  return `${request.label} asked through the ${request.door} door: ${request.method} ${request.path}${body}`;
}

export interface PressOptions {
  /**
   * Touch the owner key: what a 401 `{reassert}` asks for before the one retry.
   * The passkey ceremony unless a caller (a test) says otherwise.
   */
  touch?: () => Promise<unknown>;
}

/** The passkey ceremony, fetched when a press first needs it — no page carries it otherwise. */
const touchOwnerKey = () => import('./owner').then((owner) => owner.signInAsOwner());

/** A route's 401 `{reassert: true}`: touch the key, then press again. */
const asksForTouch = (cause: unknown) =>
  cause instanceof ApiError &&
  cause.status === 401 &&
  (cause.body as { reassert?: unknown } | undefined)?.reassert === true;

function settle<T>(result: T): Pressed<T> {
  const body = result as { requested?: unknown; request?: AuthorityRequest; error?: unknown } | null;
  if (body && typeof body === 'object' && body.requested === true && body.request) {
    return {
      state: 'asked',
      request: body.request,
      words: typeof body.error === 'string' ? body.error : body.request.ask,
    };
  }
  return { state: 'done', result };
}

/**
 * Make a press. `call` is the request itself — a fetcher from `data/`, or
 * `pressVerb` — and is called at most twice: once, and once more after a
 * touch when the route asks for one.
 *
 * Resolves `done` or `asked`; rejects with a `PressRefusal` for a 400, a 403
 * or a stale 409, and with the request's own error for anything else — a 409
 * with no `stale` block (a session already on the phase) stays the route's own.
 */
export async function press<T>(call: () => Promise<T>, options: PressOptions = {}): Promise<Pressed<T>> {
  try {
    try {
      return settle(await call());
    } catch (cause) {
      if (!asksForTouch(cause)) throw cause;
      await (options.touch ?? touchOwnerKey)();
      return settle(await call());
    }
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 400 || cause.status === 403 || staleOf(cause)))
      throw new PressRefusal(cause);
    throw cause;
  }
}
