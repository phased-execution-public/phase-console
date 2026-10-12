/**
 * The sessions as a list (7.0, quiet-console phase 15) — one kit `Grid` per
 * kind, or one for the whole list, mounted over a client of the app's own
 * config, beside the shell's panel host so Inspect has somewhere to draw.
 *
 * What is pinned:
 *
 *  - **a section per kind, and no heading over nothing.** Four headings over
 *    one shell is a page that looks broken on the console most people run.
 *    Ungrouped, it is one grid, and the kind comes up from Everything onto the
 *    glance, because no heading says it any more;
 *  - **the row says what it is** on the row itself — its kind, whether it
 *    lives, whether it waits on you — and its status is ONE mark: its own
 *    word, with a summons' paint and the fact "needs your permission" beside
 *    it, never a second badge;
 *  - **a row goes where the session lives, and opens in place onto its
 *    verbs**: a lane onto its run (and Your turn while it waits on you) and the
 *    tasks of its WHOLE record, read only once it is opened (#234); a pty onto
 *    its terminal and its controls — the only rows that have any; a foreign
 *    session onto its own page, without losing its link to the phase;
 *  - **the clocks**: every row says when it was last heard; only a live one
 *    says how long it has run;
 *  - the list's half of REG-9: an inferred end reads differently from a
 *    reported one on the rows — and on the session's own page, which has no
 *    test file of its own (`foreign.tsx`).
 *
 * The fold behind the rows is `model.test.ts`'s. ⚠️ Rows are counted in a
 * rendering here only because the list is not virtualized: a grid that asks
 * for `virtual` draws a window, and jsdom measures every window 0 tall.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForeignSession, TerminalSession } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import type { NowLane } from '@/data/lanes';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { TooltipProvider } from '@/ui/tooltip';
import { ForeignSessionPage } from './foreign';
import { SessionList, sessionColumns, type SessionListProps } from './list';
import { SORTS, isSortId, sessionRows, type SessionRow } from './model';

vi.setConfig({ testTimeout: 20_000 });

/**
 * The real clock, read afresh for every case: the rows say "2 minutes ago"
 * against `Date.now()` as they render, so a fixture dated at import would drift
 * a minute on a slow run.
 */
let NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const pty = (over: Partial<TerminalSession> & { id: string }): TerminalSession => ({
  label: over.id,
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 1,
  clients: 1,
  createdAt: NOW - 60_000,
  ...over,
});

const lane = (over: Partial<NowLane> & { phase: number }): NowLane => ({
  key: `run-1#${over.phase}`,
  slug: 'alpha',
  planTitle: 'Alpha',
  runId: 'run-1',
  status: 'running',
  runStatus: 'running',
  costUsd: 0,
  attempts: 1,
  frozen: false,
  enriched: false,
  ...over,
});

const foreign = (over: Partial<ForeignSession> & { sessionId: string }): ForeignSession => ({
  kind: 'foreign',
  cwd: '/elsewhere',
  startedAt: at(30),
  lastSeen: at(1),
  turns: 3,
  presence: 'live',
  ...over,
});

const ESSENTIALS = { on: false, toggle: () => {} };
const EVERYTHING = { on: true, toggle: () => {} };

let client: QueryClient;
/** Every read the list made — a glance reads nothing of its own. */
let sent: string[] = [];
/** What `GET /api/run/alpha` answers, when a test lets it be asked. */
let runAnswer: unknown = {};

beforeEach(() => {
  NOW = Date.now();
  localStorage.clear();
  __resetInspectorForTests();
  sent = [];
  runAnswer = {};
  client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      sent.push(url);
      return new Response(JSON.stringify(/\/api\/run\/alpha$/.test(url) ? runAnswer : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** The list as the page mounts it — grouped by kind, at the glance, in the default order. */
function mount(rows: readonly SessionRow[], over: Partial<SessionListProps> = {}) {
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SessionList
          rows={rows}
          by="kind"
          everything={ESSENTIALS}
          sort="activity"
          onSort={() => {}}
          {...over}
        />
        <InspectorHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (key: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-session-row="${key}"]`);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
};
const listedKeys = () =>
  [...document.querySelectorAll('[data-session-row]')].map((el) => el.getAttribute('data-session-row'));

/** Open a row in place, and read what it opened onto: the folded facts and the row's own detail. */
async function open(key: string): Promise<HTMLElement> {
  const row = await waitFor(() => rowOf(key));
  const toggle = within(row).getByRole('button', { name: /the rest of this row/ });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!panel) throw new Error(`${key} opened onto nothing`);
  expect(within(panel).getByTestId('session-row-detail')).toBeInTheDocument();
  return panel;
}

describe('the columns', () => {
  it('draws four facts at the glance, the kind among them once no heading says it, and the rest under Everything', () => {
    const glance = (by: 'kind' | 'none') =>
      sessionColumns(by)
        .filter((column) => !column.everything)
        .map((column) => column.id);
    expect(glance('kind')).toEqual(['status', 'session', 'detail', 'heard']);
    expect(glance('none')).toEqual(['status', 'session', 'detail', 'heard', 'kind']);
    expect(
      sessionColumns('kind')
        .filter((column) => column.everything)
        .map((column) => column.id),
    ).toEqual(['kind', 'note', 'began', 'for', 'terminal', 'conversation', 'tasks']);
    // The name is the row's identity: never folded, the holder of its link and its toggle.
    expect(sessionColumns('kind').find((column) => column.identity)?.id).toBe('session');
  });

  it('offers in its heads exactly the orders the toolbar offers', () => {
    const orders = sessionColumns('none').flatMap((column) => (column.sort ? [column.sort.id] : []));
    expect(orders.every(isSortId)).toBe(true);
    expect([...orders].sort()).toEqual(SORTS.map((s) => s.id).sort());
  });
});

describe('<SessionList>', () => {
  const twoKinds = () =>
    sessionRows({
      terminals: [pty({ id: 's1', label: 'Terminal 1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      now: NOW,
    });

  it('groups by kind, and renders no heading for a kind with nothing in it', async () => {
    mount(twoKinds());
    const shells = await screen.findByRole('region', { name: /^Shells/ });
    expect(screen.getByRole('region', { name: /^Autopilot lanes/ })).toBeInTheDocument();
    // Four headings over one shell is a page that looks broken on the console
    // most people run.
    expect(screen.queryByRole('region', { name: /^Agent sessions/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Other sessions/ })).toBeNull();
    // In the kinds' order, each its own grid, the heading counting what it holds.
    expect(
      [...document.querySelectorAll('section[data-group]')].map((s) => s.getAttribute('data-group')),
    ).toEqual(['lane', 'shell']);
    expect(within(shells).getByRole('table', { name: 'Shells' })).toBeInTheDocument();
    expect(within(shells).getByRole('heading', { name: /^Shells/ })).toHaveTextContent(/^Shells\s*1$/);
    // The heading says the kind, so the Kind column waits under Everything.
    expect(screen.queryByRole('columnheader', { name: /^Kind/ })).toBeNull();
  });

  it('draws one grid when ungrouped, and moves the kind word onto the row', async () => {
    mount(twoKinds(), { by: 'none' });
    const table = await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.queryByRole('region')).toBeNull();
    // The heading is gone, so the row says what it is.
    expect(within(table).getByRole('columnheader', { name: /^Kind/ })).toBeInTheDocument();
    expect(within(rowOf('pty:s1')).getByRole('cell', { name: 'Shells' })).toBeInTheDocument();
    expect(within(rowOf('lane:run-1#3')).getByRole('cell', { name: 'Autopilot lanes' })).toBeInTheDocument();
  });

  it('renders its own empty state rather than four blank headings', () => {
    mount([], { empty: <p>Nothing is running</p> });
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('carries what a row is on the row itself, and links it to where the session lives', async () => {
    mount(
      sessionRows({
        lanes: [lane({ phase: 1 })],
        terminals: [pty({ id: 'gone', exited: { code: 0 }, exitedAt: NOW - 120_000 })],
        foreign: [foreign({ sessionId: 'asking', waiting: { since: at(2), kind: 'permission' } })],
        now: NOW,
      }),
      { by: 'none' },
    );
    // One list, in the order it was handed: the summoned row first.
    await waitFor(() => expect(listedKeys()).toEqual(['foreign:asking', 'lane:run-1#1', 'pty:gone']));
    const live = rowOf('lane:run-1#1');
    expect(live).toHaveAttribute('data-kind', 'lane');
    expect(live).toHaveAttribute('data-live', '');
    expect(live).not.toHaveAttribute('data-attention');
    expect(within(live).getByRole('link', { name: 'Alpha P1' })).toHaveAttribute('href', '#/plan/alpha/run');
    const gone = rowOf('pty:gone');
    expect(gone).toHaveAttribute('data-kind', 'shell');
    expect(gone).not.toHaveAttribute('data-live');
    expect(within(gone).getByRole('link', { name: 'gone' })).toHaveAttribute('href', '#/sessions/gone');
    expect(rowOf('foreign:asking')).toHaveAttribute('data-attention', 'needs-you');
  });

  it('marks a summoned row with ONE status: its own word, the summons’ paint, and what it needs', async () => {
    mount(
      sessionRows({
        lanes: [lane({ phase: 2 })],
        foreign: [
          foreign({ sessionId: 'asking', waiting: { since: at(2), kind: 'input' } }),
          foreign({ sessionId: 'quiet' }),
        ],
        approvals: [{ status: 'pending', runId: 'run-1', phase: 2, createdAt: at(1) }],
        now: NOW,
      }),
    );
    const markOf = (key: string): HTMLElement => {
      const marks = rowOf(key).querySelectorAll<HTMLElement>('[data-status]');
      // One mark, not two: the summons rides beside the word, never as a badge of its own.
      expect(marks).toHaveLength(1);
      return marks[0]!;
    };
    await waitFor(() => expect(listedKeys()).toHaveLength(3));

    // A lane a pending approval names: still Running, in the summons' paint.
    const approving = markOf('lane:run-1#2');
    expect(approving).toHaveAttribute('data-vocab', 'phase');
    expect(approving).toHaveAttribute('data-status', 'running');
    expect(approving).toHaveAttribute('data-attention', 'needs-you');
    expect(approving).toHaveAttribute('data-paint', 'needs-you');
    expect(approving).toHaveTextContent('Running');
    expect(approving).toHaveTextContent('needs your permission');

    const asking = markOf('foreign:asking');
    expect(asking).toHaveAttribute('data-vocab', 'presence');
    expect(asking).toHaveAttribute('data-status', 'live');
    expect(asking).toHaveAttribute('data-attention', 'needs-you');
    expect(asking).toHaveTextContent('Live');
    expect(asking).toHaveTextContent('needs your answer');

    // The merely live keep their own paint, and ask for nothing.
    const quiet = markOf('foreign:quiet');
    expect(quiet).toHaveAttribute('data-attention', 'none');
    expect(quiet).toHaveAttribute('data-paint', 'running');
    expect(quiet).not.toHaveTextContent(/needs/);
  });

  it('opens a lane onto its run, and onto Your turn while it waits on you', async () => {
    mount(
      sessionRows({
        lanes: [lane({ phase: 1 }), lane({ phase: 2 })],
        approvals: [{ status: 'pending', runId: 'run-1', phase: 2, createdAt: at(1) }],
        now: NOW,
      }),
    );
    const asking = await open('lane:run-1#2');
    expect(within(asking).getByRole('link', { name: 'Open the run' })).toHaveAttribute(
      'href',
      '#/plan/alpha/run',
    );
    expect(within(asking).getByRole('link', { name: 'Answer on Your turn' })).toHaveAttribute(
      'href',
      '#/turn',
    );
    expect(asking).toHaveTextContent('It needs your permission since 1 minute ago.');
    // A lane has no pty here for a control to act on.
    expect(within(asking).queryByTestId('session-controls')).toBeNull();

    const plain = await open('lane:run-1#1');
    expect(within(plain).getByRole('link', { name: 'Open the run' })).toBeInTheDocument();
    expect(within(plain).queryByRole('link', { name: 'Answer on Your turn' })).toBeNull();
  });

  it("reads a lane's tasks from its whole record, and only once the row is opened (#234)", async () => {
    runAnswer = {
      run: {
        id: 'run-1',
        slug: 'alpha',
        phases: {
          '3': {
            phase: 3,
            status: 'running',
            tasks: [
              { id: 't1', content: 'Read the plan', status: 'completed' },
              {
                id: 't2',
                content: 'Wire the runner',
                activeForm: 'Wiring the runner',
                status: 'in_progress',
              },
            ],
          },
        },
      },
    };
    // A slim lane — what the list folds from — carries no tasks of its own.
    mount(sessionRows({ lanes: [lane({ phase: 3, slim: true })], now: NOW }));
    await waitFor(() => expect(listedKeys()).toEqual(['lane:run-1#3']));
    expect(sent.filter((url) => url.includes('/api/run/'))).toEqual([]);

    const opened = await open('lane:run-1#3');
    const tasks = await within(opened).findByTestId('session-tasks');
    expect(within(tasks).getByText('Read the plan')).toBeInTheDocument();
    expect(within(tasks).getByText('Wiring the runner')).toBeInTheDocument();
    expect(sent.filter((url) => url.includes('/api/run/'))).toEqual(['/api/run/alpha']);
  });

  it("never draws another run's tasks under a lane", async () => {
    // The plan's record has moved on to a newer run: its phase 3 is not this lane's.
    client.setQueryData(keys.run('alpha'), {
      run: {
        id: 'run-0',
        slug: 'alpha',
        phases: {
          '3': { phase: 3, status: 'done', tasks: [{ id: 't1', content: 'Old work', status: 'completed' }] },
        },
      },
    });
    mount(sessionRows({ lanes: [lane({ phase: 3, slim: true })], now: NOW }));
    const opened = await open('lane:run-1#3');
    expect(within(opened).queryByTestId('session-tasks')).toBeNull();
    expect(within(opened).queryByText('Old work')).toBeNull();
  });

  it('opens a pty onto its terminal and its controls — the only rows that have any', async () => {
    // 6.2 offered Close on the row; 7.0 keeps Close in the panel's Actions,
    // behind its confirm, and an opened row offers Freeze and Stop. The promise
    // is the same: a verb only where this console owns the process.
    mount(
      sessionRows({
        terminals: [
          pty({ id: 's1', label: 'Terminal 1' }),
          pty({ id: 'gone', createdAt: NOW - 600_000, exited: { code: 0 }, exitedAt: NOW - 60_000 }),
        ],
        lanes: [lane({ phase: 3 })],
        foreign: [foreign({ sessionId: 'f1' })],
        now: NOW,
      }),
    );
    const shell = await open('pty:s1');
    expect(within(shell).getByRole('link', { name: 'Open the terminal' })).toHaveAttribute(
      'href',
      '#/sessions/s1',
    );
    const controls = within(shell).getByTestId('session-controls');
    expect(controls).toHaveAccessibleName('Terminal 1 session controls');
    expect(within(controls).getByRole('button', { name: 'Freeze' })).toBeEnabled();
    expect(within(controls).getByRole('button', { name: 'Stop' })).toBeEnabled();
    // What the glance folded is one press away, under its own head: no datum removed.
    expect(within(shell).getByText('Terminal')).toBeInTheDocument();

    // An ended pty still opens onto its record — its resume lives there — and has nothing to freeze or stop.
    const ended = await open('pty:gone');
    expect(within(ended).getByRole('link', { name: 'Open the terminal' })).toHaveAttribute(
      'href',
      '#/sessions/gone',
    );
    expect(within(ended).queryByTestId('session-controls')).toBeNull();

    // A lane and a foreign session have no pty here; a control beside them would answer 404.
    expect(within(await open('lane:run-1#3')).queryByTestId('session-controls')).toBeNull();
    expect(within(await open('foreign:f1')).queryByTestId('session-controls')).toBeNull();
  });

  it('gives a foreign row a way IN without taking its link to the phase', async () => {
    // Two destinations, deliberately: the row goes where the session BELONGS
    // (its phase), the opened row also to the session itself — which is the
    // page that can resume it. Collapsing them would cost one of the two.
    mount(
      sessionRows({
        foreign: [
          foreign({ sessionId: 'f1', plan: { slug: 'beta', phase: 2, strong: true } }),
          foreign({ sessionId: 'f2', owner: 'someone' }),
        ],
        now: NOW,
      }),
    );
    await waitFor(() =>
      expect(within(rowOf('foreign:f1')).getByRole('link', { name: 'beta P2' })).toHaveAttribute(
        'href',
        '#/plan/beta/phase/2',
      ),
    );
    const correlated = await open('foreign:f1');
    expect(within(correlated).getByRole('link', { name: 'Open the session' })).toHaveAttribute(
      'href',
      '#/sessions/f1',
    );
    expect(within(correlated).getByRole('link', { name: 'Open its phase' })).toHaveAttribute(
      'href',
      '#/plan/beta/phase/2',
    );

    // An uncorrelated row already goes to its own page: one way in, never the same one twice.
    const loose = await open('foreign:f2');
    expect(within(loose).getByRole('link', { name: 'Open the session' })).toHaveAttribute(
      'href',
      '#/sessions/f2',
    );
    expect(within(loose).queryByRole('link', { name: 'Open its phase' })).toBeNull();
  });

  it('marks the row the panel shows, and shows it there', async () => {
    // 6.2 marked the session open beside the list (`activeId`). 7.0 draws no
    // list beside a terminal — the session page switches through its own menu —
    // so the mark the list owes is the row the panel is showing.
    mount(
      sessionRows({
        terminals: [pty({ id: 's1', label: 'Terminal 1' }), pty({ id: 's2', label: 'Terminal 2' })],
        now: NOW,
      }),
    );
    const first = await open('pty:s1');
    const inspect = within(first).getByRole('button', { name: 'Inspect' });
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(inspect);
    await waitFor(() => expect(inspect).toHaveAttribute('aria-pressed', 'true'));
    expect(document.querySelector('[data-inspector]')).toHaveAttribute('aria-label', 'Terminal 1');
    const second = await open('pty:s2');
    expect(within(second).getByRole('button', { name: 'Inspect' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers its orders in the column heads, and marks the one in force', async () => {
    const onSort = vi.fn();
    mount(twoKinds(), { by: 'none', sort: 'activity', onSort });
    const heard = await screen.findByRole('columnheader', { name: /^Last heard/ });
    expect(heard).toHaveAttribute('aria-sort', 'descending');
    const kind = screen.getByRole('columnheader', { name: /^Kind/ });
    expect(kind).toHaveAttribute('aria-sort', 'none');
    fireEvent.click(within(kind).getByRole('button', { name: 'Kind' }));
    expect(onSort).toHaveBeenCalledWith('kind');
  });
});

describe('the clocks on the rows', () => {
  it('says when every row was last heard, and only a live one how long it has run', async () => {
    mount(
      sessionRows({
        lanes: [lane({ phase: 1, startedAt: new Date(NOW - 60_000).toISOString() })],
        terminals: [
          pty({ id: 't1', createdAt: NOW - 600_000, exited: { code: 0 }, exitedAt: NOW - 120_000 }),
        ],
        now: NOW,
      }),
      { everything: EVERYTHING },
    );
    const live = await waitFor(() => rowOf('lane:run-1#1'));
    const dead = rowOf('pty:t1');
    // 6.2's live row carried one ticking DURATION as its clock. 7.0's first
    // clock is "Last heard", an INSTANT on every row, live or not…
    for (const row of [live, dead]) {
      expect(row.querySelector('time')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(dead).toHaveTextContent('2 minutes ago');
    // …and the duration that grows is "Running for", on a live row only.
    expect(live.querySelector('time[datetime^="PT"]')).not.toBeNull();
    expect(dead.querySelector('time[datetime^="PT"]')).toBeNull();
  });
});

/**
 * ACC-7.7 (REG-9) — see `model.test.ts` for the incident. The fold notes an
 * inferred end as one; these are the two places a person reads it.
 */
describe('inferred ends and unknown turns (REG-9)', () => {
  const reported = () =>
    foreign({
      sessionId: 'f-reported',
      presence: 'ended',
      endedAt: at(5),
      endedBy: 'hook',
      turns: 12,
      turnsSource: 'hook',
    });
  const inferred = () =>
    foreign({
      sessionId: 'f-inferred',
      presence: 'ended',
      lastSeen: at(50),
      endedAt: at(50),
      endedBy: 'probe',
      endedDetectedAt: at(2),
      turns: 0,
      turnsSource: 'unknown',
    });

  it('draws the two ends differently on the list rows', async () => {
    // Under Everything, so the Note column is drawn on the row rather than folded.
    mount(sessionRows({ foreign: [reported(), inferred()], now: NOW }), { everything: EVERYTHING });
    const guessed = await waitFor(() => rowOf('foreign:f-inferred'));
    expect(within(guessed).getByText('ended · inferred')).toBeInTheDocument();
    expect(within(rowOf('foreign:f-reported')).getByText('ended')).toBeInTheDocument();
  });

  it("the session's own page says an inferred end is an inference, and never prints an uncounted 0", () => {
    const { unmount } = render(<ForeignSessionPage session={inferred()} allowAgent onResume={() => {}} />);
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByText(/its last sign of life; the process was found gone/)).toBeTruthy();
    expect(screen.getByText('ended · inferred')).toBeTruthy();
    unmount();
    render(<ForeignSessionPage session={reported()} allowAgent onResume={() => {}} />);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText(/reported by the session/)).toBeTruthy();
    expect(screen.queryByText(/found gone/)).toBeNull();
  });
});
