/**
 * Your turn's page model (7.0, quiet-console phase 8; control-tower phase
 * 137, #214) — pure, so the six sections, the filters, the search, the history
 * and the address an item is reached by are proven without a page.
 *
 *   PM-1 the seven sections, in order, each with its count — the six groups v2
 *        the server folded (turn-by-turn phase 9), then what the AI handled;
 *   PM-2 the filters (status, time, plan, type, goes to; run, kind, reason,
 *        risk) and the search live in the address: read from it, written back
 *        to it, an unknown word ignored;
 *   PM-3 a filter narrows every group, and the search reads what a person
 *        reads — the title, the guide, the proof in words, the command;
 *   PM-4 the facets offer only what the turn holds, counted;
 *   PM-5 *Done* is the ledger's: the day's settled items, and older ones from
 *        the ledger's own list as history — never an open one twice;
 *   PM-6 `#/turn/<id>` finds its item in whatever group holds it;
 *   PM-7 the hold compares itself against every item the answer holds.
 *   PM-v2 (turn-by-turn phase 9) the Time filter's windows, the five filters
 *        narrowing by the card's words, Group · Sort · View in the address,
 *        grouping by plan, and the strip counted when a 7.0 answer sent none.
 */

import { describe, expect, it } from 'vitest';
import type { HumanStepRecord, TurnAnswer, TurnItem } from '@/data/api';
import { parseHash, type Route } from '@/shell/routes';
import {
  SECTIONS,
  SECTION_LABEL,
  activeFacets,
  arrangeValue,
  arrangementOf,
  boardOf,
  byPlan,
  deadlineBandOf,
  foldEmpty,
  groupSections,
  tabCount,
  tabSections,
  timelineOf,
  sortItems,
  stripOf,
  timeWindowsOf,
  facetsOf,
  filtersHref,
  filtersOf,
  historyOf,
  itemIds,
  itemOf,
  itemRisk,
  matches,
  openSections,
  sectionsOf,
} from './page-model';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const route = (hash: string): Route => parseHash(hash) as Route;

function item(over: Partial<TurnItem> & { item: string }): TurnItem {
  return {
    record: 'ledger',
    source: 'session',
    kind: 'operator-act',
    why: 'reserved',
    proofType: 'attest',
    group: 'now',
    rows: [`human-step:alpha:3:${over.item}`],
    title: `Do ${over.item}`,
    need: `Do ${over.item}`,
    how: '',
    severity: 'needs-you',
    slug: 'alpha',
    phase: 3,
    runId: 'r1',
    since: ago(30),
    href: '#/plan/alpha/phase/3',
    actions: [],
    ...over,
  } as TurnItem;
}

function answer(items: TurnItem[], over: Partial<TurnAnswer> = {}): TurnAnswer {
  const groups = {
    approve: [],
    now: [],
    decide: [],
    checking: [],
    upcoming: [],
    done: [],
  } as TurnAnswer['groups'];
  for (const it of items) groups[it.group].push(it);
  return {
    round: { at: ago(0), n: 14, ranAt: ago(1), changedAt: ago(2) },
    headline: '2 need you now.',
    groups,
    handled: [
      {
        id: 'h-1',
        at: ago(5),
        first: ago(50),
        source: 'auto-grant',
        what: 'Bash(npm test:*)',
        count: 4,
        links: [],
      },
      {
        id: 'hs-2',
        at: ago(9),
        first: ago(9),
        source: 'session',
        what: 'rebased the branch',
        slug: 'beta',
        phase: 2,
        count: 1,
        links: [],
      },
    ],
    counts: {
      approve: groups.approve.length,
      now: groups.now.length,
      decide: groups.decide.length,
      upcoming: groups.upcoming.length,
      checking: groups.checking.length,
      done: groups.done.length,
      total: items.filter((it) => it.group !== 'done').length,
      handled: 2,
    },
    seen: null,
    issues: null,
    ...over,
  };
}

const SIGN_IN = item({
  item: 's-signin',
  kind: 'browser-login',
  why: 'identity',
  proofType: 'probe',
  title: 'Sign the gh CLI in',
  type: 'do',
  personStatus: 'todo',
  readiness: 'now',
  route: 'phase',
  timing: { assignedAt: ago(30), deadline: ago(-60) },
  step: {
    id: 's-signin',
    kind: 'browser-login',
    title: 'Sign the gh CLI in',
    state: 'notified',
    why: 'identity',
    whySource: 'declared',
    proofType: 'probe',
    attempts: 0,
    waiters: [{ slug: 'alpha', phase: 3 }],
    declaredAt: ago(30),
    birth: 'session',
    proofWords: 'gh auth status reads Logged in',
    guide: {
      lang: 'en',
      dir: 'ltr',
      summary: 'The release pushes as you.',
      steps: [{ text: 'Run the sign-in', code: 'gh auth login --web' }],
      trouble: [],
      version: 1,
    },
  },
});
const DECISION = item({
  item: 's-decide',
  kind: 'decision',
  why: 'decision',
  proofType: 'answer',
  group: 'decide',
  type: 'decide',
  personStatus: 'todo',
  route: 'phase',
  slug: 'beta',
  phase: 2,
  runId: 'r2',
  since: ago(3000),
  title: 'Which region ships first?',
});
const WALL = item({
  item: 's-wall',
  kind: 'permission',
  why: 'permission',
  proofType: 'grant',
  group: 'approve',
  type: 'approve',
  personStatus: 'todo',
  route: 'console',
  since: ago(10),
  timing: { assignedAt: ago(10), deadline: ago(15) },
  title: 'Allow npm publish',
  permission: { wall: 'deny', rule: 'Bash(npm publish:*)', command: 'npm publish', risk: 'high' },
});
const COMING = item({
  item: 's-later',
  group: 'upcoming',
  readiness: 'not-yet',
  severity: 'fyi',
  title: 'Publish after the build',
});
const CHECKING = item({
  item: 's-check',
  group: 'checking',
  personStatus: 'checking',
  title: 'Rotate the deploy key',
});
const DONE = item({
  item: 's-done',
  group: 'done',
  personStatus: 'passed',
  severity: 'fyi',
  title: 'Enable the App',
  slug: 'beta',
  runId: 'r2',
});

const ALL = answer([SIGN_IN, DECISION, WALL, COMING, CHECKING, DONE]);

describe('PM-1 the seven sections, in order', () => {
  it('reads the six groups v2, then what the AI handled', () => {
    expect([...SECTIONS]).toEqual(['approve', 'now', 'decide', 'checking', 'upcoming', 'done', 'handled']);
    expect(SECTIONS.map((id) => SECTION_LABEL[id])).toEqual([
      'Approve',
      'Do now',
      'Decide',
      'Being checked',
      'Coming up',
      'Done',
      'Handled by the AI',
    ]);
    const sections = sectionsOf(ALL, {}, NOW);
    expect(sections.map((s) => s.id)).toEqual([...SECTIONS]);
    expect(sections.map((s) => s.count)).toEqual([1, 1, 1, 1, 1, 1, 2]);
    expect(sections.find((s) => s.id === 'handled')!.handled!.map((h) => h.id)).toEqual(['h-1', 'hs-2']);
    // The open sections are what Export writes: never Done, never the handled log.
    expect(openSections(sections).map((s) => s.id)).toEqual([
      'approve',
      'now',
      'decide',
      'checking',
      'upcoming',
    ]);
  });
});

describe('PM-2 the filters live in the address', () => {
  it('reads each one, and ignores a word no vocabulary holds', () => {
    expect(
      filtersOf(route('#/turn?plan=alpha&run=r1&kind=decision&why=identity&risk=high&q=gh').query),
    ).toEqual({
      plan: 'alpha',
      run: 'r1',
      kind: 'decision',
      why: 'identity',
      risk: 'high',
      q: 'gh',
    });
    expect(filtersOf(route('#/turn?kind=nonsense&why=whim&risk=extreme').query)).toEqual({});
    expect(filtersOf(route('#/turn?status=redo&time=overdue&type=approve&to=console').query)).toEqual({
      status: 'redo',
      time: 'overdue',
      type: 'approve',
      to: 'console',
    });
    expect(filtersOf(route('#/turn?status=late&time=soon&type=chore&to=moon').query)).toEqual({});
    expect(filtersOf(route('#/turn?q=%20%20').query)).toEqual({});
    expect(activeFacets({ plan: 'alpha', q: 'gh' })).toBe(1);
  });

  it('writes a change back, keeping the item and anything else on the address', () => {
    const at = route('#/turn/s-signin?plan=alpha&k=x');
    expect(filtersHref(at, { kind: 'decision' })).toBe('#/turn/s-signin?plan=alpha&k=x&kind=decision');
    expect(filtersHref(at, { plan: undefined })).toBe('#/turn/s-signin?k=x');
    expect(filtersHref(route('#/turn?q=gh'), { q: '' })).toBe('#/turn');
  });
});

describe('PM-3 a filter narrows every group; the search reads what a person reads', () => {
  it('narrows by plan, run, kind, reason and risk', () => {
    const by = (filters: Parameters<typeof sectionsOf>[1]) =>
      sectionsOf(ALL, filters)
        .flatMap((s) => s.items)
        .map((it) => it.item);
    expect(by({ plan: 'beta' })).toEqual(['s-decide', 's-done']);
    expect(by({ run: 'r2' })).toEqual(['s-decide', 's-done']);
    expect(by({ kind: 'decision' })).toEqual(['s-decide']);
    expect(by({ why: 'identity' })).toEqual(['s-signin']);
    expect(by({ risk: 'high' })).toEqual(['s-wall']);
    // What the AI handled is narrowed by plan too — and by search.
    expect(
      sectionsOf(ALL, { plan: 'beta' })
        .find((s) => s.id === 'handled')!
        .handled!.map((h) => h.id),
    ).toEqual(['hs-2']);
  });

  it('searches the title, the guide, the proof in words and the command', () => {
    expect(matches(SIGN_IN, { q: 'release pushes' })).toBe(true); // the guide's why
    expect(matches(SIGN_IN, { q: 'GH AUTH LOGIN' })).toBe(true); // a step's command, any case
    expect(matches(SIGN_IN, { q: 'logged in' })).toBe(true); // the proof in words
    expect(matches(WALL, { q: 'npm publish' })).toBe(true); // the wall's command
    expect(matches(DECISION, { q: 'region' })).toBe(true);
    expect(matches(DECISION, { q: 'gh auth' })).toBe(false);
    // Every word must be there, in any order.
    expect(matches(SIGN_IN, { q: 'login gh' })).toBe(true);
    expect(matches(SIGN_IN, { q: 'login region' })).toBe(false);
  });

  it('a risk is the permission record’s, on the ledger item or on the projected card', () => {
    expect(itemRisk(WALL)).toBe('high');
    expect(
      itemRisk(item({ item: 'x', step: { ...SIGN_IN.step!, permission: { wall: 'ask', risk: 'low' } } })),
    ).toBe('low');
    expect(itemRisk(SIGN_IN)).toBeUndefined();
  });
});

describe('PM-4 the facets offer only what the turn holds', () => {
  it('counts each plan, run, kind, reason and risk', () => {
    const facets = facetsOf(ALL);
    expect(facets.plan).toEqual([
      { value: 'alpha', label: 'alpha', count: 4 },
      { value: 'beta', label: 'beta', count: 2 },
    ]);
    expect(facets.run.map((f) => f.value)).toEqual(['r1', 'r2']);
    // A kind is named by `KIND_META`, the one place a kind is named.
    expect(facets.kind.find((f) => f.value === 'decision')).toEqual({
      value: 'decision',
      label: 'Make a decision',
      count: 1,
    });
    expect(facets.why.find((f) => f.value === 'identity')!.label).toBe('Only you can sign in');
    expect(facets.risk).toEqual([{ value: 'high', label: 'High risk', count: 1 }]);
  });
});

describe('PM-5 Done is the ledger’s, and so is the history', () => {
  const step = (id: string, state: HumanStepRecord['state'], at: string): HumanStepRecord =>
    ({
      id,
      kind: 'operator-act',
      title: `Step ${id}`,
      where: 'any',
      birth: 'session',
      slug: 'alpha',
      phase: 3,
      state,
      declaredAt: at,
      at,
      opened: 0,
    }) as HumanStepRecord;

  it('lists settled steps older than the day, newest first — never an open one, never one Done holds', () => {
    const steps = [
      step('s-done', 'proven', ago(60)),
      step('old-1', 'proven', ago(3000)),
      step('old-2', 'declined', ago(2000)),
      step('open', 'notified', ago(4000)),
    ];
    expect(historyOf(steps, ALL).map((s) => s.id)).toEqual(['old-2', 'old-1']);
    expect(historyOf(undefined, ALL)).toEqual([]);
  });
});

describe('PM-6 an item’s own address', () => {
  it('finds the item in whatever group holds it', () => {
    expect(itemOf(ALL, 's-decide')?.item).toBe('s-decide');
    expect(itemOf(ALL, 's-done')?.group).toBe('done');
    expect(itemOf(ALL, 'gone')).toBeNull();
    expect(itemOf(undefined, 's-decide')).toBeNull();
  });
});

describe('PM-7 the hold reads every item the answer holds (#270)', () => {
  it('names each, in every group, and nothing without an answer', () => {
    expect([...itemIds(ALL)]).toEqual(['s-wall', 's-signin', 's-decide', 's-check', 's-later', 's-done']);
    expect(itemIds(undefined).size).toBe(0);
  });
});

describe('PM-v2 the five filters, Group · Sort · View, and the strip (turn-by-turn phase 9)', () => {
  it('reads an item’s time windows off its deadline and its age', () => {
    expect(timeWindowsOf(SIGN_IN, NOW)).toEqual(['due', 'today']);
    expect(timeWindowsOf(WALL, NOW)).toEqual(['overdue', 'today']);
    expect(timeWindowsOf(DECISION, NOW)).toEqual(['older']);
    expect(timeWindowsOf({ since: 'never' }, NOW)).toEqual([]);
  });

  it('narrows by Status, Time, Type and Goes to — the card’s own words', () => {
    const by = (filters: Parameters<typeof sectionsOf>[1]) =>
      sectionsOf(ALL, filters, NOW)
        .flatMap((s) => s.items)
        .map((it) => it.item);
    expect(by({ status: 'checking' })).toEqual(['s-check']);
    expect(by({ status: 'passed' })).toEqual(['s-done']);
    expect(by({ time: 'overdue' })).toEqual(['s-wall']);
    expect(by({ time: 'older' })).toEqual(['s-decide']);
    expect(by({ type: 'approve' })).toEqual(['s-wall']);
    expect(by({ to: 'phase' })).toEqual(['s-signin', 's-decide']);
    // A filter only an item answers leaves no handled row standing.
    expect(sectionsOf(ALL, { type: 'approve' }, NOW).find((s) => s.id === 'handled')!.count).toBe(0);
    expect(activeFacets({ status: 'todo', time: 'due', type: 'do', to: 'phase', q: 'x' })).toBe(4);
  });

  it('offers each filter only what the turn holds, in a person’s words', () => {
    const facets = facetsOf(ALL, NOW);
    expect(facets.type.map((f) => [f.value, f.label])).toEqual(
      expect.arrayContaining([
        ['approve', 'Approval'],
        ['do', 'Task'],
        ['decide', 'Decision'],
      ]),
    );
    expect(facets.status.find((f) => f.value === 'checking')!.label).toBe('Checking');
    expect(facets.time.find((f) => f.value === 'overdue')).toEqual({
      value: 'overdue',
      label: 'Past its deadline',
      count: 1,
    });
    expect(facets.to.find((f) => f.value === 'phase')!.label).toBe('The phase');
  });

  it('keeps Group, Sort, View and the tab in the address, the defaults as no parameter at all', () => {
    expect(arrangementOf({})).toEqual({ group: 'asked', sort: 'oldest', view: 'list', tab: 'open' });
    expect(arrangementOf(route('#/turn?group=plan&sort=deadline&view=board&tab=done').query)).toEqual({
      group: 'plan',
      sort: 'deadline',
      view: 'board',
      tab: 'done',
    });
    // 7.1's Compact reads as the list (one-pool phase 14).
    expect(arrangementOf({ view: 'compact' }).view).toBe('list');
    expect(arrangementOf({ group: 'whim', sort: 'random', view: 'grid', tab: 'later' })).toEqual(
      arrangementOf({}),
    );
    expect(arrangeValue('sort', 'oldest')).toBe('');
    expect(filtersHref(route('#/turn?plan=alpha'), { sort: arrangeValue('sort', 'newest') })).toBe(
      '#/turn?plan=alpha&sort=newest',
    );
    expect(filtersHref(route('#/turn?sort=newest'), { sort: arrangeValue('sort', 'oldest') })).toBe('#/turn');
  });

  it('sorts oldest, newest or by the nearest deadline — none last', () => {
    const items = [SIGN_IN, DECISION, WALL, CHECKING];
    expect(sortItems(items, 'oldest').map((it) => it.item)).toEqual([
      's-decide',
      's-signin',
      's-check',
      's-wall',
    ]);
    expect(sortItems(items, 'newest').map((it) => it.item)).toEqual([
      's-wall',
      's-signin',
      's-check',
      's-decide',
    ]);
    expect(sortItems(items, 'deadline').map((it) => it.item)).toEqual([
      's-wall',
      's-signin',
      's-decide',
      's-check',
    ]);
  });

  it('groups the open items by plan, leaving Done and the handled log as they are', () => {
    const grouped = byPlan(sectionsOf(ALL, {}, NOW));
    expect(grouped.map((s) => [s.id, s.label, s.count])).toEqual([
      ['plan:alpha', 'alpha', 4],
      ['plan:beta', 'beta', 1],
      ['done', 'Done', 1],
      ['handled', 'Handled by the AI', 2],
    ]);
    expect(grouped[0]!.items.map((it) => it.item)).toEqual(['s-wall', 's-signin', 's-check', 's-later']);
  });

  it('reads the server’s strip, and counts one when a 7.0 answer sent none', () => {
    const strip = { todo: 9, checking: 0, passedToday: 0, nextDeadline: null };
    expect(stripOf({ ...ALL, strip })).toBe(strip);
    expect(stripOf(ALL)).toEqual({
      todo: 3,
      checking: 1,
      passedToday: 1,
      nextDeadline: { at: ago(15), item: 's-wall', title: 'Allow npm publish' },
    });
    const seventy = { ...ALL, groups: { ...ALL.groups } } as TurnAnswer;
    delete (seventy.groups as Partial<TurnAnswer['groups']>).approve;
    expect(stripOf(seventy).todo).toBe(2);
  });

  it('finds a heads-up by its address too', () => {
    const know = item({ item: 'eref:E-1', type: 'know', group: 'upcoming' });
    expect(itemOf({ ...ALL, headsUp: [know] }, 'eref:E-1')?.item).toBe('eref:E-1');
  });
});

describe('PM-14 the tabs, the groupings, the folded line, the board and the timeline (one-pool phase 14, #377)', () => {
  const sections = sectionsOf(ALL, {}, NOW);
  const ids = (list: readonly { id: string }[]) => list.map((one) => one.id);

  it('shows the open groups on Open, Done and Handled on their own, every one on All', () => {
    expect(ids(tabSections(sections, 'open'))).toEqual(['approve', 'now', 'decide', 'checking', 'upcoming']);
    expect(ids(tabSections(sections, 'done'))).toEqual(['done']);
    expect(ids(tabSections(sections, 'handled'))).toEqual(['handled']);
    expect(ids(tabSections(sections, 'all'))).toEqual([...SECTIONS]);
    // The tab bar's counts: the open five (and the heads-ups), the settled, the handled rows.
    expect(tabCount(sections, 'open', 1)).toBe(6);
    expect(tabCount(sections, 'done')).toBe(1);
    expect(tabCount(sections, 'handled')).toBe(2);
  });

  it('groups the open items by plan, type, deadline or status — what is over stays as it is', () => {
    const open = tabSections(sections, 'all');
    expect(ids(groupSections(open, 'plan', NOW))).toEqual(['plan:alpha', 'plan:beta', 'done', 'handled']);
    expect(ids(groupSections(open, 'type', NOW)).slice(0, 3)).toEqual([
      'type:approve',
      'type:do',
      'type:decide',
    ]);
    const byDeadline = groupSections(tabSections(sections, 'open'), 'deadline', NOW);
    expect(ids(byDeadline)).toEqual(['deadline:overdue', 'deadline:today', 'deadline:none']);
    expect(byDeadline[0]!.items.map((it) => it.item)).toEqual(['s-wall']);
    expect(byDeadline[0]!.label).toBe('Past its deadline');
    const byStatus = groupSections(tabSections(sections, 'open'), 'status', NOW);
    expect(ids(byStatus)).toEqual(['status:todo', 'status:checking']);
    // On the Done tab the settled items are themselves regrouped.
    expect(ids(groupSections(tabSections(sections, 'done'), 'plan', NOW))).toEqual(['plan:beta']);
    // byPlan is the plan grouping under its 7.1 name.
    expect(byPlan(open)).toEqual(groupSections(open, 'plan', NOW));
  });

  it('reads an item’s deadline band at the answer’s clock', () => {
    expect(deadlineBandOf({ timing: undefined }, NOW)).toBe('none');
    expect(deadlineBandOf({ timing: { assignedAt: ago(1), deadline: ago(5) } }, NOW)).toBe('overdue');
    expect(deadlineBandOf({ timing: { assignedAt: ago(1), deadline: ago(-60) } }, NOW)).toBe('today');
    expect(deadlineBandOf({ timing: { assignedAt: ago(1), deadline: ago(-3000) } }, NOW)).toBe('later');
  });

  it('folds every empty group into ONE line, and keeps a group that holds a pressed item', () => {
    const only = sectionsOf(answer([SIGN_IN]), {}, NOW);
    const open = tabSections(only, 'open');
    const folded = foldEmpty(open);
    expect(ids(folded.sections)).toEqual(['now']);
    expect(folded.empty).toBe('Nothing to approve, to decide, being checked or coming up.');
    expect(foldEmpty(open, new Set(['decide'])).empty).toBe(
      'Nothing to approve, being checked or coming up.',
    );
    // A group the filters emptied is NOT folded: it says what the filters hid.
    const filtered = tabSections(sectionsOf(ALL, { plan: 'beta' }, NOW), 'open');
    expect(ids(foldEmpty(filtered).sections)).toContain('now');
    expect(foldEmpty(tabSections(sections, 'handled')).empty).toBeNull();
  });

  it('puts the board in columns by the person’s status, one lane per group when grouped', () => {
    const [lane] = boardOf(tabSections(sections, 'all'), 'asked');
    expect(lane!.columns.map((column) => column.id)).toEqual(['todo', 'checking', 'redo', 'owner', 'done']);
    const cells = Object.fromEntries(
      lane!.columns.map((column) => [column.id, column.items.map((it) => it.item)]),
    );
    expect(cells.checking).toEqual(['s-check']);
    expect(cells.done).toEqual(['s-done']);
    expect(cells.todo).toContain('s-signin');
    const lanes = boardOf(groupSections(tabSections(sections, 'open'), 'plan', NOW), 'plan');
    expect(lanes.map((one) => one.label)).toEqual(['alpha', 'beta']);
  });

  it('places every item on one clock: raised to deadline, or to now with no deadline', () => {
    const line = timelineOf([SIGN_IN, WALL, COMING], NOW);
    expect(line.start).toBeLessThanOrEqual(NOW);
    expect(line.end).toBeGreaterThanOrEqual(NOW);
    // Now in the middle when there is a past and a future; the past alone takes the whole line.
    expect(line.nowAt).toBe(0.5);
    expect(timelineOf([COMING], NOW).nowAt).toBe(1);
    const at = Object.fromEntries(line.rows.map((row) => [row.item.item, row]));
    expect(at['s-signin']!.deadline).toBe(true);
    expect(at['s-signin']!.overdue).toBe(false);
    expect(at['s-wall']!.overdue).toBe(true);
    expect(at['s-later']!.deadline).toBe(false);
    for (const row of line.rows) {
      expect(row.from).toBeGreaterThanOrEqual(0);
      expect(row.to).toBeLessThanOrEqual(1);
      expect(row.to).toBeGreaterThanOrEqual(row.from);
    }
  });
});
