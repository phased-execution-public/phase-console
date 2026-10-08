/**
 * Your turn's page model (control-tower phase 137, #214) — pure, so the six
 * sections, the filters, the search, the history and the address an item is
 * reached by are proven without a page.
 *
 *   PM-1 the six sections, in order, each with its count — the five groups the
 *        server folded, then what the AI handled;
 *   PM-2 the filters (plan, run, kind, reason, risk) and the search live in the
 *        address: read from it, written back to it, an unknown word ignored;
 *   PM-3 a filter narrows every group, and the search reads what a person
 *        reads — the title, the guide, the proof in words, the command;
 *   PM-4 the facets offer only what the turn holds, counted;
 *   PM-5 *Done* is the ledger's: the day's settled items, and older ones from
 *        the ledger's own list as history — never an open one twice;
 *   PM-6 `#/turn/<id>` finds its item in whatever group holds it.
 */

import { describe, expect, it } from 'vitest';
import type { HumanStepRecord, TurnAnswer, TurnItem } from '@/lib/api';
import { parseHash, type Route } from '@/app/routes';
import {
  SECTIONS,
  SECTION_LABEL,
  facetsOf,
  filtersHref,
  filtersOf,
  historyOf,
  itemOf,
  itemRisk,
  matches,
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
  const groups = { now: [], decide: [], upcoming: [], checking: [], done: [] } as TurnAnswer['groups'];
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
  slug: 'beta',
  phase: 2,
  runId: 'r2',
  title: 'Which region ships first?',
});
const WALL = item({
  item: 's-wall',
  kind: 'permission',
  why: 'permission',
  proofType: 'grant',
  title: 'Allow npm publish',
  permission: { wall: 'deny', rule: 'Bash(npm publish:*)', command: 'npm publish', risk: 'high' },
});
const COMING = item({
  item: 's-later',
  group: 'upcoming',
  severity: 'fyi',
  title: 'Publish after the build',
});
const CHECKING = item({ item: 's-check', group: 'checking', title: 'Rotate the deploy key' });
const DONE = item({
  item: 's-done',
  group: 'done',
  severity: 'fyi',
  title: 'Enable the App',
  slug: 'beta',
  runId: 'r2',
});

const ALL = answer([SIGN_IN, DECISION, WALL, COMING, CHECKING, DONE]);

describe('PM-1 the six sections, in order', () => {
  it('reads the five groups, then what the AI handled', () => {
    expect([...SECTIONS]).toEqual(['now', 'decide', 'upcoming', 'checking', 'done', 'handled']);
    expect(SECTIONS.map((id) => SECTION_LABEL[id])).toEqual([
      'Do now',
      'Needs one detail from you',
      'Coming up',
      'Being checked',
      'Done',
      'Handled by the AI',
    ]);
    const sections = sectionsOf(ALL, {});
    expect(sections.map((s) => s.id)).toEqual([...SECTIONS]);
    expect(sections.map((s) => s.count)).toEqual([2, 1, 1, 1, 1, 2]);
    expect(sections.find((s) => s.id === 'handled')!.handled!.map((h) => h.id)).toEqual(['h-1', 'hs-2']);
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
    expect(filtersOf(route('#/turn?q=%20%20').query)).toEqual({});
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
