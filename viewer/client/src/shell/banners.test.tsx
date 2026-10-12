/**
 * A frozen console says so on every page, and says whose freeze it is.
 *
 * A frozen console and a console with nothing to do are indistinguishable
 * otherwise — the single hardest state to diagnose from the outside. So the
 * banner names who froze it and how long ago (both round-trip the freeze's
 * marker, so a restart does not lose them), drops a time it cannot read rather
 * than print a wrong one, and carries the thaw only where the console may run
 * anything — through the one press door, like every other press.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fleetThaw } = vi.hoisted(() => ({
  fleetThaw: vi.fn(async () => ({ fleet: { frozen: false, at: null, by: null }, runs: 2 })),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, fleetThaw } };
});

import type { ConsoleState } from '@/data/api';
import { ConsoleBanners } from './banners';

const frozen = (fleet: { at: string | null; by: string | null }, allowRun = true) =>
  ({ allowRun, fleet: { frozen: true, ...fleet } }) as unknown as ConsoleState;

const draw = (state: ConsoleState) =>
  render(<ConsoleBanners state={state} online sse="live" stopped={null} />);

beforeEach(() => {
  fleetThaw.mockClear();
});

describe('the frozen console’s banner', () => {
  it('names who froze it and how long ago — what the marker carries through a restart (#93)', () => {
    const at = new Date(Date.now() - 14 * 60_000).toISOString();
    draw(frozen({ at, by: 'operator' }));
    const banner = screen.getByText(/This console is frozen/).parentElement!;
    expect(banner.textContent).toMatch(/Frozen by operator 14 minutes ago\./);
  });

  it('an unreadable timestamp drops the clause instead of rendering a wrong time', () => {
    draw(frozen({ at: 'never', by: 'mo' }));
    const banner = screen.getByText(/This console is frozen/).parentElement!;
    expect(banner.textContent).toMatch(/Frozen by mo\./);
    expect(banner.textContent).not.toMatch(/NaN|Invalid/);
  });

  it('carries the thaw, and the thaw goes through the console’s fleet verb', async () => {
    draw(frozen({ at: '2026-08-26T10:00:00Z', by: 'mo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thaw' }));
    await waitFor(() => expect(fleetThaw).toHaveBeenCalledTimes(1));
  });

  it('offers no thaw on a console that cannot run anything — but still says it is frozen', () => {
    draw(frozen({ at: '2026-08-26T10:00:00Z', by: 'mo' }, false));
    expect(screen.getByText(/This console is frozen/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thaw' })).toBeNull();
  });
});
