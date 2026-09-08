/**
 * The session inspector — L2 and L3 for the sessions surface.
 *
 * The list flattens four different kinds of process into one `SessionRow` so
 * they can be read together, and these are the properties that keep the sheet
 * from being a fifth flattening:
 *
 *   - **the raw record is the thing the row was BUILT FROM**, not the row. A
 *     lane, a pty and a registry record answer different questions and none of
 *     them survives the flattening whole; printing the view model back would be
 *     an L3 that shows exactly what L2 already showed.
 *   - **the two ids stay two ids.** `id` is a pty this console owns and can
 *     close; `sessionId` is a Claude conversation that may be on another
 *     machine. A sheet that printed one "id" would erase the distinction the
 *     whole close/resume split rests on.
 *   - **both clocks are on screen.** For three of the four kinds `createdAt`
 *     and `startedAt` are different instants, and the list has room for one.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { SessionList, type SessionRow } from './list';
import { SessionInspector } from './session-inspector';

const AT = Date.parse('2026-09-01T10:00:00Z');

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  key: 'pty:sess-1',
  kind: 'agent',
  label: 'plan wizard',
  detail: '/work/hub',
  href: '#/sessions/sess-1',
  id: 'sess-1',
  live: true,
  state: 'running',
  createdAt: AT,
  startedAt: AT + 60_000,
  record: { id: 'sess-1', cwd: '/work/hub', pid: 4242, shell: '/bin/zsh' },
  ...over,
});

const view = (r: SessionRow) =>
  render(
    <TooltipProvider>
      <SessionInspector row={r} open onOpenChange={() => {}} />
    </TooltipProvider>,
  );

describe('the session inspector', () => {
  it("prints a QA reviewer's own task list — the one section the SESSION wrote", () => {
    // The list folds it from the inbox the reviewer's `PE_TASKS_FILE` names;
    // the sheet prints it under its own heading, beside what the reviewer was
    // minted for. Absent, the section is not drawn at all.
    const reviewer = row({
      label: 'QA: alpha · P2',
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
      ],
    });
    view(reviewer);
    expect(screen.getByText('What it says it is doing')).toBeInTheDocument();
    expect(screen.getByText(/Reading the diff|read the diff/)).toBeInTheDocument();
    expect(screen.getByText('What it is reviewing')).toBeInTheDocument();
  });

  it('prints the record the row was built from, one rung down and named', () => {
    view(row());
    // Folded: L3 is a rung, not a wall of JSON over the facts.
    expect(screen.queryByText(/"pid": 4242/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Raw record' }));
    // The SOURCE record — `pid` and `shell` exist nowhere on a `SessionRow`,
    // so finding them proves this is not the view model printed back.
    expect(screen.getByText(/"pid": 4242/)).toBeInTheDocument();
    expect(screen.getByText(/"shell"/)).toBeInTheDocument();
  });

  it('offers no raw rung at all when the row carries no record', () => {
    // Better than an empty disclosure promising a record that is not there —
    // an older server, or a row built by a caller that never had one.
    const { record: _drop, ...bare } = row();
    view(bare as SessionRow);
    expect(screen.queryByRole('button', { name: 'Raw record' })).toBeNull();
  });

  it('keeps a pty id and a conversation id apart', () => {
    view(row({ id: 'pty-9', sessionId: 'conv-abc12345', key: 'x' }));
    // Both, because they are two different things: one can be closed here, the
    // other may be running on another machine entirely.
    expect(screen.getByText(/pty-9/)).toBeInTheDocument();
    expect(screen.getByText(/conv-abc/)).toBeInTheDocument();
  });

  it('does not print one id twice when they are the same string', () => {
    view(row({ id: 'same-id', sessionId: 'same-id' }));
    expect(screen.getAllByText(/same-id/)).toHaveLength(1);
  });

  it('shows both clocks — they are different questions, from different fields', () => {
    // Two labels prove nothing: wire both rows to the same field and a
    // label-only assertion stays green, which is the exact regression the
    // header says this file exists to prevent. The fixture puts a minute
    // between `createdAt` and `startedAt`, so the two rows must read
    // differently — and the one that says "1 minute ago" is the LAST-heard one.
    // Anchored to NOW so both readings are legible words rather than two
    // fuzzy renderings of the same afternoon.
    const now = Date.now();
    view(row({ createdAt: now - 3 * 60 * 60_000, startedAt: now - 60_000 }));
    const value = (label: string) => screen.getByText(label).parentElement!.querySelector('dd')!.textContent;
    expect(value('Began')).toMatch(/hour/);
    expect(value('Last heard')).toMatch(/minute/);
    expect(value('Began')).not.toBe(value('Last heard'));
    expect(screen.getByText('Running for')).toBeInTheDocument();
  });

  it('drops the running clock on a session that is not running', () => {
    // `KeyValue` drops a null row rather than drawing an em-dash, so an ended
    // session simply has no "Running for" line — never a ticking zero.
    view(row({ live: false, state: 'done', note: 'ended' }));
    expect(screen.getByText('Began')).toBeInTheDocument();
    expect(screen.queryByText('Running for')).toBeNull();
  });

  it('says a person is being waited for, and since when', () => {
    view(row({ attention: { kind: 'permission', since: '2026-09-01T10:05:00Z' } }));
    expect(screen.getByText('Waiting on you')).toBeInTheDocument();
    expect(screen.getByText(/a permission card/)).toBeInTheDocument();
    expect(screen.getByText('Since')).toBeInTheDocument();
  });
});

describe('the list offers L2 on every row', () => {
  const rows: SessionRow[] = [
    row({ key: 'lane:1', kind: 'lane', label: 'demo · P4', id: undefined, record: { runId: 'r1' } }),
    row({ key: 'pty:2', kind: 'shell', label: 'a shell' }),
    row({
      key: 'foreign:3',
      kind: 'foreign',
      label: 'somebody else',
      id: undefined,
      sessionId: 'conv-3',
      record: { sessionId: 'conv-3' },
    }),
  ];

  it('gives a button to each kind, including the ones with nowhere else to go', () => {
    render(
      <TooltipProvider>
        <SessionList rows={rows} />
      </TooltipProvider>,
    );
    // A lane's link opens its run tab and a foreign row's opens the phase it
    // works; neither is a page ABOUT the session, and a plain shell had none.
    for (const label of ['demo · P4', 'a shell', 'somebody else']) {
      expect(screen.getByRole('button', { name: `Inspect ${label}` })).toBeInTheDocument();
    }
  });

  it('opens one sheet, on the row that was pressed', () => {
    render(
      <TooltipProvider>
        <SessionList rows={rows} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inspect a shell' }));
    const sheets = screen.getAllByRole('dialog');
    expect(sheets).toHaveLength(1);
    expect(within(sheets[0]).getByText('a shell')).toBeInTheDocument();
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
        qa: {
          slug: 'alpha',
          phase: 7,
          round: 3,
          report: 'reports/phase-07-qa-round3.md',
          before: 'fail',
        },
      },
    } as never,
  });

  it('names the plan, the phase, the round and the report it writes', () => {
    view(qaRow);
    const section =
      screen.getByRole('heading', { name: 'What it is reviewing' }).closest('section') ?? document.body;
    expect(within(section).getByText('alpha')).toBeTruthy();
    expect(within(section).getByText('7')).toBeTruthy();
    expect(within(section).getByText('3')).toBeTruthy();
    // The report path is the thing that was never linked anywhere — and round 3
    // writes its OWN file, never over round 1's.
    expect(within(section).getByText('reports/phase-07-qa-round3.md')).toBeTruthy();
    // The mint-time snapshot: what turns "it ended" into "it recorded something".
    expect(within(section).getByText('fail')).toBeTruthy();
  });

  it('says so plainly when no verdict was on file when it started', () => {
    view(
      row({
        record: { id: 'sess-qa', meta: { qa: { slug: 'alpha', phase: 7 } } } as never,
      }),
    );
    expect(screen.getByText('none recorded')).toBeTruthy();
  });

  it('shows the section for no other kind of session', () => {
    view(row());
    expect(screen.queryByRole('heading', { name: 'What it is reviewing' })).toBeNull();
  });
});
