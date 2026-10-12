/**
 * The Settings place (quiet-console phase 21): the index — every section with
 * the question it answers and how much of it is set, under one sentence read
 * from the schema; a section — its own title and question, the rail, the way
 * back; the search on every address, which answers with the sections AND the
 * keys, each key with its own control, so a setting is found and changed in
 * one place; Everything narrowed in place; a 6.x section drawn under the
 * place's title and not a second one of its own; and an id nobody knows read
 * as the list.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient, schemaAnswer, sent, type FixtureServer } from './test-kit';

const server = vi.hoisted((): FixtureServer => ({ reads: {}, calls: [] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import type { Route } from '@/shell/routes';
import SettingsPlace from './index';
import { SETTINGS_SECTIONS } from './nav';

/** A route as the router hands it over, from the address after `#/`. */
function at(address: string): Route {
  const [path = '', search = ''] = address.split('?');
  return {
    path,
    segments: path.split('/').filter(Boolean),
    query: Object.fromEntries(new URLSearchParams(search)),
  };
}

const SCHEMA = schemaAnswer({
  ladderPerRunUsd: { value: 30, default: 20, source: 'instance' },
  theme: { value: 'dark', default: 'system', source: 'instance' },
  'profile.webhooks': {
    value: [{ origin: 'https://hooks.example.com', tail: '…a1b2', name: 'Team channel' }],
    source: 'profile',
  },
});

function mount(address: string) {
  return renderWithClient(<SettingsPlace route={at(address)} />);
}

/** The page's title — the one `h1`. */
const title = () => screen.getByRole('heading', { level: 1 });

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/state': { instance: { name: 'pe-hub' }, prefs: {}, models: ['opus', 'sonnet'], allowWrites: true },
    '/api/prefs/schema': SCHEMA,
    '/api/accounts': { allowAccounts: true, accounts: [] },
    'POST /api/prefs': {},
  };
  window.location.hash = '#/settings';
});

describe('the index', () => {
  it('lists every section with its question, the registry last, under one sentence read from the schema', async () => {
    mount('settings');
    expect(title()).toHaveTextContent('Settings');
    expect(
      await screen.findByText(
        'pe-hub runs with 2 keys set here and 1 key from the machine profile; every other key is its shipped default.',
      ),
    ).toBeInTheDocument();
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-section-link]')];
    expect(links.map((link) => link.dataset.sectionLink)).toEqual(
      SETTINGS_SECTIONS.map((section) => section.id),
    );
    expect(links.at(-1)!.dataset.sectionLink).toBe('everything');
    for (const section of SETTINGS_SECTIONS) {
      const link = links.find((one) => one.dataset.sectionLink === section.id)!;
      expect(link).toHaveAttribute('href', `#/settings/${section.id}`);
      expect(within(link).getByText(section.blurb)).toBeInTheDocument();
    }
  });

  it('counts the keys each section holds that are not shipped defaults', async () => {
    mount('settings');
    const link = (id: string) => document.querySelector<HTMLElement>(`[data-section-link="${id}"]`)!;
    await waitFor(() => expect(within(link('automation')).getByText('1 set')).toBeInTheDocument());
    expect(within(link('appearance')).getByText('1 set')).toBeInTheDocument();
    // A profile key is read by This instance.
    expect(within(link('instance')).getByText('1 set')).toBeInTheDocument();
    expect(within(link('essentials')).queryByText(/set$/)).toBeNull();
  });

  it('says a console that stored nothing runs on the shipped defaults', async () => {
    server.reads['/api/prefs/schema'] = schemaAnswer();
    mount('settings');
    expect(
      await screen.findByText('pe-hub runs on the shipped defaults: no key is set.'),
    ).toBeInTheDocument();
  });

  it('reads an id nobody knows as the list, never a blank frame', () => {
    mount('settings/nope');
    expect(title()).toHaveTextContent('Settings');
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
  });
});

describe('a section', () => {
  it('is titled with its own name and question, the rail beside it and the way back to the list', async () => {
    mount('settings/appearance');
    expect(title()).toHaveTextContent('Appearance');
    const appearance = SETTINGS_SECTIONS.find((section) => section.id === 'appearance')!;
    expect(screen.getByText(appearance.blurb)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All settings' })).toHaveAttribute('href', '#/settings');
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(rail).getByRole('link', { name: 'Appearance' })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: 'Everything' })).toHaveAttribute(
      'href',
      '#/settings/everything',
    );
    // The body is the rebuilt section, not a 6.x card.
    expect(await screen.findByRole('heading', { name: 'This browser', level: 2 })).toBeInTheDocument();
  });

  it('draws MCP servers’ groups under the place’s title, none of them the title again (phase 23)', async () => {
    // No 6.x frame is left: phase 23 rebuilt the last of them.
    server.reads['/api/mcp'] = { servers: [], allowMcp: false };
    server.reads['/api/mcp/catalog'] = { entries: [] };
    mount('settings/mcp');
    expect(title()).toHaveTextContent('MCP servers');
    expect(
      await screen.findByRole('heading', { name: 'Registered servers', level: 2 }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'MCP servers' })).toHaveLength(1);
  });

  it('draws a rebuilt section’s groups under the place’s title, none of them the title again (phase 22)', async () => {
    mount('settings/accounts');
    expect(title()).toHaveTextContent('Accounts');
    expect(await screen.findByRole('heading', { name: 'Every account', level: 2 })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Accounts' })).toHaveLength(1);
  });
});

describe('the search', () => {
  it('writes what is typed into the address, on the index and on a section alike', async () => {
    mount('settings');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the settings' }), {
      target: { value: 'ladder' },
    });
    await waitFor(() => expect(window.location.hash).toBe('#/settings?q=ladder'));
  });

  it('answers with the sections that hold the words and the keys themselves — a key found is a key changed', async () => {
    mount('settings?q=ladder');
    const results = await screen.findByTestId('settings-results');
    const sections = within(results).getByRole('navigation', { name: 'Sections that match' });
    expect(within(sections).getByRole('link', { name: /Automation/ })).toHaveAttribute(
      'href',
      '#/settings/automation',
    );
    const row = await waitFor(() => {
      const found = results.querySelector<HTMLElement>('[data-pref="ladderPerRunUsd"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(within(results).getByRole('status')).toHaveTextContent(/^\d+ sections? and \d+ keys match$/);
    const usd = within(row).getByRole('spinbutton');
    fireEvent.change(usd, { target: { value: '45' } });
    fireEvent.blur(usd);
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ ladderPerRunUsd: 45 }]));
  });

  it('searches from a section too, in place of its body', async () => {
    mount('settings/appearance?q=ladder');
    expect(title()).toHaveTextContent('Appearance');
    expect(await screen.findByTestId('settings-results')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'This browser' })).toBeNull();
  });

  it('shows thirty keys at most, and sends the rest to Everything with the same words', async () => {
    mount('settings?q=the');
    const more = await screen.findByRole('link', { name: 'See every match in Everything' });
    expect(more).toHaveAttribute('href', '#/settings/everything?q=the');
    expect(
      document.querySelectorAll(
        '[data-testid="settings-results"] [data-pref], [data-testid="settings-results"] [data-key]',
      ),
    ).toHaveLength(30);
  });

  it('says when nothing matches, with the way to every key', async () => {
    mount('settings?q=zzqx');
    expect(await screen.findByText('Nothing in Settings matches “zzqx”.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open every key' })).toHaveAttribute(
      'href',
      '#/settings/everything',
    );
  });

  it('narrows Everything in place rather than answering beside it', async () => {
    mount('settings/everything?q=run usd');
    expect(title()).toHaveTextContent('Everything');
    await screen.findByTestId('settings-everything');
    expect(screen.queryByTestId('settings-results')).toBeNull();
    expect(document.querySelectorAll('[data-pref], [data-key]')).toHaveLength(1);
    expect(document.querySelector('[data-pref="ladderPerRunUsd"]')).toBeTruthy();
  });
});
