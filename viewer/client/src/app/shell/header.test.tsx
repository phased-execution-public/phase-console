/**
 * The header's two console chips (control-tower phase 25): the heap against
 * its limit on every page (#32's fourth gap), and who else the console is
 * serving, over `state.access`.
 */

import { fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouterProvider } from '@/app/router';
import { parseHash, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';

const { runtime } = vi.hoisted(() => ({
  runtime: { current: {} as { heapUsedBytes?: number; heapLimitBytes?: number } },
}));

vi.mock('@/features/debug/runtime', () => ({
  useRuntime: () => ({ data: runtime.current }),
}));

import { Header } from './header';
import { PresenceChip, RuntimeChip } from './console-chips';

const GB = 1024 ** 3;

let navigations: string[] = [];
const render = (ui: ReactElement) =>
  renderBare(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouterProvider initial="#/now" onNavigate={(to) => navigations.push(to)}>
        {ui}
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );

const counts: ShellCounts = {
  plans: 0,
  phases: 0,
  ready: 0,
  approvals: 0,
  needsYou: 0,
  asks: 0,
  sessions: 0,
  unread: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
};

const NOW = Date.parse('2026-09-29T10:00:00.000Z');
const ACCESS: NonNullable<ConsoleState['access']> = {
  served: { local: 120, remote: 7 },
  lastRemoteAt: '2026-09-29T09:58:00.000Z',
  identities: [
    {
      host: 'phone.tail',
      loginHash: 'aaaa1111bbbb2222',
      first: '2026-09-28T08:00:00.000Z',
      last: '2026-09-29T09:58:00.000Z',
      count: 5,
    },
    {
      host: 'tablet.tail',
      loginHash: 'cccc3333dddd4444',
      first: '2026-09-20T08:00:00.000Z',
      last: '2026-09-21T08:00:00.000Z',
      count: 2,
    },
  ],
};

beforeEach(() => {
  navigations = [];
  runtime.current = {};
});

describe('the heap chip reads the heap against its limit, on every page', () => {
  it('is a quiet meter while the heap is far from the limit', () => {
    runtime.current = { heapUsedBytes: 1 * GB, heapLimitBytes: 4 * GB };
    render(<RuntimeChip />);
    const chip = screen.getByTestId('runtime-chip');
    expect(chip.getAttribute('data-near')).toBe('false');
    const meter = within(chip).getByRole('meter', { name: 'This console’s heap' });
    expect(meter.getAttribute('aria-valuetext')).toBe('25 % — Heap 1.0 GB of 4.0 GB');
    expect(meter.className).toContain('state-running');
    expect(chip).not.toHaveTextContent('Heap');
  });

  it('turns and says its reading near the limit', () => {
    runtime.current = { heapUsedBytes: 3.6 * GB, heapLimitBytes: 4 * GB };
    render(<RuntimeChip />);
    const chip = screen.getByTestId('runtime-chip');
    expect(chip.getAttribute('data-near')).toBe('true');
    expect(chip).toHaveTextContent('Heap 90 %');
    expect(within(chip).getByRole('meter').className).toContain('state-failed');
  });

  it('opens Debug ▸ Health', () => {
    runtime.current = { heapUsedBytes: 1 * GB, heapLimitBytes: 4 * GB };
    render(<RuntimeChip />);
    fireEvent.click(screen.getByTestId('runtime-chip'));
    expect(navigations.at(-1)).toBe('#/debug/health');
  });

  it('draws nothing it cannot read', () => {
    runtime.current = { heapUsedBytes: 1 * GB };
    render(<RuntimeChip />);
    expect(screen.queryByTestId('runtime-chip')).toBeNull();
  });

  it('is in the header, loaded after first paint', async () => {
    runtime.current = { heapUsedBytes: 1 * GB, heapLimitBytes: 4 * GB };
    render(<Header state={undefined} counts={counts} route={parseHash('#/now') as Route} phone />);
    expect(await screen.findByTestId('runtime-chip')).toBeTruthy();
  });
});

describe('the presence chip says who else this console serves', () => {
  it('counts the phones seen in the last ten minutes, and its popover opens Debug ▸ Access', async () => {
    render(<PresenceChip access={ACCESS} now={NOW} />);
    const chip = screen.getByRole('button', { name: '1 phone connected' });
    fireEvent.click(chip);
    expect(await screen.findByText('phone.tail', { exact: false })).toBeTruthy();
    expect(screen.getByText('tablet.tail', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Served 120 requests on this machine and 7 remotely/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Debug ▸ Access' }));
    expect(navigations.at(-1)).toBe('#/debug/access');
  });

  it('says no phone is connected now when every one is stale', () => {
    render(<PresenceChip access={ACCESS} now={Date.parse('2026-10-05T00:00:00.000Z')} />);
    expect(screen.getByRole('button', { name: 'No phone connected now' })).toBeTruthy();
  });

  it('is absent on a console no phone has ever reached', () => {
    render(
      <PresenceChip
        access={{ served: { local: 3, remote: 0 }, lastRemoteAt: null, identities: [] }}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('presence-chip')).toBeNull();
  });
});
