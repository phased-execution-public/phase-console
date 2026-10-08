/**
 * Reminders for a person's turn (control-tower phase 42): the series the
 * console says a waiting step again on — and, since phase 138 (#215), ONE
 * quiet-hours setting, each device's: the card holds no window of its own and
 * never writes `reminderQuiet`; it names the devices a reminder reaches and
 * the window each keeps, read off the push register.
 *
 * And the notifications matrix's twentieth kind — `granted`, phase 149's — with
 * its own switch (phase 138's exit criterion 4).
 */

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, currentEndpoint } = vi.hoisted(() => ({
  api: { state: vi.fn(), push: vi.fn(), savePrefs: vi.fn(), webhooks: vi.fn() },
  currentEndpoint: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...api } };
});
// Which push row is this browser comes from the service worker, which jsdom lacks.
vi.mock('@/lib/push', () => ({ currentEndpoint }));

import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import { queryClientConfig } from '@/lib/queries';
import { SETTINGS_SECTIONS } from './nav';
import { RemindersCard, gapWords, quietSentence, reminderDevices } from './notifications';
import { RoutingCard } from './routing';

/** A device as the register serves it — every category present. */
function device(id: string, label: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label,
    service: 'https://web.push.apple.com',
    categories: { 'needs-you': true, granted: true },
    createdAt: '2026-10-08T00:00:00.000Z',
    lastOkAt: null,
    failures: 0,
    ...over,
  };
}

function mount(node: ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.state.mockResolvedValue({ prefs: { notify: {} } });
  api.push.mockResolvedValue({ publicKey: 'k', devices: [], categories: [] });
  api.savePrefs.mockResolvedValue({ ok: true });
  api.webhooks.mockResolvedValue({ allowWebhooks: false, hooks: [], categories: [] });
  currentEndpoint.mockResolvedValue(null);
});

describe('the reminders card', () => {
  it('draws the series the clock runs, one gap per line', () => {
    mount(<RemindersCard />);
    const series = screen.getByTestId('reminder-series').querySelectorAll('li');
    expect(series).toHaveLength(REMINDER_SERIES_MS.length);
    expect(series[0]!.textContent).toBe(`after ${gapWords(REMINDER_SERIES_MS[0]!)}`);
    expect(series[series.length - 1]!.textContent).toMatch(/then every day$/);
  });

  it('holds no quiet hours of its own — it names each device’s window, set on Devices', async () => {
    api.push.mockResolvedValue({
      publicKey: 'k',
      devices: [
        device('d1', 'iPhone · Safari', { quiet: { start: '22:00', end: '07:00', allowUrgent: true } }),
        device('d2', 'Mac · Chrome'),
        // A device that does not take a person's turn never hears a reminder.
        device('d3', 'iPad', { categories: { 'needs-you': false, granted: true } }),
      ],
      categories: [],
    });
    mount(<RemindersCard />);
    const rows = await screen.findAllByTestId('reminder-device');
    expect(rows.map((row) => row.textContent)).toEqual([
      'iPhone · Safari — quiet 22:00 to 07:00',
      'Mac · Chrome — no quiet hours',
    ]);
    expect(screen.getByTestId('reminder-quiet').textContent).toMatch(/one quiet-hours setting/);
    expect(screen.getByTestId('reminder-quiet-rule').textContent).toBe(
      'Mac · Chrome keeps no quiet hours, so a reminder goes out when it is due.',
    );
    // No form of its own: nothing to save, and `reminderQuiet` is never written.
    expect(screen.queryByTestId('quiet-save')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(api.savePrefs).not.toHaveBeenCalled();
  });

  it('says a reminder waits for the first device to wake when every one is quiet', () => {
    const quiet = { start: '22:00', end: '07:00', allowUrgent: true };
    const both = reminderDevices([
      device('a', 'phone', { quiet }),
      device('b', 'tablet', { quiet }),
    ] as never);
    expect(quietSentence(both)).toMatch(/waits for the first to wake — deferred, never dropped/);
    expect(quietSentence([])).toMatch(/nothing to be quiet on/);
  });

  it('is found under Notifications by the words a person would search for', () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'notifications');
    expect(section?.blurb).toMatch(/your turns/);
  });
});

describe('the notifications matrix', () => {
  /** The kinds around the twentieth — the catalogue the server serves, in its order. */
  const CATEGORIES = [
    { id: 'needs-you', label: 'A phase needs you', detail: 'waiting on you', byDefault: true, urgent: true },
    { id: 'digest', label: 'Hourly digest', detail: 'a summary', byDefault: false, urgent: false },
    {
      id: 'granted',
      label: 'Permission granted',
      detail: 'A grant was applied — the push opens Settings ▸ Permissions ▸ Grants at it.',
      byDefault: true,
      urgent: false,
    },
  ];

  it('shows the twentieth kind — Permission granted — with its own switch, on by default', async () => {
    api.push.mockResolvedValue({ publicKey: '', devices: [], categories: CATEGORIES });
    mount(<RoutingCard />);
    const box = await screen.findByRole('checkbox', { name: 'Permission granted' });
    // A config that never saw the kind reads its catalogue default: on.
    expect(box).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box);
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith({ notify: { granted: false } }));
  });

  it('holds the switch where the console holds it', async () => {
    api.state.mockResolvedValue({ prefs: { notify: { granted: false } } });
    api.push.mockResolvedValue({ publicKey: '', devices: [], categories: CATEGORIES });
    mount(<RoutingCard />);
    expect(await screen.findByRole('checkbox', { name: 'Permission granted' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
