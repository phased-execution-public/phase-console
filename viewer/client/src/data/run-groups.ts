/**
 * The groups — every run in exactly one (7.0, quiet-console phase 7; the
 * Tower's bays, control-tower phase 20, §Architecture 3–5).
 *
 * `#/runs` answers "does anything need me?" in two seconds: Your turn first —
 * the acts, one line each — then the runs in GROUPS by what each IS: Running,
 * Waiting, Queued, Ready to start (plans' ready phases, not runs), Settled.
 * The group ids are the Tower's bay words (`shared/bays.js`): the server mints
 * them into pushes, and every 6.2 address lands. This file is the fold;
 * nothing in it renders, and the one hook at the end only gathers the reads.
 * It is the header's situation words' fold too, so the two can never count
 * differently — loaded after first paint, because it carries the status word
 * tables (`check-dist`), which `lanes.ts` deliberately does not.
 *
 * ## One group per run, and it is the status model's answer
 *
 * A run's place is `bayOf(describeRun(run, ctx))` — the status model's answer
 * (phase 16), never this file's — and `ctx` travels to the row with the run,
 * so the row's own reading IS the group it sits in. The context is what only
 * the page knows: the plan closed (`planClosed`), a newer run of the same slug
 * (`newerRunId`), and the inbox. A settled or overtaken run never summons
 * anyone, because `describeRun` settles those before it looks at the inbox.
 *
 * ## Your turn holds the acts; a summoned run keeps its group
 *
 * The Needs-you bay held RUNS (a strip's one action was its oldest item's
 * primary) beside a list of the asks. 7.0 draws the asks as the first group —
 * every item of Your turn, one line each — and a run a person's turn summons
 * sits in the group of what it IS (a halted run waits, a run with a step while
 * another lane works runs), wearing the summons on its mark and offering the
 * act as its one action. One line per thing: the act is a thing, the run is a
 * thing, and neither is drawn twice. `bay` keeps the status model's word
 * (`needs-you`) for the readers that ask whether the run summons.
 *
 * ## The lamps
 *
 * One lamp per halt family (`HALT_CATEGORIES`): each unsettled halted run
 * counts under `haltView(run).category` (phase 17), and a run a person's turn
 * summons under its oldest item's family (`item.category`, the same table).
 * A settled run's old halt lights nothing — settled things go quiet. The
 * lamps are the Filter slot's panel on the home.
 */

import { BAYS } from '@shared/bays.js';
import { ciRefusalsOf, type CiRefusal } from '@shared/ci-refusal.js';
import { HALT_CATEGORIES, isHaltCategory, type HaltCategory } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { ATTENTION_LEVELS, bayOf, describeRun, type RunCtx, type StatusView } from '@shared/status-model.js';
import { useNow } from '@/lib/clock';
import { isClosed } from '@/lib/closure';
import type { InboxItem, PlanSummaryFull, QueueEntry, SlimRun, VerifyingLane } from '@/data/api';
import { useAttentionInbox } from './inbox';
import {
  asRunLike,
  checksOf,
  lanesOf,
  toDepartures,
  type Departure,
  type NowLane,
  type RunLike,
} from './lanes';
import { usePlanDetails, usePlans } from './plans';
import { useQueue } from './queue';
import { queueEntryFor } from './queue-words';
import { useRunList } from './runs';
import { itemRows, itemsNow, runItems } from './turn';

/** The six groups, in the order the home draws them. The words are the Tower's bays. */
export const RUN_GROUPS = BAYS;
export type RunGroup = (typeof BAYS)[number];

/** What each group is called on the page. Settled says "today" until Everything shows all of it. */
export const GROUP_LABELS: Readonly<Record<RunGroup, string>> = Object.freeze({
  'needs-you': 'Your turn',
  live: 'Running',
  waiting: 'Waiting',
  queued: 'Queued',
  ready: 'Ready to start',
  settled: 'Settled today',
});

/** The group a run sits in. Runs never sit in Your turn or Ready. */
export type RunHome = Exclude<RunGroup, 'needs-you' | 'ready'>;

/** Where a run goes by what it IS: a summoned run keeps the group of its tense and paint. */
export function homeOf(view: StatusView): RunHome {
  if (view.tense === 'live') return 'live';
  if (view.tense === 'settled') return 'settled';
  if (view.paint === 'queued') return 'queued';
  return 'waiting';
}

/** One run, placed. */
export interface PlacedRun {
  key: string;
  run: RunLike;
  /** This run's lanes, from the page's ONE fold. */
  lanes: NowLane[];
  /** The console's own checks on this run (`run.verifying`). */
  checks: VerifyingLane[];
  /** The admission entry of its queued lane, when the queue snapshot has one. */
  entry?: QueueEntry;
  /** `describeRun`'s context — handed to the row, so its reading is this one. */
  ctx: RunCtx;
  /** What the run IS — `describeRun`'s answer. */
  view: StatusView;
  /** The status model's bay: `needs-you` for a summoned run, whatever group it sits in. */
  bay: RunGroup;
  group: RunHome;
  /** The family its stop lights on the lamps; null when it lights none. */
  category: HaltCategory | null;
  /** Settled by going quiet past `STALE_AFTER_MS`, not by finishing. */
  dormant: boolean;
  /** Last touched, epoch ms — the settled group's order and its "today". */
  touched: number;
}

export interface GroupInput {
  runs: readonly RunLike[];
  lanes: readonly NowLane[];
  entries?: readonly QueueEntry[] | undefined;
  inbox?: readonly InboxItem[] | undefined;
  /** What could start next — `toDepartures(plans, details)`. */
  departures?: readonly Departure[] | undefined;
  /** Slugs of closed plans: their runs are history, settled and quiet. */
  closedSlugs?: ReadonlySet<string> | undefined;
  now: number;
}

export interface RunGroups {
  /** Every run, each in exactly one group. */
  runs: PlacedRun[];
  groups: Record<RunHome, PlacedRun[]>;
  /** The Ready group: plans' ready phases, not runs. */
  ready: Departure[];
  lamps: Record<HaltCategory, number>;
  /** How many things each group holds — Your turn its items, Ready its departures, the rest their runs. */
  counts: Record<RunGroup, number>;
  /**
   * The items a person owes now — one row each, oldest first, an errand and its
   * step one item (control-tower phase 139): the Your turn group.
   */
  items: InboxItem[];
  /** The items not due yet — *Coming up* (control-tower phase 121, #182): counted in no group, lighting no lamp. */
  upcoming: InboxItem[];
  /** The Settled group's two numbers, and the local midnight "today" starts at. */
  settled: { today: number; dormant: number; since: number };
  /**
   * Repositories GitHub is refusing to run CI for — ONE state each, however
   * many phases of however many runs wait behind it (control-tower phase 111,
   * #166). The wall is the repository's, so the diagnosis is too.
   */
  ciRefused: CiRefusal[];
}

export interface GroupFilter {
  /** A lamp pressed: only stops of that family. */
  category?: HaltCategory | null;
  /** Free text over plan slugs. */
  query?: string;
  /**
   * Exactly these runs and inbox rows — what a lamp this fold does not own
   * keeps (the supervisor's detection lamps, control-tower phase 102). A plan's
   * ready phase is kept by no lamp, so Ready empties, as it does for a family.
   */
  keep?: { runIds: ReadonlySet<string>; itemIds: ReadonlySet<string> } | null;
}

const stamp = (iso: string | null | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** The groups a run can sit in — the bays less the two that hold no runs, in the bays' own order. */
const RUN_HOMES: readonly RunHome[] = BAYS.filter(
  (bay): bay is RunHome => bay !== 'needs-you' && bay !== 'ready',
);

function emptyGroups(): Record<RunHome, PlacedRun[]> {
  return Object.fromEntries(RUN_HOMES.map((group) => [group, []])) as unknown as Record<RunHome, PlacedRun[]>;
}

function zeroLamps(): Record<HaltCategory, number> {
  return Object.fromEntries(HALT_CATEGORIES.map((category) => [category, 0])) as Record<HaltCategory, number>;
}

/** The newest run of each slug — any other unfinished run of it has been overtaken. */
function newestBySlug(runs: readonly RunLike[]): Map<string, RunLike> {
  const out = new Map<string, RunLike>();
  for (const run of runs) {
    const seen = out.get(run.slug);
    if (!seen || stamp(run.createdAt) > stamp(seen.createdAt)) out.set(run.slug, run);
  }
  return out;
}

/**
 * The family a row lights — the server's word, which it puts on a person's
 * turn too (its kind's family, `HUMAN_STEP_CATEGORY`, control-tower phase 42).
 */
export function categoryOfItem(item: Pick<InboxItem, 'category'>): HaltCategory | null {
  const word = item.category?.word;
  return isHaltCategory(word) ? word : null;
}

/** A summons first — the loudest attention level leads (`ATTENTION_LEVELS` is quietest-first) — then what moved last. */
const loudness = (view: StatusView): number =>
  (ATTENTION_LEVELS as readonly string[]).indexOf(view.attention);

function groupOrder(a: PlacedRun, b: PlacedRun): number {
  return loudness(b.view) - loudness(a.view) || b.touched - a.touched;
}

function lampsOf(runs: readonly PlacedRun[]): Record<HaltCategory, number> {
  const lamps = zeroLamps();
  for (const t of runs) if (t.category) lamps[t.category] += 1;
  return lamps;
}

function countsOf(
  groups: Record<RunHome, PlacedRun[]>,
  items: readonly InboxItem[],
  ready: readonly Departure[],
): Record<RunGroup, number> {
  return {
    'needs-you': items.length,
    live: groups.live.length,
    waiting: groups.waiting.length,
    queued: groups.queued.length,
    ready: ready.length,
    settled: groups.settled.length,
  };
}

export function groupRuns(input: GroupInput): RunGroups {
  const { runs, lanes, entries, inbox = [], departures = [], closedSlugs, now } = input;

  const byRun = new Map<string, NowLane[]>();
  for (const lane of lanes) {
    const list = byRun.get(lane.runId);
    if (list) list.push(lane);
    else byRun.set(lane.runId, [lane]);
  }

  const newest = newestBySlug(runs);
  const groups = emptyGroups();
  const placed: PlacedRun[] = [];

  for (const run of runs) {
    const mine = byRun.get(run.id) ?? [];
    const newer = newest.get(run.slug);
    const ctx: RunCtx = {
      planClosed: Boolean(closedSlugs?.has(run.slug)),
      newerRunId: newer && newer.id !== run.id ? newer.id : null,
      inbox,
      now,
    };
    const folded = asRunLike(run);
    const view = describeRun(folded as Parameters<typeof describeRun>[0], ctx);
    const bay = bayOf(view);
    // A summons paints the run amber and STANDING whatever it was doing
    // (`summoned` drops the tense), so its group is read off the run with no
    // item open on it: a summoned live run keeps Running, a queued one Queued.
    const own =
      bay === 'needs-you'
        ? describeRun(folded as Parameters<typeof describeRun>[0], { ...ctx, inbox: [] })
        : view;
    const group: RunHome = bay === 'needs-you' ? homeOf(own) : bay === 'ready' ? 'waiting' : bay;
    const queued = mine.find((lane) => lane.status === 'queued');
    const entry = queued ? queueEntryFor(entries, run.slug, queued.phase) : undefined;
    // A run summoned by a person's turn lights its oldest item's family when no
    // halt names one — the item IS why it waits (control-tower phases 42, 139).
    const step = bay === 'needs-you' ? runItems(inbox, run)[0] : undefined;
    const halted =
      group !== 'settled' && run.halt
        ? (haltView(folded as Parameters<typeof haltView>[0])?.category ?? null)
        : null;
    const category = halted ?? (step ? categoryOfItem(step) : null);
    const placedRun: PlacedRun = {
      key: run.id,
      run,
      lanes: mine,
      checks: checksOf(run),
      ...(entry ? { entry } : {}),
      ctx,
      view,
      bay,
      group,
      category,
      dormant: view.note?.kind === 'dormant',
      touched: stamp(run.updatedAt),
    };
    groups[group].push(placedRun);
    placed.push(placedRun);
  }

  for (const group of RUN_HOMES) groups[group].sort(groupOrder);

  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const items = itemsNow(inbox);

  return {
    runs: placed,
    groups,
    ready: [...departures],
    lamps: lampsOf(placed),
    counts: countsOf(groups, items, departures),
    items,
    upcoming: itemRows(inbox.filter((row) => row.turn?.group === 'upcoming')),
    settled: {
      today: groups.settled.filter((t) => !t.dormant && t.touched >= midnight).length,
      dormant: groups.settled.filter((t) => t.dormant).length,
      since: midnight,
    },
    ciRefused: ciRefusalsOf(runs as Parameters<typeof ciRefusalsOf>[0]),
  };
}

/**
 * The groups under a filter. The text narrows everything, the lamps included;
 * a pressed lamp narrows the groups to its family — and leaves the lamps alone,
 * because they are the panel you filter WITH, and a panel that went dark the
 * moment you pressed it could never be pressed again.
 */
export function filterGroups(model: RunGroups, filter: GroupFilter): RunGroups {
  const query = filter.query?.trim().toLowerCase() ?? '';
  const category = filter.category ?? null;
  const keep = filter.keep ?? null;
  if (!query && !category && !keep) return model;

  const bySlug = (slug: string | undefined) => !query || (slug ?? '').toLowerCase().includes(query);
  const runs = model.runs.filter((t) => bySlug(t.run.slug));
  const lamps = lampsOf(runs);

  const inFamily = (t: PlacedRun) =>
    (!category || t.category === category) && (!keep || keep.runIds.has(t.run.id));
  const groups = emptyGroups();
  for (const group of RUN_HOMES)
    groups[group] = model.groups[group].filter((t) => bySlug(t.run.slug) && inFamily(t));
  // A plan's ready phase has stopped for nothing, so no family holds it.
  const ready = category || keep ? [] : model.ready.filter((d) => bySlug(d.slug));
  // A person's turn, due or coming up, narrows as its family's runs do.
  const itemShown = (item: InboxItem) =>
    bySlug(item.slug ?? item.title) &&
    (!category || categoryOfItem(item) === category) &&
    (!keep || keep.itemIds.has(item.id));
  const items = model.items.filter(itemShown);

  return {
    runs: model.runs.filter((t) => bySlug(t.run.slug) && inFamily(t)),
    groups,
    ready,
    lamps,
    counts: countsOf(groups, items, ready),
    items,
    upcoming: model.upcoming.filter(itemShown),
    settled: {
      today: groups.settled.filter((t) => !t.dormant && t.touched >= model.settled.since).length,
      dormant: groups.settled.filter((t) => t.dormant).length,
      since: model.settled.since,
    },
    // A repository's refusal is no halt family's, so only the text narrows it.
    ciRefused: model.ciRefused
      .map((item) => ({ ...item, phases: item.phases.filter((p) => bySlug(p.slug)) }))
      .filter((item) => item.phases.length > 0),
  };
}

/** The fold's clock period — a re-fold, never a printed duration. */
const MINUTE = 60_000;

/**
 * The home's one fold of its groups — the model, the slim rows it folded, and
 * whether the Ready group is still reading plans. The header's situation words
 * read the same hook, so the two can never count differently.
 *
 * It reads the SLIM list (#234), the queue, the inbox and the plan summaries;
 * `details` reads each ready plan's detail — one engine read each — so only
 * the home asks for it, never the header.
 */
export function useRunGroups(input: { enabled: boolean; details: boolean }): {
  model: RunGroups;
  runs: SlimRun[] | undefined;
  /** The runs have not answered yet: nothing can be said. */
  pending: boolean;
  readyLoading: boolean;
  entries: QueueEntry[] | undefined;
} {
  const { enabled, details } = input;
  const { data: runs } = useRunList(enabled);
  const { data: queue } = useQueue(enabled);
  const { data: plans } = usePlans(enabled);
  const inbox = useAttentionInbox(false, enabled);
  const summaries = (plans ?? []) as unknown as readonly PlanSummaryFull[];
  const readySlugs = summaries.filter((p) => !isClosed(p) && (p.ready?.length ?? 0) > 0).map((p) => p.slug);
  const { bySlug, loading } = usePlanDetails(readySlugs, details && readySlugs.length > 0);
  // The fold's own clock — "today" and "dormant" move on the minute, not the
  // second; each row keeps its own finer clock.
  const minute = Math.floor(useNow(true, MINUTE) / MINUTE) * MINUTE;
  const departures = toDepartures(summaries, bySlug, minute);
  const closedSlugs = new Set(summaries.filter((p) => isClosed(p)).map((p) => p.slug));
  const list = runs ?? [];
  const model = groupRuns({
    runs: list,
    lanes: lanesOf(list, bySlug, minute),
    entries: queue?.entries,
    inbox: inbox.data?.items,
    departures,
    closedSlugs,
    now: minute,
  });
  return { model, runs, pending: runs == null, readyLoading: details && loading, entries: queue?.entries };
}
