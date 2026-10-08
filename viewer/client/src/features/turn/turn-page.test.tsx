/**
 * Your turn, the page (control-tower phase 137, #214, exit criterion 2).
 *
 *   TP-1 the round, its time and the headline, then the six sections in order;
 *   TP-2 the filters and the search live in the address — an address narrows
 *        the page, and a select writes its word into the address;
 *   TP-3 *Done* holds the day's settled items and, under them, the ledger's older ones;
 *   TP-4 *Export* writes ONE Markdown document of the open items with their guides;
 *   TP-5 `#/turn/<id>` opens that item (aria-current) — even one folded under Coming up;
 *        an id the turn no longer holds says so;
 *   TP-6 the handled log is the last section, folded with its count.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { read, humanSteps } = vi.hoisted(() => ({ read: vi.fn(), humanSteps: vi.fn() }));

vi.mock('@/lib/api/turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/turn')>();
  return { ...actual, turnApi: { ...actual.turnApi, read } };
});
vi.mock('@/lib/api/human-steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/human-steps')>();
  return { ...actual, humanStepsApi: { ...actual.humanStepsApi, humanSteps } };
});

import { humanStepView, type HumanStepKind, type HumanStepState } from '@shared/human-step-model.js';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { HumanStepRecord, TurnAnswer, TurnItem } from '@/lib/api';
import TurnPage from './index';
import { turnMarkdown } from './export';
import { filtersOf, sectionsOf } from './page-model';

const AT = '2026-10-07T12:00:00.000Z';

function item(
  id: string,
  kind: HumanStepKind,
  state: HumanStepState,
  group: TurnItem['group'],
  over: Partial<TurnItem> = {},
): TurnItem {
  return {
    item: id,
    record: 'ledger',
    source: 'declared',
    kind,
    why: kind === 'decision' ? 'decision' : 'identity',
    proofType: kind === 'decision' ? 'answer' : 'probe',
    group,
    rows: [`human-step:alpha:3:${id}`],
    title: `Item ${id}`,
    need: '',
    how: '',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    since: '2026-10-07T10:00:00.000Z',
    href: '/plan/alpha/phase/3',
    actions: [],
    humanStep: humanStepView({ kind, title: `Item ${id}`, state, stepId: id }),
    step: {
      id,
      kind,
      title: `Item ${id}`,
      state,
      why: 'identity',
      whySource: 'declared',
      proofType: 'probe',
      attempts: 0,
      waiters: [],
      declaredAt: '2026-10-07T10:00:00.000Z',
      birth: 'session',
      guide:
        id === 'now-1'
          ? {
              version: 1,
              lang: 'en',
              dir: 'ltr',
              summary: 'Only you can sign the CLI in.',
              steps: [{ text: 'Run the sign-in', code: 'gh auth login --web' }],
              trouble: [],
            }
          : undefined,
    } as TurnItem['step'],
    ...over,
  };
}

const ANSWER: TurnAnswer = {
  round: { at: AT, n: 14, ranAt: AT, changedAt: '2026-10-07T11:50:00.000Z' },
  headline: 'Two things wait on you; one unblocks phase 4.',
  groups: {
    now: [item('now-1', 'browser-login', 'notified', 'now')],
    decide: [
      item('decide-1', 'decision', 'notified', 'decide', {
        slug: 'beta',
        phase: 2,
        rows: ['human-step:beta:2:decide-1'],
      }),
    ],
    upcoming: [item('up-1', 'operator-act', 'upcoming', 'upcoming')],
    checking: [item('check-1', 'physical', 'checking', 'checking')],
    done: [item('done-1', 'secret-entry', 'proven', 'done')],
  },
  handled: [
    {
      id: 'h-1',
      at: AT,
      first: '2026-10-07T09:00:00.000Z',
      source: 'auto-grant',
      what: 'Allowed git push of the run branch',
      slug: 'alpha',
      phase: 3,
      count: 3,
      links: [{ kind: 'commit', ref: '41bc1f14abcdef' }],
    },
  ],
  counts: { now: 1, decide: 1, upcoming: 1, checking: 1, done: 1, total: 5, handled: 1 },
  seen: null,
  issues: { count: 2, href: '/repo/issues?state=draft' },
};

const OLDER: HumanStepRecord = {
  id: 'old-1',
  kind: 'claude-login',
  title: 'Sign Claude in again',
  where: 'host',
  birth: 'console',
  slug: 'alpha',
  phase: 1,
  state: 'proven',
  declaredAt: '2026-10-01T10:00:00.000Z',
  at: '2026-10-01T11:00:00.000Z',
  opened: 1,
};

function mount(hash = '#/turn', onNavigate = vi.fn()) {
  const client = new QueryClient(queryClientConfig);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial={hash} onNavigate={onNavigate}>
        <TurnPage />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
  return onNavigate;
}

beforeEach(() => {
  read.mockReset();
  humanSteps.mockReset();
  read.mockResolvedValue(ANSWER);
  humanSteps.mockResolvedValue({
    steps: [OLDER],
    reminders: { series: [], quiet: null },
    can: { openHost: false, terminal: false, resume: false },
  });
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('TP-1 the round, the headline and the six sections', () => {
  it('draws them in order', async () => {
    mount();
    expect((await screen.findByTestId('turn-headline')).textContent).toBe(ANSWER.headline);
    expect(screen.getByTestId('turn-round').textContent).toContain('Round 14');
    const sections = screen.getAllByTestId('turn-section').map((s) => s.getAttribute('data-section'));
    expect(sections).toEqual(['now', 'decide', 'upcoming', 'checking', 'done', 'handled']);
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.replace(/\d+$/, ''));
    expect(headings).toEqual([
      'Do now',
      'Needs one detail from you',
      'Coming up',
      'Being checked',
      'Done',
      'Handled by the AI',
    ]);
    expect(screen.getByTestId('turn-issues').textContent).toContain('2 issue drafts wait');
    // The page remembers the look, for the next one's handled count.
    expect(window.localStorage.getItem('turn:seen')).toBe(AT);
  });
});

describe('TP-2 the filters live in the address', () => {
  it('an address narrows the page', async () => {
    mount('#/turn?plan=beta');
    await screen.findByTestId('turn-headline');
    const items = screen.getAllByTestId('turn-item').map((el) => el.getAttribute('data-item'));
    expect(items).toEqual(['decide-1']);
    expect(screen.getAllByText(/hidden by the filters/).length).toBeGreaterThan(0);
  });

  it('a select writes its word into the address, keeping the item it names', async () => {
    const onNavigate = mount('#/turn/now-1');
    await screen.findByTestId('turn-headline');
    fireEvent.change(screen.getByTestId('turn-filter-kind'), { target: { value: 'decision' } });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.stringContaining('#/turn/now-1?kind=decision'));
  });

  it('the search is a filter too', () => {
    const narrowed = sectionsOf(ANSWER, filtersOf({ q: 'gh auth' }));
    expect(narrowed.flatMap((s) => s.items.map((i) => i.item))).toEqual(['now-1']);
  });
});

describe('TP-3 Done', () => {
  it('holds the day’s settled items and the ledger’s older ones, folded with its count', async () => {
    mount();
    await screen.findByTestId('turn-headline');
    const done = screen
      .getAllByTestId('turn-section')
      .find((s) => s.getAttribute('data-section') === 'done')!;
    expect(within(done).queryByTestId('turn-item')).toBeNull();
    fireEvent.click(within(done).getByRole('button', { name: /What was settled/ }));
    expect(within(done).getByTestId('turn-item').getAttribute('data-item')).toBe('done-1');
    expect(within(done).getByTestId('turn-done-earlier').textContent).toContain('Sign Claude in again');
  });
});

describe('TP-4 Export', () => {
  it('writes one Markdown document of the open items with their guides', () => {
    const text = turnMarkdown(ANSWER, sectionsOf(ANSWER, {}), new Map());
    expect(text.startsWith('# Your turn\n')).toBe(true);
    expect(text).toContain(ANSWER.headline);
    expect(text).toContain('## Do now');
    expect(text).toContain('### Item now-1');
    expect(text).toContain('gh auth login --web');
    expect(text).toContain('#### Steps');
    expect(text).toContain('## Coming up');
    // Settled is not open.
    expect(text).not.toContain('Item done-1');
    expect(text.match(/^# /gm)).toHaveLength(1);
  });
});

describe('TP-5 an item by its address', () => {
  it('opens the named item, even one folded under Coming up', async () => {
    mount('#/turn/up-1');
    await screen.findByTestId('turn-headline');
    const named = screen.getAllByTestId('turn-item').find((el) => el.getAttribute('data-item') === 'up-1')!;
    expect(named.getAttribute('aria-current')).toBe('true');
    expect(within(named).getByTestId('turn-body').className).toContain('flex');
  });

  it('says so when the item is no longer waiting', async () => {
    mount('#/turn/gone-1');
    expect((await screen.findByTestId('turn-item-gone')).textContent).toContain('no longer waiting');
  });
});

describe('TP-6 the handled log', () => {
  it('is the last section, folded with its count', async () => {
    mount();
    await screen.findByTestId('turn-headline');
    const handled = screen.getAllByTestId('turn-section').at(-1)!;
    expect(handled.getAttribute('data-section')).toBe('handled');
    expect(within(handled).queryByTestId('turn-handled')).toBeNull();
    fireEvent.click(within(handled).getByRole('button', { name: /What the AI handled/ }));
    const row = within(handled).getByTestId('turn-handled-row');
    expect(row.textContent).toContain('A standing grant allowed it');
    expect(row.textContent).toContain('×3');
    expect(row.textContent).toContain('commit 41bc1f14');
  });
});
