/**
 * The owner-key tests' shared harness (control-tower phase 148): a console's
 * router with an owner state of its own, a browser that keeps its cookie, and
 * the two ceremonies driven end to end with a software authenticator.
 */

import './state-sandbox.ts';

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR } from '../server/config.ts';
import { Service } from '../server/service.ts';
import { handleApi } from '../server/api/routes.ts';
import { installOwnerState, ownerStateAt, type OwnerState } from '../server/owner/door.ts';
import type { SoftAuthenticator } from './webauthn-authenticator.ts';

export const PORT = 4130;
export const ORIGIN = `http://localhost:${PORT}`;
export const REMOTE_HOST = 'mac.tailnet.ts.net';

export const flags = {
  port: PORT, host: '127.0.0.1', open: false, allowWrites: true, allowRun: true, allowAccounts: true,
  scriptsDir: `${SKILL_DIR}/scripts`, logFile: null, remoteHosts: [REMOTE_HOST] as string[], remoteUsers: [] as string[],
};

/** A fresh owner state in a directory of its own — every test starts unenrolled. */
export function freshOwnerState(): OwnerState & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-owner-'));
  const state = ownerStateAt(dir);
  installOwnerState(state);
  return Object.assign(state, { dir });
}

export type CallOptions = {
  headers?: Record<string, string>;
  body?: unknown;
  /** The socket's address — loopback unless a test says otherwise. */
  remote?: string;
  host?: string;
};

/** One request through the real router: the status, the parsed answer and any `Set-Cookie`. */
export async function call(service: Service, method: string, path: string, opts: CallOptions = {}) {
  let status = 0;
  let raw = '';
  const cookies: string[] = [];
  const body = opts.body ?? {};
  const req = {
    method,
    url: path,
    headers: { 'x-phase-console': '1', host: opts.host ?? `localhost:${PORT}`, 'content-type': 'application/json', ...opts.headers },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    on() { return this; },
    [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body), 'utf8'); },
  };
  const res = {
    req,
    writeHead(code: number) { status = code; return this; },
    setHeader(name: string, value: string | string[]) {
      if (name.toLowerCase() === 'set-cookie') cookies.push(...(Array.isArray(value) ? value : [value]));
    },
    end(chunk?: string | Buffer) { raw += chunk ? chunk.toString() : ''; },
    on() { return this; },
  };
  await handleApi({ service } as never, req as never, res as never, new URL(`http://localhost:${PORT}${path}`));
  let answer: Record<string, unknown> = {};
  try { answer = JSON.parse(raw) as Record<string, unknown>; } catch { answer = { raw }; }
  return { status, answer, cookies };
}

/** A browser at one host: it sends the cookie it was given back, the way a browser does. */
export class Browser {
  cookie: string | null = null;
  readonly service: Service;
  readonly host: string;

  constructor(service: Service, host = `localhost:${PORT}`) {
    this.service = service;
    this.host = host;
  }

  async call(method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) {
    const answer = await call(this.service, method, path, {
      host: this.host, body, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    for (const line of answer.cookies) {
      const [pair] = line.split(';');
      const value = pair!.slice(pair!.indexOf('=') + 1);
      this.cookie = value ? pair! : null;
    }
    return answer;
  }
}

export const newService = (): Service => new Service(flags as never);

/** `phase-console owner enroll` at the machine: the link's token. */
export async function enrolLink(service: Service): Promise<string> {
  const minted = await call(service, 'POST', '/api/owner/enroll/link', { host: `127.0.0.1:${PORT}` });
  assert.equal(minted.status, 200, JSON.stringify(minted.answer));
  return new URL(String(minted.answer.link).replace('#', '')).searchParams.get('enrol')!;
}

/** Enrol a key in this browser — the first one by the machine's link, a later one inside the owner session. */
export async function enrol(browser: Browser, authenticator: SoftAuthenticator, opts: { label?: string; token?: string; origin?: string; rpId?: string } = {}) {
  const begun = await browser.call('POST', '/api/owner/enroll/begin', { ...(opts.token ? { token: opts.token } : {}), label: opts.label ?? 'MacBook' });
  if (begun.status !== 200) return begun;
  const publicKey = begun.answer.publicKey as { challenge: string };
  const credential = authenticator.register({ challenge: publicKey.challenge, origin: opts.origin ?? ORIGIN, rpId: opts.rpId ?? 'localhost' });
  return browser.call('POST', '/api/owner/enroll/finish', { ceremony: begun.answer.ceremony, label: opts.label ?? 'MacBook', credential });
}

/** The machine's first key, enrolled from its link — the console is enrolled after this. */
export async function enrolFirst(service: Service, browser: Browser, authenticator: SoftAuthenticator, label = 'MacBook') {
  const finished = await enrol(browser, authenticator, { token: await enrolLink(service), label });
  assert.equal(finished.status, 201, JSON.stringify(finished.answer));
  return finished;
}

/** Sign in (or touch the key again) with an enrolled key. */
export async function signIn(browser: Browser, authenticator: SoftAuthenticator, signCount = 0, ceremony: Partial<{ uv: boolean; origin: string }> = {}) {
  const begun = await browser.call('POST', '/api/owner/assert/begin');
  assert.equal(begun.status, 200, JSON.stringify(begun.answer));
  const publicKey = begun.answer.publicKey as { challenge: string; rpId: string };
  const credential = authenticator.assert({ challenge: publicKey.challenge, origin: ceremony.origin ?? ORIGIN, rpId: publicKey.rpId, signCount, ...(ceremony.uv === false ? { uv: false } : {}) });
  return browser.call('POST', '/api/owner/assert/finish', { ceremony: begun.answer.ceremony, credential });
}
