/**
 * The card under axe, in every type × status (turn-by-turn phase 8, exit
 * criterion 3) — ledger and projected, in both lights, and under
 * `dir="rtl"`:
 *
 *   CA-1 axe finds nothing on the card in any type × status, light and dark;
 *   CA-2 under a right-to-left document the card's sides are logical (it mirrors)
 *        and every command, code and machine value stays left-to-right;
 *   CA-3 every press on the card is a kit Button, which keeps its thumb floor
 *        on touch (`--tap-min`), and every link carries a tap row;
 *   CA-4 the card as the panel draws it (Tower strips, 2026-10-20) — its act
 *        bar pinned, every fold of its record open — still finds nothing, and
 *        each fold's head keeps the thumb floor.
 *
 * jsdom lays nothing out, so contrast and the 44 px floor are measured in the
 * browser by the tour (`e2e/register.spec.ts`); here the structure is held.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import { ITEM_TYPES, PERSON_STATUSES, type ItemType, type PersonStatus } from '@shared/turn-model.js';
import { queryClientConfig } from '@/data/keys';
import type { HumanStepRecord, InboxAction, TurnItem } from '@/data/api';
import { MemoryRouterProvider } from '@/shell/router';
import { expectNoAxeViolations } from '@/test/axe';
import { ItemCard } from '../item-card';

const STATE: Record<PersonStatus, HumanStepState> = {
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
  do: 'operator-act',
  decide: 'decision',
  know: 'operator-act',
};
const OPEN: InboxAction = { verb: 'open', label: 'Open the plan', endpoint: '/api/y', method: 'POST' };
const APPROVE: InboxAction = { verb: 'approve', label: 'Approve', endpoint: '/api/a', method: 'POST' };
const DENY: InboxAction = { verb: 'deny', label: 'Deny', endpoint: '/api/d', method: 'POST' };
const COMMAND = 'gh auth login --hostname <host>';

function item(type: ItemType, status: PersonStatus, record: 'ledger' | 'projected'): TurnItem {
  const kind = KIND[type];
  const ledger = record === 'ledger';
  return {
    item: `${type}-${status}-${record}`,
    record,
    source: ledger ? 'declared' : 'errand',
    kind,
    why: 'identity',
    proofType: type === 'decide' ? 'answer' : 'probe',
    group: 'now',
    rows: [`row-${type}-${status}`],
    title: 'Sign the gh CLI in to the demo org',
    need: 'The phase pushes its branch.',
    how: 'Open the sign-in, then check.',
    severity: 'needs-you',
    slug: 'demo',
    phase: 3,
    runId: 'r-1',
    since: '2026-10-13T10:00:00.000Z',
    href: '/plan/demo/phase/3',
    actions: ledger ? [] : type === 'approve' ? [APPROVE, DENY] : [OPEN],
    type,
    personStatus: status,
    readiness: 'now',
    route: 'phase',
    checkedBy: 'The console runs a check',
    check: 'The console runs gh auth status and passes when it answers signed in.',
    timing: {
      assignedAt: '2026-10-13T10:00:00.000Z',
      deadline: '2026-10-14T10:00:00.000Z',
      openUntil: '2026-10-20T10:00:00.000Z',
    },
    steps: [
      { text: 'Sign in', code: COMMAND, expect: 'It says you are signed in.' },
      { text: 'Read the docs', link: { label: 'The docs', url: 'https://example.com/docs' } },
    ],
    ...(type === 'decide' && !ledger
      ? {
          options: [
            {
              id: 'a',
              label: 'Ship it',
              recommended: true,
              verb: { method: 'POST' as const, endpoint: '/api/x' },
            },
          ],
        }
      : {}),
    ...(ledger
      ? {
          humanStep: humanStepView({
            kind,
            title: 'Sign the gh CLI in',
            state: STATE[status],
            stepId: 's1',
            openCommand: 'gh auth login',
          }),
        }
      : {}),
    ...(type === 'decide' && ledger
      ? {
          step: {
            options: [{ id: 'a', label: 'Ship it', recommended: true }],
          } as unknown as TurnItem['step'],
        }
      : {}),
  } as TurnItem;
}

function mount(node: TurnItem, record?: HumanStepRecord, panel = false) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn">
        <main>
          <ItemCard item={node} record={record} perform={vi.fn()} inPanel={panel} everything={panel} />
        </main>
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('dir');
});

describe('CA-1 axe finds nothing, in every type × status, light and dark', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every type × status, ledger and projected`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      for (const type of ITEM_TYPES)
        for (const status of PERSON_STATUSES)
          for (const record of ['ledger', 'projected'] as const) {
            const node = item(type, status, record);
            const view = mount(
              node,
              record === 'ledger' ? ({ state: STATE[status] } as HumanStepRecord) : undefined,
            );
            try {
              await expectNoAxeViolations(view.container);
            } catch (cause) {
              throw new Error(`${type} ${status} ${record}: ${(cause as Error).message}`, { cause });
            }
            view.unmount();
          }
    }, 120_000);
  }
});

describe('CA-2 right to left', () => {
  it('the card’s sides are logical, and every command and machine value reads left to right', () => {
    document.documentElement.setAttribute('dir', 'rtl');
    const view = mount(item('do', 'todo', 'ledger'), { state: 'notified' } as HumanStepRecord);
    const html = view.container.innerHTML;
    // No physical side on the card: every margin, padding, border and alignment is logical.
    expect(html).not.toMatch(
      /\b(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-/,
    );
    for (const pre of view.container.querySelectorAll('pre')) expect(pre.getAttribute('dir')).toBe('ltr');
    // A template command says so, and is never offered as a plain copy.
    expect(view.getByTestId('code-template').textContent).toBe('Fill in <host> first.');
  });
});

describe('CA-3 presses are kit buttons with a thumb floor; links carry a tap row', () => {
  it('every button on the card wears the touch floor, and every link the tap row', () => {
    const view = mount(item('do', 'todo', 'ledger'), { state: 'notified' } as HumanStepRecord);
    const buttons = [...view.container.querySelectorAll('button')].filter(
      (button) => !button.closest('[role="radiogroup"]'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons)
      expect(button.className, button.textContent ?? '').toMatch(/min-h-\(--tap-min\)|tap-/);
    for (const link of view.container.querySelectorAll('a'))
      expect(link.className, link.textContent ?? '').toMatch(/tap-row|tap-area/);
  });
});

describe('CA-4 the card as the panel draws it', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: every type, open and settled, its bar pinned and its record open`, async () => {
      document.documentElement.setAttribute('data-theme', theme);
      for (const type of ITEM_TYPES)
        for (const status of ['todo', 'redo', 'checking', 'passed'] as const)
          for (const record of ['ledger', 'projected'] as const) {
            const node = item(type, status, record);
            const view = mount(
              node,
              record === 'ledger' ? ({ state: STATE[status] } as HumanStepRecord) : undefined,
              true,
            );
            try {
              const folds = view.container.querySelectorAll(
                '[data-testid="turn-record"] button[aria-expanded]',
              );
              expect(folds.length, `${type} ${status} ${record}: its record`).toBeGreaterThan(0);
              for (const fold of folds) expect(fold.className).toMatch(/min-h-\(--tap-min\)/);
              await expectNoAxeViolations(view.container);
            } catch (cause) {
              throw new Error(`${type} ${status} ${record}: ${(cause as Error).message}`, { cause });
            }
            view.unmount();
          }
    }, 120_000);
  }
});
