/**
 * Reminders for a person's turn (control-tower phase 42): the series the
 * console says a waiting step again on, and the quiet hours it waits out —
 * the preference `reminderQuiet`, which had no home before this card.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, ...api } };
});

import { REMINDER_SERIES_MS } from '@shared/human-step-model.js';
import { queryClientConfig } from '@/lib/queries';
import { SETTINGS_SECTIONS } from './nav';
import { DEFAULT_REMINDER_QUIET, RemindersCard, gapWords, validQuiet } from './notifications';

function mount(prefs: Record<string, unknown> = {}) {
  api.state.mockResolvedValue({ prefs });
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <RemindersCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.savePrefs.mockResolvedValue({ ok: true });
});

describe('the reminders card', () => {
  it('draws the series the clock runs, one gap per line', () => {
    mount();
    const series = screen.getByTestId('reminder-series').querySelectorAll('li');
    expect(series).toHaveLength(REMINDER_SERIES_MS.length);
    expect(series[0]!.textContent).toBe(`after ${gapWords(REMINDER_SERIES_MS[0]!)}`);
    expect(series[series.length - 1]!.textContent).toMatch(/then every day$/);
  });

  it('turns quiet hours on with the night, and says when they are held', async () => {
    mount();
    expect(screen.getByTestId('reminder-quiet').textContent).toContain('Off');
    fireEvent.click(screen.getByTestId('quiet-save'));
    await waitFor(() =>
      expect(api.savePrefs).toHaveBeenCalledWith({ reminderQuiet: DEFAULT_REMINDER_QUIET }),
    );
  });

  it('shows the window the console holds, and can turn it off', async () => {
    mount({ reminderQuiet: { start: '23:30', end: '07:00' } });
    expect(await screen.findByText(/Reminders wait from 23:30 to 07:00/)).toBeTruthy();
    expect((screen.getByTestId('quiet-start') as HTMLInputElement).value).toBe('23:30');
    fireEvent.click(screen.getByRole('button', { name: 'Turn them off' }));
    await waitFor(() => expect(api.savePrefs).toHaveBeenCalledWith({ reminderQuiet: null }));
  });

  it('refuses a window the server would silently drop', () => {
    expect(validQuiet({ start: '22:00', end: '22:00' })).toBe(false);
    expect(validQuiet({ start: '25:00', end: '08:00' })).toBe(false);
    expect(validQuiet({ start: '22:00', end: '08:00' })).toBe(true);
    mount();
    fireEvent.change(screen.getByTestId('quiet-end'), { target: { value: '22:00' } });
    expect(screen.getByTestId('quiet-invalid')).toBeTruthy();
    expect((screen.getByTestId('quiet-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is found under Notifications by the words a person would search for', () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === 'notifications');
    expect(section?.blurb).toMatch(/your turns/);
  });
});
