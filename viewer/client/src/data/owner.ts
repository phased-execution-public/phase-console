/**
 * The owner key (control-tower phase 148, #208) — a passkey that proves a press
 * is the owner's, the owner session it buys, and the requests other doors ask
 * the owner to confirm.
 *
 * Kept out of the `data/api.ts` barrel, like `turn.ts`: no first-paint page reads
 * it (the screens are phase 138's). `enrolOwnerKey` and `signInAsOwner` run
 * the browser's half of each WebAuthn ceremony — the server's options in,
 * `navigator.credentials`, the credential out as base64url — and every check
 * that matters is the server's (`server/owner/passkey.ts`).
 */

import type {
  AuthorityRequest,
  CreationOptionsJson,
  OwnerAssertFinish,
  OwnerEnrolFinish,
  OwnerEnrolLink,
  OwnerKeyRemoved,
  OwnerLockAnswer,
  OwnerRequestConfirmed,
  OwnerRequestRefused,
  OwnerView,
  RequestOptionsJson,
} from '@shared/wire/system.js';
import { useQuery } from '@tanstack/react-query';
import { ApiError, post, request } from './http';
import { keys } from './keys';

export type {
  AuthorityRequest,
  OwnerDoorState,
  OwnerKey,
  OwnerSession,
  OwnerView,
} from '@shared/wire/system.js';

const fromB64url = (text: string): ArrayBuffer => {
  const base64 = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return bytes.buffer;
};

const toB64url = (buffer: ArrayBuffer | null): string => {
  if (!buffer) return '';
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const ownerApi = {
  owner: () => request<OwnerView>('/api/owner'),
  /** `phase-console owner enroll`'s link, or — inside an owner session — one to enrol another browser. */
  ownerEnrolLink: () => post<OwnerEnrolLink>('/api/owner/enroll/link'),
  ownerEnrolBegin: (body: { token?: string; label?: string }) =>
    post<CreationOptionsJson>('/api/owner/enroll/begin', body),
  ownerEnrolFinish: (body: { ceremony: string; label: string; credential: unknown }) =>
    post<OwnerEnrolFinish>('/api/owner/enroll/finish', body),
  ownerAssertBegin: () => post<RequestOptionsJson>('/api/owner/assert/begin'),
  ownerAssertFinish: (body: { ceremony: string; credential: unknown }) =>
    post<OwnerAssertFinish>('/api/owner/assert/finish', body),
  /** End this browser's owner session; `{all: true}` ends every one. */
  ownerLock: (all = false) => post<OwnerLockAnswer>('/api/owner/lock', all ? { all } : {}),
  ownerKeyRemove: (id: string) =>
    request<OwnerKeyRemoved>(`/api/owner/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  ownerConfirm: (id: string) =>
    post<OwnerRequestConfirmed>(`/api/owner/requests/${encodeURIComponent(id)}/confirm`),
  ownerRefuse: (id: string) =>
    post<OwnerRequestRefused>(`/api/owner/requests/${encodeURIComponent(id)}/refuse`),
};

/** Enrol a passkey: the server's options, the browser's ceremony, the server's check. */
export async function enrolOwnerKey(label: string, token?: string): Promise<OwnerEnrolFinish> {
  const options = await ownerApi.ownerEnrolBegin({ ...(token ? { token } : {}), label });
  const { publicKey } = options;
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...publicKey,
      challenge: fromB64url(publicKey.challenge),
      user: { ...publicKey.user, id: fromB64url(publicKey.user.id) },
      excludeCredentials: publicKey.excludeCredentials.map((entry) => ({
        ...entry,
        id: fromB64url(entry.id),
      })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was made.');
  const response = credential.response as AuthenticatorAttestationResponse;
  return ownerApi.ownerEnrolFinish({
    ceremony: options.ceremony,
    label,
    credential: {
      id: credential.id,
      rawId: toB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64url(response.clientDataJSON),
        attestationObject: toB64url(response.attestationObject),
      },
    },
  });
}

/** Sign in as the owner — or, inside an owner session, touch the key again for a high-risk press. */
export async function signInAsOwner(): Promise<OwnerAssertFinish> {
  const options = await ownerApi.ownerAssertBegin();
  const { publicKey } = options;
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...publicKey,
      challenge: fromB64url(publicKey.challenge),
      allowCredentials: publicKey.allowCredentials.map((entry) => ({ ...entry, id: fromB64url(entry.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey answered.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return ownerApi.ownerAssertFinish({
    ceremony: options.ceremony,
    credential: {
      id: credential.id,
      rawId: toB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: toB64url(response.clientDataJSON),
        authenticatorData: toB64url(response.authenticatorData),
        signature: toB64url(response.signature),
        userHandle: toB64url(response.userHandle),
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * The owner key in the browser (control-tower phase 138, #215; under `data/`
 * since quiet-console phase 8, where Your turn's permission card and
 * Settings ▸ Permissions ▸ Owner keys both read it).
 *
 * A passkey proves a press is the owner's. What the two screens share around
 * the two WebAuthn ceremonies: whether this browser can make one at all, the
 * `localhost` address to offer when the page is open on an IP (a passkey is
 * bound to a NAME, and the server refuses an address), what a high-risk press
 * needs from the key right now, and the one retry a route's 401
 * `{reassert: true}` asks for — touch the key, then press again. Every
 * judgement that matters is still the server's (`server/owner/passkey.ts`,
 * `server/permissions/grants.ts`).
 * ------------------------------------------------------------------ */

/** The one cache key both screens read `GET /api/owner` under — `keys.owner()`, by its older name. */
export const OWNER_QUERY_KEY = keys.owner();

/** The owner door, as `GET /api/owner` reads it — one cache entry both screens share. */
export function useOwner(enabled = true) {
  return useQuery({
    queryKey: keys.owner(),
    queryFn: () => ownerApi.owner(),
    enabled,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Can this browser make or use a passkey at all? */
export function passkeysSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.credentials)
  );
}

/** An IPv4 or IPv6 literal — a host a passkey can never be bound to. */
export function isIpHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || (host.includes(':') && /^[0-9a-f:.]+$/i.test(host));
}

/** The same page at `localhost` — what a person opens instead of an IP address. */
export function localhostAddress(location: Pick<Location, 'port' | 'protocol' | 'hash'>): string {
  const port = location.port ? `:${location.port}` : '';
  return `http://localhost${port}/${location.hash || ''}`;
}

/**
 * What a high-risk press needs from the owner key now:
 *   - `unkeyed` — no key is enrolled: the typed rule alone grants it;
 *   - `sign-in` — a key is enrolled and this browser holds no owner session;
 *   - `touch` — an owner session, but no touch inside the last five minutes;
 *   - `fresh` — touched inside five minutes: the press may go.
 */
export type OwnerGate = 'unkeyed' | 'sign-in' | 'touch' | 'fresh';

export function ownerGateOf(view: Pick<OwnerView, 'state' | 'session'> | undefined, now: number): OwnerGate {
  if (!view || view.state === 'unenrolled') return 'unkeyed';
  const session = view.session;
  if (!session) return 'sign-in';
  return session.fresh && Date.parse(session.freshUntil) > now ? 'fresh' : 'touch';
}

/** A route's 401 `{reassert: true}` — "touch the key, then press again". */
export function reassertOf(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status === 401 &&
    Boolean((cause.body as { reassert?: unknown } | undefined)?.reassert)
  );
}

/** A press an enrolled console wrote down as a request: 202 `{requested: true, request}` — not done. */
export function requestedOf(answer: unknown): AuthorityRequest | null {
  const body = answer as { requested?: unknown; request?: AuthorityRequest } | null | undefined;
  return body && body.requested === true && body.request ? body.request : null;
}

/**
 * Press, and if the route answers 401 — a stale touch, or no owner session
 * where one is needed — touch the key and press ONCE more. A second refusal is
 * the server's answer, and is thrown. (`press()` in `./press` does the same
 * for a press that also wants the 202 and the refusals read; this is the bare
 * retry the owner-keys screen uses around the ceremonies themselves.)
 */
export async function withOwnerTouch<T>(
  press: () => Promise<T>,
  touch: () => Promise<unknown> = signInAsOwner,
): Promise<T> {
  try {
    return await press();
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 401) throw cause;
    await touch();
    return press();
  }
}

/** A ceremony's failure in words — what happened, and what to do about it. */
export function ceremonyError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : '';
  if (name === 'NotAllowedError')
    return 'The passkey prompt was closed or timed out — nothing changed. Try again.';
  if (name === 'InvalidStateError') return 'This browser already holds a key for this console.';
  if (name === 'SecurityError') return 'This address cannot hold a passkey — open the console at localhost.';
  return cause instanceof Error ? cause.message : String(cause);
}
