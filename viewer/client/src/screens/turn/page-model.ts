/**
 * Your turn's page, as data (7.0, quiet-console phase 8; control-tower phase
 * 137, #214, §Architecture 19).
 *
 * The server owns the turn: `GET /api/turn` folds every inbox row that asks a
 * person for an act into ONE item and groups it (`server/turn/index.ts`
 * `turnView`); this file decides nothing about an item. What it owns is the
 * PAGE: the seven sections in their order (the groups v2 of turn-by-turn
 * phase 9, then the handled log), the filters, the search, the grouping, the
 * order and the view a person reads them by — all of it in the address, so a
 * narrowed view is a link —
 * the facets those filters offer, the ledger's older settled steps as history,
 * and which item `#/turn/<id>` names.
 *
 * Pure and React-free, so `page-model.test.ts` proves it without a page.
 */

import { HUMAN_STEP_KINDS, HUMAN_STEP_SETTLED_STATES, KIND_META } from '@shared/human-step-model.js';
import { describeWord } from '@shared/status-model.js';
import {
  ITEM_TYPES,
  PERSON_STATUSES,
  PERSON_STATUS_LABEL,
  REASON_META,
  RISK_TIERS,
  ROUTE_META,
  ROUTE_TO,
  TURN_GROUPS,
  TURN_GROUP_LABEL,
  TYPE_META,
  WHY_PERSON,
  type ItemType,
  type PersonStatus,
  type RiskTier,
  type RouteTo,
  type TurnGroup,
} from '@shared/turn-model.js';
import type { HumanStepRecord } from '@/data/human-steps';
import type { HandledRow, TurnAnswer, TurnItem, TurnStrip } from '@/data/turn';
import { withQuery, type Route } from '@/shell/routes';

/* ------------------------------------------------------------------ *
 * The sections
 * ------------------------------------------------------------------ */

/** A section of the page: one of the six groups the server folds (v2), or what the AI handled. */
export type SectionId = TurnGroup | 'handled';

/**
 * The seven, in the order the page draws them — the groups v2 as the model
 * orders them (*Approve* · *Do now* · *Decide* · *Being checked* · *Coming up*
 * · *Done*), then the handled log, a section and never a group.
 */
export const SECTIONS: readonly SectionId[] = Object.freeze([...TURN_GROUPS, 'handled'] as SectionId[]);

/** What each section is called — the groups' own labels (`TURN_GROUP_LABEL`), and one more. */
export const SECTION_LABEL: Readonly<Record<SectionId, string>> = Object.freeze({
  ...TURN_GROUP_LABEL,
  handled: 'Handled by the AI',
});

/** What an empty section says — one plain line, so the order a glance learns never moves. */
export const EMPTY_WORDS: Readonly<Record<SectionId, string>> = Object.freeze({
  approve: 'Nothing waits for your yes or no.',
  now: 'Nothing to do now.',
  decide: 'No decision waits on you.',
  checking: 'Nothing is being checked.',
  upcoming: 'Nothing is coming up.',
  done: 'Nothing settled today.',
  handled: 'The AI handled nothing on its own in this window.',
});

/** A section as the page draws it: its items (or handled rows) after the filters, and how many there were before. */
export type TurnSection = {
  /** A group, the handled log — or, grouped by plan, `plan:<slug>`. */
  id: SectionId | `plan:${string}`;
  label: string;
  items: TurnItem[];
  /** The handled rows — only on `handled`. */
  handled?: HandledRow[];
  /** How many the filters left. */
  count: number;
  /** How many there were. */
  total: number;
};

/* ------------------------------------------------------------------ *
 * The filters — in the address
 * ------------------------------------------------------------------ */

/**
 * How long an item has waited, or how its deadline stands — the *Time*
 * filter's words. An item can stand in more than one (overdue and waiting
 * more than a day).
 */
export const TIME_WINDOWS = Object.freeze(['overdue', 'due', 'today', 'older'] as const);
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export const TIME_LABEL: Readonly<Record<TimeWindow, string>> = Object.freeze({
  overdue: 'Past its deadline',
  due: 'A deadline ahead',
  today: 'Raised in the last day',
  older: 'Waiting more than a day',
});

const DAY_MS = 24 * 60 * 60_000;

/** The time windows an item stands in at `now`. */
export function timeWindowsOf(item: Pick<TurnItem, 'since' | 'timing'>, now: number): TimeWindow[] {
  const out: TimeWindow[] = [];
  const deadline = item.timing?.deadline ? Date.parse(item.timing.deadline) : NaN;
  if (Number.isFinite(deadline)) out.push(deadline < now ? 'overdue' : 'due');
  const since = Date.parse(item.since);
  if (Number.isFinite(since)) out.push(now - since <= DAY_MS ? 'today' : 'older');
  return out;
}

/** What a person narrowed the page by. Every key is a query parameter of `#/turn`. */
export type TurnFilters = {
  /** The person's status (`PERSON_STATUSES`). */
  status?: string;
  /** How long it has waited, or how its deadline stands (`TIME_WINDOWS`). */
  time?: string;
  plan?: string;
  /** What is asked (`ITEM_TYPES`). */
  type?: string;
  /** *Goes to* (`ROUTE_TO`). */
  to?: string;
  run?: string;
  kind?: string;
  /** The reason only a person fits it (`WHY_PERSON`). */
  why?: string;
  risk?: string;
  /** Words, every one of which must be found. */
  q?: string;
};

/** The query keys the filters own. */
export const FILTER_KEYS = Object.freeze([
  'status',
  'time',
  'plan',
  'type',
  'to',
  'run',
  'kind',
  'why',
  'risk',
  'q',
] as const);

/** The five selects of the Filter slot, in its order — the search is the bar's own. */
export const FACET_KEYS = Object.freeze(['status', 'time', 'plan', 'type', 'to'] as const);

/** Four more, drawn under Everything — and read from any address, so a 7.0 link still narrows. */
export const MORE_FACET_KEYS = Object.freeze(['run', 'kind', 'why', 'risk'] as const);

export type FacetKey = (typeof FACET_KEYS)[number] | (typeof MORE_FACET_KEYS)[number];

/** The filters a select offers, named as a person reads them. */
export const FILTER_LABEL: Readonly<Record<FacetKey, string>> = Object.freeze({
  status: 'Status',
  time: 'Time',
  plan: 'Plan',
  type: 'Type',
  to: 'Goes to',
  run: 'Run',
  kind: 'Kind',
  why: 'Reason',
  risk: 'Risk',
});

const has = (list: readonly string[], word: string | undefined): word is string =>
  typeof word === 'string' && list.includes(word);

/**
 * The filters an address carries. A plan, a run and the search are any words;
 * every other must be a word its vocabulary holds — an unknown one is
 * ignored, never guessed at (the `?bay=` rule).
 */
export function filtersOf(query: Readonly<Record<string, string>>): TurnFilters {
  const out: TurnFilters = {};
  const word = (key: string): string | undefined => {
    const value = query[key]?.trim();
    return value ? value : undefined;
  };
  const vocab: Partial<Record<keyof TurnFilters, readonly string[]>> = {
    status: PERSON_STATUSES,
    time: TIME_WINDOWS,
    type: ITEM_TYPES,
    to: ROUTE_TO,
    kind: HUMAN_STEP_KINDS,
    why: WHY_PERSON,
    risk: RISK_TIERS,
  };
  for (const key of FILTER_KEYS) {
    const value = word(key);
    if (!value) continue;
    const list = vocab[key];
    if (list && !has(list, value)) continue;
    out[key] = value;
  }
  return out;
}

/** Does any filter narrow the page? */
export function filtering(filters: TurnFilters): boolean {
  return FILTER_KEYS.some((key) => Boolean(filters[key]));
}

/** How many of the selects are away from "Any" — the toolbar's count. */
export function activeFacets(filters: TurnFilters): number {
  return [...FACET_KEYS, ...MORE_FACET_KEYS].filter((key) => Boolean(filters[key])).length;
}

/**
 * The address with the filters (or the arrangement) changed — the item it
 * names and anything else on it (an overlay) kept; a key set to nothing is
 * taken off. Spelled by the one navigation door (`shell/routes.ts`), never here.
 */
export function filtersHref(route: Route, patch: Partial<TurnFilters & Record<ArrangeKey, string>>): string {
  const query: Record<string, string> = { ...route.query };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || !String(value).trim()) delete query[key];
    else query[key] = String(value).trim();
  }
  return withQuery({ ...route, path: route.path || 'turn' }, query);
}

/* ------------------------------------------------------------------ *
 * The arrangement — Group, Sort and View, in the address too
 * ------------------------------------------------------------------ */

/** By what is asked (the six groups) — the default — or by plan. */
export const GROUPINGS = Object.freeze([
  { id: 'asked', label: 'What is asked', blurb: 'The six groups: approve, do now, decide and the rest.' },
  { id: 'plan', label: 'Plan', blurb: 'One section per plan for the open items; Done stays last.' },
] as const);
export const SORTS = Object.freeze([
  { id: 'oldest', label: 'Oldest first', blurb: 'What has waited longest leads each section.' },
  { id: 'newest', label: 'Newest first', blurb: 'What arrived last leads.' },
  { id: 'deadline', label: 'Deadline first', blurb: 'The nearest deadline leads; items with none follow.' },
] as const);
export const VIEWS = Object.freeze([
  { id: 'cards', label: 'Cards', blurb: 'Every open item drawn whole.' },
  { id: 'compact', label: 'Compact', blurb: 'Every item folded to its head; open one to act.' },
] as const);

export type Grouping = (typeof GROUPINGS)[number]['id'];
export type SortOrder = (typeof SORTS)[number]['id'];
export type ViewMode = (typeof VIEWS)[number]['id'];
export type ArrangeKey = 'group' | 'sort' | 'view';
export type Arrangement = { group: Grouping; sort: SortOrder; view: ViewMode };

/** The arrangement an address carries; a word none of the three holds reads as the default. */
export function arrangementOf(query: Readonly<Record<string, string>>): Arrangement {
  const pick = <T extends string>(list: readonly { id: T }[], value: string | undefined): T =>
    list.find((one) => one.id === value)?.id ?? list[0]!.id;
  return {
    group: pick(GROUPINGS, query.group),
    sort: pick(SORTS, query.sort),
    view: pick(VIEWS, query.view),
  };
}

/** The address's value for an arrangement — the default is no parameter at all. */
export function arrangeValue<K extends ArrangeKey>(key: K, value: Arrangement[K]): string {
  return value === arrangementOf({})[key] ? '' : value;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** A permission item's risk tier — the ledger's record, or the card it projects. */
export function itemRisk(item: Pick<TurnItem, 'permission' | 'step'>): RiskTier | undefined {
  return item.permission?.risk ?? item.step?.permission?.risk;
}

/** Every word a person reads on an item, in one lower-cased string — what the search looks in. */
export function searchText(item: TurnItem): string {
  const step = item.step;
  const guide = step?.guide;
  const permission = item.permission ?? step?.permission;
  return [
    item.title,
    item.need,
    item.how,
    item.meta,
    item.check,
    KIND_META[item.kind]?.label,
    REASON_META[item.why]?.label,
    item.type ? TYPE_META[item.type]?.label : undefined,
    item.slug,
    item.phase != null ? `phase ${item.phase}` : '',
    item.runId,
    step?.title,
    step?.proofWords,
    step?.proof,
    step?.note,
    guide?.summary,
    ...(guide?.steps ?? []).flatMap((s) => [s.text, s.code, s.expect, s.warn, s.link?.label, s.link?.url]),
    ...(guide?.trouble ?? []).flatMap((t) => [t.symptom, t.fix]),
    ...(step?.options ?? []).flatMap((o) => [o.label, o.consequence]),
    ...(item.options ?? []).flatMap((o) => [o.label, o.consequence]),
    item.approval?.what,
    permission?.rule,
    permission?.command,
    permission?.tool,
    permission?.need,
    item.request?.ask,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
    .toLowerCase();
}

/** Does an item pass the filters at `now`? Every word of the search must be found, in any order. */
export function matches(item: TurnItem, filters: TurnFilters, now = Date.now()): boolean {
  if (filters.status && (item.personStatus ?? 'todo') !== filters.status) return false;
  if (filters.time && !timeWindowsOf(item, now).includes(filters.time as TimeWindow)) return false;
  if (filters.plan && item.slug !== filters.plan) return false;
  if (filters.type && item.type !== filters.type) return false;
  if (filters.to && item.route !== filters.to) return false;
  if (filters.run && item.runId !== filters.run && !item.step?.waiters.some((w) => w.runId === filters.run))
    return false;
  if (filters.kind && item.kind !== filters.kind) return false;
  if (filters.why && item.why !== filters.why) return false;
  if (filters.risk && itemRisk(item) !== filters.risk) return false;
  if (filters.q) {
    const text = searchText(item);
    for (const word of filters.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!text.includes(word)) return false;
    }
  }
  return true;
}

/** A handled row passes the filters that can speak about it — the plan, the run and the search. */
function handledMatches(row: HandledRow, filters: TurnFilters): boolean {
  // A filter only an item can answer (its status, type, route…) leaves no handled row standing.
  if (filters.status || filters.type || filters.to || filters.kind || filters.why || filters.risk)
    return false;
  if (filters.plan && row.slug !== filters.plan) return false;
  if (filters.run && row.runId !== filters.run) return false;
  if (filters.q) {
    const text = [row.what, row.note, row.slug, row.source].filter(Boolean).join('\n').toLowerCase();
    for (const word of filters.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!text.includes(word)) return false;
    }
  }
  return true;
}

const stamp = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

/** The items in the order the Sort slot says — stable, and a missing clock sorts last. */
export function sortItems(items: readonly TurnItem[], sort: SortOrder): TurnItem[] {
  const keyed = items.map((item, index) => ({ item, index }));
  const by = (one: TurnItem): number =>
    sort === 'deadline'
      ? stamp(one.timing?.deadline)
      : sort === 'newest'
        ? -(Number.isFinite(stamp(one.since)) ? stamp(one.since) : Number.NEGATIVE_INFINITY)
        : stamp(one.since);
  keyed.sort((a, b) => {
    const diff = by(a.item) - by(b.item);
    if (sort === 'deadline' && diff === 0)
      return stamp(a.item.since) - stamp(b.item.since) || a.index - b.index;
    return Number.isNaN(diff) || diff === 0 ? a.index - b.index : diff;
  });
  return keyed.map((one) => one.item);
}

/** The seven sections, in order, narrowed by the filters and ordered by the sort. */
export function sectionsOf(
  answer: TurnAnswer,
  filters: TurnFilters,
  now = Date.now(),
  sort: SortOrder = 'oldest',
): TurnSection[] {
  return SECTIONS.map((id) => {
    if (id === 'handled') {
      const handled = answer.handled.filter((row) => handledMatches(row, filters));
      return {
        id,
        label: SECTION_LABEL[id],
        items: [],
        handled,
        count: handled.length,
        total: answer.handled.length,
      };
    }
    const all = answer.groups[id] ?? [];
    const items = sortItems(
      all.filter((it) => matches(it, filters, now)),
      sort,
    );
    return { id, label: SECTION_LABEL[id], items, count: items.length, total: all.length };
  });
}

/**
 * Grouped by plan: one section per plan the open items name (in the order
 * their first item stands), each holding its items in the groups' order, then
 * *Done* and the handled log as they are — what is over is not regrouped.
 */
export function byPlan(sections: readonly TurnSection[]): TurnSection[] {
  const open = sections.filter((section) => section.id !== 'done' && section.id !== 'handled');
  const plans = new Map<string, { items: TurnItem[]; total: number }>();
  for (const section of open) {
    for (const item of section.items) {
      const slug = item.slug ?? '';
      const held = plans.get(slug) ?? { items: [], total: 0 };
      held.items.push(item);
      plans.set(slug, held);
    }
  }
  const grouped: TurnSection[] = [...plans.entries()].map(([slug, held]) => ({
    id: `plan:${slug}`,
    label: slug || 'No plan',
    items: held.items,
    count: held.items.length,
    total: held.items.length,
  }));
  return [...grouped, ...sections.filter((section) => section.id === 'done' || section.id === 'handled')];
}

/** The open sections — every one but *Done* and the handled log; what *Export* writes. */
export function openSections(sections: readonly TurnSection[]): TurnSection[] {
  return sections.filter((section) => section.id !== 'done' && section.id !== 'handled');
}

/* ------------------------------------------------------------------ *
 * The facets
 * ------------------------------------------------------------------ */

/** One choice a filter offers: the word, what a person reads, and how many items carry it. */
export type TurnFacet = { value: string; label: string; count: number };

export type Facets = Record<FacetKey, TurnFacet[]>;

/** Every choice each filter offers — only what the turn holds, the most common first. */
export function facetsOf(answer: TurnAnswer | undefined, now = Date.now()): Facets {
  const keys = [...FACET_KEYS, ...MORE_FACET_KEYS];
  const tally = Object.fromEntries(keys.map((key) => [key, new Map<string, number>()])) as Record<
    FacetKey,
    Map<string, number>
  >;
  const bump = (key: FacetKey, value: string | undefined) => {
    if (value) tally[key].set(value, (tally[key].get(value) ?? 0) + 1);
  };
  for (const group of TURN_GROUPS) {
    for (const it of answer?.groups[group] ?? []) {
      bump('status', it.personStatus ?? 'todo');
      for (const window of timeWindowsOf(it, now)) bump('time', window);
      bump('plan', it.slug);
      bump('type', it.type);
      bump('to', it.route);
      bump('run', it.runId);
      bump('kind', it.kind);
      bump('why', it.why);
      bump('risk', itemRisk(it));
    }
  }
  const label: Record<FacetKey, (value: string) => string> = {
    status: (v) => PERSON_STATUS_LABEL[v as PersonStatus] ?? v,
    time: (v) => TIME_LABEL[v as TimeWindow] ?? v,
    plan: (v) => v,
    type: (v) => TYPE_META[v as ItemType]?.label ?? v,
    to: (v) => ROUTE_META[v as RouteTo]?.label ?? v,
    run: (v) => v,
    kind: (v) => KIND_META[v as keyof typeof KIND_META]?.label ?? v,
    why: (v) => REASON_META[v as keyof typeof REASON_META]?.label ?? v,
    risk: (v) => describeWord('risk', v).label,
  };
  const facets = {} as Facets;
  for (const key of keys) {
    facets[key] = [...tally[key].entries()]
      .map(([value, count]) => ({ value, label: label[key](value), count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  return facets;
}

/* ------------------------------------------------------------------ *
 * History and the item's own address
 * ------------------------------------------------------------------ */

const SETTLED = new Set<string>(HUMAN_STEP_SETTLED_STATES as readonly string[]);

/**
 * The ledger's settled steps *Done* does not already hold — the day's are the
 * turn's (`groups.done`), and everything older the ledger still lists is
 * history, newest first. Never an open step: an open one is an item above.
 */
export function historyOf(
  steps: readonly HumanStepRecord[] | undefined,
  answer: TurnAnswer | undefined,
): HumanStepRecord[] {
  const shown = new Set((answer?.groups.done ?? []).map((it) => it.item));
  return (steps ?? [])
    .filter((step) => SETTLED.has(step.state) && !shown.has(step.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The item `#/turn/<id>` names — by its id, or by an inbox row it stands for — wherever it is grouped, or a heads-up. */
export function itemOf(answer: TurnAnswer | undefined, id: string | undefined): TurnItem | null {
  if (!answer || !id) return null;
  for (const group of TURN_GROUPS) {
    const found = answer.groups[group]?.find((it) => it.item === id || it.rows.includes(id));
    if (found) return found;
  }
  // A heads-up has an address too: it is in no group, and still an item.
  return answer.headsUp?.find((it) => it.item === id) ?? null;
}

/** Every item the answer holds, in the page's order — what a hold compares itself against (#270). */
export function itemIds(answer: TurnAnswer | undefined): Set<string> {
  const ids = new Set<string>();
  for (const group of TURN_GROUPS) for (const it of answer?.groups[group] ?? []) ids.add(it.item);
  return ids;
}

/**
 * The strip: the server's when it sent one, else counted from the groups — a
 * 7.0 console's answer has no strip and no *Approve*, and still reads.
 */
export function stripOf(answer: Pick<TurnAnswer, 'groups' | 'strip'>): TurnStrip {
  if (answer.strip) return answer.strip;
  const g = answer.groups as Partial<TurnAnswer['groups']>;
  let next: TurnStrip['nextDeadline'] = null;
  for (const group of TURN_GROUPS) {
    if (group === 'done') continue;
    for (const item of g[group] ?? []) {
      const at = item.timing?.deadline;
      if (at && Number.isFinite(Date.parse(at)) && (!next || Date.parse(at) < Date.parse(next.at)))
        next = { at, item: item.item, title: item.title };
    }
  }
  return {
    todo: (g.approve?.length ?? 0) + (g.now?.length ?? 0) + (g.decide?.length ?? 0),
    checking: g.checking?.length ?? 0,
    passedToday: (g.done ?? []).filter((item) => item.personStatus === 'passed').length,
    nextDeadline: next,
  };
}
