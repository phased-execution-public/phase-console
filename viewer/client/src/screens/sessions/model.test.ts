/**
 * Sessions' one vocabulary (7.0, quiet-console phase 15) — the fold, the
 * orders, the filters, the grouping and the page's one sentence, asserted
 * without a DOM, a pty or a socket.
 *
 * `sessionRows` is where "every process this console owns or can see" stops
 * being a sentence and becomes data. It moved here from `list.tsx`, and the
 * pure cases of 6.2's `list.test.tsx` moved with it. What is pinned:
 *
 *  - **four lists, one row.** The lanes, this console's ptys and the sessions
 *    the presence hook reported fold into one vocabulary, each row's word in
 *    its own vocabulary of the ONE status model — and the fold does not do the
 *    two things it must not: draw a lane twice, or give a process this console
 *    does not own a pty id (which is what offers its verbs);
 *  - **a session waiting on a person is first in EVERY order** — the fold's
 *    own and each of the three the toolbar offers — and the pin is not "live",
 *    because an order over the ended records is exactly what `created` is for;
 *  - **the two clocks are two questions.** `activity` reads the last thing that
 *    happened; `created` reads when the session began. Only a fixture where
 *    the two disagree can tell them apart;
 *  - **the kind order is the section order.** One list owns both
 *    (`SESSION_GROUPS`), so a fifth kind cannot be first in one and last in
 *    the other;
 *  - **search reaches the directory and both ids**, because eight shells
 *    labelled `zsh` are distinguishable by nothing else;
 *  - **the situation counts a summons once**, under "needs you", whatever its
 *    own word is, and says only the figures that are not zero.
 */

import { describe, expect, it } from 'vitest';
import { describeWord } from '@shared/status-model.js';
import type {
  AccountView,
  ForeignSession,
  PlanDetail,
  RunDetail,
  TerminalSession,
  VerifyingLane,
} from '@/data/api';
import { endedLabel, turnsLabel, type NowLane } from '@/data/lanes';
import {
  KIND_LABEL,
  KIND_ORDER,
  NO_FILTERS,
  SESSION_BADGES,
  SESSION_GROUPINGS,
  SESSION_GROUPS,
  SORTS,
  activeCount,
  applyFilters,
  attentionWords,
  foreignLabel,
  groupOf,
  groupSessionRows,
  isSortId,
  kindCounts,
  kindOf,
  sessionRows,
  sessionStateNote,
  sessionSummary,
  situationWords,
  sortRows,
  terminalWord,
  type SessionRow,
} from './model';

const NOW = Date.parse('2026-08-22T12:00:00Z');
/** An epoch-ms clock, N minutes before `NOW` — what a pty and a row carry. */
const ago = (minutes: number) => NOW - minutes * 60_000;
/** The same instant as ISO — what a lane, an approval and the registry carry. */
const at = (minutes: number) => new Date(ago(minutes)).toISOString();

const pty = (over: Partial<TerminalSession> & { id: string }): TerminalSession => ({
  label: over.id,
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  pid: 1,
  clients: 1,
  createdAt: ago(1),
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

/** A row as the orders, filters and groups read it — they never read its word, so any word will do. */
const row = (over: Partial<SessionRow> & Pick<SessionRow, 'key' | 'kind'>): SessionRow => ({
  label: over.key,
  // Every group kind is a badge word of its own; QA and Recovery are agents' finer words.
  badge: over.kind,
  href: '#/sessions/x',
  live: true,
  vocab: 'terminal',
  view: describeWord('terminal', 'running'),
  ...over,
});

describe('the fold — four lists into one', () => {
  it('folds all four kinds into one vocabulary, each word in its own vocabulary of the one model', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 'c1', label: 'Claude: hello', kind: 'claude' }), pty({ id: 's1' })],
      lanes: [lane({ phase: 3, title: 'Server B' })],
      foreign: [foreign({ sessionId: 'f1', owner: 'someone' })],
      now: NOW,
    });
    expect(rows.map((r) => r.kind)).toEqual(['lane', 'agent', 'shell', 'foreign']);
    // A lane's word is its phase's, a pty's the terminal's, a registry row's its presence.
    expect(rows.map((r) => [r.vocab, r.view.vocab])).toEqual([
      ['phase', 'phase'],
      ['terminal', 'terminal'],
      ['terminal', 'terminal'],
      ['presence', 'presence'],
    ]);
    // A lane is named by its plan and phase, with what the phase is beside it;
    // everything else by its own name, with its directory beside it.
    expect(rows[0]).toMatchObject({ label: 'Alpha P3', detail: 'Server B', note: null });
    expect(rows[3]).toMatchObject({ label: 'someone', detail: '/elsewhere' });
  });

  it('orders them: waiting on a person, then live, then by kind, then the most recent, then the name', () => {
    const rows = sessionRows({
      terminals: [
        pty({ id: 'old-shell', lastOutputAt: ago(30) }),
        pty({ id: 'new-shell', lastOutputAt: ago(2) }),
        pty({ id: 'gone', kind: 'claude', exited: { code: 0 }, exitedAt: ago(1) }),
      ],
      lanes: [lane({ phase: 7, startedAt: at(45) })],
      foreign: [foreign({ sessionId: 'asking', waiting: { since: at(3), kind: 'input' } })],
      now: NOW,
    });
    // The newest thing that ended sits under everything still alive, and the
    // one session that cannot move without you sits over all of it.
    expect(rows.map((r) => r.key)).toEqual([
      'foreign:asking',
      'lane:run-1#7',
      'pty:new-shell',
      'pty:old-shell',
      'pty:gone',
    ]);
    // With nothing else to tell two rows apart, the name does — never the arrival order.
    expect(
      sessionRows({ lanes: [lane({ phase: 2 }), lane({ phase: 1 })], now: NOW }).map((r) => r.key),
    ).toEqual(['lane:run-1#1', 'lane:run-1#2']);
  });

  it("carries a lane's task list, and only a lane's", () => {
    // A lane folded from a whole record carries its list (`nowLanes`); one
    // folded from the SLIM run list carries none, and its opened row reads the
    // whole record's instead (`list.tsx`, #234). Every other pty's list is its
    // own business, and the registry cannot see it.
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
    expect(rows.filter((r) => r.live)).toHaveLength(1);
  });

  it('says what a lane is doing when it is not simply running — its word, a freeze, or the console’s check', () => {
    const check: VerifyingLane = {
      phase: 4,
      purpose: 'baseline',
      command: 'pytest tests/unit',
      index: 9,
      total: 10,
      startedAt: at(3),
      commandStartedAt: at(1),
      pid: 77,
    };
    const rows = sessionRows({
      lanes: [
        lane({ phase: 1 }),
        lane({ phase: 2, status: 'parked' }),
        lane({ phase: 3, frozen: true }),
        // A phase whose only live work is the console's own check IS a lane,
        // and a live one (control-tower phase 105, #193).
        lane({ phase: 4, status: 'verifying', check }),
      ],
      now: NOW,
    });
    const by = (phase: number) => rows.find((r) => r.lane?.phase === phase)!;
    expect(by(1)).toMatchObject({ note: null, live: true });
    expect(by(2)).toMatchObject({ note: 'parked', live: false });
    expect(by(3).note).toBe('frozen');
    // No phase title yet, so the check is also the fact beside the name.
    expect(by(4)).toMatchObject({
      note: 'baseline 9/10 · pytest tests/unit',
      detail: 'baseline 9/10 · pytest tests/unit',
      live: true,
    });
    // What its expanded row reads the whole record by.
    expect(by(4).lane).toEqual({ slug: 'alpha', phase: 4, runId: 'run-1' });
  });

  it('reads two clocks off every kind: the last thing that happened, and when it began', () => {
    const rows = sessionRows({
      terminals: [
        pty({ id: 'printing', createdAt: ago(60), lastOutputAt: ago(2) }),
        pty({
          id: 'ended',
          createdAt: ago(60),
          lastOutputAt: ago(20),
          exited: { code: 0 },
          exitedAt: ago(10),
        }),
      ],
      lanes: [lane({ phase: 1, startedAt: at(45) }), lane({ phase: 2, status: 'queued' })],
      foreign: [foreign({ sessionId: 'f1', startedAt: at(300), lastSeen: at(4) })],
      now: NOW,
    });
    const clocks = (key: string) => {
      const found = rows.find((r) => r.key === key)!;
      return [found.startedAt, found.createdAt];
    };
    expect(clocks('pty:printing')).toEqual([ago(2), ago(60)]);
    // An end is the last thing that happened to a pty, whatever it printed before.
    expect(clocks('pty:ended')).toEqual([ago(10), ago(60)]);
    expect(clocks('lane:run-1#1')).toEqual([ago(45), ago(45)]);
    // A lane that has not started has no clock at all, rather than the epoch.
    expect(clocks('lane:run-1#2')).toEqual([undefined, undefined]);
    expect(clocks('foreign:f1')).toEqual([ago(4), ago(300)]);
  });

  it('addresses a console-owned pty by id and sends everything else to its own page', () => {
    const rows = sessionRows({
      terminals: [pty({ id: 's1' })],
      lanes: [lane({ phase: 3 })],
      foreign: [foreign({ sessionId: 'f1', plan: { slug: 'beta', phase: 2, strong: true } })],
      now: NOW,
    });
    const by = (kind: string) => rows.find((r) => r.kind === kind)!;
    // The only rows with an `id` are the ones `#/sessions/:id` can open — which
    // is also what decides whether a pty's verbs are offered.
    expect(by('shell').id).toBe('s1');
    expect(by('shell').href).toBe('#/sessions/s1');
    expect(by('lane').id).toBeUndefined();
    expect(by('lane').href).toBe('#/plan/alpha/run');
    expect(by('foreign').id).toBeUndefined();
    // The PHASE, not the plan's run tab: a correlated session works one phase,
    // and the row in the incident linked at the page the operator was on.
    expect(by('foreign').href).toBe('#/plan/beta/phase/2');
    expect(by('foreign').label).toBe('beta P2');
    // …and it ALSO carries the conversation, which is a different thing from
    // `id`: there is no pty to close, so it must not reach a pty's verbs — but
    // `#/sessions/<conversation>` is a real page.
    expect(by('foreign').sessionId).toBe('f1');
  });

  it('sends an uncorrelated foreign row to its own page, not back to this one', () => {
    // `sessionsHref()` with no id is `#/sessions` — the page the row was
    // clicked ON. That is the incident's own defect at its smallest, and it
    // survived because an uncorrelated row had nowhere better to go until the
    // session itself had a page.
    const rows = sessionRows({ foreign: [foreign({ sessionId: 'f1' })], now: NOW });
    expect(rows[0]!.href).toBe('#/sessions/f1');
    expect(rows[0]!.sessionId).toBe('f1');
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
    // Nor a live session working a plan whose lane is already on the list,
    // whatever its own id: the lane's row is where that work is drawn.
    const again = sessionRows({
      lanes: [lane({ phase: 3 })],
      foreign: [foreign({ sessionId: 'y1', plan: { slug: 'alpha', phase: 3, strong: false } })],
      now: NOW,
    });
    expect(again.map((r) => r.kind)).toEqual(['lane']);
  });

  it('keeps an hour of what ended, and no more', () => {
    const rows = sessionRows({
      foreign: [
        foreign({ sessionId: 'just-left', presence: 'ended', endedAt: at(30), lastSeen: at(30) }),
        foreign({ sessionId: 'long-gone', presence: 'ended', endedAt: at(90), lastSeen: at(90) }),
      ],
      now: NOW,
    });
    expect(rows.map((r) => r.sessionId)).toEqual(['just-left']);
  });

  it('is empty rather than undefined when the console can see nothing', () => {
    expect(sessionRows({ now: NOW })).toEqual([]);
  });
});

describe('status and the summons', () => {
  it('paints each row through the status vocabulary — a queued lane is queued, an exited-nonzero shell failed', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 2, status: 'queued' })],
      terminals: [pty({ id: 't1', exited: { code: 1 }, exitedAt: NOW - 1000 })],
      // `unknown` presence never reaches the list (`otherSessions` keeps only
      // the live and the recently ended), so the reachable dead state is `ended`.
      foreign: [foreign({ sessionId: 'f1', presence: 'ended', endedAt: at(2), lastSeen: at(1) })],
      now: NOW,
    });
    // Each kind speaks its own vocabulary of the ONE model (control-tower phase 24).
    expect(rows.find((r) => r.kind === 'lane')?.view).toMatchObject({ vocab: 'phase', word: 'queued' });
    expect(rows.find((r) => r.kind === 'shell')?.view).toMatchObject({
      vocab: 'terminal',
      word: 'failed',
      paint: 'failed',
    });
    expect(rows.find((r) => r.kind === 'foreign')?.view).toMatchObject({ vocab: 'presence', word: 'ended' });
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
    const waiting = rows[0]!;
    expect(waiting.label).toContain('P2');
    // The word stays the phase's; the summons is the attention the row carries.
    expect(waiting.view).toMatchObject({ vocab: 'phase', word: 'running' });
    expect(waiting.attention).toEqual({ kind: 'permission', since: at(1) });
    expect(rows[1]!.attention).toBeUndefined();
  });

  it('reads a card that names no phase as every lane of its run, and no other run’s', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 1 }), lane({ phase: 2 }), lane({ phase: 1, key: 'run-2#1', runId: 'run-2' })],
      approvals: [{ status: 'pending', runId: 'run-1', phase: null, createdAt: at(1) }],
      now: NOW,
    });
    expect(rows.filter((r) => r.attention).map((r) => r.key)).toEqual(['lane:run-1#1', 'lane:run-1#2']);
  });

  it("reads the registry's waiting field as attention, with the CLI's own words as the note", () => {
    const rows = sessionRows({
      foreign: [
        foreign({
          sessionId: 'f1',
          waiting: { since: at(2), kind: 'input', note: 'Claude is waiting for your input' },
        }),
        // A wait the registry still holds on an ENDED session asks nobody anything.
        foreign({
          sessionId: 'f2',
          presence: 'ended',
          endedAt: at(3),
          waiting: { since: at(9), kind: 'permission' },
        }),
      ],
      now: NOW,
    });
    expect(rows[0]!.view).toMatchObject({ vocab: 'presence', word: 'live' });
    expect(rows[0]!.attention).toEqual({ kind: 'input', since: at(2) });
    expect(rows[0]!.note).toBe('Claude is waiting for your input');
    expect(rows[1]!.attention).toBeUndefined();
    expect(rows[1]!.note).toBe('ended');
  });

  it('says what a session waits on a person for, in words', () => {
    expect(attentionWords({ kind: 'permission' })).toBe('needs your permission');
    expect(attentionWords({ kind: 'input', since: at(1) })).toBe('needs your answer');
  });
});

describe("a pty's word", () => {
  it('reads the exit code, never the signal — "you closed it" is not "it failed"', () => {
    const cases: [TerminalSession, ReturnType<typeof terminalWord>, string | null][] = [
      [pty({ id: 'a' }), 'running', null],
      [pty({ id: 'b', frozen: { at: ago(2), by: 'me', escalateAt: at(-5) } }), 'frozen', 'frozen'],
      [pty({ id: 'c', stopping: { at: ago(1), by: 'me' } }), 'stopping', 'stopping'],
      // Closed by the operator: it dies by signal, and its code is still 0.
      [pty({ id: 'd', exited: { code: 0, signal: 15, closedByOperator: true } }), 'exited', 'ended'],
      [pty({ id: 'e', exited: { code: 1 } }), 'failed', 'ended'],
      // The end decides before a freeze the record still carries.
      [
        pty({ id: 'f', exited: { code: 0 }, frozen: { at: ago(9), by: 'me', escalateAt: at(1) } }),
        'exited',
        'ended',
      ],
    ];
    for (const [session, word, note] of cases) {
      expect([session.id, terminalWord(session), sessionStateNote(session)]).toEqual([
        session.id,
        word,
        note,
      ]);
    }
  });
});

describe('what a foreign session is called', () => {
  it('names the phase it works, else who owns it, else what it is', () => {
    expect(
      foreignLabel({ kind: 'foreign', owner: 'someone', plan: { slug: 'beta', phase: 2, strong: false } }),
    ).toBe('beta P2');
    expect(foreignLabel({ kind: 'foreign', owner: 'someone' })).toBe('someone');
    expect(foreignLabel({ kind: 'foreign' })).toBe('Terminal session');
    expect(foreignLabel({ kind: 'agent' })).toBe('Console agent');
    expect(foreignLabel({ kind: 'autopilot' })).toBe('Autopilot session');
  });
});

/**
 * ACC-7.7 (REG-9). A probe-detected death used to be stamped with the moment
 * somebody LOOKED — one record claimed 17.3 hours it never lived — and `turns
 * 0` described a twelve-hour session in the same words as a five-second probe.
 * The registry now writes an inferred end as one, and says where a turn count
 * came from; the rows here, and the list and the session's own page
 * (`list.test.tsx`), draw both differently from what a session reported.
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

  it('notes the two ends differently on the rows', () => {
    const rows = sessionRows({ foreign: [reported, inferred], now: NOW });
    expect(rows.find((r) => r.sessionId === 'f-reported')?.note).toBe('ended');
    expect(rows.find((r) => r.sessionId === 'f-inferred')?.note).toBe('ended · inferred');
  });
});

describe('the orders', () => {
  it('offers three, and the first one declared is what an unknown preference falls back to', () => {
    expect(SORTS.map((s) => [s.id, s.label])).toEqual([
      ['activity', 'Activity'],
      ['created', 'Started'],
      ['kind', 'Kind'],
    ]);
    expect(isSortId('activity')).toBe(true);
    expect(isSortId('whatever-a-later-build-called-it')).toBe(false);
    const rows = [row({ key: 'a', kind: 'shell', startedAt: ago(1) })];
    // A stored id this build no longer offers must not empty the list.
    expect(sortRows(rows, 'retired-order')).toHaveLength(1);
  });

  it('puts a session waiting on a person first, in every order', () => {
    const rows = [
      row({ key: 'busy', kind: 'lane', startedAt: ago(1), createdAt: ago(1) }),
      row({
        key: 'asking',
        kind: 'foreign',
        startedAt: ago(90),
        createdAt: ago(600),
        attention: { kind: 'permission' },
      }),
    ];
    for (const sort of SORTS) expect(sortRows(rows, sort.id)[0]!.key).toBe('asking');
  });

  it('reads two different clocks — the quietest is not the oldest', () => {
    const rows = [
      // Opened this morning, and printed a minute ago.
      row({ key: 'morning', kind: 'shell', startedAt: ago(1), createdAt: ago(480) }),
      // Opened five minutes ago, and silent for four.
      row({ key: 'fresh', kind: 'shell', startedAt: ago(4), createdAt: ago(5) }),
    ];
    expect(sortRows(rows, 'activity').map((r) => r.key)).toEqual(['morning', 'fresh']);
    expect(sortRows(rows, 'created').map((r) => r.key)).toEqual(['fresh', 'morning']);
    // …and the oldest is at the bottom of `created`, which is the whole point.
    expect(sortRows(rows, 'created').at(-1)!.key).toBe('morning');
  });

  it('sinks what has ended below what is live, without making that the pin', () => {
    const rows = [
      row({ key: 'ended', kind: 'shell', live: false, startedAt: ago(1), createdAt: ago(2) }),
      row({ key: 'live', kind: 'shell', live: true, startedAt: ago(60), createdAt: ago(90) }),
    ];
    expect(sortRows(rows, 'activity').map((r) => r.key)).toEqual(['live', 'ended']);
    // `kind` leads with the kind, so two shells fall back to live-first too.
    expect(sortRows(rows, 'kind').map((r) => r.key)).toEqual(['live', 'ended']);
  });

  it('orders kinds the way the sections do — one list owns both', () => {
    const rows = [...SESSION_GROUPS]
      .reverse()
      .map((group) => row({ key: group.kind, kind: group.kind, startedAt: ago(1) }));
    expect(sortRows(rows, 'kind').map((r) => r.kind)).toEqual(SESSION_GROUPS.map((g) => g.kind));
    // Each kind's place and heading are derived from that one list, never re-spelled.
    expect(KIND_ORDER).toEqual({ lane: 0, agent: 1, shell: 2, foreign: 3 });
    expect(KIND_LABEL).toEqual(Object.fromEntries(SESSION_GROUPS.map((g) => [g.kind, g.title])));
    expect(Object.isFrozen(KIND_ORDER) && Object.isFrozen(KIND_LABEL)).toBe(true);
    expect(SESSION_GROUPS.map((g) => g.short)).toEqual(['Lanes', 'Agents', 'Shells', 'Others']);
  });
});

describe('the filters', () => {
  const rows = [
    row({ key: 'lane', kind: 'lane', label: 'Alpha P3', detail: 'Wire the runner' }),
    row({ key: 'shell', kind: 'shell', label: 'zsh', detail: '/repo/beta', id: 'pty-771' }),
    row({ key: 'other', kind: 'foreign', label: 'someone', detail: '/elsewhere', sessionId: 'c0ffee' }),
  ];

  it('narrows nothing at rest', () => {
    expect(applyFilters(rows, NO_FILTERS)).toHaveLength(3);
    expect(activeCount(NO_FILTERS)).toBe(0);
  });

  it('finds a shell by the only thing that distinguishes it — its directory', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'beta' }).map((r) => r.key)).toEqual(['shell']);
  });

  it('finds a session by the pty id and by the conversation id', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'pty-771' }).map((r) => r.key)).toEqual(['shell']);
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'c0ffee' }).map((r) => r.key)).toEqual(['other']);
  });

  it('matches words in any order, so a half-remembered name still lands', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, query: 'p3 alpha' }).map((r) => r.key)).toEqual(['lane']);
  });

  it('keeps one kind, and counts as one filter set', () => {
    expect(applyFilters(rows, { ...NO_FILTERS, kind: 'foreign' }).map((r) => r.key)).toEqual(['other']);
    expect(activeCount({ query: 'x', kind: 'lane' })).toBe(2);
  });

  it('reads a stored kind the list offers, and any other word as every kind', () => {
    expect(kindOf('shell')).toBe('shell');
    expect(kindOf('')).toBe('');
    expect(kindOf(undefined)).toBe('');
    // A kind a later build retired must not empty the list it was left set on.
    expect(kindOf('retired-kind')).toBe('');
    expect(applyFilters(rows, { ...NO_FILTERS, kind: kindOf('retired-kind') })).toHaveLength(3);
  });

  it('counts every kind, including the ones with nothing in them', () => {
    const counts = kindCounts(rows);
    expect(counts).toEqual({ lane: 1, agent: 0, shell: 1, foreign: 1 });
    // Total, so a filter can never claim more than the list holds.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });
});

describe('the grouping', () => {
  it('offers two shapes, and reads the 3.0 boolean as one of them', () => {
    expect(SESSION_GROUPINGS.map((g) => [g.id, g.label])).toEqual([
      ['kind', 'Kind'],
      ['none', 'None'],
    ]);
    // `prefs.sessionsGroup` was a boolean before there was a choice to make;
    // unset is where the page has always opened — a section per kind.
    expect(groupOf(undefined)).toBe('kind');
    expect(groupOf(true)).toBe('kind');
    expect(groupOf(false)).toBe('none');
  });

  it('groups by kind in the kinds’ order, keeping the order it was handed, with no section for an empty kind', () => {
    const rows = [
      row({ key: 'f', kind: 'foreign' }),
      row({ key: 's1', kind: 'shell' }),
      row({ key: 'l', kind: 'lane' }),
      row({ key: 's2', kind: 'shell' }),
    ];
    expect(groupSessionRows(rows, 'kind').map((g) => [g.key, g.label, g.rows.map((r) => r.key)])).toEqual([
      ['lane', 'Autopilot lanes', ['l']],
      ['shell', 'Shells', ['s1', 's2']],
      ['foreign', 'Other sessions on this machine', ['f']],
    ]);
    // Ungrouped, one list in the order it came — the chosen order, whole.
    expect(groupSessionRows(rows, 'none').map((g) => [g.key, g.label, g.rows.map((r) => r.key)])).toEqual([
      ['all', 'Sessions', ['f', 's1', 'l', 's2']],
    ]);
  });
});

describe('the situation', () => {
  it('says the page in one sentence, and counts a summons once, under "needs you"', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 1 }), lane({ phase: 2, status: 'queued' })],
      terminals: [
        pty({ id: 'zsh' }),
        pty({ id: 'done', exited: { code: 0 }, exitedAt: ago(5) }),
        pty({ id: 'broke', exited: { code: 1 }, exitedAt: ago(9) }),
      ],
      foreign: [
        // Live, and stopped on a person: "needs you", never "running" as well.
        foreign({ sessionId: 'asking', waiting: { since: at(2), kind: 'permission' } }),
        foreign({ sessionId: 'quiet' }),
      ],
      now: NOW,
    });
    expect(situationWords(rows)).toBe('1 needs you, 3 running, 1 waiting and 2 ended.');
  });

  it('counts a frozen process as waiting, never running — a pty and a lane alike', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 1 }), lane({ phase: 2, frozen: true })],
      terminals: [
        pty({ id: 'zsh' }),
        pty({ id: 'held', frozen: { at: ago(2), by: 'me', escalateAt: at(-5) } }),
      ],
      now: NOW,
    });
    // Both frozen rows are still live (no exit yet); the sentence follows what they say.
    expect(rows.filter((r) => r.live)).toHaveLength(4);
    expect(situationWords(rows)).toBe('2 running and 2 waiting.');
  });

  it('says only the figures that are not zero, and nothing about nothing', () => {
    const live = (key: string) => row({ key, kind: 'shell' });
    const asking = (key: string) => row({ key, kind: 'foreign', attention: { kind: 'input' } });
    expect(situationWords([live('a'), live('b')])).toBe('2 running.');
    expect(situationWords([asking('a'), asking('b')])).toBe('2 need you.');
    expect(situationWords([asking('a'), live('b')])).toBe('1 needs you and 1 running.');
    expect(situationWords([])).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * #369 — the row carries what the run record holds
 * ------------------------------------------------------------------ */

/**
 * The Sessions tables showed four facts and a dot though the run record holds
 * the account, the model, the spend, the context and the task list (#369).
 * The fold reads them ONCE, into the row, so the list, the inspector and the
 * phone's records read one row: these cases hold the row model against a
 * phase record's own fields.
 */
describe('the row carries what the run record holds (#369)', () => {
  const tasks = [
    ...['one', 'two', 'three', 'four'].map((content, i) => ({ id: `t${i}`, content, status: 'completed' })),
    { id: 't4', content: 'wire the meter', activeForm: 'Wiring the meter', status: 'in_progress' },
    { id: 't5', content: 'six', status: 'pending' },
    { id: 't6', content: 'seven', status: 'pending' },
  ];
  const record = {
    phase: 3,
    status: 'running',
    attempts: 2,
    turns: 41,
    costUsd: 1.5,
    model: 'opus',
    actualModel: 'claude-opus-5-5[1m]',
    effort: 'high',
    sessionAccountId: 'acct-b',
    sessionId: 'conv-3',
    tasks,
    phaseClocks: { workedMs: 12 * 60_000 },
    // The `run:progress` overlay: this session's unbooked dollars and its newest context.
    live: { spentUsd: 0.25, contextTokens: 300_000 },
    tokens: [{ window: 1_000_000, lastContext: 120_000 }],
  };
  const detail = (over: Record<string, unknown> = {}) =>
    ({
      run: {
        id: 'run-1',
        slug: 'alpha',
        accountId: 'acct-run',
        workRoot: '/work/.worktrees/runs/alpha/run-1',
        phases: { '3': record },
      },
      history: [],
      eta: null,
      phaseEta: [{ phase: 3, weight: 1, estMs: 40 * 60_000, basis: 'history', clock: 'working', label: '' }],
      liveness: [{ phase: 3, tokens: { context: 200_000, peak: 210_000, window: 1_000_000 }, spentUsd: 0.1 }],
      ...over,
    }) as unknown as RunDetail;
  const accounts = [{ id: 'acct-b', name: 'Work login' }] as unknown as AccountView[];

  it("folds a lane's account, model and effort, spend, context, progress and clocks from its phase record", () => {
    const [r] = sessionRows({
      lanes: [lane({ phase: 3, slim: true })],
      records: new Map([['alpha', detail()]]),
      accounts,
      now: NOW,
    });
    expect(r).toMatchObject({
      badge: 'lane',
      // The account the SESSION ran on, named as the registry names it — not the run's default.
      account: { id: 'acct-b', name: 'Work login' },
      // What the session's own `init` said it runs on beats what it was asked for.
      model: 'claude-opus-5-5[1m]',
      effort: 'high',
      // Booked, plus this session's unbooked dollars.
      spendUsd: 1.75,
      // The newest context against the window the server judged it by.
      context: { tokens: 300_000, window: 1_000_000 },
      progress: { done: 4, total: 7, active: 'Wiring the meter' },
      workedMs: 12 * 60_000,
      estimateMs: 40 * 60_000,
      attempts: 2,
      turns: 41,
      conversation: 'conv-3',
      worktree: '/work/.worktrees/runs/alpha/run-1',
      tasks,
    });
  });

  it('takes the phase title from the plan detail when the slim lane has none', () => {
    const details = new Map([
      ['alpha', { phases: [{ phase: 3, title: 'Server B' }] } as unknown as PlanDetail],
    ]);
    const [r] = sessionRows({ lanes: [lane({ phase: 3, slim: true })], details, now: NOW });
    expect(r?.detail).toBe('Server B');
  });

  it("never reads another run's record onto a lane", () => {
    const other = detail();
    (other.run as { id: string }).id = 'run-0';
    const [r] = sessionRows({
      lanes: [lane({ phase: 3, slim: true })],
      records: new Map([['alpha', other]]),
      now: NOW,
    });
    expect(r?.account).toBeUndefined();
    expect(r?.progress).toBeUndefined();
    expect(r?.attempts).toBeUndefined();
    expect(r?.worktree).toBeUndefined();
  });

  it("reads a slim lane's live facts before its record lands — and never a slim lane's zeroes as facts", () => {
    const [r] = sessionRows({
      lanes: [
        lane({
          phase: 3,
          slim: true,
          model: 'opus',
          effort: 'max',
          liveness: {
            phase: 3,
            lastOutputAt: at(1),
            turnsSinceLastTool: 0,
            commitsSinceStart: 0,
            treeDirty: false,
            tokens: {
              context: 50_000,
              peak: 50_000,
              calls: 3,
              rebuilds: 0,
              input: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              pollCalls: 0,
              window: 200_000,
            },
            spentUsd: 0.4,
          },
        }),
      ],
      now: NOW,
    });
    expect(r).toMatchObject({
      model: 'opus',
      effort: 'max',
      spendUsd: 0.4,
      context: { tokens: 50_000, window: 200_000 },
    });
    // A slim row's `costUsd: 0` and `attempts: 0` are "not read yet", never a measurement.
    expect(r?.attempts).toBeUndefined();
    expect(r?.progress).toBeUndefined();
  });

  it('badges each process by what it is: lane, shell, agent, QA, recovery, foreign', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 1 }), lane({ phase: 2, qa: { round: 1 } })],
      terminals: [
        pty({ id: 's1' }),
        pty({
          id: 'a1',
          kind: 'claude',
          meta: { model: 'sonnet', effort: 'low', claudeSessionId: 'conv-a' },
        }),
        pty({ id: 'q1', kind: 'claude', meta: { qa: { slug: 'alpha', phase: 2 } } }),
        pty({ id: 'r1', kind: 'claude', meta: { recovery: { kind: 'halt', slug: 'alpha' } } }),
      ],
      foreign: [foreign({ sessionId: 'f1' })],
      now: NOW,
    });
    const badgeOf = (key: string) => rows.find((r) => r.key === key)?.badge;
    expect(badgeOf('lane:run-1#1')).toBe('lane');
    expect(badgeOf('lane:run-1#2')).toBe('qa');
    expect(badgeOf('pty:s1')).toBe('shell');
    expect(badgeOf('pty:a1')).toBe('agent');
    expect(badgeOf('pty:q1')).toBe('qa');
    expect(badgeOf('pty:r1')).toBe('recovery');
    expect(badgeOf('foreign:f1')).toBe('foreign');
    // Every badge has its word; an agent pty carries the model it was launched on and its conversation.
    for (const r of rows) expect(SESSION_BADGES[r.badge].label).toBeTruthy();
    expect(rows.find((r) => r.key === 'pty:a1')).toMatchObject({
      model: 'sonnet',
      effort: 'low',
      conversation: 'conv-a',
    });
    expect(rows.find((r) => r.key === 'foreign:f1')).toMatchObject({ conversation: 'f1', turns: 3 });
  });

  it('sums the strip: live lanes, shells, agents, others, who waits on a person, accounts in use', () => {
    const rows = sessionRows({
      lanes: [lane({ phase: 3, slim: true }), lane({ phase: 4, slim: true, status: 'queued' })],
      records: new Map([['alpha', detail()]]),
      accounts,
      terminals: [pty({ id: 's1' }), pty({ id: 'gone', exited: { code: 0 }, exitedAt: ago(1) })],
      foreign: [foreign({ sessionId: 'asking', waiting: { since: at(2), kind: 'permission' } })],
      now: NOW,
    });
    expect(sessionSummary(rows)).toEqual({
      lanes: 1,
      shells: 1,
      agents: 0,
      foreign: 1,
      waiting: 1,
      accounts: 1,
    });
  });
});
