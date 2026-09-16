/**
 * The policy editor (zero-touch phase 12): every row of the policy table has
 * a control, a change writes the WHOLE `policy` object (a merge would leave
 * an answer the operator meant to clear), a free-text key saves one line on
 * blur, and a picked plan shows its own reading beside the console's with the
 * answer in force and its source.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';
import { POLICY_TABLE, POLICY_DEFAULTS } from '@shared/policy-model.js';

const { state, savePrefs, plans, runPrelude } = vi.hoisted(() => ({
  state: vi.fn(),
  savePrefs: vi.fn(),
  plans: vi.fn(),
  runPrelude: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs, plans, runPrelude } };
});

async function mount(prefs: Record<string, unknown> = {}) {
  state.mockResolvedValue({ root: { ok: true, path: '/repo' }, autopilot: true, prefs });
  savePrefs.mockResolvedValue({});
  plans.mockResolvedValue([{ slug: 'shop', phases: 3, ready: [] }]);
  runPrelude.mockResolvedValue({
    prelude: {
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
      at: '2026-09-14T00:00:00Z',
    },
  });
  const { PolicyAnswersCard } = await import('./policy');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <PolicyAnswersCard />
    </QueryClientProvider>,
  );
  await screen.findByText('Automation · policy answers');
}

const control = (cls: string) =>
  document.querySelector(`[data-policy-control="${cls}"]`) as HTMLSelectElement | HTMLInputElement;

beforeEach(() => {
  state.mockReset();
  savePrefs.mockReset();
  plans.mockReset();
  runPrelude.mockReset();
});

describe('<PolicyAnswersCard>', () => {
  it('renders every row of the policy table with its key, its shipped default and one control', async () => {
    await mount({});
    for (const row of POLICY_TABLE) {
      const tr = document.querySelector(`[data-policy-row="${row.class}"]`)!;
      expect(tr, row.class).not.toBeNull();
      expect(within(tr as HTMLElement).getByText(row.decisionKey, { selector: 'code' })).toBeTruthy();
      expect(tr.querySelectorAll('[data-policy-control]')).toHaveLength(1);
    }
    // A closed key is a select of its words; a free-text key is a line of text.
    expect(control('manual-gate').tagName).toBe('SELECT');
    expect(control('human-only').tagName).toBe('INPUT');
    // The shipped default shows where one ships — and reads as the selection
    // when the console holds no override.
    const gates = document.querySelector('[data-policy-row="manual-gate"]')!;
    expect(gates.textContent).toContain(POLICY_DEFAULTS.gates);
    expect((control('manual-gate') as HTMLSelectElement).value).toBe('');
  });

  it('a change writes the whole policy object, merged; the shipped default clears the key', async () => {
    await mount({ policy: { 'qa.exhausted': 'halt' } });
    expect((control('qa-exhausted') as HTMLSelectElement).value).toBe('halt');
    fireEvent.change(control('manual-gate'), { target: { value: 'operator' } });
    await waitFor(() =>
      expect(savePrefs).toHaveBeenCalledWith({ policy: { 'qa.exhausted': 'halt', gates: 'operator' } }),
    );
    fireEvent.change(control('qa-exhausted'), { target: { value: '' } });
    // Clearing sends the object WITHOUT the key — the server replaces the
    // object wholesale, so an omitted key is a cleared one. Each write merges
    // over what the server holds (the mocked state still says `halt` alone),
    // never over an unsaved draft.
    await waitFor(() => expect(savePrefs).toHaveBeenLastCalledWith({ policy: {} }));
    expect(savePrefs).toHaveBeenCalledTimes(2);
  });

  it('a free-text row saves one line on blur or Enter, and nothing when unchanged', async () => {
    await mount({ policy: { stop: 'page me' } });
    const input = control('human-only') as HTMLInputElement;
    expect(input.value).toBe('page me');
    fireEvent.blur(input);
    expect(savePrefs).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  keep-going; page me  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ policy: { stop: 'keep-going; page me' } }));
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(savePrefs).toHaveBeenLastCalledWith({ policy: {} }));
  });

  it('an owner key takes a name beside its closed words', async () => {
    await mount({ policy: { 'qa.exhausted': 'dev-lead' } });
    const select = control('qa-exhausted') as HTMLSelectElement;
    expect(select.value).toBe('__owner');
    expect(within(select).getByText('owner: dev-lead')).toBeTruthy();
    fireEvent.change(select, { target: { value: '__owner' } });
    const who = screen.getByLabelText('qa.exhausted owner (qa-exhausted)') as HTMLInputElement;
    fireEvent.change(who, { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalledWith({ policy: { 'qa.exhausted': 'sam' } }));
  });

  it('picking a plan shows its reading per key and the answer in force with its source', async () => {
    await mount({ policy: { 'qa.exhausted': 'halt' } });
    fireEvent.change(screen.getByLabelText('Compare with a plan'), { target: { value: 'shop' } });
    await waitFor(() => expect(runPrelude).toHaveBeenCalledWith('shop', expect.anything()));
    // The plan's own row outranks the console: gates reads `operator` from the plan.
    const gates = await waitFor(() => document.querySelector('[data-policy-plan="manual-gate"]')!);
    await waitFor(() => expect(gates.textContent).toContain("the plan's row · answered"));
    expect(document.querySelector('[data-policy-in-force="manual-gate"]')!.textContent).toContain('operator');
    expect(document.querySelector('[data-policy-in-force="manual-gate"]')!.textContent).toContain(
      'from the plan',
    );
    // No plan row for qa.exhausted: the console's `halt` is what is in force.
    expect(document.querySelector('[data-policy-plan="qa-exhausted"]')!.textContent).toContain('no plan row');
    expect(document.querySelector('[data-policy-in-force="qa-exhausted"]')!.textContent).toContain('halt');
    expect(document.querySelector('[data-policy-in-force="qa-exhausted"]')!.textContent).toContain(
      'from the console',
    );
    // A key nothing answers is `unstated` — never invented.
    expect(document.querySelector('[data-policy-in-force="carve-out"]')!.textContent).toContain('unstated');
  });
});
