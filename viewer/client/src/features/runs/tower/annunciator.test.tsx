/**
 * The annunciator (control-tower phase 20, exit criterion 2): its lamps count
 * exactly the halt card's families (`haltView`), a lamp with nothing behind it
 * is dim and cannot be pressed, and pressing a lit one narrows the bays to
 * that family — remembered, and undone by pressing it again.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleState, RunState } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      phaseActivity: vi.fn(async () => ({ events: [], untrusted: true })),
      phaseReport: vi.fn(async () => ({ live: false })),
    },
  };
});

import { HALT_CATEGORIES } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { nowLanes } from '@/features/runs/lanes-model';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { Tower } from './tower';
import { towerModel } from './tower-model';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const run = (id: string, over: Record<string, unknown>): RunState =>
  ({
    id,
    slug: id,
    root: '/repo',
    status: 'halted',
    model: 'opus',
    spentUsd: 0,
    runBudgetUsd: null,
    createdAt: iso(NOW - 3_600_000),
    updatedAt: iso(NOW - 60_000),
    phases: {},
    ...over,
  }) as unknown as RunState;

const RUNS = [
  run('signin', { halt: { kind: 'credential-refused', phase: 1, at: iso(NOW - 600_000) } }),
  run('red-a', { halt: { kind: 'verify-failed', phase: 2, at: iso(NOW - 600_000) } }),
  run('red-b', { halt: { kind: 'verify-failed', phase: 3, at: iso(NOW - 600_000) } }),
  run('moving', { status: 'running' }),
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = { allowRun: true, fleet: { frozen: false, at: null, by: null } } as unknown as ConsoleState;
  client.setQueryData(['state'], state);
  return render(
    <QueryClientProvider client={client}>
      <Tower
        model={towerModel({ runs: RUNS, lanes: nowLanes(RUNS), now: NOW })}
        state={state}
        allowRun
        totalRuns={RUNS.length}
      />
    </QueryClientProvider>,
  );
}

const lamp = (category: string) =>
  within(screen.getByTestId('annunciator'))
    .getAllByTestId('lamp')
    .find((el) => el.dataset.category === category)!;

const strips = () =>
  screen
    .queryAllByTestId('board-card')
    .map((el) => el.dataset.slug)
    .sort();

beforeEach(() => {
  cleanup();
  setPrefs({ towerCategory: '', towerQuery: '', stripsOpen: [] });
});

describe('the annunciator', () => {
  it('has one lamp per halt family, each counting exactly the halt card’s own category', () => {
    mount();
    const lamps = within(screen.getByTestId('annunciator')).getAllByTestId('lamp');
    expect(lamps.map((el) => el.dataset.category)).toEqual([...HALT_CATEGORIES]);
    const expected: Record<string, number> = Object.fromEntries(HALT_CATEGORIES.map((c) => [c, 0]));
    for (const r of RUNS) {
      const view = haltView(r as never);
      if (view) expected[view.category] = (expected[view.category] ?? 0) + 1;
    }
    for (const el of lamps) {
      expect(el.textContent, el.dataset.category).toMatch(new RegExp(`${expected[el.dataset.category!]}$`));
    }
    expect(expected.verification).toBe(2);
    expect(expected.credentials).toBe(1);
  });

  it('dims a lamp with nothing behind it, and it cannot be pressed', () => {
    mount();
    const dark = lamp('plan');
    expect(dark.dataset.lit).toBe('false');
    expect((dark as HTMLButtonElement).disabled).toBe(true);
    expect(dark.className).toMatch(/opacity-60/);
    expect(lamp('verification').dataset.lit).toBe('true');
  });

  it('narrows the bays to the family pressed, remembers it, and a second press lets go', () => {
    mount();
    expect(strips()).toEqual(['moving', 'red-a', 'red-b', 'signin']);

    fireEvent.click(lamp('verification'));
    expect(lamp('verification').getAttribute('aria-pressed')).toBe('true');
    expect(strips()).toEqual(['red-a', 'red-b']);
    expect(getPrefs().towerCategory).toBe('verification');
    // The other lamps stay lit: they are the panel you filter WITH.
    expect(lamp('credentials').dataset.lit).toBe('true');
    expect(screen.getByTestId('tower-filtered').textContent).toMatch(/verification and unfinished work/i);
    // An emptied bay says the filter emptied it — never that the console is idle.
    expect(
      within(screen.getByRole('region', { name: /^Live/ })).getByText('Nothing here matches the filter.'),
    ).toBeTruthy();

    fireEvent.click(lamp('verification'));
    expect(strips()).toEqual(['moving', 'red-a', 'red-b', 'signin']);
    expect(getPrefs().towerCategory).toBe('');
  });
});
