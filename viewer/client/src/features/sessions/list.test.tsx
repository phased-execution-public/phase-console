/**
 * The fold — four lists into one.
 *
 * `sessionRows` is where "every process this console owns or can see" stops
 * being a sentence and becomes data, so it is asserted without a pty, without a
 * socket and without a render: the ordering rule, the four kinds, and the two
 * things it deliberately does NOT do (draw a lane twice, or offer a Close on a
 * process this console does not own).
 *
 * ⚠️ The list itself is rendered here only for the row-level promises. Counting
 * ROWS in a rendering is what `journal.test.tsx` warns about — this list is not
 * virtualized, so it is safe here, but any future one that is will pass
 * vacuously (a virtualized scroller measures 0 tall in jsdom and honestly
 * reports nothing on screen).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ForeignSession, TerminalSession } from '@/lib/api';
import type { NowLane } from '@/features/now/model';
import { SessionList, sessionRows } from './list';
import { ForeignSessionPage } from './foreign';
import { endedLabel, turnsLabel } from '@/features/now/model';

const NOW = Date.parse('2026-08-22T12:00:00Z');
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

const lane = (over: Partial<NowLane> & { phase: number }): NowLane =>
  ({
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
  }) as NowLane;

const foreign = (over: Partial<ForeignSession> & { sessionId: string }): ForeignSession => ({
  kind: 'foreign',
  cwd: '/elsewhere',
  startedAt: at(30),
  lastSeen: at(1),
  turns: 3,
  presence: 'live',
  ...over,
});

describe('sessionRows', () => {
  it('folds all four kinds into one vocabulary', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 'c1', label: 'Claude: hello', kind: 'claude' }), pty({ id: 's1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      foreign: [foreign({ sessionId: 'f1', owner: 'someone' })],
      now: NOW,
    });
    expect(rows.map((row) => row.kind)).toEqual(['lane', 'agent', 'shell', 'foreign']);
  });

  it("carries a lane's task list, and only a lane's", () => {
    // A pty's list is its own business and the registry cannot see it; a lane's
    // is on the run record the row was built from. Rendered through the same
    // `taskSummary` the Now page uses, so the two cannot disagree.
    const tasks = [
      { id: 'p3.task1', content: 'one', status: 'completed' },
      { id: 'p3.task2', content: 'two', activeForm: 'Doing two', status: 'in_progress' },
    ];
    const rows = sessionRows({
      terminals: [pty({ id: 's1' })],
      lanes: [lane({ phase: 3, tasks }), lane({ phase: 4 })],
      now: NOW,
    });
    expect(rows.find((r) => r.key === 'lane:run-1#3')?.tasks).toEqual(tasks);
    expect(rows.find((r) => r.key === 'lane:run-1#4')?.tasks).toBeUndefined();
    expect(rows.find((r) => r.kind === 'shell')?.tasks).toBeUndefined();
  });

  it("carries a QA reviewer pty's task list too — the one pty whose list the server can see", () => {
    // A "QA this phase" session publishes into the inbox its `PE_TASKS_FILE`
    // names and `GET /api/terminal` folds it onto the session; the row is
    // built from that record, so the reviewer reads like a lane here and in
    // the inspector. Every other pty still has no list to carry.
    const tasks = [
      { id: 'p2.task1', content: 'read the diff', activeForm: 'Reading the diff', status: 'in_progress' },
    ];
    const rows = sessionRows({
      terminals: [
        pty({ id: 'q1', kind: 'claude', meta: { intent: 'qa', qa: { slug: 'alpha', phase: 2 } }, tasks }),
        pty({ id: 'w1', kind: 'claude', meta: { intent: 'plan' } }),
        pty({ id: 's1' }),
      ],
      now: NOW,
    });
    expect(rows.find((r) => r.key === 'pty:q1')?.tasks).toEqual(tasks);
    expect(rows.find((r) => r.key === 'pty:w1')?.tasks).toBeUndefined();
    expect(rows.find((r) => r.key === 'pty:s1')?.tasks).toBeUndefined();
  });

  it('puts what is live above what is not, whatever kind it is', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 'dead', exited: { code: 0 }, exitedAt: NOW - 1_000 }), pty({ id: 'alive' })],
      lanes: [lane({ phase: 1, status: 'queued' })],
      now: NOW,
    });
    // The queued lane is not live either, so the ONE live row leads — a list
    // sorted by kind alone would bury the shell you are typing in under eight
    // records of shells that exited yesterday.
    expect(rows[0]!.id).toBe('alive');
    expect(rows.filter((row) => row.live)).toHaveLength(1);
  });

  it('addresses a console-owned pty by id and sends everything else to its own page', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 's1' })],
      lanes: [lane({ phase: 3 })],
      foreign: [foreign({ sessionId: 'f1', plan: { slug: 'beta', phase: 2, strong: true } })],
      now: NOW,
    });
    const by = (kind: string) => rows.find((row) => row.kind === kind)!;
    // The only rows with an `id` are the ones `#/sessions/:id` can open — which
    // is also what decides whether a Close button is offered.
    expect(by('shell').id).toBe('s1');
    expect(by('shell').href).toBe('#/sessions/s1');
    expect(by('lane').id).toBeUndefined();
    expect(by('lane').href).toContain('#/plan/alpha/run');
    expect(by('foreign').id).toBeUndefined();
    // The PHASE, not the plan's run tab: a correlated session works one phase,
    // and the row in the incident linked at the page the operator was on.
    expect(by('foreign').href).toBe('#/plan/beta/phase/2');
    // …and since Phase 8 it ALSO carries the conversation, which is a different
    // thing from `id`: there is no pty to close, so it must not reach the close
    // button — but `#/sessions/<conversation>` is a real page now.
    expect(by('foreign').sessionId).toBe('f1');
  });

  it('sends an uncorrelated foreign row to its own page, not back to this one', () => {
    // `sessionsHref()` with no id is `#/sessions` — the page the row was
    // clicked ON. That is the incident's own defect at its smallest, and it
    // survived because an uncorrelated row had nowhere better to go until the
    // session itself had a page.
    const rows = sessionRows({ foreign: [foreign({ sessionId: 'f1' })], now: NOW });
    expect(rows[0].href).toBe('#/sessions/f1');
    expect(rows[0].sessionId).toBe('f1');
  });

  it('never draws a lane twice, however the registry reports it', () => {
    // The presence hook sees the console's OWN lane session too. Drawn from
    // both sources it appears as a lane and again as a foreign process, and
    // the two rows disagree about what can be done to it.
    const rows = sessionRows({
      lanes: [lane({ phase: 3, child: { sessionId: 'x9' } as NowLane['child'] })],
      foreign: [foreign({ sessionId: 'x9', plan: { slug: 'alpha', phase: 3, strong: true } })],
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('lane');
  });

  it('is empty rather than undefined when the console can see nothing', () => {
    expect(sessionRows({ now: NOW })).toEqual([]);
  });
});

describe('<SessionList>', () => {
  const rows = () =>
    sessionRows({
      terminals: [pty({ id: 's1', label: 'Terminal 1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      now: NOW,
    });

  it('groups by kind, and renders no heading for a kind with nothing in it', () => {
    render(<SessionList rows={rows()} />);
    expect(screen.getByRole('region', { name: 'Shells' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Autopilot lanes' })).toBeInTheDocument();
    // Four headings over one shell is a page that looks broken on the console
    // most people run.
    expect(screen.queryByRole('region', { name: 'Agent sessions' })).toBeNull();
    expect(screen.queryByRole('region', { name: /other sessions/i })).toBeNull();
  });

  it('offers Close only where the console owns the process', () => {
    const closed: string[] = [];
    render(<SessionList rows={rows()} onClose={(id) => closed.push(id)} />);
    // One button, not two: a lane has no pty for this page to close, and a
    // Close beside it would be a button that answers 404.
    const buttons = screen.getAllByRole('button', { name: /^close /i });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Close Terminal 1');
  });

  it('marks the open session, so the list beside a pane says which one it is', () => {
    render(<SessionList rows={rows()} activeId="s1" />);
    expect(screen.getByRole('link', { name: /Terminal 1/ })).toHaveAttribute('aria-current', 'true');
  });

  it('renders its own empty state rather than four blank headings', () => {
    render(<SessionList rows={[]} empty={<p>Nothing is running</p>} />);
    expect(screen.getByText('Nothing is running')).toBeInTheDocument();
  });

  it('gives a foreign row a way IN without taking its link to the phase', () => {
    // Two destinations, deliberately: the row goes where the session BELONGS
    // (its phase), the trailing link goes to the session itself — which is the
    // page that can resume it. Collapsing them would cost one of the two.
    const withForeign = sessionRows({
      foreign: [foreign({ sessionId: 'f1', plan: { slug: 'beta', phase: 2, strong: true } })],
      now: NOW,
    });
    render(<SessionList rows={withForeign} onClose={() => {}} />);

    expect(screen.getByRole('link', { name: /^Open beta · P2$/ })).toHaveAttribute('href', '#/sessions/f1');
    // And still no Close: there is no pty here to close, whatever the row now
    // knows how to open.
    expect(screen.queryByRole('button', { name: /^close /i })).toBeNull();
  });
});

describe('status, attention and time on the rows', () => {
  it('paints each row through the status vocabulary — a queued lane is queued, an exited-nonzero shell failed', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 2, status: 'queued' })],
      terminals: [pty({ id: 't1', exited: { code: 1 }, exitedAt: NOW - 1000 })],
      // `unknown` presence never reaches the list (`otherSessions` keeps only
      // the live and the recently ended), so the reachable dead state is `done`.
      foreign: [foreign({ sessionId: 'f1', presence: 'ended', endedAt: at(2), lastSeen: at(1) })],
      now: NOW,
    });
    expect(rows.find((r) => r.kind === 'lane')?.state).toBe('queued');
    expect(rows.find((r) => r.kind === 'shell')?.state).toBe('failed');
    expect(rows.find((r) => r.kind === 'foreign')?.state).toBe('done');
  });

  it('marks a lane parked on a pending approval as needing permission, and sorts it above the merely live', () => {
    const rows = sessionRows({
      lanes: [
        lane({ phase: 1, status: 'running', startedAt: at(10) }),
        lane({ phase: 2, status: 'running', startedAt: at(5), key: 'run-1#2' }),
      ],
      approvals: [
        { status: 'pending', runId: 'run-1', phase: 2, createdAt: at(1) },
        // A settled card marks nothing.
        { status: 'allow', runId: 'run-1', phase: 1, createdAt: at(1) },
      ],
      now: NOW,
    });
    const waiting = rows[0];
    expect(waiting.label).toContain('P2');
    expect(waiting.state).toBe('needs-you');
    expect(waiting.attention).toEqual({ kind: 'permission', since: at(1) });
    expect(rows[1].attention).toBeUndefined();
  });

  it("reads the registry's waiting field as attention, with the CLI's own words as the note", () => {
    const rows = sessionRows({
      foreign: [
        foreign({
          sessionId: 'f1',
          waiting: { since: at(2), kind: 'input', note: 'Claude is waiting for your input' },
        }),
      ],
      now: NOW,
    });
    expect(rows[0].state).toBe('needs-you');
    expect(rows[0].attention).toEqual({ kind: 'input', since: at(2) });
    expect(rows[0].note).toBe('Claude is waiting for your input');
  });

  it('shows a ticking clock only for live rows — an ended one reads "N ago"', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 1, status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString() })],
      terminals: [pty({ id: 't1', exited: { code: 0 }, exitedAt: Date.now() - 120_000 })],
    });
    render(<SessionList rows={rows} empty="none" />);
    const items = screen.getAllByRole('listitem');
    // Both clocks are `<time>` now — the ended one is `RelativeTime`, not a
    // bare string — so the distinction is what each one MEASURES: a live row
    // carries an ISO DURATION that grows, an ended one an ISO INSTANT that
    // does not. Asserting on the element alone would pass for either.
    const live = items.find((li) => li.textContent?.includes('P1'))!;
    expect(live.querySelector('time')?.getAttribute('datetime')).toMatch(/^PT/);
    const dead = items.find((li) => li.textContent?.includes('t1'))!;
    expect(dead.querySelector('time')?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(dead.textContent).toMatch(/ago/);
  });

  it('the attention badge names what is needed, through the one vocabulary', () => {
    const rows = sessionRows({
      foreign: [foreign({ sessionId: 'f1', waiting: { since: at(2), kind: 'permission' } })],
      now: NOW,
    });
    render(<SessionList rows={rows} empty="none" />);
    expect(screen.getByText('needs permission')).toBeTruthy();
  });
});

/**
 * ACC-7.7 (REG-9). A probe-detected death used to be stamped with the moment
 * somebody LOOKED — one record claimed 17.3 hours it never lived — and `turns
 * 0` described a twelve-hour session in the same words as a five-second probe.
 * The registry now writes an inferred end as one, and says where a turn count
 * came from; the pages draw both differently from what a session reported.
 */
describe('inferred ends and unknown turns (REG-9)', () => {
  const reported = foreign({
    sessionId: 'f-reported',
    presence: 'ended',
    endedAt: at(5),
    endedBy: 'hook',
    turns: 12,
    turnsSource: 'hook',
  });
  const inferred = foreign({
    sessionId: 'f-inferred',
    presence: 'ended',
    lastSeen: at(50),
    endedAt: at(50),
    endedBy: 'probe',
    endedDetectedAt: at(2),
    turns: 0,
    turnsSource: 'unknown',
  });

  it('labels an inferred end differently from a reported one, and an unknown count as unknown', () => {
    expect(endedLabel(reported)).toBe('ended');
    expect(endedLabel(inferred)).toBe('ended · inferred');
    expect(endedLabel(foreign({ sessionId: 'f-live' }))).toBeNull();
    expect(turnsLabel(reported)).toBe('12');
    expect(turnsLabel(inferred)).toBe('unknown');
    expect(turnsLabel(foreign({ sessionId: 'f-lane', turns: 139, turnsSource: 'stream' }))).toMatch(
      /139 \(counted by the run's stream/,
    );
  });

  it('draws the two ends differently on the list rows', () => {
    const rows = sessionRows({ foreign: [reported, inferred], now: NOW });
    expect(rows.find((row) => row.sessionId === 'f-reported')?.note).toBe('ended');
    expect(rows.find((row) => row.sessionId === 'f-inferred')?.note).toBe('ended · inferred');
    render(<SessionList rows={rows} empty="none" />);
    expect(screen.getByText('ended · inferred')).toBeTruthy();
    expect(screen.getByText('ended')).toBeTruthy();
  });

  it("the session's own page says an inferred end is an inference, and never prints an uncounted 0", () => {
    const { unmount } = render(<ForeignSessionPage session={inferred} allowAgent onResume={() => {}} />);
    expect(screen.getByText('unknown')).toBeTruthy();
    expect(screen.getByText(/its last sign of life; the process was found gone/)).toBeTruthy();
    expect(screen.getByText('ended · inferred')).toBeTruthy();
    unmount();
    render(<ForeignSessionPage session={reported} allowAgent onResume={() => {}} />);
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText(/reported by the session/)).toBeTruthy();
    expect(screen.queryByText(/found gone/)).toBeNull();
  });
});
