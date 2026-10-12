/**
 * The sessions list's datum ledger (docs/design.md §1; control-tower phase 24,
 * and 7.0's list since quiet-console phase 15): every fact a 6.2 session row
 * carried is reached within TWO interactions, and the raw record is in the
 * Inspector.
 *
 * The list folds four shapes of process into one row — a lane the console
 * drives, a pty it owns, a `claude` it can only see — and the row is the
 * glance: its word (the phase's, the pty's `terminal` word, the registry's
 * presence), its name, what it works on, the summons and its kind, when it was
 * last heard. One press opens the row in place (its note, since when it has
 * waited, the columns Everything adds); two reach the Inspector (Inspect → the
 * shell's panel, `InspectorHost`), whose Raw tab is the record the row was
 * built from, whole. A fact that moves deeper than its press count — or goes —
 * fails its row by name.
 *
 * Since 7.0 a status is a dot and a WORD, never an icon (quiet-console phase
 * 4), and a summoned session keeps its own word with the summons' paint and
 * fact beside it: one mark, as a summoned run.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForeignSession, TerminalSession } from '@/data/api';

// A lane's tasks are read from its run once its row is opened; the ledger
// counts presses, not fetches, so the run answers nothing here.
vi.mock('@/data/runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/runs')>();
  return { ...actual, useRun: vi.fn(() => ({ data: undefined })) };
});

import { queryClientConfig } from '@/data/keys';
import type { NowLane } from '@/data/lanes';
import { setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { TooltipProvider } from '@/ui/tooltip';
import { SessionList } from './list';
import { foreignLabel, sessionRows, type SessionRow } from './model';

vi.setConfig({ testTimeout: 20_000 });

const NOW = Date.now();
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

const LANE = {
  key: 'run-1#3',
  slug: 'alpha',
  planTitle: 'Alpha',
  runId: 'run-1',
  phase: 3,
  title: 'Server B',
  status: 'running',
  runStatus: 'running',
  startedAt: at(12),
  costUsd: 1.25,
  attempts: 1,
  frozen: false,
  enriched: false,
} as unknown as NowLane;

const PTY = {
  id: 'pty-9',
  label: 'a shell',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 4242,
  clients: 1,
  createdAt: NOW - 30 * MIN,
  exited: { code: 1 },
  exitedAt: NOW - MIN,
} as unknown as TerminalSession;

const FOREIGN = {
  kind: 'foreign',
  sessionId: 'f-77',
  cwd: '/elsewhere',
  startedAt: at(40),
  lastSeen: at(1),
  turns: 3,
  presence: 'live',
  waiting: { since: at(2), kind: 'permission', note: 'Claude needs your permission' },
} as unknown as ForeignSession;

beforeEach(() => {
  localStorage.clear();
  setPrefs({ tables: {}, everything: {} });
  __resetInspectorForTests();
  // Whatever slips past the rows (a foreign session's hook events) answers empty.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});

afterEach(() => vi.unstubAllGlobals());

function mount(): SessionRow[] {
  const rows = sessionRows({ lanes: [LANE], terminals: [PTY], foreign: [FOREIGN], now: NOW });
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SessionList
          rows={rows}
          by="kind"
          everything={{ on: false, toggle: () => undefined }}
          sort="activity"
          onSort={() => undefined}
        />
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return rows;
}

const KEYS = { lane: 'lane:run-1#3', shell: 'pty:pty-9', foreign: 'foreign:f-77' } as const;
type Which = keyof typeof KEYS;

async function rowOf(which: Which): Promise<HTMLElement> {
  // The grid draws its rows once its engine has arrived.
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row = document.querySelector<HTMLElement>(`[data-session-row="${KEYS[which]}"]`);
    expect(row, `no ${which} row`).not.toBeNull();
  });
  return row!;
}

/** Press 1: open the row in place, and read what it opened. */
async function open(which: Which): Promise<HTMLElement> {
  const row = await rowOf(which);
  const toggle = within(row).getByRole('button', { name: /the rest of this row/ });
  fireEvent.click(toggle);
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!panel) throw new Error(`opening the ${which} row drew nothing`);
  return panel;
}

/** Press 2: Inspect, from the opened row — and the panel it drew. */
function inspect(opened: HTMLElement): HTMLElement {
  fireEvent.click(within(opened).getByRole('button', { name: 'Inspect' }));
  const panel = document.querySelector<HTMLElement>('[data-inspector]');
  if (!panel) throw new Error('Inspect drew nothing in the panel');
  return panel;
}

/** The 6.2 row's facts, each with the most presses the list may make a person spend on it. */
type Datum = { name: string; row: Which; presses: 0 | 1 | 2; find: string | RegExp };

const LEDGER: Datum[] = [
  // The glance.
  { name: 'the lane’s name', row: 'lane', presses: 0, find: 'Alpha P3' },
  { name: 'what the lane works on', row: 'lane', presses: 0, find: 'Server B' },
  { name: 'the shell’s name', row: 'shell', presses: 0, find: 'a shell' },
  { name: 'the shell’s directory', row: 'shell', presses: 0, find: '/repo' },
  { name: 'the shell’s clock', row: 'shell', presses: 0, find: /1 minute ago|a minute ago|1m ago/ },
  { name: 'the other session’s name', row: 'foreign', presses: 0, find: foreignLabel(FOREIGN) },
  { name: 'the summons and its kind', row: 'foreign', presses: 0, find: 'needs your permission' },
  // One press: the row opened in place.
  { name: 'the shell’s note', row: 'shell', presses: 1, find: 'ended' },
  { name: 'when the shell began', row: 'shell', presses: 1, find: /30 minutes ago/ },
  { name: 'the shell’s terminal id', row: 'shell', presses: 1, find: 'pty-9' },
  { name: 'since when it has waited', row: 'foreign', presses: 1, find: /It needs your permission since/ },
  { name: 'the other session’s conversation', row: 'foreign', presses: 1, find: 'f-77' },
  { name: 'the lane’s verbs', row: 'lane', presses: 1, find: 'Open the run' },
  // Two presses: the Inspector.
  { name: 'what the shell is', row: 'shell', presses: 2, find: 'What it is' },
  { name: 'the shell’s standing, in words', row: 'shell', presses: 2, find: 'Exited with an error' },
  { name: 'the shell’s clocks', row: 'shell', presses: 2, find: 'Clocks' },
];

const shows = (root: HTMLElement, datum: Datum): boolean => {
  const text = root.textContent ?? '';
  return typeof datum.find === 'string' ? text.includes(datum.find) : datum.find.test(text);
};

describe('the sessions list: every datum within two interactions (control-tower phase 24, 7.0)', () => {
  it('the glance: each row’s word is the typed family’s — a dot and a word, never a bare dot', async () => {
    mount();
    await rowOf('shell');
    const marks = [...document.querySelectorAll<HTMLElement>('[data-session-row] [data-status][data-vocab]')];
    expect(marks.map((mark) => `${mark.dataset.vocab}:${mark.dataset.status}`)).toEqual(
      expect.arrayContaining(['phase:running', 'terminal:failed', 'presence:live']),
    );
    for (const mark of marks) expect(mark.textContent?.trim(), mark.dataset.status).toBeTruthy();
    // The summons rides the session's OWN word: one mark, painted, with its fact.
    const summoned = (await rowOf('foreign')).querySelector<HTMLElement>('[data-status][data-vocab]')!;
    expect(summoned).toHaveAttribute('data-attention', 'needs-you');
    expect(summoned).toHaveTextContent('Live');
    expect(summoned).toHaveTextContent('needs your permission');
  });

  it('nothing at the glance is deeper than the glance', async () => {
    mount();
    const missing: string[] = [];
    for (const datum of LEDGER.filter((d) => d.presses === 0)) {
      if (!shows(await rowOf(datum.row), datum)) missing.push(datum.name);
    }
    expect(missing).toEqual([]);
  });

  it('one press — the row opened in place — reaches every fact the 6.2 row and its menu carried', async () => {
    mount();
    const missing: string[] = [];
    for (const which of ['lane', 'shell', 'foreign'] as const) {
      const opened = await open(which);
      expect(within(opened).getByTestId('session-row-detail')).toBeInTheDocument();
      for (const datum of LEDGER.filter((d) => d.presses === 1 && d.row === which)) {
        if (!shows(opened, datum)) missing.push(datum.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('two presses reach the Inspector’s facts, and its Raw tab is the row’s record whole', async () => {
    const rows = mount();
    const opened = await open('shell');
    const inspector = inspect(opened);
    const missing = LEDGER.filter((d) => d.presses === 2 && !shows(inspector, d)).map((d) => d.name);
    expect(missing).toEqual([]);
    // The inspected row says so, for a pointer and a reader alike.
    expect(within(opened).getByRole('button', { name: 'Inspect' })).toHaveAttribute('aria-pressed', 'true');

    const raw = within(inspector).getByRole('tab', { name: 'Raw' });
    fireEvent.mouseDown(raw);
    fireEvent.click(raw);
    const pre = within(inspector).getByText(/"pid": 4242/);
    const record = rows.find((row) => row.kind === 'shell')!.record;
    expect(JSON.parse(pre.textContent ?? '')).toEqual(JSON.parse(JSON.stringify(record)));
  });

  it('a session the hook reported is inspected with its hook events, one tab over', async () => {
    mount();
    const inspector = inspect(await open('foreign'));
    expect(within(inspector).getByRole('tab', { name: 'History' })).toBeInTheDocument();
    expect(inspector).toHaveTextContent('needs your permission');
  });
});
