/**
 * Policy answers (quiet-console phase 21; the editor is zero-touch phase
 * 12's): every row of the policy table has exactly one control, a change sends
 * the WHOLE `policy` object (a merge would leave an answer the operator meant
 * to clear), a free-text key saves one line when it is left, an owner key
 * takes a name, and a picked plan shows its own reading beside the console's
 * with the answer in force and its source. The wire is what is asserted: what
 * `POST /api/prefs` was sent.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POLICY_DEFAULTS, POLICY_TABLE } from '@shared/policy-model.js';
import type { Call } from './test-kit';

const server = vi.hoisted(() => ({ reads: {} as Record<string, unknown>, calls: [] as Call[] }));
vi.mock('@/data/http', async (importOriginal) =>
  (await import('./test-kit')).fixtureHttp(await importOriginal(), server),
);
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/ui')>()), toast }));

import { renderWithClient, schemaAnswer, sent } from './test-kit';
import { PolicyGroup, policyClassWords } from './policy';

/** What the plan `shop` says at the launch door: its own `gates` row, and a default for `qa.exhausted`. */
const PRELUDE = {
  slug: 'shop',
  rows: [
    {
      key: 'gates',
      value: 'operator',
      owner: 'op',
      state: 'answered',
      blocking: 'no',
      source: 'plan',
      origin: 'plan',
    },
    {
      key: 'qa.exhausted',
      value: 'waive',
      owner: 'console',
      state: 'answered',
      blocking: 'no',
      source: 'default',
      origin: 'default',
    },
  ],
  probes: {},
  blocking: [],
  waived: [],
  acknowledged: [],
  manifestPresent: true,
  accounts: [],
  credentials: { policy: 'continue', ids: [], held: [], missing: [] },
  delivery: { ok: true, channels: [], acknowledged: false },
  at: '2026-10-11T00:00:00Z',
};

/** A console holding `stored`: the schema reads it, and a save merges into it as the server's would. */
function serve(stored: Record<string, unknown>) {
  const held: Record<string, unknown> = { ...stored };
  server.reads['/api/prefs/schema'] = () =>
    schemaAnswer(
      Object.fromEntries(
        Object.entries(held).map(([key, value]) => [key, { value, source: 'instance' as const }]),
      ),
    );
  server.reads['POST /api/prefs'] = (body: unknown) => {
    Object.assign(held, body as Record<string, unknown>);
    return { ok: true };
  };
}

const control = (cls: string) =>
  document.querySelector(`[data-policy-control="${cls}"]`) as HTMLSelectElement | HTMLInputElement | null;

/** The control of one row, once the rows have drawn. */
const rowControl = (cls: string) =>
  waitFor(() => {
    const found = control(cls);
    expect(found, cls).not.toBeNull();
    return found!;
  });

const saves = () => sent(server, 'POST', '/api/prefs');

beforeEach(() => {
  server.calls = [];
  server.reads = {
    '/api/plans': [{ slug: 'shop', phases: 3, ready: [] }],
    '/api/run/shop/prelude': { prelude: PRELUDE },
  };
  toast.mockClear();
});

describe('<PolicyGroup>', () => {
  it('draws every row of the policy table with its key, its shipped default and one control', async () => {
    serve({});
    const { container } = renderWithClient(<PolicyGroup />);
    await rowControl('manual-gate');
    for (const row of POLICY_TABLE) {
      const drawn = container.querySelector(`[data-policy-row="${row.class}"]`) as HTMLElement | null;
      expect(drawn, row.class).not.toBeNull();
      expect(within(drawn!).getByText(policyClassWords(row.class))).toBeTruthy();
      expect(within(drawn!).getByText(row.decisionKey, { selector: 'code' })).toBeTruthy();
      expect(drawn!.querySelectorAll('[data-policy-control]')).toHaveLength(1);
    }
    // A closed key is a select of its words; a free-text key is a line of text.
    expect(control('manual-gate')!.tagName).toBe('SELECT');
    expect(control('human-only')!.tagName).toBe('INPUT');
    // The shipped default is said where one ships, and is the selection while
    // the console holds no answer of its own.
    const gates = container.querySelector('[data-policy-row="manual-gate"]')!;
    expect(gates.textContent).toContain(`Ships as ${POLICY_DEFAULTS.gates}`);
    expect(gates.textContent).toContain('Same answer as Gate block');
    expect(control('manual-gate')!.value).toBe('');
    expect(container.querySelector('[data-policy-row="human-only"]')!.textContent).toContain('Nothing ships');
    // The key and the relay rules under it are each ONE editor to the coverage count.
    expect(container.querySelectorAll('[data-pref="policy"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-pref="relayRules"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-policy-control]')).toHaveLength(POLICY_TABLE.length);
  });

  it('a change sends the whole policy object, merged; the shipped default takes the key out', async () => {
    serve({ policy: { 'qa.exhausted': 'halt' } });
    renderWithClient(<PolicyGroup />);
    await waitFor(async () => expect((await rowControl('qa-exhausted')).value).toBe('halt'));
    fireEvent.change(control('manual-gate')!, { target: { value: 'operator' } });
    await waitFor(() => expect(saves()).toEqual([{ policy: { 'qa.exhausted': 'halt', gates: 'operator' } }]));
    // One key, two rows: the row that shares it reads the same answer.
    await waitFor(() => expect(control('gate-block')!.value).toBe('operator'));
    fireEvent.change(control('qa-exhausted')!, { target: { value: '' } });
    // The object goes WITHOUT the key — the server replaces it whole, so an
    // omitted key is a cleared one.
    await waitFor(() => expect(saves().at(-1)).toEqual({ policy: { gates: 'operator' } }));
    expect(saves()).toHaveLength(2);
  });

  it('a free-text row saves one line when it is left or on Enter, and nothing when unchanged', async () => {
    serve({ policy: { stop: 'page me' } });
    renderWithClient(<PolicyGroup />);
    const input = (await rowControl('human-only')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('page me'));
    fireEvent.blur(input);
    expect(saves()).toEqual([]);
    fireEvent.change(input, { target: { value: '  keep-going; page me  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saves()).toEqual([{ policy: { stop: 'keep-going; page me' } }]));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(saves().at(-1)).toEqual({ policy: {} }));
  });

  it('an owner key takes a name beside its closed words, and refuses one that is not a name', async () => {
    serve({ policy: { 'qa.exhausted': 'dev-lead' } });
    renderWithClient(<PolicyGroup />);
    const select = (await rowControl('qa-exhausted')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('__owner'));
    expect(within(select).getByText('Owner dev-lead')).toBeTruthy();
    fireEvent.change(select, { target: { value: '__owner' } });
    const who = screen.getByLabelText('Who owns qa.exhausted') as HTMLInputElement;
    expect(who.value).toBe('dev-lead');
    fireEvent.change(who, { target: { value: 'not a name!' } });
    expect(screen.getByRole('button', { name: 'Set the owner' })).toBeDisabled();
    fireEvent.change(who, { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set the owner' }));
    await waitFor(() => expect(saves()).toEqual([{ policy: { 'qa.exhausted': 'sam' } }]));
  });

  it('a picked plan shows its reading per key, and the answer in force with where it came from', async () => {
    serve({ policy: { 'qa.exhausted': 'halt' } });
    const { container } = renderWithClient(<PolicyGroup />);
    await screen.findByRole('option', { name: 'shop' });
    fireEvent.change(screen.getByLabelText('Compare with a plan'), { target: { value: 'shop' } });
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === '/api/run/shop/prelude')).toBe(true),
    );
    const read = (attr: string, cls: string) =>
      container.querySelector(`[${attr}="${cls}"]`)?.textContent ?? '';
    // The plan's own row outranks the console: gates reads `operator` from the plan.
    await waitFor(() => expect(read('data-policy-plan', 'manual-gate')).toBe('shop says operator, answered'));
    expect(read('data-policy-in-force', 'manual-gate')).toBe('In force: operator, from the plan');
    // No plan row for qa.exhausted: the console's `halt` is what holds.
    expect(read('data-policy-plan', 'qa-exhausted')).toBe('shop has no row; the default says waive');
    expect(read('data-policy-in-force', 'qa-exhausted')).toBe('In force: halt, from the console');
    // A key nothing answers is unstated — never invented.
    expect(read('data-policy-in-force', 'carve-out')).toBe('Unstated: nothing answers it');
    // And a key with no answer anywhere but the shipped one says so.
    expect(read('data-policy-in-force', 'ambiguity')).toBe(
      `In force: ${POLICY_DEFAULTS.ambiguity}, from the shipped default`,
    );
  });

  it('a save the owner door holds is said in the server’s words, and the answer goes back', async () => {
    serve({});
    server.reads['POST /api/prefs'] = {
      requested: true,
      request: { id: 'r1', ask: 'asked by this device' },
      error: 'Asked of the owner: confirm it on Your turn.',
    };
    renderWithClient(<PolicyGroup />);
    const select = await rowControl('manual-gate');
    fireEvent.change(select, { target: { value: 'operator' } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Asked of the owner: confirm it on Your turn.', 'info', 6000),
    );
    await waitFor(() => expect(control('manual-gate')!.value).toBe(''));
  });
});
