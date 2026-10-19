/**
 * Which register row is THIS browser (one-pool phase 18, #325) — apart from
 * `lib/push.ts` because it is pure: no permission, no worker, no request.
 */

/**
 * The page's handle on an endpoint — sha256, first 16 hex characters — the
 * same as the server's `endpointTag` (`server/push/index.ts`). Null where the
 * browser has no `crypto.subtle` (an insecure context, where push is off anyway).
 */
export async function endpointTag(endpoint: string): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Which register row is THIS browser (one-pool phase 18, #325).
 *
 * By the endpoint's tag, exactly: two Chrome browsers both subscribe through
 * `https://fcm.googleapis.com`, so the push service's origin alone took the
 * first one registered for both — the other's *Send a test* reached the wrong
 * device. A register whose rows carry no tag (a console from before the tag)
 * falls back to the origin only when exactly ONE row carries it; two rows on
 * one service with no tag are no answer, never a guess.
 */
export function matchThisDevice<T extends { service?: string; endpointTag?: string }>(
  devices: readonly T[] | undefined,
  endpoint: string | null,
  tag: string | null,
): T | null {
  if (!devices?.length || !endpoint) return null;
  if (tag) {
    const exact = devices.find((device) => device.endpointTag === tag);
    if (exact) return exact;
  }
  if (devices.some((device) => device.endpointTag)) return null;
  const sameService = devices.filter((device) => device.service && endpoint.startsWith(device.service));
  return sameService.length === 1 ? sameService[0]! : null;
}
