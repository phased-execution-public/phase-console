/**
 * The instance switcher (7.0, quiet-console phases 3 and 24): which console
 * this is, and the way to every other console of the machine.
 *
 *  - Free lists every console the machine's registry names
 *    (`GET /api/instances`), this one first, each with its liveness as a dot
 *    and a word and the port it answers on — and a press goes to that
 *    console's own page.
 *  - Pro reads the fleet census instead (through this console's relay), in
 *    its worst-first order, adds what needs a person on each console, and
 *    opens Fleet with the whole machine in a line beneath it.
 *  - Nothing is asked until the menu opens: first paint carries the button.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The server's answers by path; every request is logged. */
const server = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  calls: [] as string[],
}));
vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  const answer = async (path: string) => {
    server.calls.push(path);
    const read = server.reads[path.split('?')[0]!];
    if (read !== undefined) return read;
    throw new actual.ApiError(`Nothing is fixtured for ${path}`, 404, path);
  };
  return { ...actual, request: (path: string) => answer(path), post: (path: string) => answer(path) };
});

import type { ConsoleState } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { MemoryRouterProvider } from './router';
import { Switcher } from './switcher';

const STATE: ConsoleState = {
  autopilot: true,
  allowRun: true,
  root: { path: '/work/pe-hub', label: 'pe-hub', ok: true },
  instance: { id: 'f922d743-pe-hub', name: 'pe-hub', pinned: true },
  unread: 0,
};

const REGISTRY = {
  rows: [
    { id: 'f922d743-pe-hub', name: 'pe-hub', port: 4130, liveness: 'running', provenance: 'registry' },
    { id: '1a2b3c4d-hub', name: 'hub', port: 4123, liveness: 'running', provenance: 'registry' },
    { id: '5e6f7a8b-scratch', name: 'scratch', port: 4131, liveness: 'stopped', provenance: 'registry' },
  ],
};

function mount(state: ConsoleState, onNavigate?: (path: string) => void) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider onNavigate={onNavigate}>
        <Switcher state={state} variant="rail" />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /This console: pe-hub/ }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  server.reads = { '/api/instances': REGISTRY };
  server.calls = [];
});

describe('the switcher in both editions', () => {
  it('asks nothing until it is opened', () => {
    mount(STATE);
    expect(screen.getByRole('button', { name: /This console: pe-hub, on pe-hub/ })).toBeTruthy();
    expect(server.calls).toEqual([]);
  });

  it('lists every console of the registry: this one first, then the others with liveness and port', async () => {
    mount(STATE);
    const menu = await openMenu();
    await within(menu).findByText('hub');
    const items = within(menu).getAllByRole('menuitem');
    // This console, then hub and scratch, then the closing sentence about sources.
    expect(items[0]!.textContent).toContain('pe-hub');
    expect(items[0]!.textContent).toContain('/work/pe-hub');
    const hub = items.find((item) => item.textContent?.includes('hub') && item.textContent.includes('4123'))!;
    expect(hub.querySelector('[data-status="running"]')).toBeTruthy();
    expect(hub.textContent).toContain('port 4123');
    const scratch = items.find((item) => item.textContent?.includes('scratch'))!;
    expect(scratch.querySelector('[data-status="stopped"]')).toBeTruthy();
    expect(server.calls).toContain('/api/instances');
  });

  it('offers no Fleet when no supervisor answers', async () => {
    mount({ ...STATE, fleet: { frozen: false, at: null, by: null, reachable: false, hold: null } });
    const menu = await openMenu();
    await within(menu).findByText('hub');
    expect(within(menu).queryByText('Open Fleet')).toBeNull();
    expect(server.calls.some((path) => path.startsWith('/api/fleet/'))).toBe(false);
  });
});

