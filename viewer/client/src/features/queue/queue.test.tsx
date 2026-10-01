/**
 * `#/queue` — the whole queue of one console, on the 6.0 grid (control-tower
 * phase 99, #135; QV-1..6 from the page's side).
 *
 * The server writes every word (`GET /api/queue`); the page's promises are
 * that it SHOWS them — every entry in the order it will board, why it sits
 * there, what it waits on (a lane polling its own job named so, #67), its
 * class and account; the lanes and who each holds up; the hinted and the
 * withdrawn phases with the press that moves each; the audit strip — and that
 * every press sends the verb, the entry and the reason typed once at the top.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { queryClientConfig } from '@/lib/queries';
import type { QueueView, QueueViewEntry } from '@/lib/api';
import QueuePage from './index';
import { capacityLine, entryVerbs, laneLine, laneVerbs, pressBody } from './model';
import { queueMarks } from '@/features/runs/queue-words';

const { queue, queueAct, laneAct, queuePolicy, state, toast } = vi.hoisted(() => ({
  queue: vi.fn(),
  queueAct: vi.fn(),
  laneAct: vi.fn(),
  queuePolicy: vi.fn(),
  state: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return { ...actual, toast };
});

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, queue, queueAct, laneAct, queuePolicy, state } };
});

const NOW = Date.now();
const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

const entry = (over: Partial<QueueViewEntry>): QueueViewEntry =>
  ({
    id: 'e1',
    slug: 'alpha',
    phase: 7,
    runId: 'aaaaaaaaaaaa',
    scope: ['app'],
    since: NOW - 8 * 60_000,
    waitingOn: [],
    bypassed: 0,
    reserving: false,
    order: 0,
    position: 1,
    title: 'cart api',
    class: 'normal',
    account: 'default',
    clocks: { since: ago(8), waitedMs: 8 * 60_000 },
    reason: {
      key: 'seniority',
      text: `first come, first served — waiting since ${ago(8)}, 8 min`,
      all: [{ key: 'seniority', text: 'first come, first served' }],
    },
    waits: 'beta P2 — a live lane, polling its own job, 12 min',
    ...over,
  }) as QueueViewEntry;

const VIEW: QueueView = {
  max: 4,
  live: 1,
  queued: 2,
  entries: [
    entry({
      id: 'e2',
      slug: 'trade',
      phase: 43,
      position: 1,
      order: 0,
      class: 'high',
      account: 'work',
      title: 'order book',
      bumped: true,
      control: { bump: { at: ago(3), by: 'operator', reason: 'unblocks P50', stamp: NOW - 3 * 60_000 } },
      reason: {
        key: 'bumped',
        text: 'moved ahead by operator — unblocks P50 — first in its class',
        all: [{ key: 'bumped', text: 'moved ahead by operator — unblocks P50 — first in its class' }],
      },
    }),
    entry({ id: 'e1', position: 2, order: 1 }),
  ],
  grants: [
    { id: 'g1', slug: 'beta', phase: 2, runId: 'bbbbbbbbbbbb', scope: ['app'], at: NOW - 30 * 60_000 },
  ],
  lanes: [
    {
      slug: 'beta',
      phase: 2,
      runId: 'bbbbbbbbbbbb',
      scope: ['app'],
      account: 'default',
      since: ago(30),
      wait: { scope: 'local', minutes: 12, calls: 3, text: 'polling its own job, 12 min' },
      behind: [{ slug: 'alpha', phase: 7 }],
    },
  ],
  hinted: [
    {
      slug: 'alpha',
      runId: 'aaaaaaaaaaaa',
      phase: 59,
      since: ago(90),
      waitedMs: 90 * 60_000,
      rung: 'reboard-resume-brief',
      by: 'console',
      why: "re-boarded, and waiting behind its own run's P58",
      queue: {
        verb: 'bump',
        method: 'POST',
        endpoint: '/api/queue/bump',
        body: { slug: 'alpha', phase: 59 },
      },
    },
  ],
  withdrawn: [
    {
      slug: 'alpha',
      runId: 'aaaaaaaaaaaa',
      phase: 9,
      at: ago(20),
      by: 'operator',
      reason: 'not this week',
      text: 'withdrawn from the queue by operator — not this week',
      requeue: {
        verb: 'requeue',
        method: 'POST',
        endpoint: '/api/queue/requeue',
        body: { slug: 'alpha', phase: 9 },
      },
    },
  ],
  audit: [
    {
      at: ago(3),
      slug: 'trade',
      runId: 'cccccccccccc',
      phase: 43,
      verb: 'bump',
      by: 'operator',
      reason: 'unblocks P50',
      text: 'operator moved trade P43 ahead (3rd → 1st) — unblocks P50',
    },
  ],
} as unknown as QueueView;

function renderPage() {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouterProvider initial="#/queue" onNavigate={vi.fn()}>
        <QueuePage />
      </MemoryRouterProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queue.mockReset().mockResolvedValue(VIEW);
  queueAct
    .mockReset()
    .mockResolvedValue({ entries: [], change: { verb: 'hold', slug: 'alpha', phase: 7, changed: true } });
  state.mockReset().mockResolvedValue({ allowRun: true });
  laneAct.mockReset().mockResolvedValue({ entries: [] });
  queuePolicy
    .mockReset()
    .mockResolvedValue({ policy: { console: 'blocker-first', plans: {}, default: 'seniority' } });
  toast.mockReset();
});

describe('#/queue', () => {
  it('shows every entry in the order it will board — plan, phase, title, why here, what it waits on, class, account', async () => {
    renderPage();
    const table = await screen.findByRole('table', {
      name: /the admission queue, in the order it will board/i,
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('trade P43');
    expect(rows[0]).toHaveTextContent('order book');
    expect(rows[0]).toHaveTextContent('moved ahead by operator — unblocks P50');
    expect(rows[0]).toHaveTextContent('high');
    expect(rows[0]).toHaveTextContent('work');
    expect(rows[1]).toHaveTextContent('alpha P7');
    expect(rows[1]).toHaveTextContent('first come, first served');
    expect(within(rows[1]).getByTestId('queue-waits')).toHaveTextContent('polling its own job, 12 min');
  });

  it('names who holds what — a lane polling its own job, and who it is holding up (#67)', async () => {
    renderPage();
    const lanes = await screen.findByTestId('queue-lanes');
    expect(lanes).toHaveTextContent('beta P2');
    expect(within(lanes).getByTestId('queue-lane-line')).toHaveTextContent(
      'polling its own job, 12 min — holding up alpha P7',
    );
  });

  it('lists the hinted-not-queued phases with their press, and the withdrawn ones with theirs', async () => {
    renderPage();
    const hinted = await screen.findByTestId('queue-hinted');
    expect(hinted).toHaveTextContent('alpha P59');
    expect(hinted).toHaveTextContent("waiting behind its own run's P58");
    fireEvent.click(within(hinted).getByTestId('queue-hinted-queue'));
    await waitFor(() => expect(queueAct).toHaveBeenCalledWith('bump', { slug: 'alpha', phase: 59 }));
    const withdrawn = screen.getByTestId('queue-withdrawn');
    expect(withdrawn).toHaveTextContent('withdrawn from the queue by operator — not this week');
    fireEvent.click(within(withdrawn).getByTestId('queue-requeue'));
    await waitFor(() => expect(queueAct).toHaveBeenCalledWith('requeue', { slug: 'alpha', phase: 9 }));
  });

  it('sends every press with the reason typed once at the top, and says what it did', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: /the admission queue/i });
    fireEvent.change(screen.getByTestId('queue-reason'), { target: { value: 'waiting for the CI fix' } });
    const alpha = within(table).getAllByRole('row').slice(1)[1]!;
    fireEvent.click(within(alpha).getByTestId('queue-hold'));
    await waitFor(() =>
      expect(queueAct).toHaveBeenCalledWith('hold', { entryId: 'e1', reason: 'waiting for the CI fix' }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Held', 'ok'));
  });

  it('shows the audit strip — every change, newest first, with who and why', async () => {
    renderPage();
    const audit = await screen.findByTestId('queue-audit');
    expect(audit).toHaveTextContent('operator moved trade P43 ahead (3rd → 1st) — unblocks P50');
  });

  it('offers no press to a console without the run flag', async () => {
    state.mockResolvedValue({ allowRun: false });
    renderPage();
    await screen.findByRole('table', { name: /the admission queue/i });
    expect(screen.queryByTestId('queue-reason')).toBeNull();
    expect(screen.queryByTestId('queue-hold')).toBeNull();
    expect(screen.queryByTestId('queue-hinted-queue')).toBeNull();
  });
});

describe('the queue page model', () => {
  it('offers Release to a held entry and never the bump again to the head that was bumped', () => {
    const held = entryVerbs(entry({ position: 2, control: { hold: { at: ago(1), by: 'operator' } } }), NOW);
    expect(held.map((verb) => verb.verb)).toEqual(['bump', 'release', 'withdraw']);
    const head = entryVerbs(entry({ position: 1, bumped: true }), NOW);
    expect(head.map((verb) => verb.verb)).toEqual(['hold', 'defer', 'withdraw']);
    const defer = head.find((verb) => verb.verb === 'defer')!;
    expect(Date.parse(String(defer.body.until)) - NOW).toBe(60 * 60_000);
  });

  it('adds the reason only when one was typed, and says what a lane is doing', () => {
    expect(pressBody({ entryId: 'e1' }, '  ')).toEqual({ entryId: 'e1' });
    expect(pressBody({ entryId: 'e1' }, ' why ')).toEqual({ entryId: 'e1', reason: 'why' });
    expect(laneLine(VIEW.lanes[0]!)).toBe('polling its own job, 12 min — holding up alpha P7');
    expect(laneLine({ ...VIEW.lanes[0]!, wait: undefined, behind: [] } as never)).toBe(
      'nobody waiting on it',
    );
  });

  it("reads the marks the board and the run card show off the record — the server's own sentences", () => {
    const marks = queueMarks(
      {
        bump: { at: ago(3), by: 'operator', reason: 'unblocks P50', stamp: 1 },
        defer: { at: ago(3), by: 'watchdog', until: new Date(NOW + 60 * 60_000).toISOString() },
        withdrawn: { at: ago(1), by: 'operator' },
      },
      NOW,
    );
    expect(marks.map((mark) => mark.key)).toEqual(['withdrawn', 'defer', 'bump']);
    expect(marks.find((mark) => mark.key === 'bump')!.text).toBe('moved ahead by operator — unblocks P50');
    expect(queueMarks({ defer: { at: ago(9), until: ago(1) } }, NOW)).toEqual([]);
  });
});

/* ---- lanes, policies and capacity (control-tower phase 100) ---- */

const WITH_LANES = {
  ...VIEW,
  policy: { console: 'seniority', plans: { trade: 'blocker-first' }, default: 'seniority' },
  load: { avg5: 30.2, cores: 14, factor: 1.5, threshold: 21, holding: true },
  reservations: [
    {
      slug: 'sweep',
      runId: 'cccccccccccc',
      phase: 2,
      scope: ['all'],
      at: ago(5),
      armed: true,
      by: 'operator',
      reason: 'keep the deploy window',
    },
  ],
} as unknown as QueueView;

describe('#/queue — lanes, policies and capacity', () => {
  it('says what orders the queue and what holds all of it, and the policy changes from the page', async () => {
    queue.mockResolvedValue(WITH_LANES);
    renderPage();
    const line = await screen.findByTestId('queue-capacity');
    expect(line).toHaveTextContent('Seniority — first come, first served');
    expect(line).toHaveTextContent('plans: trade: blocker-first');
    expect(line).toHaveTextContent('the machine is loaded — 30.2 over 21 (1.5 × 14 cores); new work waits');
    fireEvent.change(screen.getByTestId('queue-policy'), { target: { value: 'blocker-first' } });
    await waitFor(() => expect(queuePolicy).toHaveBeenCalledWith({ policy: 'blocker-first' }));
  });

  it('pins a phase and keeps a lane through the lane door, lists kept lanes, and yields a live lane', async () => {
    queue.mockResolvedValue(WITH_LANES);
    renderPage();
    const kept = await screen.findByTestId('queue-kept');
    expect(kept).toHaveTextContent('sweep P2');
    expect(kept).toHaveTextContent(
      'holding all and one lane until it boards, by operator — keep the deploy window',
    );
    const table = await screen.findByRole('table', { name: /the admission queue/i });
    const row = within(table).getAllByRole('row')[2]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Pin next' }));
    await waitFor(() => expect(laneAct).toHaveBeenCalledWith('pin', { slug: 'alpha', phase: 7 }));
    expect(queueAct).not.toHaveBeenCalled();
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Keep a lane' })).not.toBeDisabled());
    fireEvent.click(within(row).getByRole('button', { name: 'Keep a lane' }));
    await waitFor(() => expect(laneAct).toHaveBeenCalledWith('reserve', { slug: 'alpha', phase: 7 }));
    await waitFor(() => expect(screen.getByTestId('queue-yield')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('queue-yield'));
    await waitFor(() => expect(laneAct).toHaveBeenCalledWith('yield', { slug: 'beta', phase: 2 }));
  });

  it('offers the undo of each lane mark, and says nothing about a queue that has no policy or load yet', () => {
    const pinned = laneVerbs({
      slug: 'alpha',
      phase: 7,
      pinned: true,
      laneReserved: { by: 'operator' },
    } as QueueViewEntry);
    expect(pinned.map((verb) => verb.verb)).toEqual(['unpin', 'unreserve']);
    expect(capacityLine(undefined)).toBe('');
    expect(
      capacityLine({
        load: { avg5: 3, cores: 14, factor: null, threshold: null, holding: false },
      } as QueueView),
    ).toBe('load 3, guard off');
  });
});
