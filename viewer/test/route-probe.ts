/**
 * Ask the router itself whether it serves a method and a path — the probe
 * `console-forge.test.ts` (CF-5) and `surface-parity.test.ts` share.
 *
 * A text parse can say a head and a verb exist; only the router can say which
 * METHOD it answers on which path, because the method checks are spread
 * through every branch. So the request is made for real, through `handleApi`,
 * against a service with nothing behind it — its capability flags open, or the
 * set the caller asks for (`FLAGS_ON`, `FLAGS_OFF`): a served route gets past
 * its guard and fails on the first method it calls (a 500, or whatever its
 * guard answers), and a path no route serves is the router's own 404 or 405.
 */

// Before anything reaches `server/`: the router's module graph resolves the
// console's state directory at load.
import './state-sandbox.ts';

import { tmpdir } from 'node:os';
import { handleApi } from '../server/api/routes.ts';
import { CAPABILITY_WORDS } from '../shared/capability-model.js';

export type ProbeAnswer = { status: number; body: string };

/** The service's flags a probe runs under: a capability field per flag, true or false. */
export type ProbeFlags = Readonly<Record<string, boolean>>;

/** The three CF-5 has always probed with: enough to get past the write, run and account guards. */
const DEFAULT_FLAGS: ProbeFlags = { allowWrites: true, allowRun: true, allowAccounts: true };

/** Every capability on — no guard answers before the route does, so what answers is the route. */
export const FLAGS_ON: ProbeFlags = Object.fromEntries(CAPABILITY_WORDS.map((word) => [word.field, true]));

/** Every capability off — so a route's own guard answers, and names the flag it wants. */
export const FLAGS_OFF: ProbeFlags = Object.fromEntries(CAPABILITY_WORDS.map((word) => [word.field, false]));

/** One request through the router, with a JSON `{}` body and the console's header. */
export async function probe(
  method: string,
  path: string,
  { flags = DEFAULT_FLAGS }: { flags?: ProbeFlags } = {},
): Promise<ProbeAnswer> {
  let status = 0;
  let body = '';
  const req = {
    method,
    url: path,
    headers: { 'x-phase-console': '1', host: '127.0.0.1:4130', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    on() {
      return this;
    },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from('{}', 'utf8');
    },
  };
  const res = {
    req,
    writeHead(code: number) {
      status = code;
      return this;
    },
    setHeader() {},
    write(chunk?: string) {
      body += chunk ?? '';
      return true;
    },
    end(chunk?: string) {
      body += chunk ?? '';
    },
    on() {
      return this;
    },
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
  };
  const service = {
    root: { ok: true, path: tmpdir() },
    store: {},
    flags: { ...flags, remoteHosts: [] as string[] },
  };
  try {
    await handleApi({ service } as never, req as never, res as never, new URL(`http://127.0.0.1:4130${path}`));
  } catch {
    // A served route that reached the empty service threw past the router's
    // own handler: served all the same.
    if (!status) status = 500;
  }
  return { status, body };
}

/** The router's own "no such route" — a 405, or a 404 that says it found no route or verb. */
export const unrouted = ({ status, body }: ProbeAnswer): boolean =>
  status === 405 || (status === 404 && /No API route|No run verb|a step has no verb/.test(body));

/**
 * What a head answers for a word under it that it does not have — a lane or a
 * trigger verb, a repository surface, a message's or a draft's act, an owner
 * press. `unrouted` reads those as served, which is right for CF-5's rows (a
 * prefix the router extends) and wrong for a row that must be a whole route.
 */
const NO_SUCH_SUB_ROUTE: readonly string[] = [
  'unknown repository surface',
  'takes /',
  'no lane verb',
  'no such owner route',
];

/** The router's "no such route" at any depth: its own 404 or 405, or a head's 404 for a sub-route it lacks. */
export const noRoute = (answer: ProbeAnswer): boolean =>
  unrouted(answer) || (answer.status === 404 && NO_SUCH_SUB_ROUTE.some((words) => answer.body.includes(words)));

/** A `:name` pattern filled with a value the router accepts — `3` for a phase, `demo` for the rest. */
export const fill = (path: string): string =>
  path.replace(/:([a-z]+)/g, (_, name: string) => (name === 'phase' || name === 'n' ? '3' : 'demo'));
