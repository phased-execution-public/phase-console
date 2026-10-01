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
 * Its INBOX is the Needs-you bay's loose rows — every item that wants a person
 * and that no strip in the bay already draws (the approval queue keeps its own
 * cards); its LANES ride on the Live bay's strips; its NEXT UP is the Ready bay
 * — `toDepartures`, the same set, handed in.
 *
 * ## The annunciator
 *
 * One lamp per halt family (`HALT_CATEGORIES`): each unsettled halted run
 * counts under `haltView(run).category` (phase 17), each loose inbox row under
 * the family the server already put on it (`item.category`, the same table).
 * A settled run's old halt lights nothing — settled things go quiet.
 */

import { BAYS, bayOf, describeRun, type RunCtx } from '@shared/status-model.js';
import { HALT_CATEGORIES, isHaltCategory, type HaltCategory } from '@shared/halt-categories.js';
import { haltView } from '@shared/halt-view.js';
import { countsTowardAttention } from '@shared/attention-model.js';
import type { InboxItem, QueueEntry, RunState, VerifyingLane } from '@/lib/api';
import type { Departure, NowLane } from '@/features/runs/lanes-model';
import { queueEntryFor } from '../queue-words';
import { verifyingLanes } from '../verifying-lane';

export type Bay = (typeof BAYS)[number];

/** Inbox kinds the approval queue draws as cards of its own — never a loose row as well. */
const CARDED: ReadonlySet<string> = new Set(['approval', 'question']);

/**
 * Inbox kinds that stand in Needs you as rows of their own even when their
 * run's strip is there: a supervisor's card (control-tower phase 102) is a
 * second ask about the run — its evidence and its ONE action — not the stop
 * the strip already draws.
 */
const OWN_ROW: ReadonlySet<string> = new Set(['supervisor']);

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
  /** Inbox rows in Needs you that no strip draws. */
  loose: InboxItem[];
  annunciator: Record<HaltCategory, number>;
  /** How many things each bay holds — Needs you counts its loose rows, Ready its departures. */
  counts: Record<Bay, number>;
  /** The open human steps — a person's turn each (control-tower phase 42): *Your turn (n)*. */
  steps: InboxItem[];
  /** The Settled bay's two numbers, and the local midnight "today" starts at. */
  settled: { today: number; dormant: number; since: number };
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
 * Is this inbox row a person's turn on a ledger step — the summons a step
 * puts on its run (control-tower phase 42)? A folded card (a gate, a
 * question) is drawn by the same card but summons through its own kind.
 */
export function isStepItem(item: Pick<InboxItem, 'kind' | 'humanStep' | 'ack'>): boolean {
  return item.kind === 'human-step' && Boolean(item.humanStep?.stepId) && !item.ack;
}

/**
 * The family a row lights — the server's word, which it puts on a person's
 * turn too (its kind's family, `HUMAN_STEP_CATEGORY`, control-tower phase 42).
 */
export function categoryOfItem(item: Pick<InboxItem, 'category'>): HaltCategory | null {
  const word = item.category?.word;
  return isHaltCategory(word) ? word : null;
}

/** This run's open step rows, oldest first — the first is the strip's ONE action. */
export function stepItemsOf(
  inbox: readonly InboxItem[] | undefined,
  run: Pick<RunState, 'id' | 'slug'>,
): InboxItem[] {
  return (inbox ?? [])
    .filter((item) => isStepItem(item) && itemOfRun(item, run))
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
}

/** Does this inbox item belong to this run? `describeRun`'s own matching rule. */
export function itemOfRun(
  item: Pick<InboxItem, 'runId' | 'slug'>,
  run: Pick<RunState, 'id' | 'slug'>,
): boolean {
  return item.runId ? item.runId === run.id : Boolean(run.slug) && item.slug === run.slug;
}

/** Urgent first, then the oldest ask — the one you do not already know about. */
function needsYouOrder(a: TowerRun, b: TowerRun): number {
  const loud = (t: TowerRun) => (describeRun(t.run as never, t.ctx).attention === 'urgent' ? 0 : 1);
  return loud(a) - loud(b) || a.touched - b.touched;
}

function lampsOf(runs: readonly TowerRun[], loose: readonly InboxItem[]): Record<HaltCategory, number> {
  const lamps = zeroLamps();
  for (const t of runs) if (t.category) lamps[t.category] += 1;
  for (const item of loose) {
    const word = categoryOfItem(item);
    if (word) lamps[word] += 1;
  }
  return lamps;
}

function countsOf(
  bays: Record<Bay, TowerRun[]>,
  loose: readonly InboxItem[],
  ready: readonly Departure[],
): Record<Bay, number> {
  const counts = Object.fromEntries(BAYS.map((bay) => [bay, bays[bay].length])) as Record<Bay, number>;
  counts['needs-you'] += loose.length;
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
    // A run summoned by a person's turn lights the step's family when no halt
    // names one — the step IS why it waits (control-tower phase 42).
    const step = bay === 'needs-you' ? stepItemsOf(inbox, run)[0] : undefined;
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

  const summoned = bays['needs-you'].map((t) => t.run);
  const loose = inbox.filter(
    (item) =>
      countsTowardAttention(item.severity) &&
      !CARDED.has(item.kind) &&
      (OWN_ROW.has(item.kind) || !summoned.some((run) => itemOfRun(item, run))),
  );

  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const settledBay = bays.settled;

  return {
    runs: placed,
    bays,
    ready: [...departures],
    loose,
    annunciator: lampsOf(placed, loose),
    counts: countsOf(bays, loose, departures),
    steps: inbox.filter(isStepItem),
    settled: {
      today: settledBay.filter((t) => !t.dormant && t.touched >= midnight).length,
      dormant: settledBay.filter((t) => t.dormant).length,
      since: midnight,
    },
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
  const loose = model.loose.filter((item) => bySlug(item.slug ?? item.title));
  const annunciator = lampsOf(runs, loose);

  const inFamily = (t: TowerRun) =>
    (!category || t.category === category) && (!keep || keep.runIds.has(t.run.id));
  const bays = emptyBays();
  for (const bay of BAYS) bays[bay] = model.bays[bay].filter((t) => bySlug(t.run.slug) && inFamily(t));
  const looseShown = loose.filter(
    (item) => (!category || categoryOfItem(item) === category) && (!keep || keep.itemIds.has(item.id)),
  );
  // A plan's ready phase has stopped for nothing, so no family holds it.
  const ready = category || keep ? [] : model.ready.filter((d) => bySlug(d.slug));

  return {
    runs: model.runs.filter((t) => bySlug(t.run.slug) && inFamily(t)),
    bays,
    ready,
    loose: looseShown,
    annunciator,
    counts: countsOf(bays, looseShown, ready),
    steps: model.steps.filter(
      (item) =>
        bySlug(item.slug ?? item.title) &&
        (!category || categoryOfItem(item) === category) &&
        (!keep || keep.itemIds.has(item.id)),
    ),
    settled: {
      today: bays.settled.filter((t) => !t.dormant && t.touched >= model.settled.since).length,
      dormant: bays.settled.filter((t) => t.dormant).length,
      since: model.settled.since,
    },
  };
}
