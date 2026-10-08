/**
 * The owner key (control-tower phase 148, #208) — a passkey that proves a press
 * is the owner's, the owner session it buys, and the requests other doors ask
 * the owner to confirm.
 *
 * Kept out of the `lib/api` barrel, like `turn.ts`: no first-paint page reads
 * it (the screens are phase 138's). `enrolOwnerKey` and `signInAsOwner` run
 * the browser's half of each WebAuthn ceremony — the server's options in,
 * `navigator.credentials`, the credential out as base64url — and every check
 * that matters is the server's (`server/owner/passkey.ts`).
 */

import type { OWNER_DOOR_MODES, OWNER_DOOR_STATES } from '@shared/door-model.js';
import { post, request } from './client';

export type OwnerDoorState = (typeof OWNER_DOOR_STATES)[number];

export interface OwnerKey {
  id: string;
  alg: 'ES256' | 'EdDSA';
  label: string;
  origin: string;
  rpId: string;
  createdAt: string;
  lastUsedAt: string | null;
  counter: number;
  backedUp: boolean;
}

export interface OwnerSession {
  id: string;
  keyId: string;
  label: string;
  origin: string;
  startedAt: string;
  lastSeenAt: string;
  assertedAt: string;
  idleEndsAt: string;
  freshUntil: string;
  fresh: boolean;
}

export interface AuthorityRequest {
  id: string;
  at: string;
  state: 'open' | 'confirmed' | 'refused' | 'failed';
  door: string;
  label: string;
  press: string;
  authority: string;
  risk: string;
  method: string;
  path: string;
  body: Record<string, unknown>;
  summary: string;
  item: { kind: string; id?: string; slug?: string; phase?: number } | null;
  repeats: number;
  /** "asked by <label> through <door> — <what> — confirm?" */
  ask: string;
  settledAt?: string;
  settledBy?: string;
  result?: { status: number; error?: string };
}

export interface OwnerView {
  state: OwnerDoorState;
  mode: (typeof OWNER_DOOR_MODES)[number];
  keys: OwnerKey[];
  session: OwnerSession | null;
  requests: AuthorityRequest[];
  relyingParty: { id: string; origin: string } | { refused: string };
}

interface CreationOptionsJson {
  ceremony: string;
  publicKey: {
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { type: 'public-key'; alg: number }[];
    authenticatorSelection: AuthenticatorSelectionCriteria;
    attestation: AttestationConveyancePreference;
    timeout: number;
    excludeCredentials: { type: 'public-key'; id: string }[];
  };
}

interface RequestOptionsJson {
  ceremony: string;
  publicKey: {
    challenge: string;
    rpId: string;
    userVerification: UserVerificationRequirement;
    timeout: number;
    allowCredentials: { type: 'public-key'; id: string }[];
  };
}

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
  ownerEnrolLink: () =>
    post<{ link: string; links?: string[]; expiresAt: string; first: boolean }>('/api/owner/enroll/link'),
  ownerEnrolBegin: (body: { token?: string; label?: string }) =>
    post<CreationOptionsJson>('/api/owner/enroll/begin', body),
  ownerEnrolFinish: (body: { ceremony: string; label: string; credential: unknown }) =>
    post<{ key: OwnerKey; session: OwnerSession | null }>('/api/owner/enroll/finish', body),
  ownerAssertBegin: () => post<RequestOptionsJson>('/api/owner/assert/begin'),
  ownerAssertFinish: (body: { ceremony: string; credential: unknown }) =>
    post<{ session: OwnerSession; fresh: boolean }>('/api/owner/assert/finish', body),
  /** End this browser's owner session; `{all: true}` ends every one. */
  ownerLock: (all = false) => post<{ ended: number; state: string }>('/api/owner/lock', all ? { all } : {}),
  ownerKeyRemove: (id: string) =>
    request<{ removed: OwnerKey; state: string }>(`/api/owner/keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  ownerConfirm: (id: string) =>
    post<{ request: AuthorityRequest | null; result: { status: number; answer: unknown } }>(
      `/api/owner/requests/${encodeURIComponent(id)}/confirm`,
    ),
  ownerRefuse: (id: string) =>
    post<{ request: AuthorityRequest | null }>(`/api/owner/requests/${encodeURIComponent(id)}/refuse`),
};

/** Enrol a passkey: the server's options, the browser's ceremony, the server's check. */
export async function enrolOwnerKey(
  label: string,
  token?: string,
): Promise<{ key: OwnerKey; session: OwnerSession | null }> {
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
export async function signInAsOwner(): Promise<{ session: OwnerSession; fresh: boolean }> {
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
