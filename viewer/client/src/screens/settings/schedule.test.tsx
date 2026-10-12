/**
 * The boarding schedule (quiet-console phase 21; the 6.x card's cases): three
 * rules read from the settings schema and saved WHOLE through `POST
 * /api/prefs`.
 *
 * The assertions worth having are the ones a form can get plausibly wrong —
 * the default that must stay "board at any hour", the day toggles whose empty
 * list means EVERY day, a time that is committed when it is left and never
 * deletes a window by being emptied, and a bad cron expression that must be
 * refused rather than silently dropped (a dropped one looks exactly like an
 * opening that is set and never fires).
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
// The refusal is a toast, and the tray is the shell's: the assertion is on what
// was said, at the seam that says it.
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import type { SchedulePolicy } from '@shared/schedule-policy.js';
import { renderWithClient, schemaAnswer, sent } from './test-kit';
import { ScheduleGroup } from './schedule';

function serve(boardingSchedule?: unknown) {
  const held: Record<string, unknown> = boardingSchedule === undefined ? {} : { boardingSchedule };
  server.reads['/api/prefs/schema'] = () =>
    schemaAnswer(
      'boardingSchedule' in held
        ? { boardingSchedule: { value: held.boardingSchedule, source: 'instance' } }
        : {},
    );
  server.reads['POST /api/prefs'] = (body: unknown) => {
    Object.assign(held, body as Record<string, unknown>);
    return { ok: true };
  };
}

async function mount(boardingSchedule?: unknown) {
  serve(boardingSchedule);
  const view = renderWithClient(<ScheduleGroup />);
  await screen.findByText('Boarding windows');
  // The schema has answered once the Origin can read it — wait for the value, not the frame.
  await waitFor(() => expect(server.calls.some((call) => call.path === '/api/prefs/schema')).toBe(true));
  return view;
}

/** The policy the last save sent. */
const saved = () =>
  (sent(server, 'POST', '/api/prefs').at(-1) as { boardingSchedule: Required<SchedulePolicy> })
    .boardingSchedule;
const saves = () => sent(server, 'POST', '/api/prefs');
const onOff = () => screen.getByRole('checkbox', { name: /Only start phases at these times/ });

beforeEach(() => {
  server.calls = [];
  server.reads = {};
  toast.mockClear();
});

describe('<ScheduleGroup>', () => {
  it('is OFF on a console that has never set one — every hour boards, and nothing claims open or closed', async () => {
    const { container } = await mount();
    await waitFor(() => expect(onOff()).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('schedule-now')).toBeNull();
    expect(container.querySelectorAll('[data-pref="boardingSchedule"]')).toHaveLength(1);
  });

  it('turning it on keeps the windows already stored — the switch is not a delete', async () => {
    await mount({ enabled: false, windows: [{ days: [1], from: '09:00', to: '18:00' }] });
    await screen.findByRole('group', { name: 'Boarding window 1' });
    fireEvent.click(onOff());
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saved().enabled).toBe(true);
    expect(saved().windows).toEqual([{ days: [1], from: '09:00', to: '18:00' }]);
  });

  it('adding a window offers Mon–Fri office hours rather than an empty row', async () => {
    await mount({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Add a window' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saved().windows).toEqual([{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }]);
  });

  it('a window with no days reads as every day, and the first press REMOVES one', async () => {
    await mount({ enabled: true, windows: [{ from: '09:00', to: '18:00' }] });
    const days = await screen.findByRole('group', { name: 'Boarding window 1 days' });
    for (const day of ['Sunday', 'Monday', 'Saturday']) {
      expect(within(days).getByRole('button', { name: day })).toHaveAttribute('aria-pressed', 'true');
    }
    fireEvent.click(within(days).getByRole('button', { name: 'Sunday' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    // Starting from nothing would have meant "every day" all over again.
    expect(saved().windows[0]!.days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a time round-trips through the server’s coercer, is saved when it is left, and an emptied one goes back', async () => {
    await mount({ enabled: true, windows: [{ from: '9:00', to: '18:00' }] });
    const window = await screen.findByRole('group', { name: 'Boarding window 1' });
    const from = within(window).getByLabelText('From') as HTMLInputElement;
    const to = within(window).getByLabelText('To') as HTMLInputElement;
    await waitFor(() => expect(from.value).toBe('09:00'));
    // Emptied and left: nothing is sent, and the time held comes back.
    fireEvent.change(to, { target: { value: '' } });
    fireEvent.blur(to);
    expect(saves()).toEqual([]);
    expect(to.value).toBe('18:00');
    fireEvent.change(to, { target: { value: '17:30' } });
    expect(saves()).toEqual([]);
    fireEvent.blur(to);
    await waitFor(() => expect(saves()).toHaveLength(1));
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
    await screen.findByRole('group', { name: 'Quiet hours 2' });
    // No day toggles on the deny-list rows — quiet hours are about the clock.
    expect(screen.queryByRole('group', { name: 'Quiet hours 1 days' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove quiet hours 1' }));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saved().quiet).toEqual([{ from: '13:00', to: '14:00' }]);
  });

  it('a bad cron expression is REFUSED, not silently dropped', async () => {
    await mount({ enabled: true });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 99 * * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add opening' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toBe('0 99 * * * is not a five-field cron expression.');
    expect(toast.mock.calls[0]![1]).toBe('error');
    expect(saves()).toEqual([]);
    // …and the expression is still in the box, so the operator can fix it.
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('0 99 * * *');
  });

  it('a good cron expression is added, normalised, and de-duplicated', async () => {
    await mount({ enabled: true, cron: ['0 9 * * 1-5'] });
    await screen.findByRole('button', { name: 'Remove 0 9 * * 1-5' });
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '  0   9  *  *  1-5 ' } });
    fireEvent.keyDown(screen.getByLabelText('Cron expression'), { key: 'Enter' });
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saved().cron).toEqual(['0 9 * * 1-5']);
    expect((screen.getByLabelText('Cron expression') as HTMLInputElement).value).toBe('');
  });

  it('says whether boarding is open right now, and when it next opens', async () => {
    // A Monday at 20:00 — outside office hours, so the line has to name
    // tomorrow morning rather than a bare time. `Date.now` is spied rather
    // than the timers faked: fake timers stop react-query's own scheduling.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 24, 20, 0, 0).getTime());
    try {
      await mount({ enabled: true, windows: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }] });
      expect(await screen.findByTestId('schedule-now')).toHaveTextContent(
        'Closed now: boarding opens tomorrow 09:00.',
      );
    } finally {
      clock.mockRestore();
    }
  });
});
