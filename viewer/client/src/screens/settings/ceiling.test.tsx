/**
 * Settings ▸ Automation, the start ceiling (quiet-console phase 21).
 *
 * What it holds: its two keys, each drawn once, read from the server's
 * settings schema; the shipped numbers said, and that 0 is no limit — which
 * is why a zero is a real answer here and goes on the wire; a number of starts
 * is a whole one and neither goes below zero; a key set here says so, and
 * Reset takes it out of the file.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrefSchemaRow } from '@/data/console';
import { keys } from '@/data/keys';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { CeilingGroup } from './ceiling';

/** `server/start-ceiling.ts`: forty starts and $250 of reported session spend per sliding hour. */
const SHIPPED = { ceilingStartsPerHour: 40, ceilingUsdPerHour: 250 };

async function mount(over: Record<string, Partial<PrefSchemaRow>> = {}) {
  const rows: Record<string, Partial<PrefSchemaRow>> = {};
  for (const [key, value] of Object.entries(SHIPPED)) rows[key] = { value, default: value, ...over[key] };
  server.reads['/api/prefs/schema'] = schemaAnswer(rows);
  const view = renderWithClient(<CeilingGroup />);
  await waitFor(() => expect(view.client.getQueryState(keys.prefsSchema())?.status).toBe('success'));
  return view;
}

function row(key: string): HTMLElement {
  const found = document.querySelectorAll<HTMLElement>(`[data-pref="${key}"]`);
  expect(found, `${key} has exactly one control`).toHaveLength(1);
  return found[0]!;
}
const saves = () => sent(server, 'POST', '/api/prefs');
const starts = () => screen.getByLabelText('Automatic starts per hour') as HTMLInputElement;
const dollars = () => screen.getByLabelText('Session spend per hour') as HTMLInputElement;

function enter(input: HTMLInputElement, typed: string) {
  fireEvent.change(input, { target: { value: typed } });
  fireEvent.blur(input);
}

beforeEach(() => {
  server.calls = [];
  server.reads = { 'POST /api/prefs': {} };
});

describe('the start ceiling', () => {
  it('reads the shipped ceiling, and says 0 is no limit', async () => {
    await mount();
    expect(screen.getByRole('heading', { name: 'The start ceiling' })).toBeInTheDocument();
    expect([...document.querySelectorAll('[data-pref]')].map((el) => el.getAttribute('data-pref'))).toEqual([
      'ceilingStartsPerHour',
      'ceilingUsdPerHour',
    ]);
    expect(starts().value).toBe('40');
    expect(dollars().value).toBe('250');
    expect(row('ceilingStartsPerHour')).toHaveTextContent('0 is no limit (shipped: 40).');
    expect(row('ceilingUsdPerHour')).toHaveTextContent('0 is no limit (shipped: $250).');
    // A person's own press is never counted, and the group says so once.
    expect(screen.getByText(/your own Start, Retry and Continue are never counted/)).toBeInTheDocument();
    expect(screen.queryByText('Set here')).toBeNull();
  });

  it('each saves exactly its own key, and 0 is a real answer', async () => {
    await mount();
    enter(starts(), '60');
    await waitFor(() => expect(saves()).toEqual([{ ceilingStartsPerHour: 60 }]));
    enter(dollars(), '0');
    await waitFor(() => expect(saves()).toEqual([{ ceilingStartsPerHour: 60 }, { ceilingUsdPerHour: 0 }]));
  });

  it('a number of starts is a whole one, and neither goes below zero', async () => {
    await mount();
    enter(starts(), '2.5');
    expect(within(row('ceilingStartsPerHour')).getByText('Type a whole number.')).toBeInTheDocument();
    enter(starts(), '-1');
    expect(within(row('ceilingStartsPerHour')).getByText('Type 0 or more.')).toBeInTheDocument();
    enter(dollars(), '-5');
    expect(within(row('ceilingUsdPerHour')).getByText('Type 0 or more.')).toBeInTheDocument();
    expect(saves()).toEqual([]);
  });

  it('a key set here says so, and Reset takes it out of the file', async () => {
    await mount({ ceilingUsdPerHour: { value: 100, source: 'instance' } });
    expect(dollars().value).toBe('100');
    expect(within(row('ceilingUsdPerHour')).getByText('Set here')).toBeInTheDocument();
    expect(within(row('ceilingStartsPerHour')).queryByText('Set here')).toBeNull();
    fireEvent.click(
      within(row('ceilingUsdPerHour')).getByRole('button', {
        name: 'Reset ceilingUsdPerHour to its default',
      }),
    );
    await waitFor(() => expect(saves()).toEqual([{ ceilingUsdPerHour: null }]));
  });
});
