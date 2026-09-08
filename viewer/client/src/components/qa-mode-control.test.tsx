/**
 * The QA switch — what it says, what it posts, and how it degrades.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QaModeControl } from './qa-mode-control';

const { qaModeSet } = vi.hoisted(() => ({ qaModeSet: vi.fn() }));

vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, qaModeSet } };
});

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('the plan-level switch', () => {
  it("reads the engine's word with its reason, marks the current choice, and posts the other", async () => {
    qaModeSet.mockResolvedValue({
      ok: true,
      plan: { mode: 'waived' },
      detail: 'QA now reads waived for alpha.',
    });
    mount(<QaModeControl slug="alpha" mode="on" reason="plan directive: QA gate: on" allowWrites />);
    expect(screen.getByText('QA gate · on (plan directive: QA gate: on)')).toBeInTheDocument();
    const on = screen.getByRole('button', { name: 'On' });
    expect(on).toHaveAttribute('aria-pressed', 'true');
    expect(on).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'off' }));
  });

  it('shows a gate written off as the engine reads it — waived — with Off current', () => {
    mount(<QaModeControl slug="alpha" mode="waived" reason="plan directive: QA gate: off" allowWrites />);
    expect(screen.getByText(/QA gate · waived/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'On' })).not.toBeDisabled();
  });

  it('degrades to the hand command without --allow-writes, never to nothing', () => {
    mount(<QaModeControl slug="alpha" mode="on" allowWrites={false} scriptsDir="/opt/pe/scripts" />);
    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('title')).toMatch(/--allow-writes/);
    expect(screen.getByText(/By hand:/).textContent).toContain(
      'bash /opt/pe/scripts/qa-mode.sh alpha <on|off>',
    );
  });
});

describe('the per-phase switch', () => {
  it('says the phase inherits the plan, with Inherit current, and posts the phase with a directive', async () => {
    qaModeSet.mockClear();
    qaModeSet.mockResolvedValue({
      ok: true,
      plan: { mode: 'on' },
      phase: { phase: 3, regime: { mode: 'off' } },
      detail: 'ok',
    });
    mount(
      <QaModeControl
        slug="alpha"
        mode="on"
        phase={3}
        phaseMode={{ mode: 'on', source: 'plan' }}
        allowWrites
      />,
    );
    expect(screen.getByText('QA for this phase · inherits the plan (on)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inherit' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'off', phase: 3 }));
  });

  it("names the phase's own directive, and Inherit removes it", async () => {
    qaModeSet.mockClear();
    qaModeSet.mockResolvedValue({ ok: true, detail: 'ok' });
    mount(
      <QaModeControl
        slug="alpha"
        mode="on"
        phase={2}
        phaseMode={{ mode: 'off', source: 'phase' }}
        allowWrites
      />,
    );
    expect(screen.getByText('QA for this phase · off (phase directive)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Inherit' }));
    await waitFor(() => expect(qaModeSet).toHaveBeenCalledWith('alpha', { mode: 'inherit', phase: 2 }));
    // A console that may write prints no hand command.
    expect(screen.queryByText(/By hand/)).toBeNull();
  });
});
