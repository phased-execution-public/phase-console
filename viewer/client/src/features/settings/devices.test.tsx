/**
 * The Devices card (parallel-repaint P2 — coverage hole N4, and the quiet-hours
 * editor from N3).
 *
 * Pinned: both lanes render with their honest copy; the subscribed device gets
 * a quiet-hours editor that saves as it is changed (on → the default night
 * window, a time edit → that field, off → null); the delivery readout counts a
 * `quiet` outcome as held, never as a failed handover; another device's window
 * shows as a chip.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pushQuiet: vi.fn(),
  pushCategories: vi.fn(),
  pushTest: vi.fn(),
  notifications: vi.fn(),
  currentEndpoint: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      push: mocks.push,
      pushQuiet: mocks.pushQuiet,
      pushCategories: mocks.pushCategories,
      pushTest: mocks.pushTest,
      notifications: mocks.notifications,
    },
  };
});

vi.mock('@/lib/push', () => ({
  currentEndpoint: mocks.currentEndpoint,
  blocker: () => null,
  describeBrowser: () => 'Mac · Chrome',
  iosNeedsInstall: () => false,
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock('@/lib/notify', () => ({
  notifyState: () => 'default',
  askToNotify: vi.fn(async () => 'granted'),
}));

const CATEGORIES = [
  { id: 'approval', label: 'Permission needed', detail: 'blocked', byDefault: true, urgent: true },
  { id: 'phase', label: 'Phase finished or failed', detail: 'the pulse', byDefault: true, urgent: false },
];

const MINE = {
  id: 'dev-1',
  label: 'Mac · Chrome',
  service: 'https://push.example.com',
  categories: { approval: true, phase: true },
  createdAt: '2026-09-01T00:00:00Z',
  lastOkAt: null,
  failures: 0,
};

function mount(opts: { devices?: Record<string, unknown>[]; items?: unknown[] } = {}) {
  mocks.push.mockResolvedValue({ publicKey: 'k', devices: opts.devices ?? [MINE], categories: CATEGORIES });
  mocks.notifications.mockResolvedValue({ items: opts.items ?? [], total: 0, unread: 0, more: false });
  const client = new QueryClient(queryClientConfig);
  return import('./devices').then(({ DevicesCard }) =>
    render(
      <QueryClientProvider client={client}>
        <DevicesCard />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentEndpoint.mockResolvedValue('https://push.example.com/sub/1');
  mocks.pushQuiet.mockResolvedValue({ device: MINE });
});

describe('the Devices card', () => {
  it('renders both lanes, with the in-tab lane saying what it actually does', async () => {
    await mount();
    expect(await screen.findByText('In this tab')).toBeTruthy();
    expect(screen.getByText(/when this tab is in the background/)).toBeTruthy();
    expect(screen.getByText('On this device')).toBeTruthy();
    // The permission is `default`, so the lane offers to ask.
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
  });

  it('offers quiet hours to the subscribed device, off by default', async () => {
    await mount();
    const box = await screen.findByRole('checkbox', { name: 'Quiet hours' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('off')).toBeTruthy();
    expect(screen.queryByLabelText('Quiet from')).toBeNull();
  });

  it('switching quiet hours on saves the default night window', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Quiet hours' }));
    await waitFor(() =>
      expect(mocks.pushQuiet).toHaveBeenCalledWith('dev-1', {
        start: '22:00',
        end: '08:00',
        allowUrgent: true,
      }),
    );
  });

  it('edits one field of a set window, and clears it with null', async () => {
    const quiet = { start: '22:00', end: '08:00', allowUrgent: true };
    await mount({ devices: [{ ...MINE, quiet }] });
    const box = await screen.findByRole('checkbox', { name: 'Quiet hours' });
    expect(box).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/22:00 to 08:00 · urgent still gets through/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Quiet until'), { target: { value: '07:30' } });
    await waitFor(() => expect(mocks.pushQuiet).toHaveBeenCalledWith('dev-1', { ...quiet, end: '07:30' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Urgent still gets through' }));
    await waitFor(() =>
      expect(mocks.pushQuiet).toHaveBeenCalledWith('dev-1', { ...quiet, allowUrgent: false }),
    );

    fireEvent.click(box);
    await waitFor(() => expect(mocks.pushQuiet).toHaveBeenCalledWith('dev-1', null));
  });

  it('counts a held push as quiet hours, never as a failed handover', async () => {
    await mount({
      items: [
        {
          id: 'n1',
          title: 'x',
          delivery: [
            { device: 'dev-1', label: 'Mac · Chrome', outcome: 'quiet', at: '' },
            { device: 'dev-2', label: 'iPhone', outcome: 'failed', at: '' },
          ],
        },
        {
          id: 'n2',
          title: 'y',
          delivery: [{ device: 'dev-1', label: 'Mac · Chrome', outcome: 'quiet', at: '' }],
        },
      ],
    });
    expect(await screen.findByText(/2 handovers held by quiet hours/)).toBeTruthy();
    const failed = screen.getByText(/did not succeed/);
    expect(failed.textContent).toContain('iPhone · failed');
    expect(failed.textContent).not.toContain('quiet');
  });

  it("shows another device's window as a chip", async () => {
    await mount({
      devices: [
        MINE,
        {
          ...MINE,
          id: 'dev-2',
          label: 'iPhone',
          service: 'https://web.push.apple.com',
          quiet: { start: '23:00', end: '07:00', allowUrgent: false },
        },
      ],
    });
    expect(await screen.findByText('quiet 23:00–07:00')).toBeTruthy();
  });
});
