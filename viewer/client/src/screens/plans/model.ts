/**
 * The plans library's model (7.0, quiet-console phase 9) — every plan of the
 * source as one resolved row, and the orders, filters, groups and folds the
 * page draws it through.
 *
 * A `PlanRow` is the `/api/plans` summary flattened and finished: counts
 * resolved, the title through `plainText`, idle days computed once, the
 * newest run joined on as its view in context, and how many things wait on a
 * person. Everything a sort, a filter, a column or a card needs is a property
 * of the row, so the list and the cards cannot disagree about what a plan is.
 *
 * It reads the SLIM run list (#234): a run's word in context needs its status,
 * its lifecycle, its halt and one word per phase, which is what the slim row
 * carries; nothing here reads a whole record.
 *
 * ⚠️ `/api/plans` sends `ready`, `inProgress`, `stuck` and `qaFailures` as
 * arrays of phase NUMBERS, and `waiting` as a plain count.
 */

import { describeRun, describeWord, type RunCtx, type StatusView } from '@shared/status-model.js';
import { countsTowardAttention } from '@shared/attention-model.js';
import { PLAN_STATUS_ORDER } from '@shared/plan-vocab.js';
import type { UiState } from '@shared/status-vocab.js';
import type { EtaEstimate, InboxItem, PlanSummaryFull } from '@/data/api';
import { asRunLike, type RunLike } from '@/data/lanes';
import { isClosed as readClosed } from '@/lib/closure';
import { plural } from '@/lib/format';
import { defineFilters, defineSorts, matchesWords, words, type SortSpec } from '@/lib/list-model';
import { plainText } from '@/lib/plain-text';

/** The newest run of a plan, as much of it as a row can use. */
export interface RowRun {
  id: string;
  status: string;
  /** The run as the status model reads it IN CONTEXT — its plan's closure, the inbox and the clock. */
  view: StatusView;
  /** The run as `RunStatus` reads it, for a page that draws it beside its own word. */
  record: RunLike;
  activePhase: number | null;
  updatedAt: number;
}

/** One plan, resolved. */
export interface PlanRow {
  slug: string;
  /** Already through `plainText` — titles are markdown on disk. */
  title: string;
  kind: string;
  status: string;
  isPlan: boolean;
  /** Every phase done, whether or not anybody closed the plan. */
  isComplete: boolean;
  /**
   * The operator closed it — its status is terminal. Not `isComplete`: a plan
   * is closed with phases left (`abandoned`), and complete before anyone closes it.
   */
  isClosed: boolean;
  closedStatus?: string;
  closedOn?: string;
  closedReason?: string;

  phases: number;
  /** The last good reading's when the board could not be read (#96) — `progress` says so. */
  done: number;
  percent: number;
  /** `unknown` when this read of the board failed (#96); the track draws `progressReading`. */
  progress?: 'unknown';
  lastGood?: { done: number; phases: number; percent: number; at: number; ageMs: number };
  readyPhases: number[];
  inProgress: number[];
  stuck: number[];
  waiting: number;
  qaFailures: number[];
  remainingSessions: number;
  eta?: EtaEstimate;

  repos: string[];
  branch?: string;
  handoffCount: number;
  activity: number;
  /** Whole days since anything in this plan moved. */
  idleDays: number;

  errors: number;
  warnings: number;
  /** The worst issue's message — what the broken-plans banner names. */
  firstIssue?: string;
  /** A live claim by a session, and whether its lease has lapsed. */
  claim?: { owner: string; phase?: number; expired: boolean };
  /**
   * How many inbox items wait on a PERSON for this plan — the unified inbox
   * counted per slug, which knows the gates, errands and sign-ins no field of
   * `/api/plans` mentions. `fyi` is not counted: a ruling is worth reading and
   * nobody is waiting on it. Zero on a closed plan.
   */
  needsYou: number;

  run?: RowRun;
  /** The summary as the server sent it — the inspector's raw tab. Absent on a row built by hand. */
  summary?: PlanSummaryFull;
}

const DAY = 86_400_000;

const stamp = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * Build the list.
 *
 * `now` is a parameter so idle days are one answer for the whole render and a
 * test can state the date. Each plan is joined to its NEWEST run, by when the
 * run was created, whatever order the list arrived in.
 */
export function toRows(
  plans: readonly PlanSummaryFull[],
  runs: readonly RunLike[] = [],
  now = Date.now(),
  /** The unified inbox, or nothing on a console that cannot answer for it. */
  inbox: readonly InboxItem[] = [],
): PlanRow[] {
  const waiting = new Map<string, number>();
  for (const item of inbox) {
    if (!item.slug || !countsTowardAttention(item.severity)) continue;
    waiting.set(item.slug, (waiting.get(item.slug) ?? 0) + 1);
  }

  const newest = new Map<string, RunLike>();
  for (const run of runs) {
    const held = newest.get(run.slug);
    if (!held || stamp(run.createdAt) > stamp(held.createdAt)) newest.set(run.slug, run);
  }
  const rowRun = (run: RunLike | undefined, planClosed: boolean): RowRun | undefined =>
    run && {
      id: run.id,
      status: run.status,
      view: describeRun(asRunLike(run) as Parameters<typeof describeRun>[0], {
        planClosed,
        inbox: inbox as RunCtx['inbox'],
        now,
      }),
      record: run,
      activePhase: run.activePhase ?? null,
      updatedAt: stamp(run.updatedAt),
    };

  return plans.map((plan) => {
    const phases = plan.phases ?? 0;
    const done = plan.done ?? plan.lastGood?.done ?? 0;
    const issues = plan.issues ?? [];
    // An engine that cannot read a plan is an error whether or not it reached
    // `issues` — a plan nobody can parse is the most broken kind there is.
    const errors = (plan.issueCounts?.error ?? 0) + (plan.engineError ? 1 : 0);
    const worst = issues.find((i) => i.severity === 'error') ?? issues.find((i) => i.severity === 'warning');
    const claim = (plan.locks ?? [])[0];
    const closed = readClosed(plan);
    const kind = plan.kind ?? 'plan';

    return {
      slug: plan.slug,
      title: plainText(plan.title) || plan.slug,
      kind,
      status: plan.status ?? 'unknown',
      isPlan: kind === 'plan',
      isComplete: plan.status === 'complete' || (phases > 0 && done >= phases),
      isClosed: closed,
      closedStatus: closed ? plan.status : undefined,
      closedOn: plan.closedOn,
      closedReason: plan.closedReason,

      phases,
      done,
      percent: plan.percent ?? plan.lastGood?.percent ?? 0,
      ...(plan.progress ? { progress: plan.progress } : {}),
      ...(plan.lastGood ? { lastGood: plan.lastGood } : {}),
      readyPhases: (plan.ready ?? []).filter((n): n is number => typeof n === 'number'),
      inProgress: plan.inProgress ?? [],
      stuck: plan.stuck ?? [],
      waiting: plan.waiting ?? 0,
      qaFailures: plan.qaFailures ?? [],
      remainingSessions: plan.remainingSessions ?? 0,
      eta: plan.eta,

      repos: plan.repos ?? [],
      branch: plan.branch,
      handoffCount: plan.handoffCount ?? 0,
      activity: plan.activity ?? 0,
      idleDays: plan.activity ? Math.max(0, Math.floor((now - plan.activity) / DAY)) : 0,

      errors,
      warnings: plan.issueCounts?.warning ?? 0,
      firstIssue: plan.engineError ?? worst?.message,
      claim: claim ? { owner: claim.owner, phase: claim.phase, expired: claim.expired } : undefined,
      needsYou: closed ? 0 : (waiting.get(plan.slug) ?? 0),

      run: rowRun(newest.get(plan.slug), closed),
      summary: plan,
    };
  });
}

/* ------------------------------------------------------------------ *
 * The mark — the row's dot and word
 * ------------------------------------------------------------------ */

/**
 * Which word leads the row. A person waited on outranks everything (amber is
 * the one summons): the run's own summons when it carries one, else the
 * inbox's count. Then a run that has not settled says what it is doing. Then
 * the plan's own status — and a document is not a plan, so it has no status
 * at all, only its kind.
 */
export type MarkKind = 'kind' | 'run' | 'attention' | 'plan';

export function markKind(row: PlanRow): MarkKind {
  if (!row.isPlan) return 'kind';
  const view = row.run?.view;
  if (view && view.attention !== 'none' && !row.isClosed) return 'run';
  if (row.needsYou > 0) return 'attention';
  if (view && view.tense !== 'settled' && !row.isClosed) return 'run';
  return 'plan';
}

/** The plan's own stored status, as the status model words it. */
export const planView = (row: Pick<PlanRow, 'status'>): StatusView => describeWord('plan', row.status);

/** What a document is called instead of a status. */
export const kindWord = (row: Pick<PlanRow, 'kind'>): string =>
  row.kind === 'orphan-handoffs' ? 'Handoffs only' : row.kind === 'document' ? 'Document' : row.kind;

/** The mark's hue — the row's leading edge, the card's edge. `undefined` draws no edge. */
export function markPaint(row: PlanRow): UiState | undefined {
  switch (markKind(row)) {
    case 'kind':
      return undefined;
    case 'attention':
      return 'needs-you';
    case 'run':
      return row.run!.view.paint as UiState;
    case 'plan': {
      const view = planView(row);
      return view.tense === 'settled' ? undefined : (view.paint as UiState);
    }
  }
}

/** The mark's word, as text — what a column sorts and groups by. */
export function markLabel(row: PlanRow): string {
  switch (markKind(row)) {
    case 'kind':
      return kindWord(row);
    case 'attention':
      return 'Needs you';
    case 'run':
      return row.run!.view.label;
    case 'plan':
      return planView(row).label;
  }
}

/* ------------------------------------------------------------------ *
 * The line — a plan folded to labelled stations
 * ------------------------------------------------------------------ */

/** One station of a row's track: a count or a phase, its board word, its paint. */
export interface LineStation {
  key: string;
  label: string;
  paint: UiState;
  settled: boolean;
  /** The phase this station IS, when it is one phase rather than a count. */
  phase?: number;
  count?: number;
}

const boardPaint = (word: string): UiState => describeWord('board', word).paint as UiState;

/** A run of phases as one station when there are several, each its own when there are few. */
function standing(phases: readonly number[], word: string, said: string, limit: number): LineStation[] {
  const paint = boardPaint(word);
  if (phases.length <= limit) {
    return phases.map((phase) => ({
      key: `${word}-${phase}`,
      label: `P${phase} ${said}`,
      paint,
      settled: false,
      phase,
    }));
  }
  return [{ key: word, label: `${phases.length} ${said}`, paint, settled: false, count: phases.length }];
}

/**
 * The plan as a line folded to the stations a glance can read — the same
 * grammar the run row draws: what is done as one hollow station, every phase
 * that stands (in progress, stuck, next up) by name while they are few, and
 * what is left as one more. A closed plan paints only what got done; the rest
 * never ran, and the line says so rather than calling it ready.
 *
 * Empty for a board the engine could not read — the row draws the shared
 * reading instead (`progressReading`), never a line at 0 %.
 */
export function lineOf(row: PlanRow): LineStation[] {
  if (!row.phases || row.progress === 'unknown') return [];
  const out: LineStation[] = [];
  if (row.done > 0) {
    out.push({ key: 'done', label: `${row.done} done`, paint: 'done', settled: true, count: row.done });
  }
  if (row.isClosed) {
    const never = Math.max(0, row.phases - row.done);
    if (never > 0) {
      out.push({ key: 'never', label: `${never} never ran`, paint: 'skipped', settled: true, count: never });
    }
    return out;
  }
  out.push(...standing(row.inProgress, 'in-progress', 'in progress', 2));
  out.push(...standing(row.stuck, 'stuck', 'stuck', 1));
  out.push(...standing(row.readyPhases, 'ready', 'next up', 1));
  const left = Math.max(
    0,
    row.phases - row.done - row.inProgress.length - row.stuck.length - row.readyPhases.length,
  );
  if (left > 0) out.push({ key: 'left', label: `${left} left`, paint: 'queued', settled: true, count: left });
  return out;
}

/**
 * The work still to do, in the unit the engine forecasts it in — sessions —
 * as the row's one fact. The line beside it already says how many phases.
 */
export function leftWords(row: PlanRow): string {
  if (!row.isPlan) return row.phases ? plural(row.phases, 'phase') : 'No phases';
  if (row.progress === 'unknown') return 'Unknown';
  if (row.isClosed) {
    const never = Math.max(0, row.phases - row.done);
    return never ? `${never} never ran` : 'Nothing left';
  }
  if (row.isComplete) return 'Nothing left';
  if (row.remainingSessions > 0) return plural(row.remainingSessions, 'session');
  const left = Math.max(0, row.phases - row.done);
  return left ? plural(left, 'phase') : 'Nothing left';
}

/* ------------------------------------------------------------------ *
 * Concerns — what is wrong with a plan, worst first
 * ------------------------------------------------------------------ */

export type ConcernTone = 'bad' | 'warn';

export interface Concern {
  key: string;
  text: string;
  tone: ConcernTone;
}

/**
 * Ordered worst first; empty means the plan is fine. One list serving two
 * jobs — the reasons a row's detail names and the key the `attention` order
 * sorts by — so a plan never sits on top of "Needs attention" with nothing on
 * screen saying why.
 *
 * A closed plan keeps only its STRUCTURAL concern, demoted to `warn` — the
 * shape the server gives its issues. `stuck`, `qaFailures` and `locks` stay
 * populated on a closed plan by design, and re-deriving warnings from them
 * would bring back exactly what closing it silenced.
 */
export function concerns(row: PlanRow): Concern[] {
  const out: Concern[] = [];
  if (row.errors > 0) {
    out.push({
      key: 'error',
      text: row.firstIssue ?? plural(row.errors, 'error'),
      tone: row.isClosed ? 'warn' : 'bad',
    });
  }
  if (row.isClosed) return out;
  if (row.needsYou > 0) {
    out.push({ key: 'needs-you', text: `${plural(row.needsYou, 'thing')} waiting on you`, tone: 'bad' });
  }
  if (row.run?.status === 'halted')
    out.push({ key: 'halted', text: 'the autopilot halted here', tone: 'bad' });
  if (row.stuck.length) {
    out.push({ key: 'stuck', text: `phase ${row.stuck.join(', ')} is stuck`, tone: 'bad' });
  }
  if (row.qaFailures.length) {
    out.push({ key: 'qa', text: `QA failed at phase ${row.qaFailures.join(', ')}`, tone: 'warn' });
  }
  if (row.claim?.expired)
    out.push({ key: 'lock', text: `a lapsed claim by ${row.claim.owner}`, tone: 'warn' });
  // Idle counts only against a plan that COULD be moving: one waiting on a
  // dependency has nothing anybody could have done.
  if (row.idleDays >= 7 && row.readyPhases.length > 0 && !row.isComplete) {
    out.push({ key: 'idle', text: `${plural(row.idleDays, 'day')} untouched with work ready`, tone: 'warn' });
  }
  return out;
}

/** How bad the worst thing is — lower is worse; `Infinity` when nothing is. */
const severity = (row: PlanRow): number => {
  const list = concerns(row);
  if (!list.length) return Number.POSITIVE_INFINITY;
  return list[0].tone === 'bad' ? 0 : 1;
};

/* ------------------------------------------------------------------ *
 * Orders — five, each leading with a different first key
 * ------------------------------------------------------------------ */

const byName = (a: PlanRow, b: PlanRow): number =>
  a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);

const SORT_SPECS = {
  activity: {
    label: 'Recent',
    hint: 'last touched',
    blurb: 'Most recently active first — where the context is still warm.',
    compare: (a, b) => b.activity - a.activity || byName(a, b),
  },
  progress: {
    label: 'Closest to done',
    hint: 'furthest along',
    blurb: 'Nearly-finished plans first. Finishing one is worth more than starting two.',
    // Complete plans sink: the question is which ones you can still finish.
    compare: (a, b) =>
      Number(a.isComplete) - Number(b.isComplete) ||
      b.percent - a.percent ||
      a.phases - a.done - (b.phases - b.done) ||
      byName(a, b),
  },
  ready: {
    label: 'Most ready',
    hint: 'work available now',
    blurb: 'Plans with the most phases that could start today — where the capacity is.',
    // Closed plans sink in both work-shaped orders: their ready phases are
    // real, but a closed plan is never the answer to "where do I go next".
    compare: (a, b) =>
      Number(a.isClosed) - Number(b.isClosed) ||
      b.readyPhases.length - a.readyPhases.length ||
      b.remainingSessions - a.remainingSessions ||
      b.activity - a.activity ||
      byName(a, b),
  },
  attention: {
    label: 'Needs attention',
    hint: 'broken or rotting',
    blurb: 'Errors, halted runs and stuck phases first, then plans left idle with work ready.',
    compare: (a, b) =>
      Number(a.isClosed) - Number(b.isClosed) ||
      severity(a) - severity(b) ||
      concerns(b).length - concerns(a).length ||
      b.idleDays - a.idleDays ||
      byName(a, b),
  },
  name: {
    label: 'Name',
    hint: 'A to Z',
    blurb: 'Alphabetical — for when you already know which one you want.',
    compare: byName,
  },
} satisfies Record<string, SortSpec<PlanRow>>;

export type SortId = keyof typeof SORT_SPECS;

/** Declaration order is the default order: an id the kit does not know reads as the first. */
export const { SORTS, isSortId, sortRows } = defineSorts<PlanRow, SortId>(SORT_SPECS);

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/** A TYPE, not an interface: `defineFilters` needs the implicit index signature. */
export type Filters = {
  /** Free text over slug and title; every word must match, in any order. */
  query: string;
  /** Include documents and orphan handoff sets in the list, not only plans. */
  showDocuments: boolean;
  /** Include closed plans — complete, abandoned, superseded — in the list. */
  showClosed: boolean;
  repo: string;
  status: string;
};

/**
 * The status control's two questions no single status answers: three words
 * mean closed. `@` cannot collide with a status, which is a bare YAML word.
 */
export const OPEN_ONLY = '@open';
export const CLOSED_ONLY = '@closed';

const isSentinel = (status: unknown): boolean => status === OPEN_ONLY || status === CLOSED_ONLY;

/** `cart api` finds `cart-api-endpoint` — words, in any order, over slug and title. */
export function matchesPlan(row: PlanRow, query: string): boolean {
  return matchesWords(`${row.slug} ${row.title}`, words(query));
}

/**
 * The five filters. `inert` is spelled out on both include toggles because
 * their resting value (`false`) is the one that narrows: `true` narrows
 * nothing. A status filter that names a closure, or a closed status, stands
 * the closed toggle down — otherwise "closed only" and "leave closed out"
 * cancel and the list comes back empty.
 */
export const { NO_FILTERS, applyFilters, activeCount } = defineFilters<PlanRow, Filters>({
  query: {
    initial: '',
    prepare: (value) => words(value),
    keep: (row, terms) => matchesWords(`${row.slug} ${row.title}`, terms as string[]),
    // The search field carries its own text; the Filter count does not repeat it.
    counts: false,
  },
  showDocuments: {
    initial: false,
    inert: (value) => value,
    keep: (row) => row.isPlan,
  },
  showClosed: {
    initial: false,
    inert: (value) => value,
    keep: (row, _value, all) => isSentinel(all.status) || !row.isClosed || all.status === row.status,
  },
  repo: {
    initial: '',
    keep: (row, value) => row.repos.includes(value as string),
  },
  status: {
    initial: '',
    keep: (row, value) => {
      if (value === OPEN_ONLY) return !row.isClosed;
      if (value === CLOSED_ONLY) return row.isClosed;
      return row.status === value;
    },
  },
});

/**
 * What the filters leave out, and which filter does it — each number MEASURED
 * by re-running the real filter with one toggle moved, never by a second copy
 * of the predicate. Each answers "turn this one on, and how much comes back".
 */
export interface HiddenBreakdown {
  total: number;
  closed: number;
  documents: number;
  /** Left out by the search, repo or status fields. */
  search: number;
  shapeOnly: boolean;
}

export function hiddenBreakdown(rows: readonly PlanRow[], filters: Filters): HiddenBreakdown {
  const shown = applyFilters(rows, filters).length;
  const withClosed = applyFilters(rows, { ...filters, showClosed: true }).length;
  const withDocuments = applyFilters(rows, { ...filters, showDocuments: true }).length;
  const widened = applyFilters(rows, { ...filters, showClosed: true, showDocuments: true }).length;
  return {
    total: rows.length - shown,
    closed: withClosed - shown,
    documents: withDocuments - shown,
    search: rows.length - widened,
    shapeOnly: widened === rows.length,
  };
}

/** Every repo the list names, most-used first — the repo filter's own vocabulary. */
export function repoOptions(rows: readonly PlanRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const repo of row.repos) counts.set(repo, (counts.get(repo) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo);
}

const STATUS_ORDER: readonly string[] = PLAN_STATUS_ORDER;

/** The statuses the source holds, in the order a plan travels through them, then the rest. */
export function statusOptions(rows: readonly PlanRow[]): string[] {
  const seen = new Set(rows.map((r) => r.status));
  const known = STATUS_ORDER.filter((s) => seen.has(s));
  const rest = [...seen].filter((s) => !STATUS_ORDER.includes(s)).sort();
  return [...known, ...rest];
}

/* ------------------------------------------------------------------ *
 * The estate — the list, and the two folds under it
 * ------------------------------------------------------------------ */

/**
 * What the page draws: the rows the filters keep, and — folded under them,
 * each with its count named — the closed plans and the documents the same
 * filters would keep if they were let in. Measured through the real filter
 * with one flag moved, so the search narrows a fold exactly as it narrows the
 * list; and a row already in the list is never folded again (a status filter
 * naming a closure stands the closed toggle down, so the guard is "is it on
 * the page", never "is the toggle on").
 */
export interface Estate {
  list: PlanRow[];
  closed: PlanRow[];
  documents: PlanRow[];
}

export function estateOf(rows: readonly PlanRow[], filters: Filters, sort: SortId | string): Estate {
  const list = sortRows(applyFilters(rows, filters), sort);
  const shown = new Set(list.map((row) => row.slug));
  const closed = sortRows(
    applyFilters(rows, { ...filters, showClosed: true }).filter(
      (row) => row.isClosed && row.isPlan && !shown.has(row.slug),
    ),
    sort,
  );
  const folded = new Set([...shown, ...closed.map((row) => row.slug)]);
  const documents = sortRows(
    applyFilters(rows, { ...filters, showDocuments: true, showClosed: true }).filter(
      (row) => !row.isPlan && !folded.has(row.slug),
    ),
    sort,
  );
  return { list, closed, documents };
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

export type GroupBy = 'none' | 'status' | 'repo';

export const PLAN_GROUPS: readonly { id: GroupBy; label: string }[] = [
  { id: 'none', label: 'One list' },
  { id: 'status', label: 'Plan status' },
  { id: 'repo', label: 'Repository' },
];

export const isGroupBy = (value: unknown): value is GroupBy =>
  value === 'none' || value === 'status' || value === 'repo';

export interface PlanGroup {
  key: string;
  label: string;
  rows: PlanRow[];
}

/**
 * Section the list. Rows keep the order the sort gave them — a group that
 * re-sorted its contents would silently stop the sort applying. A plan naming
 * several repos sits under each; one naming none is its own group, never dropped.
 */
export function groupRows(rows: readonly PlanRow[], by: GroupBy): PlanGroup[] {
  if (by === 'none') return [{ key: 'all', label: 'All', rows: [...rows] }];
  const groups = new Map<string, PlanRow[]>();
  const push = (key: string, row: PlanRow) => {
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  };
  for (const row of rows) {
    if (by === 'status') push(row.status, row);
    else if (!row.repos.length) push('', row);
    else for (const repo of row.repos) push(repo, row);
  }
  const rank = (key: string) => {
    if (by === 'status') {
      const i = STATUS_ORDER.indexOf(key);
      return i === -1 ? STATUS_ORDER.length : i;
    }
    return key ? 0 : 1;
  };
  return [...groups]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([key, list]) => ({
      key: key || 'unassigned',
      label:
        by === 'status'
          ? key
            ? describeWord('plan', key).label
            : 'No status'
          : key || 'No repository named',
      rows: list,
    }));
}

/* ------------------------------------------------------------------ *
 * The views a person may choose
 * ------------------------------------------------------------------ */

export type PlansLayout = 'list' | 'cards';

/**
 * The stored word, read. `cards` is the browsing view; everything else — the
 * 7.0 `list`, and 6.x's `table` and its default `board` — reads as the list,
 * which is 7.0's library: one line per plan.
 */
export const layoutOf = (stored: string | undefined): PlansLayout => (stored === 'cards' ? 'cards' : 'list');

/* ------------------------------------------------------------------ *
 * Totals, and the sentence they make
 * ------------------------------------------------------------------ */

/**
 * What the rows add up to. The work figures (`ready`, `sessions`, `running`)
 * leave closed plans out — they are readings of what is left to do — while
 * the census counts every plan, the split the server's `portfolio()` makes.
 */
export function rowTotals(rows: readonly PlanRow[]) {
  let plans = 0;
  let documents = 0;
  let closed = 0;
  let phases = 0;
  let done = 0;
  let ready = 0;
  let sessions = 0;
  let errors = 0;
  let running = 0;
  let needsYou = 0;
  for (const row of rows) {
    if (row.isPlan) plans++;
    else documents++;
    phases += row.phases;
    done += row.done;
    if (row.isClosed) {
      closed++;
      continue;
    }
    ready += row.readyPhases.length;
    sessions += row.remainingSessions;
    needsYou += row.needsYou;
    if (row.errors) errors++;
    if (row.run?.view.paint === 'running' && row.run.view.tense === 'live') running++;
  }
  return {
    plans,
    documents,
    closed,
    phases,
    done,
    ready,
    sessions,
    errors,
    running,
    needsYou,
    total: rows.length,
  };
}

/**
 * The page's lead: what the open plans hold for somebody to do, in one
 * sentence — or nothing, when there is nothing to say.
 */
export function workSentence(totals: ReturnType<typeof rowTotals>): string {
  const parts: string[] = [];
  if (totals.needsYou) parts.push(`${plural(totals.needsYou, 'thing')} waiting on you`);
  if (totals.running) parts.push(`${totals.running} running`);
  if (totals.ready) parts.push(`${plural(totals.ready, 'phase')} ready to start`);
  if (totals.sessions) parts.push(`about ${plural(totals.sessions, 'session')} of work left`);
  if (!parts.length) return '';
  const last = parts.pop()!;
  const sentence = parts.length ? `${parts.join(', ')} and ${last}` : last;
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * Repos at the length a row carries: two and a count past three, the whole
 * list as the title.
 */
export function repoLabel(repos: readonly string[]): { text: string; title: string } {
  const title = repos.join(', ');
  if (repos.length <= 3) return { text: title, title };
  return { text: `${repos.slice(0, 2).join(', ')} +${repos.length - 2}`, title };
}
