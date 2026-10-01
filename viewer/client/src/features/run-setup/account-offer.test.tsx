/**
 * The start door offers the unattended path (control-tower phase 91, #147):
 * under the paying account's meters, a login-backed account carries the
 * server's own offer of a long-lived token; a token account says when it must
 * be replaced instead.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Headroom } from './sections';

const OFFER =
  'For runs left alone for days, add a long-lived token for this login: run `claude setup-token`, sign in as the same person, and paste the token under Add account ▸ Token.';

describe("the start door's account panel", () => {
  it('offers the long-lived token under a login that lapses', () => {
    render(
      <Headroom
        account={{
          id: 'default',
          kind: 'default',
          builtIn: true,
          email: 'me@example.com',
          unattended: OFFER,
        }}
        auto={false}
      />,
    );
    expect(screen.getByText(/For runs left alone for days/)).toBeTruthy();
  });

  it('says when a token must be replaced, and offers nothing more', () => {
    render(
      <Headroom
        account={{
          id: 'tok',
          kind: 'token',
          builtIn: false,
          name: 'tok',
          tokenExpiresAt: '2027-09-26T00:00:00.000Z',
        }}
        auto={false}
      />,
    );
    expect(screen.getByText(/A long-lived token — it needs no renewing; replace it by/)).toBeTruthy();
    expect(screen.queryByText(/For runs left alone for days/)).toBeNull();
  });
});
