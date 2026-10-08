/**
 * The Tower's model — every run in exactly one bay (control-tower phase 20,
 * §Architecture 3–5).
 *
 * `#/runs` answers "does anything need me?" in two seconds: the runs folded
 * into BAYS most urgent first — Needs you, Live, Waiting, Queued, Ready to
 * start, Settled — an annunciator of halt families over them, and one
 * situation line above. This file is the fold; nothing in it renders.
 *
 * ## One bay per run, and it is the strip's
 *
 * A run's bay is `bayOf(describeRun(run, ctx))` — the status model's answer
 * (phase 16), never this file's — and `ctx` travels to the strip with the run,
 * so the strip's own `stripModel(…).bay` (phase 19) IS the bay it sits in. The
 * context is what only the page knows: the plan closed (`planClosed`), a newer
 * run of the same slug (`newerRunId`), and the inbox. A stop with an open item
 * moves to Needs you; a settled or overtaken run never does, because
 * `describeRun` settles those before it looks at the inbox.
 *
 * ## Now's bands, absorbed rather than copied
 *
 * Its INBOX is Your turn now (control-tower phase 139, #216): the Needs-you bay
 * keeps runs — a strip is a run, and Runs must answer "which run?" — each
 * strip's ONE action its oldest item's primary, and the asks no strip draws
 * moved to the page, which the bay and the situation line link to. Its LANES
 * ride on the Live bay's strips; its NEXT UP is the Ready bay —
 * `toDepartures`, the same set, handed in.
 *
 * ## The annunciator
 *
 * One lamp per halt family (`HALT_CATEGORIES`): each unsettled halted run
 * counts under `haltView(run).category` (phase 17), and a run a person's turn
 * summons under its oldest item's family (`item.category`, the same table).
 * A settled run's old halt lights nothing — settled things go quiet.
 */

import { BAYS, bayOf, describeRun, type RunCtx } from '@shared/status-model.js';
import { HALT_CATEGORIES, isHaltCategory, type HaltCategory } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { ciRefusalsOf, type CiRefusal } from '@shared/ci-refusal.js';
import type { InboxItem, QueueEntry, RunState, VerifyingLane } from '@/lib/api';
import { itemRows, itemsNow, runItems } from '@/features/turn/surfaces';
import type { Departure, NowLane } from '@/features/runs/lanes-model';
import { queueEntryFor } from '../queue-words';
import { verifyingLanes } from '../verifying-lane';

export type Bay = (typeof BAYS)[number];

/** One run, placed. */
export interface TowerRun {
  key: string;
  run: RunState;
  /** This run's lanes, from the page's ONE `nowLanes` fold. */
  lanes: NowLane[];
  /** The console's own checks on this run (`run.verifying`). */
  checks: VerifyingLane[];
  /** The admission entry of its queued lane, when the queue snapshot has one. */
  entry?: QueueEntry;
  /** `describeRun`'s context — handed to the strip, so its bay is this one. */
  ctx: RunCtx;
  bay: Bay;
  /** The family its stop lights on the annunciator; null when it lights none. */
  category: HaltCategory | null;
  /** Settled by going quiet past `STALE_AFTER_MS`, not by finishing. */
  dormant: boolean;
  /** Last touched, epoch ms — the settled bay's order and its "today". */
  touched: number;
}

export interface TowerInput {
  runs: readonly RunState[];
  lanes: readonly NowLane[];
  entries?: readonly QueueEntry[] | undefined;
  inbox?: readonly InboxItem[] | undefined;
  /** Now's Next-up set — `toDepartures(plans, details)`. */
  departures?: readonly Departure[] | undefined;
  /** Slugs of closed plans: their runs are history, settled and quiet. */
  closedSlugs?: ReadonlySet<string> | undefined;
  now: number;
}

export interface TowerModel {
  /** Every run, each in exactly one bay. */
  runs: TowerRun[];
  bays: Record<Bay, TowerRun[]>;
  /** The Ready bay: plans' ready phases, not runs. */
  ready: Departure[];
  annunciator: Record<HaltCategory, number>;
  /** How many things each bay holds — runs, and Ready its departures. */
  counts: Record<Bay, number>;
  /**
   * The items a person owes now — one row each, oldest first, an errand and its
   * step one item (control-tower phase 139): *Your turn (n)*, and the page.
   */
  items: InboxItem[];
  /**
   * The items not due yet — *Coming up* (control-tower phase 121, #182): on the
   * page, counted in no bay, lighting no lamp.
   */
  upcoming: InboxItem[];
  /** The Settled bay's two numbers, and the local midnight "today" starts at. */
  settled: { today: number; dormant: number; since: number };
  /**
   * Repositories GitHub is refusing to run CI for — ONE state each, however
   * many phases of however many runs wait behind it (control-tower phase 111,
   * #166). The wall is the repository's, so the diagnosis is too.
   */
  ciRefused: CiRefusal[];
}

export interface TowerFilter {
  /** An annunciator lamp pressed: only stops of that family. */
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

function emptyBays(): Record<Bay, TowerRun[]> {
  return Object.fromEntries(BAYS.map((bay) => [bay, []])) as unknown as Record<Bay, TowerRun[]>;
}

function zeroLamps(): Record<HaltCategory, number> {
  return Object.fromEntries(HALT_CATEGORIES.map((category) => [category, 0])) as Record<HaltCategory, number>;
}

/** The newest run of each slug — any other unfinished run of it has been overtaken. */
function newestBySlug(runs: readonly RunState[]): Map<string, RunState> {
  const out = new Map<string, RunState>();
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

/** Urgent first, then the oldest ask — the one you do not already know about. */
function needsYouOrder(a: TowerRun, b: TowerRun): number {
  const loud = (t: TowerRun) => (describeRun(t.run as never, t.ctx).attention === 'urgent' ? 0 : 1);
  return loud(a) - loud(b) || a.touched - b.touched;
}

function lampsOf(runs: readonly TowerRun[]): Record<HaltCategory, number> {
  const lamps = zeroLamps();
  for (const t of runs) if (t.category) lamps[t.category] += 1;
  return lamps;
}

function countsOf(bays: Record<Bay, TowerRun[]>, ready: readonly Departure[]): Record<Bay, number> {
  const counts = Object.fromEntries(BAYS.map((bay) => [bay, bays[bay].length])) as Record<Bay, number>;
  counts.ready = ready.length;
  return counts;
}

export function towerModel(input: TowerInput): TowerModel {
  const { runs, lanes, entries, inbox = [], departures = [], closedSlugs, now } = input;

  const byRun = new Map<string, NowLane[]>();
  for (const lane of lanes) {
    const list = byRun.get(lane.runId);
    if (list) list.push(lane);
    else byRun.set(lane.runId, [lane]);
  }

  const newest = newestBySlug(runs);
  const bays = emptyBays();
  const placed: TowerRun[] = [];

  for (const run of runs) {
    const mine = byRun.get(run.id) ?? [];
    const newer = newest.get(run.slug);
    const ctx: RunCtx = {
      planClosed: Boolean(closedSlugs?.has(run.slug)),
      newerRunId: newer && newer.id !== run.id ? newer.id : null,
      inbox,
      now,
    };
    const view = describeRun(run as Parameters<typeof describeRun>[0], ctx);
    const bay = bayOf(view);
    const queued = mine.find((lane) => lane.status === 'queued');
    const entry = queued ? queueEntryFor(entries, run.slug, queued.phase) : undefined;
    // A run summoned by a person's turn lights its oldest item's family when no
    // halt names one — the item IS why it waits (control-tower phases 42, 139).
    const step = bay === 'needs-you' ? runItems(inbox, run)[0] : undefined;
    const halted =
      bay !== 'settled' && run.halt
        ? (haltView(run as Parameters<typeof haltView>[0])?.category ?? null)
        : null;
    const category = halted ?? (step ? categoryOfItem(step) : null);
    const placedRun: TowerRun = {
      key: run.id,
      run,
      lanes: mine,
      checks: verifyingLanes(run),
      ...(entry ? { entry } : {}),
      ctx,
      bay,
      category,
      dormant: view.note?.kind === 'dormant',
      touched: stamp(run.updatedAt),
    };
    bays[bay].push(placedRun);
    placed.push(placedRun);
  }

  bays['needs-you'].sort(needsYouOrder);
  for (const bay of BAYS) if (bay !== 'needs-you') bays[bay].sort((a, b) => b.touched - a.touched);

  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const settledBay = bays.settled;

  return {
    runs: placed,
    bays,
    ready: [...departures],
    annunciator: lampsOf(placed),
    counts: countsOf(bays, departures),
    items: itemsNow(inbox),
    upcoming: itemRows(inbox.filter((row) => row.turn?.group === 'upcoming')),
    settled: {
      today: settledBay.filter((t) => !t.dormant && t.touched >= midnight).length,
      dormant: settledBay.filter((t) => t.dormant).length,
      since: midnight,
    },
    ciRefused: ciRefusalsOf(runs),
  };
}

/**
 * The Tower under a filter. The text narrows everything, the lamps included;
 * a pressed lamp narrows the bays to its family — and leaves the lamps alone,
 * because they are the panel you filter WITH, and a panel that went dark the
 * moment you pressed it could never be pressed again.
 */
export function filterTower(model: TowerModel, filter: TowerFilter): TowerModel {
  const query = filter.query?.trim().toLowerCase() ?? '';
  const category = filter.category ?? null;
  const keep = filter.keep ?? null;
  if (!query && !category && !keep) return model;

  const bySlug = (slug: string | undefined) => !query || (slug ?? '').toLowerCase().includes(query);
  const runs = model.runs.filter((t) => bySlug(t.run.slug));
  const annunciator = lampsOf(runs);

  const inFamily = (t: TowerRun) =>
    (!category || t.category === category) && (!keep || keep.runIds.has(t.run.id));
  const bays = emptyBays();
  for (const bay of BAYS) bays[bay] = model.bays[bay].filter((t) => bySlug(t.run.slug) && inFamily(t));
  // A plan's ready phase has stopped for nothing, so no family holds it.
  const ready = category || keep ? [] : model.ready.filter((d) => bySlug(d.slug));
  // A person's turn, due or coming up, narrows as its family's runs do.
  const itemShown = (item: InboxItem) =>
    bySlug(item.slug ?? item.title) &&
    (!category || categoryOfItem(item) === category) &&
    (!keep || keep.itemIds.has(item.id));

  return {
    runs: model.runs.filter((t) => bySlug(t.run.slug) && inFamily(t)),
    bays,
    ready,
    annunciator,
    counts: countsOf(bays, ready),
    items: model.items.filter(itemShown),
    upcoming: model.upcoming.filter(itemShown),
    settled: {
      today: bays.settled.filter((t) => !t.dormant && t.touched >= model.settled.since).length,
      dormant: bays.settled.filter((t) => t.dormant).length,
      since: model.settled.since,
    },
    // A repository's refusal is no halt family's, so only the text narrows it.
    ciRefused: model.ciRefused
      .map((item) => ({ ...item, phases: item.phases.filter((p) => bySlug(p.slug)) }))
      .filter((item) => item.phases.length > 0),
  };
}
