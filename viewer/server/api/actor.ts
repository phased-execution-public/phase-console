/**
 * The derived actor for an HTTP request — the request half of `../actor.ts`.
 *
 * Lives beside `access.ts` because it reads the same three facts that layer
 * reads (the Host header, the proxy's identity header, the User-Agent), and
 * apart from the runner because the runner must never import from `api/`.
 */

import type { IncomingMessage } from 'node:http';

import { headerValue, hostnameOf, IDENTITY_HEADER, isLoopbackHost } from './access.ts';
import type { Flags } from '../config.ts';
import type { Actor, ActorVia } from '../runner/state.ts';

/* ------------------------------------------------------------------ *
 * The request's actor
 * ------------------------------------------------------------------ */

/**
 * What kind of client sent a request, read off its User-Agent.
 *
 * Three classes and an absence. `browser` is anything Mozilla-shaped, which
 * is every browser there is; `cli` is the console's own command-line tools,
 * which announce themselves; `script` is everything else — curl, a fetch from
 * node or python, a webhook relay — and is the class the audit could not
 * tell from the operator (SHD-3). `none` is a request that said nothing.
 */
export type AgentClass = 'browser' | 'cli' | 'script' | 'none';

export function agentClassOf(userAgent: string | string[] | undefined): AgentClass {
  const ua = Array.isArray(userAgent) ? userAgent[0] : userAgent;
  if (!ua || !ua.trim()) return 'none';
  if (/^(phase-console|btw)\b/i.test(ua.trim())) return 'cli';
  if (/\bMozilla\/\d/.test(ua)) return 'browser';
  return 'script';
}

/** The longest label a body may offer for `by` — the same bound the routes always applied. */
export const ACTOR_LABEL_MAX = 64;

/**
 * The derived actor for one HTTP request.
 *
 * `by` is the body's label when it offers one, else the proxy's login, else
 * the class of thing that asked. `via`, `origin` and `remoteUser` come from
 * the transport alone. The identity header is read only under `--remote`:
 * without it `classify()` never checks the header, so nothing has vouched
 * for it, and a loopback caller could write any name it liked into the
 * record.
 */
export function actorOfRequest(
  req: Pick<IncomingMessage, 'headers'>,
  flags: Partial<Pick<Flags, 'remoteHosts'>>,
  body: { by?: unknown } | null | undefined = undefined,
): Actor {
  const offered = typeof body?.by === 'string' ? body.by.trim().slice(0, ACTOR_LABEL_MAX) : '';
  const host = hostnameOf(req.headers.host);
  const loopback = isLoopbackHost(host);
  // `remoteHosts` is always an array on a real console; a harness's flags may
  // carry no such key, and a route must not 500 for want of one.
  const remote = (flags.remoteHosts ?? []).length > 0;
  const remoteUser = remote && !loopback ? headerValue(req.headers[IDENTITY_HEADER]) : null;
  const agent = agentClassOf(req.headers['user-agent']);
  const via: ActorVia = agent === 'cli' ? 'cli' : 'api';
  const origin = loopback ? 'local' : host;
  const by = offered || remoteUser || (agent === 'browser' || agent === 'cli' ? 'operator' : 'script');
  return { by, via, origin, remoteUser };
}

