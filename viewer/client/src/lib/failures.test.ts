/**
 * Does a run's stop look like a sign-in problem? The machine-login probe is
 * believed first; a halt that talks about signing in is read even without one,
 * because the probe can be missing or stale and the reason is the run's own
 * record of what happened. An ordinary halt is never called one.
 */

import { describe, expect, it } from 'vitest';
import type { RunState } from '@/data/api';
import { looksLikeAuthFailure } from './failures';

const RUN = {
  id: 'abc1234',
  slug: 'demo',
  root: '/repo',
  status: 'running',
  halt: null,
} as unknown as RunState;

const run = (patch: Partial<RunState>): RunState => ({ ...RUN, ...patch });

describe('looksLikeAuthFailure', () => {
  it('believes the probe when it says signed out', () => {
    expect(looksLikeAuthFailure(RUN, { loggedIn: false, checkedAt: 'x' })).toBe(true);
  });

  it('reads a halt that talks about signing in, even with no probe', () => {
    const halted = run({ halt: { at: 'x', reason: 'the session was not signed in' } });
    expect(looksLikeAuthFailure(halted, undefined)).toBe(true);
    expect(looksLikeAuthFailure(run({ halt: { at: 'x', reason: 'authenticate first' } }), undefined)).toBe(
      true,
    );
  });

  it('does not cry wolf over an ordinary halt', () => {
    expect(looksLikeAuthFailure(run({ halt: { at: 'x', reason: 'no handoff written' } }), undefined)).toBe(
      false,
    );
    expect(looksLikeAuthFailure(RUN, { loggedIn: true, checkedAt: 'x' })).toBe(false);
  });
});
