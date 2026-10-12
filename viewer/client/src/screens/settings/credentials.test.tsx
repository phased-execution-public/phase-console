/**
 * Settings ▸ Accounts, what this machine holds (quiet-console phase 26): every
 * credential id the server is asked about, as a dot and a word with its
 * reason — never a value, which the server never sends — opened in place to
 * its kind and the plans that name it. Check again asks past the server's
 * minute for one id (`ids: [id]`) or every one (no ids), and the answer,
 * which is the whole view, is what every row then shows.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeldCredentials } from '@/data/machine';
import { renderWithClient, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// What a failed press came to is a toast, and the tray is the shell's: the assertion is on what was raised.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { ApiError } from '@/data/http';
import { CredentialsGroup } from './credentials';

const HELD: HeldCredentials = {
  at: '2026-10-12T09:58:00.000Z',
  cacheMs: 60_000,
  credentials: [
    { id: 'gh', status: 'ok', reason: 'gh auth status exits 0', known: true, named: [] },
    {
      id: 'env:STRIPE_KEY',
      status: 'fail',
      reason: 'the variable is not set in the console’s environment',
      known: true,
      named: [{ slug: 'alpha' }, { slug: 'alpha', phase: 3 }],
    },
    {
      id: 'vault:payments',
      status: 'skip',
      reason: 'no probe for vault: ids on this machine',
      known: false,
      named: [{ slug: 'beta', phase: 2 }],
    },
  ],
};

/** The same view after a probe found the variable set. */
const FOUND: HeldCredentials = {
  ...HELD,
  at: '2026-10-12T10:00:00.000Z',
  credentials: HELD.credentials.map((one) =>
    one.id === 'env:STRIPE_KEY' ? { ...one, status: 'ok', reason: 'the variable is set' } : one,
  ),
};

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-credential="${id}"]`)!;

beforeEach(() => {
  server.calls = [];
  server.reads = { '/api/credentials': HELD, 'POST /api/credentials/probe': FOUND };
  toast.mockClear();
});

describe('what this machine holds', () => {
  it('each id is a dot and a word with its reason, and the read says when it was made', async () => {
    renderWithClient(<CredentialsGroup />);
    const list = await screen.findByTestId('credential-list');
    expect(
      [...list.querySelectorAll('[data-credential]')].map((row) => row.getAttribute('data-credential')),
    ).toEqual(['gh', 'env:STRIPE_KEY', 'vault:payments']);
    expect(
      ['gh', 'env:STRIPE_KEY', 'vault:payments'].map(
        (id) => rowOf(id).querySelector('[data-vocab="probe"]')?.textContent,
      ),
    ).toEqual(['OK', 'Fail', 'Not asked']);
    expect(rowOf('env:STRIPE_KEY')).toHaveTextContent('the variable is not set in the console’s environment');
    expect(screen.getByTestId('credentials-read')).toHaveTextContent('An answer is reused for a minute');
    // A read, never a press: nothing was sent but the one GET.
    expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/credentials']);
  });

  it('a row opened in place says whether its kind is known and which plans and phases name it', async () => {
    renderWithClient(<CredentialsGroup />);
    await screen.findByTestId('credential-list');
    fireEvent.click(screen.getByRole('button', { name: 'Show details of env:STRIPE_KEY' }));
    const row = rowOf('env:STRIPE_KEY');
    expect(row).toHaveTextContent('The console knows how to ask about an id like this.');
    expect(within(row).getByRole('link', { name: 'alpha' })).toHaveAttribute('href', '#/plan/alpha/phases');
    expect(within(row).getByRole('link', { name: 'alpha P3' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phase/3',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show details of vault:payments' }));
    expect(rowOf('vault:payments')).toHaveTextContent(
      'No probe here knows an id like this, so it is never asked.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show details of gh' }));
    expect(rowOf('gh')).toHaveTextContent('No open plan names it; it is one of the CLI’s own.');
  });

  it('Check again on a row asks for that id alone, and the row shows what the probe found', async () => {
    renderWithClient(<CredentialsGroup />);
    await screen.findByTestId('credential-list');
    fireEvent.click(within(rowOf('env:STRIPE_KEY')).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(rowOf('env:STRIPE_KEY').querySelector('[data-vocab="probe"]')).toHaveTextContent('OK'),
    );
    expect(sent(server, 'POST', '/api/credentials/probe')).toEqual([{ ids: ['env:STRIPE_KEY'] }]);
    expect(rowOf('env:STRIPE_KEY')).toHaveTextContent('the variable is set');
  });

  it('Check every credential again asks with no ids, which the server reads as every one', async () => {
    renderWithClient(<CredentialsGroup />);
    await screen.findByTestId('credential-list');
    fireEvent.click(screen.getByRole('button', { name: 'Check every credential again' }));
    await waitFor(() => expect(sent(server, 'POST', '/api/credentials/probe')).toEqual([{ ids: [] }]));
  });

  it('a probe that failed is the server’s words, raised where a press’s answer goes', async () => {
    server.reads['POST /api/credentials/probe'] = new ApiError(
      'the probe timed out',
      504,
      '/api/credentials/probe',
    );
    renderWithClient(<CredentialsGroup />);
    await screen.findByTestId('credential-list');
    fireEvent.click(within(rowOf('gh')).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('The check could not run: the probe timed out', 'error'),
    );
    // The read stands as it was.
    expect(rowOf('gh').querySelector('[data-vocab="probe"]')).toHaveTextContent('OK');
  });

  it('a read that failed says so in its own words, and asks again', async () => {
    let asks = 0;
    server.reads['/api/credentials'] = () => {
      asks += 1;
      if (asks === 1) throw new ApiError('the registry could not be read', 500, '/api/credentials');
      return HELD;
    };
    renderWithClient(<CredentialsGroup />);
    expect(
      await screen.findByText('What this machine holds could not be read: the registry could not be read'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('credential-list')).toBeInTheDocument();
  });
});
