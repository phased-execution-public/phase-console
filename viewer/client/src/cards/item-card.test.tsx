/**
 * The item card's one primary and the decision card (quiet-console phase 4;
 * control-tower phase 137, #214; rebuilt as IC-v2 by turn-by-turn phase 8).
 *
 *   IC-v2 the move table is the contract: every (type, status, readiness, record) has
 *        exactly one primary — a NOW Task's is I've done this — check (never a
 *        terminal, never the opener), a Redo's I've redone it, a Checking item's only
 *        Undo, a Decision's its options and Send my decision, an Approval's Approve
 *        (Deny beside it), a Heads-up's Got it; settled and not-yet items have none;
 *        a flagged action is never the primary — and the card draws exactly what
 *        the table says, over every type × status, ledger and projected;
 *   IC-7 the card draws exactly ONE primary, the table's;
 *   IC-8 a decision card draws its options as cards — the recommended one named in
 *        words and never pre-selected, each consequence — and a note; Send my
 *        decision is disabled until an option or a note; a projected decision's
 *        flagged option is disabled with its flag;
 *   IC-9 a secret-entry card draws no field for the value — it says where the value goes;
 *   IC-10 every status on the card is a dot and a word of the typed family (`TurnStatus`
 *        for the person's status, `OpsStatus` over `verdict` and `risk`), and the
 *        step card drawn from an inbox row keeps no state words of its own;
 *   IC-11 the verdict a check sent back is drawn BEFORE the guide — it changes what the guide is for —
 *        and right after the head (Tower strips, 2026-10-20): its lead on a line of its own, then
 *        what the check found and read, then exactly what to redo;
 *   IC-12 the act comes before the record (Tower strips, 2026-10-20): a Decision says *What you
 *        decide* — the why and the guide's own paragraph — then its options as strips (the
 *        recommended one marked ★ in words, *Hand it to the AI* set apart under an "or"), the
 *        note, the primary; a Task's steps come first, then its form; an Approval's block is a
 *        two-column grid of what, who asked and what each answer does, then Approve and Deny;
 *   IC-13 the record after the act, as fold strips: How it's checked · Where it goes · Timing ·
 *        (a Decision's Steps, open at first) · History — each head saying its gist while folded.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import {
  ITEM_TYPES,
  PERSON_STATUSES,
  READINESS,
  TURN_RECORDS,
  type ItemType,
  type PersonStatus,
  type Readiness,
  type TurnRecord,
} from '@shared/turn-model.js';
import { MemoryRouterProvider } from '@/shell/router';
import { CHECK_LABEL } from './human-step-words';
import { queryClientConfig } from '@/data/keys';
import type { HumanStepRecord, InboxAction, TurnItem, TurnOption } from '@/data/api';
import { DecisionCard } from './decision-card';
import { ItemCard } from './item-card';
import {
  MOVE_LABEL,
  approveLabelOf,
  cardMoveLabel,
  cardMoveOf,
  denyLabelOf,
  type CardMove,
  type CardMoveInput,
} from './turn/moves';

const at = (verb: string): string => `/api/human-steps/s1/${verb}`;
const STEP_ACTIONS: InboxAction[] = [
  { verb: 'check', label: CHECK_LABEL, endpoint: at('check'), method: 'POST' },
  { verb: 'snooze', label: 'Snooze an hour', endpoint: at('snooze'), method: 'POST' },
  {
    verb: 'cannot',
    label: "I can't do this",
    endpoint: at('cannot'),
    method: 'POST',
    // As the server mints it (`server/inbox.ts` `humanStepActions`): the reason goes in `reason`.
    says: { field: 'reason', label: 'Why not?', placeholder: 'Who can do it, or what is in the way' },
  },
];
const GRANT: InboxAction = {
  verb: 'grant',
  label: 'Grant — this phase',
  endpoint: at('grant'),
  method: 'POST',
};
const DENY: InboxAction = { verb: 'deny', label: 'Deny', endpoint: at('deny'), method: 'POST' };
const CONVERT: InboxAction = {
  verb: 'convert',
  label: "I'll do it myself",
  endpoint: at('convert'),
  method: 'POST',
};
const OPEN_ROW: InboxAction = { verb: 'open', label: 'Open the plan', endpoint: '/api/y', method: 'POST' };
const APPROVE_ROW: InboxAction = { verb: 'approve', label: 'Approve', endpoint: '/api/a', method: 'POST' };
const DENY_ROW: InboxAction = { verb: 'deny', label: 'Deny', endpoint: '/api/d', method: 'POST' };

const URL = 'https://github.com/login/device';

function word(move: CardMove): string {
  if (move.move === 'none') return `none:${move.why}`;
  if (move.move === 'row') return `row:${move.action.verb}`;
  if (move.move === 'check') return move.redo ? 'check:redo' : 'check';
  return move.move;
}

/** The table's input for one cell, with the facts a type carries in each record. */
function cell(
  type: ItemType,
  personStatus: PersonStatus,
  readiness: Readiness,
  record: TurnRecord,
): CardMoveInput {
  const ledger = record === 'ledger';
  const kind: HumanStepKind =
    type === 'approve' ? 'person-check' : type === 'decide' ? 'decision' : 'browser-login';
  return {
    type,
    personStatus,
    readiness,
    record,
    kind,
    proofType: type === 'decide' ? 'answer' : 'probe',
    actions: ledger ? [] : type === 'approve' ? [APPROVE_ROW, DENY_ROW] : [OPEN_ROW],
    options: type === 'decide' && !ledger ? [{ id: 'a', label: 'Ship it' }] : [],
  };
}

/** What the table must answer for one cell — written out, so the test is not the table again. */
function expected(type: ItemType, status: PersonStatus, readiness: Readiness, record: TurnRecord): string {
  if (status === 'passed' || status === 'not-doing' || status === 'closed') return 'none:settled';
  if (type === 'know') return 'got-it';
  if (status === 'checking') return record === 'ledger' ? 'undo' : 'none:checking';
  if (status === 'owner')
    return record === 'ledger' ? 'none:no-action' : `row:${type === 'approve' ? 'approve' : 'open'}`;
  if (readiness === 'not-yet') return 'none:not-yet';
  if (type === 'approve') return 'approve';
  if (type === 'decide') return 'decide';
  if (record === 'ledger') return status === 'redo' ? 'check:redo' : 'check';
  return 'row:open';
}

describe('IC-v2 the move table', () => {
  it('every type × status × readiness × record has exactly the primary the board asks for', () => {
    let cells = 0;
    for (const type of ITEM_TYPES)
      for (const status of PERSON_STATUSES)
        for (const readiness of READINESS)
          for (const record of TURN_RECORDS) {
            cells += 1;
            const got = word(cardMoveOf(cell(type, status, readiness, record)));
            expect(got, `${type} ${status} ${readiness} ${record}`).toBe(
              expected(type, status, readiness, record),
            );
          }
    expect(cells).toBe(ITEM_TYPES.length * PERSON_STATUSES.length * READINESS.length * TURN_RECORDS.length);
  });

  it('a NOW Task’s primary is the check — never the opener, never a terminal — and a Redo’s is I’ve redone it', () => {
    for (const kind of ['browser-login', 'operator-act', 'interactive-prompt', 'one-time-code'] as const) {
      const move = cardMoveOf({ ...cell('do', 'todo', 'now', 'ledger'), kind });
      expect(move).toEqual({ move: 'check', redo: false });
      expect(cardMoveLabel(move)).toBe(CHECK_LABEL);
    }
    expect(cardMoveLabel(cardMoveOf(cell('do', 'redo', 'now', 'ledger')))).toBe("I've redone it");
  });

  it('an Approval: a permission through its grant, a projected card through its yes, a check by eye through its answer', () => {
    expect(
      word(
        cardMoveOf({
          ...cell('approve', 'todo', 'now', 'ledger'),
          kind: 'permission',
          proofType: 'grant',
          actions: [GRANT, DENY, CONVERT],
        }),
      ),
    ).toBe('grant');
    expect(word(cardMoveOf(cell('approve', 'todo', 'now', 'projected')))).toBe('approve');
    expect(word(cardMoveOf(cell('approve', 'todo', 'now', 'ledger')))).toBe('approve');
    // A run request's two options (turn-by-turn phase 6).
    expect(
      word(
        cardMoveOf({
          ...cell('approve', 'todo', 'now', 'ledger'),
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
        }),
      ),
    ).toBe('approve');
    // A projected approval with no yes to press leads with its row's first action.
    expect(word(cardMoveOf({ ...cell('approve', 'todo', 'now', 'projected'), actions: [OPEN_ROW] }))).toBe(
      'row:open',
    );
  });

  it('a flagged action is never the primary', () => {
    const flagged = { ...OPEN_ROW, flag: 'run' };
    expect(word(cardMoveOf({ ...cell('do', 'todo', 'now', 'projected'), actions: [flagged] }))).toBe(
      'none:no-action',
    );
    expect(
      word(
        cardMoveOf({
          ...cell('do', 'todo', 'now', 'projected'),
          actions: [flagged, { ...OPEN_ROW, verb: 'look', label: 'Look again' }],
        }),
      ),
    ).toBe('row:look');
  });

  it('says each move in its one wording', () => {
    expect(CHECK_LABEL).toBe("I've done this — check");
    expect(cardMoveLabel({ move: 'check', redo: false })).toBe(CHECK_LABEL);
    expect(cardMoveLabel({ move: 'undo' })).toBe("Undo: I'm not finished");
    expect(cardMoveLabel({ move: 'decide' })).toBe('Send my decision');
    expect(cardMoveLabel({ move: 'approve' })).toBe('Approve');
    expect(cardMoveLabel({ move: 'got-it' })).toBe('Got it');
    expect(cardMoveLabel({ move: 'row', action: OPEN_ROW })).toBe('Open the plan');
    expect(cardMoveLabel({ move: 'none', why: 'settled' })).toBeNull();
    expect(approveLabelOf('Grant — this phase')).toBe('Approve — this phase');
    expect(approveLabelOf('Approve the gate on Phase 3')).toBe('Approve the gate on Phase 3');
    expect(approveLabelOf('Yes')).toBe(MOVE_LABEL.approve);
    expect(denyLabelOf('No')).toBe('Deny');
  });
});

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

function wrap(node: ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">{node}</MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

function item(kind: HumanStepKind, state: HumanStepState, over: Partial<TurnItem> = {}): TurnItem {
  return {
    item: 's1',
    record: 'ledger',
    source: 'declared',
    kind,
    why: 'identity',
    proofType: 'probe',
    group: 'now',
    rows: ['human-step:alpha:3:s1'],
    title: 'Sign the gh CLI in',
    need: 'The phase pushes its branch.',
    how: 'Open the sign-in, then check.',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '2026-10-07T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: kind === 'permission' ? [GRANT, DENY, CONVERT] : STEP_ACTIONS,
    humanStep: humanStepView({ kind, title: 'Sign the gh CLI in', state, stepId: 's1', openUrl: URL }),
    ...over,
  } as TurnItem;
}

describe('IC-7 the card draws one primary', () => {
  it('a notified sign-in leads with the check; its opener sits beside it, never the primary', () => {
    wrap(<ItemCard item={item('browser-login', 'notified')} perform={vi.fn()} />);
    const primaries = screen.getAllByTestId('turn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toBe(CHECK_LABEL);
    expect(primaries[0]!.getAttribute('data-move')).toBe('check');
    expect(screen.getByTestId('turn-open').textContent).toBe('Open sign-in');
  });

  it('sent back, the primary is I’ve redone it', () => {
    wrap(<ItemCard item={item('browser-login', 'returned')} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-primary').textContent).toBe("I've redone it");
  });

  it('an item being checked offers only Undo, and says the verdict lands here', () => {
    wrap(<ItemCard item={item('physical', 'checking', { group: 'checking' })} perform={vi.fn()} />);
    const primaries = screen.getAllByTestId('turn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toBe("Undo: I'm not finished");
    expect(screen.getByTestId('turn-checking').textContent).toMatch(/waiting for the check/i);
    expect(screen.queryByTestId('turn-snooze')).toBeNull();
  });

  it('a projected item presses its row action verbatim', () => {
    const perform = vi.fn();
    wrap(
      <ItemCard
        item={item('physical', 'notified', {
          record: 'projected',
          actions: [OPEN_ROW],
          humanStep: undefined,
        })}
        perform={perform}
      />,
    );
    const primary = screen.getByTestId('turn-primary');
    expect(primary.textContent).toBe('Open the plan');
    fireEvent.click(primary);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0]![0].id).toBe('human-step:alpha:3:s1');
    expect(perform.mock.calls[0]![1]).toBe(OPEN_ROW);
  });

  it('a permission item with no card lent is an approval: Approve at its scope, Deny and I’ll do it myself beside it', () => {
    wrap(
      <ItemCard
        item={item('permission', 'notified', { why: 'permission', proofType: 'grant' })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('turn-primary').textContent).toBe('Approve — this phase');
    const act = screen.getByTestId('turn-act');
    expect(within(act).getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(within(act).getByRole('button', { name: "I'll do it myself" })).toBeTruthy();
  });

  it('a flagged row action is drawn disabled with the flag that turns it on', () => {
    const flagged: InboxAction = {
      verb: 'recover',
      label: 'Recover & continue',
      endpoint: '/api/r',
      method: 'POST',
      flag: 'run',
    };
    wrap(
      <ItemCard
        item={item('physical', 'notified', {
          record: 'projected',
          actions: [OPEN_ROW, flagged],
          humanStep: undefined,
        })}
        perform={vi.fn()}
      />,
    );
    const off = within(screen.getByTestId('turn-flagged')).getByRole('button', {
      name: 'Recover & continue',
    }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(screen.getByTestId('turn-flagged').textContent).toMatch(/--allow-run|run/);
  });

  it('says why only a person fits it — once — and that the reason was inferred when nobody named one', () => {
    wrap(
      <ItemCard
        item={item('browser-login', 'notified', { step: { whySource: 'inferred' } as TurnItem['step'] })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('turn-why')).toHaveLength(1);
    const why = screen.getByTestId('turn-why');
    expect(why.textContent).toContain('Only you:');
    expect(why.textContent).toContain('only you can sign in as yourself');
    expect(why.textContent).toMatch(/inferred/);
  });

  it('over every type × status, ledger and projected, the card draws exactly the table’s one primary', () => {
    const states: Record<PersonStatus, HumanStepState> = {
      todo: 'notified',
      checking: 'checking',
      passed: 'proven',
      redo: 'returned',
      'not-doing': 'declined',
      closed: 'dismissed',
      owner: 'notified',
    };
    const KIND: Record<ItemType, HumanStepKind> = {
      approve: 'person-check',
      do: 'physical',
      decide: 'decision',
      know: 'operator-act',
    };
    for (const type of ITEM_TYPES)
      for (const status of PERSON_STATUSES)
        for (const record of ['ledger', 'projected'] as const) {
          const projected = record === 'projected';
          const it = item(KIND[type], states[status], {
            record,
            type,
            personStatus: status,
            readiness: 'now',
            ...(projected
              ? {
                  humanStep: undefined,
                  actions: type === 'approve' ? [APPROVE_ROW, DENY_ROW] : [OPEN_ROW],
                  ...(type === 'decide'
                    ? {
                        options: [
                          {
                            id: 'a',
                            label: 'Ship it',
                            verb: { method: 'POST' as const, endpoint: '/api/x' },
                          },
                        ],
                      }
                    : {}),
                }
              : {}),
          });
          const view = wrap(
            <ItemCard
              item={it}
              record={projected ? undefined : ({ state: states[status] } as HumanStepRecord)}
              perform={vi.fn()}
            />,
          );
          const move = cardMoveOf({
            type,
            personStatus: status === 'owner' && !projected ? 'todo' : status,
            readiness: 'now',
            record,
            kind: KIND[type],
            proofType: 'probe',
            actions: projected ? it.actions : [],
            options: projected && type === 'decide' ? [{ id: 'a', label: 'Ship it' }] : [],
          });
          const pressable = move.move !== 'none';
          expect(
            view.queryAllByTestId('turn-primary').length,
            `${type} ${status} ${record}: ${word(move)}`,
          ).toBe(pressable ? 1 : 0);
          view.unmount();
        }
  });
});

describe('IC-8 the decision card', () => {
  const options = [
    {
      id: 'a',
      label: 'Ship it on Monday',
      consequence: 'The release waits two days.',
      recommended: true as const,
    },
    { id: 'b', label: 'Ship it today', consequence: 'Nobody reviews the notes.' },
  ];

  it('draws the options as cards, the recommended one named in words and not chosen, each consequence', () => {
    wrap(<DecisionCard options={options} onSend={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio.getAttribute('aria-checked')).toBe('false');
    const first = screen.getByTestId('decision-option-a');
    expect(within(first).getByText('Recommended')).toBeTruthy();
    expect(within(first).getByText('The release waits two days.')).toBeTruthy();
    expect(within(screen.getByTestId('decision-option-b')).queryByText('Recommended')).toBeNull();
    expect(screen.getByText('Nobody reviews the notes.')).toBeTruthy();
  });

  it('keeps Send my decision disabled until an option or a note exists', () => {
    const onSend = vi.fn();
    wrap(<DecisionCard options={options} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send my decision' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ option: 'b' });
  });

  it('a note alone is an answer', () => {
    const onSend = vi.fn();
    wrap(<DecisionCard options={[]} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send my decision' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: '  Use the staging key.  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ note: 'Use the staging key.' });
  });

  it('a projected decision: a flagged option is disabled with its flag, and its box is a note for the AI until an option names its own field', () => {
    const onSend = vi.fn();
    wrap(
      <DecisionCard
        mode="bound"
        options={[
          {
            id: 'serialize',
            label: 'Serialize them',
            recommended: true,
            says: { field: 'note', label: 'Why, for the log' },
          },
          { id: 'recover', label: 'Recover & continue', flag: 'run' },
        ]}
        onSend={onSend}
      />,
    );
    expect((screen.getAllByRole('radio')[1] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('turn-option-recover').textContent).toMatch(/run/);
    // Every decision has a box for the person's words (2026-10-20).
    expect(screen.getByLabelText('A note for the AI (optional)')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.change(screen.getByLabelText('Why, for the log'), { target: { value: 'two lanes collide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send my decision' }));
    expect(onSend).toHaveBeenCalledWith({ option: 'serialize', note: 'two lanes collide' });
  });

  it('a projected option that takes no words still sends the note the person typed, for the AI', () => {
    const onSend = vi.fn();
    wrap(
      <DecisionCard
        mode="bound"
        options={[
          { id: 'leave', label: 'Leave them' },
          {
            id: 'hand-to-ai',
            label: 'Hand it to the AI',
            says: {
              field: 'note',
              label: 'Your note for the AI',
              placeholder: 'What it should know or weigh',
            },
          },
        ]}
        onSend={onSend}
      />,
    );
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.change(screen.getByLabelText('A note for the AI (optional)'), {
      target: { value: 'merge x first' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send my decision' }));
    expect(onSend).toHaveBeenCalledWith({ option: 'leave', note: 'merge x first' });
    // Choosing the hand-off names its own field.
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect(screen.getByLabelText('Your note for the AI')).toBeTruthy();
  });

  it('a decision item on the card is answered through it', () => {
    wrap(
      <ItemCard
        item={item('decision', 'notified', {
          why: 'decision',
          proofType: 'answer',
          group: 'decide',
          step: { options } as TurnItem['step'],
        })}
        perform={vi.fn()}
      />,
    );
    const primary = screen.getByTestId('turn-primary');
    expect(primary.textContent).toBe('Send my decision');
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });
});

describe('IC-9 never a field for a secret', () => {
  it('a secret-entry item says where the value goes and draws no text field', () => {
    const record = { secretWhere: 'the keychain item `npm-token`' } as HumanStepRecord;
    wrap(
      <ItemCard
        item={item('secret-entry', 'notified', {
          why: 'secret',
          humanStep: humanStepView({
            kind: 'secret-entry',
            title: 'Store the npm token',
            state: 'notified',
            stepId: 's1',
          }),
        })}
        record={record}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('step-secret-where').textContent).toContain('never takes the value');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});

describe('IC-10 statuses through the typed family', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = (path: string) => readFileSync(join(SRC, path), 'utf8');

  it('the card draws the person’s status, readiness, verdict and risk as a dot and a word, and no word of its own', () => {
    const card = source('cards/item-card.tsx');
    for (const vocab of ['verdict', 'risk']) expect(card).toMatch(new RegExp(`<OpsStatus vocab="${vocab}"`));
    const head = source('cards/turn/head.tsx');
    expect(head).toMatch(/<TurnStatus status=/);
    expect(head).toMatch(/<TurnReadiness\b/);
    for (const file of [
      'cards/item-card.tsx',
      'cards/turn/head.tsx',
      'cards/turn/act.tsx',
      'cards/turn/steps.tsx',
      'cards/turn/timing.tsx',
      'cards/turn/verdict.tsx',
    ])
      expect(source(file), file).not.toMatch(/StatusBadge|StatusDot|DotWord/);
  });

  it('the step card drawn from an inbox row keeps no state words of its own', () => {
    const card = source('cards/item-card.tsx');
    expect(card).toMatch(/<OpsStatus vocab="step"/);
    for (const file of ['cards/item-card.tsx', 'cards/turn/step-parts.tsx', 'cards/turn/step-words.ts'])
      expect(source(file), file).not.toMatch(/STATE_WORDS/);
  });
});

describe('IC-11 the verdict before the guide', () => {
  it('a returned item says what to redo above the guide it sends the person back to', () => {
    const record = {
      verdict: {
        state: 'rejected',
        note: 'The keychain has no item by that name.',
        redo: ['Store it under the service name npm-token'],
        read: [],
        at: '2026-10-07T11:40:00.000Z',
        by: 'probe',
        attempt: 2,
      },
      guide: {
        version: 1,
        lang: 'en',
        dir: 'ltr',
        summary: 'Store the token.',
        steps: [{ text: 'Store it in the keychain', code: 'security add-generic-password -s npm-token' }],
        trouble: [],
      },
    } as unknown as HumanStepRecord;
    wrap(
      <ItemCard
        item={item('secret-entry', 'returned', { why: 'secret' })}
        record={record}
        perform={vi.fn()}
      />,
    );
    const verdict = screen.getByTestId('turn-verdict');
    const guide = screen.getByTestId('turn-guide');
    expect(verdict.textContent).toContain('Back to you — attempt 2');
    expect(verdict.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Back with the person, the verdict wears the summons on its edge — the one amber.
    expect(verdict.className).toMatch(/\bstate-needs-you\b/);
    expect(screen.getByTestId('turn-primary').textContent).toBe("I've redone it");
  });

  it('comes right after the head: the lead, what the check found and read, then what to redo', () => {
    const record = {
      verdict: {
        state: 'rejected',
        note: 'The keychain has no item by that name.',
        redo: ['Store it under the service name npm-token', 'Press I’ve redone it'],
        read: ['security: item not found'],
        at: '2026-10-07T11:40:00.000Z',
        by: 'probe',
        attempt: 2,
      },
    } as unknown as HumanStepRecord;
    wrap(
      <ItemCard
        item={item('secret-entry', 'returned', { why: 'secret' })}
        record={record}
        perform={vi.fn()}
      />,
    );
    const verdict = screen.getByTestId('turn-verdict');
    // Nothing between the head and the verdict: the first thing the body says.
    expect(screen.getByTestId('turn-body').firstElementChild).toBe(verdict);
    const lead = screen.getByTestId('turn-verdict-lead');
    expect(lead.textContent?.trim()).toBe('Back to you — attempt 2:');
    const note = screen.getByTestId('turn-verdict-note');
    const read = within(verdict).getByText(/security: item not found/);
    const redo = within(verdict).getByTestId('turn-redo');
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(lead, note) && follows(note, read) && follows(read, redo)).toBe(true);
    expect(within(redo).getAllByRole('listitem')).toHaveLength(2);
    // The head says the same attempt beside its Redo badge.
    expect(screen.getByTestId('turn-state-attempt').textContent).toBe('Attempt 2');
  });
});

describe('IC-12 the act before the record', () => {
  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const HAND_OFF: TurnOption = {
    id: 'hand-to-ai',
    label: 'Hand it to the AI',
    consequence: 'The AI decides it, with your note; the item moves to Done.',
    verb: { method: 'POST', endpoint: '/api/turn/s1/hand-off', body: {} },
    says: { field: 'note', label: 'Your note for the AI', placeholder: 'What it should know or weigh' },
  };

  it('a Decision: What you decide — the why and the guide’s paragraph — then the option strips, the note and Send', () => {
    const record = {
      state: 'notified',
      guide: {
        version: 1,
        lang: 'en',
        dir: 'ltr',
        summary: 'The notes are not reviewed yet.',
        steps: [{ text: 'Read the release notes' }],
        trouble: [],
      },
    } as unknown as HumanStepRecord;
    wrap(
      <ItemCard
        item={item('decision', 'notified', {
          why: 'decision',
          proofType: 'answer',
          group: 'decide',
          type: 'decide',
          step: {
            options: [
              { id: 'a', label: 'Ship it on Monday', consequence: 'The release waits.', recommended: true },
              { id: 'b', label: 'Ship it today' },
            ],
          } as TurnItem['step'],
          options: [HAND_OFF],
        })}
        record={record}
        perform={vi.fn()}
      />,
    );
    const act = screen.getByTestId('turn-act-section');
    expect(within(act).getByTestId('turn-act-label').textContent).toBe('What you decide');
    expect(screen.getByRole('group', { name: 'What you decide' })).toBe(act);
    // The why, once, and the guide's own paragraph — said here, not again above its steps.
    expect(within(act).getByTestId('turn-why')).toBeTruthy();
    expect(screen.getAllByTestId('guide-why')).toHaveLength(1);
    expect(within(act).getByTestId('guide-why').textContent).toContain('not reviewed yet');
    // The options as strips: the recommended one marked in words, nothing chosen.
    const radios = within(act).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio.getAttribute('aria-checked')).toBe('false');
    expect(
      within(screen.getByTestId('decision-option-a')).getByTestId('option-recommended').textContent,
    ).toBe('Recommended');
    // *Hand it to the AI* is set apart: after an "or", dashed, the last way.
    const or = within(act).getByTestId('turn-option-or');
    const handOff = screen.getByTestId('decision-option-hand-to-ai');
    expect(handOff.hasAttribute('data-hand-off')).toBe(true);
    expect(follows(screen.getByTestId('decision-option-b'), or) && follows(or, handOff)).toBe(true);
    expect(handOff.querySelector('label')?.className).toMatch(/\bborder-dashed\b/);
    // The note, then the one primary on the act bar.
    const note = within(act).getByTestId('decision-note');
    const primary = within(act).getByTestId('turn-primary');
    expect(follows(handOff, note) && follows(note, primary)).toBe(true);
    expect(primary.closest('[data-testid="turn-moves"]')).toBeTruthy();
    // A decision's steps are the record's — after the act.
    expect(follows(act, screen.getByTestId('turn-guide'))).toBe(true);
  });

  it('the chosen strip wears an ink leading edge on the raised surface, never amber', () => {
    wrap(
      <DecisionCard
        options={[
          { id: 'a', label: 'Ship it on Monday' },
          { id: 'b', label: 'Ship it today' },
        ]}
        onSend={vi.fn()}
      />,
    );
    const strip = screen.getByTestId('decision-option-a').querySelector('label')!;
    expect(strip.className).toMatch(/has-\[\[data-state=checked\]\]:border-s-ink/);
    expect(strip.className).toMatch(/has-\[\[data-state=checked\]\]:bg-surface-raised/);
    expect(strip.className).not.toMatch(/needs-you|amber/);
  });

  it('a Task: its steps first, then its form', () => {
    wrap(
      <ItemCard
        item={item('browser-login', 'notified', {
          type: 'do',
          steps: [{ text: 'Open the sign-in' }, { text: 'Approve the device' }],
        })}
        perform={vi.fn()}
      />,
    );
    const act = screen.getByTestId('turn-act-section');
    expect(within(act).getByTestId('turn-act-label').textContent).toBe('What you do');
    const guide = within(act).getByTestId('turn-guide');
    expect(within(guide).getAllByTestId('guide-step')).toHaveLength(2);
    expect(follows(guide, within(act).getByTestId('turn-primary'))).toBe(true);
  });

  it('an Approval: its block as a grid of what, who asked and what each answer does, then Approve and Deny', () => {
    wrap(
      <ItemCard
        item={item('person-check', 'notified', {
          record: 'projected',
          type: 'approve',
          humanStep: undefined,
          actions: [APPROVE_ROW, DENY_ROW],
          approval: {
            what: 'Open the gate on phase 4',
            askedBy: 'The plan',
            ifApproved: 'Phase 4 boards.',
            ifDenied: 'The phase waits.',
          },
        } as Partial<TurnItem>)}
        perform={vi.fn()}
      />,
    );
    const act = screen.getByTestId('turn-act-section');
    expect(within(act).getByTestId('turn-act-label').textContent).toBe('What you approve');
    const block = within(act).getByTestId('turn-approval');
    expect(block.tagName).toBe('DL');
    expect(block.className).toMatch(/@md\/card:grid-cols-\[max-content_minmax\(0,1fr\)\]/);
    expect([...block.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual([
      'What',
      'Asked by',
      'If you approve',
      'If you deny',
    ]);
    const approve = within(act).getByTestId('turn-primary');
    expect(approve.getAttribute('data-move')).toBe('approve');
    expect(follows(block, approve)).toBe(true);
    expect(within(act).getByRole('button', { name: 'Deny' })).toBeTruthy();
  });
});

describe('IC-13 the record after the act, as fold strips', () => {
  const follows = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const heads = () =>
    within(screen.getByTestId('turn-record'))
      .getAllByRole('button', { expanded: false })
      .concat(within(screen.getByTestId('turn-record')).queryAllByRole('button', { expanded: true }))
      .sort((a, b) => (follows(a, b) ? -1 : 1));

  it('a Task: How it’s checked, Where it goes, Timing and History, after the act, each saying its gist', () => {
    wrap(<ItemCard item={item('browser-login', 'notified', { route: 'phase' })} perform={vi.fn()} />);
    const record = screen.getByTestId('turn-record');
    expect(follows(screen.getByTestId('turn-act-section'), record)).toBe(true);
    expect(heads().map((head) => head.getAttribute('data-testid'))).toEqual([
      'turn-check-fold',
      'turn-route-fold',
      'turn-timing-fold',
      'turn-history-toggle',
    ]);
    // Folded, every one: a Task's steps are its act, never the record's.
    for (const head of heads()) expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('turn-steps-fold')).toBeNull();
    expect(screen.getByTestId('turn-check-fold').textContent).toContain('The console runs a check');
    expect(screen.getByTestId('turn-route-fold').textContent).toContain('The phase');
    expect(screen.getByTestId('turn-history-toggle').textContent).toMatch(/^History, Raised by /);
    // One press opens each.
    expect(screen.queryByTestId('turn-history')).toBeNull();
    fireEvent.click(screen.getByTestId('turn-history-toggle'));
    expect(screen.getByTestId('turn-history')).toBeTruthy();
  });

  it('a Decision’s steps are the record’s Steps fold, open at first, counted and led by the first', () => {
    wrap(
      <ItemCard
        item={item('decision', 'notified', {
          why: 'decision',
          proofType: 'answer',
          group: 'decide',
          type: 'decide',
          steps: [{ text: 'Read the `release` notes' }, { text: 'Pick a day' }],
          step: { options: [{ id: 'a', label: 'Ship it' }] } as TurnItem['step'],
        })}
        perform={vi.fn()}
      />,
    );
    const steps = screen.getByTestId('turn-steps-fold');
    expect(steps.getAttribute('aria-expanded')).toBe('true');
    expect(steps.textContent).toContain('First: Read the release notes');
    expect(within(screen.getByTestId('turn-record')).getAllByTestId('guide-step')).toHaveLength(2);
    expect(follows(screen.getByTestId('turn-timing-fold'), steps)).toBe(true);
    expect(follows(steps, screen.getByTestId('turn-history-toggle'))).toBe(true);
  });
});
