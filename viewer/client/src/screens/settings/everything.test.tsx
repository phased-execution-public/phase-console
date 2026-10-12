/**
 * Settings ▸ Everything over the schema fixture (quiet-console phase 21, exit
 * criterion 1): every key `GET /api/prefs/schema` returns is listed with where
 * its value came from; a writable key saves and resets, on the wire the server
 * reads; a read-only key shows the line that changes it; a secret is said as
 * set, never served.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);

import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { useToasts } from '@/ui';
import { EverythingSection, keyFileOf, numberWords, valueWords } from './everything';
import { keyRaw } from './key-inspector';
import { renderWithClient, schemaAnswer, sent } from './test-kit';

function Toasts() {
  const toasts = useToasts();
  return (
    <ul aria-label="toasts">
      {toasts.map((one) => (
        <li key={one.id}>{one.message}</li>
      ))}
    </ul>
  );
}

const SCHEMA = schemaAnswer({
  ladderPerRunUsd: { value: 30, default: 20, source: 'instance' },
  repoGuard: { value: true, default: true },
  theme: { value: 'dark', default: 'system', source: 'config' },
  'notify.digest': { value: true, default: true },
  'profile.webhooks': {
    value: [{ origin: 'https://hooks.example.com', tail: '…a1b2', name: 'Team channel' }],
    source: 'profile',
  },
  'profile.notifyCommand': { value: '[withheld]', source: 'profile' },
  schedulingPolicy: { value: 'seniority', default: 'seniority' },
});

async function mount() {
  const view = renderWithClient(
    <>
      <EverythingSection />
      <Toasts />
    </>,
  );
  await screen.findByTestId('settings-everything');
  return view;
}

/** One key's row, by its data attribute: a control row stamps `data-pref`, a reading `data-key`. */
const rowOf = (key: string): HTMLElement =>
  (document.querySelector(`[data-pref="${CSS.escape(key)}"]`) ??
    document.querySelector(`[data-key="${CSS.escape(key)}"]`)) as HTMLElement;

beforeEach(() => {
  server.calls.length = 0;
  server.reads = { '/api/prefs/schema': SCHEMA, 'POST /api/prefs': {} };
  // Each case opens on the essentials and an empty panel: both outlive a render.
  setPrefs({ everything: {} });
  __resetInspectorForTests();
});

describe('Settings ▸ Everything', () => {
  it('lists every key the schema returns, once, under the section that owns it', async () => {
    await mount();
    for (const row of SCHEMA.rows) expect(rowOf(row.key), row.key).toBeTruthy();
    const drawn = document.querySelectorAll('[data-pref], [data-key]');
    expect(drawn).toHaveLength(SCHEMA.rows.length);
    // The sections in their order, each counted.
    const automation = document.querySelector('[data-settings-group="everything-automation"]') as HTMLElement;
    expect(within(automation).getByRole('heading', { level: 2 }).textContent).toMatch(/^Automation\d+$/);
    expect(within(automation).getByRole('link', { name: 'Open Automation' })).toHaveAttribute(
      'href',
      '#/settings/automation',
    );
  });

  it('says where each value came from — silent for a default, a word for the rest', async () => {
    await mount();
    expect(within(rowOf('ladderPerRunUsd')).getByText('Set here')).toBeTruthy();
    // theme comes from the person's shared file, and this console has a file of its own.
    expect(within(rowOf('theme')).getByText('Set in the shared config')).toBeTruthy();
    expect(within(rowOf('profile.webhooks')).getByText('Set by the machine profile')).toBeTruthy();
    expect(within(rowOf('repoGuard')).queryByText(/Set /)).toBeNull();
    expect(within(rowOf('ladderPerRunUsd')).getByText('Default $20')).toBeTruthy();
  });

  it('saves a writable key on the wire the server reads, and resets it to its default', async () => {
    await mount();
    const usd = within(rowOf('ladderPerRunUsd')).getByRole('spinbutton');
    fireEvent.change(usd, { target: { value: '45' } });
    fireEvent.blur(usd);
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ ladderPerRunUsd: 45 }]));

    fireEvent.click(within(rowOf('repoGuard')).getByRole('checkbox'));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toContainEqual({ repoGuard: false }));

    fireEvent.click(
      within(rowOf('ladderPerRunUsd')).getByRole('button', { name: 'Reset ladderPerRunUsd to its default' }),
    );
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toContainEqual({ ladderPerRunUsd: null }));
  });

  it('writes one announcement category as a member of the map, and takes it back by its dotted name', async () => {
    server.reads['/api/prefs/schema'] = schemaAnswer({
      'notify.digest': { value: false, default: true, source: 'instance' },
    });
    await mount();
    fireEvent.click(within(rowOf('notify.digest')).getByRole('checkbox'));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toEqual([{ notify: { digest: true } }]));
    fireEvent.click(within(rowOf('notify.digest')).getByRole('button', { name: /^Reset/ }));
    await waitFor(() => expect(sent(server, 'POST', '/api/prefs')).toContainEqual({ 'notify.digest': null }));
  });

  it('shows a read-only key with its value and the line that changes it, and no control', async () => {
    await mount();
    const row = rowOf('schedulingPolicy');
    expect(row.getAttribute('data-key')).toBe('schedulingPolicy');
    expect(within(row).queryByRole('combobox')).toBeNull();
    expect(within(row).getByText('seniority')).toBeTruthy();
    // Drawn as words (it wraps between them, never inside a flag), named and copied whole.
    expect(
      within(row).getByRole('button', { name: 'phase-console run queue-policy --policy <word>' }),
    ).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Change it in Automation' })).toHaveAttribute(
      'href',
      '#/settings/automation',
    );
  });

  it('sends a machine-profile key to This instance, which draws the profile with its lines', async () => {
    await mount();
    const row = rowOf('profile.webhooks');
    expect(within(row).getByRole('link', { name: 'See it in This instance' })).toHaveAttribute(
      'href',
      '#/settings/instance',
    );
    // A key this page edits itself names no other place.
    expect(within(rowOf('ladderPerRunUsd')).queryByRole('link', { name: /^(See|Change) it in/ })).toBeNull();
  });

  it('says a secret is set without serving it', async () => {
    await mount();
    expect(within(rowOf('profile.webhooks')).getByText('1 set: Team channel')).toBeTruthy();
    expect(within(rowOf('profile.notifyCommand')).getByText('Set, and withheld')).toBeTruthy();
    expect(document.body.textContent).not.toContain('…a1b2');
  });

  it('shows only the keys that are set when asked, and says how many are shown', async () => {
    await mount();
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Show' })[0]!, { target: { value: 'set' } });
    await waitFor(() => expect(rowOf('repoGuard')).toBeFalsy());
    expect(rowOf('ladderPerRunUsd')).toBeTruthy();
    expect(rowOf('theme')).toBeTruthy();
    expect(screen.getByText(/keys, 4 set here or elsewhere; 4 shown/)).toBeTruthy();
  });

  it('narrows to what the place was asked for', async () => {
    renderWithClient(<EverythingSection query="run usd" />);
    await screen.findByTestId('settings-everything');
    expect(document.querySelectorAll('[data-pref], [data-key]')).toHaveLength(1);
    expect(rowOf('ladderPerRunUsd')).toBeTruthy();
  });

  it('says a save the owner must confirm is a request, not a save, and puts the value back', async () => {
    server.reads['POST /api/prefs'] = {
      requested: true,
      error: 'This console has an owner key: the owner confirms this change.',
      request: {
        id: 'r1',
        method: 'POST',
        path: '/api/prefs',
        body: { repoGuard: false },
        label: 'device',
        door: 'device',
        ask: 'Confirm',
      },
    };
    await mount();
    const box = within(rowOf('repoGuard')).getByRole('checkbox');
    fireEvent.click(box);
    expect(
      await screen.findByText('This console has an owner key: the owner confirms this change.'),
    ).toBeTruthy();
    await waitFor(() => expect(box).toHaveAttribute('data-state', 'checked'));
  });

  it('says a failed read in the server’s words, with a way out', async () => {
    const { ApiError } = await import('@/data/http');
    server.reads['/api/prefs/schema'] = new ApiError(
      'The settings file could not be read.',
      500,
      '/api/prefs/schema',
    );
    renderWithClient(<EverythingSection />);
    expect(
      await screen.findByText(/The settings could not be read: The settings file could not be read\./),
    ).toBeTruthy();
    server.reads['/api/prefs/schema'] = SCHEMA;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByTestId('settings-everything')).toBeTruthy();
  });
});

/* ---------------- the three doors on a key (quiet-console phase 27) ---------------- */

/** A key's fold toggle — the one "Details" on its row. */
const foldOf = (key: string): HTMLElement => within(rowOf(key)).getByRole('button', { name: 'Details' });

/**
 * Open a key's fold and hand back the region it drew. The toggle is held as an
 * element: open, it says "Hide details", and a search by its shut name would
 * find nothing.
 */
function openFold(key: string): HTMLElement {
  const toggle = foldOf(key);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveAccessibleName('Hide details');
  const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  expect(region, `${key}: the open fold names the region it drew`).toBeTruthy();
  return region!;
}

/** The section beside the shell's panel, as a desk draws the two. */
async function mountWithPanel() {
  const view = renderWithClient(
    <>
      <EverythingSection />
      <InspectorHost />
    </>,
  );
  await screen.findByTestId('settings-everything');
  return view;
}

/** Inspect a key from its fold, and hand back the panel's record. */
async function inspectFromFold(key: string): Promise<{ panel: HTMLElement; button: HTMLElement }> {
  const button = within(openFold(key)).getByRole('button', { name: 'Inspect' });
  fireEvent.click(button);
  return { panel: await screen.findByRole('region', { name: key }), button };
}

/** One fact of the Overview, by its label. */
function factOf(panel: HTMLElement, label: string): HTMLElement {
  const term = within(within(panel).getByTestId('key-overview')).getByText(label, { selector: 'dt' });
  return term.nextElementSibling as HTMLElement;
}

function openRaw(panel: HTMLElement): HTMLElement {
  const tab = within(panel).getByRole('tab', { name: 'Raw' });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
  return within(panel).getByRole('tabpanel');
}

describe('the three doors on a key', () => {
  it('folds what the glance leaves out under Details: one toggle per key, on its facts line, never in a label', async () => {
    await mount();
    // One per key, and only one.
    const folds = [...document.querySelectorAll<HTMLElement>('button[aria-expanded]')].filter(
      (button) => button.textContent === 'Details',
    );
    expect(folds).toHaveLength(SCHEMA.rows.length);
    // A button inside the control's label would work the control as well.
    for (const key of ['ladderPerRunUsd', 'repoGuard', 'theme', 'schedulingPolicy', 'profile.webhooks']) {
      expect(foldOf(key).closest('label'), key).toBeNull();
      expect(foldOf(key)).toHaveAttribute('aria-expanded', 'false');
    }
    // Folded, its facts are not drawn: a fold is not a cache.
    expect(within(rowOf('ladderPerRunUsd')).queryByText('number in dollars')).toBeNull();

    const region = openFold('ladderPerRunUsd');
    expect(within(region).getByText('number in dollars')).toBeTruthy();
    // The file the value is written in — this console's own, where the schema says it was set.
    expect(within(region).getByText('Written in')).toBeTruthy();
    expect(within(region).getByRole('button', { name: SCHEMA.files.instance })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Inspect' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('adds the words and the command line a key’s glance does not already say', async () => {
    await mount();
    // A word: its words. A shipped default lives in no file, so none is named.
    const theme = openFold('theme');
    expect(within(theme).getByText('word')).toBeTruthy();
    expect(within(theme).getByText('system, light, dark')).toBeTruthy();
    expect(within(theme).getByText('Written in')).toBeTruthy();
    expect(within(openFold('repoGuard')).queryByText('Written in')).toBeNull();
    // A read-only key says its line on the glance already, so its fold does not say it twice.
    const line = 'phase-console run queue-policy --policy <word>';
    expect(within(rowOf('schedulingPolicy')).getAllByRole('button', { name: line })).toHaveLength(1);
    const policy = openFold('schedulingPolicy');
    expect(within(policy).getByText('seniority, blocker-first, critical-path')).toBeTruthy();
    expect(within(policy).queryByRole('button', { name: line })).toBeNull();
    expect(within(rowOf('schedulingPolicy')).getAllByRole('button', { name: line })).toHaveLength(1);
  });

  it('keeps the file and Inspect in the fold under Everything, where the row already says the rest', async () => {
    await mount();
    fireEvent.click(screen.getByRole('switch', { name: 'Everything' }));
    await waitFor(() => expect(within(rowOf('ladderPerRunUsd')).getByText('number in dollars')).toBeTruthy());
    const region = openFold('ladderPerRunUsd');
    expect(within(region).queryByText('number in dollars')).toBeNull();
    expect(within(region).getByRole('button', { name: SCHEMA.files.instance })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Inspect' })).toBeTruthy();
    // Nothing written anywhere and nothing left unsaid: the fold is the way into the panel alone.
    expect(
      within(openFold('repoGuard'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Inspect']);
  });

  it('puts the key’s whole record in the panel — every fact its schema row carries, and the row', async () => {
    await mountWithPanel();
    const { panel, button } = await inspectFromFold('ladderPerRunUsd');
    expect(within(panel).getByRole('heading', { level: 2, name: 'ladderPerRunUsd' })).toBeTruthy();
    expect(panel).toHaveTextContent('Repair dollars per run.');
    expect(factOf(panel, 'Value')).toHaveTextContent('$30');
    expect(factOf(panel, 'Default')).toHaveTextContent('$20');
    expect(factOf(panel, 'Comes from')).toHaveTextContent('Set here');
    expect(
      within(factOf(panel, 'Written in')).getByRole('button', { name: SCHEMA.files.instance }),
    ).toBeTruthy();
    expect(within(factOf(panel, 'Changed in')).getByRole('link', { name: 'Automation' })).toHaveAttribute(
      'href',
      '#/settings/automation',
    );
    expect(factOf(panel, 'Type')).toHaveTextContent('number in dollars');
    // A key has no history the console keeps, and no act but its own control.
    expect(
      within(panel)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Overview', 'Raw']);
    // The row on show says so.
    expect(button).toHaveAttribute('aria-pressed', 'true');

    const raw = openRaw(panel);
    const row = SCHEMA.rows.find((one) => one.key === 'ladderPerRunUsd');
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(row)));
  });

  it('says where a structured or read-only key is drawn, and the line that changes it', async () => {
    await mountWithPanel();
    const { panel } = await inspectFromFold('schedulingPolicy');
    expect(factOf(panel, 'Value')).toHaveTextContent('seniority');
    expect(within(factOf(panel, 'Changed in')).getByRole('link', { name: 'Automation' })).toBeTruthy();
    expect(
      within(factOf(panel, 'Command line')).getByRole('button', {
        name: 'phase-console run queue-policy --policy <word>',
      }),
    ).toBeTruthy();
    expect(factOf(panel, 'Words')).toHaveTextContent('seniority, blocker-first, critical-path');
    expect(factOf(panel, 'Type')).toHaveTextContent('word');
    // Nothing stores it: the shipped default, in no file.
    expect(factOf(panel, 'Comes from')).toHaveTextContent('The shipped default');
    expect(within(within(panel).getByTestId('key-overview')).queryByText('Written in')).toBeNull();
  });

  it('keeps a secret one in the panel: said as set, its row withheld, not even its masked tail drawn', async () => {
    await mountWithPanel();
    const { panel } = await inspectFromFold('profile.webhooks');
    expect(factOf(panel, 'Value')).toHaveTextContent('1 set: Team channel');
    expect(factOf(panel, 'Kept secret')).toHaveTextContent('Yes: the console never serves its value');
    // The machine profile is shown on This instance and changed only from a terminal.
    expect(within(factOf(panel, 'Shown in')).getByRole('link', { name: 'This instance' })).toHaveAttribute(
      'href',
      '#/settings/instance',
    );
    expect(
      within(factOf(panel, 'Written in')).getByRole('button', { name: SCHEMA.files.profile }),
    ).toBeTruthy();
    const raw = openRaw(panel);
    expect(JSON.parse(raw.textContent ?? '')).toMatchObject({ key: 'profile.webhooks', value: '[withheld]' });
    expect(document.body.textContent).not.toContain('…a1b2');
    expect(document.body.textContent).not.toContain('hooks.example.com');
  });

  it('follows a save: the panel reads the key from the one schema answer the row reads', async () => {
    await mountWithPanel();
    const { panel } = await inspectFromFold('ladderPerRunUsd');
    expect(factOf(panel, 'Value')).toHaveTextContent('$30');
    // What the server reads once the save has landed.
    server.reads['/api/prefs/schema'] = {
      ...SCHEMA,
      rows: SCHEMA.rows.map((row) => (row.key === 'ladderPerRunUsd' ? { ...row, value: 45 } : row)),
    };
    const usd = within(rowOf('ladderPerRunUsd')).getByRole('spinbutton');
    fireEvent.change(usd, { target: { value: '45' } });
    fireEvent.blur(usd);
    await waitFor(() => expect(factOf(panel, 'Value')).toHaveTextContent('$45'));
  });

  it('draws a group’s count as its own item beside the title, a gap between and no margin', async () => {
    await mount();
    const group = document.querySelector('[data-settings-group="everything-automation"]') as HTMLElement;
    const pair = within(group).getByRole('heading', { level: 2 }).firstElementChild as HTMLElement;
    // A margin on the count's start edge lands outside the run under `dir="rtl"`; a gap holds both ways.
    expect(pair.className).toMatch(/\binline-flex\b/);
    expect(pair.className).toMatch(/\bgap-2\b/);
    const [title, count] = [...pair.children] as HTMLElement[];
    expect(title!.textContent).toBe('Automation');
    expect(count!.textContent).toMatch(/^\d+$/);
    expect(count!.className).not.toMatch(/(?:^|\s)-?m[sexl]?-/);
  });
});

describe('a key’s facts', () => {
  it('names the file a value is written in only where the schema says one holds it', () => {
    const files = SCHEMA.files;
    expect(keyFileOf({ source: 'instance' }, files)).toBe(files.instance);
    expect(keyFileOf({ source: 'config' }, files)).toBe(files.config);
    expect(keyFileOf({ source: 'profile' }, files)).toBe(files.profile);
    expect(keyFileOf({ source: 'default' }, files)).toBeUndefined();
    expect(keyFileOf({ source: 'migrated' }, files)).toBeUndefined();
    expect(keyFileOf({ source: 'instance' }, undefined)).toBeUndefined();
  });

  it('withholds a secret’s value in its raw row, and leaves every other row as it came', () => {
    const notify = SCHEMA.rows.find((row) => row.key === 'profile.notifyCommand')!;
    const usd = SCHEMA.rows.find((row) => row.key === 'ladderPerRunUsd')!;
    expect(keyRaw(notify).value).toBe('[withheld]');
    expect(keyRaw(usd)).toBe(usd);
    // A secret nothing set is said as nothing set.
    expect(keyRaw({ ...notify, value: null }).value).toBeNull();
  });
});

describe('a value in words', () => {
  it('says a number in its unit, never a raw count of milliseconds or bytes', () => {
    expect(numberWords(600_000, 'ms')).toBe('10 minutes');
    expect(numberWords(1_500, 'ms')).toBe('1,500 ms');
    expect(numberWords(5 * 1024 * 1024, 'bytes')).toBe('5 MB');
    expect(numberWords(20, 'usd')).toBe('$20');
    expect(numberWords(1, 'days')).toBe('1 day');
    expect(numberWords(2, 'factor')).toBe('2×');
  });

  it('says a list, a map, an empty value and nothing at all as words', () => {
    const row = { key: 'k', type: 'list' };
    expect(valueWords(row, ['a', 'b', 'c', 'd'])).toBe('a, b, c and 1 more');
    expect(valueWords(row, [])).toBe('None');
    expect(valueWords({ key: 'k', type: 'map' }, { a: 1, b: 2 })).toBe('2 entries');
    expect(valueWords({ key: 'k', type: 'string' }, '')).toBe('Empty');
    expect(valueWords({ key: 'k', type: 'string' }, null)).toBe('Not set');
    expect(valueWords({ key: 'k', type: 'boolean' }, false)).toBe('Off');
  });
});
