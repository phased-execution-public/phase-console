/**
 * The boarding schedule card: three rules edited from `/api/state` and saved
 * whole through `/api/prefs`.
 *
 * The assertions worth having here are the ones a form can get plausibly
 * wrong — the default that must stay "board at any hour", the day toggles
 * whose empty list means EVERY day, and a bad cron expression that must be
 * refused rather than silently dropped (a dropped one looks exactly like an
 * opening that is set and never fires).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs } = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs } };
});

// The refusal is a toast, which renders through the app shell this harness does
// not mount — so the assertion is on what was said, at the seam that says it.
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast };
});

async function mount(boardingSchedule?: unknown) {
  state.mockResolvedValue({
    root: { ok: true, path: '/repo' },
    autopilot: true,
    prefs: boardingSchedule === undefined ? {} : { boardingSchedule },
  });
  savePrefs.mockResolvedValue({});
  const { ScheduleCard } = await import('./schedule-card');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <ScheduleCard />
    </QueryClientProvider>,
  );
  await screen.findByText('Boarding schedule');
}

/** The policy the last save sent. */
const saved = () => savePrefs.mock.calls.at(-1)![0].boardingSchedule;

beforeEach(() => {
  state.mockReset();
  savePrefs.mockReset();
  toast.mockReset();
});

describe('<ScheduleCard>', () => {
  it('is OFF on a console that has never set one — every hour boards', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy();
    // Nothing claims to be open or closed while the policy is off: the state
    // line is about a schedule, and there is none.
    expect(screen.queryByTestId('schedule-now')).toBeNull();
  });

  it('turning it on keeps the windows already stored — the toggle is not a delete', async () => {
    await mount({ enabled: false, windows: [{ days: [1], from: '09:00', to: '18:00' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(saved().enabled).toBe(true);
    expect(saved().windows).toEqual([{ days: [1], from: '09:00', to: '18:00' }]);
  });

  it('adding a window offers Mon–Fri office hours rather than an empty row', async () => {
    await mount({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Add window/ }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(saved().windows).toEqual([{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }]);
  });

  it('a window with no days reads as every day, and the first click REMOVES one', async () => {
    await mount({ enabled: true, windows: [{ from: '09:00', to: '18:00' }] });
    for (const day of ['Sunday', 'Monday', 'Saturday']) {
      expect(screen.getByRole('button', { name: day }).getAttribute('aria-pressed')).toBe('true');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    // Starting from nothing would have meant "every day" all over again.
    expect(saved().windows[0].days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('the times round-trip through the same coercer the server uses', async () => {
    await mount({ enabled: true, windows: [{ from: '9:00', to: '18:00' }] });
    expect((screen.getByLabelText('window from') as HTMLInputElement).value).toBe('09:00');
    fireEvent.change(screen.getByLabelText('window to'), { target: { value: '17:30' } });
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(saved().windows[0]).toEqual({ from: '09:00', to: '17:30' });
  });

  it('quiet hours are offered without days, and removing one removes only that one', async () => {
    await mount({
      enabled: true,
      quiet: [
        { from: '22:00', to: '07:00' },
        { from: '13:00', to: '14:00' },
      ],
    });
    // No day toggles on the deny-list rows — quiet hours are about the clock.
    expect(screen.queryByRole('group', { name: 'quiet hours days' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove this quiet hours' })[0]);
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(saved().quiet).toEqual([{ from: '13:00', to: '14:00' }]);
  });

  it('a bad cron expression is REFUSED, not silently dropped', async () => {
    await mount({ enabled: true });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 99 * * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add opening' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatch(/is not a five-field cron expression/);
    expect(savePrefs).not.toHaveBeenCalled();
    // …and the expression is still in the box, so the operator can fix it.
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('0 99 * * *');
  });

  it('a good cron expression is added, normalised, and de-duplicated', async () => {
    await mount({ enabled: true, cron: ['0 9 * * 1-5'] });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '  0   9  *  *  1-5 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add opening' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalled());
    expect(saved().cron).toEqual(['0 9 * * 1-5']);
  });

  it('says whether boarding is open right now, and when it next opens', async () => {
    // A Monday at 20:00 — outside office hours, so the card has to name
    // tomorrow morning rather than a bare time. `Date.now` is spied rather
    // than the timers faked: fake timers stop react-query's own scheduling and
    // the render never lands.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 24, 20, 0, 0).getTime());
    try {
      await mount({ enabled: true, windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] });
      expect(screen.getByTestId('schedule-now').textContent).toMatch(/Closed — opens tomorrow 09:00/);
    } finally {
      clock.mockRestore();
    }
  });
});
