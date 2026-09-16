/**
 * The relay's rule table (zero-touch phase 14): rules edited from `/api/state`
 * and saved WHOLE through `/api/prefs` — a rule needs a key and an answer, a
 * removal takes it out of the list that is written, and nothing ships.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClientConfig } from '@/lib/queries';

const { state, savePrefs } = vi.hoisted(() => ({ state: vi.fn(), savePrefs: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, state, savePrefs } };
});

async function mount(relayRules?: unknown) {
  state.mockResolvedValue({
    root: { ok: true, path: '/repo' },
    autopilot: true,
    prefs: relayRules === undefined ? {} : { relayRules },
  });
  savePrefs.mockResolvedValue({});
  const { RelayRulesEditor } = await import('./relay-rules');
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <RelayRulesEditor />
    </QueryClientProvider>,
  );
  await screen.findByText('Relay rules');
}

const saved = () => savePrefs.mock.calls.at(-1)![0].relayRules;

beforeEach(() => {
  state.mockReset();
  savePrefs.mockReset();
});

describe('<RelayRulesEditor>', () => {
  it('adds a rule with its key, its answer and its profile, written whole', async () => {
    await mount();
    expect(screen.getByText(/No rules ship/)).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Relay rule question key'), { target: { value: 'colour:*' } });
    fireEvent.change(screen.getByLabelText('Relay rule answer'), { target: { value: 'Blue' } });
    fireEvent.change(screen.getByLabelText('Relay rule profile'), { target: { value: 'trusted' } });
    fireEvent.click(add);
    await waitFor(() => expect(savePrefs).toHaveBeenCalledTimes(1));
    expect(saved()).toEqual([
      {
        id: 'AskUserQuestion:colour:*:trusted',
        tool: 'AskUserQuestion',
        key: 'colour:*',
        profile: 'trusted',
        answer: 'Blue',
      },
    ]);
  });

  it('removes a rule by writing the list without it', async () => {
    await mount([
      { key: 'colour:*', answer: 'Blue' },
      { key: 'port:*', answer: '8080', profile: 'guarded' },
    ]);
    expect(await screen.findByText('colour:*')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule for colour:*' }));
    await waitFor(() => expect(savePrefs).toHaveBeenCalledTimes(1));
    expect(saved()).toEqual([
      {
        id: 'AskUserQuestion:port:*:guarded',
        tool: 'AskUserQuestion',
        key: 'port:*',
        profile: 'guarded',
        answer: '8080',
      },
    ]);
  });
});
