/**
 * The owner key in the browser (control-tower phase 138, #215; the API is
 * phase 148's `lib/api/owner.ts`).
 *
 * A passkey proves a press is the owner's. This file is what the permission
 * card and Settings ▸ Permissions ▸ Owner keys share around the two WebAuthn
 * ceremonies: whether this browser can make one at all, the `localhost`
 * address to offer when the page is open on an IP (a passkey is bound to a
 * NAME, and the server refuses an address), what a high-risk press needs from
 * the key right now, and the one retry a route's 401 `{reassert: true}` asks
 * for — touch the key, then press again. Every judgement that matters is still
 * the server's (`server/owner/passkey.ts`, `server/permissions/grants.ts`).
 */

import { ApiError } from '@/lib/api/client';
import {
  enrolOwnerKey,
  ownerApi,
  signInAsOwner,
  type AuthorityRequest,
  type OwnerView,
} from '@/lib/api/owner';

export { enrolOwnerKey, ownerApi, signInAsOwner };

/** The one cache key both screens read `GET /api/owner` under — kept here, off first paint. */
export const OWNER_QUERY_KEY = ['owner'] as const;

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
 * the server's answer, and is thrown.
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
