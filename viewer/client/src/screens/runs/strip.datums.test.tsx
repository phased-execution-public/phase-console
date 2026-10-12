/**
 * The run row's datum ledger (docs/design.md §1, control-tower phase 19;
 * 7.0's row since quiet-console phase 7): every fact the 6.2 strip and the old
 * board card showed is reached within TWO interactions, and the raw record is
 * in the Inspector.
 *
 * The ledger is the old card's facts, one row each, with the press count at
 * which the row must show it: 0 on the glance, 1 once expanded in place
 * (`strip-expand` → `strip-detail`), 2 in the Inspector opened from there (the
 * "Inspect" button → the shell's panel, `InspectorHost`). A fact that moves
 * deeper than two presses — or disappears — fails its row by name. The raw
 * JSON sits behind the Inspector's own Raw tab, and is asserted whole.
 *
 * Two 6.2 rows were middle-dotted; 7.0 says them in words: "opus at max" and
 * "you pe/storefront-p4, them pe/alpha-p3". One figure's second half rides in
 * its title — the budget beside the spend (`ui/money.tsx`) — and its row says
 * so with `title`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsoleState, QueueEntry, RunState } from '@/data/api';

// The row is handed the whole record, so nothing is fetched to draw it: the
// three hooks that would read the server answer nothing, and a stubbed fetch
// below records any read that slips past them.
vi.mock('@/data/runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/runs')>();
  return {
    ...actual,
    useRun: vi.fn(() => ({ data: undefined })),
    usePhaseReport: vi.fn(() => ({ data: undefined })),
    usePhaseActivity: vi.fn(() => ({ data: undefined })),
  };
});

import { keys, queryClientConfig } from '@/data/keys';
import { lanesOf } from '@/data/lanes';
import { groupRuns } from '@/data/run-groups';
import { useRun } from '@/data/runs';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { expandStrips } from '@/test/expand';
import { TooltipProvider } from '@/ui/tooltip';
import { RunRow } from './run-row';

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: true,
  allowAgent: true,
  root: { ok: true, path: '/repo' },
} as unknown as ConsoleState;

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

let sent: string[] = [];

/**
 * The row as the home mounts it: placed by the home's own fold, handed the
 * whole record, beside the shell's panel host so Inspect has somewhere to draw.
 */
function mount(r: RunState, entry?: QueueEntry) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), STATE);
  client.setQueryData(keys.terminal(), {
    allowed: false,
    agentAllowed: true,
    available: 'yes',
    sessions: [],
  });
  const placed = groupRuns({
    runs: [r],
    lanes: lanesOf([r], new Map(), NOW),
    ...(entry ? { entries: [entry] } : {}),
    now: NOW,
  }).runs[0]!;
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunRow placed={placed} allowRun state={STATE} record={r} />
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return screen.getByRole('article');
}

/** Press Inspect on an expanded row, and read the panel it drew. */
function inspect(strip: HTMLElement): HTMLElement {
  fireEvent.click(within(strip).getByRole('button', { name: 'Inspect' }));
  const panel = document.querySelector<HTMLElement>('[data-inspector]');
  if (!panel) throw new Error('Inspect drew nothing in the panel');
  return panel;
}

/**
 * Press, name, where — the old card's facts. `presses` is the most the row may
 * make a person spend; `title` names a figure's second half that rides in an
 * element's title rather than its text.
 */
type Datum = { name: string; presses: 0 | 1 | 2; find: RegExp | string; title?: RegExp };

const LEDGER: Datum[] = [
  // The old card's header.
  { name: 'the plan it runs', presses: 0, find: 'storefront' },
  { name: 'its status word', presses: 0, find: /Running/ },
  { name: 'held, and by whom', presses: 0, find: /Held by me/ },
  { name: 'its priority, when not normal', presses: 1, find: 'high priority' },
  { name: 'bumped in its class', presses: 1, find: 'bumped' },
  { name: 'boards after another run', presses: 1, find: 'after upstream' },
  { name: 'its own checkout, and how many repos', presses: 1, find: 'own checkout, 2 repos' },
  // The phase strip and the counts.
  { name: 'phases done of phases touched', presses: 0, find: '2/4' },
  {
    name: 'spent of the run budget',
    presses: 0,
    find: '$4.20',
    title: /\$4\.20 spent of a \$25\.00 run budget/,
  },
  { name: 'the track, folded to labelled stations', presses: 0, find: /2 done.*P3 running.*P4 queued/ },
  { name: 'the spend meter', presses: 1, find: '2/4 phases' },
  // The lanes.
  { name: 'each lane, by phase', presses: 1, find: 'P3' },
  { name: "a lane's branch", presses: 1, find: 'pe/storefront-p3' },
  { name: "a lane's cost", presses: 1, find: '$1.10' },
  { name: "a lane's model and effort", presses: 1, find: 'opus at max' },
  { name: "a lane's clock, with its verb", presses: 1, find: /running 14m/ },
  { name: "the console's own check", presses: 1, find: 'npm run verify:local' },
  // The queue.
  { name: 'who holds the queued lane', presses: 1, find: /waiting on alpha P3/ },
  { name: 'how long it has queued', presses: 1, find: /queued 5m/ },
  {
    name: 'both branches, once two trees are in play',
    presses: 1,
    find: 'you pe/storefront-p4, them pe/alpha-p3',
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
  // The Inspector — one press from the expanded row.
  { name: 'the run id', presses: 2, find: /Run r-busy/ },
  { name: 'the root', presses: 2, find: '/repo' },
  { name: 'the checkout it got', presses: 2, find: '/repo/.worktrees/runs/storefront/r-busy' },
  { name: 'the git mode', presses: 2, find: 'new-branch' },
  { name: 'chained after (inspector)', presses: 2, find: 'Chained after' },
  { name: 'on credit', presses: 2, find: /\$0\.50 of it past plan limits/ },
  { name: 'the phase budget', presses: 2, find: '$12.00' },
  { name: 'consecutive failures of the ceiling', presses: 2, find: '1 of 4' },
  { name: 'the run budget (inspector)', presses: 2, find: '$25.00' },
];

const text = (root: HTMLElement, find: RegExp | string) =>
  typeof find === 'string' ? (root.textContent ?? '').includes(find) : find.test(root.textContent ?? '');
const titled = (root: HTMLElement, find: RegExp) =>
  [...root.querySelectorAll<HTMLElement>('[title]')].some((el) => find.test(el.title));
const shows = (root: HTMLElement, d: Datum) => text(root, d.find) && (!d.title || titled(root, d.title));

beforeEach(() => {
  setPrefs({ stripsOpen: [] });
  __resetInspectorForTests();
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      sent.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('the run row’s datum ledger — every fact within two interactions', () => {
  it('the glance carries the facts that decide whether to open it', () => {
    const strip = mount(busy, ENTRY);
    const missing = LEDGER.filter((d) => d.presses === 0 && !shows(strip, d)).map((d) => d.name);
    expect(missing).toEqual([]);
    // One line per thing: the one action, and the fold beside it.
    expect(within(strip).getByTestId('strip-action')).toHaveAttribute('data-action', 'pause');
    expect(within(strip).getByTestId('strip-expand')).toHaveAttribute('aria-expanded', 'false');
    expect(within(strip).queryByTestId('strip-detail')).toBeNull();
  });

  it('one press — expanded in place — reaches every fact of the old card body', () => {
    const strip = mount(busy, ENTRY);
    expect(expandStrips(strip)).toBe(1);
    expect(within(strip).getByTestId('strip-detail')).toBeInTheDocument();
    const missing = LEDGER.filter((d) => d.presses <= 1 && !shows(strip, d)).map((d) => d.name);
    expect(missing).toEqual([]);
    // Handed the record, the opened row reads nothing from the server.
    expect(vi.mocked(useRun)).toHaveBeenLastCalledWith('storefront', false);
    expect(sent.filter((url) => url.includes('/api/run/'))).toEqual([]);
  });

  it('two presses reach the Inspector’s facts, and the raw record is in it', () => {
    const strip = mount(busy, ENTRY);
    expandStrips(strip);
    const inspector = inspect(strip);
    expect(strip).toHaveAttribute('data-inspected');
    const missing = LEDGER.filter((d) => d.presses === 2 && !shows(inspector, d)).map((d) => d.name);
    expect(missing).toEqual([]);

    // L3: the whole record, verbatim, on the Inspector's own Raw tab.
    const raw = within(inspector).getByRole('tab', { name: 'Raw' });
    fireEvent.mouseDown(raw);
    fireEvent.click(raw);
    const pre = within(inspector).getByText(/"slug": "storefront"/);
    expect(JSON.parse(pre.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(busy)));
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
    // The glance's one action is the halt view's recommended verb (#278)…
    expect(within(strip).getByTestId('strip-action')).toHaveAttribute('data-recommended');
    expandStrips(strip);
    // …and the card behind it draws the same button first.
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
    expect(within(strip).queryByTestId('bumped-chip')).toBeNull();
  });
});
