/**
 * The gate card — the one control that widens what an unattended run may do.
 *
 * Three properties:
 *
 * 1. **Approving asks, and the asking says what it does.** It used to be a
 *    button that changed its own words to "Press again to approve", with the
 *    whole explanation in a `title` — which a phone never shows and a screen
 *    reader reads as part of the button's name. It is a dialog now, and the
 *    explanation is its body.
 * 2. **"Continue the run" is offered only when a run is actually parked on
 *    this phase.** Approving must never quietly resume a run the operator
 *    stopped for unrelated reasons.
 * 3. **A read-only console renders no control at all**, and says which flag
 *    and which script are the way through.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import { expectNoAxeViolations } from '@/test/axe';
import type { GateStatus, PhaseView } from '@/lib/api';
import { GateCard } from './gate-card';

const { approveGate, run } = vi.hoisted(() => ({ approveGate: vi.fn(), run: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, approveGate, run } };
});

const view = (over: Partial<PhaseView> = {}): PhaseView =>
  ({
    phase: 4,
    title: 'Cutover',
    state: 'ready',
    size: 'M',
    gated: true,
    gateKind: 'human',
    gates: '1. mint the keys\n2. export them',
    ...over,
  }) as unknown as PhaseView;

const GATE: GateStatus = { clear: false, kind: 'human', detail: 'awaiting approval' } as GateStatus;

function mount(allowWrites = true, over: Partial<PhaseView> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        <GateCard slug="demo" view={view(over)} gate={GATE} allowWrites={allowWrites} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  approveGate.mockResolvedValue({ ok: true, detail: 'recorded' });
  run.mockResolvedValue({ run: null });
});

describe('the gate card', () => {
  it('asks before approving, and the question says what approving does', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve gate' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Approve this gate?');
    // The sentence that used to live in a `title` — where a phone never saw it.
    expect(dialog).toHaveTextContent(/gate-status\.md/);
    expect(dialog).toHaveTextContent(/Nothing bypasses the gate/);
    // Nothing has been written yet.
    expect(approveGate).not.toHaveBeenCalled();
  });

  it('records the approval with the note when the question is answered', async () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText(/what was done or verified/), {
      target: { value: 'keys minted and exported' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve gate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve gate' }));

    await waitFor(() =>
      expect(approveGate).toHaveBeenCalledWith('demo', 4, {
        approve: true,
        note: 'keys minted and exported',
        continueRun: false,
      }),
    );
  });

  it('offers "continue the run" only where a run is parked on this phase', async () => {
    // No run: the offer is not there at all.
    mount();
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });

  it('carries the run forward when one is parked on the gate, and says it is doing that', async () => {
    run.mockResolvedValue({ run: { phases: { '4': { status: 'gated' } } } });
    mount();
    // A real Checkbox, not a bare `<input type=checkbox>`: the drawn box is
    // 16 px and the hit area is the thumb floor.
    const box = await screen.findByRole('checkbox', { name: /continue the run/ });
    expect(box).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Approve gate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve gate' }));
    await waitFor(() =>
      expect(approveGate).toHaveBeenCalledWith('demo', 4, {
        approve: true,
        note: undefined,
        continueRun: true,
      }),
    );
  });

  it('says which flag and which script when writes are off', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: 'Approve gate' })).toBeNull();
    expect(screen.getByText(/--allow-writes/)).toBeInTheDocument();
    expect(screen.getByText(/gate-approve\.sh/)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});
