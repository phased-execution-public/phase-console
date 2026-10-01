/**
 * Every datum the run page showed is reached within two interactions, with a
 * raw view (control-tower phase 24, exit criterion 1; `docs/design.md` §1).
 *
 * Phase 24 folded the page: it opens on a glance — the run's strip, the facts
 * the strip does not carry, the asks, the halt card when stopped, the verbs and
 * the four figures — and everything else sits one press down, under a fold that
 * names it. "Minimal" never means fewer facts, so this is the ledger of what the
 * flat page carried, each row saying how many presses it now costs: 0 on the
 * glance, 1 behind a fold, 2 behind a fold and a tab. A row that fails names
 * the datum, not an index.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, JournalEntry, PlanDetail, RunLedger, RunState } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';
import { setPrefs } from '@/lib/prefs';

const { state, run, runJournal, runTimeline, runLedger } = vi.hoisted(() => ({
  state: vi.fn(),
  run: vi.fn(),
  runJournal: vi.fn(),
  runTimeline: vi.fn(),
  runLedger: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      state,
      run,
      runJournal,
      runTimeline,
      runLedger,
      runRulings: vi.fn(async () => ({ rulings: [] })),
      runScopes: vi.fn(async () => ({ scopes: [] })),
      queue: vi.fn(async () => ({
        max: 3,
        live: 0,
        queued: 0,
        throttledUntil: null,
        grants: [],
        entries: [],
      })),
      approvals: vi.fn(async () => []),
      auth: vi.fn(async () => ({ loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' })),
      accounts: vi.fn(async () => ({ accounts: [], allowAccounts: false })),
      runTranscript: vi.fn(async () => []),
      phaseActivity: vi.fn(async () => ({ events: [], untrusted: true })),
      phaseReport: vi.fn(async () => ({ live: false })),
    },
  };
});

vi.setConfig({ testTimeout: 20_000 });

const STATE = {
  autopilot: true,
  allowRun: true,
  allowWrites: false,
  staticRoot: 'not-built',
  root: { path: '/repo', ok: true, planCount: 1, handoffCount: 1 },
  scriptsDir: '/scripts',
  recentRoots: [],
  unread: 0,
} as unknown as ConsoleState;

const RUN = {
  id: 'run-7f3a',
  slug: 'demo',
  root: '/repo',
  status: 'halted',
  autonomy: 'keep-going',
  model: 'opus',
  phaseBudgetUsd: null,
  runBudgetUsd: null,
  spentUsd: 4.25,
  maxConsecutiveFailures: 2,
  consecutiveFailures: 0,
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T01:00:00Z',
  activePhase: 1,
  child: null,
  waitUntil: null,
  halt: {
    phase: 1,
    kind: 'verify-failed',
    reason: 'The verification of phase 1 went red.',
    at: '2026-08-03T01:00:00Z',
  },
  pause: null,
  freeze: null,
  notes: [
    { id: 'n1', at: '2026-08-03T00:30:00Z', by: 'operator', text: 'Leave the cache alone.', pinned: true },
  ],
  phases: {
    1: {
      phase: 1,
      status: 'failed',
      attempts: 2,
      costUsd: 3.1,
      queuedMs: 120_000,
      attemptWindows: [
        { attempt: 1, startedAt: '2026-08-03T00:05:00Z', endedAt: '2026-08-03T00:25:00Z' },
        {
          attempt: 2,
          startedAt: '2026-08-03T00:40:00Z',
          firstToolAt: '2026-08-03T00:41:30Z',
          endedAt: '2026-08-03T01:00:00Z',
        },
      ],
      verification: {
        ok: false,
        reason: 'npm test exited 1',
        ran: [
          {
            command: 'npm test',
            ok: false,
            code: 1,
            output: 'FAIL',
            tree: { repo: 'phased-execution', branch: 'pe/control-tower', head: '1d1911ee4c7a' },
          },
        ],
        notRun: [],
        trees: [
          { repo: 'phased-execution', branch: 'pe/control-tower', head: '1d1911ee4c7a', role: 'verify-in' },
        ],
      },
    },
  },
} as unknown as RunState;

const HISTORY = [
  { ...RUN, id: 'run-7f3a' },
  { ...RUN, id: 'run-earlier-1', status: 'finished', halt: null, createdAt: '2026-08-01T00:00:00Z' },
] as unknown as RunState[];

const JOURNAL: JournalEntry[] = [
  { seq: 1, time: '2026-08-03T00:00:00Z', event: 'run.start', data: { runId: 'run-7f3a' } },
  { seq: 2, time: '2026-08-03T01:00:00Z', event: 'run.halt', phase: 1, data: { kind: 'verify-failed' } },
];

const LEDGER = {
  runId: 'run-7f3a',
  starts: [
    {
      at: '2026-08-03T00:00:00Z',
      event: 'run.start',
      phase: null,
      resumed: false,
      door: 'operator',
      trigger: null,
      guard: null,
      counter: null,
      by: 'operator',
      via: 'browser',
      origin: null,
      remoteUser: null,
      account: null,
      mode: null,
      said: 'Start the demo plan',
      reason: null,
    },
  ],
  sessions: [],
  rungs: [
    {
      at: '2026-08-03T00:26:00Z',
      phase: 1,
      rung: 'resume',
      driver: 'console',
      outcome: 'withdrawn',
      cause: 'never-ran',
      situation: 'crashed',
      costUsd: 0,
      note: null,
      by: 'drive',
    },
  ],
  totals: {
    sessions: 0,
    sessionsUsd: 0,
    turns: 0,
    ms: 0,
    unknownCost: 0,
    spentUsd: 4.25,
    gapUsd: null,
    reconciled: null,
    rungsUsd: 0,
    truncated: false,
  },
} as unknown as RunLedger;

const DETAIL = {
  summary: { slug: 'demo', title: 'demo plan', kind: 'plan', phases: 1, ready: [] },
  plan: { path: '/repo/docs/plans/demo.md' },
  phases: [
    {
      phase: 1,
      title: 'the api',
      state: 'stuck',
      size: 'M',
      weight: 40_000,
      gated: false,
      bullets: [],
      row: { phase: 1, title: 'the api', dependsOn: [], parallelSafe: '', repos: 'api', exitCriteria: '' },
    },
  ],
} as unknown as PlanDetail;

/** One datum the flat page showed, and what reaching it now costs. */
type Datum = {
  name: string;
  /** 0 on the glance, 1 behind its fold, 2 behind its fold and one more press. */
  presses: 0 | 1 | 2;
  /** The fold that holds it (its name, as the page draws it). */
  fold?: string;
  /** The second press, for a 2. */
  then?: (root: HTMLElement) => void;
  find: RegExp | string | ((root: HTMLElement) => boolean);
};

const LEDGER_OF_DATUMS: Datum[] = [
  // The glance: the strip, and the facts it does not carry.
  {
    name: 'the run’s word',
    presses: 0,
    find: (root) => Boolean(root.querySelector('[data-strip] [data-status]')),
  },
  {
    name: 'the plan it runs',
    presses: 0,
    find: (root) => root.querySelector('[data-testid="strip-name"]')?.textContent === 'demo',
  },
  {
    name: 'its one clock, labelled',
    presses: 0,
    find: (root) => /^halted /.test(root.querySelector('[data-testid="strip-clock"]')?.textContent ?? ''),
  },
  { name: 'the phase total beside it (#28)', presses: 0, find: /phase total worked 40m/ },
  {
    name: 'how far — done of total',
    presses: 0,
    find: (root) => Boolean(root.querySelector('[data-testid="strip-done"]')),
  },
  {
    name: 'what it cost',
    presses: 0,
    find: (root) => /\$4\.25/.test(root.querySelector('[data-testid="strip-cost"]')?.textContent ?? ''),
  },
  { name: 'the run id', presses: 0, find: 'run-7f3a' },
  {
    name: 'the run’s own clock',
    presses: 0,
    find: (root) => /^ran /.test(root.querySelector('[data-testid="run-clock"]')?.textContent ?? ''),
  },
  {
    name: 'the halt card when stopped',
    presses: 0,
    find: (root) => Boolean(root.querySelector('[data-halt-category]')),
  },
  {
    name: 'the verbs — continue, or its settings',
    presses: 0,
    find: (root) =>
      within(root).queryAllByRole('button', { name: /^(Settings|Continue this run|Start a run)$/ }).length >
      0,
  },
  { name: 'the Spent tile', presses: 0, find: /Spent/ },
  {
    name: 'the halt card names the tree its verdict ran against (#41)',
    presses: 0,
    find: (root) =>
      /on phased-execution · pe\/control-tower · 1d1911ee/.test(
        root.querySelector('[data-testid="halt-tree"]')?.textContent ?? '',
      ),
  },
  // One press: each fold.
  { name: 'every phase, in the table', presses: 1, fold: 'Phases', find: 'the api' },
  {
    name: 'a red verdict on its row, with the tree it judged (#41)',
    presses: 1,
    fold: 'Phases',
    find: (root) =>
      /on phased-execution · pe\/control-tower · 1d1911ee/.test(
        root.querySelector('[data-testid="verify-tree"]')?.textContent ?? '',
      ),
  },
  {
    name: 'the run’s console tab',
    presses: 1,
    fold: 'Sessions and their consoles',
    find: (root) => within(root).queryAllByRole('tab').length > 0,
  },
  {
    name: 'why it started',
    presses: 1,
    fold: 'Why it started and what it cost',
    find: /Start the demo plan/,
  },
  {
    name: 'the reconciliation',
    presses: 1,
    fold: 'Why it started and what it cost',
    find: (root) => Boolean(root.querySelector('[data-testid="ledger-reconcile"]')),
  },
  {
    name: 'the withdrawn rung (#16), as a badge',
    presses: 1,
    fold: 'Why it started and what it cost',
    find: (root) =>
      root.querySelector('[data-testid="ledger-outcome"]')?.getAttribute('data-status') === 'withdrawn',
  },
  { name: 'a pinned note', presses: 1, fold: 'Notes', find: 'Leave the cache alone.' },
  {
    name: 'the journal, every entry counted',
    presses: 1,
    fold: 'Journal',
    find: /What the runner did — 2 entries/,
  },
  {
    name: 'the journal’s own log',
    presses: 1,
    fold: 'Journal',
    find: (root) => within(root).queryAllByRole('log', { name: 'Run journal' }).length > 0,
  },
  { name: 'an earlier run', presses: 1, fold: 'Earlier runs of this plan', find: /run-earl/ },
  // Two presses: into a fold, then a record inside it — the phase's row.
  {
    name: 'the phase’s clocks, labelled — queued and to its first tool (#28)',
    presses: 2,
    fold: 'Phases',
    then: openPhaseRow,
    find: (root) =>
      Boolean(root.querySelector('[data-testid="phase-clocks"] [data-clock="queuedMs"]')) &&
      /first tool after 1m 30s/.test(
        root.querySelector('[data-clock="timeToFirstToolMs"]')?.textContent ?? '',
      ),
  },
  {
    name: 'every attempt’s window (#28)',
    presses: 2,
    fold: 'Phases',
    then: openPhaseRow,
    find: (root) => root.querySelectorAll('[data-testid="attempt-window"]').length === 2,
  },
  {
    name: 'the verdict in the row’s detail, with its tree (#41)',
    presses: 2,
    fold: 'Phases',
    then: openPhaseRow,
    find: (root) => root.querySelectorAll('[data-testid="verify-tree"]').length >= 2,
  },
];

/** The phase row's own expander — the second press. */
function openPhaseRow(root: HTMLElement) {
  const row = [...root.querySelectorAll('tr')].find(
    (tr) => tr.textContent?.includes('the api') && tr.querySelector('button[aria-expanded="false"]'),
  );
  const toggle = row?.querySelector('button[aria-expanded="false"]');
  if (toggle) fireEvent.click(toggle);
}

function mount() {
  const client = new QueryClient(queryClientConfig);
  return render(
    <QueryClientProvider client={client}>
      <View />
    </QueryClientProvider>,
  );
}

let View: () => React.ReactElement = () => <></>;

async function page(): Promise<HTMLElement> {
  const { default: RunView } = await import('@/features/runs/run-page');
  View = () => <RunView detail={DETAIL} />;
  const { container } = mount();
  await screen.findByTestId('run-head');
  await waitFor(() => expect(container.querySelector('[data-halt-category]')).not.toBeNull());
  return container;
}

function shows(root: HTMLElement, find: Datum['find']): boolean {
  if (typeof find === 'function') return find(root);
  const text = root.textContent ?? '';
  return typeof find === 'string' ? text.includes(find) : find.test(text);
}

function openFold(root: HTMLElement, name: string) {
  const section = root.querySelector(`section[aria-label="${name}"]`);
  const toggle = section?.querySelector('[data-testid="run-section-toggle"]');
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({ runSectionsOpen: [] });
  window.location.hash = '';
  state.mockResolvedValue(STATE);
  run.mockResolvedValue({ run: RUN, history: HISTORY, eta: null });
  runJournal.mockResolvedValue(JOURNAL);
  runTimeline.mockResolvedValue(null);
  runLedger.mockResolvedValue(LEDGER);
});

describe('the run page: every datum within two interactions (control-tower phase 24)', () => {
  it('opens on the glance: every 0-press datum is there with nothing pressed, and every fold is folded', async () => {
    const root = await page();
    const missing = LEDGER_OF_DATUMS.filter((d) => d.presses === 0 && !shows(root, d.find)).map(
      (d) => d.name,
    );
    expect(missing).toEqual([]);
    for (const toggle of root.querySelectorAll('[data-testid="run-section-toggle"]')) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    // Each fold names what it holds and, folded, how much — the raw record
    // alone is not a count of anything.
    const uncounted = [...root.querySelectorAll('section[data-section]')]
      .filter((section) => section.getAttribute('data-section') !== 'raw')
      .filter((section) => !section.querySelector('[data-testid="run-section-count"]'))
      .map((section) => section.getAttribute('aria-label'));
    expect(uncounted).toEqual([]);
  });

  it('reaches every 1-press datum by opening the one fold that names it', async () => {
    const root = await page();
    const missing: string[] = [];
    for (const datum of LEDGER_OF_DATUMS.filter((d) => d.presses === 1)) {
      openFold(root, datum.fold!);
      const section = root.querySelector(`section[aria-label="${datum.fold}"]`) as HTMLElement | null;
      if (!section) {
        missing.push(`${datum.name} (no fold named ${datum.fold})`);
        continue;
      }
      try {
        await waitFor(() => expect(shows(section, datum.find)).toBe(true), { timeout: 2000 });
      } catch {
        missing.push(datum.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('reaches every 2-press datum through its fold and one more press', async () => {
    const root = await page();
    const missing: string[] = [];
    for (const datum of LEDGER_OF_DATUMS.filter((d) => d.presses === 2)) {
      openFold(root, datum.fold!);
      const section = root.querySelector(`section[aria-label="${datum.fold}"]`) as HTMLElement;
      await waitFor(() => expect(section.textContent?.length).toBeGreaterThan(0));
      datum.then?.(section);
      try {
        await waitFor(() => expect(shows(section, datum.find)).toBe(true), { timeout: 2000 });
      } catch {
        missing.push(datum.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps a raw view: the record as the machine holds it, one press down', async () => {
    const root = await page();
    openFold(root, 'Raw record');
    const raw = await screen.findByTestId('run-raw');
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(RUN)));
  });
});
