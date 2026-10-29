/**
 * One loopback check (measured-console phase 17, EI-39).
 *
 * Six routes asked "did this request come from this machine?" with six copies
 * of one comparison, two of them without the in-process case. This is the one
 * answer: the socket's peer is 127.0.0.1, ::1 or the v4-mapped ::ffff:127.0.0.1.
 * An EMPTY address is a request the console made of itself (a replay, a test's
 * bare request object) — loopback only where the caller says it may be, since
 * the machine-key door must never be opened by something with no socket.
 * The Host check stays the caller's: some doors read it, some read the access
 * classifier instead.
 */

import type { IncomingMessage } from 'node:http';

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackRequest(
  req: Pick<IncomingMessage, 'socket'>,
  opts: { inProcess?: boolean } = {},
): boolean {
  const address = req.socket?.remoteAddress ?? '';
  if (address === '') return opts.inProcess === true;
  return LOOPBACK_ADDRESSES.has(address);
}
