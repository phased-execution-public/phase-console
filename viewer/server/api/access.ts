/**
 * Who is allowed to talk to this console.
 *
 * The console binds to loopback and, for most of its life, that IS the access
 * control: the only thing that can reach it is something already running as
 * you. `--remote` keeps that bind and puts an authenticating proxy in front of
 * it — `tailscale serve` is the case this was written for — so the console can
 * be driven from a phone without ever being exposed to a network.
 *
 * The proxy's job is to prove who is calling. It terminates TLS, authenticates
 * the caller against the tailnet, and forwards to 127.0.0.1 with the caller's
 * login in a header it sets itself. That header is only worth anything because
 * the app never leaves loopback: if the app listened on a network interface,
 * anyone could send the header themselves. Tailscale documents this exactly —
 * "it's best practice to only have the service listen on localhost" — and it is
 * why `--remote` deliberately does not widen `--host`.
 *
 * The residual risk is another process on this machine spoofing the header.
 * That is accepted: a process running as you can start `claude` itself, so the
 * console is not the weak link.
 *
 * The rule, when `--remote` is set, is a pair rather than two separate checks:
 *
 *   loopback Host + no identity header  → a local client. As it always was.
 *   remote Host   + allowlisted login   → the proxy, carrying someone allowed.
 *   anything else                       → refused.
 *
 * The "anything else" is doing real work. A caller on the tailnet can put
 * whatever they like in the Host header, so `Host: 127.0.0.1:4123` sent through
 * the proxy would otherwise read as local and skip the identity check entirely.
 * It cannot: the proxy sets the identity header on everything it forwards, and
 * a loopback Host carrying one is a combination no honest client produces.
 *
 * With `--remote` unset — the default — none of this runs and every request is
 * treated exactly as it was before this file existed.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { Flags } from '../config.ts';

/** The header `tailscale serve` fills with the authenticated caller's login. */
export const IDENTITY_HEADER = 'tailscale-user-login';

const LOOPBACK = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Is this (port-stripped) hostname one of the console's own? Shared with `actor.ts`, which derives `origin` from it. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export type Verdict =
  /**
   * `poll` marks a request the fleet supervisor made for itself (its inbox merge,
   * zero-touch phase 19): served, and not a visit — the ledger does not count it,
   * so `lastRemoteAt` keeps meaning "a phone reached this console".
   */
  | { ok: true; scope: 'local' | 'remote'; login: string | null; poll?: true }
  | { ok: false; status: number; message: string; reason: string };

/**
 * The Host header without its port.
 *
 * Bracketed IPv6 (`[::1]:4123`) and bare IPv6 (`::1`) both have to survive
 * this, so a colon alone is not enough to mean "port".
 */
export function hostnameOf(header: string | undefined): string {
  const raw = (header ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1) || raw;
  const colons = raw.split(':').length - 1;
  if (colons > 1) return raw; // bare IPv6, no port
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}


export function classify(req: IncomingMessage, flags: Flags): Verdict {
  const login = headerValue(req.headers[IDENTITY_HEADER]);

  // Local-only console: unchanged behaviour, including for anyone who runs it
  // behind their own proxy or on a wider `--host`.
  if (!flags.remoteHosts.length) return { ok: true, scope: 'local', login: null };

  const host = hostnameOf(req.headers.host);
  const loopback = LOOPBACK.has(host);

  if (loopback && !login) return { ok: true, scope: 'local', login: null };

  if (loopback) {
    return {
      ok: false,
      status: 421,
      reason: 'proxied-as-local',
      message: 'This request arrived through a proxy but asks for a local hostname. '
        + 'Use the name the proxy serves.',
    };
  }

  if (!flags.remoteHosts.includes(host)) {
    return {
      ok: false,
      status: 421,
      reason: 'unknown-host',
      message: `This console does not answer to "${host || '(no Host header)'}".`,
    };
  }

  if (!login) {
    return {
      ok: false,
      status: 403,
      reason: 'no-identity',
      message: 'No caller identity. This hostname is only reachable through an authenticating '
        + 'proxy, and the proxy did not say who you are.',
    };
  }

  if (!flags.remoteUsers.includes(login)) {
    return {
      ok: false,
      status: 403,
      reason: 'not-allowed',
      message: `${login} is not allowed to use this console.`,
    };
  }

  return { ok: true, scope: 'remote', login };
}

/**
 * A repeated header arrives as an array. Taking the first would let a caller
 * bury the real value behind one of their own, so a duplicated identity is no
 * identity at all.
 */
export function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return null;
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed || null;
}

/* ------------------------------------------------------------------ *
 * The served-request record (zero-touch phase 17, FLT-10)
 * ------------------------------------------------------------------ */

/**
 * A login, never in clear: the first 12 hex characters of its sha256 — enough
 * to tell two identities apart in a log, useless for finding out who they are.
 */
export function loginHash(login: string): string {
  return createHash('sha256').update(login).digest('hex').slice(0, 12);
}

type RemoteIdentity = { host: string; loginHash: string; first: string; last: string; count: number };

/**
 * What this console has SERVED, by scope — the ingress record that was missing.
 *
 * Only refusals were ever logged, so forty-two days of logs could not say
 * whether a phone had reached a console once: a failing proxy, an allowlist
 * that no longer matched the login Serve asserts and a phone nobody picked up
 * all read as silence. Now every served request counts (`served.local`,
 * `served.remote`, on `state().access`), each remote identity is logged ONCE
 * per process (`access.remote`, with a hashed login), and the last remote
 * request's moment is what the heartbeat writes as `lastRemoteAt`.
 *
 * `log` and `onFirstRemote` are injectable so a test can watch both without a
 * log file; the process-wide ledger below wires the real ones in `index.ts`.
 */
export class AccessLedger {
  readonly served = { local: 0, remote: 0 };
  private readonly identities = new Map<string, RemoteIdentity>();
  private last: string | null = null;
  private log: (event: 'access.remote', detail: RemoteIdentity) => void;
  private onFirstRemote: (at: string) => void;

  constructor(
    opts: {
      log?: (event: 'access.remote', detail: RemoteIdentity) => void;
      onFirstRemote?: (at: string) => void;
    } = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.onFirstRemote = opts.onFirstRemote ?? (() => {});
  }

  /** Wire the real log and the registry write — `index.ts`, once. */
  wire(opts: {
    log?: (event: 'access.remote', detail: RemoteIdentity) => void;
    onFirstRemote?: (at: string) => void;
  }): void {
    if (opts.log) this.log = opts.log;
    if (opts.onFirstRemote) this.onFirstRemote = opts.onFirstRemote;
  }

  /** One served request. A refused one is not served — `access.refused` already records it. */
  note(verdict: Verdict, host: string | undefined, now: number = Date.now()): void {
    if (!verdict.ok) return;
    // The supervisor asking for itself (its inbox merge) is not somebody reaching this console.
    if (verdict.poll) return;
    if (verdict.scope === 'local') {
      this.served.local++;
      return;
    }
    this.served.remote++;
    const at = new Date(now).toISOString();
    const firstRemote = this.last === null;
    this.last = at;
    const hash = loginHash(verdict.login ?? '');
    const seen = this.identities.get(hash);
    if (seen) {
      seen.last = at;
      seen.count++;
    } else {
      const identity: RemoteIdentity = { host: hostnameOf(host), loginHash: hash, first: at, last: at, count: 1 };
      this.identities.set(hash, identity);
      try { this.log('access.remote', { ...identity }); } catch { /* a log line must never refuse a request */ }
    }
    if (firstRemote) {
      try { this.onFirstRemote(at); } catch { /* the heartbeat writes it again on its next beat */ }
    }
  }

  lastRemoteAt(): string | null {
    return this.last;
  }

  /** What `state().access` carries: the counters, the identities (hashed) and the last remote moment. */
  snapshot(): { served: { local: number; remote: number }; lastRemoteAt: string | null; identities: RemoteIdentity[] } {
    return {
      served: { ...this.served },
      lastRemoteAt: this.last,
      identities: [...this.identities.values()].map((identity) => ({ ...identity })),
    };
  }
}

/** The process's one ledger — `index.ts` notes every served request into it. */
export const accessLedger = new AccessLedger();
