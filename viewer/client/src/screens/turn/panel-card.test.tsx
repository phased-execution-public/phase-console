/**
 * The selected item's card in the panel (one-pool phase 14; Tower strips,
 * 2026-10-20):
 *
 *   PC-1 ONE title and ONE status — the card's head is the panel's only one:
 *        the frame draws no heading and no step word, and the region is named
 *        by the card's own title, drawn at the title size;
 *   PC-2 the act bar is pinned: *Send my decision* holds to the foot of the
 *        panel's scroller (sticky, a hairline over it, the card's ground under
 *        it), its form drawing no box of its own so the bar travels the whole
 *        act — and on the page the same card keeps its bar in flow;
 *   PC-3 the record asks for the form measure, so the panel fits a card.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { read, humanSteps } = vi.hoisted(() => ({ read: vi.fn(), humanSteps: vi.fn() }));

vi.mock('@/data/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/http')>();
  return {
    ...actual,
    request: (path: string) => {
      if (path.startsWith('/api/turn')) return read(path);
      if (path.startsWith('/api/human-steps')) return humanSteps(path);
      return Promise.reject(new actual.ApiError(`unmocked ${path}`, 500, path));
    },
  };
});

import { humanStepView } from '@shared/human-step-model.js';
import type { TurnAnswer, TurnItem } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { __resetInspectorForTests, InspectorHost, useInspected } from '@/shell/panel/inspector-host';
import { MemoryRouterProvider } from '@/shell/router';
import { inspectItem } from './inspector';
import { TurnItemCard } from './parts';

const AT = '2026-10-07T12:00:00.000Z';

const DECIDE: TurnItem = {
  item: 'decide-1',
  record: 'ledger',
  source: 'declared',
  kind: 'decision',
  why: 'decision',
  proofType: 'answer',
  group: 'decide',
  rows: ['human-step:alpha:3:decide-1'],
  title: 'Choose the release day',
  need: '',
  how: '',
  severity: 'needs-you',
  slug: 'alpha',
  phase: 3,
  since: '2026-10-07T10:00:00.000Z',
  href: '/plan/alpha/phase/3',
  actions: [],
  type: 'decide',
  personStatus: 'todo',
  readiness: 'now',
  humanStep: humanStepView({
    kind: 'decision',
    title: 'Choose the release day',
    state: 'notified',
    stepId: 'decide-1',
  }),
  step: {
    id: 'decide-1',
    kind: 'decision',
    title: 'The release day for alpha',
    state: 'notified',
    why: 'decision',
    whySource: 'declared',
    proofType: 'answer',
    attempts: 0,
    waiters: [],
    declaredAt: '2026-10-07T10:00:00.000Z',
    birth: 'session',
    options: [
      { id: 'mon', label: 'Ship it on Monday', recommended: true },
      { id: 'now', label: 'Ship it today' },
    ],
  } as unknown as TurnItem['step'],
};

function answer(): TurnAnswer {
  return {
    round: { at: AT, n: 1, ranAt: AT, changedAt: AT },
    headline: 'One thing to decide.',
    groups: { approve: [], now: [], decide: [DECIDE], upcoming: [], checking: [], done: [] },
    handled: [],
    counts: { approve: 0, now: 0, decide: 1, upcoming: 0, checking: 0, done: 0, total: 1, handled: 0 },
    seen: null,
  } as unknown as TurnAnswer;
}

/** The panel's body, as the shell hosts it — and what the shell reads of the record. */
function Panel() {
  const record = useInspected();
  return (
    <aside aria-label="Details" data-measure={record?.measure}>
      <InspectorHost />
    </aside>
  );
}

function mount() {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/turn/decide-1">
        <Panel />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  read.mockReset();
  humanSteps.mockReset();
  read.mockResolvedValue(answer());
  humanSteps.mockResolvedValue({
    steps: [],
    reminders: { series: [], quiet: null },
    can: { openHost: false, terminal: false, resume: false },
  });
  window.localStorage.clear();
});
afterEach(() => __resetInspectorForTests());

describe('PC-1 one title and one status', () => {
  it('the card’s head is the panel’s only one', async () => {
    inspectItem({ item: DECIDE, record: undefined }, { open: false, card: true });
    mount();
    const card = await screen.findByTestId('turn-item');
    const region = screen.getByRole('region', { name: 'Choose the release day' });
    expect(region.contains(card)).toBe(true);
    // No frame heading: the card's title is the one heading that names the item.
    expect(within(region).getAllByRole('heading', { name: 'Choose the release day' })).toEqual([
      within(card).getByTestId('turn-title'),
    ]);
    expect(within(card).getByTestId('turn-title').className).toMatch(/\btext-title\b/);
    // No step word beside the person's status: one status, the card's lead badge.
    expect(within(region).queryByText('Waiting on you')).toBeNull();
    expect(region.querySelectorAll('[data-vocab="step"]')).toHaveLength(0);
    expect(card.querySelectorAll('[data-chrome="tint"]')).toHaveLength(1);
  });
});

describe('PC-2 the act bar is pinned in the panel', () => {
  it('Send my decision holds to the foot of the panel’s scroller', async () => {
    inspectItem({ item: DECIDE, record: undefined }, { open: false, card: true });
    mount();
    const card = await screen.findByTestId('turn-item');
    const primary = await within(card).findByTestId('turn-primary');
    expect(primary.textContent).toBe('Send my decision');
    const bar = primary.closest('[data-testid="turn-moves"]')!;
    expect(bar.hasAttribute('data-pinned')).toBe(true);
    expect(bar.className).toMatch(/\bsticky\b/);
    // At the scroller's very foot: through its padding, so nothing reads under the bar.
    expect(bar.className).toMatch(/(?:^|\s)-bottom-\(--pad-y\)(?:\s|$)/);
    expect(bar.className).toMatch(/\bbg-surface\b/);
    expect(bar.className).toMatch(/\bborder-t\b/);
    // Its form draws no box of its own, so the bar travels the whole act.
    expect(within(card).getByTestId('decision-card').className).toMatch(/\bcontents\b/);
    expect(bar.closest('[data-testid="turn-act-section"]')).toBeTruthy();
  });

  it('on the page the same card keeps its bar in flow', () => {
    const client = new QueryClient(queryClientConfig);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouterProvider initial="#/turn">
          <TurnItemCard item={DECIDE} perform={vi.fn()} />
        </MemoryRouterProvider>
      </QueryClientProvider>,
    );
    const bar = screen.getByTestId('turn-primary').closest('[data-testid="turn-moves"]')!;
    expect(bar.hasAttribute('data-pinned')).toBe(false);
    expect(bar.className).not.toMatch(/\bsticky\b/);
    expect(screen.getByTestId('decision-card').className).not.toMatch(/\bcontents\b/);
    expect(screen.getByTestId('turn-title').className).toMatch(/\btext-section\b/);
  });
});

describe('PC-3 the record’s measure', () => {
  it('asks for the form measure, so the panel fits a card', async () => {
    inspectItem({ item: DECIDE, record: undefined }, { open: false, card: true });
    mount();
    await screen.findByTestId('turn-item');
    await waitFor(() => expect(screen.getByLabelText('Details').getAttribute('data-measure')).toBe('form'));
  });
});
