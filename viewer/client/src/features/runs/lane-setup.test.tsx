/**
 * The run-page controls card: the account picker, and whether Continue is
 * honest about what is still running.
 *
 * The bug this pins: the old select listed the accounts MINUS the current one,
 * which on a two-account machine read as "the console only knows one account"
 * — the exact question the row exists to answer. Every account renders now,
 * the current one marked, and Switch only arms once a different one is picked.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type { AccountsState, RunState } from '@/lib/api';

const { accountsMock } = vi.hoisted(() => ({
  accountsMock: vi.fn<() => Promise<AccountsState>>(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      accounts: accountsMock,
      runSwitchAccount: vi.fn(async () => ({ ok: true })),
    },
  };
});

import { SwitchAccountRow } from '@/components/switch-account';

const RUN = { id: 'r1', slug: 'demo', status: 'running' } as unknown as RunState;

function mount(run: RunState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SwitchAccountRow slug="demo" run={run} disabled={false} />
    </QueryClientProvider>,
  );
}

describe('SwitchAccountRow', () => {
  it('lists EVERY account — the current one marked — and arms Switch only on a change', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [
        { id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' },
        { id: 'info', kind: 'profile', builtIn: false, name: 'info', email: 'info@example.com' },
      ],
    });
    mount(RUN);

    const select = await screen.findByRole('combobox', { name: 'Account for this run' });
    const labels = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
    expect(labels[0]).toMatch(/auto — most headroom/);
    expect(labels.some((label) => /machine login.*· current/.test(label ?? ''))).toBe(true);
    expect(labels.some((label) => /info.*info@example.com/.test(label ?? ''))).toBe(true);

    // The select shows where the run IS; Switch has nothing to do yet.
    const button = screen.getByRole('button', { name: 'Switch account' });
    expect(button).toBeDisabled();
    fireEvent.change(select, { target: { value: 'info' } });
    expect(button).not.toBeDisabled();
  });

  it('with one account it stays visible as awareness, pointing at Settings', async () => {
    accountsMock.mockResolvedValue({
      allowAccounts: true,
      accounts: [{ id: 'default', kind: 'default', builtIn: true, email: 'me@example.com' }],
    });
    mount(RUN);
    expect(await screen.findByText(/Add another account in Settings/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

/* ================================================================== *
 * B2(b) — Continue is offered on a fact, not on a word
 * ================================================================== */

import { TooltipProvider } from '@/components/ui';
import { Controls } from './lane-setup';
import type { LaneLiveness, PhaseView } from '@/lib/api';

/**
 * A halted run. `isLiveStatus('halted')` is false — the run's own word says it
 * has stopped — which is exactly the state a killed console leaves behind
 * while its session carries on editing the tree.
 */
const HALTED = { id: 'r1', slug: 'demo', status: 'halted', phases: {} } as unknown as RunState;

/** A lane the console can still see output from: a phase record in flight. */
const WORKING = [{ phase: 9, lastOutputAt: '2026-08-23T10:00:00Z' }] as unknown as LaneLiveness[];

function mountControls(liveness?: LaneLiveness[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  accountsMock.mockResolvedValue({ allowAccounts: false, accounts: [] });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Controls
          slug="demo"
          run={HALTED}
          live={false}
          busy=""
          allowRun
          planPhases={[] as PhaseView[]}
          planSkills={[]}
          {...(liveness ? { liveness } : {})}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('Continue, over a run whose session has not stopped', () => {
  it('offers Continue when the run has stopped and so has everything else', () => {
    mountControls();
    expect(screen.getByRole('button', { name: /Continue this run/ })).toBeEnabled();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('refuses — with the reason — when a lane still has a live session', () => {
    // `resumable` read `!isLiveStatus(run.status)` alone, so a halted run with
    // a session still writing the tree offered the button, and pressing it put
    // a second agent on one working tree. The server refuses that now; this is
    // the same refusal shown BEFORE the press rather than as a toast after it.
    mountControls(WORKING);
    const button = screen.getByRole('button', { name: /Something is still running/ });
    expect(button).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Continue this run/ })).toBeNull();
    // And the card stops calling it stopped, which was the other half of the
    // lie: a run reading "Stopped" over a session that was not.
    expect(screen.queryByText('Stopped')).toBeNull();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText(/second agent on the same working tree/)).toBeInTheDocument();
  });
});
