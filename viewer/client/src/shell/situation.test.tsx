/**
 * The situation words in the header (7.0, quiet-console phase 3; the Tower's
 * one sentence since control-tower phases 20–21).
 *
 * Ported from `app/shell/situation.test.tsx`. What is pinned: the parts come in
 * the order it costs to miss them, only the non-zero figures, each one a link
 * on a desk to where it is answered; with exactly one run live it names that
 * run and what it is doing — never `phase ?`; "needs you" is the SHELL's count
 * (`counts.needsYou`, the fold `App.tsx` makes), Your turn the turn's own; the
 * desk line is one row whose clipped tail leaves the keyboard and the reading
 * order with it; a phone gets plain words; and it says nothing at all until
 * the runs have answered, or on a server with no run endpoints.
 *
 * Since 7.0's home (quiet-console phase 7) the figures are the home's own
 * groups (`useRunGroups`, the ONE fold): what is live and waiting is what the
 * fold says a run IS, and `queued` alone stays the queue's entry count —
 * phases, not runs. The fold reads the slim list, the queue, the plan
 * summaries and the inbox, each answered below.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, PlanSummary, SlimRun, SpendView } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { keys, queryClientConfig } from '@/data/keys';
import type { TurnAnswer } from '@/data/turn';
import { hrefOf } from './routes';
import SituationSlot from './situation-line';

const { runList, queue, plans, spend, inbox } = vi.hoisted(() => ({
  runList: vi.fn(),
  queue: vi.fn(),
  plans: vi.fn(),
  spend: vi.fn(),
  inbox: vi.fn(),
}));

// The slim run list is its own export (#234), not a member of `api`.
vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, runList, api: { ...actual.api, queue, plans, spend, inbox } };
});

const STATE: ConsoleState = { autopilot: true, allowRun: true, unread: 0 };
const NOW = new Date().toISOString();

const COUNTS: ShellCounts = {
  plans: 0,
  phases: 0,
  ready: 0,
  approvals: 0,
  unread: 0,
  needsYou: 0,
  asks: 0,
  sessions: 0,
  agentSessions: 0,
  terminalSessions: 0,
  mcpAttention: 0,
};
const counts = (over: Partial<ShellCounts> = {}): ShellCounts => ({ ...COUNTS, ...over });

const run = (over: Partial<SlimRun> = {}): SlimRun =>
  ({
    id: 'r1',
    slug: 'demo',
    status: 'running',
    // The lifecycle is the server's own fold of the word (`runLifecycle`): a
    // slim row never carries one that disagrees with its status, and the
    // groups read the lifecycle first.
    lifecycle: { state: over.status === 'waiting' ? 'waiting' : 'running' },
    activePhase: 3,
    halt: null,
    children: {},
    verifying: {},
    liveness: [],
    phases: { '3': 'running' },
    waitUntil: null,
    accountId: null,
    consecutiveFailures: 0,
    createdAt: NOW,
    updatedAt: NOW,
    finishedReason: null,
    ...over,
  }) as unknown as SlimRun;

const plan = (slug: string, ready: number[], over: Partial<PlanSummary> = {}): PlanSummary => ({
  slug,
  kind: 'plan',
  phases: 9,
  ready,
  status: 'active',
  closed: false,
  ...over,
});

const day = (settledUsd: number): SpendView => ({
  today: { settledUsd, ladderUsd: 0, capUsd: null },
  runs: [],
  series: [],
});

/** `GET /api/turn`, answered: the items of each group, and the AI's own handled count. */
function turn(
  groups: Partial<Record<'now' | 'decide' | 'upcoming' | 'checking' | 'done', number>> = {},
  handled = 0,
) {
  const n = { approve: 0, now: 0, decide: 0, upcoming: 0, checking: 0, done: 0, ...groups };
  return {
    round: { at: NOW, n: 1, ranAt: null, changedAt: null },
    headline: '',
    groups: { approve: [], now: [], decide: [], upcoming: [], checking: [], done: [] },
    handled: [],
    // The server's own fold (`server/turn/index.ts`): the open total over the
    // four live groups, and the AI's handled count beside it.
    counts: { ...n, total: n.now + n.decide + n.checking + n.upcoming, handled },
    seen: null,
    issues: null,
  } as TurnAnswer;
}

/**
 * Mounted under a client of the app's own config, with Your turn answered
 * in the cache — its read is not on `api` (`data/turn.ts`), so it is seeded
 * rather than mocked, and `staleTime: Infinity` keeps the seed the answer.
 */
function mount(node: ReactElement, answer: TurnAnswer = turn()) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.turn(), answer);
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const desk = (over: Partial<ShellCounts> = {}) => (
  <SituationSlot state={STATE} counts={counts(over)} phone={false} />
);

/** The parts, in the order the line draws them. */
const partsOf = (line: HTMLElement) =>
  [...line.querySelectorAll<HTMLElement>('[data-part]')].map((part) => part.dataset.part);

beforeEach(() => {
  vi.clearAllMocks();
  runList.mockResolvedValue([]);
  queue.mockResolvedValue({ entries: [], advice: [] });
  plans.mockResolvedValue([]);
  spend.mockResolvedValue(day(0));
  // The fold reads the inbox for a run a person's turn summons; nothing here does.
  inbox.mockResolvedValue({ items: [] });
});

describe('the situation words in the header', () => {
  it('names what is running, on any page, and links each figure to where it is answered', async () => {
    runList.mockResolvedValue([run()]);
    spend.mockResolvedValue(day(12.5));
    mount(desk());

    const line = await screen.findByTestId('situation-line');
    const live = await within(line).findByRole('link', { name: 'demo is running — phase 3' });
    expect(live.getAttribute('href')).toBe(hrefOf('runs', { group: 'live' }));
    // The day's money is answered on Insights, not on a bay.
    const money = await within(line).findByRole('link', { name: '$12.50 today' });
    expect(money.getAttribute('href')).toBe(hrefOf('insights'));
  });

  it('names the phase a baseline holds the lane for — never `phase ?` (control-tower phase 105, #193)', async () => {
    // ai-builder-v7 P8, 2026-10-03 01:35Z: `activePhase` null, no session, and
    // the console 9 lines into the phase's baseline.
    runList.mockResolvedValue([
      run({
        activePhase: null,
        phases: { '8': 'pending' },
        verifying: {
          '8': {
            phase: 8,
            purpose: 'baseline',
            command: 'pytest tests/unit',
            index: 9,
            total: 10,
            startedAt: NOW,
            commandStartedAt: NOW,
            pid: 789,
          },
        } as unknown as SlimRun['verifying'],
      }),
    ]);
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: 'demo is running — P8 baseline 9/10' });
    expect(line.textContent).not.toContain('phase ?');
  });

  it('says only that a run is running when no lane names a phase — never `phase ?`', async () => {
    runList.mockResolvedValue([run({ activePhase: null, phases: {} })]);
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: 'demo is running' });
    expect(line.textContent).not.toContain('?');
  });

  it('counts the runs once more than one is live', async () => {
    runList.mockResolvedValue([run(), run({ id: 'r2', slug: 'beta' }), run({ id: 'r3', slug: 'gamma' })]);
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    expect((await within(line).findByRole('link', { name: '3 live' })).getAttribute('href')).toBe(
      hrefOf('runs', { group: 'live' }),
    );
  });

  it('says so plainly when nothing is running — and says nothing else on a quiet console', async () => {
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: 'Nothing running right now' });
    // Only the non-zero figures: no "0 waiting", no "$0.00 today".
    expect(partsOf(line)).toEqual(['live']);
  });

  it('reads "needs you" off the shell’s own count, sending it to the Needs-you bay, loud', async () => {
    // The figure is `counts.needsYou` — the inbox `App.tsx` folds through
    // `shellCounts`, the same number the Runs badge wears — never a second count.
    mount(desk({ needsYou: 1 }));
    const needs = await screen.findByRole('link', { name: '1 needs you' });
    expect(needs.getAttribute('href')).toBe(hrefOf('runs', { group: 'needs-you' }));
    expect(needs.className).toMatch(/\bfont-medium\b/);
  });

  it('names Your turn on its own, loud, opening the page its items are on', async () => {
    mount(desk(), turn({ now: 2, decide: 1 }));
    const yours = await screen.findByRole('link', { name: 'Your turn (3)' });
    expect(yours.getAttribute('href')).toBe(hrefOf('turn'));
    expect(yours.className).toMatch(/\bfont-medium\b/);
  });

  it('counts the items a person owes NOW — Do now and Needs one detail — never the AI’s handled count', async () => {
    mount(desk(), turn({ now: 2, decide: 1, upcoming: 1, checking: 1 }, 4));
    const line = await screen.findByTestId('situation-line');
    // The page's own headline counts the same two groups (`server/turn/headline.ts`).
    await within(line).findByRole('link', { name: 'Your turn (3)' });
  });

  it('draws every part in the order it costs to miss them, the money last', async () => {
    runList.mockResolvedValue([
      run(),
      run({ id: 'r2', slug: 'beta' }),
      run({ id: 'r3', slug: 'gamma', status: 'waiting', activePhase: null }),
    ]);
    queue.mockResolvedValue({ entries: [{ slug: 'x' }, { slug: 'y' }], advice: [] });
    plans.mockResolvedValue([plan('alpha', [1, 2]), plan('omega', [5])]);
    spend.mockResolvedValue(day(4.25));
    mount(desk({ needsYou: 2 }), turn({ now: 1 }));

    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: '$4.25 today' });
    expect(partsOf(line)).toEqual(['needs-you', 'your-turn', 'live', 'waiting', 'queued', 'ready', 'spend']);
    const links = within(line).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['2 need you', hrefOf('runs', { group: 'needs-you' })],
      ['Your turn (1)', hrefOf('turn')],
      ['2 live', hrefOf('runs', { group: 'live' })],
      ['1 waiting', hrefOf('runs', { group: 'waiting' })],
      ['2 queued', hrefOf('runs', { group: 'queued' })],
      ['3 phases ready', hrefOf('runs', { group: 'ready' })],
      ['$4.25 today', hrefOf('insights')],
    ]);
    // Only what needs a person is loud.
    expect(
      links.filter((link) => /\bfont-medium\b/.test(link.className)).map((link) => link.textContent),
    ).toEqual(['2 need you', 'Your turn (1)']);
  });

  it('says one phase in the singular', async () => {
    plans.mockResolvedValue([plan('alpha', [4])]);
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    expect((await within(line).findByRole('link', { name: '1 phase ready' })).getAttribute('href')).toBe(
      hrefOf('runs', { group: 'ready' }),
    );
  });

  it('never counts a closed plan’s phases as ready — the bay the figure opens never boards one', async () => {
    plans.mockResolvedValue([
      plan('gone', [3, 4], { status: 'abandoned', closed: true }),
      plan('alpha', [2]),
    ]);
    mount(desk());
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: '1 phase ready' });
  });

  /**
   * The desk header is ONE row of a fixed height. Its parts used to shrink past
   * their own words in a no-wrap row and paint over each other (measured on the
   * e2e tour at 1280 px: "10 need you" over "tower is running"). They keep their
   * width, and a part the row cannot hold leaves WHOLE, to a clipped second
   * line — the money first, since the parts are ordered by what it costs to
   * miss them — and leaves the keyboard and the reading order with it.
   */
  it('keeps the desk line to one row: a part that does not fit leaves whole, and inert', async () => {
    runList.mockResolvedValue([run()]);
    spend.mockResolvedValue(day(12.5));
    // jsdom lays nothing out, so the row is measured here: the money wrapped.
    const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.part === 'spend' ? 24 : 0;
    });
    try {
      mount(desk());
      const line = await screen.findByTestId('situation-line');
      await within(line).findByText('$12.50 today');
      expect(line.className).toMatch(/\bh-6\b/);
      expect(line.className).toMatch(/\boverflow-hidden\b/);
      expect(line.className).toMatch(/\bflex-wrap\b/);
      expect(line.className).not.toMatch(/\bflex-nowrap\b/);
      const spent = line.querySelector('[data-part="spend"]')!;
      const live = line.querySelector('[data-part="live"]')!;
      expect(live.className).toMatch(/\bshrink-0\b/);
      expect(spent).toHaveAttribute('inert');
      expect(spent).toHaveAttribute('aria-hidden', 'true');
      expect(live).not.toHaveAttribute('inert');
      // Still named for everyone else: only the clipped part left.
      expect(within(line).getByRole('link', { name: 'demo is running — phase 3' })).toBeInTheDocument();
      expect(within(line).queryByRole('link', { name: '$12.50 today' })).toBeNull();
    } finally {
      top.mockRestore();
    }
  });

  it('hides nothing from a row that holds every part', async () => {
    runList.mockResolvedValue([run()]);
    spend.mockResolvedValue(day(3));
    mount(desk({ needsYou: 1 }));
    const line = await screen.findByTestId('situation-line');
    await within(line).findByRole('link', { name: '$3.00 today' });
    expect(line.querySelectorAll('[inert]')).toHaveLength(0);
    // A screen reader hears the parts as a list: a comma between, never a dot.
    expect(line.textContent).toBe('1 needs you, demo is running — phase 3, $3.00 today');
  });

  it('gives a phone plain words on a row of its own, with inline padding (#284) — no target under the tap floor', async () => {
    runList.mockResolvedValue([run()]);
    mount(<SituationSlot state={STATE} counts={counts({ needsYou: 1 })} phone />);
    const line = await screen.findByTestId('situation-line');
    expect(line.textContent).toContain('demo is running — phase 3');
    expect(line.textContent).toContain('1 needs you');
    expect(within(line).queryAllByRole('link')).toEqual([]);
    // The words never touch the screen's edge.
    expect(line.parentElement!.className).toMatch(/(^|\s)px-\S+/);
    // …and a phone's row is never clipped to one line: nothing goes inert.
    expect(line.className).not.toMatch(/\boverflow-hidden\b/);
  });

  it('says nothing before the runs have answered, and nothing on a server with no run endpoints', async () => {
    runList.mockImplementation(() => new Promise<SlimRun[]>(() => {}));
    const { container, unmount } = mount(desk({ needsYou: 2 }));
    await Promise.resolve();
    // Not even the count it already has: "Nothing running right now" before
    // the list arrives would be a claim, not a fact.
    expect(container.textContent).toBe('');
    unmount();

    const stale = mount(
      <SituationSlot state={{ ...STATE, autopilot: false }} counts={COUNTS} phone={false} />,
    );
    await Promise.resolve();
    expect(stale.container.textContent).toBe('');
    stale.unmount();

    const booting = mount(<SituationSlot state={undefined} counts={COUNTS} phone={false} />);
    await Promise.resolve();
    expect(booting.container.textContent).toBe('');
    // Only the first mount ever asked.
    expect(runList).toHaveBeenCalledTimes(1);
  });
});
