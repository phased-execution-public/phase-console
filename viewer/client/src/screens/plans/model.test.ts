/**
 * The library's model (quiet-console phase 9) — the properties that are
 * invisible until they are wrong, carried from 6.2's list and joined by 7.0's:
 *
 * - a ready list is phase NUMBERS, a title is markdown on disk, a plan joins
 *   its NEWEST run (by when it was made, whatever the list's order);
 * - the mark: a person waited on leads, then a run that has not settled, then
 *   the plan's own word; a document has a kind, never a status;
 * - the counts (#360): every board bucket a segment in proportion, held by QA
 *   carved out of done, gated a mark over next up and waiting, a closed plan's
 *   what got done and what never ran, an unread board its last reading and a
 *   hatch — the segments always summing to the phase count;
 * - the five orders lead with five different plans; the filters say what they
 *   hide, measured; the closed estate and the documents fold under the list,
 *   narrowed by the same search, never twice on one page.
 */

import { describe, expect, it } from 'vitest';
import type { InboxItem, PlanSummaryFull, SlimRun } from '@/data/api';
import {
  CLOSED_ONLY,
  NO_FILTERS,
  OPEN_ONLY,
  activeCount,
  applyFilters,
  concerns,
  estateOf,
  groupRows,
  hiddenBreakdown,
  layoutOf,
  leftWords,
  countsLabel,
  countsOf,
  legendOf,
  segmentsOf,
  markKind,
  markLabel,
  matchesPlan,
  repoLabel,
  repoOptions,
  rowTotals,
  sortRows,
  statusOptions,
  toRows,
  workSentence,
  type PlanRow,
} from './model';
import { BOARD_STATE_UI } from '@shared/status-vocab.js';
import { describeWord } from '@shared/status-model.js';

const plan = (over: Partial<PlanSummaryFull> = {}): PlanSummaryFull => ({
  slug: 'alpha',
  title: 'Alpha plan',
  kind: 'plan',
  status: 'active',
  activity: Date.UTC(2026, 7, 3),
  phases: 4,
  done: 1,
  ready: [2],
  waiting: 2,
  inProgress: [],
  stuck: [],
  percent: 25,
  remainingWeight: 120_000,
  remainingSessions: 2,
  criticalPath: [2],
  criticalWeight: 40_000,
  minimumSessions: 1,
  budget: 200_000,
  skills: [],
  mcpServers: [],
  qaMode: 'off',
  qaFailures: [],
  locks: [],
  repos: ['hub'],
  handoffCount: 0,
  issues: [],
  issueCounts: { error: 0, warning: 0, info: 0 },
  hasHandoffs: false,
  ...over,
});

/** A run as the SLIM list carries it — one word per phase. */
const run = (over: Partial<SlimRun> = {}): SlimRun =>
  ({
    id: 'r1',
    slug: 'alpha',
    status: 'running',
    activePhase: 2,
    halt: null,
    children: {},
    verifying: {},
    liveness: [],
    phases: { '1': 'done', '2': 'running' },
    records: {},
    waitUntil: null,
    accountId: null,
    consecutiveFailures: 0,
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T01:00:00Z',
    finishedReason: null,
    resolved: false,
    stoppedBy: null,
    onLimit: null,
    waitReason: null,
    hold: null,
    spentUsd: 0,
    liveUsd: 0,
    runBudgetUsd: null,
    workedMs: null,
    model: 'opus',
    effort: null,
    maxConsecutiveFailures: 2,
    undriven: [],
    ...over,
  }) as unknown as SlimRun;

const NOW = Date.UTC(2026, 7, 3, 12);

describe('building a row', () => {
  it('reads ready as phase numbers, strips the markdown from a title and falls back to the slug', () => {
    const [row] = toRows([plan({ ready: [2, 3], title: '**Alpha** plan `v2`' })], [], NOW);
    expect(row.readyPhases).toEqual([2, 3]);
    expect(row.title).toBe('Alpha plan v2');
    expect(toRows([plan({ title: '' })], [], NOW)[0].title).toBe('alpha');
  });

  it('joins the newest run by when it was made, whatever order the list came in', () => {
    const [row] = toRows(
      [plan()],
      [
        run({ id: 'old', status: 'finished', createdAt: '2026-08-01T00:00:00Z' }),
        run({ id: 'new', status: 'running', createdAt: '2026-08-03T00:00:00Z' }),
      ],
      NOW,
    );
    expect(row.run?.id).toBe('new');
    expect(row.run?.view.label).toBe('Running');
    expect(row.run?.view.paint).toBe('running');
  });

  it('counts an unreadable plan as an error even when its issue list is empty', () => {
    const [row] = toRows([plan({ engineError: 'phase table did not parse' })], [], NOW);
    expect(row.errors).toBe(1);
    expect(row.firstIssue).toBe('phase table did not parse');
  });

  it('separates closure from completeness', () => {
    const [finished] = toRows([plan({ phases: 4, done: 4, ready: [] })], [], NOW);
    expect([finished.isComplete, finished.isClosed]).toEqual([true, false]);
    const [walkedAway] = toRows([plan({ status: 'abandoned', phases: 4, done: 1 })], [], NOW);
    expect([walkedAway.isComplete, walkedAway.isClosed]).toEqual([false, true]);
    // The server's own closed flag wins over the word.
    expect(toRows([plan({ status: 'shelved', closed: true })], [], NOW)[0].isClosed).toBe(true);
  });

  it('counts what waits on a person per plan, never a closed plan’s and never a mere fyi', () => {
    const inbox = [
      { slug: 'alpha', severity: 'needs-you' },
      { slug: 'alpha', severity: 'fyi' },
      { slug: 'gone', severity: 'needs-you' },
    ] as unknown as InboxItem[];
    const rows = toRows([plan(), plan({ slug: 'gone', status: 'abandoned' })], [], NOW, inbox);
    expect(rows.map((r) => r.needsYou)).toEqual([1, 0]);
  });
});

describe('the mark — which word leads a row', () => {
  it('says a person is waited on before anything else, and only on an open plan', () => {
    const inbox = [{ slug: 'alpha', severity: 'needs-you' }] as unknown as InboxItem[];
    const [row] = toRows([plan()], [run()], NOW, inbox);
    expect(markKind(row)).toBe('attention');
    expect(markLabel(row)).toBe('Needs you');
  });

  it('lets a run that has not settled speak, and the plan’s own word once it has', () => {
    expect(markKind(toRows([plan()], [run({ status: 'running' })], NOW)[0])).toBe('run');
    const [settled] = toRows(
      [plan()],
      [run({ status: 'finished', phases: { '1': 'done', '2': 'done' } })],
      NOW,
    );
    expect(markKind(settled)).toBe('plan');
    expect(markLabel(settled)).toBe('Active');
    // A closed plan's run is overtaken by the closure: the plan's word leads.
    const [closed] = toRows([plan({ status: 'complete' })], [run({ status: 'halted' })], NOW);
    expect([markKind(closed), markLabel(closed)]).toEqual(['plan', 'Complete']);
  });

  it('gives a document its kind, never a status', () => {
    const [doc] = toRows([plan({ kind: 'document', phases: 0, ready: [] })], [], NOW);
    expect([markKind(doc), markLabel(doc)]).toEqual(['kind', 'Document']);
  });
});

describe('the counts — every phase in proportion (#360)', () => {
  /** What the track draws, summed: it must be the phase count, whatever the board says. */
  const drawn = (row: PlanRow): number => segmentsOf(countsOf(row)).reduce((sum, s) => sum + s.count, 0);

  it('counts every bucket, and keeps the waiting phases apart from what is left', () => {
    const [row] = toRows(
      [
        plan({
          phases: 72,
          done: 41,
          inProgress: [42],
          stuck: [50, 51],
          ready: [43],
          waiting: 3,
          percent: 57,
        }),
      ],
      [],
      NOW,
    );
    expect(countsOf(row)).toMatchObject({
      phases: 72,
      known: true,
      closed: false,
      done: 41,
      heldByQa: 0,
      inProgress: 1,
      stuck: 2,
      ready: 1,
      waiting: 3,
      gated: 0,
      rest: 24,
      neverRan: 0,
      unread: 0,
      percent: 57,
    });
    expect(legendOf(row)).toBe('41 done · 1 in progress · 2 stuck · 1 next up · 3 waiting · 24 left · 57 %');
    expect(segmentsOf(countsOf(row)).map((s) => [s.key, s.count])).toEqual([
      ['done', 41],
      ['in-progress', 1],
      ['stuck', 2],
      ['ready', 1],
      ['waiting', 3],
      ['rest', 24],
    ]);
  });

  it('paints each segment from the board’s own table, and QA’s hold as QA words a fail', () => {
    const [row] = toRows(
      [plan({ phases: 9, done: 3, inProgress: [4], stuck: [5], ready: [6], waiting: 2, qaFailures: [2] })],
      [],
      NOW,
    );
    expect(Object.fromEntries(segmentsOf(countsOf(row)).map((s) => [s.key, s.paint]))).toEqual({
      done: BOARD_STATE_UI.done,
      'held-by-qa': describeWord('qa-result', 'fail').paint,
      'in-progress': BOARD_STATE_UI['in-progress'],
      stuck: BOARD_STATE_UI.stuck,
      ready: BOARD_STATE_UI.ready,
      waiting: BOARD_STATE_UI.waiting,
      // What no bucket accounts for is the bare track: unpainted, no state claimed.
      rest: null,
    });
  });

  it('carves a phase held by QA out of done — its own segment, never counted twice', () => {
    const [row] = toRows(
      [plan({ phases: 10, done: 6, ready: [7], waiting: 3, qaFailures: [4, 4, 6], percent: 60 })],
      [],
      NOW,
    );
    const counts = countsOf(row);
    expect([counts.done, counts.heldByQa, counts.waiting]).toEqual([4, 2, 3]);
    expect(legendOf(row)).toBe('4 done · 2 held by QA · 1 next up · 3 waiting · 60 %');
    expect(drawn(row)).toBe(10);
    // A failed phase the board already names as standing is not held twice.
    const [standing] = toRows(
      [plan({ phases: 4, done: 1, stuck: [2], ready: [], waiting: 1, qaFailures: [2] })],
      [],
      NOW,
    );
    expect(countsOf(standing).heldByQa).toBe(0);
  });

  it('reads a gated phase as a mark over next up and waiting, never as a segment of its own', () => {
    const summary = { ...plan({ phases: 6, done: 2, ready: [3, 4], waiting: 2 }), gated: [4, 5] };
    const [row] = toRows([summary], [], NOW);
    const counts = countsOf(row);
    expect(counts.gated).toBe(2);
    expect(segmentsOf(counts).map((s) => s.key)).not.toContain('gated');
    expect(drawn(row)).toBe(6);
    expect(legendOf(row)).toBe('2 done · 2 next up · 2 waiting · 2 gated · 25 %');
    // The list sends no gate words today: no mark, nothing claimed.
    expect(countsOf(toRows([plan()], [], NOW)[0]).gated).toBe(0);
  });

  it('adds up to the phase count for open, complete, closed and unread boards', () => {
    const at = NOW - 3_600_000;
    const rows = toRows(
      [
        plan({
          slug: 'open',
          phases: 12,
          done: 5,
          inProgress: [6],
          stuck: [7],
          ready: [8],
          waiting: 4,
          qaFailures: [3],
        }),
        plan({
          slug: 'complete',
          status: 'complete',
          phases: 7,
          done: 7,
          ready: [],
          waiting: 0,
          percent: 100,
        }),
        plan({
          slug: 'closed',
          status: 'abandoned',
          phases: 9,
          done: 2,
          ready: [3, 4],
          waiting: 5,
          qaFailures: [1],
        }),
        plan({
          slug: 'unread',
          phases: 8,
          progress: 'unknown',
          done: null,
          percent: null,
          lastGood: { done: 3, phases: 8, percent: 38, at, ageMs: 0 },
        }),
        plan({
          slug: 'blind',
          phases: 5,
          progress: 'unknown',
          done: null,
          percent: null,
          ready: [],
          waiting: 0,
        }),
        // A board that over-counts (an older server) still draws exactly the phases.
        plan({ slug: 'over', phases: 4, done: 3, inProgress: [4], ready: [5], waiting: 3 }),
      ],
      [],
      NOW,
    );
    expect(rows.map((row) => [row.slug, drawn(row)])).toEqual([
      ['open', 12],
      ['complete', 7],
      ['closed', 9],
      ['unread', 8],
      ['blind', 5],
      ['over', 4],
    ]);
  });

  it('words a closed plan as what got done and what never ran — never next up', () => {
    const [row] = toRows(
      [plan({ status: 'abandoned', phases: 6, done: 2, ready: [3, 4], qaFailures: [1], percent: 33 })],
      [],
      NOW,
    );
    expect(segmentsOf(countsOf(row)).map((s) => [s.key, s.count, s.paint])).toEqual([
      ['done', 2, 'done'],
      ['never', 4, 'skipped'],
    ]);
    expect(legendOf(row)).toBe('2 done · 4 never ran · 33 %');
  });

  it('words a complete plan as all done', () => {
    const [row] = toRows([plan({ phases: 4, done: 4, ready: [], waiting: 0, percent: 100 })], [], NOW);
    expect(legendOf(row)).toBe('4 done · 100 %');
  });

  it('says an unread board’s reading, never a track at 0 % — the last good reading drawn, the rest hatched', () => {
    const [blind] = toRows([plan({ progress: 'unknown', done: null, percent: null })], [], NOW);
    expect(countsOf(blind).known).toBe(false);
    expect(segmentsOf(countsOf(blind)).map((s) => [s.key, s.count, s.hatch])).toEqual([['unread', 4, true]]);
    expect(legendOf(blind)).toBe('progress unknown');
    const [last] = toRows(
      [
        plan({
          progress: 'unknown',
          done: null,
          percent: null,
          lastGood: { done: 1, phases: 4, percent: 25, at: NOW, ageMs: 0 },
        }),
      ],
      [],
      NOW,
    );
    expect(segmentsOf(countsOf(last)).map((s) => [s.key, s.count])).toEqual([
      ['done', 1],
      ['unread', 3],
    ]);
    expect(legendOf(last, NOW)).toMatch(/^progress unknown · last read 1\/4 · 25%/);
  });

  it('names the counts in the accessible name, in words', () => {
    const [row] = toRows([plan({ phases: 6, done: 2, inProgress: [3], ready: [4], waiting: 1 })], [], NOW);
    expect(countsLabel(row)).toBe(
      'Alpha plan, 6 phases: 2 done, 1 in progress, 1 next up, 1 waiting, 1 left, 25 %',
    );
  });

  it('says the work left in sessions, and what a closed plan or a document leaves', () => {
    const rows = toRows(
      [
        plan({ remainingSessions: 3 }),
        plan({ slug: 'done', phases: 4, done: 4, ready: [], remainingSessions: 0 }),
        plan({ slug: 'gone', status: 'abandoned', phases: 6, done: 2 }),
        plan({ slug: 'doc', kind: 'document', phases: 0, ready: [] }),
        plan({ slug: 'blind', progress: 'unknown', done: null, percent: null }),
      ],
      [],
      NOW,
    );
    expect(rows.map(leftWords)).toEqual([
      '3 sessions',
      'Nothing left',
      '4 never ran',
      'No phases',
      'Unknown',
    ]);
  });
});

describe('what is wrong with a plan', () => {
  it('puts an error above a halted run above a stuck phase', () => {
    const [row] = toRows(
      [
        plan({
          issueCounts: { error: 1, warning: 0, info: 0 },
          issues: [{ slug: 'alpha', severity: 'error', kind: 'engine', message: 'boom' }],
          stuck: [3],
        }),
      ],
      [run({ status: 'halted' })],
      NOW,
    );
    expect(concerns(row).map((c) => c.key)).toEqual(['error', 'halted', 'stuck']);
  });

  it('drops every progress concern on a closed plan, and keeps its structural error demoted', () => {
    const fixture = {
      activity: Date.UTC(2026, 6, 1),
      ready: [2],
      stuck: [3],
      qaFailures: [1],
      locks: [{ phase: 4, owner: 'someone', expired: true }],
    };
    const [open] = toRows([plan(fixture)], [run({ status: 'halted' })], NOW);
    expect(concerns(open).map((c) => c.key)).toEqual(['halted', 'stuck', 'qa', 'lock', 'idle']);
    const [closed] = toRows([plan({ ...fixture, status: 'abandoned' })], [run({ status: 'halted' })], NOW);
    expect(concerns(closed)).toEqual([]);
    const [broken] = toRows([plan({ status: 'superseded', engineError: 'did not parse' })], [], NOW);
    expect(concerns(broken).map((c) => [c.key, c.tone])).toEqual([['error', 'warn']]);
  });
});

describe('the five orders', () => {
  const rows = toRows(
    [
      plan({ slug: 'recent', title: 'Recent', activity: NOW, percent: 10, done: 1, phases: 10, ready: [2] }),
      plan({ slug: 'nearly', title: 'Nearly', activity: 1, percent: 90, done: 9, phases: 10, ready: [10] }),
      plan({ slug: 'wide', title: 'Wide', activity: 2, percent: 20, done: 2, phases: 10, ready: [3, 4, 5] }),
      plan({
        slug: 'broken',
        title: 'Broken',
        activity: 3,
        percent: 50,
        done: 5,
        phases: 10,
        ready: [6],
        issueCounts: { error: 2, warning: 0, info: 0 },
        issues: [{ slug: 'broken', severity: 'error', kind: 'engine', message: 'unreadable' }],
      }),
    ],
    [],
    NOW,
  );

  it('leads each order with a different plan', () => {
    const first = (by: string) => sortRows(rows, by)[0].slug;
    expect([first('activity'), first('progress'), first('ready'), first('attention'), first('name')]).toEqual(
      ['recent', 'nearly', 'wide', 'broken', 'broken'],
    );
  });

  it('sinks closed plans in the two work-shaped orders, and only there', () => {
    const mixed = toRows(
      [
        plan({ slug: 'walked-away', title: 'Walked away', status: 'abandoned', ready: [1, 2, 3, 4, 5] }),
        plan({ slug: 'live', title: 'Live', ready: [2] }),
      ],
      [],
      NOW,
    );
    expect(sortRows(mixed, 'ready').map((r) => r.slug)).toEqual(['live', 'walked-away']);
    expect(sortRows(mixed, 'attention').map((r) => r.slug)).toEqual(['live', 'walked-away']);
    expect(sortRows(mixed, 'name').map((r) => r.slug)).toEqual(['live', 'walked-away']);
  });
});

describe('the filters and the folds', () => {
  const estate = toRows(
    [
      plan({ slug: 'cart-api-endpoint', title: 'Cart API endpoint', repos: ['shop'] }),
      plan({ slug: 'pear', title: 'Pear orchard' }),
      plan({ slug: 'notes', title: 'Notes', kind: 'document', phases: 0, ready: [] }),
      plan({ slug: 'shipped', title: 'Shipped pear jam', status: 'complete', phases: 3, done: 3, ready: [] }),
      plan({ slug: 'gone', title: 'Walked away', status: 'abandoned' }),
    ],
    [],
    NOW,
  );

  it('lists the open plans and folds the closed ones and the documents, each counted', () => {
    const { list, closed, documents } = estateOf(estate, NO_FILTERS, 'name');
    expect(list.map((r) => r.slug)).toEqual(['cart-api-endpoint', 'pear']);
    expect(closed.map((r) => r.slug)).toEqual(['shipped', 'gone']);
    expect(documents.map((r) => r.slug)).toEqual(['notes']);
  });

  it('narrows the folds with the same search that narrows the list', () => {
    const { list, closed, documents } = estateOf(estate, { ...NO_FILTERS, query: 'pear' }, 'name');
    expect(list.map((r) => r.slug)).toEqual(['pear']);
    expect(closed.map((r) => r.slug)).toEqual(['shipped']);
    expect(documents).toEqual([]);
  });

  it('never folds a row the list already holds — the toggle, or a status naming a closure', () => {
    const shown = estateOf(estate, { ...NO_FILTERS, showClosed: true, showDocuments: true }, 'name');
    expect(shown.list).toHaveLength(5);
    expect([shown.closed, shown.documents]).toEqual([[], []]);
    const closedOnly = estateOf(estate, { ...NO_FILTERS, status: CLOSED_ONLY }, 'name');
    expect(closedOnly.list.map((r) => r.slug)).toEqual(['shipped', 'gone']);
    expect(closedOnly.closed).toEqual([]);
  });

  it('offers open-only and closed-only, and lets a named status override the closed toggle', () => {
    expect(applyFilters(estate, { ...NO_FILTERS, status: OPEN_ONLY }).map((r) => r.slug)).toEqual([
      'cart-api-endpoint',
      'pear',
    ]);
    expect(applyFilters(estate, { ...NO_FILTERS, status: 'complete' }).map((r) => r.slug)).toEqual([
      'shipped',
    ]);
  });

  it('says how many rows each filter hides, measured, never crediting one with the other’s', () => {
    const counts = hiddenBreakdown(estate, NO_FILTERS);
    expect(counts).toMatchObject({ total: 3, closed: 2, documents: 1, search: 0, shapeOnly: true });
    expect(hiddenBreakdown(estate, { ...NO_FILTERS, query: 'pear' }).search).toBe(3);
    const both = toRows(
      [plan({ slug: 'live' }), plan({ slug: 'old', kind: 'document', status: 'complete' })],
      [],
      NOW,
    );
    expect(hiddenBreakdown(both, NO_FILTERS)).toMatchObject({ total: 1, closed: 0, documents: 0 });
  });

  it('matches words in any order across the slug and the title', () => {
    const [row] = estate;
    expect(matchesPlan(row, 'cart api')).toBe(true);
    expect(matchesPlan(row, 'endpoint Cart')).toBe(true);
    expect(matchesPlan(row, 'cart checkout')).toBe(false);
  });

  it('counts the filters away from their resting value, never the search box', () => {
    expect(activeCount(NO_FILTERS)).toBe(0);
    expect(activeCount({ ...NO_FILTERS, query: 'cart' })).toBe(0);
    expect(activeCount({ ...NO_FILTERS, showClosed: true, repo: 'hub' })).toBe(2);
  });

  it('offers only the repositories and statuses the source has', () => {
    expect(repoOptions(estate)).toEqual(['hub', 'shop']);
    expect(statusOptions(estate)).toEqual(['active', 'complete', 'abandoned']);
  });
});

describe('groups, views, totals and the words', () => {
  it('lists a plan under every repository it names, and keeps one that names none', () => {
    const rows = toRows(
      [plan({ slug: 'a', repos: ['hub', 'shop'] }), plan({ slug: 'b', repos: [] })],
      [],
      NOW,
    );
    const groups = groupRows(rows, 'repo');
    expect(groups.filter((g) => g.rows.some((r) => r.slug === 'a'))).toHaveLength(2);
    expect(groups.at(-1)!.label).toBe('No repository named');
    expect(groupRows(rows, 'status')[0].label).toBe('Active');
  });

  it('reads 6.x’s stored layouts as the list, and only `cards` as cards', () => {
    expect(['board', 'table', 'list', undefined, 'cards'].map((w) => layoutOf(w))).toEqual([
      'list',
      'list',
      'list',
      'list',
      'cards',
    ]);
  });

  it('counts a closed plan in the census and never in the work left', () => {
    const rows = toRows(
      [
        plan({ slug: 'live', ready: [2], remainingSessions: 2 }),
        plan({ slug: 'gone', status: 'abandoned', ready: [3, 4], remainingSessions: 3 }),
      ],
      [],
      NOW,
    );
    expect(rowTotals(rows)).toMatchObject({ plans: 2, closed: 1, ready: 1, sessions: 2 });
  });

  it('heads the page with the work left, in one sentence, or says nothing', () => {
    const inbox = [{ slug: 'live', severity: 'needs-you' }] as unknown as InboxItem[];
    const rows = toRows(
      [plan({ slug: 'live', ready: [2, 3], remainingSessions: 4 }), plan({ slug: 'busy', ready: [] })],
      [run({ slug: 'busy' })],
      NOW,
      inbox,
    );
    expect(workSentence(rowTotals(rows))).toBe(
      '1 thing waiting on you, 1 running, 2 phases ready to start and about 6 sessions of work left.',
    );
    expect(workSentence(rowTotals([]))).toBe('');
  });

  it('caps a long repository list and keeps the whole of it in the title', () => {
    const many = ['all', 'api', 'billing', 'docs', 'mobile-app'];
    expect(repoLabel(many)).toEqual({ text: 'all, api +3', title: many.join(', ') });
    expect(repoLabel(['hub', 'shop']).text).toBe('hub, shop');
  });
});
