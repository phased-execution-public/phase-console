/**
 * The gate card (7.0, quiet-console phase 10; ported from
 * `features/plans/gate-card.test.tsx` and the gate cases of
 * `features/runs/item-surfaces.test.tsx`) — the one control that widens what
 * an unattended run may do.
 *
 * What is pinned:
 *
 * 1. **A gate that asks a person now is its item** (control-tower phase 139,
 *    #216): the card wears the summons — the amber leading edge and the words
 *    "Needs you" — and draws the item's row and link, never a form of its own.
 *    Nothing else on the card is amber.
 * 2. **A gate nobody is asked about keeps the plan's door** to
 *    gate-status.md: approving asks first and the question says what it does;
 *    "Continue the run" is offered only where a run is parked on the phase;
 *    an approved gate offers its revoke.
 * 3. **A read-only console draws no control** and names the flag and the
 *    script that are the way through.
 * 4. **Every press goes through the owner door**: the answer in place, a
 *    refusal in the server's words, a press the owner must confirm as asked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateStatus, InboxAction, InboxItem, PhaseView, TurnView } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { expectNoAxeViolations } from '@/test/axe';
import { Toaster, dismissToast, useToasts } from '@/ui';
import { TooltipProvider } from '@/ui/tooltip';
import { GateCard, PhaseGate } from './gate-card';

vi.setConfig({ testTimeout: 20_000 });

const { approveGate, run, inbox, plan, gate, state } = vi.hoisted(() => ({
  approveGate: vi.fn(),
  run: vi.fn(),
  inbox: vi.fn(),
  plan: vi.fn(),
  gate: vi.fn(),
  state: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, approveGate, run, inbox, plan, gate, state } };
});

const AT = '2026-10-08T10:00:00.000Z';

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

const GATE: GateStatus = { clear: false, kind: 'human', detail: 'awaiting approval' };
const APPROVED: GateStatus = { clear: true, kind: 'human', detail: 'approved by sam: keys minted' };

const action = (verb: string, label: string, over: Partial<InboxAction> = {}): InboxAction => ({
  verb,
  label,
  endpoint: `/api/x/${verb}`,
  method: 'POST',
  ...over,
});

/** A row's fields, its turn view by part — merged over the defaults below. */
type RowOver = Omit<Partial<InboxItem>, 'turn'> & { turn?: Partial<TurnView> };

/** A gate as the server raises it: Approve asks for its evidence, so the row opens the page. */
function gateItem(id: string, over: RowOver = {}): InboxItem {
  const { turn, ...rest } = over;
  return {
    id,
    kind: 'gate',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: `Row ${id}`,
    need: '',
    how: '',
    since: AT,
    href: '/plan/alpha/run',
    actions: [action('approve', 'Approve the gate', { says: { field: 'note', label: 'Evidence' } })],
    turn: {
      item: id,
      record: 'projected',
      source: 'gate',
      kind: 'decision',
      why: 'decision',
      proofType: 'answer',
      group: 'decide',
      ...turn,
    } as TurnView,
    ...rest,
  } as InboxItem;
}

/** The item-surfaces phase: gated by a person, not yet flagged gated on the record. */
const VIEW3 = {
  phase: 3,
  title: 'Cutover',
  state: 'ready',
  size: 'M',
  gated: false,
  gateKind: 'human',
} as unknown as PhaseView;
const MANUAL = { clear: false, kind: 'manual', detail: 'awaiting approval' } as GateStatus;

function mount(ui: ReactNode, items: InboxItem[] = []) {
  inbox.mockResolvedValue({ items, generatedAt: AT });
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>
        {ui}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const card = (allowWrites = true, over: Partial<PhaseView> = {}, status: GateStatus = GATE) =>
  mount(<GateCard slug="demo" view={view(over)} gate={status} allowWrites={allowWrites} />);

beforeEach(() => {
  vi.clearAllMocks();
  approveGate.mockResolvedValue({ ok: true, gate: null, detail: 'recorded' });
  run.mockResolvedValue({ run: null });
});

afterEach(() => {
  const { result, unmount } = renderHook(() => useToasts());
  act(() => {
    for (const one of result.current) dismissToast(one.id);
  });
  unmount();
});

describe('the plan’s door — a gate nobody is asked about', () => {
  it('asks before approving, and the question says what approving does', async () => {
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Approve this gate?');
    // The sentence a phone would never see in a `title`.
    expect(dialog).toHaveTextContent(/docs\/handoffs\/demo\/gate-status\.md/);
    expect(dialog).toHaveTextContent(/Nothing bypasses the gate/);
    // Nothing has been written yet.
    expect(approveGate).not.toHaveBeenCalled();
  });

  it('records the approval with the note when the question is answered, and says the answer in place', async () => {
    card();
    fireEvent.change(screen.getByRole('textbox', { name: 'Approval note' }), {
      target: { value: 'keys minted and exported' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve the gate' }));

    await waitFor(() =>
      expect(approveGate).toHaveBeenCalledWith('demo', 4, {
        approve: true,
        note: 'keys minted and exported',
        continueRun: false,
      }),
    );
    expect(await screen.findByText('recorded')).toBeInTheDocument();
  });

  it('is the one filled primary on the card', () => {
    card();
    const primary = screen.getByRole('button', { name: 'Approve the gate' });
    expect(primary).toHaveClass('bg-action');
    const filled = within(screen.getByTestId('gate-card'))
      .getAllByRole('button')
      .filter((button) => button.classList.contains('bg-action'));
    expect(filled).toEqual([primary]);
  });

  it('offers "Continue the run" only where a run is parked on this phase', async () => {
    // No run: the offer is not there at all.
    card();
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('carries the run forward when one is parked on the gate, and says it is doing that', async () => {
    run.mockResolvedValue({ run: { phases: { '4': { status: 'gated' } } } });
    card();
    // A real Checkbox: the drawn box is 16 px and the hit area is the thumb floor.
    const box = await screen.findByRole('checkbox', { name: /Continue the run/ });
    expect(box).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve the gate' }));
    await waitFor(() =>
      expect(approveGate).toHaveBeenCalledWith('demo', 4, {
        approve: true,
        note: undefined,
        continueRun: true,
      }),
    );
  });

  it('offers the revoke on an approved gate, and posts it without a note', async () => {
    card(true, {}, APPROVED);
    expect(screen.getByText('Gate approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve the gate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke the approval' }));
    await waitFor(() =>
      expect(approveGate).toHaveBeenCalledWith('demo', 4, {
        approve: false,
        note: undefined,
        continueRun: false,
      }),
    );
  });

  it('says which flag and which script when writes are off', () => {
    card(false);
    expect(screen.queryByRole('button', { name: 'Approve the gate' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/--allow-writes/)).toBeInTheDocument();
    expect(screen.getByText(/gate-approve\.sh/)).toHaveTextContent('bash scripts/gate-approve.sh demo 4');
  });

  it('says the server’s refusal, and a press the owner must confirm as asked — never as done', async () => {
    approveGate.mockRejectedValueOnce(new Error('The gate was answered by another console.'));
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve the gate' }),
    );
    expect(await screen.findByText('The gate was answered by another console.')).toBeInTheDocument();

    approveGate.mockResolvedValueOnce({
      requested: true,
      error: 'Asked of the owner: confirm it on Your turn.',
      request: { ask: 'Asked of the owner: confirm it on Your turn.' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve the gate' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Approve the gate' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve the gate' }),
    );
    expect(await screen.findByText('Asked of the owner: confirm it on Your turn.')).toBeInTheDocument();
    expect(screen.queryByText('recorded')).toBeNull();
  });

  it('draws the kind as a dot and a word, the steps, and the engine’s reading', () => {
    card(true, { gateCheck: 'cmd test -f keys.json', gateKind: 'auto' });
    const kind = screen.getByTestId('gate-card').querySelector('[data-vocab="gate"]');
    expect(kind).toHaveAttribute('data-status', 'auto');
    expect(screen.getByText('mint the keys')).toBeInTheDocument();
    expect(screen.getByText('cmd test -f keys.json').tagName).toBe('CODE');
    expect(screen.getByText('human: awaiting approval')).toBeInTheDocument();
    // A cmd gate is the autopilot's to run, never this page's.
    expect(screen.getByText(/The autopilot runs a cmd gate/)).toBeInTheDocument();
  });

  it('wears no summons — a plain card, no amber', () => {
    card();
    const drawn = screen.getByTestId('gate-card');
    expect(drawn).not.toHaveAttribute('data-summons');
    expect(drawn).not.toHaveClass('state-needs-you');
    expect(drawn).toHaveClass('bg-surface');
    expect(screen.queryByText('Needs you')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = card();
    await expectNoAxeViolations(container);
  });
});

describe('the gate card draws its item (exit criterion 1)', () => {
  it('a gate that is a person’s ask today is its item’s row — its Approve and the link — not a form', async () => {
    // As the server raises it: Approve asks for its evidence, so the row opens the page.
    mount(<GateCard slug="alpha" view={VIEW3} gate={MANUAL} allowWrites />, [gateItem('gate-alpha-3')]);
    const drawn = await screen.findByTestId('item-row');
    expect(drawn).toHaveAttribute('data-item', 'gate-alpha-3');
    expect(within(drawn).getByTestId('item-primary')).toHaveAttribute('href', '#/turn/gate-alpha-3');
    expect(screen.queryByRole('button', { name: 'Approve the gate' })).toBeNull();
    // …and the card is the summons: the amber leading edge and the words.
    const summons = screen.getByTestId('gate-card');
    expect(summons).toHaveAttribute('data-summons');
    expect(summons).toHaveClass('state-needs-you', 'border-s-state');
    expect(within(summons).getByText('Needs you')).toBeInTheDocument();
  });

  it('a gate nobody is asked about keeps the plan’s door to gate-status.md', async () => {
    mount(<GateCard slug="alpha" view={VIEW3} gate={MANUAL} allowWrites />, []);
    expect(await screen.findByRole('button', { name: 'Approve the gate' })).toBeInTheDocument();
    expect(screen.queryByTestId('item-row')).toBeNull();
  });

  it('an item that does not ask now — coming up, or a note to nobody — is no summons, and the door stays', async () => {
    for (const over of [{ turn: { group: 'upcoming' } }, { severity: 'fyi' }] as RowOver[]) {
      const { unmount } = mount(<GateCard slug="alpha" view={VIEW3} gate={MANUAL} allowWrites />, [
        gateItem('gate-alpha-3', over),
      ]);
      await waitFor(() => expect(inbox).toHaveBeenCalled());
      expect(await screen.findByRole('button', { name: 'Approve the gate' })).toBeInTheDocument();
      expect(screen.queryByTestId('item-row')).toBeNull();
      expect(screen.getByTestId('gate-card')).not.toHaveAttribute('data-summons');
      unmount();
      inbox.mockClear();
    }
  });

  it('an approved gate draws no item, even while the inbox still holds its row', async () => {
    mount(<GateCard slug="alpha" view={VIEW3} gate={APPROVED} allowWrites />, [gateItem('gate-alpha-3')]);
    expect(await screen.findByRole('button', { name: 'Revoke the approval' })).toBeInTheDocument();
    expect(screen.queryByTestId('item-row')).toBeNull();
    expect(screen.getByTestId('gate-card')).not.toHaveAttribute('data-summons');
  });

  it('another phase’s gate item is not this card’s', async () => {
    mount(<GateCard slug="alpha" view={VIEW3} gate={MANUAL} allowWrites />, [
      gateItem('gate-alpha-4', { phase: 4 }),
    ]);
    expect(await screen.findByRole('button', { name: 'Approve the gate' })).toBeInTheDocument();
    expect(screen.queryByTestId('item-row')).toBeNull();
  });
});

describe('PhaseGate — the card for a caller that knows only the phase', () => {
  const PLAN = {
    summary: { slug: 'demo' },
    phases: [view(), view({ phase: 5, gated: false, gates: undefined, gateKind: 'none' })],
  };

  it('draws the card for a gated phase, with the engine’s status and the console’s write flag', async () => {
    plan.mockResolvedValue(PLAN);
    gate.mockResolvedValue(GATE);
    state.mockResolvedValue({ allowWrites: true, scriptsDir: '/opt/pe/scripts' });
    mount(<PhaseGate slug="demo" phase={4} />);
    expect(await screen.findByTestId('gate-card')).toBeInTheDocument();
    expect(await screen.findByText('human: awaiting approval')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Approve the gate' })).toBeInTheDocument();
    expect(gate).toHaveBeenCalledWith('demo', 4);
  });

  it('names the console’s own script when its writes are off', async () => {
    plan.mockResolvedValue(PLAN);
    gate.mockResolvedValue(GATE);
    state.mockResolvedValue({ allowWrites: false, scriptsDir: '/opt/pe/scripts' });
    mount(<PhaseGate slug="demo" phase={4} />);
    expect(await screen.findByText(/gate-approve\.sh/)).toHaveTextContent(
      'bash /opt/pe/scripts/gate-approve.sh demo 4',
    );
  });

  it('draws nothing — and asks the engine nothing — for a phase with no gate', async () => {
    plan.mockResolvedValue(PLAN);
    state.mockResolvedValue({ allowWrites: true });
    const { container } = mount(<PhaseGate slug="demo" phase={5} />);
    await waitFor(() => expect(plan).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[data-testid="gate-card"]')).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });
});
