/**
 * What a freeze MEANS once the console that armed it is gone.
 *
 * A freeze is the one operator act the console renders as a durable promise:
 * the lane card reads "Left frozen past 18:11 it converts to a checkpoint".
 * Until this module existed that promise was kept by exactly one thing — an
 * `unref`ed `setTimeout` in the Runner — so closing the laptop, or the console
 * dying the way it died in the incident this plan closes, silently retracted
 * it. The persisted `escalateAt` was written to the state file and then read
 * only by the CLIENT, which drew the countdown; nothing on the server ever
 * came back to it.
 *
 * So the escalation is split in two, and this file is the half that does not
 * need a lane table:
 *
 *  - `freezeVerdict` — what a persisted freeze is owed right now. Three
 *    answers, and the middle one is the one a boot pass needs: `rearm` says
 *    "this promise still has time on it, set a clock for the remainder".
 *  - `escalatePersistedFreeze` — carry it out against the STATE alone: probe
 *    the child, wake-then-terminate it, and convert the phase into something
 *    Continue can resume.
 *  - `checkpointFrozenRecord` — the record mutation and its wording, shared
 *    with the Runner's live path so a freeze that escalated in a running
 *    console and one that escalated at boot leave byte-identical records. The
 *    note is what the operator reads to understand why a phase went back to
 *    `pending`; two spellings of it would be two bugs.
 *
 * The live path (`Runner.escalateFreeze`) keeps its own body because it has
 * lanes, mirrors, run status and an event stream to maintain. What it does NOT
 * keep is a second opinion about what the record should say.
 */

import type { FreezeRef, PhaseRecord, RunState } from './state.ts';
import { childrenOf, phaseRecord } from './state.ts';
import { processState, type ProcessState } from '../pid.ts';
import { killLadder, wake } from './signals.ts';

/**
 * How long a freeze is cheap. Past this the operator is assumed not to be
 * coming back, and holding a 200 MB child stopped forever is worse than
 * checkpointing it — which is exactly what the incident proved, at 3 h 25 m.
 *
 * It lives here rather than in `runner.ts` because both halves of the
 * escalation quote it: the live timer's delay, and the note both paths write.
 */
export const FREEZE_ESCALATE_MS = 15 * 60 * 1_000;

/** The run-level freeze slot, as `RunState` stores it. */
export type PersistedFreeze = NonNullable<RunState['freeze']>;

export type FreezeVerdict =
  /** Nothing is frozen, or the slot is unusable. */
  | { kind: 'none' }
  /** Still within its window — re-arm a clock for the remainder. */
  | { kind: 'rearm'; inMs: number; at: number }
  /** The window closed while nobody was watching. */
  | { kind: 'escalate' };

/**
 * What this freeze is owed at `nowMs`.
 *
 * An unparseable or missing `escalateAt` answers `none` rather than
 * `escalate`: a freeze whose deadline cannot be read is not evidence that the
 * deadline passed, and the failure that costs least is the one that leaves the
 * operator's freeze standing.
 */
export function freezeVerdict(
  freeze: { escalateAt?: string } | null | undefined, nowMs: number,
): FreezeVerdict {
  if (!freeze) return { kind: 'none' };
  const at = Date.parse(freeze.escalateAt ?? '');
  if (!Number.isFinite(at)) return { kind: 'none' };
  if (at <= nowMs) return { kind: 'escalate' };
  return { kind: 'rearm', inMs: at - nowMs, at };
}

/** One frozen session as the STATE records it — from either place it is written. */
export type FrozenEntry = { phase: number | null; pid: number | null; freeze: FreezeRef };

/**
 * Every frozen session this state knows about, not just the one the mirror names.
 *
 * `state.freeze` is a SINGLE SLOT holding the lowest frozen phase; the per-lane
 * truth lives on `children[phase].frozen` precisely because several lanes can be
 * frozen at once. Everything on the boot path read the slot alone, so freezing
 * two lanes and restarting the console escalated one and left the other
 * SIGSTOPped with nothing holding a promise about it — the very orphan the
 * escalation exists to prevent, produced by the escalation's own blind spot.
 *
 * De-duplicated by pid, because the mirror is a COPY of one of the children and
 * escalating it twice would signal one process twice.
 */
export function frozenEntries(state: RunState): FrozenEntry[] {
  const out: FrozenEntry[] = [];
  const seen = new Set<number>();
  for (const child of childrenOf(state)) {
    if (!child.frozen) continue;
    out.push({ phase: child.phase, pid: child.pid || null, freeze: child.frozen });
    if (child.pid) seen.add(child.pid);
  }
  const slot = state.freeze;
  if (slot && !(slot.pid && seen.has(slot.pid))) {
    out.push({ phase: slot.phase ?? null, pid: slot.pid || null, freeze: slot });
  }
  return out;
}

/**
 * What the RUN is owed — the earliest deadline among everything frozen under it.
 *
 * The boot pass arms one timer per run, so it must be the timer of whichever
 * freeze comes due first; arming for the mirror's deadline let a child frozen
 * earlier sit past its own. A pass that fires escalates everything due, so the
 * remaining ones simply re-arm on the next call.
 */
export function runFreezeVerdict(state: RunState, nowMs: number): FreezeVerdict {
  let best: FreezeVerdict = { kind: 'none' };
  for (const entry of frozenEntries(state)) {
    const verdict = freezeVerdict(entry.freeze, nowMs);
    if (verdict.kind === 'none') continue;
    if (verdict.kind === 'escalate') return verdict;
    if (best.kind !== 'rearm' || verdict.inMs < best.inMs) best = verdict;
  }
  return best;
}

/**
 * Send a frozen phase back to `pending` with its session id kept.
 *
 * `resumeSessionId` is the whole point: without it Continue re-runs the phase
 * from its boot prompt and every turn the frozen session had already spent is
 * paid again. With it the next attempt is a `--resume`.
 */
export function checkpointFrozenRecord(
  record: PhaseRecord | undefined, afterMs = FREEZE_ESCALATE_MS,
): void {
  if (!record) return;
  const sessionId = record.sessionId;
  record.status = 'pending';
  record.resumeSessionId = sessionId;
  record.note = sessionId
    ? `frozen for ${Math.round(afterMs / 60_000)} minutes, then checkpointed — `
      + `Continue resumes session ${sessionId}`
    : 'frozen too long and checkpointed, but the session reported no id to resume — '
      + 'Continue starts this phase again from its boot prompt';
}

export type PersistedEscalationDeps = {
  nowMs?: number;
  /** The process probe. Injected by tests; `processState` otherwise. */
  probe?: (pid: number) => ProcessState;
  /** Wake-then-terminate. Injected by tests; the real ladder otherwise. */
  kill?: (pid: number) => void;
  /**
   * WHICH freezes this call is ruling on. The two callers ask different
   * questions and must not be given one answer:
   *
   *  - `all` (the default) — the boot/timer clock, which owns every frozen
   *    session under the run. That is the D14 fix: the single slot named one,
   *    so a second frozen child escalated nowhere.
   *  - `slot` — `Runner.start()`, which rules on THE RUN'S freeze because
   *    starting it ends that freeze either way. A frozen CHILD is a different
   *    situation with a different owner: `adopt`/`orphanAdvice` parks the run
   *    and tells the operator how to continue it. Escalating those here would
   *    take that case away from the code that handles it properly — and, in a
   *    test whose fixture child is the test runner's own pid, signal the
   *    process doing the asking.
   */
  scope?: 'all' | 'slot';
};

export type PersistedEscalation = {
  escalated: boolean;
  phase: number | null;
  pid: number | null;
  sessionId: string | undefined;
  /** Whether a live child was actually signalled — the journal wants this. */
  signalled: boolean;
};

/**
 * Escalate a freeze held on a state with no lanes behind it — the boot pass,
 * and `Runner.start()` ruling on a freeze it inherited.
 *
 * The child, if it is still there, is woken before it is asked to stop. That
 * ordering is not a precaution here: a frozen child is BY DEFINITION stopped,
 * and a SIGTERM to a stopped process queues forever. Sending one without a
 * SIGCONT first is precisely the bug that orphaned the incident's session for
 * three and a half hours, and `signals.ts` is the only place allowed to make
 * that call.
 *
 * `gone` and `stopped` are both escalated. A `stopped` child is the live case
 * — the one the ladder exists for — and a `gone` one still leaves a phase
 * record claiming to be in flight, which is the fact Continue would trip over.
 *
 * Returns one entry PER frozen session, because a run can hold several. It
 * returned one — the mirror slot's — and the second frozen child of a restarted
 * console was left stopped forever with its phase record still claiming to be
 * running. An empty array means nothing was frozen.
 */
export function escalatePersistedFreeze(
  state: RunState, deps: PersistedEscalationDeps = {},
): PersistedEscalation[] {
  const slot = state.freeze;
  const entries = (deps.scope ?? 'all') === 'slot'
    ? (slot ? [{ phase: slot.phase ?? null, pid: slot.pid || null, freeze: slot }] : [])
    : frozenEntries(state);
  if (!entries.length) return [];

  const probe = deps.probe ?? ((p: number) => processState(p));
  const kill = deps.kill ?? ((p: number) => { void killLadder(p); });
  const out: PersistedEscalation[] = [];

  for (const { phase, pid } of entries) {
    const record = phase == null ? undefined : phaseRecord(state, phase);
    const sessionId = record?.sessionId;

    let signalled = false;
    if (pid && probe(pid) !== 'gone') {
      kill(pid);
      signalled = true;
    }

    checkpointFrozenRecord(record);

    // A child the freeze named is not running any more, so the mirror must not
    // go on advertising it. Other children are left alone — another lane may
    // still be in the map, and `survivingChildren` is the one thing allowed to
    // prune it wholesale.
    if (pid && state.child?.pid === pid) state.child = null;
    if (state.children) {
      for (const [key, child] of Object.entries(state.children)) {
        if (child?.pid === pid) delete state.children[key];
      }
    }

    out.push({ escalated: true, phase, pid, sessionId, signalled });
  }

  if (state.children && !Object.keys(state.children).length) delete state.children;
  // The freeze is over — it has been ruled on, which is the thing the
  // unconditional `state.freeze = null` in `start()` could never claim. Cleared
  // once, after the loop: the slot is a mirror of one of the entries above and
  // clearing it mid-iteration would hide the rest from `frozenEntries`.
  state.freeze = null;

  return out;
}

/** One woken session, as `thawPersistedFreeze` reports it. */
export type PersistedThaw = { phase: number | null; pid: number | null; woken: boolean };

/**
 * WAKE a freeze held on a state with no lanes behind it — the other half of
 * `escalatePersistedFreeze`, and the one a fleet thaw needs.
 *
 * Both halves exist for the same reason: a console restart leaves the freeze on
 * disk and the SIGSTOPped children under PPID 1, with no lane table pointing at
 * them. The escalation ends such a session; this one lets it carry on, which is
 * what a thaw means. Without it, `thawFleet` after a restart iterates a runner
 * pool that is empty, clears the marker, and the children stay stopped for ever
 * — the original incident, reached by the undo rather than by the do.
 *
 * A `gone` child is not an error: the record still has to be cleared, or the
 * run goes on calling itself frozen over nothing.
 *
 * Wakes first, THEN clears — the rule phase 15 wrote in blood: never release a
 * freeze record without waking what it names, because the record is the only
 * thing left pointing at the process.
 */
export function thawPersistedFreeze(
  state: RunState,
  deps: { probe?: (pid: number) => ProcessState; wake?: (pid: number) => void } = {},
): PersistedThaw[] {
  const entries = frozenEntries(state);
  if (!entries.length) return [];

  const probe = deps.probe ?? ((p: number) => processState(p));
  const cont = deps.wake ?? ((p: number) => { wake(p); });
  const out: PersistedThaw[] = [];

  for (const { phase, pid } of entries) {
    let woken = false;
    if (pid && probe(pid) === 'stopped') {
      try { cont(pid); woken = true; } catch { /* the record is cleared either way */ }
    }
    out.push({ phase, pid, woken });
  }

  for (const child of childrenOf(state)) delete child.frozen;
  state.freeze = null;
  return out;
}
