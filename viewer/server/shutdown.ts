/**
 * What the off switch turns off, and whether a press may go through — pure.
 *
 * Zero-touch phase 16 (SHD-1, SHD-2). `shutdownReadiness()` used to answer with
 * two numbers that did not measure the work: `sessions` counted pty terminals
 * and `busy` was "is a drain handler registered", true only while a drive loop
 * sat between its `onShutdown` and its `.finally`. So at 17:49 on 09-12 the
 * dialog said *"Nothing is running — no session, no run"* over a
 * `waiting-external` lane armed to resume in 36.8 minutes, the press went
 * through, and the lane resumed 581 minutes late. And the endpoint never
 * refused anything, by design.
 *
 * The inventory below is computed from WORK instead: the lanes a runner holds
 * (with pids), every in-process clock the exit discards (with its moment and
 * its source), the runs on disk the next boot would pick back up, the sessions
 * the presence registry shows live, the approval cards still pending, and the
 * two inboxes' unread depth. The verdict keeps the off switch ungated — a
 * read-only console must still be able to stop — and makes it deliberate
 * instead: a bare `{confirm: true}` over a non-empty inventory is refused with
 * the inventory named, and `mode: 'unload'` (stay off) always needs an explicit
 * `acknowledge: true`, because it is the one strength a login does not undo.
 *
 * Kept free of the Service so the rules can be asserted with plain objects.
 */

import { SHUTDOWN_MODES, type ShutdownClockSource, type ShutdownMode } from '../shared/ops-vocab.js';
import type { UnloadPlan } from './lifecycle.ts';

/** A lane a live runner holds right now. */
export type InventoryLane = {
  slug: string;
  runId: string;
  phase: number;
  pid: number | null;
  sessionId: string | null;
};

/** One in-process clock the exit discards, and when it would have fired. */
export type InventoryClock = {
  /** ISO. */
  at: string;
  source: ShutdownClockSource;
  slug?: string;
  runId?: string;
  phase?: number;
};

/** A run the shutdown leaves behind — live, or on disk with something still owed. */
export type InventoryRun = {
  slug: string;
  id: string;
  status: string;
  /** The run's wait clock (`waitClockOf`), when it has one. */
  waitUntil: string | null;
  /** A runner of this console is driving it right now. */
  live: boolean;
  /** The soonest in-process clock armed for it, when one is. */
  clock: InventoryClock | null;
};

/** A session the presence registry shows live — somebody's work the exit stops watching. */
export type InventorySession = {
  sessionId: string;
  kind: string;
  pid: number | null;
  cwd: string;
  plan: { slug: string; phase: number } | null;
};

export type InventoryApproval = {
  id: string;
  slug: string;
  phase: number | null;
  kind: string;
  expiresAt: string;
};

export type ShutdownInventory = {
  lanes: InventoryLane[];
  clocks: InventoryClock[];
  runs: InventoryRun[];
  liveSessions: InventorySession[];
  pendingApprovals: InventoryApproval[];
  /**
   * What is written and not yet read: presence drops in the session inbox, and
   * unsupervised declarations in the outcome inboxes (`outcomes/*.json` — the
   * `ignored/` history is not depth). Stopping the console stops the reading.
   */
  inboxDepth: { sessions: number; outcomes: number };
};

export function emptyInventory(): ShutdownInventory {
  return {
    lanes: [], clocks: [], runs: [], liveSessions: [], pendingApprovals: [],
    inboxDepth: { sessions: 0, outcomes: 0 },
  };
}

/** Nothing at all in flight, armed, owed, live, pending or unread. */
export function inventoryEmpty(inventory: ShutdownInventory): boolean {
  return !inventory.lanes.length
    && !inventory.clocks.length
    && !inventory.runs.length
    && !inventory.liveSessions.length
    && !inventory.pendingApprovals.length
    && !inventory.inboxDepth.sessions
    && !inventory.inboxDepth.outcomes;
}

/**
 * The two inbox debounces: a read of a file already written, a few hundred
 * milliseconds out. Listed — the exit does discard them — but never the clock a
 * person is told about first, which would otherwise be a 100 ms debounce on
 * every console with a watcher, standing in front of the resume due in an hour.
 */
const DEBOUNCE_SOURCES: ReadonlySet<ShutdownClockSource> = new Set<ShutdownClockSource>(['outcome-inbox', 'session-inbox']);

/**
 * The clock the exit would break that matters first: the soonest WORK clock (a
 * resume, an escalation, a `require` clock, a booked convergence pass), else the
 * soonest inbox debounce when that is all there is.
 */
export function soonestClock(inventory: ShutdownInventory): InventoryClock | null {
  let work: InventoryClock | null = null;
  let debounce: InventoryClock | null = null;
  for (const clock of inventory.clocks) {
    if (DEBOUNCE_SOURCES.has(clock.source)) {
      if (!debounce || Date.parse(clock.at) < Date.parse(debounce.at)) debounce = clock;
    } else if (!work || Date.parse(clock.at) < Date.parse(work.at)) {
      work = clock;
    }
  }
  return work ?? debounce;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Who a clock belongs to, in the fewest words. */
function clockOwner(clock: InventoryClock): string {
  if (!clock.slug) return '';
  return ` for ${clock.slug}${clock.phase != null ? ` phase ${clock.phase}` : ''}`;
}

/**
 * The inventory as one sentence a person can check against what they believe
 * is running — the refusal's reason and the log line's summary.
 */
export function inventorySentence(inventory: ShutdownInventory): string {
  const parts: string[] = [];
  if (inventory.lanes.length) {
    const named = inventory.lanes.slice(0, 3)
      .map((lane) => `${lane.slug} phase ${lane.phase}${lane.pid ? ` (pid ${lane.pid})` : ''}`)
      .join(', ');
    parts.push(`${plural(inventory.lanes.length, 'live lane')}: ${named}${inventory.lanes.length > 3 ? ', …' : ''}`);
  }
  const soonest = soonestClock(inventory);
  if (soonest) {
    const more = inventory.clocks.length - 1;
    parts.push(`an armed ${soonest.source} clock${clockOwner(soonest)} due ${soonest.at}`
      + (more > 0 ? ` and ${plural(more, 'more clock')}` : ''));
  }
  const parked = inventory.runs.filter((run) => !run.live);
  if (parked.length) {
    const named = parked.slice(0, 3)
      .map((run) => `${run.slug} ${run.status}${run.waitUntil ? ` until ${run.waitUntil}` : ''}`)
      .join(', ');
    parts.push(`${plural(parked.length, 'run')} on disk the next boot picks up: ${named}${parked.length > 3 ? ', …' : ''}`);
  }
  if (inventory.liveSessions.length) {
    const named = inventory.liveSessions.slice(0, 3)
      .map((session) => `${session.sessionId.slice(0, 8)}${session.pid ? ` (pid ${session.pid})` : ''}`)
      .join(', ');
    parts.push(`${plural(inventory.liveSessions.length, 'live Claude session')}: ${named}${inventory.liveSessions.length > 3 ? ', …' : ''}`);
  }
  if (inventory.pendingApprovals.length) parts.push(plural(inventory.pendingApprovals.length, 'pending approval'));
  const { sessions, outcomes } = inventory.inboxDepth;
  if (sessions || outcomes) {
    parts.push([
      sessions ? plural(sessions, 'presence event') : '',
      outcomes ? plural(outcomes, 'declaration') : '',
    ].filter(Boolean).join(' and ') + ' not yet read');
  }
  return parts.join('; ');
}

/** A Shut down press, as the route hands it over. */
export type ShutdownAsk = { mode: unknown; acknowledge: boolean };

export type ShutdownVerdict =
  | { ok: true; mode: ShutdownMode }
  | { ok: false; status: 400 | 409; reason: string; needs: 'mode' | 'unload' | 'acknowledge' };

export function isShutdownMode(value: unknown): value is ShutdownMode {
  return typeof value === 'string' && (SHUTDOWN_MODES as readonly string[]).includes(value);
}

/**
 * May this press go through? Refusals, in the order a person needs them:
 *
 *  1. a mode that is not one of the two strengths (400);
 *  2. `unload` where there is no unit to unload — `exit` already stops it, and
 *     nothing brings it back (409);
 *  3. `unload` without `acknowledge` — always, inventory or not: it is the one
 *     strength a login does not undo, and the refusal names the command that
 *     does (409);
 *  4. anything over a non-empty inventory without `acknowledge` — the reason is
 *     the inventory itself, soonest clock first (409).
 */
export function shutdownVerdict(
  ask: ShutdownAsk,
  unload: UnloadPlan | null,
  inventory: ShutdownInventory,
): ShutdownVerdict {
  if (!isShutdownMode(ask.mode)) {
    return { ok: false, status: 400, needs: 'mode', reason: `mode must be one of ${SHUTDOWN_MODES.join(', ')}` };
  }
  if (ask.mode === 'unload') {
    if (!unload) {
      return {
        ok: false, status: 409, needs: 'unload',
        reason: 'nothing supervises this console that it could unload — `exit` already stops it, and nothing brings it back',
      };
    }
    if (!ask.acknowledge) {
      return {
        ok: false, status: 409, needs: 'acknowledge',
        reason: `stay off unloads and disables ${unload.label} and writes a stop marker, so not even a login brings its work back — `
          + `pass "acknowledge": true to mean it. To start it again: ${unload.resurrect}`,
      };
    }
  }
  if (!ask.acknowledge && !inventoryEmpty(inventory)) {
    return {
      ok: false, status: 409, needs: 'acknowledge',
      reason: `this console is holding work — ${inventorySentence(inventory)}. `
        + 'Shutting it down stops all of it until the console boots again; pass "acknowledge": true to shut it down anyway',
    };
  }
  return { ok: true, mode: ask.mode };
}

/** The inventory in the size a log line can carry: counts, the soonest clock, and the lanes. */
export function inventoryDigest(inventory: ShutdownInventory): Record<string, unknown> {
  return {
    lanes: inventory.lanes.map((lane) => ({ slug: lane.slug, phase: lane.phase, pid: lane.pid })),
    clocks: inventory.clocks.length,
    soonestClock: soonestClock(inventory),
    runs: inventory.runs.map((run) => ({ slug: run.slug, id: run.id, status: run.status, live: run.live })),
    liveSessions: inventory.liveSessions.length,
    pendingApprovals: inventory.pendingApprovals.length,
    inboxDepth: inventory.inboxDepth,
  };
}
