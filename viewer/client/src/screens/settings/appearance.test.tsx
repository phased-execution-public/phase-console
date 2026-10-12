/**
 * Settings ▸ Appearance (quiet-console phase 21). Two homes, and the page says
 * which: the theme, the density, the plan list's documents and the terminal's
 * two switches are THIS BROWSER's — a press writes the browser's own store and
 * paints the page at once, and nothing goes to the server; the plans library's
 * order and the session plan's model are the person's, kept on the server and
 * posted one key at a time, with where the value came from beside them. The
 * words offered are the owners' (`shared/prefs-model.js`, the plans library's
 * sorts, the console's models), never a second list.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { DENSITIES, THEMES } from '@shared/prefs-model.js';
import { getPrefs, setPrefs } from '@/lib/prefs';
import { SORTS } from '@/screens/plans/model';
import { AppearanceSection } from './appearance';
import { renderWithClient, schemaAnswer, sent } from './test-kit';

const MODELS = ['opus', 'sonnet', 'opus[1m]'];

function serve(over: Parameters<typeof schemaAnswer>[0] = {}) {
  server.reads['/api/state'] = { prefs: {}, models: MODELS };
  server.reads['/api/prefs/schema'] = schemaAnswer({
    sort: { value: null, default: SORTS[0]!.id },
    model: { value: null, default: '' },
    ...over,
  });
}

async function mount(over: Parameters<typeof schemaAnswer>[0] = {}) {
  serve(over);
  const view = renderWithClient(<AppearanceSection />);
  await waitFor(() => expect(server.calls.some((call) => call.path === '/api/prefs/schema')).toBe(true));
  return view;
}

const posted = () => sent(server, 'POST', '/api/prefs');
const group = (name: string) => screen.getByRole('group', { name });
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

beforeEach(() => {
  server.calls = [];
  server.reads = { 'POST /api/prefs': {} };
  act(() =>
    setPrefs({
      theme: 'system',
      density: 'comfortable',
      showDocuments: false,
      terminalWebgl: false,
      terminalScreenReader: false,
    }),
  );
});

describe('this browser', () => {
  it('offers every theme the owner names, and a press keeps it here and paints the page', async () => {
    await mount();
    const themes = within(group('Theme')).getAllByRole('button');
    expect(themes).toHaveLength(THEMES.length);
    fireEvent.click(within(group('Theme')).getByRole('button', { name: 'Night' }));
    expect(getPrefs().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(within(group('Theme')).getByRole('button', { name: 'Night' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(group('Theme')).getByRole('button', { name: 'Auto' }));
    expect(getPrefs().theme).toBe('system');
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(posted()).toEqual([]);
  });

  it('offers every density the owner names, and compact tightens this browser alone', async () => {
    await mount();
    expect(within(group('Density')).getAllByRole('button')).toHaveLength(DENSITIES.length);
    fireEvent.click(within(group('Density')).getByRole('button', { name: 'Compact' }));
    expect(getPrefs().density).toBe('compact');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    fireEvent.click(within(group('Density')).getByRole('button', { name: 'Comfortable' }));
    expect(document.documentElement).not.toHaveAttribute('data-density');
    expect(posted()).toEqual([]);
  });

  it('keeps the plan list’s documents and the terminal’s two switches in this browser', async () => {
    await mount();
    for (const [name, key] of [
      [/Show documents in the plan list/, 'showDocuments'],
      [/WebGL renderer/, 'terminalWebgl'],
      [/Screen reader mode/, 'terminalScreenReader'],
    ] as const) {
      const box = screen.getByRole('checkbox', { name });
      expect(box).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(box);
      expect(getPrefs()[key], key).toBe(true);
      expect(box).toHaveAttribute('aria-checked', 'true');
    }
    expect(posted()).toEqual([]);
  });
});

describe('every device', () => {
  it('orders the plans library by the library’s own sorts, kept on the server', async () => {
    await mount();
    await waitFor(() => expect(select('Plans library order').value).toBe(SORTS[0]!.id));
    expect([...select('Plans library order').options].map((option) => option.text)).toEqual(
      SORTS.map((sort) => sort.label),
    );
    expect(select('Plans library order').closest('[data-pref]')).toHaveAttribute('data-pref', 'sort');
    fireEvent.change(select('Plans library order'), { target: { value: SORTS[1]!.id } });
    await waitFor(() => expect(posted()).toEqual([{ sort: SORTS[1]!.id }]));
    expect(getPrefs().theme).toBe('system');
  });

  it('sizes a session plan for the console’s models, a plan’s own first, and posts the one key', async () => {
    await mount();
    await waitFor(() =>
      expect([...select('Session plan model').options].map((option) => option.text)).toEqual([
        'Each plan’s own target model',
        ...MODELS,
      ]),
    );
    fireEvent.change(select('Session plan model'), { target: { value: 'opus[1m]' } });
    await waitFor(() => expect(posted()).toEqual([{ model: 'opus[1m]' }]));
  });

  it('still offers a stored model the console no longer lists, and says it is set here with a Reset', async () => {
    await mount({ model: { value: 'haiku', default: '', source: 'instance' } });
    await waitFor(() => expect(select('Session plan model').value).toBe('haiku'));
    const row = select('Session plan model').closest<HTMLElement>('[data-pref]')!;
    expect(within(row).getByText('Set here')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Reset model to its default' }));
    await waitFor(() => expect(posted()).toEqual([{ model: null }]));
  });
});
