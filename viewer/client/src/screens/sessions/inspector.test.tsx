/**
 * A session in the panel — Inspect, the second door to depth (7.0,
 * quiet-console phase 15; design.md principle 3) — drawn by the shell's own
 * `InspectorHost`, as the app draws it.
 *
 * The list flattens four different kinds of process into one `SessionRow` so
 * they can be read together, and these are the properties that keep the panel
 * from being a fifth flattening:
 *
 *   - **the raw record is the thing the row was BUILT FROM**, not the row. The
 *     panel's Raw tab, one press below the facts, prints it verbatim; a row
 *     that carries no record has no Raw tab at all. A lane, a pty and a
 *     registry record answer different questions and none of them survives
 *     the flattening whole.
 *   - **the two ids stay two ids.** `id` is a pty this console owns and can
 *     close; `sessionId` is a Claude conversation that may be on another
 *     machine. A panel that printed one "id" would erase the distinction the
 *     whole close/resume split rests on.
 *   - **both clocks are on screen**, each from its own field: for three of the
 *     four kinds `createdAt` and `startedAt` are different instants, and the
 *     list has room for one.
 *   - **a QA reviewer says what it is reviewing** — the plan, the phase, the
 *     round, the report it writes and the verdict on file when it started —
 *     and the task list it wrote itself.
 *   - **its hook events are its History**, read only while that tab is drawn.
 *
 * Every row of the list offers Inspect once opened, including the kinds with
 * nowhere else to go, and the panel holds one record: the pressed row's. An
 * OPEN session is inspected live — its Overview, Actions and Raw read the
 * session by id from the one terminal list, so a freeze turns Freeze into
 * Continue without the page handing the panel a new record — and `open:
 * false` puts the record there without opening the panel.
 *
 * 6.2's sheet said "a permission card"; 7.0 says what the session waits for in
 * the summons' words ("needs your permission"), beside its own word.
 */

import { describeWord } from '@shared/status-model.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseTask, TerminalSession, TerminalState } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { PANEL_WIDTH, getPrefs, setPrefs } from '@/lib/prefs';
import { InspectorHost, __resetInspectorForTests } from '@/shell/panel/inspector-host';
import { runHref, sessionsHref } from '@/shell/routes';
import { inspectRow, inspectSession, taskWords } from './inspector';
import { SessionList } from './list';
import type { SessionRow } from './model';

const AT = Date.parse('2026-09-01T10:00:00Z');

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  key: 'pty:sess-1',
  kind: 'agent',
  label: 'plan wizard',
  detail: '/work/hub',
  href: sessionsHref('sess-1'),
  id: 'sess-1',
  live: true,
  vocab: 'terminal',
  view: describeWord('terminal', 'running'),
  createdAt: AT,
  startedAt: AT + 60_000,
  record: { id: 'sess-1', cwd: '/work/hub', pid: 4242, shell: '/bin/zsh' },
  // Every group kind is a badge word of its own (#369).
  badge: over.kind ?? 'agent',
  ...over,
});

let sent: string[] = [];
/** What `GET /api/sessions/<id>/events` answers — `[status, body]`. */
let events: [number, unknown] = [200, { sessionId: '', events: [] }];

beforeEach(() => {
  sent = [];
  events = [200, { sessionId: '', events: [] }];
  __resetInspectorForTests();
  setPrefs({ panel: { open: false, width: PANEL_WIDTH.initial, mode: 'details' }, tables: {} });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      sent.push(path);
      const [status, body] = /^\/api\/sessions\/[^/?]+\/events/.test(path)
        ? events
        : [404, { error: 'not here' }];
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Mount over a client of the app's own config, the terminal list seeded when given. */
function mount(node: ReactNode, list?: TerminalState) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  if (list) client.setQueryData(keys.terminal(), list);
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return client;
}

/** The one record the panel draws. */
function panel(): HTMLElement {
  const drawn = document.querySelectorAll<HTMLElement>('[data-inspector]');
  expect(drawn).toHaveLength(1);
  return drawn[0]!;
}

/** Put a row in the panel through the list's own door, and read what the panel drew. */
function show(r: SessionRow): HTMLElement {
  inspectRow(r);
  mount(<InspectorHost />);
  return panel();
}

/** Press one of the panel's tabs, the way Radix hears a press. */
function openTab(name: string): void {
  const tab = within(panel()).getByRole('tab', { name });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

const tabsOf = (root: HTMLElement): string[] =>
  within(root)
    .queryAllByRole('tab')
    .map((tab) => tab.textContent ?? '');

/** The value drawn beside a KeyValue label, or null when the row is not drawn. */
const valueOf = (label: string, root: HTMLElement): string | null =>
  within(root).queryByText(label)?.parentElement?.querySelector('dd')?.textContent ?? null;

describe('the session in the panel', () => {
  it("prints a QA reviewer's own task list — the one section the SESSION wrote", () => {
    // The list folds it from the inbox the reviewer's `PE_TASKS_FILE` names;
    // the panel prints it under its own heading, beside what the reviewer was
    // minted for. Absent, the section is not drawn at all.
    const reviewer = row({
      label: 'QA: alpha P2',
      record: {
        id: 'sess-1',
        cwd: '/work/hub',
        pid: 4242,
        shell: '/bin/zsh',
        kind: 'claude',
        meta: { intent: 'qa', qa: { slug: 'alpha', phase: 2, round: 1, report: 'reports/phase-02-qa.md' } },
      },
      tasks: [
        { id: 'p2.task1', content: 'read the diff', activeForm: 'Reading the diff', status: 'in_progress' },
        { id: 'p2.task2', content: 'record the verdict', status: 'pending' },
      ],
    });
    const inspector = show(reviewer);
    expect(within(inspector).getByRole('heading', { name: 'What it says it is doing' })).toBeInTheDocument();
    // Each task under its status word; the doing one in its own active words.
    const tasks = within(inspector).getByRole('list', { name: 'What it says it is doing' });
    expect(
      within(tasks)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['DoingReading the diff', 'To dorecord the verdict']);
    expect(within(inspector).getByRole('heading', { name: 'What it is reviewing' })).toBeInTheDocument();
  });

  it('prints the record the row was built from, one rung down and named', () => {
    const r = row();
    const inspector = show(r);
    // Folded: L3 is a rung, not a wall of JSON over the facts.
    expect(within(inspector).queryByText(/"pid": 4242/)).toBeNull();
    openTab('Raw');
    // The SOURCE record — `pid` and `shell` exist nowhere on a `SessionRow`,
    // so finding them proves this is not the view model printed back.
    const raw = within(panel()).getByText(/"pid": 4242/);
    expect(raw.textContent).toMatch(/"shell": "\/bin\/zsh"/);
    expect(JSON.parse(raw.textContent ?? '')).toEqual(r.record);
  });

  it('gives a lane its phase’s verbs as Actions — its place in the queue among them — and no other row any', () => {
    const lane = show(
      row({
        key: 'lane:1',
        kind: 'lane',
        label: 'demo P4',
        detail: 'Wire the runner',
        href: runHref('demo'),
        id: undefined,
        lane: { slug: 'demo', phase: 4, runId: 'r1' },
        vocab: 'phase',
        view: describeWord('phase', 'running'),
        record: { runId: 'r1' },
      }),
    );
    expect(tabsOf(lane)).toContain('Actions');
    openTab('Actions');
    expect(within(panel()).getByRole('group', { name: 'Queue' })).toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Press retry' })).toBeInTheDocument();
    // A run's own verbs are the run's tab, not the lane's.
    expect(within(panel()).queryByRole('button', { name: 'Press pause' })).toBeNull();
  });

  it('offers no Actions on a row that is no phase’s session', () => {
    expect(
      tabsOf(show(row({ key: 'foreign:3', kind: 'foreign', id: undefined, sessionId: 'conv-3' }))),
    ).not.toContain('Actions');
  });

  it('offers no raw rung at all when the row carries no record', () => {
    // Better than an empty tab promising a record that is not there — an
    // older server, or a row built by a caller that never had one.
    const { record: _drop, ...bare } = row();
    const inspector = show(bare);
    expect(within(inspector).queryByRole('tab', { name: 'Raw' })).toBeNull();
    expect(valueOf('Terminal', inspector)).toBe('sess-1');
  });

  it('keeps a pty id and a conversation id apart', () => {
    const inspector = show(row({ id: 'pty-9', sessionId: 'conv-abc12345', key: 'x' }));
    // Both, because they are two different things: one can be closed here, the
    // other may be running on another machine entirely.
    expect(valueOf('Terminal', inspector)).toBe('pty-9');
    expect(valueOf('Conversation', inspector)).toBe('conv-abc12345');
  });

  it('does not print one id twice when they are the same string', () => {
    const inspector = show(row({ id: 'same-id', sessionId: 'same-id' }));
    expect(within(inspector).getAllByText(/same-id/)).toHaveLength(1);
    expect(valueOf('Conversation', inspector)).toBeNull();
  });

  it('shows both clocks — they are different questions, from different fields', () => {
    // Two labels prove nothing: wire both rows to the same field and a
    // label-only assertion stays green, which is the exact regression this
    // file exists to prevent. The fixture puts hours between `createdAt` and
    // `startedAt`, so the two rows must read differently — and the one that
    // says "1 minute ago" is the LAST-heard one. Anchored to now so both
    // readings are legible words rather than two renderings of one afternoon.
    const now = Date.now();
    const inspector = show(row({ createdAt: now - 3 * 60 * 60_000, startedAt: now - 60_000 }));
    expect(valueOf('Began', inspector)).toMatch(/hour/);
    expect(valueOf('Last heard', inspector)).toMatch(/minute/);
    expect(valueOf('Began', inspector)).not.toBe(valueOf('Last heard', inspector));
    expect(valueOf('Running for', inspector)).not.toBeNull();
  });

  it('drops the running clock on a session that is not running', () => {
    // `KeyValue` drops an empty row rather than drawing an em-dash, so an ended
    // session simply has no "Running for" line — never a ticking zero.
    const inspector = show(row({ live: false, view: describeWord('terminal', 'exited'), note: 'ended' }));
    expect(valueOf('Began', inspector)).not.toBeNull();
    expect(valueOf('Note', inspector)).toBe('ended');
    expect(within(inspector).queryByText('Running for')).toBeNull();
  });

  it('says a person is being waited for, and since when — beside its own word', () => {
    const inspector = show(row({ attention: { kind: 'permission', since: '2026-09-01T10:05:00Z' } }));
    expect(valueOf('Waiting on you', inspector)).toBe('needs your permission');
    expect(valueOf('Since', inspector)).not.toBeNull();
    // The identity row keeps the session's own word and takes the summons beside it.
    const mark = inspector.querySelector<HTMLElement>('[data-status][data-vocab]')!;
    expect(mark).toHaveAttribute('data-status', 'running');
    expect(mark).toHaveAttribute('data-vocab', 'terminal');
    expect(mark).toHaveAttribute('data-attention', 'needs-you');
    expect(mark.textContent).toMatch(/^Running.*needs your permission$/);
  });
});

describe('taskWords', () => {
  it('counts what is done and names the doing task in its own words', () => {
    const tasks: PhaseTask[] = [
      { id: '1', content: 'read the plan', status: 'completed' },
      { id: '2', content: 'wire the runner', activeForm: 'Wiring the runner', status: 'in_progress' },
      { id: '3', content: 'write the handoff', status: 'pending' },
    ];
    expect(taskWords(tasks)).toBe('1 of 3 done, Wiring the runner');
    // No active form: the task's own words. Nothing doing: the count alone.
    expect(taskWords([{ id: '2', content: 'wire the runner', status: 'in_progress' }])).toBe(
      '0 of 1 done, wire the runner',
    );
    expect(taskWords(tasks.slice(0, 1))).toBe('1 of 1 done');
  });
});

describe('the list offers L2 on every row', () => {
  const rows: SessionRow[] = [
    row({
      key: 'lane:1',
      kind: 'lane',
      label: 'demo P4',
      detail: 'Wire the runner',
      href: runHref('demo'),
      id: undefined,
      lane: { slug: 'demo', phase: 4, runId: 'r1' },
      vocab: 'phase',
      view: describeWord('phase', 'running'),
      record: { runId: 'r1' },
    }),
    row({
      key: 'pty:2',
      kind: 'shell',
      label: 'a shell',
      id: '2',
      href: sessionsHref('2'),
      record: { id: '2', label: 'a shell', cwd: '/work/hub', pid: 4243, shell: '/bin/zsh' },
    }),
    row({
      key: 'foreign:3',
      kind: 'foreign',
      label: 'somebody else',
      id: undefined,
      sessionId: 'conv-3',
      href: sessionsHref('conv-3'),
      vocab: 'presence',
      view: describeWord('presence', 'live'),
      record: { sessionId: 'conv-3' },
    }),
  ];

  /** The list beside the panel, every row opened in place by its own toggle — and nothing else that folds. */
  function list(): void {
    mount(
      <>
        <SessionList
          rows={rows}
          by="kind"
          everything={{ on: false, toggle: () => {} }}
          sort="activity"
          onSort={() => {}}
        />
        <InspectorHost />
      </>,
    );
    const toggles = screen.getAllByRole('button', { name: /^Show the rest of this row/ });
    expect(toggles).toHaveLength(rows.length);
    for (const toggle of toggles) fireEvent.click(toggle);
  }

  const inspectButton = (key: string): HTMLElement =>
    within(document.getElementById(`row-${key}-detail`)!).getByRole('button', { name: 'Inspect' });

  it('gives Inspect to each kind, including the ones with nowhere else to go', () => {
    list();
    // A lane's link opens its run and a foreign row's its own page; neither is
    // a page ABOUT the session, and a plain shell had none.
    for (const key of ['lane:1', 'pty:2', 'foreign:3']) expect(inspectButton(key)).toBeInTheDocument();
  });

  it('puts one record in the panel — the row that was pressed — and marks that row', () => {
    list();
    fireEvent.click(inspectButton('pty:2'));
    expect(panel()).toHaveAttribute('aria-label', 'a shell');
    expect(inspectButton('pty:2')).toHaveAttribute('aria-pressed', 'true');
    expect(inspectButton('lane:1')).toHaveAttribute('aria-pressed', 'false');
    expect(inspectButton('foreign:3')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('a QA session says what it is reviewing', () => {
  // Issue #7 §1: a QA session decides whether every dependent phase may start
  // and it costs money, and everything a reader ever learned about it was three
  // journal fields. Which phase, which round and which report it writes were
  // knowable only from the prompt it had been handed.
  const qaRow = row({
    kind: 'agent',
    label: 'QA — alpha p7',
    record: {
      id: 'sess-qa',
      cwd: '/work/hub',
      meta: {
        intent: 'qa',
        qa: { slug: 'alpha', phase: 7, round: 3, report: 'reports/phase-07-qa-round3.md', before: 'fail' },
      },
    },
  });

  it('names the plan, the phase, the round and the report it writes', () => {
    const inspector = show(qaRow);
    const section = within(inspector)
      .getByRole('heading', { name: 'What it is reviewing' })
      .closest('section')!;
    expect(valueOf('Plan', section)).toBe('alpha');
    expect(valueOf('Phase', section)).toBe('7');
    expect(valueOf('Round', section)).toBe('3');
    // The report path is the thing that was never linked anywhere — and round 3
    // writes its OWN file, never over round 1's.
    expect(valueOf('Report it writes', section)).toBe('reports/phase-07-qa-round3.md');
    // The mint-time snapshot: what turns "it ended" into "it recorded something".
    expect(valueOf('Verdict before it started', section)).toBe('fail');
  });

  it('says so plainly when no verdict was on file when it started', () => {
    const inspector = show(row({ record: { id: 'sess-qa', meta: { qa: { slug: 'alpha', phase: 7 } } } }));
    expect(valueOf('Verdict before it started', inspector)).toBe('none recorded');
    // No round on the record, so no round row — never an invented "1".
    expect(valueOf('Round', inspector)).toBeNull();
  });

  it('shows the section for no other kind of session', () => {
    const inspector = show(row());
    expect(within(inspector).queryByRole('heading', { name: 'What it is reviewing' })).toBeNull();
  });
});

describe('the hook events behind a session (phase 25)', () => {
  it('reads GET /api/sessions/<id>/events once History is drawn, and lists what the hook said, with its lateness', async () => {
    events = [
      200,
      {
        sessionId: 'c399fe08',
        events: [
          {
            at: '2026-09-01T10:00:00Z',
            appliedAt: '2026-09-01T10:00:00Z',
            lateMs: 0,
            via: 'http',
            event: 'SessionStart',
            payload: {},
          },
          {
            at: '2026-09-01T10:05:00Z',
            appliedAt: '2026-09-01T10:05:09Z',
            lateMs: 9000,
            via: 'inbox',
            event: 'Stop',
            payload: {},
          },
        ],
      },
    ];
    show(row({ sessionId: 'c399fe08' }));
    // The facts alone read nothing: the events are the History tab's.
    expect(sent).toEqual([]);
    openTab('History');
    const list = await within(panel()).findByTestId('hook-events');
    expect(sent).toEqual(['/api/sessions/c399fe08/events?limit=50']);
    // As the hook sent them, newest last: when, what (and how late), by which door.
    const lines = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines[0]).toMatch(/SessionStart.*http$/);
    expect(lines[0]).not.toMatch(/late/);
    expect(lines[1]).toMatch(/Stop, 9 s late.*inbox$/);
  });

  it('says so when they cannot be read, rather than showing an empty history', async () => {
    events = [404, { error: 'no such session' }];
    show(row({ sessionId: 'gone-1' }));
    openTab('History');
    expect(
      await within(panel()).findByText('The hook events could not be read: no such session'),
    ).toBeInTheDocument();
  });
});

describe('an open session, inspected live', () => {
  const pty = (over: Partial<TerminalSession> = {}): TerminalSession => ({
    id: 'abc123',
    label: 'claude in repo',
    kind: 'claude',
    cwd: '/repo',
    shell: '/bin/zsh',
    cols: 80,
    rows: 24,
    pid: 4242,
    clients: 1,
    createdAt: Date.now() - 5 * 60_000,
    meta: { model: 'opus', effort: 'max', permissionMode: 'acceptEdits', claudeSessionId: 'conv-abc' },
    ...over,
  });

  const listOf = (...sessions: TerminalSession[]): TerminalState => ({
    allowed: true,
    agentAllowed: true,
    available: 'yes',
    limit: 8,
    live: sessions.filter((one) => !one.exited).length,
    sessions,
  });

  it('`open: false` puts the record in the panel without opening it — every tab, History for a conversation', () => {
    const session = pty();
    inspectSession(session, { onGone: vi.fn(), open: false });
    expect(getPrefs().panel.open).toBe(false);
    mount(<InspectorHost />, listOf(session));
    const inspector = panel();
    expect(inspector).toHaveAttribute('aria-label', 'claude in repo');
    expect(inspector.querySelector('header p')).toHaveTextContent('/repo');
    expect(tabsOf(inspector)).toEqual(['Overview', 'Actions', 'History', 'Raw']);
    const mark = inspector.querySelector<HTMLElement>('[data-status][data-vocab]')!;
    expect(mark).toHaveAttribute('data-vocab', 'terminal');
    expect(mark).toHaveAttribute('data-status', 'running');
  });

  it('a shell has no conversation, so no History; inspected the usual way, the panel opens', () => {
    const shell = pty({ kind: 'shell', label: 'zsh', meta: undefined });
    inspectSession(shell, { onGone: vi.fn() });
    expect(getPrefs().panel.open).toBe(true);
    mount(<InspectorHost />, listOf(shell));
    expect(tabsOf(panel())).toEqual(['Overview', 'Actions', 'Raw']);
    expect(valueOf('Kind', panel())).toBe('A shell');
    expect(valueOf('Launched in', panel())).toBeNull();
  });

  it('its Overview says what it is, how it was launched, and the size the pane is drawn at', () => {
    const session = pty();
    inspectSession(session, { onGone: vi.fn(), size: { cols: 120, rows: 40 }, open: false });
    mount(<InspectorHost />, listOf(session));
    const inspector = panel();
    // The vitals ride first: its clock.
    expect(within(inspector).getByTestId('session-clock')).toBeInTheDocument();
    expect(valueOf('Kind', inspector)).toBe('An agent session — Claude Code in a terminal');
    expect(valueOf('Launched in', inspector)).toBe('accept edits');
    expect(valueOf('Model', inspector)).toBe('opus at max');
    expect(valueOf('Directory', inspector)).toBe('/repo');
    // The pane's own size over the record's: it is what the person is looking at.
    expect(valueOf('Size', inspector)).toBe('120 columns, 40 rows');
    expect(valueOf('Attached', inspector)).toBe('one browser');
    expect(valueOf('Process', inspector)).toBe('4242');
    expect(valueOf('Terminal', inspector)).toBe('abc123');
    expect(valueOf('Conversation', inspector)).toBe('conv-abc');
  });

  // The query cache tells its observers on the next task, so a move of the
  // list is read back with `findBy…`/`waitFor`, never synchronously.

  it('reads the session by id from the one list: a freeze turns Freeze into Continue, Raw follows, an end says so', async () => {
    const session = pty();
    inspectSession(session, { onGone: vi.fn(), open: false });
    const client = mount(<InspectorHost />, listOf(session));
    openTab('Actions');
    expect(within(panel()).getByRole('button', { name: 'Freeze' })).toBeInTheDocument();

    // The list moves; nobody hands the panel a new record.
    const frozen = pty({
      frozen: { at: Date.now(), by: 'you', escalateAt: new Date(Date.now() + 15 * 60_000).toISOString() },
    });
    act(() => client.setQueryData(keys.terminal(), listOf(frozen)));
    expect(await within(panel()).findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Freeze' })).toBeNull();

    openTab('Raw');
    expect(within(panel()).getByText(/"frozen": \{/)).toBeInTheDocument();

    act(() => client.setQueryData(keys.terminal(), listOf()));
    expect(await within(panel()).findByText('That session is not here any more.')).toBeInTheDocument();
  });

  it('an ended conversation resumes from Actions — unless the shared cap is reached', async () => {
    const ended = pty({ exited: { code: 0 }, exitedAt: Date.now() });
    const onResume = vi.fn();
    inspectSession(ended, { onGone: vi.fn(), onResume, open: false });
    const client = mount(<InspectorHost />, listOf(ended));
    openTab('Actions');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Resume here' }));
    expect(onResume).toHaveBeenCalledWith('conv-abc');

    // Eight live sessions across shells and agents: the limit counts them all.
    act(() => client.setQueryData(keys.terminal(), { ...listOf(ended), live: 8 }));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Resume here' })).toBeDisabled());
  });
});
