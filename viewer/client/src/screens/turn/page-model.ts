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
  TURN_BOARD_COLUMNS,
  TURN_DEADLINE_BANDS,
  TURN_DEADLINE_LABEL,
  TURN_GROUPINGS,
  TURN_GROUPS,
  TURN_GROUP_LABEL,
  TURN_TABS,
  TURN_TAB_LABEL,
  TURN_VIEWS,
  TURN_VIEW_ALIASES,
  TYPE_META,
  WHY_PERSON,
  type ItemType,
  type PersonStatus,
  type RiskTier,
  type RouteTo,
  type TurnDeadlineBand,
  type TurnGroup,
  type TurnGrouping,
  type TurnTab,
  type TurnPageView,
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
  /** A group, the handled log — or, grouped, `<grouping>:<key>` (`plan:<slug>`, `type:do`…). */
  id: SectionId | `${Exclude<Grouping, 'asked'>}:${string}`;
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

/** What each grouping does, in the Group slot's words — the ids are `TURN_GROUPINGS`'. */
const GROUPING_WORDS: Readonly<Record<TurnGrouping, { label: string; blurb: string }>> = Object.freeze({
  asked: { label: 'What is asked', blurb: 'Approve, do now, decide, being checked, coming up, done.' },
  plan: { label: 'Plan', blurb: 'One section per plan.' },
  type: { label: 'Type', blurb: 'Approvals, tasks, decisions and heads-ups apart.' },
  deadline: { label: 'Deadline', blurb: 'Past its deadline, due within a day, due later, none set.' },
  status: { label: 'Status', blurb: 'To do, checking, redo and the rest, by the person’s status.' },
});

/** What each view draws — the ids are `TURN_VIEWS`'. */
const VIEW_WORDS: Readonly<Record<TurnPageView, { label: string; blurb: string }>> = Object.freeze({
  list: { label: 'List', blurb: 'One line per item; the selected card opens beside the list.' },
  board: { label: 'Board', blurb: 'Columns by status: to do, checking, redo, waiting for the owner, done.' },
  cards: { label: 'Cards', blurb: 'Every item drawn whole.' },
  timeline: { label: 'Timeline', blurb: 'Every item on one clock, from when it was raised to its deadline.' },
});

/** The Group slot's choices, in `TURN_GROUPINGS` order. */
export const GROUPINGS: readonly { id: TurnGrouping; label: string; blurb: string }[] = Object.freeze(
  TURN_GROUPINGS.map((id) => ({ id, ...GROUPING_WORDS[id] })),
);
export const SORTS = Object.freeze([
  { id: 'oldest', label: 'Oldest first', blurb: 'What has waited longest leads each section.' },
  { id: 'newest', label: 'Newest first', blurb: 'What arrived last leads.' },
  { id: 'deadline', label: 'Deadline first', blurb: 'The nearest deadline leads; items with none follow.' },
] as const);
/** The View slot's choices, in `TURN_VIEWS` order. */
export const VIEWS: readonly { id: TurnPageView; label: string; blurb: string }[] = Object.freeze(
  TURN_VIEWS.map((id) => ({ id, ...VIEW_WORDS[id] })),
);
/** The tabs, in `TURN_TABS` order. */
export const TABS: readonly { id: TurnTab; label: string }[] = Object.freeze(
  TURN_TABS.map((id) => ({ id, label: TURN_TAB_LABEL[id] })),
);

export type Grouping = TurnGrouping;
export type SortOrder = (typeof SORTS)[number]['id'];
export type ViewMode = TurnPageView;
export type ArrangeKey = 'group' | 'sort' | 'view' | 'tab';
export type Arrangement = { group: Grouping; sort: SortOrder; view: ViewMode; tab: TurnTab };

/**
 * The arrangement an address carries; a word none of them holds reads as the
 * default, and 7.1's `?view=compact` as the list (`TURN_VIEW_ALIASES`).
 */
export function arrangementOf(query: Readonly<Record<string, string>>): Arrangement {
  const pick = <T extends string>(list: readonly { id: T }[], value: string | undefined): T =>
    list.find((one) => one.id === value)?.id ?? list[0]!.id;
  const view = (TURN_VIEW_ALIASES as Readonly<Record<string, TurnPageView>>)[query.view ?? ''] ?? query.view;
  return {
    group: pick(GROUPINGS, query.group),
    sort: pick(SORTS, query.sort),
    view: pick(VIEWS, view),
    tab: pick(TABS, query.tab),
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

/** The open sections — every one but *Done* and the handled log; what *Export* writes. */
export function openSections(sections: readonly TurnSection[]): TurnSection[] {
  return sections.filter((section) => section.id !== 'done' && section.id !== 'handled');
}

/* ------------------------------------------------------------------ *
 * The tabs, the groupings, the board and the timeline (one-pool phase 14)
 * ------------------------------------------------------------------ */

/** The sections a tab shows: Open the five open groups, Done and Handled their own, All every one. */
export function tabSections(sections: readonly TurnSection[], tab: TurnTab): TurnSection[] {
  if (tab === 'all') return [...sections];
  if (tab === 'done') return sections.filter((section) => section.id === 'done');
  if (tab === 'handled') return sections.filter((section) => section.id === 'handled');
  return openSections(sections);
}

/** How many items (or handled rows) a tab holds after the filters — its count on the tab bar. */
export function tabCount(sections: readonly TurnSection[], tab: TurnTab, headsUp = 0): number {
  const shown = tabSections(sections, tab).reduce((n, section) => n + section.count, 0);
  return tab === 'open' || tab === 'all' ? shown + headsUp : shown;
}

/** The deadline band an item stands in at `now`. */
export function deadlineBandOf(item: Pick<TurnItem, 'timing'>, now: number): TurnDeadlineBand {
  const at = item.timing?.deadline ? Date.parse(item.timing.deadline) : NaN;
  if (!Number.isFinite(at)) return 'none';
  if (at < now) return 'overdue';
  return at - now <= DAY_MS ? 'today' : 'later';
}

/** The key and words one item is grouped under, for a grouping other than *What is asked*. */
function groupKeyOf(
  item: TurnItem,
  group: Exclude<Grouping, 'asked'>,
  now: number,
): { key: string; label: string } {
  switch (group) {
    case 'plan':
      return { key: item.slug ?? '', label: item.slug || 'No plan' };
    case 'type': {
      const type = item.type ?? 'do';
      return { key: type, label: TYPE_META[type]?.label ?? type };
    }
    case 'deadline': {
      const band = deadlineBandOf(item, now);
      return { key: band, label: TURN_DEADLINE_LABEL[band] };
    }
    case 'status': {
      const status = item.personStatus ?? 'todo';
      return { key: status, label: PERSON_STATUS_LABEL[status] ?? status };
    }
  }
}

/** The order a grouping's sections are drawn in: a vocabulary's own, or (plans) first seen. */
const GROUP_ORDER: Readonly<Record<Exclude<Grouping, 'asked' | 'plan'>, readonly string[]>> = Object.freeze({
  type: ITEM_TYPES,
  deadline: TURN_DEADLINE_BANDS,
  status: PERSON_STATUSES,
});

/**
 * The tab's sections, regrouped. *What is asked* is the server's groups as
 * they are. Any other grouping puts the tab's items under one section per
 * plan, type, deadline band or status — only the ones that hold something, in
 * the vocabulary's order (plans as first seen) — and leaves what is over as it
 * is: *Done* and the handled log follow, never mixed into the open work. On
 * the Done tab the settled items are themselves what is regrouped.
 */
export function groupSections(
  sections: readonly TurnSection[],
  group: Grouping,
  now = Date.now(),
): TurnSection[] {
  if (group === 'asked') return [...sections];
  const onlyDone = sections.every((section) => section.id === 'done' || section.id === 'handled');
  const regrouped = sections.filter((section) =>
    onlyDone ? section.id === 'done' : section.id !== 'done' && section.id !== 'handled',
  );
  const kept = sections.filter((section) => !regrouped.includes(section));
  const buckets = new Map<string, { label: string; items: TurnItem[] }>();
  for (const section of regrouped) {
    for (const item of section.items) {
      const { key, label } = groupKeyOf(item, group, now);
      const held = buckets.get(key) ?? { label, items: [] };
      held.items.push(item);
      buckets.set(key, held);
    }
  }
  const order = group === 'plan' ? [...buckets.keys()] : GROUP_ORDER[group].filter((key) => buckets.has(key));
  const grouped: TurnSection[] = order.map((key) => {
    const held = buckets.get(key)!;
    return {
      id: `${group}:${key}`,
      label: held.label,
      items: held.items,
      count: held.items.length,
      total: held.items.length,
    };
  });
  return [...grouped, ...kept];
}

/** Grouped by plan — `groupSections(…, 'plan')`, kept by its 7.1 name. */
export function byPlan(sections: readonly TurnSection[]): TurnSection[] {
  return groupSections(sections, 'plan');
}

/** What an empty open group is, as a phrase the one shared line lists. */
const EMPTY_PHRASE: Readonly<Record<TurnGroup, string>> = Object.freeze({
  approve: 'to approve',
  now: 'to do now',
  decide: 'to decide',
  checking: 'being checked',
  upcoming: 'coming up',
  done: 'settled today',
});

/** "a, b or c" — the shared line's list. */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/**
 * The sections a page draws, and the one line that stands for every empty
 * group (#377): three empty groups no longer take three headings, they read
 * "Nothing to approve, to do now or to decide." — and a filter that hid every
 * item of a group still says so, under its heading. Only the groups of *What
 * is asked* fold; the handled log keeps its own line.
 */
export function foldEmpty(
  sections: readonly TurnSection[],
  /** Groups that hold an item pressed a moment ago (#270): they keep their heading, to hold it under. */
  keep: ReadonlySet<string> = new Set(),
): { sections: TurnSection[]; empty: string | null } {
  const folded = sections.filter(
    (section) =>
      section.total === 0 &&
      !keep.has(section.id) &&
      section.id !== 'handled' &&
      (TURN_GROUPS as readonly string[]).includes(section.id),
  );
  if (!folded.length) return { sections: [...sections], empty: null };
  return {
    sections: sections.filter((section) => !folded.includes(section)),
    empty: `Nothing ${orList(folded.map((section) => EMPTY_PHRASE[section.id as TurnGroup]))}.`,
  };
}

/** Every item the sections hold, in order — the list's rows, the board's and the timeline's. */
export function itemsOf(sections: readonly TurnSection[]): TurnItem[] {
  return sections.flatMap((section) => section.items);
}

/** One lane of the board: its column cells, in `TURN_BOARD_COLUMNS` order. */
export type BoardLane = {
  id: string;
  label: string;
  columns: { id: string; label: string; items: TurnItem[] }[];
};

/**
 * The board (#377): columns by the person's status, the Owner To-Do Board's
 * shape, in one lane — or, grouped, one lane per section (a plan, a type…), so
 * `?view=board&group=plan` is the board with a lane per plan.
 */
export function boardOf(sections: readonly TurnSection[], group: Grouping): BoardLane[] {
  const lanes =
    group === 'asked'
      ? [{ id: 'all', label: '', items: itemsOf(sections) }]
      : sections
          .filter((section) => section.id !== 'handled' && section.items.length > 0)
          .map((section) => ({ id: section.id, label: section.label, items: section.items }));
  return lanes.map((lane) => ({
    id: lane.id,
    label: lane.label,
    columns: TURN_BOARD_COLUMNS.map((column) => ({
      id: column.id,
      label: column.label,
      items: lane.items.filter((item) => column.statuses.includes(item.personStatus ?? 'todo')),
    })),
  }));
}

/** One item on the timeline: where its bar starts and ends, and its marks, as fractions of the span. */
export type TimelineRow = {
  item: TurnItem;
  /** When it was raised (assigned), 0–1. */
  from: number;
  /** Its deadline, else now, 0–1. */
  to: number;
  /** When it is due to be done (NOT YET's *when*), 0–1, if it has one. */
  start?: number;
  /** Its deadline is set (the bar's end is a deadline, not now). */
  deadline: boolean;
  overdue: boolean;
};

/**
 * The timeline (#377): every item placed on ONE clock, now in the middle —
 * the past from the earliest raised item to now on the left, the future from
 * now to the latest deadline on the right, each side on a square-root scale,
 * so an item raised an hour ago stays readable beside a deadline weeks away.
 * An item with no deadline runs to now, its end left open.
 */
export function timelineOf(
  items: readonly TurnItem[],
  now: number,
): { start: number; end: number; now: number; nowAt: number; rows: TimelineRow[] } {
  const at = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
  let start = now;
  let end = now;
  for (const item of items) {
    for (const t of [
      at(item.timing?.assignedAt ?? item.since),
      at(item.timing?.deadline),
      at(item.timing?.startAt),
    ]) {
      if (!Number.isFinite(t)) continue;
      start = Math.min(start, t);
      end = Math.max(end, t);
    }
  }
  const past = now - start;
  const ahead = end - now;
  // With nothing ahead the past takes the whole line, and the other way round.
  const nowAt = past > 0 && ahead > 0 ? 0.5 : past > 0 ? 1 : 0;
  const frac = (t: number) =>
    t <= now
      ? past > 0
        ? nowAt * (1 - Math.sqrt((now - t) / past))
        : nowAt
      : ahead > 0
        ? nowAt + (1 - nowAt) * Math.sqrt(Math.min(1, (t - now) / ahead))
        : nowAt;
  const rows = items.map((item) => {
    const raised = at(item.timing?.assignedAt ?? item.since);
    const deadline = at(item.timing?.deadline);
    const due = at(item.timing?.startAt);
    const from = frac(Number.isFinite(raised) ? raised : now);
    const has = Number.isFinite(deadline);
    return {
      item,
      from,
      to: Math.max(from, frac(has ? deadline : now)),
      ...(Number.isFinite(due) ? { start: frac(due) } : {}),
      deadline: has,
      overdue: has && deadline < now,
    };
  });
  return { start, end, now, nowAt, rows };
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
