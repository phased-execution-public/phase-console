/**
 * The operator-acts queue, as a person meets it (control-tower phase 121, #182).
 *
 * An act only the operator can do is a human step of kind `operator-act`, and
 * one declared before it is due is `upcoming`: shown, never a summons, until
 * its due-when ref lands. Pinned here:
 *
 *   OA-C1 a due act leads with its command, and the command is copyable;
 *   OA-C2 an upcoming act says what it waits on and offers no open, no check
 *         and no snooze (the ledger refuses each before it is due), yet its
 *         command still copies;
 *   OA-C3 the Tower: an upcoming act summons no run and counts in no bay — it
 *         is the *Coming up* list after what is due, narrowed by the filter;
 *   OA-C4 the approve head: the due cards first, then *Coming up*, drawn with
 *         the card's row variant — and still drawn when nothing is due.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inbox, humanSteps } = vi.hoisted(() => ({ inbox: vi.fn(), humanSteps: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, inbox } };
});
vi.mock('@/lib/api/human-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/human-steps')>();
  return { ...actual, humanStepsApi: { ...actual.humanStepsApi, humanSteps } };
});

import { humanStepView } from '@shared/human-step-model.js';
import { MemoryRouterProvider } from '@/app/router';
import { HumanStepCard } from '@/components/human-step-card';
import { queryClientConfig } from '@/lib/queries';
import type { InboxItem, InboxView, RunState } from '@/lib/api';
import ApprovePage from '@/features/approve';
import { nowLanes } from './lanes-model';
import { TowerBays } from './tower/bays';
import { filterTower, isStepItem, stepItemsOf, towerModel } from './tower/tower-model';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const COMMAND = 'npm publish --access public';
const DUE_WHEN = 'unit:build-box/nightly-build.service';

function act(state: 'upcoming' | 'notified', over: Partial<InboxItem> = {}): InboxItem {
  const id = `s-${state}`;
  return {
    id: `human-step:alpha:3:${id}`,
    kind: 'human-step',
    severity: state === 'upcoming' ? 'fyi' : 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    title: `${state === 'upcoming' ? 'Coming up' : 'Your turn'} — carry out a task for alpha phase 3`,
    need: 'Publish the package once the nightly build is green',
    how: '',
    since: new Date(NOW - 10 * 60_000).toISOString(),
    href: '/plan/alpha/phase/3',
    actions: [
      { verb: 'check', label: 'I did it — check', endpoint: `/api/human-steps/${id}/check`, method: 'POST' },
    ],
    humanStep: humanStepView({
      kind: 'operator-act',
      title: 'Publish the package once the nightly build is green',
      where: 'host',
      state,
      stepId: id,
      openCommand: COMMAND,
      proof: 'cmd:"npm view my-package version"',
      ...(state === 'upcoming' ? { dueWhen: DUE_WHEN } : {}),
      check: true,
    }),
    ...over,
  } as InboxItem;
}

function withClient(node: React.ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/approve" onNavigate={vi.fn()}>
        {node}
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  humanSteps.mockResolvedValue({
    steps: [],
    reminders: { series: [], quiet: null },
    can: { openHost: false, terminal: true, resume: true },
  });
});

describe('OA-C1 a due act leads with its command', () => {
  it('opens in the terminal, and the command is there to copy', () => {
    withClient(<HumanStepCard item={act('notified')} />);
    const card = screen.getByTestId('human-step-card');
    expect(within(card).getByTestId('step-primary').getAttribute('data-act')).toBe('terminal');
    const command = within(card).getByTestId('step-command');
    expect(command.textContent).toContain(COMMAND);
    expect(within(command).getByRole('button', { name: /copy/i })).toBeTruthy();
    expect(within(card).queryByTestId('step-due')).toBeNull();
  });
});

describe('OA-C2 an upcoming act is shown, never pressed', () => {
  it('the card says what it waits on, and offers only what the ledger allows', () => {
    withClient(<HumanStepCard item={act('upcoming')} />);
    const card = screen.getByTestId('human-step-card');
    expect(card.getAttribute('data-state')).toBe('upcoming');
    expect(within(card).getByTestId('step-state').textContent).toBe('coming up');
    expect(within(card).getByTestId('step-due').textContent).toBe(`Due when ${DUE_WHEN} lands.`);
    // Not due: nothing to open, check or snooze — the ledger refuses each.
    for (const id of ['step-primary', 'step-open-again', 'step-check', 'step-snooze'])
      expect(within(card).queryByTestId(id)).toBeNull();
    // It can still be handed back, and its command still copies.
    expect(within(card).getByTestId('step-cannot')).toBeTruthy();
    expect(within(card).getByTestId('step-command').textContent).toContain(COMMAND);
  });

  it('the row says it too, with no primary', () => {
    withClient(<HumanStepCard item={act('upcoming')} variant="row" />);
    const row = screen.getByTestId('human-step-row');
    expect(row.getAttribute('data-state')).toBe('upcoming');
    expect(within(row).getByTestId('step-due').textContent).toBe(`Due when ${DUE_WHEN} lands.`);
    expect(within(row).getByTestId('step-command').textContent).toContain(COMMAND);
    expect(within(row).queryByTestId('step-primary')).toBeNull();
  });
});

describe('OA-C3 the Tower', () => {
  const RUN = {
    id: 'r1',
    slug: 'alpha',
    root: '/repo',
    status: 'waiting',
    waitReason: 'person',
    model: 'opus',
    spentUsd: 1,
    runBudgetUsd: null,
    createdAt: new Date(NOW - 90 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    phases: { 3: { phase: 3, status: 'waiting', attempts: 1, costUsd: 0 } },
    halt: null,
  } as unknown as RunState;

  it('an upcoming act is no step item and summons no run', () => {
    expect(isStepItem(act('notified'))).toBe(true);
    expect(isStepItem(act('upcoming'))).toBe(false);
    expect(stepItemsOf([act('upcoming')], RUN)).toEqual([]);
  });

  it('it is the Coming up list, after what is due, and the filter narrows it', () => {
    const model = towerModel({
      runs: [],
      lanes: [],
      inbox: [act('upcoming'), act('notified', { runId: undefined })],
      now: NOW,
    });
    expect(model.steps.map((item) => item.humanStep?.state)).toEqual(['notified']);
    expect(model.upcoming.map((item) => item.humanStep?.state)).toEqual(['upcoming']);
    expect(filterTower(model, { query: 'alpha' }).upcoming).toHaveLength(1);
    expect(filterTower(model, { query: 'beta' }).upcoming).toHaveLength(0);
  });

  it('the Needs-you bay draws it below its own rows and does not count it', async () => {
    const model = towerModel({
      runs: [],
      lanes: nowLanes([], new Map(), NOW),
      inbox: [act('upcoming')],
      now: NOW,
    });
    withClient(<TowerBays model={model} allowRun />);
    const bay = screen.getAllByTestId('bay').find((el) => el.getAttribute('data-bay') === 'needs-you')!;
    expect(bay.getAttribute('data-count')).toBe('0');
    const list = within(bay).getByTestId('coming-up');
    expect(within(list).getByRole('heading', { name: 'Coming up' })).toBeTruthy();
    const row = await within(list).findByTestId('human-step-row');
    expect(row.getAttribute('data-state')).toBe('upcoming');
  });
});

describe('OA-C4 the approve head', () => {
  function mount(items: InboxItem[]) {
    inbox.mockResolvedValue({ items, generatedAt: new Date(NOW).toISOString() } as InboxView);
    return withClient(<ApprovePage />);
  }

  it('draws the due cards first, then Coming up as rows', async () => {
    mount([act('upcoming'), act('notified')]);
    const page = await screen.findByTestId('approve-page');
    const cards = within(page).getAllByTestId('approve-card');
    expect(cards).toHaveLength(1);
    const coming = within(page).getByTestId('approve-coming-up');
    expect(within(coming).getByRole('heading', { name: 'Coming up' })).toBeTruthy();
    expect(within(coming).getByTestId('human-step-row').getAttribute('data-state')).toBe('upcoming');
    // Worst first: what is due comes before what is coming.
    expect(cards[0]!.compareDocumentPosition(coming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('still draws Coming up when nothing is due', async () => {
    mount([act('upcoming')]);
    const page = await screen.findByTestId('approve-page');
    expect(within(page).queryAllByTestId('approve-card')).toHaveLength(0);
    expect(within(page).getByText('Nothing to answer')).toBeTruthy();
    expect(within(within(page).getByTestId('approve-coming-up')).getByTestId('human-step-row')).toBeTruthy();
  });
});
