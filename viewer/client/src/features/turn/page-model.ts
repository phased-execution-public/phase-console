/**
 * Your turn's page, as data (control-tower phase 137, #214, §Architecture 19).
 *
 * The server owns the turn: `GET /api/turn` folds every inbox row that asks a
 * person for an act into ONE item and groups it (`server/turn/index.ts`
 * `turnView`); this file decides nothing about an item. What it owns is the
 * PAGE: the six sections in their order, the filters and the search a person
 * narrows them with — all of it in the address, so a filtered view is a link —
 * the facets those filters offer, the ledger's older settled steps as history,
 * and which item `#/turn/<id>` names.
 *
 * Pure and React-free, so `page-model.test.ts` proves it without a page.
 */

import { HUMAN_STEP_KINDS, HUMAN_STEP_SETTLED_STATES, KIND_META } from '@shared/human-step-model.js';
import { describeWord } from '@shared/status-model.js';
import {
  REASON_META,
  RISK_TIERS,
  TURN_GROUPS,
  TURN_GROUP_LABEL,
  WHY_PERSON,
  type RiskTier,
  type TurnGroup,
} from '@shared/turn-model.js';
import type { HandledRow, HumanStepRecord, TurnAnswer, TurnItem } from '@/lib/api';
import type { Route } from '@/app/routes';

/* ------------------------------------------------------------------ *
 * The sections
 * ------------------------------------------------------------------ */

/** A section of the page: one of the five groups the server folds, or what the AI handled. */
export type SectionId = TurnGroup | 'handled';

/** The six, in the order the page draws them — the groups as the model orders them, then the handled log. */
export const SECTIONS: readonly SectionId[] = Object.freeze([...TURN_GROUPS, 'handled'] as SectionId[]);

/** What each section is called — the groups' own labels (`TURN_GROUP_LABEL`), and one more. */
export const SECTION_LABEL: Readonly<Record<SectionId, string>> = Object.freeze({
  ...TURN_GROUP_LABEL,
  handled: 'Handled by the AI',
});

/** A section as the page draws it: its items (or handled rows) after the filters, and how many there were before. */
export type Section = {
  id: SectionId;
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

/** What a person narrowed the page by. Every key is a query parameter of `#/turn`. */
export type TurnFilters = {
  plan?: string;
  run?: string;
  kind?: string;
  /** The reason only a person fits it (`WHY_PERSON`). */
  why?: string;
  risk?: string;
  /** Words, every one of which must be found. */
  q?: string;
};

/** The query keys the filters own, in the order the toolbar draws them. */
export const FILTER_KEYS = Object.freeze(['plan', 'run', 'kind', 'why', 'risk', 'q'] as const);

const has = (list: readonly string[], word: string | undefined): word is string =>
  typeof word === 'string' && list.includes(word);

/**
 * The filters an address carries. A plan, a run and the search are any words;
 * a kind, a reason and a risk must be words their vocabulary holds — an
 * unknown one is ignored, never guessed at (the `?bay=` rule).
 */
export function filtersOf(query: Readonly<Record<string, string>>): TurnFilters {
  const out: TurnFilters = {};
  const word = (key: string): string | undefined => {
    const value = query[key]?.trim();
    return value ? value : undefined;
  };
  const plan = word('plan');
  if (plan) out.plan = plan;
  const run = word('run');
  if (run) out.run = run;
  const kind = word('kind');
  if (has(HUMAN_STEP_KINDS, kind)) out.kind = kind;
  const why = word('why');
  if (has(WHY_PERSON, why)) out.why = why;
  const risk = word('risk');
  if (has(RISK_TIERS, risk)) out.risk = risk;
  const q = word('q');
  if (q) out.q = q;
  return out;
}

/** Does any filter narrow the page? */
export function filtering(filters: TurnFilters): boolean {
  return FILTER_KEYS.some((key) => Boolean(filters[key]));
}

/**
 * The address with the filters changed — the item it names and anything else
 * on it (an overlay) kept; a filter set to nothing is taken off.
 */
export function filtersHref(route: Route, patch: Partial<TurnFilters>): string {
  const query: Record<string, string> = { ...route.query };
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || !String(value).trim()) delete query[key];
    else query[key] = String(value).trim();
  }
  const search = new URLSearchParams(query).toString();
  return `#/${route.path || 'turn'}${search ? `?${search}` : ''}`;
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
    KIND_META[item.kind]?.label,
    REASON_META[item.why]?.label,
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

/** Does an item pass the filters? Every word of the search must be found, in any order. */
export function matches(item: TurnItem, filters: TurnFilters): boolean {
  if (filters.plan && item.slug !== filters.plan) return false;
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

/** The six sections, in order, narrowed by the filters. */
export function sectionsOf(answer: TurnAnswer, filters: TurnFilters): Section[] {
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
    const items = all.filter((it) => matches(it, filters));
    return { id, label: SECTION_LABEL[id], items, count: items.length, total: all.length };
  });
}

/* ------------------------------------------------------------------ *
 * The facets
 * ------------------------------------------------------------------ */

/** One choice a filter offers: the word, what a person reads, and how many items carry it. */
export type Facet = { value: string; label: string; count: number };

export type Facets = Record<'plan' | 'run' | 'kind' | 'why' | 'risk', Facet[]>;

/** Every choice each filter offers — only what the turn holds, the most common first. */
export function facetsOf(answer: TurnAnswer | undefined): Facets {
  const tally = {
    plan: new Map(),
    run: new Map(),
    kind: new Map(),
    why: new Map(),
    risk: new Map(),
  } as Record<keyof Facets, Map<string, number>>;
  const bump = (key: keyof Facets, value: string | undefined) => {
    if (value) tally[key].set(value, (tally[key].get(value) ?? 0) + 1);
  };
  for (const group of TURN_GROUPS) {
    for (const it of answer?.groups[group] ?? []) {
      bump('plan', it.slug);
      bump('run', it.runId);
      bump('kind', it.kind);
      bump('why', it.why);
      bump('risk', itemRisk(it));
    }
  }
  const label: Record<keyof Facets, (value: string) => string> = {
    plan: (v) => v,
    run: (v) => v,
    kind: (v) => KIND_META[v as keyof typeof KIND_META]?.label ?? v,
    why: (v) => REASON_META[v as keyof typeof REASON_META]?.label ?? v,
    risk: (v) => describeWord('risk', v).label,
  };
  const facets = {} as Facets;
  for (const key of Object.keys(tally) as (keyof Facets)[]) {
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

/** The item `#/turn/<id>` names — by its id, or by an inbox row it stands for — wherever it is grouped. */
export function itemOf(answer: TurnAnswer | undefined, id: string | undefined): TurnItem | null {
  if (!answer || !id) return null;
  for (const group of TURN_GROUPS) {
    const found = answer.groups[group]?.find((it) => it.item === id || it.rows.includes(id));
    if (found) return found;
  }
  return null;
}
