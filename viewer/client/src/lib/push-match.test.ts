/**
 * Which register row is THIS browser (one-pool phase 18, #325).
 *
 * Two Chrome browsers both subscribe through `https://fcm.googleapis.com`, so
 * matching by the push service's origin took the first one registered for
 * both, and the other browser's *Send a test* reached the wrong device. The
 * register now carries each endpoint's tag (sha256, 16 hex) and the page
 * hashes its own endpoint the same way.
 */

import { describe, expect, it } from 'vitest';
import { endpointTag, matchThisDevice } from './push-match';

const FCM = 'https://fcm.googleapis.com';

describe('matchThisDevice', () => {
  it('tells two browsers behind one push service apart by the endpoint’s tag', async () => {
    const mine = `${FCM}/fcm/send/second`;
    const tag = await endpointTag(mine);
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    const devices = [
      { id: 'first', service: FCM, endpointTag: (await endpointTag(`${FCM}/fcm/send/first`))! },
      { id: 'second', service: FCM, endpointTag: tag! },
    ];
    expect(matchThisDevice(devices, mine, tag)?.id).toBe('second');
  });

  it('hashes exactly as the server does — sha256 of the endpoint, first 16 hex', async () => {
    // sha256("abc") = ba7816bf8f01cfea…
    expect(await endpointTag('abc')).toBe('ba7816bf8f01cfea');
  });

  it('never guesses: a tagged register with no row for this tag is no device here', async () => {
    const devices = [{ id: 'other', service: FCM, endpointTag: '0000000000000000' }];
    expect(matchThisDevice(devices, `${FCM}/x`, await endpointTag(`${FCM}/x`))).toBeNull();
  });

  it('a register with no tags falls back to the service only when exactly one row carries it', () => {
    const one = [{ id: 'only', service: FCM }];
    expect(matchThisDevice(one, `${FCM}/x`, null)?.id).toBe('only');
    const two = [
      { id: 'a', service: FCM },
      { id: 'b', service: FCM },
    ];
    expect(matchThisDevice(two, `${FCM}/x`, null)).toBeNull();
  });

  it('no endpoint, or no register, is no device', () => {
    expect(matchThisDevice([{ id: 'a', service: FCM }], null, null)).toBeNull();
    expect(matchThisDevice(undefined, `${FCM}/x`, 'abc')).toBeNull();
  });
});
