/**
 * The console's panic button, on disk.
 *
 * One marker file — `INSTANCE_STATE_DIR/freeze.json`, `{at, by}` — behind one
 * predicate, consulted by every mechanism that could start or resume work. The
 * operator presses Freeze all and the whole fleet holds where it stands; they
 * press Thaw all and it carries on from exactly there.
 *
 * Three decisions are worth stating, because each is the opposite of the
 * obvious one:
 *
 * **1. Instance state, not a preference.** A freeze is an ACT with a moment and
 * an author, not a policy the operator configures — the same distinction that
 * makes `hold`/`release` verbs rather than settings fields. It lives beside
 * `webhooks.json` and the notification inbox, per instance, because two
 * consoles pointed at two source trees are two fleets and freezing one must not
 * stop the other.
 *
 * **2. It is read at FIRE time, never used to move a clock.** Nothing here
 * cancels a timer, shortens a wait or rewinds a deadline. Every auto-start
 * mechanism keeps its own clock exactly as it was and asks this predicate at
 * the instant it would act. That is what makes thaw *exact*: a wait whose
 * moment passed during the freeze fires on the next poll after the thaw, and a
 * session that was mid-token thaws mid-token (phase 15 made that true). A
 * design that paused clocks would have to know how to resume each of them, and
 * would get one of the eighteen wrong.
 *
 * **3. An unreadable marker is NOT a freeze.** A corrupt or half-written file
 * answers `null`, the same way `freezeVerdict` reads an unparseable
 * `escalateAt` as "leave the operator's freeze standing". The two failures are
 * not symmetric: a console that wrongly believes itself frozen stops the whole
 * fleet silently and looks exactly like a console with nothing to do, which is
 * the single hardest failure to diagnose from the outside. A console that
 * wrongly believes itself thawed starts work the operator can see and stop.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { INSTANCE_STATE_DIR } from './config.ts';
import { log } from './log.ts';

/** Where the marker lives. Per instance, beside every other instance fact. */
export const FLEET_FREEZE_FILE = join(INSTANCE_STATE_DIR, 'freeze.json');

/** The whole record: when it was frozen, and by whom. */
export type FleetHold = {
  /** ISO8601. What the banner counts from. */
  at: string;
  /** Who pressed it — an operator name, `console`, or an API caller's `by`. */
  by: string;
};

/**
 * Read the marker, or `null`.
 *
 * Deliberately tolerant in one direction only (see the header note 3): every
 * failure — missing file, unreadable file, bad JSON, a record with no usable
 * `at` — answers "not frozen".
 */
export function readFleetHold(): FleetHold | null {
  let raw: string;
  try {
    raw = readFileSync(FLEET_FREEZE_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FleetHold> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const at = typeof parsed.at === 'string' ? parsed.at : '';
    if (!Number.isFinite(Date.parse(at))) return null;
    const by = typeof parsed.by === 'string' && parsed.by ? parsed.by : 'console';
    return { at, by };
  } catch {
    log.warn('fleet.freeze-unreadable', { file: FLEET_FREEZE_FILE });
    return null;
  }
}

/**
 * Write the marker. Returns what was written, so the caller announces the same
 * record the next reader will see rather than one it composed in parallel.
 */
export function writeFleetHold(by: string, at = new Date().toISOString()): FleetHold {
  const hold: FleetHold = { at, by: by || 'console' };
  mkdirSync(INSTANCE_STATE_DIR, { recursive: true });
  writeFileSync(FLEET_FREEZE_FILE, `${JSON.stringify(hold, null, 2)}\n`, 'utf8');
  return hold;
}

/**
 * Remove the marker. Idempotent — thawing a fleet nobody froze is not an error.
 *
 * Throws if the file is still there afterwards, and that is the point: the
 * caller nulls its cache on the strength of this call, so a swallowed failure
 * would leave the process believing it had thawed while the marker survived —
 * and the NEXT boot would re-freeze the whole fleet from a file nobody meant to
 * leave. A thaw that could not happen must say so loudly enough to be refused.
 */
export function clearFleetHold(): void {
  try {
    rmSync(FLEET_FREEZE_FILE, { force: true });
  } catch (error) {
    log.warn('fleet.thaw-failed', { file: FLEET_FREEZE_FILE, error });
  }
  if (readFleetHold()) {
    throw new Error(`the freeze marker could not be removed (${FLEET_FREEZE_FILE}) — the console is still frozen`);
  }
}
