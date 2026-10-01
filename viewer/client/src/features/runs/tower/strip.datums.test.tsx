/**
 * The strip's datum ledger (docs/design.md §1, control-tower phase 19):
 * every fact the old board card showed is reached within TWO interactions,
 * and the raw record is in the Inspector.
 *
 * The ledger is the old card's facts, one row each, with the press count at
 * which the strip must show it: 0 on the glance, 1 once expanded in place, 2 in
 * the Inspector opened from there. A fact that moves deeper than two presses —
 * or disappears — fails its row by name. The raw JSON sits behind the
 * Inspector's own "Raw record" fold (L3), and is asserted whole.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueEntry, RunState } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      phaseActivity: vi.fn(async () => ({ events: [], untrusted: true })),
      phaseReport: vi.fn(async () => ({ live: false })),
    },
  };
});

import { nowLanes } from '@/features/runs/lanes-model';
import { setPrefs } from '@/lib/prefs';
import { expandStrips } from '@/test/expand';
import { Strip } from './strip';

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A busy run: a live lane, a queued lane behind a holder, the console's own check, every chip. */
const busy = {
  id: 'r-busy',
  slug: 'storefront',
  root: '/repo',
  status: 'running',
  model: 'opus',
  autonomy: 'keep-going',
  gitMode: 'new-branch',
  startAfter: 'upstream',
  priority: 'high',
  hold: { at: iso(NOW - 4 * MIN), by: 'me' },
  checkout: 'worktree',
  workRoot: '/repo/.worktrees/runs/storefront/r-busy',
  mountedRepos: ['app', 'site'],
  spentUsd: 4.2,
  creditUsd: 0.5,
  phaseBudgetUsd: 12,
  runBudgetUsd: 25,
  consecutiveFailures: 1,
  maxConsecutiveFailures: 4,
  createdAt: iso(NOW - 3 * 60 * MIN),
  updatedAt: iso(NOW - MIN),
  activePhase: 3,
  children: {
    3: { pid: 103, phase: 3, sessionId: 's3', startedAt: iso(NOW - 14 * MIN), branch: 'pe/storefront-p3' },
  },
  verifying: {
    2: {
      phase: 2,
      purpose: 'verify',
      command: 'npm run verify:local',
      index: 3,
      total: 5,
      startedAt: iso(NOW - 12 * MIN),
      commandStartedAt: iso(NOW - MIN),
      pid: 902,
    },
  },
  phases: {
    1: { phase: 1, status: 'done', attempts: 1, costUsd: 1 },
    2: { phase: 2, status: 'done', attempts: 1, costUsd: 1 },
    3: {
      phase: 3,
      status: 'running',
      attempts: 1,
      costUsd: 1.1,
      model: 'opus',
      effort: 'max',
      attemptStartedAt: iso(NOW - 14 * MIN),
      startedAt: iso(NOW - 14 * MIN),
      liveness: {
        phase: 3,
        lastOutputAt: iso(NOW - 5_000),
        turnsSinceLastTool: 0,
        commitsSinceStart: 0,
        treeDirty: false,
      },
    },
    4: { phase: 4, status: 'queued', attempts: 0, costUsd: 0, queuedAt: iso(NOW - 5 * MIN) },
  },
} as unknown as RunState;

const ENTRY = {
  id: 'e4',
  slug: 'storefront',
  phase: 4,
  runId: 'r-busy',
  scope: ['app'],
  since: NOW - 5 * MIN,
  branch: 'pe/storefront-p4',
  bumped: true,
  held: { at: iso(NOW - 4 * MIN), by: 'me' },
  after: 'upstream',
  waitingOn: [
    {
      kind: 'grant',
      slug: 'alpha',
      phase: 3,
      owner: 'console',
      scope: ['app'],
      overlaps: ['app'],
      branch: 'pe/alpha-p3',
      eta: { of: 'phase', label: '~5 min of work left' },
    },
    { kind: 'grant', slug: 'beta', phase: 9, owner: 'console', scope: ['app'], overlaps: ['app'] },
  ],
  bypassed: 0,
  reserving: false,
} as unknown as QueueEntry;

function mount(r: RunState, entry?: QueueEntry) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['state'], { allowRun: true, allowWrites: true, allowAgent: true });
  render(
    <QueryClientProvider client={client}>
      <Strip
        run={r}
        lanes={nowLanes([r])}
        checks={Object.values(r.verifying ?? {})}
        {...(entry ? { entry } : {})}
        allowRun
      />
    </QueryClientProvider>,
  );
  return screen.getByTestId('board-card');
}

/** Press, name, where — the old card's facts. `presses` is the most the strip may make a person spend. */
type Datum = { name: string; presses: 0 | 1 | 2; find: RegExp | string };

const LEDGER: Datum[] = [
  // The old card's header.
  { name: 'the plan it runs', presses: 0, find: 'storefront' },
  { name: 'its status word', presses: 0, find: /Running/ },
  { name: 'held, and by whom (chip)', presses: 0, find: /held/ },
  { name: 'its priority, when not normal', presses: 1, find: 'high priority' },
  { name: 'bumped in its class', presses: 1, find: 'bumped' },
  { name: 'boards after another run', presses: 1, find: 'after upstream' },
  { name: 'its own checkout, and how many repos', presses: 1, find: 'own checkout, 2 repos' },
  // The phase strip and the counts.
  { name: 'phases done of phases touched', presses: 0, find: '2/4' },
  { name: 'spent of the run budget', presses: 0, find: '$4.20/$25.00' },
  { name: 'the spend meter', presses: 1, find: '2/4 phases' },
  // The lanes.
  { name: 'each lane, by phase', presses: 1, find: 'P3' },
  { name: "a lane's branch", presses: 1, find: 'pe/storefront-p3' },
  { name: "a lane's cost", presses: 1, find: '$1.10' },
  { name: "a lane's model and effort", presses: 1, find: /opus · max/ },
  { name: "a lane's clock, with its verb", presses: 1, find: /running 14m/ },
  { name: "the console's own check", presses: 1, find: 'npm run verify:local' },
  // The queue.
  { name: 'who holds the queued lane', presses: 1, find: /waiting on alpha P3/ },
  { name: 'how long it has queued', presses: 1, find: /queued 5m/ },
  {
    name: 'both branches, once two trees are in play',
    presses: 1,
    find: 'you pe/storefront-p4 · them pe/alpha-p3',
  },
  { name: "the holder's time left", presses: 1, find: 'P3 has ~5 min of work left' },
  { name: 'the other holders', presses: 1, find: /Also behind/ },
  { name: 'the entry held, by whom', presses: 1, find: /Held .* by me/ },
  { name: 'chained behind a run', presses: 1, find: 'Chained behind upstream, which has not settled.' },
  // The verbs.
  { name: 'Freeze', presses: 1, find: 'Freeze' },
  { name: 'Release (a held run)', presses: 1, find: 'Release' },
  { name: 'Stop', presses: 1, find: 'Stop' },
  { name: 'the priority control', presses: 1, find: 'Priority' },
  { name: 'Drop isolation', presses: 1, find: 'Drop isolation' },
  { name: 'Inspect', presses: 1, find: 'Inspect' },
  { name: 'Open run', presses: 1, find: 'Open run' },
  // The Inspector — one press from the expanded strip.
  { name: 'the run id', presses: 2, find: /Run r-busy/ },
  { name: 'the root', presses: 2, find: '/repo' },
  { name: 'the checkout it got', presses: 2, find: '/repo/.worktrees/runs/storefront/r-busy' },
  { name: 'the git mode', presses: 2, find: 'new-branch' },
  { name: 'chained after (inspector)', presses: 2, find: 'Chained after' },
  { name: 'on credit', presses: 2, find: /\$0\.50 of it past plan limits/ },
  { name: 'the phase budget', presses: 2, find: '$12.00' },
  { name: 'consecutive failures of the ceiling', presses: 2, find: '1 of 4' },
];

const shows = (root: HTMLElement, find: RegExp | string) =>
  typeof find === 'string' ? (root.textContent ?? '').includes(find) : find.test(root.textContent ?? '');

beforeEach(() => setPrefs({ stripsOpen: [] }));

describe('the strip’s datum ledger — every fact within two interactions', () => {
  it('the glance carries the facts that decide whether to open it', () => {
    const strip = mount(busy, ENTRY);
    const missing = LEDGER.filter((d) => d.presses === 0 && !shows(strip, d.find)).map((d) => d.name);
    expect(missing).toEqual([]);
  });

  it('one press — expanded in place — reaches every fact of the old card body', () => {
    const strip = mount(busy, ENTRY);
    expect(expandStrips(strip)).toBe(1);
    const missing = LEDGER.filter((d) => d.presses <= 1 && !shows(strip, d.find)).map((d) => d.name);
    expect(missing).toEqual([]);
  });

  it('two presses reach the Inspector’s facts, and the raw record is in it', () => {
    const strip = mount(busy, ENTRY);
    expandStrips(strip);
    fireEvent.click(within(strip).getByRole('button', { name: 'Inspect' }));
    const inspector = screen.getByRole('dialog');
    const missing = LEDGER.filter((d) => d.presses === 2 && !shows(inspector, d.find)).map((d) => d.name);
    expect(missing).toEqual([]);

    // L3: the whole record, verbatim, behind the Inspector's own fold.
    fireEvent.click(within(inspector).getByRole('button', { name: /Raw record/ }));
    const raw = within(inspector).getByText(/"slug": "storefront"/);
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(busy)));
  });

  it('a stop’s card and a waiting run’s note are one press away too', () => {
    const stopped = {
      ...busy,
      id: 'r-stop',
      slug: 'checkout',
      status: 'halted',
      children: {},
      verifying: {},
      halt: { at: iso(NOW - 12 * MIN), kind: 'verify-failed', reason: 'red', phase: 3 },
      phases: { ...busy.phases, 3: { ...busy.phases['3']!, status: 'failed', sessionId: 's3' } },
    } as unknown as RunState;
    const strip = mount(stopped);
    expandStrips(strip);
    expect(within(strip).getByTestId('halt-card')).toBeTruthy();
    expect(within(strip).getByTestId('halt-recommended')).toBeTruthy();
  });

  it('a terminal holding the line is released, and an unbumped entry bumped, one press in', () => {
    const entry = {
      ...ENTRY,
      bumped: false,
      waitingOn: [
        {
          kind: 'session',
          session: 'abcdef123456',
          slug: 'alpha',
          phase: 3,
          scope: ['app'],
          overlaps: ['app'],
        },
      ],
    } as unknown as QueueEntry;
    const strip = mount(busy, entry);
    expandStrips(strip);
    expect(within(strip).getByRole('button', { name: /Release terminal/ })).toBeTruthy();
    expect(within(strip).getByRole('button', { name: /Bump/ })).toBeTruthy();
  });
});
