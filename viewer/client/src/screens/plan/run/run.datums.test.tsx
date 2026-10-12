/**
 * Every datum the 6.2 run page showed is reached within two interactions on
 * 7.0's Run view, with a raw view (control-tower phase 24's ledger, carried by
 * quiet-console phase 11; design.md principle 3).
 *
 * The rows are the 6.2 ledger's, every one kept; what moved is the door. The
 * glance (0 presses) is the run's row as the view's head, the facts under it,
 * the halt card and the verbs; a fold (1 press) names what it holds; a record
 * inside a fold is a second press. Three rows changed door in 7.0 and say so:
 * the withdrawn rung lives in the fold that is about the ladder, the earlier
 * runs are the History reading — one press, a link — and the run's own
 * console is the first pane the sessions fold names, a link (`?lane=run`)
 * where 6.2 drew a tab. Every section is 7.0's own: no door is left.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, JournalEntry, PlanDetail, RunLedger, RunState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { setPrefs } from '@/lib/prefs';
import { TooltipProvider } from '@/ui/tooltip';
import RunView from './index';

vi.setConfig({ testTimeout: 30_000 });

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

const TRIGGERS = [
  {
    id: 't1',
    slug: 'demo',
    when: 'phase-done:1',
    verb: 'resume',
    body: {},
    mode: 'once',
    expiresAt: '2026-08-10T00:00:00Z',
    note: 'carry on once the api lands',
    armedAt: '2026-08-03T00:10:00Z',
    armedBy: { by: 'operator' },
    state: 'armed',
    firings: [],
  },
];

/** The plan's two verification ledgers (quiet-console phase 25's routes). */
const PROOFS = {
  slug: 'demo',
  phase: null,
  proofs: [
    {
      phase: 1,
      command: 'npm test',
      code: 0,
      tree: '1d1911ee4c7a9b8c7d6e5f4a3b2c1d0e9f8a7b6c',
      head: '1d1911ee4c7a',
      at: '2026-08-03T00:50:00Z',
      session: 's-1',
    },
  ],
};

const VERIFICATIONS = {
  slug: 'demo',
  rows: [
    {
      phase: 1,
      run: 'run-7f3a',
      at: '2026-08-03T01:00:00Z',
      kind: 'verify',
      command: 'npm test',
      code: 1,
      ms: 12_000,
      ok: false,
      failures: ['api › saves'],
      own: ['api › saves'],
    },
    {
      phase: 1,
      run: 'run-7f3a',
      at: '2026-08-03T00:05:00Z',
      kind: 'baseline',
      command: 'npm test',
      code: 0,
      ms: 11_000,
      ok: true,
    },
  ],
  total: 2,
  limit: 200,
};

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

/** What the console answers, by path — every read the view and its doors make. */
function answerFor(path: string): unknown {
  const at = path.replace(/^https?:\/\/[^/]+/, '');
  if (/^\/api\/run\/demo$/.test(at)) return { run: RUN, history: HISTORY, eta: null };
  if (/^\/api\/run\/demo\/journal/.test(at)) return JOURNAL;
  if (/^\/api\/run\/demo\/timeline/.test(at)) return null;
  if (/^\/api\/run\/demo\/ledger/.test(at)) return LEDGER;
  if (/^\/api\/run\/demo\/rulings/.test(at)) return { rulings: [] };
  if (/^\/api\/run\/demo\/scopes/.test(at)) return { scopes: [] };
  if (/^\/api\/run\/demo\/triggers/.test(at)) return { triggers: TRIGGERS };
  if (/^\/api\/run\/demo\/proofs/.test(at)) return PROOFS;
  if (/^\/api\/run\/demo\/verifications/.test(at)) return VERIFICATIONS;
  if (/^\/api\/run\/demo\/transcript/.test(at)) return [];
  if (/^\/api\/run\/demo\/messages/.test(at)) return { messages: [] };
  if (/^\/api\/run\/demo\/issues/.test(at)) return { drafts: [] };
  if (/^\/api\/run\/demo\/phase\/\d+\/activity/.test(at)) return { events: [], untrusted: true, live: false };
  if (/^\/api\/run\/demo\/phase\/\d+\/report/.test(at)) return { live: false };
  // The phase row's prose reads the plan with the inspector's include set.
  if (/^\/api\/plans\/demo(\?|$)/.test(at)) return DETAIL;
  if (/^\/api\/queue$/.test(at))
    return { max: 3, live: 0, queued: 0, throttledUntil: null, grants: [], entries: [] };
  if (/^\/api\/approvals$/.test(at)) return [];
  if (/^\/api\/auth/.test(at)) return { loggedIn: true, checkedAt: '2026-08-03T00:00:00Z' };
  if (/^\/api\/accounts/.test(at)) return { accounts: [], allowAccounts: false };
  if (/^\/api\/inbox/.test(at)) return { items: [], generatedAt: '2026-08-03T01:00:00Z' };
  if (/^\/api\/runs\?view=slim$/.test(at)) return [];
  if (/^\/api\/(sessions|terminals)/.test(at)) return { sessions: [] };
  if (/^\/api\/state$/.test(at)) return STATE;
  return {};
}

beforeEach(() => {
  setPrefs({ runSectionsOpen: [] });
  window.location.hash = '#/plan/demo/run';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(answerFor(path)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function mount(view?: string) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), STATE);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RunView detail={DETAIL} view={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** One datum the 6.2 page showed, and what reaching it costs now. */
type Datum = {
  name: string;
  /** 0 on the glance, 1 behind its fold, 2 behind its fold and one more press. */
  presses: 0 | 1 | 2;
  /** The fold that holds it, by the name the view draws. */
  fold?: string;
  /** The second press, for a 2. */
  then?: (root: HTMLElement) => void;
  find: RegExp | string | ((root: HTMLElement) => boolean);
};

const LEDGER_OF_DATUMS: Datum[] = [
  // The glance: the run's row as the head, and the facts it does not carry.
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
  // 6.2's Spent tile: 7.0 draws no tiles, and says the figure in words.
  {
    name: 'the Spent tile',
    presses: 0,
    find: (root) => /^Spent \$4\.25/.test(root.querySelector('[data-testid="run-spent"]')?.textContent ?? ''),
  },
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
  // 7.0: the panes are named in the address — the run's own console is a link.
  {
    name: 'the run’s console tab',
    presses: 1,
    fold: 'Sessions and their consoles',
    find: (root) =>
      within(root)
        .queryAllByRole('link', { name: /^Run\b/ })
        .some((link) => link.getAttribute('href') === '#/plan/demo/run?lane=run'),
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
  // 7.0: the ladder's rungs are a fold of their own.
  {
    name: 'the withdrawn rung (#16), as a badge',
    presses: 1,
    fold: 'What the ladder tried',
    find: (root) =>
      root.querySelector('[data-testid="rung-outcome"]')?.getAttribute('data-status') === 'withdrawn',
  },
  { name: 'a pinned note', presses: 1, fold: 'Notes', find: 'Leave the cache alone.' },
  {
    name: 'the journal, every entry counted',
    presses: 1,
    fold: 'Journal',
    find: (root) => root.querySelector('[data-testid="journal-count"]')?.textContent === '2 entries',
  },
  {
    name: 'the journal’s own log',
    presses: 1,
    fold: 'Journal',
    find: (root) => within(root).queryAllByRole('log', { name: 'Run journal' }).length > 0,
  },
  // 7.0: the plan's stored triggers (control-tower phase 98), which 6.2 never drew.
  { name: 'a stored trigger, armed', presses: 1, fold: 'Triggers', find: /carry on once the api lands/ },
  // 7.0: the plan's two verification ledgers (quiet-console phase 26), which 6.2 never drew.
  {
    name: 'what a session proved — its exit as a word, the tree it ran against',
    presses: 1,
    fold: 'Verification',
    find: (root) => {
      const proof = root.querySelector('[data-testid="verification-proof"]');
      return (
        proof?.querySelector('[data-status]')?.getAttribute('data-status') === 'green' &&
        /tree 1d1911ee/.test(proof.textContent ?? '')
      );
    },
  },
  {
    name: 'the console’s verdict ledger, and the baseline its lines read at boarding',
    presses: 1,
    fold: 'Verification',
    find: (root) =>
      Boolean(
        root.querySelector('[data-testid="verification-run"][data-kind="verify"][data-word="red"]') &&
        root.querySelector('[data-testid="verification-run"][data-kind="baseline"][data-word="green"]'),
      ),
  },
  {
    name: 'the reds a phase still owes',
    presses: 1,
    fold: 'Verification',
    find: (root) =>
      /1 failing test: api › saves/.test(
        root.querySelector('[data-testid="verification-owed"]')?.textContent ?? '',
      ),
  },
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

async function page(): Promise<HTMLElement> {
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

describe('the Run view: every 6.2 datum within two interactions (quiet-console phase 11)', () => {
  it('opens on the glance: every 0-press datum is there with nothing pressed, and every fold is folded', async () => {
    const root = await page();
    await waitFor(() => {
      const missing = LEDGER_OF_DATUMS.filter((d) => d.presses === 0 && !shows(root, d.find)).map(
        (d) => d.name,
      );
      expect(missing).toEqual([]);
    });
    for (const toggle of root.querySelectorAll('[data-testid="run-section-toggle"]')) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    // Each fold names what it holds and, folded, how much — the raw record
    // alone is not a count of anything.
    await waitFor(() => {
      const uncounted = [...root.querySelectorAll('section[data-section]')]
        .filter((section) => section.getAttribute('data-section') !== 'raw')
        .filter((section) => !section.querySelector('[data-testid="run-section-count"]'))
        .map((section) => section.getAttribute('aria-label'));
      expect(uncounted).toEqual([]);
    });
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
        await waitFor(() => expect(shows(section, datum.find)).toBe(true), { timeout: 4000 });
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
        await waitFor(() => expect(shows(section, datum.find)).toBe(true), { timeout: 4000 });
      } catch {
        missing.push(datum.name);
      }
    }
    expect(missing).toEqual([]);
  });

  // 6.2's "Earlier runs of this plan" fold is 7.0's History reading: one press, a link.
  it('reaches an earlier run in one press — the History reading, a real link', async () => {
    const root = await page();
    const link = within(root).getByRole('link', { name: /^History/ });
    expect(link).toHaveAttribute('href', '#/plan/demo/run?view=history');
    const { container } = mount('history');
    await waitFor(() => expect(container.textContent).toMatch(/run-earl/));
  });

  it('keeps a raw view: the record as the machine holds it, one press down', async () => {
    const root = await page();
    openFold(root, 'Raw record');
    const raw = await screen.findByTestId('run-raw');
    expect(JSON.parse(raw.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(RUN)));
  });
});
