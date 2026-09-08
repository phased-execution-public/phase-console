/**
 * The ladder card: twelve server preferences rendered from `/api/state` and
 * saved one key per change through `/api/prefs` — the caps in rungs AND
 * dollars, the two clocks in minutes, the one budget raise, the four toggles.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs } = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs } };
});

async function mount(prefs: Record<string, unknown> = {}) {
  state.mockResolvedValue({ root: { ok: true, path: '/repo' }, autopilot: true, prefs });
  savePrefs.mockResolvedValue({});
  const { LadderCard } = await import('./ladder');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <LadderCard />
    </QueryClientProvider>,
  );
  await screen.findByText('Automation · the ladder');
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  state.mockReset();
  savePrefs.mockReset();
});

describe('<LadderCard>', () => {
  it('reads a config from before the keys existed as the shipped defaults', async () => {
    await mount({});
    expect(field('Rungs per phase').value).toBe('3');
    expect(field('Spend per phase').value).toBe('100');
    expect(field('Rungs per run').value).toBe('10');
    expect(field('Spend per run').value).toBe('400');
    expect(field('Spend per day').value).toBe('600');
    // The clocks in minutes, never milliseconds.
    expect(field('Sweep every').value).toBe('5');
    expect(field('Park on a required MCP server for').value).toBe('30');
    expect(field('Raise a spent run budget once by').value).toBe('25');
    // Three toggles default on. Three default OFF, each deliberately:
    // `delegateHumanGates` (the plan author wrote `human`, and "the owner
    // approves the visual result" is not a thing a session can judge),
    // `allowUnverifiedPhases` (it lowers the proof bar to the handoff) and
    // `ladderExtendOnProgress` (one more rung is one more session's money) —
    // server/config.ts. `resumeAtBoot` is no longer a toggle at all — it is
    // three-valued since 3.5.0 and opens on Ask.
    expect(screen.getAllByRole('button', { name: 'On' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Off' })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
  });

  it('offers the two posture opt-ins off, each saving exactly its own key when turned on', async () => {
    // Both were fully plumbed server preferences the moment they existed —
    // honoured by the runner and the healer, patchable over the API — and a
    // preference with no control is the hand-edit-config.json trap again.
    await mount({});
    for (const [label, key] of [
      ['Board a phase that states no verification', 'allowUnverifiedPhases'],
      ['One more rung while the work is moving', 'ladderExtendOnProgress'],
    ] as const) {
      const row = screen.getByText(label).closest('div')!;
      const toggle = within(row).getByRole('button', { name: 'Off' });
      expect(toggle.getAttribute('data-pref')).toBe(key);
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(toggle);
      await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ [key]: true }));
    }
  });

  it('offers a control for delegateHumanGates, and it can be turned on', async () => {
    // It was a fully-plumbed server preference — honoured by the runner,
    // patchable over the API — with no control anywhere, so the only way to
    // use it was to hand-edit config.json and restart the console, which is
    // the exact thing the console exists to remove.
    await mount({});
    const label = screen.getByText('Let a session clear a human gate');
    const row = label.closest('div')!;
    // The button carries the CURRENT state, so the delegation row reads "Off"
    // — which is itself the assertion that it ships off.
    const toggle = within(row).getByRole('button', { name: 'Off' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(savePrefs).toHaveBeenCalledWith(expect.objectContaining({ delegateHumanGates: true })),
    );
  });

  it('renders the stored choices, not the defaults', async () => {
    await mount({ ladderPerDayUsd: 900, convergeEveryMs: 0, resumeAtBoot: false, mcpRequireTimeoutMs: 0 });
    expect(field('Spend per day').value).toBe('900');
    expect(field('Sweep every').value).toBe('0');
    expect(field('Park on a required MCP server for').value).toBe('0');
    // The three opt-ins stay Off; `resumeAtBoot: false` renders as its own
    // three-valued control reading Never.
    expect(screen.getAllByRole('button', { name: 'Off' })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Never' })).toBeTruthy();
  });

  it('saves a cap as its own key when the field is left', async () => {
    await mount({});
    const input = field('Spend per phase');
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.blur(input);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ ladderPerPhaseUsd: 150 }));
  });

  it('saves the sweep interval in milliseconds from a field in minutes', async () => {
    await mount({});
    const input = field('Sweep every');
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ convergeEveryMs: 120_000 }));
  });

  it('saves nothing for an unchanged or unusable value', async () => {
    await mount({});
    const input = field('Rungs per run');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '-4' } });
    fireEvent.blur(input);
    expect(savePrefs).not.toHaveBeenCalled();
    // The field snaps back to what the process holds.
    expect(input.value).toBe('10');
  });

  it('flips a toggle as its own key', async () => {
    await mount({});
    // By its own key rather than by position — the same lesson the automation
    // card learned when a row was added above the one being clicked.
    const unblock = document.querySelector<HTMLButtonElement>('button[data-pref="unblockAttempts"]');
    expect(unblock).toBeTruthy();
    fireEvent.click(unblock!);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ unblockAttempts: false }));
  });

  it('resume-at-boot cycles Ask → Always → Never, sending a word each time', async () => {
    // Three values, one control, and a WORD on the wire: `onOff` would send a
    // boolean and the server's door would drop it in silence.
    await mount({});
    const button = () => document.querySelector<HTMLButtonElement>('button[data-pref="resumeAtBoot"]')!;
    expect(button().textContent).toBe('Ask');
    fireEvent.click(button());
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ resumeAtBoot: 'auto' }));
  });

  it('a stored boolean true still reads as Ask', async () => {
    // The migration, on screen: `true` was the only value that resumed at all,
    // so it means "resume somehow", not "resume silently".
    await mount({ resumeAtBoot: true });
    expect(document.querySelector<HTMLButtonElement>('button[data-pref="resumeAtBoot"]')!.textContent).toBe(
      'Ask',
    );
  });
});
