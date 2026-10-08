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
 *   OA-C4 Your turn (phase 137 — the approve head became it): what is due
 *         first, then *Coming up*, each act a folded row — and still drawn
 *         when nothing is due.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inbox, humanSteps, read } = vi.hoisted(() => ({
  inbox: vi.fn(),
  humanSteps: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, inbox } };
});
vi.mock('@/lib/api/turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/turn')>();
  return { ...actual, turnApi: { ...actual.turnApi, read } };
});
vi.mock('@/lib/api/human-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/human-steps')>();
  return { ...actual, humanStepsApi: { ...actual.humanStepsApi, humanSteps } };
});

import { humanStepView } from '@shared/human-step-model.js';
import { MemoryRouterProvider } from '@/app/router';
import { HumanStepCard } from '@/components/human-step-card';
import { queryClientConfig } from '@/lib/queries';
import type { InboxItem, RunState, TurnAnswer, TurnItem } from '@/lib/api';
import TurnPage from '@/features/turn';
import { nowLanes } from './lanes-model';
import { TowerBays } from './tower/bays';
import { filterTower, towerModel } from './tower/tower-model';
import { itemsNow, runItems } from '@/features/turn/surfaces';

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
      {
        verb: 'check',
        label: "I've done this — check",
        endpoint: `/api/human-steps/${id}/check`,
        method: 'POST',
      },
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
    turn: {
      item: id,
      record: 'ledger',
      source: 'declared',
      kind: 'operator-act',
      why: 'reserved',
      proofType: 'probe',
      group: state === 'upcoming' ? 'upcoming' : 'now',
    },
    ...over,
  } as InboxItem;
}

function withClient(node: React.ReactNode) {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn" onNavigate={vi.fn()}>
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
    expect(within(card).getByTestId('step-state').textContent).toContain('Coming up');
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

  it('an upcoming act is no item a person owes now, and summons no run', () => {
    expect(itemsNow([act('notified')])).toHaveLength(1);
    expect(itemsNow([act('upcoming')])).toEqual([]);
    expect(runItems([act('upcoming')], RUN)).toEqual([]);
  });

  it('it is the Coming up list, after what is due, and the filter narrows it', () => {
    const model = towerModel({
      runs: [],
      lanes: [],
      inbox: [act('upcoming'), act('notified', { runId: undefined })],
      now: NOW,
    });
    expect(model.items.map((item) => item.humanStep?.state)).toEqual(['notified']);
    expect(model.upcoming.map((item) => item.humanStep?.state)).toEqual(['upcoming']);
    expect(filterTower(model, { query: 'alpha' }).upcoming).toHaveLength(1);
    expect(filterTower(model, { query: 'beta' }).upcoming).toHaveLength(0);
  });

  it('the Needs-you bay does not count it, and links to the page where it is listed (phase 139)', () => {
    const model = towerModel({
      runs: [],
      lanes: nowLanes([], new Map(), NOW),
      inbox: [act('upcoming')],
      now: NOW,
    });
    withClient(<TowerBays model={model} allowRun />);
    const bay = screen.getAllByTestId('bay').find((el) => el.getAttribute('data-bay') === 'needs-you')!;
    expect(bay.getAttribute('data-count')).toBe('0');
    expect(within(bay).queryByTestId('coming-up')).toBeNull();
    const line = within(bay).getByTestId('bay-turn');
    expect(line).toHaveTextContent('Your turn: 1 coming up — open the page');
    expect(line).toHaveAttribute('href', '#/turn');
  });
});

describe('OA-C4 Your turn', () => {
  function turnItem(state: 'upcoming' | 'notified'): TurnItem {
    const row = act(state);
    return {
      ...row,
      item: `s-${state}`,
      record: 'ledger',
      source: 'declared',
      kind: 'operator-act',
      why: 'reserved',
      proofType: 'probe',
      group: state === 'upcoming' ? 'upcoming' : 'now',
      rows: [row.id],
    } as unknown as TurnItem;
  }

  function mount(states: ('upcoming' | 'notified')[]) {
    const groups: TurnAnswer['groups'] = { now: [], decide: [], upcoming: [], checking: [], done: [] };
    for (const state of states) groups[state === 'upcoming' ? 'upcoming' : 'now'].push(turnItem(state));
    const at = new Date(NOW).toISOString();
    read.mockResolvedValue({
      round: { at, n: 1, ranAt: at, changedAt: null },
      headline: 'One act waits on you.',
      groups,
      handled: [],
      counts: {
        now: groups.now.length,
        decide: 0,
        upcoming: groups.upcoming.length,
        checking: 0,
        done: 0,
        total: states.length,
        handled: 0,
      },
      seen: null,
      issues: null,
    } satisfies TurnAnswer);
    return withClient(<TurnPage />);
  }

  const section = (id: string) =>
    screen.getAllByTestId('turn-section').find((el) => el.getAttribute('data-section') === id)!;

  it('draws what is due first, then Coming up as a folded row', async () => {
    mount(['upcoming', 'notified']);
    await screen.findByTestId('turn-headline');
    const now = section('now');
    const coming = section('upcoming');
    expect(within(now).getAllByTestId('turn-item')).toHaveLength(1);
    const row = within(coming).getByTestId('turn-item');
    expect(row.getAttribute('data-state')).toBe('upcoming');
    expect(within(row).getByTestId('turn-item-toggle')).toBeTruthy();
    // Worst first: what is due comes before what is coming.
    expect(now.compareDocumentPosition(coming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('still draws Coming up when nothing is due', async () => {
    mount(['upcoming']);
    await screen.findByTestId('turn-headline');
    expect(within(section('now')).queryAllByTestId('turn-item')).toHaveLength(0);
    expect(within(section('now')).getByText('Nothing to do now.')).toBeTruthy();
    expect(within(section('upcoming')).getByTestId('turn-item')).toBeTruthy();
  });
});
