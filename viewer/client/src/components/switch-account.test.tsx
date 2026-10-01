/**
 * The switch-account control offers "at the next boundary", previews which
 * lanes a switch would checkpoint from the server's own answer, and reports
 * what the switch did (control-tower phase 25 — #92 and #107's ask 2).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@/lib/api';

const { accounts, runSwitchAccount, runSwitchPreview, toast } = vi.hoisted(() => ({
  accounts: vi.fn(),
  runSwitchAccount: vi.fn(),
  runSwitchPreview: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, accounts, runSwitchAccount, runSwitchPreview } };
});
vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast };
});

import { SwitchAccountRow, previewText, switchedText } from './switch-account';

const ACCOUNTS = [
  { id: 'default', kind: 'default', builtIn: true, name: 'machine login', email: 'me@example.com' },
  { id: 'acct-work', kind: 'token', name: 'work', email: 'work@example.com' },
] as unknown as AccountView[];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SwitchAccountRow slug="demo" run={{ accountId: 'default' }} disabled={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  accounts.mockResolvedValue({ accounts: ACCOUNTS, allowAccounts: true });
  runSwitchPreview.mockImplementation((_slug: string, _id: string, when?: string) =>
    Promise.resolve(
      when === 'boundary'
        ? { ok: true, wouldCheckpoint: [], deferred: [3, 7] }
        : { ok: true, wouldCheckpoint: [3], deferred: [7] },
    ),
  );
  runSwitchAccount.mockResolvedValue({ ok: true, checkpointed: 0, deferred: [3, 7], rekeyed: 2 });
});

describe('the switch control', () => {
  it('previews, from the server, which lanes switching now would checkpoint', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Account for this run'), {
      target: { value: 'acct-work' },
    });
    expect(await screen.findByTestId('switch-preview')).toHaveTextContent(
      'Checkpoints phase 3 now (the session id is kept); phase 7 finishes on the old account first.',
    );
    expect(runSwitchPreview).toHaveBeenCalledWith('demo', 'acct-work', 'now');
    expect(runSwitchAccount).not.toHaveBeenCalled();
  });

  it('offers the next boundary, previews that nothing is cut, and reports what the switch did', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Account for this run'), {
      target: { value: 'acct-work' },
    });
    fireEvent.change(screen.getByLabelText('When to switch'), { target: { value: 'boundary' } });
    expect(
      await screen.findByText(/At the next boundary: Checkpoints nothing; phases 3 and 7 finish/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }));
    await waitFor(() => expect(runSwitchAccount).toHaveBeenCalledWith('demo', 'acct-work', 'boundary'));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        'Switched — phases 3 and 7 finish first — 2 queued phases moved with it. The next session runs under the other account.',
        'ok',
      ),
    );
  });

  it('words a preview and an outcome from the verb’s own fields', () => {
    expect(previewText('now', { wouldCheckpoint: [], deferred: [] })).toBe(
      'No session is live — the next one starts on the new account.',
    );
    expect(switchedText({ checkpointed: 1, deferred: [], rekeyed: 0 })).toBe(
      'Switched — 1 live session checkpointed. The next session runs under the other account.',
    );
  });
});
