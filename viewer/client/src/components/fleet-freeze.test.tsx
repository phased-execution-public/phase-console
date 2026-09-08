/**
 * The panic button's two surfaces, over one pair of verbs.
 *
 * The property worth pinning is not that a button calls an endpoint. It is
 * that a frozen console **says so wherever you are looking** — a frozen
 * console and a console with nothing to do are indistinguishable otherwise,
 * and that is the single hardest state to diagnose from the outside. So: the
 * banner renders only when frozen, and it explains what is stopped rather than
 * announcing a mode.
 *
 * The second property is that both surfaces go through the same hook, so the
 * Settings row and the banner's Thaw can never drift into two behaviours of
 * one act — the argument `useRunLifecycle` makes for the per-run verbs.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { queryClientConfig } from '@/lib/queries';
import { FleetFrozenBanner, FleetFreezeControl, fleetOf } from './fleet-freeze';

const fleetFreeze = vi.fn(async () => ({ fleet: { frozen: true, at: null, by: 'mo' }, runs: 2 }));
const fleetThaw = vi.fn(async () => ({ fleet: { frozen: false, at: null, by: null }, runs: 2 }));
let state: Record<string, unknown> = {};

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state: vi.fn(async () => state),
      fleetFreeze: () => fleetFreeze(),
      fleetThaw: () => fleetThaw(),
    },
  };
});

function draw(node: React.ReactElement) {
  const client = new QueryClient(queryClientConfig);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  fleetFreeze.mockClear();
  fleetThaw.mockClear();
  state = { allowRun: true };
});

describe('what `fleet` means when the server does not say', () => {
  it('an older server, or one that never froze, is not frozen', () => {
    expect(fleetOf(undefined)).toEqual({ frozen: false, at: null, by: null });
    expect(fleetOf({})).toEqual({ frozen: false, at: null, by: null });
  });
});

describe('the banner', () => {
  it('renders nothing at all on a console that is running normally', async () => {
    state = { allowRun: true, fleet: { frozen: false, at: null, by: null } };
    const { container } = draw(<FleetFrozenBanner />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('says what is stopped, and who stopped it, rather than announcing a mode', async () => {
    state = { allowRun: true, fleet: { frozen: true, at: '2026-08-26T10:00:00Z', by: 'mo' } };
    draw(<FleetFrozenBanner />);
    await screen.findByText(/This console is frozen/);
    // The three things that are NOT happening, named — this is the sentence
    // that turns "nothing is happening" into "I know why".
    expect(screen.getByText(/no queued phase, no wait, no recovery/)).toBeTruthy();
    expect(screen.getByText(/Frozen by mo/)).toBeTruthy();
  });

  it('carries the thaw, and the thaw goes through the shared verb', async () => {
    state = { allowRun: true, fleet: { frozen: true, at: '2026-08-26T10:00:00Z', by: 'mo' } };
    draw(<FleetFrozenBanner />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thaw all' }));
    await waitFor(() => expect(fleetThaw).toHaveBeenCalledTimes(1));
  });

  it('offers no thaw on a console that cannot run anything — but still says it is frozen', async () => {
    state = { allowRun: false, fleet: { frozen: true, at: '2026-08-26T10:00:00Z', by: 'mo' } };
    draw(<FleetFrozenBanner />);
    await screen.findByText(/This console is frozen/);
    expect(screen.queryByRole('button', { name: 'Thaw all' })).toBeNull();
  });

  it('an unreadable timestamp drops the clause instead of rendering a wrong time', async () => {
    state = { allowRun: true, fleet: { frozen: true, at: 'never', by: 'mo' } };
    draw(<FleetFrozenBanner />);
    const banner = await screen.findByText(/This console is frozen/);
    expect(banner.textContent).not.toMatch(/NaN|Invalid/);
  });
});

describe('the Settings control', () => {
  it('freezes when running, thaws when frozen — one button, the current state on it', async () => {
    state = { allowRun: true, fleet: { frozen: false, at: null, by: null } };
    const { unmount } = draw(<FleetFreezeControl />);
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze all' }));
    await waitFor(() => expect(fleetFreeze).toHaveBeenCalledTimes(1));
    expect(fleetThaw).not.toHaveBeenCalled();
    unmount();

    state = { allowRun: true, fleet: { frozen: true, at: '2026-08-26T10:00:00Z', by: 'mo' } };
    draw(<FleetFreezeControl />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thaw all' }));
    await waitFor(() => expect(fleetThaw).toHaveBeenCalledTimes(1));
  });

  it('is absent without --allow-run: a console that starts nothing has nothing to stop', async () => {
    state = { allowRun: false, fleet: { frozen: false, at: null, by: null } };
    const { container } = draw(<FleetFreezeControl />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});

/**
 * `confirm` is the ONE thing the board's copy and the Settings row ever
 * disagreed about.
 *
 * The board grew its own freeze verb over the same hook rather than adopting
 * this component — three render sites, two behaviours, and a doc comment six
 * lines up promising that this file was the single implementation. These pin
 * the asymmetry so a future divergence has to delete an assertion rather than
 * simply drifting.
 */
describe('the board control confirms; the Settings row does not', () => {
  it('puts a freeze behind a dialog when asked, and does nothing until it is taken', async () => {
    state = { allowRun: true, fleet: { frozen: false, at: null, by: null } };
    draw(<FleetFreezeControl confirm />);
    fireEvent.click(await screen.findByRole('button', { name: /Freeze all/ }));
    const dialog = await screen.findByRole('alertdialog');
    // The whole point of the confirmation: pressing the trigger freezes nothing.
    expect(fleetFreeze).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Freeze all' }));
    await waitFor(() => expect(fleetFreeze).toHaveBeenCalledTimes(1));
  });

  it('never confirms a THAW, whichever surface asks', async () => {
    // A thaw restores, and phase 15 made it exact. Confirming it would be a
    // question about nothing — and the asymmetry is the reason the two
    // surfaces can share one component at all.
    state = { allowRun: true, fleet: { frozen: true, at: null, by: 'mo' } };
    draw(<FleetFreezeControl confirm />);
    fireEvent.click(await screen.findByRole('button', { name: 'Thaw all' }));
    await waitFor(() => expect(fleetThaw).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('freezes on one press without it', async () => {
    state = { allowRun: true, fleet: { frozen: false, at: null, by: null } };
    draw(<FleetFreezeControl />);
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze all' }));
    await waitFor(() => expect(fleetFreeze).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
