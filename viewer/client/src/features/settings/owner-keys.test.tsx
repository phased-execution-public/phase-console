/**
 * Settings ▸ Permissions ▸ Owner keys (control-tower phase 138, #215, exit criterion 3).
 *
 *   OK-1 with no key, the card says what that means and where the first key is enrolled;
 *   OK-2 the CLI's link (`?enrol=<token>`) enrols a passkey here, under the label given;
 *   OK-3 each key is listed — its label, where it was made, when, when last used — and
 *        removing one is asked once and needs the owner (a touch when the session is stale);
 *   OK-4 which presses need a key is said, from the door table itself;
 *   OK-5 on an IP address the card offers the same page at localhost;
 *   OK-6 sign in, touch again and lock are offered by the owner session's state, and a
 *        signed-in owner can enrol another browser or make a link for another device.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouterProvider } from '@/app/router';
import { ApiError } from '@/lib/api/client';
import type { OwnerKey, OwnerView } from '@/lib/api/owner';
import { queryClientConfig } from '@/lib/queries';

const owner = vi.fn();
const enrol = vi.fn();
const touch = vi.fn();
const lock = vi.fn();
const remove = vi.fn();
const link = vi.fn();
vi.mock('@/lib/api/owner', () => ({
  ownerApi: {
    owner: () => owner(),
    ownerLock: (all?: boolean) => lock(all),
    ownerKeyRemove: (id: string) => remove(id),
    ownerEnrolLink: () => link(),
    ownerConfirm: vi.fn(),
    ownerRefuse: vi.fn(),
  },
  enrolOwnerKey: (label: string, token?: string) => enrol(label, token),
  signInAsOwner: () => touch(),
}));

import { OwnerKeysCard } from './owner-keys';

const KEY: OwnerKey = {
  id: 'k1',
  alg: 'ES256',
  label: 'MacBook',
  origin: 'http://localhost:4130',
  rpId: 'localhost',
  createdAt: '2026-10-07T09:00:00.000Z',
  lastUsedAt: '2026-10-08T08:00:00.000Z',
  counter: 0,
  backedUp: true,
};

const SESSION = {
  id: 'o1',
  keyId: 'k1',
  label: 'MacBook',
  origin: 'http://localhost:4130',
  startedAt: '2026-10-08T08:00:00.000Z',
  lastSeenAt: '2026-10-08T08:00:00.000Z',
  assertedAt: new Date(Date.now() - 60_000).toISOString(),
  idleEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
  freshUntil: new Date(Date.now() + 240_000).toISOString(),
  fresh: true,
};

const view = (over: Partial<OwnerView> = {}): OwnerView => ({
  state: 'unenrolled',
  mode: 'unenrolled',
  keys: [],
  session: null,
  requests: [],
  relyingParty: { id: 'localhost', origin: 'http://localhost:4130' },
  ...over,
});

function wrap(node: ReactNode, initial = '#/settings/permissions') {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={initial}>{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of [owner, enrol, touch, lock, remove, link]) fn.mockReset();
  owner.mockResolvedValue(view());
  Object.defineProperty(window, 'PublicKeyCredential', {
    value: function PublicKeyCredential() {},
    configurable: true,
  });
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
});

describe('OK-1 no key yet', () => {
  it('says the console behaves as before, and that the first key is enrolled at the machine', async () => {
    wrap(<OwnerKeysCard />);
    const state = await screen.findByTestId('owner-state');
    expect(state.textContent).toMatch(/no owner key/i);
    const first = screen.getByTestId('owner-first');
    expect(first.textContent).toContain('phase-console owner enroll');
  });
});

describe('OK-2 the enrol link', () => {
  it('enrols a passkey under the label given, with the link’s token', async () => {
    enrol.mockResolvedValue({ key: KEY, session: SESSION });
    wrap(<OwnerKeysCard />, '#/settings/permissions?enrol=tok-123');
    const label = await screen.findByLabelText(/name this key/i);
    fireEvent.change(label, { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /enrol a passkey/i }));
    await waitFor(() => expect(enrol).toHaveBeenCalledWith('Work laptop', 'tok-123'));
  });
});

describe('OK-2b an owner-minted link on another device', () => {
  it('a device with no session (the console reads enrolled) enrols with the link’s token', async () => {
    owner.mockResolvedValue(view({ state: 'enrolled', mode: 'enrolled', keys: [KEY] }));
    enrol.mockResolvedValue({ key: { ...KEY, id: 'k2', label: 'Phone' }, session: null });
    wrap(<OwnerKeysCard />, '#/settings/permissions?enrol=tok-456');
    fireEvent.change(await screen.findByLabelText(/name this key/i), { target: { value: 'Phone' } });
    fireEvent.click(screen.getByRole('button', { name: /enrol a passkey/i }));
    await waitFor(() => expect(enrol).toHaveBeenCalledWith('Phone', 'tok-456'));
  });
});

describe('OK-3 the keys', () => {
  it('lists each key and removes one, asked once, through the owner', async () => {
    owner.mockResolvedValue(view({ state: 'unlocked', mode: 'enrolled', keys: [KEY], session: SESSION }));
    remove.mockResolvedValue({ removed: KEY, state: 'unenrolled' });
    wrap(<OwnerKeysCard />);
    const row = await screen.findByTestId('owner-key');
    expect(row.textContent).toContain('MacBook');
    expect(row.textContent).toContain('localhost');
    expect(row.textContent).toMatch(/synced|backed up/i);
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('k1'));
  });

  it('a stale owner session touches the key, then removes', async () => {
    owner.mockResolvedValue(
      view({ state: 'unlocked', mode: 'enrolled', keys: [KEY], session: { ...SESSION, fresh: false } }),
    );
    remove
      .mockRejectedValueOnce(new ApiError('touch again', 401, '/api/owner/keys/k1', { reassert: true }))
      .mockResolvedValueOnce({ removed: KEY, state: 'unenrolled' });
    touch.mockResolvedValue({ session: SESSION, fresh: true });
    wrap(<OwnerKeysCard />);
    const row = await screen.findByTestId('owner-key');
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(touch).toHaveBeenCalledTimes(1);
  });
});

describe('OK-4 which presses need a key', () => {
  it('names the high presses that need a fresh touch, and what any door may still do', async () => {
    wrap(<OwnerKeysCard />);
    const needs = await screen.findByTestId('owner-needs');
    expect(needs.textContent).toMatch(/five minutes/i);
    expect(needs.textContent).toMatch(/permission profile/i);
    expect(needs.textContent).toMatch(/capability/i);
    expect(needs.textContent).toMatch(/high-risk grant/i);
    expect(needs.textContent).toMatch(/deny/i);
  });
});

describe('OK-5 an IP address', () => {
  it('offers the same page at localhost', async () => {
    owner.mockResolvedValue(
      view({ relyingParty: { refused: 'open this console at http://localhost:4130' } }),
    );
    wrap(<OwnerKeysCard />);
    const hint = await screen.findByTestId('owner-localhost');
    expect(within(hint).getByRole('link').getAttribute('href')).toMatch(/^http:\/\/localhost/);
  });
});

describe('OK-6 the owner session', () => {
  it('signs in when a key is enrolled and this browser holds no session', async () => {
    owner.mockResolvedValue(view({ state: 'enrolled', mode: 'enrolled', keys: [KEY] }));
    touch.mockResolvedValue({ session: SESSION, fresh: true });
    wrap(<OwnerKeysCard />);
    fireEvent.click(await screen.findByRole('button', { name: /sign in with the owner key/i }));
    await waitFor(() => expect(touch).toHaveBeenCalledTimes(1));
  });

  it('a signed-in owner locks, enrols another browser and makes a link for another device', async () => {
    owner.mockResolvedValue(view({ state: 'unlocked', mode: 'enrolled', keys: [KEY], session: SESSION }));
    lock.mockResolvedValue({ ended: 1, state: 'enrolled' });
    link.mockResolvedValue({
      link: 'http://localhost:4130/#/settings/permissions?enrol=t2',
      links: ['https://mac.tailnet.ts.net/#/settings/permissions?enrol=t2'],
      expiresAt: '2026-10-08T10:10:00.000Z',
      first: false,
    });
    enrol.mockResolvedValue({ key: { ...KEY, id: 'k2', label: 'Phone' }, session: null });
    wrap(<OwnerKeysCard />);
    fireEvent.click(await screen.findByRole('button', { name: /lock this browser/i }));
    await waitFor(() => expect(lock).toHaveBeenCalledWith(undefined));
    fireEvent.click(screen.getByRole('button', { name: /make a link for another device/i }));
    const links = await screen.findByTestId('owner-links');
    expect(links.textContent).toContain('mac.tailnet.ts.net');
    fireEvent.change(screen.getByLabelText(/name this key/i), { target: { value: 'Studio' } });
    fireEvent.click(screen.getByRole('button', { name: /add a passkey in this browser/i }));
    await waitFor(() => expect(enrol).toHaveBeenCalledWith('Studio', undefined));
  });
});
