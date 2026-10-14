/**
 * Superseded runs (turn-by-turn phase 7, §Architecture 5.2): ONE predicate,
 * both editions — is this stopped run replaced by a later run of its plan?
 *
 * Seen on a hub: a run in a shared checkout was stopped "relaunch isolated"
 * and replaced by an isolated run of the same plan. A day later the machine
 * login changed identity, and the identity park raised a fresh question on the
 * DEAD run — overwriting the operator's stop — which then sat on Your turn
 * with nobody to answer it. The old run was over in every sense but the
 * record's.
 *
 * Run A is superseded by run B iff every clause holds:
 *   - B is another run of the same plan (`slug`), with a different id,
 *     created after A (`B.createdAt > A.createdAt`);
 *   - B is not abandoned — a person did not dismiss it (`resolved` by hand);
 *   - B covers what A still owes: B is unscoped (`onlyPhases` absent), or its
 *     `onlyPhases` holds every phase A has outstanding;
 *   - A is not live — no driver, no child process still holding work (the one
 *     process probe, `server/pid.ts`);
 *   - A is stopped: `halted`, `parked` or `interrupted`;
 *   - A's halt is neither `unlanded` (its work is not on the trunk — a merge
 *     errand is a person's) nor a stop about the plan (`isPlanHalt`: only the
 *     lint answers one, control-tower phase 81);
 *   - and no person put A back (`reopenedAt`) or dismissed it themselves.
 * Every refusal is named (`SUPERSEDE_REFUSALS`), so a test — and a reader of
 * the journal — can say exactly why a run was NOT closed.
 *
 * Applied in three places: the identity park skips a superseded run
 * (`service-runs.ts` `parkStoredOnIdentity`), the read-path resolver annotates
 * it "superseded by run <id>" (`autoResolveSuperseded`, reversible with
 * `unresolve`, which sets `reopenedAt`), and the round's stale pass closes its
 * run-specific items and moves its world acts to B's lane (`turn/stale.ts`).
 */

import { isPlanHalt } from '../../shared/recovery-model.js';
import { pidHoldsWork } from '../pid.ts';
import { isLive, RESOLVABLE, type LiveRuns, type RunState } from './state.ts';

/** Why a run is NOT superseded — the predicate's every refusal, by name. */
export const SUPERSEDE_REFUSALS = Object.freeze([
  'live', 'not-stopped', 'unlanded', 'plan-halt', 'reopened', 'dismissed', 'no-successor',
] as const);
export type SupersedeRefusal = (typeof SUPERSEDE_REFUSALS)[number];

export type SupersedeFacts = {
  /** The runs something is driving now — the service's `liveRunIds()`. */
  live?: LiveRuns;
  /** A test's process probe; the console's is `pidHoldsWork`. */
  holdsWork?: (pid: number) => boolean;
  /** The plan's phases, when known — what an unscoped run still owes is every one the board does not read done. */
  planPhases?: readonly number[];
  /** The board's word per phase, when read. */
  board?: Readonly<Record<number, string>>;
};

export type SupersedeReading =
  | { superseded: true; by: RunState }
  | { superseded: false; refused: SupersedeRefusal; detail?: string };

const SETTLED_RECORD = new Set(['done', 'skipped']);

/** Is something still driving this run, or a session of it still holding work? */
export function runStillLive(run: RunState, facts: SupersedeFacts = {}): boolean {
  if (isLive(run.id, facts.live)) return true;
  const holds = facts.holdsWork ?? ((pid: number) => pidHoldsWork(pid));
  return Object.values(run.children ?? {}).some((child) => Number.isInteger(child?.pid) && holds(child.pid));
}

/**
 * The phases a run still owes, or null for "the rest of the plan" — an
 * unscoped run whose plan's phases this reader was not told.
 */
export function outstandingPhases(run: RunState, facts: SupersedeFacts = {}): number[] | null {
  const doneHere = (phase: number) => facts.board?.[phase] === 'done'
    || SETTLED_RECORD.has(run.phases[String(phase)]?.status ?? '');
  const scope = run.onlyPhases?.length ? run.onlyPhases : facts.planPhases ?? null;
  if (!scope) return null;
  return [...new Set(scope)].filter((phase) => !doneHere(phase)).sort((a, b) => a - b);
}

/** Does `b` cover what `a` still owes? An unscoped successor covers anything. */
function covers(b: RunState, owed: number[] | null): boolean {
  if (!b.onlyPhases?.length) return true;
  if (owed === null) return false;
  const scope = new Set(b.onlyPhases);
  return owed.every((phase) => scope.has(phase));
}

/** A run a person dismissed by hand — abandoned, never anybody's successor. */
const abandoned = (run: RunState) => Boolean(run.resolved && !run.resolved.auto);

/**
 * The predicate, with its reason: is `a` superseded, and by which run? The
 * successor named is the NEWEST run that qualifies — the one still standing,
 * whose lane a world act moves to.
 */
export function supersedeReading(a: RunState, runs: readonly RunState[], facts: SupersedeFacts = {}): SupersedeReading {
  if (a.reopenedAt) return { superseded: false, refused: 'reopened' };
  if (a.resolved && !a.resolved.auto) return { superseded: false, refused: 'dismissed' };
  if (a.status !== 'parked' && !RESOLVABLE.includes(a.status)) return { superseded: false, refused: 'not-stopped', detail: a.status };
  if (a.halt?.kind === 'unlanded') return { superseded: false, refused: 'unlanded' };
  if (isPlanHalt(a.halt?.kind)) return { superseded: false, refused: 'plan-halt', detail: a.halt?.kind ?? undefined };
  if (runStillLive(a, facts)) return { superseded: false, refused: 'live' };
  const owed = outstandingPhases(a, facts);
  const created = Date.parse(a.createdAt);
  const successor = runs
    .filter((b) => b.slug === a.slug && b.id !== a.id && Date.parse(b.createdAt) > created && !abandoned(b) && covers(b, owed))
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))[0];
  if (!successor) return { superseded: false, refused: 'no-successor' };
  return { superseded: true, by: successor };
}

/** The predicate alone: the run that supersedes `a`, or null. */
export function supersededBy(a: RunState, runs: readonly RunState[], facts: SupersedeFacts = {}): RunState | null {
  const reading = supersedeReading(a, runs, facts);
  return reading.superseded ? reading.by : null;
}

/** The words a superseded run's resolution says — the reason the run and its items carry. */
export function supersededReason(by: Pick<RunState, 'id'>): string {
  return `superseded by run ${by.id}`;
}

/**
 * Annotate a superseded run as resolved — automatically, reversibly: the
 * reason names its successor, `auto: true`, and `unresolve` (which sets
 * `reopenedAt`) puts it back for good. Answers the successor when it wrote,
 * null when the run is not superseded or already resolved.
 */
export function autoResolveSuperseded(a: RunState, runs: readonly RunState[], facts: SupersedeFacts = {}, at = new Date()): RunState | null {
  if (a.resolved) return null;
  const by = supersededBy(a, runs, facts);
  if (!by) return null;
  a.resolved = { at: at.toISOString(), auto: true, reason: supersededReason(by), supersededBy: by.id };
  return by;
}
