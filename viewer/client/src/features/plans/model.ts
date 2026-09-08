/**
 * The plan list, as an estate you can interrogate.
 *
 * ## What the old view threw away
 *
 * `/api/plans` sends about thirty-five fields per plan. The view that stood here
 * rendered five of them — slug, title, phase count, done count, and the *length*
 * of the ready array — in a single unordered scroll. In this source that is
 * sixty-five plans and fifteen documents in one list, with no way to ask which
 * are finished, which are broken, which have work available, or where anything
 * is. The percent, the activity date, the health issues, the locks, the repos,
 * the remaining sessions and the stuck phases were all on the wire and none of
 * them were on the screen.
 *
 * Three preferences for exactly this — `sort`, `showDocuments`, `showComplete` —
 * had been sitting in `lib/prefs.ts` since the first phase, read by nothing.
 *
 * ## What a row is
 *
 * A `PlanRow` is the summary flattened and finished: counts resolved, the title
 * already through `plainText`, idle days computed once, and the newest run for
 * that plan joined on. Everything a sort, a filter or a card needs is a property
 * of the row — no view reaches back into the payload, so the list and the table
 * cannot disagree about what a plan is.
 *
 * ⚠️ `/api/plans` sends `ready`, `inProgress`, `stuck` and `qaFailures` as arrays
 * of **numbers**, but `waiting` as a plain count. Reading the first group as
 * objects is the defect that made the ready board unusable for a month.
 */

import { plainText } from '@/components/markdown';
import { defineFilters, defineSorts, matchesWords, words, type SortSpec } from '@/lib/list-model';
import { plural } from '@/lib/format';
import { runUiState, type UiState } from '@/lib/status-vocab';
import { isClosed as readClosed } from '@/lib/closure';
import { countsTowardAttention } from '@shared/attention-model.js';
import { PLAN_STATUS_ORDER } from '@shared/plan-vocab.js';
import type { EtaEstimate, PlanSummaryFull, RunState } from '@/lib/api';

/** The newest run on a plan, as much of it as a list row can use. */
export interface RowRun {
  id: string;
  status: string;
  /** The run's status through the vocabulary. */
  ui: UiState;
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
  isComplete: boolean;
  /**
   * The operator closed this plan — its status is terminal. Every attention
   * surface skips it; the row still renders in full. ⚠️ Not the same question as
   * `isComplete`: a plan can be closed with phases left (`abandoned`), and a plan
   * whose phases are all done is `isComplete` before anyone closes it.
   */
  isClosed: boolean;
  /** The word — `complete`, `abandoned`, `superseded` — behind the CLOSED badge. */
  closedStatus?: string;
  closedOn?: string;
  closedReason?: string;

  phases: number;
  done: number;
  percent: number;
  readyPhases: number[];
  inProgress: number[];
  stuck: number[];
  waiting: number;
  qaFailures: number[];
  remainingSessions: number;
  /** How long this plan has left, when there is anything left. See `EtaEstimate`. */
  eta?: EtaEstimate;

  repos: string[];
  branch?: string;
  handoffCount: number;
  activity: number;
  /** Whole days since anything in this plan moved. */
  idleDays: number;

  errors: number;
  warnings: number;
  /** The worst issue's message, for the attention band. */
  firstIssue?: string;
  /** A live claim by another session, and whether its lease has lapsed. */
  claim?: { owner: string; phase?: number; expired: boolean };
  /**
   * How many inbox items are waiting on a PERSON for this plan.
   *
   * Not derived from the row like `concerns` is — it is the unified inbox
   * (`/api/inbox`, Phase 4) counted per slug, which knows about gates, errands,
   * sign-ins and MCP walls that no field of `/api/plans` mentions. `fyi` is
   * excluded: a ruling is worth reading and is not a thing anyone is waiting
   * for, and a list that counted it would tell every plan it needs attention.
   *
   * Zero on a console whose server predates the endpoint. A silent zero is the
   * honest answer there — the row makes no claim rather than a false one.
   */
  needsYou: number;

  run?: RowRun;
}

const DAY = 86_400_000;

/**
 * Build the list.
 *
 * `now` is a parameter rather than a call to the clock, so idle days are one
 * consistent answer for the whole render and a test can state the date — the
 * same reason `views/ready/model.ts` takes one.
 *
 * `runs` arrives newest-first from `/api/runs`, so first-seen wins and each plan
 * is joined to its most recent run only. A plan's run history is the fleet's
 * subject, not this page's.
 */
export function toRows(
  plans: readonly PlanSummaryFull[],
  runs: readonly RunState[] = [],
  now = Date.now(),
  /** The unified inbox, or nothing on a console that cannot answer for it. */
  inbox: readonly { slug?: string; severity: string }[] = [],
): PlanRow[] {
  // `fyi` is informational — see `PlanRow.needsYou`.
  const waiting = new Map<string, number>();
  for (const item of inbox) {
    if (!item.slug || !countsTowardAttention(item.severity)) continue;
    waiting.set(item.slug, (waiting.get(item.slug) ?? 0) + 1);
  }

  const newest = new Map<string, RowRun>();
  for (const run of runs) {
    if (newest.has(run.slug)) continue;
    newest.set(run.slug, {
      id: run.id,
      status: run.status,
      ui: runUiState(run.status),
      activePhase: run.activePhase ?? null,
      updatedAt: Date.parse(run.updatedAt) || 0,
    });
  }

  return plans.map((plan) => {
    const phases = plan.phases ?? 0;
    const done = plan.done ?? 0;
    const issues = plan.issues ?? [];
    // The engine failing to read a plan is an error whether or not it made it
    // into `issues` — a plan nobody can parse is the most broken kind there is.
    const errors = (plan.issueCounts?.error ?? 0) + (plan.engineError ? 1 : 0);
    const worst = issues.find((i) => i.severity === 'error') ?? issues.find((i) => i.severity === 'warning');
    const claim = (plan.locks ?? [])[0];
    const closed = readClosed(plan);

    return {
      slug: plan.slug,
      title: plainText(plan.title) || plan.slug,
      kind: plan.kind ?? 'plan',
      status: plan.status ?? 'unknown',
      isPlan: (plan.kind ?? 'plan') === 'plan',
      isComplete: plan.status === 'complete' || (phases > 0 && done >= phases),
      isClosed: closed,
      closedStatus: closed ? plan.status : undefined,
      closedOn: plan.closedOn,
      closedReason: plan.closedReason,

      phases,
      done,
      percent: plan.percent ?? 0,
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
      // A closed plan reports nothing to do, for the same reason its ready
      // chips are suppressed — the inbox already drops it, and this is the
      // belt to that braces.
      needsYou: closed ? 0 : (waiting.get(plan.slug) ?? 0),

      run: newest.get(plan.slug),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Concerns
 *
 * What is wrong with a plan, worst first. This is one list serving two jobs: it
 * is the content of the attention band and of a row's warning chips, and it is
 * the key the `attention` sort orders by. Deriving the sort from the same
 * function that draws the reasons is what stops a plan sitting at the top of
 * "needs attention" with nothing on screen explaining why.
 * ------------------------------------------------------------------ */

export type ConcernTone = 'bad' | 'warn';

export interface Concern {
  key: string;
  text: string;
  tone: ConcernTone;
}

/**
 * Ordered worst first. An empty list means the plan is fine.
 *
 * ## Closure
 *
 * A closed plan keeps only its **structural** concern, demoted to `warn` — the
 * exact shape the server gives its issues (`healthIssues()` drops the progress
 * kinds and demotes `engine` / `phase-count` / `undefined-dep` / `orphan` to
 * `info`). Everything else here is a progress concern, and this list is the
 * client's attention vocabulary: it is the chip on the row, the reasons in the
 * band, and the key the `attention` sort orders by. Leaving `stuck`, `qa` and
 * `lock` in would re-derive from `stuck` / `qaFailures` / `locks` — three fields
 * the server deliberately leaves populated — the very warnings closing the plan
 * was supposed to silence.
 *
 * The demotion, not deletion, is the point: a closed plan the engine cannot
 * parse still says so, it just stops outranking a live plan's real error.
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

  // First after a broken plan, because it is the only concern that is somebody
  // ALREADY WAITING rather than a condition that might want looking at.
  if (row.needsYou > 0) {
    out.push({
      key: 'needs-you',
      text: `${plural(row.needsYou, 'thing')} waiting on you`,
      tone: 'bad',
    });
  }
  if (row.run?.status === 'halted') {
    out.push({ key: 'halted', text: 'the autopilot halted here', tone: 'bad' });
  }
  if (row.stuck.length) {
    out.push({ key: 'stuck', text: `phase ${row.stuck.join(', ')} is stuck`, tone: 'bad' });
  }
  if (row.qaFailures.length) {
    out.push({ key: 'qa', text: `QA failed at phase ${row.qaFailures.join(', ')}`, tone: 'warn' });
  }
  if (row.claim?.expired) {
    out.push({ key: 'lock', text: `a lapsed claim by ${row.claim.owner}`, tone: 'warn' });
  }
  // Idle only counts against a plan that *could* be moving. A plan waiting on a
  // dependency has nothing anybody could have done, and calling that neglect
  // would bury the ones where somebody genuinely stopped.
  if (row.idleDays >= 7 && row.readyPhases.length > 0 && !row.isComplete) {
    out.push({ key: 'idle', text: `${plural(row.idleDays, 'day')} untouched with work ready`, tone: 'warn' });
  }

  return out;
}

/** How bad the worst thing is — lower is worse. `Infinity` when nothing is. */
const severity = (row: PlanRow): number => {
  const list = concerns(row);
  if (!list.length) return Number.POSITIVE_INFINITY;
  return list[0].tone === 'bad' ? 0 : 1;
};

/* ------------------------------------------------------------------ *
 * Ordering
 *
 * Five orders, each leading with a different first key, because "show me the
 * plans" is five different questions. Five sorts of the same list that all put
 * the same plan on top would be one sort with a decorative control.
 * ------------------------------------------------------------------ */

/**
 * Ahead of the specs below, and it has to be: `name`'s comparator IS this
 * function, so the record's own evaluation reads it.
 */
const byName = (a: PlanRow, b: PlanRow): number =>
  a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug);

/**
 * The five orders, as one record: the words, the gloss, and the comparator.
 *
 * `defineSorts` builds `SORTS`, `isSortId` and `sortRows` off this — the three
 * shapes this file used to declare by hand out of an `as const` array plus a
 * `Record<SortId, …>` that had to be kept in step with it. The mechanism is
 * shared; the vocabulary below is not, and stays exactly what it was.
 */
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
    // Complete plans sink: "closest to done" asked for the ones you can still
    // finish, and a wall of 100% bars answers a question nobody had.
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
    // Closed plans sink in both work-shaped orders. Their `readyPhases` are
    // real — the engine reports what never got done — but "most ready" and
    // "needs attention" are both the question *where should I go next*, and a
    // plan the operator has closed is never the answer. Sunk rather than
    // dropped: the filter decides what is on the list, a sort only decides
    // where.
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

/**
 * Declaration order is the DEFAULT order — `sortRows` falls back to the first
 * spec for an id it does not know, so a `sort` preference written by a browser
 * that predates an order being renamed still renders a list.
 */
export const { SORTS, isSortId, sortRows } = defineSorts<PlanRow, SortId>(SORT_SPECS);

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * A TYPE, not an interface, and that is load-bearing: `defineFilters` needs
 * `Record<string, unknown>` so a predicate can read a sibling's value, and TS
 * gives an implicit index signature to an object type alias and never to an
 * interface.
 */
export type Filters = {
  /** Free text over slug and title. Every word must match, in any order. */
  query: string;
  /** Include documents and orphan handoff sets, not only plans. */
  showDocuments: boolean;
  /**
   * Keep closed plans — complete, abandoned and superseded — in the list.
   *
   * **Off by default, and that is the deliberate divergence.** The toggle this
   * replaces (`showComplete`) defaulted to *true*, so this source opened on
   * sixty-four finished plans and three live ones. Closure is the operator
   * saying nobody is coming back; the list should open on the work.
   *
   * It is a new preference key rather than a flipped default because
   * `setPrefs()` persists the whole object — every browser that has ever
   * touched any control already has `showComplete: true` on disk, so changing
   * that key's default would have reached nobody. See `lib/prefs.ts`.
   */
  showClosed: boolean;
  /** One repo, or every repo. */
  repo: string;
  /** One status, or every status. */
  status: string;
};

/**
 * Two sentinels the status control offers besides the statuses themselves.
 *
 * "Closed" is a question about a plan that no single status answers — three
 * words mean it (`complete`, `abandoned`, `superseded`) and picking one of them
 * from the dropdown gives a third of the answer. They live in the status value
 * space rather than in a control of their own because they are the same
 * question the operator is already asking there, and `@` cannot collide with a
 * status: these come out of YAML frontmatter, where they are bare words.
 */
export const OPEN_ONLY = '@open';
export const CLOSED_ONLY = '@closed';

/** True while the status control is asking a closure question, not a status one. */
const isSentinel = (status: unknown): boolean => status === OPEN_ONLY || status === CLOSED_ONLY;

/**
 * `cart api` finds `cart-api-endpoint`.
 *
 * Words rather than a substring, because slugs are hyphenated and titles are
 * prose, so the thing you remember is rarely contiguous in either. Kept as its
 * own export because it is also the predicate the palette and the tests ask
 * about directly; the filter below runs the prepared form.
 */
export function matches(row: PlanRow, query: string): boolean {
  return matchesWords(`${row.slug} ${row.title}`, words(query));
}

/**
 * The five filters, as predicates.
 *
 * Two of them read a sibling, which is why `keep` is handed the whole set:
 * the status control can ask a CLOSURE question (`@open` / `@closed`) rather
 * than name a status, and while it is doing that the closed toggle must not
 * also have an opinion — otherwise "closed only" and "hide closed" would
 * cancel and the list would come back empty.
 *
 * `inert` is spelled out on both toggles because their resting value is not
 * their no-op value: `showClosed: false` is what NARROWS, and `true` is what
 * narrows nothing. The default (`value === initial`) would have them exactly
 * backwards, which is how "hide closed plans" becomes "hide nothing".
 */
export const { NO_FILTERS, applyFilters, activeCount } = defineFilters<PlanRow, Filters>({
  query: {
    initial: '',
    // Once per pass, not once per row: this list is filtered on every
    // keystroke, over every plan in the source.
    prepare: (value) => words(value),
    keep: (row, terms) => matchesWords(`${row.slug} ${row.title}`, terms as string[]),
    // The search field carries its own text; counting it again on the phone's
    // filter badge would double-report what the operator is looking at.
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
    keep: (row, _value, all) =>
      // Asking for a status by name overrides the closed filter: picking
      // `abandoned` from the dropdown and getting an empty list would read as a
      // broken control rather than as a filter fighting another filter.
      isSentinel(all.status) || !row.isClosed || all.status === row.status,
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
 * What the filters are dropping, and which filter is doing it.
 *
 * A single "N hidden" is true and useless once N gets large: on this machine's
 * source it reads 86 of 87, and the operator's reasonable conclusion is that the
 * page is broken rather than that two toggles are doing exactly what they were
 * asked to. The distinction that matters is between the SHAPE toggles — closed
 * and documents, which are sticky preferences that survive reloads and are
 * usually the whole answer — and the SEARCH filters, which the operator set
 * seconds ago and already knows about.
 *
 * Counted independently, not as a cascade: `closed` is every closed row the
 * closed toggle is dropping, whether or not a document, so the two numbers can
 * overlap. Each answers "turn this one thing on and how much comes back", which
 * is the question the buttons beside them actually pose.
 */
export interface HiddenBreakdown {
  /** Rows the filters dropped, all reasons together. */
  total: number;
  /** Dropped for being closed — what `Show closed` would bring back. */
  closed: number;
  /** Dropped for not being a plan — what `Documents` would bring back. */
  documents: number;
  /** Dropped by the query, repo or status fields. */
  search: number;
  /** Nothing but the sticky shape toggles is hiding anything. */
  shapeOnly: boolean;
}

export function hiddenBreakdown(rows: readonly PlanRow[], filters: Filters): HiddenBreakdown {
  // Every number here is MEASURED by re-running the real filter with one toggle
  // moved, never by re-deriving the predicate. A second copy of "is this row
  // dropped" is a second thing to keep in step with `applyFilters`, and the way
  // it fails is a button promising to bring back rows it then does not.
  const shown = applyFilters(rows, filters).length;
  const withClosed = applyFilters(rows, { ...filters, showClosed: true }).length;
  const withDocuments = applyFilters(rows, { ...filters, showDocuments: true }).length;
  const widened = applyFilters(rows, { ...filters, showClosed: true, showDocuments: true }).length;
  return {
    total: rows.length - shown,
    closed: withClosed - shown,
    documents: withDocuments - shown,
    // What the query/repo/status fields cost, measured with the shape toggles
    // already open so the two are not counted against each other.
    search: rows.length - widened,
    shapeOnly: widened === rows.length,
  };
}

/** Every repo the list names, most-used first — the filter's own vocabulary. */
export function repoOptions(rows: readonly PlanRow[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const repo of row.repos) counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo);
}

/**
 * Statuses in the order a plan travels through them, then anything
 * unrecognised. Ordering lives in `shared/plan-vocab.js` beside the words.
 */
const STATUS_ORDER: readonly string[] = PLAN_STATUS_ORDER;

export function statusOptions(rows: readonly PlanRow[]): string[] {
  const seen = new Set(rows.map((r) => r.status));
  const known = STATUS_ORDER.filter((s) => seen.has(s));
  const rest = [...seen].filter((s) => !STATUS_ORDER.includes(s)).sort();
  return [...known, ...rest];
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

export type GroupBy = 'none' | 'status' | 'repo';

export interface Group {
  key: string;
  label: string;
  rows: PlanRow[];
}

/**
 * Section the list.
 *
 * Rows keep the order the sort gave them; grouping only decides where the
 * headings fall. A group that re-sorted its own contents would mean the sort
 * control silently stops applying the moment you group.
 */
export function groupRows(rows: readonly PlanRow[], by: GroupBy): Group[] {
  if (by === 'none') return [{ key: 'all', label: 'All', rows: [...rows] }];

  const groups = new Map<string, PlanRow[]>();
  const push = (key: string, row: PlanRow) => {
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  };

  for (const row of rows) {
    if (by === 'status') push(row.status, row);
    // A plan can name several repos, so it appears under each. A plan naming
    // none is not "repo: none", it is a plan that never said — and dropping it
    // from a grouped view would make rows vanish when you press Group.
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
      label: key || (by === 'repo' ? 'No repo named' : 'No status'),
      rows: list,
    }));
}

/* ------------------------------------------------------------------ *
 * Totals
 * ------------------------------------------------------------------ */

/**
 * What the visible list adds up to.
 *
 * `sessions` sums the engine's own `remainingSessions` rather than dividing
 * weight by budget here — batching is the engine's decision, and a second
 * implementation of it would eventually disagree with the plan pages.
 *
 * **The work figures exclude closed plans; the census does not.** `ready`,
 * `sessions` and `errors` are readings of what is left to do, and a closed plan
 * has nothing left to do by definition — the same split the server makes in
 * `portfolio()`, where `totals.ready` and `remainingSessions` filter to the open
 * plans while `phases` / `done` / `percent` still count everything. Closing a
 * plan quiets it; it does not delete its history.
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
    if (row.errors) errors++;
    if (row.run?.ui === 'running') running++;
  }

  return { plans, documents, closed, phases, done, ready, sessions, errors, running, total: rows.length };
}
