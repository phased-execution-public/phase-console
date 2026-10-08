/**
 * The owner key's presses (control-tower phase 148, #208): enrol, sign in,
 * lock, remove a key — and the owner's answer to a request. The router hands
 * each one here through ONE `Service` method (`ownerPress`, `answerOwnerRequest`
 * — both in `AUTHORITY_METHODS`), so the table of authority routes is held both
 * ways for these presses as for every other.
 *
 * Every rule of §Architecture 19's owner door that is not the WebAuthn check
 * itself (`passkey.ts`) is here:
 *
 *   - the FIRST key only at the machine, through `phase-console owner enroll`'s
 *     one-time link (ten minutes), opened at `localhost`;
 *   - a later key only inside an owner session with the key touched in the
 *     last five minutes — or through a link the owner minted that way, for
 *     another browser (a phone at the console's https host);
 *   - a removal only inside an owner session, fresh, ending that key's sessions;
 *   - `lock` ends this browser's session, or — from the machine — every one;
 *   - a request is answered by the owner alone, in one press; a high-risk one
 *     needs a fresh touch.
 */

import { createHash, randomBytes } from 'node:crypto';

import { OWNER_DOOR_MODES, OWNER_LINK_MS } from '../../shared/door-model.js';
import { RISK_TIERS } from '../../shared/turn-model.js';
import type { DoorReading, OwnerState } from './door.ts';
import { PasskeyError, verifyAssertion, verifyRegistration, type RelyingParty } from './passkey.ts';
import { keyLabel, keyView, type OwnerKeyRow } from './registry.ts';
import { requestView, type AuthorityRequest } from './requests.ts';
import { OwnerSessions, clearedOwnerCookie, ownerCookie } from './session.ts';

/** A press's answer: the status, the body, and the cookie to set when the press set one. */
export type OwnerAnswer = { status: number; body: Record<string, unknown>; cookie?: string };

/** What a press is: the route's segments after `/api/owner/`, its door, its body. */
export type OwnerPressInput = {
  method: string;
  rest: readonly string[];
  reading: DoorReading;
  body: Record<string, unknown>;
  /** The press's label (`actorOfRequest(...).by`). */
  by: string;
  /** A loopback socket, a loopback Host, nothing a proxy vouched for, door `local`. */
  atTheMachine: boolean;
};

/** What a press needs from the console. */
export type OwnerPressDeps = {
  state: OwnerState;
  rp: RelyingParty;
  cookieName: string;
  port: number;
  remoteHosts: readonly string[];
  instanceName: string;
  noteKey: (change: 'enrolled' | 'removed', key: OwnerKeyRow, by: string, door: string) => void;
  now?: number;
};

const HIGH_RISK = RISK_TIERS[2];

/** At most this many enrol links wait at once; a new one past it pushes out the oldest. */
const LINKS_MAX = 16;

/** A link token's key in the in-memory map — its sha256; the token itself is never kept. */
export const linkKey = (token: string): string => createHash('sha256').update(token).digest('hex');

const faulted = (error: unknown): OwnerAnswer => ({
  status: 400,
  body: error instanceof PasskeyError
    ? { error: error.message, fault: error.fault }
    : { error: (error as Error)?.message ?? 'that ceremony could not be read' },
});

const needOwner = (why: string): OwnerAnswer => ({ status: 401, body: { error: `${why} is the owner's — sign in with your owner key first.`, owner: false } });

const needFresh = (why: string): OwnerAnswer => ({
  status: 401,
  body: { error: `${why} carries high risk: touch your owner key again — the last touch was over five minutes ago.`, reassert: true },
});

/** The owner session this request's door names, alive now — or null. */
function ownSessionOf(state: OwnerState, reading: DoorReading, now: number) {
  return reading.door === 'owner' && reading.proof === 'owner-session' && reading.sessionId
    ? (state.sessions.live(now).find((session) => session.id === reading.sessionId) ?? null)
    : null;
}

/** `POST /api/owner/enroll/link|begin|finish`, `/assert/begin|finish`, `/lock`, `DELETE /api/owner/keys/:id`. */
export function ownerPress(deps: OwnerPressDeps, input: OwnerPressInput): OwnerAnswer {
  const { state, rp } = deps;
  const now = deps.now ?? Date.now();
  const { reading, body, by } = input;
  const [sub = '', verb = ''] = input.rest;
  const secure = rp.ok && rp.secure;
  const enrolled = state.registry.count() > 0;
  const ownSession = ownSessionOf(state, reading, now);
  const liveLink = (token: unknown) => {
    for (const [key, link] of state.links) if (now > link.expiresAt) state.links.delete(key);
    return typeof token === 'string' && token ? (state.links.get(linkKey(token)) ?? null) : null;
  };

  // The one-time link: the FIRST key's, at the machine; a later key's, from
  // inside an owner session (to enrol another browser, a phone among them).
  if (input.method === 'POST' && sub === 'enroll' && verb === 'link' && input.rest.length === 2) {
    if (enrolled && reading.door !== 'owner') {
      return { status: 409, body: { error: 'This console already has an owner key. Add another from a browser signed in as the owner — Settings ▸ Owner key.' } };
    }
    if (!enrolled && !input.atTheMachine) {
      return { status: 403, body: { error: 'The first owner key is enrolled at the machine: run `phase-console owner enroll` there.' } };
    }
    if (enrolled && reading.fresh !== true) return needFresh('Enrolling another key');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + OWNER_LINK_MS;
    liveLink(null);
    while (state.links.size >= LINKS_MAX) state.links.delete(state.links.keys().next().value!);
    state.links.set(linkKey(token), { expiresAt, mintedBy: enrolled ? 'owner' : 'machine' });
    const base = enrolled && rp.ok ? rp.origin : `http://localhost:${deps.port}`;
    // A later key is often another device's: the owner's link names every
    // https address this console serves too, for a phone to open.
    const elsewhere = enrolled ? deps.remoteHosts.map((host) => `https://${host}/#/settings/permissions?enrol=${token}`) : [];
    return {
      status: 200,
      body: {
        link: `${base}/#/settings/permissions?enrol=${token}`, ...(elsewhere.length ? { links: elsewhere } : {}),
        expiresAt: new Date(expiresAt).toISOString(), first: !enrolled,
      },
    };
  }

  // The registration ceremony.
  if (input.method === 'POST' && sub === 'enroll' && (verb === 'begin' || verb === 'finish') && input.rest.length === 2) {
    if (!rp.ok) return { status: 400, body: { error: rp.reason } };
    if (verb === 'begin') {
      const link = liveLink(body.token);
      if (!enrolled) {
        if (!link || link.mintedBy !== 'machine' || !input.atTheMachine) {
          return { status: 403, body: { error: 'The first owner key is enrolled at the machine, from the link `phase-console owner enroll` prints — it is good once, for ten minutes.' } };
        }
      } else if (!link || link.mintedBy !== 'owner') {
        // With a key, only the owner — or a link the owner minted — enrols another.
        if (reading.door !== 'owner') return needOwner('Enrolling another key');
        if (reading.fresh !== true) return needFresh('Enrolling another key');
      }
      const ceremony = state.ceremonies.begin('create', rp, {
        ...(link && (!enrolled || link.mintedBy === 'owner') ? { link: linkKey(String(body.token)) } : {}),
      ...(reading.sessionId ? { session: reading.sessionId } : {}),
      }, now);
      return {
        status: 200,
        body: {
          ceremony: ceremony.id,
          publicKey: {
            challenge: ceremony.challenge,
            rp: { id: rp.rpId, name: `Phase Console — ${deps.instanceName}` },
            user: { id: state.registry.userId(), name: `owner@${deps.instanceName}`, displayName: `The owner of Phase Console ${deps.instanceName}` },
            pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
            attestation: 'none',
            timeout: ceremony.expiresAt - now,
            excludeCredentials: state.registry.list().filter((key) => key.rpId === rp.rpId).map((key) => ({ type: 'public-key', id: key.id })),
          },
        },
      };
    }
    const ceremony = state.ceremonies.take(body.ceremony, 'create', now);
    if (ceremony instanceof PasskeyError) return faulted(ceremony);
    if (ceremony.origin !== rp.origin) return faulted(new PasskeyError('origin', 'the ceremony was begun at another origin'));
    const linkHash = ceremony.context.link;
    const link = linkHash ? (state.links.get(linkHash) ?? null) : null;
    if (linkHash && (!link || now > link.expiresAt)) {
      return { status: 403, body: { error: 'The enrol link was used already, or its ten minutes are up — ask for a new one.' } };
    }
    // Without a link, the session that began the ceremony finishes it.
    if (!linkHash && (!enrolled || reading.door !== 'owner' || ceremony.context.session !== reading.sessionId)) {
      return needOwner('Enrolling another key');
    }
    let registered;
    try {
      registered = verifyRegistration(body.credential, { challenge: ceremony.challenge, origin: ceremony.origin, rpId: ceremony.rpId });
    } catch (error) {
      return faulted(error);
    }
    const stamp = new Date(now).toISOString();
    const row: OwnerKeyRow = {
      id: registered.credentialId, publicKey: registered.publicKey, alg: registered.alg, label: keyLabel(body.label),
      origin: ceremony.origin, rpId: ceremony.rpId, createdAt: stamp, lastUsedAt: stamp, counter: registered.signCount,
      backedUp: registered.backedUp,
    };
    const added = state.registry.add(row, by);
    if (!added.ok) return { status: 409, body: { error: added.reason } };
    if (linkHash) state.links.delete(linkHash);
    // The first key closes the machine's door: any other first-key link left standing is void.
    for (const [key, standing] of state.links) if (standing.mintedBy === 'machine') state.links.delete(key);
    deps.noteKey('enrolled', row, by, reading.door);
    // The person just proved themselves with this key in this browser: unless
    // it is the owner's already, it is now — the session starts here.
    if (ownSession) return { status: 201, body: { key: keyView(row), session: ownSession } };
    const started = state.sessions.start({ id: row.id, label: row.label }, ceremony.origin, now);
    return { status: 201, body: { key: keyView(row), session: started.session }, cookie: ownerCookie(deps.cookieName, started.cookieValue, secure) };
  }

  // Sign in, or a fresh touch inside a session.
  if (input.method === 'POST' && sub === 'assert' && (verb === 'begin' || verb === 'finish') && input.rest.length === 2) {
    if (!rp.ok) return { status: 400, body: { error: rp.reason } };
    if (!enrolled) return { status: 409, body: { error: 'No owner key is enrolled here — run `phase-console owner enroll` at the machine.' } };
    if (verb === 'begin') {
      const ceremony = state.ceremonies.begin('get', rp, reading.sessionId ? { session: reading.sessionId } : {}, now);
      return {
        status: 200,
        body: {
          ceremony: ceremony.id,
          publicKey: {
            challenge: ceremony.challenge, rpId: rp.rpId, userVerification: 'required', timeout: ceremony.expiresAt - now,
            allowCredentials: state.registry.list().filter((key) => key.rpId === rp.rpId).map((key) => ({ type: 'public-key', id: key.id })),
          },
        },
      };
    }
    const ceremony = state.ceremonies.take(body.ceremony, 'get', now);
    if (ceremony instanceof PasskeyError) return faulted(ceremony);
    if (ceremony.origin !== rp.origin) return faulted(new PasskeyError('origin', 'the ceremony was begun at another origin'));
    const offered = (body.credential as { id?: unknown } | null)?.id;
    const key = state.registry.get(typeof offered === 'string' ? offered.replace(/=+$/, '') : '');
    if (!key || key.rpId !== ceremony.rpId) return faulted(new PasskeyError('credential', 'that is not an owner key of this console'));
    let signCount: number;
    try {
      ({ signCount } = verifyAssertion(body.credential, key, { challenge: ceremony.challenge, origin: ceremony.origin, rpId: ceremony.rpId }));
    } catch (error) {
      return faulted(error);
    }
    state.registry.used(key.id, signCount, new Date(now).toISOString());
    if (ownSession) {
      const touched = state.sessions.asserted(ownSession.id, now);
      return { status: 200, body: { session: touched ? OwnerSessions.view(touched, now) : ownSession, fresh: true } };
    }
    const started = state.sessions.start({ id: key.id, label: key.label }, ceremony.origin, now);
    return { status: 200, body: { session: started.session, fresh: true }, cookie: ownerCookie(deps.cookieName, started.cookieValue, secure) };
  }

  // Lock: this browser's session — or, with none (the CLI at the machine) or `{all: true}`, every one.
  if (input.method === 'POST' && sub === 'lock' && input.rest.length === 1) {
    if ((!ownSession || body.all === true) && reading.door !== 'owner' && !input.atTheMachine) {
      return {
        status: 403,
        body: { error: 'Ending every owner session is the owner\'s, or the machine\'s — run `phase-console owner lock` there.' },
      };
    }
    const ended = ownSession && body.all !== true ? (state.sessions.end(ownSession.id, now) ? 1 : 0) : state.sessions.endAll(now);
    return {
      status: 200,
      body: { ended, state: state.registry.count() > 0 ? OWNER_DOOR_MODES[1] : OWNER_DOOR_MODES[0] },
      cookie: clearedOwnerCookie(deps.cookieName, secure),
    };
  }

  // Remove a key: inside an owner session, with a fresh touch.
  if (input.method === 'DELETE' && sub === 'keys' && input.rest.length === 2) {
    if (reading.door !== 'owner') return needOwner('Removing an owner key');
    if (reading.fresh !== true) return needFresh('Removing an owner key');
    const removed = state.registry.remove(verb, by, new Date(now).toISOString());
    if (!removed) return { status: 404, body: { error: 'no such owner key' } };
    state.sessions.endAll(now, removed.id);
    deps.noteKey('removed', removed, by, reading.door);
    return {
      status: 200,
      body: { removed: keyView(removed), state: state.registry.count() > 0 ? OWNER_DOOR_MODES[1] : OWNER_DOOR_MODES[0] },
      ...(reading.keyId === removed.id ? { cookie: clearedOwnerCookie(deps.cookieName, secure) } : {}),
    };
  }
  return { status: 404, body: { error: 'no such owner route' } };
}

/**
 * `POST /api/owner/requests/:id/confirm|refuse` — the owner's one press. A
 * confirmed request is pressed as asked, through the owner's door (`press`,
 * the router's own replay); a refused one is pressed by nobody.
 */
export async function answerRequest(
  deps: {
    state: OwnerState;
    press: (request: AuthorityRequest) => Promise<{ status: number; answer: unknown }>;
    note: (answer: 'confirmed' | 'failed' | 'refused', record: Record<string, unknown>) => void;
    now?: number;
  },
  input: { id: string; answer: string; reading: DoorReading; by: string },
): Promise<OwnerAnswer> {
  const { state } = deps;
  const { reading } = input;
  const now = deps.now ?? Date.now();
  if (reading.door !== 'owner') return needOwner('Answering a request');
  const request = state.requests.get(input.id);
  if (!request) return { status: 404, body: { error: 'no such request' } };
  if (request.state !== 'open') return { status: 409, body: { error: `that request was ${request.state} already`, request: requestView(request) } };
  const who = reading.label ?? input.by;
  const record = { id: request.id, press: request.press, authority: request.authority, door: request.door, label: request.label, by: who };
  if (input.answer === 'refuse') {
    const settled = state.requests.settle(request.id, 'refused', who, undefined, now);
    deps.note('refused', record);
    return { status: 200, body: { request: settled ? requestView(settled) : null } };
  }
  if (request.risk === HIGH_RISK && reading.fresh !== true) return needFresh(request.summary.split(' — ')[0]!);
  const pressed = await deps.press(request);
  const failed = pressed.status >= 400;
  const error = failed && pressed.answer && typeof pressed.answer === 'object' ? String((pressed.answer as { error?: unknown }).error ?? '') : '';
  const settled = state.requests.settle(request.id, failed ? 'failed' : 'confirmed', who,
    { status: pressed.status, ...(error ? { error: error.slice(0, 400) } : {}) }, now);
  deps.note(failed ? 'failed' : 'confirmed', { ...record, status: pressed.status });
  return { status: failed ? 409 : 200, body: { request: settled ? requestView(settled) : null, result: pressed } };
}
