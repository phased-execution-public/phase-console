/**
 * The item card's primary move and the decision card (control-tower phase 137,
 * #214, exit criteria 3 and 4).
 *
 *   IC-1 a settled, upcoming or checking item offers no primary, whatever its kind;
 *   IC-2 a projected item, or a request, leads with its row's first pressable action;
 *   IC-3 a permission item leads with its Grant, else I'll do it myself, else Deny — never a check;
 *   IC-4 a decision or a person-check leads with Send my answer;
 *   IC-5 every other kind leads with its own opener while declared or notified, and with
 *        the check once opened or returned — table-driven over the eighteen kinds and the
 *        eleven states, with the opener falling back when the item lacks what it needs;
 *   IC-6 the label is the move's own words, and the check's one wording is the row's too;
 *   IC-7 the card draws exactly ONE primary, the table's;
 *   IC-8 a decision card draws its options as cards — the recommended one marked, each
 *        consequence — and a note; Send my answer is disabled until an option or a note;
 *   IC-9 a secret-entry card draws no field for the value — it says where the value goes;
 *   IC-10 every status on the card is drawn through the typed family (`OpsBadge` over `step`,
 *        `verdict` and `risk`), and the human-step card's own state words (`STATE_WORDS`) are gone.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  HUMAN_STEP_KINDS,
  HUMAN_STEP_SETTLED_STATES,
  HUMAN_STEP_STATES,
  humanStepView,
  type HumanStepKind,
  type HumanStepState,
} from '@shared/human-step-model.js';
import { MemoryRouterProvider } from '@/app/router';
import { CHECK_LABEL } from '@/components/human-step-words';
import { queryClientConfig } from '@/lib/queries';
import type { HumanStepRecord, InboxAction, TurnItem } from '@/lib/api';
import { DecisionCard } from './decision-card';
import { ItemCard, primaryMoveLabel, primaryMoveOf, type PrimaryMove } from './item-card';

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

const URL = 'https://github.com/login/device';
const COMMAND = 'gh auth login --web';

/** The move a declared or notified item leads with, when it carries both a link and a command — written out, kind by kind. */
const OPENING: Readonly<Record<HumanStepKind, string>> = {
  'browser-login': 'open',
  'device-code': 'open',
  'one-time-code': 'machine',
  'secret-entry': 'check',
  'claude-login': 'open',
  'mcp-login': 'open',
  'os-prompt': 'terminal',
  'os-permission': 'check',
  'third-party-approval': 'open',
  physical: 'check',
  'person-check': 'answer',
  decision: 'answer',
  'protected-path': 'check',
  'interactive-prompt': 'terminal',
  captcha: 'open',
  'email-link': 'open',
  'operator-act': 'terminal',
  permission: 'row:grant',
};

/** The same, once the person opened it or the check sent it back. */
function afterOpening(kind: HumanStepKind): string {
  if (kind === 'permission') return 'row:grant';
  if (kind === 'decision' || kind === 'person-check') return 'answer';
  return 'check';
}

function word(move: PrimaryMove): string {
  if (move.move === 'none') return `none:${move.why}`;
  if (move.move === 'row') return `row:${move.action.verb}`;
  return move.move;
}

function ledger(
  kind: HumanStepKind,
  state: HumanStepState,
  over: Partial<Parameters<typeof primaryMoveOf>[0]> = {},
) {
  return primaryMoveOf({
    kind,
    state,
    record: 'ledger',
    openUrl: URL,
    openCommand: COMMAND,
    actions: kind === 'permission' ? [GRANT, DENY, CONVERT] : STEP_ACTIONS,
    ...over,
  });
}

describe('IC-1..IC-5 the primary move, by kind and state', () => {
  it('covers the eighteen kinds and the eleven states', () => {
    expect(HUMAN_STEP_KINDS).toHaveLength(18);
    expect(HUMAN_STEP_STATES).toHaveLength(11);
    expect(Object.keys(OPENING).sort()).toEqual([...HUMAN_STEP_KINDS].sort());
  });

  const settled = new Set<string>(HUMAN_STEP_SETTLED_STATES);
  for (const kind of HUMAN_STEP_KINDS) {
    for (const state of HUMAN_STEP_STATES) {
      const expected = settled.has(state)
        ? 'none:settled'
        : state === 'upcoming'
          ? 'none:upcoming'
          : state === 'checking'
            ? 'none:checking'
            : state === 'opened' || state === 'returned'
              ? afterOpening(kind)
              : OPENING[kind];
      it(`${kind} · ${state} → ${expected}`, () => {
        expect(word(ledger(kind, state))).toBe(expected);
      });
    }
  }

  it('IC-5 an opener falls back to the other opener, then to the check', () => {
    expect(word(ledger('browser-login', 'notified', { openUrl: undefined }))).toBe('terminal');
    expect(word(ledger('browser-login', 'notified', { openUrl: undefined, openCommand: undefined }))).toBe(
      'check',
    );
    expect(word(ledger('os-prompt', 'declared', { openCommand: undefined }))).toBe('open');
    expect(word(ledger('one-time-code', 'declared', { openCommand: undefined, openUrl: undefined }))).toBe(
      'check',
    );
  });

  it('IC-3 a permission item: Grant, else I’ll do it myself, else Deny — a flagged action is never the primary', () => {
    expect(word(ledger('permission', 'notified', { actions: [DENY, CONVERT] }))).toBe('row:convert');
    expect(word(ledger('permission', 'notified', { actions: [DENY] }))).toBe('row:deny');
    expect(word(ledger('permission', 'notified', { actions: [{ ...GRANT, flag: 'writes' }, DENY] }))).toBe(
      'row:deny',
    );
    expect(word(ledger('permission', 'notified', { actions: [] }))).toBe('none:no-action');
    // A grant-proven item of another kind is a permission item too.
    expect(word(ledger('operator-act', 'notified', { proofType: 'grant', actions: [GRANT, DENY] }))).toBe(
      'row:grant',
    );
  });

  it('IC-4 an answer-proven item is answered, whatever its kind', () => {
    expect(word(ledger('operator-act', 'notified', { proofType: 'answer' }))).toBe('answer');
  });

  it('IC-2 a projected item or a request leads with its first pressable row action', () => {
    const approve: InboxAction = {
      verb: 'approve',
      label: 'Approve',
      endpoint: '/api/x',
      method: 'POST',
      flag: 'run',
    };
    const open: InboxAction = { verb: 'open', label: 'Open the plan', endpoint: '/api/y', method: 'POST' };
    expect(word(ledger('decision', 'notified', { record: 'projected', actions: [approve, open] }))).toBe(
      'row:open',
    );
    expect(word(ledger('browser-login', 'notified', { record: 'request', actions: [open] }))).toBe(
      'row:open',
    );
    expect(word(ledger('decision', 'notified', { record: 'projected', actions: [approve] }))).toBe(
      'none:no-action',
    );
    // Settled is settled, projected or not.
    expect(word(ledger('decision', 'proven', { record: 'projected', actions: [open] }))).toBe('none:settled');
  });
});

describe('IC-6 the words', () => {
  it('says each move in its own words, and the check in its one wording', () => {
    expect(primaryMoveLabel({ move: 'check' }, 'physical')).toBe(CHECK_LABEL);
    expect(CHECK_LABEL).toBe("I've done this — check");
    expect(primaryMoveLabel({ move: 'answer' }, 'decision')).toBe('Send my answer');
    expect(primaryMoveLabel({ move: 'open' }, 'browser-login')).toBe('Open sign-in');
    expect(primaryMoveLabel({ move: 'terminal' }, 'operator-act')).toBe('Open in terminal');
    expect(primaryMoveLabel({ move: 'row', action: GRANT }, 'permission')).toBe('Grant — this phase');
    expect(primaryMoveLabel({ move: 'none', why: 'checking' }, 'physical')).toBeNull();
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
  it('a notified sign-in leads with Open sign-in, and nothing else is the primary', () => {
    wrap(<ItemCard item={item('browser-login', 'notified')} perform={vi.fn()} />);
    const primaries = screen.getAllByTestId('turn-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.textContent).toBe('Open sign-in');
    expect(primaries[0]!.getAttribute('data-move')).toBe('open');
  });

  it('once opened, the primary is the check', () => {
    wrap(<ItemCard item={item('browser-login', 'opened')} perform={vi.fn()} />);
    expect(screen.getByTestId('turn-primary').textContent).toBe(CHECK_LABEL);
  });

  it('an item being checked offers no primary, and says so', () => {
    wrap(<ItemCard item={item('physical', 'checking', { group: 'checking' })} perform={vi.fn()} />);
    expect(screen.queryByTestId('turn-primary')).toBeNull();
    expect(screen.getByTestId('turn-checking').textContent).toMatch(/being checked/i);
  });

  it('a projected item presses its row action verbatim', () => {
    const perform = vi.fn();
    const open: InboxAction = { verb: 'open', label: 'Open the plan', endpoint: '/api/y', method: 'POST' };
    wrap(
      <ItemCard
        item={item('decision', 'notified', { record: 'projected', actions: [open], humanStep: undefined })}
        perform={perform}
      />,
    );
    const primary = screen.getByTestId('turn-primary');
    expect(primary.textContent).toBe('Open the plan');
    fireEvent.click(primary);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(perform.mock.calls[0]![0].id).toBe('human-step:alpha:3:s1');
    expect(perform.mock.calls[0]![1]).toBe(open);
  });

  it('a permission item grants, and offers Deny and I’ll do it myself beside it', () => {
    wrap(
      <ItemCard
        item={item('permission', 'notified', { why: 'permission', proofType: 'grant' })}
        perform={vi.fn()}
      />,
    );
    expect(screen.getByTestId('turn-primary').textContent).toBe('Grant — this phase');
    const rest = screen.getByTestId('turn-moves');
    expect(within(rest).getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(within(rest).getByRole('button', { name: "I'll do it myself" })).toBeTruthy();
  });

  it('says why only a person fits it, and that the reason was inferred when nobody named one', () => {
    wrap(
      <ItemCard
        item={item('browser-login', 'notified', { step: { whySource: 'inferred' } as TurnItem['step'] })}
        perform={vi.fn()}
      />,
    );
    const why = screen.getByTestId('turn-why');
    expect(why.textContent).toContain('Only you:');
    expect(why.textContent).toContain('only you can sign in as yourself');
    expect(why.textContent).toMatch(/inferred/);
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

  it('draws the options as cards, the recommended one marked, each consequence', () => {
    wrap(<DecisionCard options={options} onSend={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    const first = screen.getByTestId('decision-option-a');
    expect(within(first).getByText('Recommended')).toBeTruthy();
    expect(within(first).getByText('The release waits two days.')).toBeTruthy();
    expect(within(screen.getByTestId('decision-option-b')).queryByText('Recommended')).toBeNull();
    expect(screen.getByText('Nobody reviews the notes.')).toBeTruthy();
  });

  it('keeps Send my answer disabled until an option or a note exists', () => {
    const onSend = vi.fn();
    wrap(<DecisionCard options={options} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send my answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ option: 'b' });
  });

  it('a note alone is an answer', () => {
    const onSend = vi.fn();
    wrap(<DecisionCard options={[]} onSend={onSend} />);
    const send = screen.getByRole('button', { name: 'Send my answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: '  Use the staging key.  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ note: 'Use the staging key.' });
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
    expect(primary.textContent).toBe('Send my answer');
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
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = (path: string) => readFileSync(join(SRC, path), 'utf8');

  it('the card draws step, verdict and risk through OpsBadge, and no word of its own', () => {
    const card = source('features/turn/item-card.tsx');
    for (const vocab of ['step', 'verdict', 'risk'])
      expect(card).toMatch(new RegExp(`<OpsBadge vocab="${vocab}"`));
    expect(card).not.toMatch(/StatusBadge|StatusDot/);
  });

  it('the human-step card keeps no state words of its own', () => {
    expect(source('components/human-step-card.tsx')).not.toMatch(/STATE_WORDS/);
    expect(source('features/turn/index.tsx')).toMatch(/<OpsBadge vocab="step"/);
  });
});
