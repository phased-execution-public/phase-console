/**
 * Every surface that draws a person's ask draws the ITEM (control-tower phase
 * 139, #216): the row variant and a link to its place on Your turn, with the
 * item as its data — the run's asks (its broker cards and its relayed
 * questions), the gate, the errand. And what an item carries is drawn where it
 * belongs: a `physical` item's link for the phone, *Not doing this* where the
 * raiser allows a decline, and no Dismiss anywhere.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inbox, run, perform } = vi.hoisted(() => ({ inbox: vi.fn(), run: vi.fn(), perform: vi.fn() }));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, inbox, run } };
});

import { humanStepView, type HumanStepKind } from '@shared/human-step-model.js';
import type { Errand, InboxAction, InboxItem, TurnItem, TurnView } from '@/data/api';
import { humanStepsApi } from '@/data/human-steps';
import { queryClientConfig } from '@/data/keys';
import { approvalRows, errandRow, gateRow, itemsNow, runItems } from '@/data/turn';
import { TurnItemCard as ItemCard } from '@/screens/turn/parts';
import { TooltipProvider } from '@/ui/tooltip';
import { ErrandCard } from './errand';
import ItemRow, { rowPrimaryOf } from './item-row';

const AT = '2026-10-08T10:00:00.000Z';

const action = (verb: string, label: string, over: Partial<InboxAction> = {}): InboxAction => ({
  verb,
  label,
  endpoint: `/api/x/${verb}`,
  method: 'POST',
  ...over,
});

/** A row's fields, its turn view by part — merged over the defaults below. */
type RowOver = Omit<Partial<InboxItem>, 'turn'> & { turn?: Partial<TurnView> };

function row(id: string, over: RowOver = {}): InboxItem {
  const { turn, ...rest } = over;
  return {
    id,
    kind: 'approval',
    severity: 'urgent',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: `Row ${id}`,
    need: '',
    how: '',
    since: AT,
    href: '/plan/alpha/run',
    actions: [],
    turn: {
      item: id,
      record: 'projected',
      source: 'approval',
      kind: 'permission',
      why: 'permission',
      proofType: 'grant',
      group: 'now',
      ...turn,
    } as TurnView,
    ...rest,
  } as InboxItem;
}

const broker = (id: string, over: RowOver = {}) =>
  row(id, {
    actions: [action('allow', 'Allow'), action('deny', 'Deny'), action('extend', 'Extend 2 h')],
    ...over,
  });

const question = (id: string, over: RowOver = {}) =>
  row(id, {
    kind: 'question',
    title: 'Which colour should the banner be?',
    actions: [action('answer', 'Red'), action('answer', 'Blue (Recommended)')],
    turn: { source: 'question', kind: 'decision', why: 'decision', proofType: 'answer', group: 'decide' },
    ...over,
  });

function stepRow(id: string, kind: HumanStepKind, { turn, ...over }: RowOver = {}): InboxItem {
  return row(`human-step:${id}`, {
    kind: 'human-step',
    severity: 'needs-you',
    title: `Step ${id}`,
    humanStep: humanStepView({
      kind,
      title: `Step ${id}`,
      stepId: id,
      state: 'notified',
      openCommand: 'gh auth login',
    }),
    turn: {
      item: id,
      record: 'ledger',
      source: 'declared',
      kind,
      why: 'identity',
      proofType: 'probe',
      group: 'now',
      ...turn,
    },
    ...over,
  });
}

function mount(ui: ReactNode, items: InboxItem[] = []) {
  inbox.mockResolvedValue({ items, generatedAt: AT });
  return render(
    <QueryClientProvider client={new QueryClient(queryClientConfig)}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({ run: null });
});

describe('the row primary, by rule (rowPrimaryOf)', () => {
  it('a low or medium permission is answered here in one press; a high or never one opens the page', () => {
    expect(rowPrimaryOf(broker('a'))).toMatchObject({ move: 'row', action: { verb: 'allow' } });
    const grant = row('g', {
      actions: [
        action('deny', 'Deny'),
        action('grant', 'Grant — this call'),
        action('convert', 'I’ll do it myself'),
      ],
      turn: { record: 'ledger', permission: { wall: 'deny', risk: 'medium' } },
    });
    expect(rowPrimaryOf(grant)).toMatchObject({ move: 'row', action: { verb: 'grant' } });
    for (const risk of ['high', 'never'] as const) {
      expect(rowPrimaryOf(broker('h', { turn: { permission: { wall: 'deny', risk } } }))).toEqual({
        move: 'page',
      });
    }
  });

  it('a choice of options is made on the page; a projected decision with ONE answer is pressed here', () => {
    expect(rowPrimaryOf(question('q'))).toEqual({ move: 'page' });
    const gate = row('gate', {
      kind: 'gate',
      actions: [action('approve', 'Approve the gate')],
      turn: { source: 'gate', kind: 'decision', why: 'decision', proofType: 'answer', group: 'decide' },
    });
    expect(rowPrimaryOf(gate)).toMatchObject({ move: 'row', action: { verb: 'approve' } });
    // The server's gate asks for its evidence: a box for words is the page's.
    const asks = {
      ...gate,
      actions: [action('approve', 'Approve the gate', { says: { field: 'note', label: 'Evidence' } })],
    };
    expect(rowPrimaryOf(asks)).toEqual({ move: 'page' });
  });

  it('a step leads with its own act; one coming up, being checked or done offers only the link', () => {
    expect(rowPrimaryOf(stepRow('s1', 'browser-login'))).toEqual({ move: 'step' });
    for (const group of ['upcoming', 'checking', 'done'] as const) {
      expect(rowPrimaryOf(stepRow('s2', 'operator-act', { turn: { group } }))).toMatchObject({
        move: 'none',
      });
    }
  });

  it('a flagged action is never the primary — the page is', () => {
    expect(rowPrimaryOf(broker('f', { actions: [action('allow', 'Allow', { flag: 'run' })] }))).toEqual({
      move: 'page',
    });
  });
});

describe('the surfaces find their items in the inbox (data/turn.ts)', () => {
  const rows = [
    broker('b1', { since: '2026-10-08T09:00:00.000Z' }),
    question('q1'),
    broker('b2', { runId: 'r2' }),
    row('gate', {
      kind: 'gate',
      since: '',
      runId: undefined as never,
      turn: { source: 'gate', group: 'decide' },
    }),
    row('errand', {
      kind: 'errand',
      turn: { item: 'st-1', record: 'ledger', source: 'errand', group: 'now' },
    }),
    stepRow('st-1', 'operator-act', { turn: { source: 'errand' } }),
  ];

  it('the queue takes this run’s cards and questions; the gate and the errand find theirs', () => {
    expect(approvalRows(rows, { runId: 'r1' }).map((r) => r.id)).toEqual(['b1', 'q1']);
    expect(approvalRows(rows).map((r) => r.id)).toEqual(['b1', 'q1', 'b2']);
    expect(gateRow(rows, 'alpha', 3)?.id).toBe('gate');
    expect(gateRow(rows, 'alpha', 4)).toBeUndefined();
    // An errand and its step are ONE item, drawn from the ledger's row.
    expect(errandRow(rows, { slug: 'alpha', phase: 3, runId: 'r1' })?.id).toBe('human-step:st-1');
  });

  it('one row per item, oldest first — the strip’s ONE action is the first', () => {
    expect(itemsNow(rows).filter((r) => r.turn?.item === 'st-1')).toHaveLength(1);
    expect(runItems(rows, { id: 'r1', slug: 'alpha' })[0]?.id).toBe('b1');
    // A row with no clock (a gate) sorts last, as the inbox orders it.
    expect(itemsNow(rows).at(-1)?.id).toBe('gate');
  });

  it('an fyi row asks nobody — a clash zone or an idle plan is no item', () => {
    const note = row('clash', { kind: 'conflict', severity: 'fyi', turn: { group: 'decide' } });
    expect(itemsNow([note])).toEqual([]);
    expect(runItems([note], { id: 'r1', slug: 'alpha' })).toEqual([]);
  });

  it('an errand whose step a session declared is found too, drawn from the step’s row', () => {
    const linked = [
      row('errand-2', { kind: 'errand', turn: { item: 'st-7', record: 'ledger', source: 'session' } }),
      stepRow('st-7', 'browser-login', { turn: { source: 'session' } }),
    ];
    expect(errandRow(linked, { slug: 'alpha', phase: 3, runId: 'r1' })?.id).toBe('human-step:st-7');
  });
});

describe('<ItemRow> — the row variant every surface shares', () => {
  it('draws the kind, the title and ONE primary pressed verbatim, and links to the item', () => {
    const card = broker('b1');
    mount(<ItemRow row={card} perform={perform} />);
    const drawn = screen.getByTestId('item-row');
    expect(drawn).toHaveAttribute('data-item', 'b1');
    expect(within(drawn).getByTestId('item-row-title')).toHaveTextContent('Row b1');
    expect(within(drawn).getByTestId('item-link')).toHaveAttribute('href', '#/turn/b1');
    fireEvent.click(within(drawn).getByTestId('item-primary'));
    expect(perform).toHaveBeenCalledWith(card, card.actions[0]);
    // Deny and Extend are the page's, one press away — never a second shape here.
    expect(within(drawn).queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('a high-risk grant opens the page instead of granting', () => {
    mount(
      <ItemRow
        row={broker('h', { turn: { permission: { wall: 'deny', risk: 'high' } } })}
        perform={perform}
      />,
    );
    expect(screen.getByTestId('item-primary')).toHaveAttribute('href', '#/turn/h');
    expect(screen.queryByTestId('item-link')).toBeNull();
  });
});

describe('the errand card draws its item', () => {
  const errand = {
    phase: 3,
    situation: 'blocked-declared:needs-human',
    tried: [],
    need: 'The phase needs gh signed in.',
    how: 'Run gh auth login.',
    at: AT,
  } as Errand;

  it('where the inbox holds the errand’s item, its row and link stand where the how was', async () => {
    const items = [
      row('errand-row', { kind: 'errand', turn: { item: 'st-1', record: 'ledger', source: 'errand' } }),
      stepRow('st-1', 'operator-act', { turn: { source: 'errand' } }),
    ];
    mount(<ErrandCard errand={errand} scope={{ slug: 'alpha', runId: 'r1' }} />, items);
    const drawn = await screen.findByTestId('item-row');
    expect(drawn).toHaveAttribute('data-item', 'st-1');
    expect(within(drawn).getByTestId('item-link')).toHaveAttribute('href', '#/turn/st-1');
    expect(screen.getByTestId('errand')).toHaveTextContent('The phase needs gh signed in.');
    expect(screen.queryByText('Run gh auth login.')).toBeNull();
  });

  it('with no item, the ladder’s how is still said', () => {
    mount(<ErrandCard errand={errand} />, []);
    expect(screen.getByText('Run gh auth login.')).toBeInTheDocument();
  });
});

function turnItem(kind: HumanStepKind, over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 'p-1',
    record: 'ledger',
    source: 'declared',
    kind,
    why: 'physical',
    proofType: 'attest',
    group: 'now',
    rows: ['human-step:p-1'],
    title: 'Plug the key in',
    need: '',
    how: '',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: AT,
    href: '/plan/alpha/phase/3',
    actions: [],
    humanStep: humanStepView({
      kind,
      title: 'Plug the key in',
      stepId: 'p-1',
      state: 'notified',
      openUrl: 'https://example.com/pair?device=1',
    }),
    ...over,
  };
}

describe('what an item carries is drawn on its card', () => {
  it('a physical item with a link shows it for the phone — the QR in Pro', async () => {
    mount(<ItemCard item={turnItem('physical')} perform={perform} />);
    const qr = screen.getByTestId('turn-qr');
    expect(qr).toHaveTextContent('https://example.com/pair?device=1');
  });

  it('an item of another kind shows no QR', () => {
    mount(<ItemCard item={turnItem('browser-login')} perform={perform} />);
    expect(screen.queryByTestId('turn-qr')).toBeNull();
  });

  it('Not doing this is offered where the raiser allows it, and no Dismiss anywhere', () => {
    const item = turnItem('operator-act', {
      step: {
        id: 'p-1',
        kind: 'operator-act',
        title: 'Plug the key in',
        state: 'notified',
        why: 'physical',
        whySource: 'declared',
        proofType: 'attest',
        attempts: 0,
        waiters: [],
        declaredAt: AT,
        birth: 'plan',
        allowDecline: true,
      },
    });
    mount(<ItemCard item={item} perform={perform} />);
    expect(screen.getByRole('button', { name: 'Not doing this' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    // A person declines; nothing dismisses. The OWNER's Withdraw is the page's
    // own move, lent to the card by `screens/turn/index.tsx` and never the
    // card's — so none is drawn here.
    expect('humanStepDismiss' in humanStepsApi).toBe(false);
    expect(screen.queryByRole('button', { name: /withdraw/i })).toBeNull();
  });
});
