/**
 * The watch scheduler — the clock the console owns for evidence it did not
 * produce.
 *
 * ## Why this is not the convergence loop
 *
 * Before this file, a declared ref was polled inside `convergePlan`: the
 * healer read a parked phase, probed its `gh:` refs, and resumed the session
 * if one had landed. That coupled two clocks with nothing in common. The
 * convergence sweep is five minutes wide and answers "has the *situation*
 * changed?" — a question whose evidence is the board, the locks, the gate
 * stamp. A watch ref answers "has the *world* changed?", it changes on a clock
 * nobody here controls, and — measured on `aug-create-order-filters-remediation`
 * p12 — a workflow run that finished at 02:14 was not looked at until the sweep
 * that happened to follow it, behind a `noops` latch that had every right to
 * say nothing had changed, because from the console's point of view nothing
 * had. The phase sat two days on a `gh run rerun`.
 *
 * So the poll gets its own timer, sized to what it is watching (a `gh` run is
 * worth asking about every two minutes, a PR every five, a lock every minute,
 * a deadline exactly once) with a floor of one wake a minute however near
 * something is due. Convergence keeps the situation; this keeps the world.
 *
 * ## What it watches
 *
 * Every phase of every non-finished run that carries refs — `declared.watch`
 * first (the session's own testimony), else `record.watch`. A `lock:` ref is
 * added for a phase parked behind another claim even when the session declared
 * none, because that is the one wait the console can answer entirely from its
 * own state.
 *
 * ## What it writes
 *
 * `record.watchState` — one row per ref, ADDITIVELY: a ref not probed on this
 * pass keeps the row it had, so a rotation that skips a ref because its probe
 * is still in flight never erases what was known about it. `watchChecked` is
 * still written for readers older than `watchState`. `phase.watch-checked` is
 * journalled on TRANSITION only; a pending ref that is still pending is the
 * overwhelmingly common answer and must cost nothing.
 *
 * A landing is handed to `onLanded` and nothing else: whether that resumes a
 * session, and how often it may, is the healer's judgement and lives with the
 * rest of the ladder's accounting.
 */

import { log } from './log.ts';
import { holdBinds } from './fleet-hold.ts';
import { type ConvergeClock, REAL_CLOCK } from './converge.ts';
import type { RunState, PhaseRecord } from './runner/state.ts';
import {
  pollableRefs, probeWatchRef, nextDueFor, declaredWindowOf, WATCH_FLOOR_MS, WATCH_CMD_TIMEOUT_MS,
  MAX_CMD_RUNS_PER_PHASE, MAX_WATCH_REFS, watchEligible, cmdRefProblem,
  type WatchProbeDeps, type WatchRefTarget, type WatchState,
} from './watch-refs.ts';
import { isOwnLockRef, waitBudgetEndOf } from './runner/wait-budget.ts';
import { stepProofOf, stepWindowEndOf } from './human-steps.ts';
import { OWN_LOCK_WATCH_REFUSAL } from '../shared/run-lifecycle.js';

/** The same bound `phase-outcome.sh` puts on `--watch` — owned by `watch-refs.ts`, re-exported for its readers. */
export { MAX_WATCH_REFS };

/**
 * How many times one landing may be handed to the healer.
 *
 * Deliberately `MAX_BOOT_RESUMES`' number and deliberately counted on
 * `record.watchResumes`, which is where the healer already bounds itself: the
 * scheduler stops offering exactly when the healer stops acting, so the errand
 * it writes on the last one is the final word rather than a line rewritten
 * every minute.
 */
export const MAX_LANDING_DELIVERIES = 3;

export type WatchSchedulerDeps = {
  /** The runs worth scanning: live or parked, never finished. */
  runs: () => { slug: string; state: RunState }[];
  /** One ref's verdict. Overridable so tests never shell `gh` or run a command. */
  probe?: (target: WatchRefTarget) => Promise<WatchState>;
  /** Append one line to a run's journal. */
  journal?: (slug: string, state: RunState, kind: string, data: Record<string, unknown>, phase: number) => void;
  /** Persist a run whose `watchState` changed. Best-effort by contract. */
  save?: (slug: string, state: RunState) => void;
  /** A ref landed. The healer decides what that means; this file does not. */
  onLanded?: (slug: string, state: RunState, phase: number, landed: WatchState)
  => WatchLandingOutcome | Promise<WatchLandingOutcome>;
  clock?: ConvergeClock;
  /**
   * The panic button, asked at FIRE time exactly as the convergence loop asks
   * it: a frozen console keeps its schedule and simply does nothing when each
   * moment comes, so a thaw needs no reconstruction.
   */
  fleetHold?: () => { at: string; by?: string; plans?: readonly string[] } | null | undefined;
  /**
   * Is `cmd:` execution switched on? Absent or false means a `cmd:` ref is
   * `unknown` — the console has not judged the command, it simply did not ask.
   */
  cmdRefsEnabled?: () => boolean;
  /** Run one command under `verify.ts`'s read-only policy. */
  runCommand?: (command: string, timeoutMs: number) => Promise<{ refused?: string; ok: boolean; detail?: string }>;
  /** Is nothing holding `slug`'s phase any more? `null` = no answer. */
  lockFree?: (slug: string, phase: number) => Promise<boolean | null> | boolean | null;
  /**
   * Is a delivery of this phase's landing still being driven — a resume or
   * retry whose promise has not settled, a runner driving the plan, an agent
   * recovery on the phase? Answered by the service that STARTED the drive,
   * because the promise it holds is the one thing that settles exactly when
   * the drive does. This — not a stamp signed before the work happened — is
   * what holds a landed offer back (QA round 3, H1). Absent means "no answer",
   * and nothing is held.
   */
  resumeInFlight?: (slug: string, phase: number) => boolean;
  /**
   * May a `cmd:` ref the CONSOLE minted run at all (SLF-8)? The watchdog's park
   * lifts a command out of a Bash tool summary and files it as a watch ref of
   * its own (`declared.minted`); absent or false, such a ref is written once
   * as `unknown` and never run — the console's own inference must not execute
   * a writing command against a repository nobody is watching.
   */
  mintedCmdRefsEnabled?: () => boolean;
  /**
   * `phase:<slug>/<N>` for a plan this pass did not load, or a phase its run
   * has no record of (control-tower phase 88, #129) — the service's own read
   * of that plan's latest run, then its board. A sibling in a run this pass
   * DID load is answered from that record directly.
   */
  phaseDone?: WatchProbeDeps['phaseDone'];
  /** `verify:<slug>/<N>` — the declaring phase's red lines on a new head (`verify-watch.ts`). */
  verifyProbe?: WatchProbeDeps['verifyProbe'];
  /**
   * The run policy's verdict on a command WITHOUT running it — `verify.ts`
   * `judgeCommand` — asked by the ingest probe, so a `cmd:` ref the console
   * would never run is refused at declaration however `watchCmdRefs` is set.
   */
  judgeCommand?: (command: string) => string | null;
};

/** A phase record's answer to `phase:<slug>/<N>` — `done` is the console's final word (#129). */
export function phaseDoneOf(record: Pick<PhaseRecord, 'status' | 'phase' | 'reopened'> | null | undefined): { state: 'landed' | 'pending'; detail: string } | null {
  if (!record) return null;
  if (record.status === 'done') return { state: 'landed', detail: `phase ${record.phase} is done` };
  const reopened = record.reopened ? ' — re-opened by its §Verification' : '';
  return { state: 'pending', detail: `phase ${record.phase} reads ${record.status}${reopened}` };
}

/** Does this ref name `<slug>`'s phase N — a `phase:` ref on it, or a `cmd:` over its handoff? */
function namesPhase(target: WatchRefTarget, slug: string, phase: number): boolean {
  if (target.kind === 'phase') return target.slug === slug && target.phase === phase;
  if (target.kind !== 'cmd') return false;
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`docs/handoffs/${escaped}/phase-0*${phase}-`).test(target.command);
}

/** Why a `phase:`/`verify:` ref can never be this phase's wait, or null (#129). */
function selfRefProblem(target: WatchRefTarget, slug: string, phase: number): string | null {
  if (target.kind === 'phase' && target.slug === slug && target.phase === phase) {
    return `names phase ${phase} itself — a phase cannot wait for its own completion; name the sibling it waits on`;
  }
  if (target.kind === 'verify' && !(target.slug === slug && target.phase === phase)) {
    return `a verify: ref re-runs the DECLARING phase's own red lines — phase ${phase} would write verify:${slug}/${phase}`;
  }
  return null;
}

/**
 * What the healer did with a landing — a REPORT, deliberately not a gate.
 *
 * Three rounds of review are condensed in that sentence. The scheduler first
 * handed a landing over fire-and-forget (QA round 1, F2), then re-offered it on
 * a clock that could not tell a running resume from one that never happened
 * (round 2, G1), then gated on a receipt the healer signed the moment it had
 * CALLED `recoverPhase` — before a session could possibly be known to exist —
 * which turned a lost delivery into a landing gated for ever, silently
 * (round 3, H1). Each fix took its signal from the caller's intent; each moved
 * the uncertainty one layer down instead of removing it.
 *
 * The hold against re-offering now comes from the things that actually know:
 * `deps.resumeInFlight` — the service's own un-settled drive promise, which
 * settles exactly when the drive does — and the record's own status while a
 * session runs (`WATCH_INELIGIBLE_STATUSES`). When the drive settles, the
 * service inspects what really happened and un-charges a delivery that
 * launched nothing (`voidWatchDelivery`). Nothing here signs anything.
 *
 *   - `resumed`  — a delivery drive was STARTED. No more is knowable yet, and
 *                  the word claims no more; the healer's own bookkeeping (the
 *                  charge, the stamp, the save) already happened inside it.
 *   - `deferred` — the healer could not act: a fleet freeze, `--allow-run` off,
 *                  a drive already in flight, the over-cap errand. Nothing is
 *                  spent; ask again on the cadence.
 *   - `done`     — nothing is waiting on this any more. Retire the row.
 */
export type WatchLandingOutcome = 'resumed' | 'deferred' | 'done';

type Tracked = { slug: string; phase: number; target: WatchRefTarget };

export class WatchScheduler {
  private deps: WatchSchedulerDeps;
  private clock: ConvergeClock;
  private handle: unknown = null;
  private closed = true;
  /**
   * One probe per REF per PASS — two runs watching one workflow ask once.
   *
   * Held for the whole pass rather than only while the request is open,
   * because the sweep is sequential: an in-flight-only guard would be
   * satisfied every time (the first probe has always settled before the
   * second record is reached) and the second plan would make a second `gh`
   * call for the same workflow run, on a rate-limited API, for an answer it
   * already had. Cleared at the top of each `tick`, so the per-scheme cadence
   * — and nothing else — decides when a ref is genuinely re-asked.
   */
  private asked = new Map<string, Promise<WatchState>>();
  /** Refs whose refusal has been journalled, so it is said once and not every tick. */
  private refused = new Set<string>();
  private passes = 0;
  /**
   * `<slug>/<phase>` keys the board just moved on (`boardMoved`) — every ref
   * naming one is due on the next pass whatever its clock says, and a landed
   * `phase:` row is re-read so a re-open un-lands it. Kept here rather than
   * written onto the rows: production re-loads each run from disk every pass,
   * so a due time set on a row this pass did not save would be lost.
   */
  private boardDue = new Set<string>();
  /** The runs the current pass loaded — a sibling's record is read from here. */
  private passRuns: { slug: string; state: RunState }[] = [];

  constructor(deps: WatchSchedulerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? REAL_CLOCK;
  }

  /** A harness seam: swap the clock BEFORE `open()`. */
  setClock(clock: ConvergeClock): void { this.clock = clock; }

  /** Arm the timer (idempotent). */
  open(): void {
    if (!this.closed) return;
    this.closed = false;
    this.arm();
  }

  close(): void {
    this.closed = true;
    if (this.handle != null) this.clock.clearTimeout(this.handle);
    this.handle = null;
    this.asked.clear();
  }

  /**
   * What it is holding. Nothing reads it yet — the Pulse's watch card is Phase
   * 4's — and it is kept because the numbers are the ones an operator will want.
   *
   * ⚠️ `nextDueAt` is deliberately NOT computed here. `nextDue()` runs through
   * `dueFor()`, which PRUNES stale rows as it goes, so a read of this snapshot
   * would mutate every watched record — a write behind a getter, which is how
   * a UI poll becomes a state change. Whoever adds the card should read the
   * scheduler's own armed timer instead, or split the prune out first
   * (Outstanding 8).
   */
  snapshot(): { passes: number; asked: string[]; open: boolean } {
    return {
      passes: this.passes,
      asked: [...this.asked.keys()],
      open: !this.closed,
    };
  }

  /**
   * One pass, awaited — the operator's press, and the harness seam every test
   * uses instead of racing the timer.
   */
  async tick(): Promise<void> {
    if (this.closed) return;
    let hold: { by?: string; plans?: readonly string[] } | null | undefined;
    try { hold = this.deps.fleetHold?.(); } catch { hold = null; }
    // A hold on every plan skips the pass. One that binds only some — a
    // restart waiting for its lanes (control-tower phase 48, #70) — skips
    // just their runs below, and every other plan's refs are still asked.
    if (hold && !hold.plans) { this.arm(); return; }
    this.passes += 1;
    this.asked.clear();
    // The board moves this pass acts on; one arriving while it runs waits for the next.
    const poked = this.boardDue;
    this.boardDue = new Set();

    let runs: { slug: string; state: RunState }[] = [];
    try { runs = this.deps.runs(); } catch (error) { log.warn('watch.runs-failed', { error }); }
    this.passRuns = runs;

    const now = this.clock.now();
    for (const { slug, state } of runs) {
      if (holdBinds(hold, slug)) continue;
      let changed = false;
      // The rotation's own writes — a terminal row's retired due time, a pruned
      // row — must reach the save exactly like a verdict: production re-loads
      // the run from disk on every pass, so a delete that lives only in this
      // object protects nothing (QA round 3, M2).
      const sink = { changed: false };
      const landings: { phase: number; landed: WatchState }[] = [];
      for (const record of Object.values(state.phases ?? {})) {
        const due = this.dueFor(slug, record, now, sink, poked);
        if (!due.length) continue;
        for (const target of due) {
          // A row that already says `landed` is due for RE-DELIVERY, not for a
          // second probe: `gh` is rate-limited and a `cmd:` ref runs a command.
          // The stored verdict is the world's final answer; re-asking for it
          // would cost a network round trip to be told the same thing.
          const known = record.watchState?.refs.find((r) => r.ref === target.ref);
          // …except a `phase:` ref (control-tower phase 88, #129): its answer is
          // the console's own record, free to read, and NOT final — a phase
          // re-opened by its §Verification (phase 62) or by reconcile (phase
          // 79) un-lands every ref that waited on it. So it is re-read.
          const reread = target.kind === 'phase' && known?.state === 'landed';
          const settledLanding = reread && this.landingSettled(record, target.ref);
          const selfRef = selfRefProblem(target, slug, record.phase);
          // A `cmd:` ref the console MINTED runs only when the operator said so
          // (SLF-8): written once as `unknown`, with no clock, never asked again.
          // `unknown`, not `refused` — the console did not judge the command, it
          // did not ask; the same word `watchCmdRefs` off gets.
          const mintedHeld = target.kind === 'cmd' && this.mintedHeld(record, target.ref);
          // A `cmd:` ref RUNS something on every pass, for as long as the phase
          // is parked — on a cadence that backs off (`WATCH_CMD_BACKOFF_MS`),
          // until the phase's WAIT BUDGET ends (control-tower phase 6, #19),
          // with a run-count backstop behind both. Either end is a refusal in
          // words, so an operator sees a state rather than a silence.
          //
          // …except on a park whose budget is already SPENT (control-tower
          // phase 45, #59): that phase waits on its refs alone, with no clock
          // of its own, so the budget's end is not the end of the watch — the
          // run-count backstop below is what bounds it.
          //
          // …and a phase parked on a HUMAN STEP has no wait budget at all
          // (control-tower phase 43): its `cmd:` refs run until the step's
          // window ends, which for a `third-party-approval` is days, not the
          // eight hours `waitBudgetEndOf` would read for an unstamped park.
          const stepEnd = stepWindowEndOf(record);
          const budgetEnd = target.kind === 'cmd' && !record.declared?.budgetSpent
            ? (stepEnd !== undefined ? stepEnd : waitBudgetEndOf(record)) : null;
          // A `lock:` ref naming THIS phase's own lock never lands (#42): the
          // console holds that lock for the phase and releases it at the
          // session's closeout, so its release is the phase's own teardown and
          // never the event it waited for. Asked before everything, a stored
          // `landed` row included — a declaration an older console armed is
          // refused here, in words, once, and retired from the rotation.
          const ownLock = target.kind === 'lock' && isOwnLockRef(target.ref, slug, record.phase);
          const verdict: WatchState = ownLock
            ? { ref: target.ref, state: 'refused' as const, detail: `names phase ${record.phase}'s own lock — ${OWN_LOCK_WATCH_REFUSAL}` }
            : selfRef
            ? { ref: target.ref, state: 'refused' as const, detail: selfRef }
            : known?.state === 'landed' && !reread
            ? { ref: known.ref, state: 'landed', ...(known.detail ? { detail: known.detail } : {}) }
            : mintedHeld
              ? { ref: target.ref, state: 'unknown' as const, detail: 'console-minted cmd ref — not run (watchMintedCmdRefs is off)' }
              : target.kind === 'cmd' && (known?.runs ?? 0) >= MAX_CMD_RUNS_PER_PHASE
                ? {
                  ref: target.ref, state: 'refused' as const,
                  detail: `run ${MAX_CMD_RUNS_PER_PHASE} times without landing — this console will not run it again`,
                }
                : budgetEnd !== null && now >= budgetEnd
                  ? {
                    ref: target.ref, state: 'refused' as const,
                    detail: `${stepEnd !== undefined ? "the human step's window" : "the phase's wait budget"} ended `
                      + `${new Date(budgetEnd).toISOString()} after ${known?.runs ?? 0} runs — this console will not run it again`,
                  }
                  : await this.ask(target);
          const refusedByName = ownLock || Boolean(selfRef);
          if (this.apply(slug, state, record, target, verdict, now, {
            terminal: mintedHeld || refusedByName || (settledLanding && verdict.state === 'landed'),
            retire: refusedByName,
          })) changed = true;
          // A settled landing re-read and still landed is not a new landing:
          // offering it again would re-deliver what the healer already closed.
          if (verdict.state === 'landed' && !settledLanding) landings.push({ phase: record.phase, landed: verdict });
        }
      }
      // The healer's own bookkeeping — the charge, the `deliveredAt` stamp,
      // the save — happens inside `resumeOnWatchLanded`, beside the rollback
      // that can revoke it. This loop acts on exactly one answer: `done`
      // retires the row. It used to stamp the receipt here, AFTER the healer's
      // `.catch` could have run, which is how a rollback's delete became a
      // no-op and a landing was gated for ever (QA round 3, H1).
      for (const { phase, landed } of landings) {
        let outcome: WatchLandingOutcome = 'deferred';
        try {
          outcome = (await this.deps.onLanded?.(slug, state, phase, landed)) ?? 'deferred';
        } catch (error) {
          // A throwing healer is a DEFERRAL, not a delivery: the landing was
          // not acted on, so it must not be charged as though it had been.
          log.warn('watch.landed-failed', { slug, phase, ref: landed.ref, error });
        }
        if (outcome !== 'done') continue;
        const record = state.phases[String(phase)];
        const row = record?.watchState?.refs.find((r) => r.ref === landed.ref);
        if (row && row.nextDueAt !== undefined) { delete row.nextDueAt; changed = true; }
        // …and the answer is kept ON THE RECORD (control-tower phase 87, #126).
        // A landed row with no due time reads "due" to `dueFor`, so deleting the
        // clock alone offered the same landing again every minute and retired it
        // again, for as long as the declaration stood.
        if (record && !record.watchLandedDone?.includes(landed.ref)) {
          record.watchLandedDone = [...(record.watchLandedDone ?? []), landed.ref];
          changed = true;
        }
      }
      if (changed || sink.changed) {
        try { this.deps.save?.(slug, state); } catch { /* the verdict matters more than the write */ }
      }
    }
    // Re-armed from the SAME snapshot this pass acted on — the records were
    // mutated in place, so their fresh `nextDueAt` values are already here.
    this.arm(runs);
  }

  /* ---------------------------------------------------------------- *
   * The rotation
   * ---------------------------------------------------------------- */

  /**
   * This phase's refs that are due now.
   *
   * A ref with no row yet is due immediately — the first pass after a
   * declaration should not wait out a cadence — and a ref whose row says
   * `landed` or `refused` is never due again: a landed ref stays landed, and
   * nothing about the console's own policy changes between two ticks.
   */
  private dueFor(
    slug: string, record: PhaseRecord, now: number,
    /**
     * Where a write this rotation performs is REPORTED, so the pass can save
     * it. `nextDue()` passes none — arming the timer must not buy a write —
     * which leaves its prune the known, documented mutation (Outstanding 8).
     */
    sink?: { changed: boolean },
    /** `<slug>/<phase>` keys the board moved on — refs naming one are due now (`boardMoved`). */
    poked?: ReadonlySet<string>,
  ): WatchRefTarget[] {
    if (!watchEligible(record)) return [];
    const isPoked = (target: WatchRefTarget): boolean => {
      if (!poked?.size) return false;
      for (const key of poked) {
        const cut = key.lastIndexOf('/');
        if (namesPhase(target, key.slice(0, cut), Number(key.slice(cut + 1)))) return true;
      }
      return false;
    };
    const declared = record.declared?.watch;
    const refs = [...(declared?.length ? declared : record.watch ?? [])];
    // The one wait the console can answer entirely from its own state, added
    // even when the session declared nothing: a phase parked behind another
    // plan's claim on this repository.
    for (const holder of record.waitingOn ?? []) {
      if (!holder?.slug || holder.phase === undefined) continue;
      const implied = `lock:${holder.slug}/${holder.phase}`;
      if (!refs.includes(implied)) refs.push(implied);
    }
    // A person's turn (control-tower phase 43): an open human step's proof IS a
    // watch ref, added the same way — the step lives in its ledger, the proof
    // rides the declaration (`parkOnStep`), and a landing proves the step.
    const proof = stepProofOf(record);
    if (proof && !refs.includes(proof.ref)) refs.push(proof.ref);
    // Refs this phase RETIRED — refused by the policy, or run to the cap — are
    // out of the rotation for good, whatever a new declaration says (SLF-8):
    // the same command is the same command, and the world's answer was final.
    // Only an operator's Retry un-retires (`resetForRetry` by `operator`).
    const retired = new Set(record.watchRetired ?? []);
    const declaredTargets = pollableRefs(refs).slice(0, MAX_WATCH_REFS);
    // A retired ref keeps its `refused` row while it is declared — the operator
    // sees a state, not a silence — but is never a probe target again.
    const targets = declaredTargets.filter((t) => !retired.has(t.ref));
    const store = record.watchState;
    if (store) {
      // PRUNE to what is actually declared now, before anything reads the cap.
      //
      // Rows accumulate across declarations, and the cap is a hard 8: with eight
      // stale rows stored, a ninth ref could never be written, so every pass
      // re-probed it, re-journalled it and re-saved the run — a `cmd:` ref
      // executing every sixty seconds instead of every five minutes, for ever
      // (QA F4). A row for a ref nobody is watching any more is not evidence
      // worth keeping; it is the thing that stops the real one being kept.
      const live = new Set(declaredTargets.map((t) => t.ref));
      if (store.refs.some((r) => !live.has(r.ref))) {
        store.refs = store.refs.filter((r) => live.has(r.ref));
        if (sink) sink.changed = true;
      }
    }
    const rows = store?.refs ?? [];
    return targets.filter((target) => {
      const row = rows.find((r) => r.ref === target.ref);
      if (!row) return true;
      if (row.state === 'refused') return false;
      // A minted `cmd:` row the operator has not enabled: written once, held.
      if (target.kind === 'cmd' && row.state === 'unknown' && row.minted && this.mintedHeld(record, target.ref)) return false;
      // A LANDING is re-offered, not re-probed — the world's answer is final,
      // the healer's chance to act on it is not. Three things end the offer:
      //
      //   - the declaration is spent (a session produced work, so nothing is
      //     waiting on this any more);
      //   - the healer has written its over-cap ERRAND for this declaration,
      //     which is its way of saying it has nothing left to try — for EVERY
      //     landed ref of the phase, since control-tower phase 6: one errand per
      //     declaration, so a second landed ref must not be offered to a healer
      //     that will write nothing. `watchResumes` alone cannot carry this: the
      //     errand branch returns without incrementing it, so the count sits one
      //     below the cap for ever and the offer would recur every minute;
      //   - the count is over the cap anyway, which covers a record written by a
      //     build that had no errand stamp;
      //   - the healer answered `done` for this landing — nothing in this
      //     declaration waits on it (control-tower phase 87, #126).
      if (row.state === 'landed') {
        if (this.landingSettled(record, row.ref)) {
          // A settled `phase:` landing is re-read when the board moves on its
          // phase — a re-open un-lands it (control-tower phase 88, #129).
          if (target.kind === 'phase' && isPoked(target)) return true;
          // Terminal. Drop the due time with it: a row nothing will ever
          // advance goes on reading "due" to `evidenceFingerprint`, which then
          // changes every minute for ever — the permanent spin F3 closed for a
          // different shape and this one re-opened (QA round 2, G2). Reported
          // through the sink because the delete must reach DISK: production
          // re-loads the run on every pass, so an unsaved delete stopped the
          // churn only for the object it happened on (QA round 3, M2).
          if (row.nextDueAt !== undefined) {
            delete row.nextDueAt;
            if (sink) sink.changed = true;
          }
          return false;
        }
        // A delivery of this landing is still being DRIVEN — a `recoverPhase`
        // or retry whose promise has not settled, a runner on the plan. The
        // service that started the drive answers, because the promise it holds
        // settles exactly when the drive does; a session that is RUNNING is
        // already excluded above (`WATCH_INELIGIBLE_STATUSES`). This replaces a
        // `deliveredAt`/`endedAt` stamp gate that was signed before the drive
        // could know whether a session would exist, and therefore gated a
        // landing for ever when it did not (QA round 3, H1).
        if (this.deps.resumeInFlight?.(slug, record.phase)) return false;
      }
      if (isPoked(target)) return true;
      return row.nextDueAt === undefined || row.nextDueAt <= now;
    });
  }

  /**
   * Is this landing closed — the declaration spent, the healer's over-cap
   * errand written, its `done` answer kept, or the delivery cap passed? Such a
   * row is never offered again (the four ends `dueFor` lists).
   */
  private landingSettled(record: PhaseRecord, ref: string): boolean {
    return !record.declared
      || record.watchLandedErrandFor !== undefined
      || Boolean(record.watchLandedDone?.includes(ref))
      || (record.watchResumes ?? 0) > MAX_LANDING_DELIVERIES;
  }

  /**
   * The board moved on `<slug>`'s phase N — it reached `done`, or it was
   * re-opened (control-tower phase 88, #129 ask 2). Every ref naming it — a
   * `phase:` ref, a `cmd:` ref over its handoff — is asked on a pass fired NOW,
   * not on the next timer: P50 would have noticed P43's completion 3 h 20 min
   * late on the `cmd:` back-off. Answers how many watched refs name it; with
   * none, nothing fires.
   */
  boardMoved(slug: string, phase: number): number {
    if (this.closed) return 0;
    let runs: { slug: string; state: RunState }[] = [];
    try { runs = this.deps.runs(); } catch { return 0; }
    let named = 0;
    for (const { state } of runs) {
      for (const record of Object.values(state.phases ?? {})) {
        const declared = record.declared?.watch?.length ? record.declared.watch : record.watch ?? [];
        named += pollableRefs(declared).filter((target) => namesPhase(target, slug, phase)).length;
      }
    }
    if (!named) return 0;
    this.boardDue.add(`${slug}/${phase}`);
    if (this.handle != null) this.clock.clearTimeout(this.handle);
    this.handle = this.clock.setTimeout(() => { void this.tick(); }, 0);
    return named;
  }

  /**
   * The earliest moment anything is due, or null when nothing is tracked.
   *
   * Takes the runs it was given wherever the caller already has them: a pass
   * reads every open plan's latest run through the store, and asking twice per
   * tick would both double that work and let the timer be armed from a
   * different snapshot than the pass acted on.
   */
  private nextDue(known?: { slug: string; state: RunState }[]): number | null {
    let soonest: number | null = null;
    let runs: { slug: string; state: RunState }[] = known ?? [];
    if (!known) { try { runs = this.deps.runs(); } catch { return null; } }
    const now = this.clock.now();
    for (const { slug, state } of runs) {
      for (const record of Object.values(state.phases ?? {})) {
        if (this.dueFor(slug, record, now).length) return now;
        for (const row of record.watchState?.refs ?? []) {
          if (row.nextDueAt === undefined) continue;
          if (soonest === null || row.nextDueAt < soonest) soonest = row.nextDueAt;
        }
      }
    }
    return soonest;
  }

  private arm(known?: { slug: string; state: RunState }[]): void {
    if (this.handle != null) { this.clock.clearTimeout(this.handle); this.handle = null; }
    if (this.closed) return;
    const due = this.nextDue(known);
    if (due === null) {
      // Nothing to watch. Re-ask on the floor rather than sleeping for ever: a
      // declaration can arrive at any moment and this timer is one wake a
      // minute, which is cheaper than a subscription to every writer of one.
      this.handle = this.clock.setTimeout(() => { void this.tick(); }, WATCH_FLOOR_MS);
      return;
    }
    const delay = Math.max(WATCH_FLOOR_MS, due - this.clock.now());
    this.handle = this.clock.setTimeout(() => { void this.tick(); }, delay);
  }

  /**
   * Ask a declaration's refs NOW, while the session that wrote it is still
   * running `phase-outcome.sh` (control-tower phase 50, #86) — the ingest
   * probe, with the same probe deps this timer uses, so a `cmd:` ref runs here
   * only where it would run on the timer (`--allow-run` and `watchCmdRefs`).
   *
   * 5 of 30 declared refs were already true when they were declared (8 of 30
   * at the first probe): three workflow runs had COMPLETED before the session
   * said it would wait for them. Each still cost a park, a probe and a resume
   * of a 300–470k-token context. Asked here, a landed ref answers "continue"
   * and nothing is parked.
   *
   * Every ref is asked at once and the whole ask is bounded by `budgetMs`: an
   * answer that has not come by then reads `unknown`, which parks exactly as
   * before — a slow `gh` must never hold a session hostage. A ref naming the
   * declaring phase's own lock is `refused` (#42), never a landing. Nothing is
   * stored: the declaration has not been ingested, and a refusal or a pending
   * answer is the timer's to write when it is.
   */
  async probeDeclared(
    slug: string, phase: number, refs: readonly string[], opts: { budgetMs: number },
  ): Promise<{ landed: WatchState | null; refs: WatchState[] }> {
    let hold: { plans?: readonly string[] } | null | undefined;
    try { hold = this.deps.fleetHold?.(); } catch { hold = null; }
    const targets = pollableRefs(refs).slice(0, MAX_WATCH_REFS);
    if (holdBinds(hold, slug)) {
      return { landed: null, refs: targets.map((t) => ({ ref: t.ref, state: 'unknown' as const, detail: 'the console is frozen' })) };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), opts.budgetMs);
      (timer as { unref?: () => void }).unref?.();
    });
    // Asked afresh: the pass's loaded runs are not this declaration's.
    try { this.passRuns = this.deps.runs(); } catch { this.passRuns = []; }
    const one = async (target: WatchRefTarget): Promise<WatchState> => {
      if (target.kind === 'lock' && isOwnLockRef(target.ref, slug, phase)) {
        return { ref: target.ref, state: 'refused', detail: `names phase ${phase}'s own lock — ${OWN_LOCK_WATCH_REFUSAL}` };
      }
      const self = selfRefProblem(target, slug, phase);
      if (self) return { ref: target.ref, state: 'refused', detail: self };
      // A `cmd:` ref the console could never run as written is refused NOW,
      // while the session can still fix it (control-tower phase 88, #125) —
      // its shape first, then the run policy's verdict, however `watchCmdRefs`
      // is set: a ref refused at its first probe is a park nothing resumes.
      if (target.kind === 'cmd') {
        const problem = cmdRefProblem(target.command) ?? this.deps.judgeCommand?.(target.command) ?? null;
        if (problem) return { ref: target.ref, state: 'refused', detail: problem.slice(0, 240) };
      }
      const asked = this.probeOf(target, Math.min(WATCH_CMD_TIMEOUT_MS, opts.budgetMs));
      const answer = await Promise.race([
        asked.catch((error): WatchState => ({
          ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160),
        })),
        late,
      ]);
      return answer === 'late'
        ? { ref: target.ref, state: 'unknown', detail: `not answered within the ${Math.round(opts.budgetMs / 1000)} s ingest budget` }
        : answer;
    };
    try {
      const answers = await Promise.all(targets.map(one));
      return { landed: answers.find((a) => a.state === 'landed') ?? null, refs: answers };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Ask ONE ref now, for a person's *I did it — check* on a human step
   * (control-tower phase 43): the same probe deps the timer uses, so a `cmd:`
   * proof runs only where it would run on the timer, and a command the run
   * policy refuses is refused here in its words. Nothing is stored — the
   * caller moves the step; the timer's own row for the ref is its to write.
   */
  async probeNow(ref: string): Promise<WatchState> {
    const [target] = pollableRefs([ref]);
    if (!target) return { ref, state: 'refused', detail: 'not a ref this console can check (gh:, date:, lock:, phase:, verify: or cmd:)' };
    if (target.kind === 'cmd') {
      const problem = cmdRefProblem(target.command) ?? this.deps.judgeCommand?.(target.command) ?? null;
      if (problem) return { ref: target.ref, state: 'refused', detail: problem.slice(0, 240) };
    }
    try { this.passRuns = this.deps.runs(); } catch { this.passRuns = []; }
    return this.probeOf(target, WATCH_CMD_TIMEOUT_MS).catch((error): WatchState => ({
      ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160),
    }));
  }

  /** One ref, asked at most once per pass however many phases declared it. */
  /**
   * One probe of one target. `phase:` and `verify:` are answered from the
   * console's own state (control-tower phase 88) — a sibling in a run this pass
   * loaded from its record, anything else through the service — and never
   * through the test seam `probe`, which stands in for what would SHELL.
   */
  private probeOf(target: WatchRefTarget, cmdTimeoutMs: number): Promise<WatchState> {
    if (target.kind === 'phase' || target.kind === 'verify') {
      return probeWatchRef(target, {
        phaseDone: (slug, phase) => {
          const loaded = this.passRuns.find((run) => run.slug === slug)?.state.phases?.[String(phase)];
          return phaseDoneOf(loaded) ?? this.deps.phaseDone?.(slug, phase) ?? null;
        },
        ...(this.deps.verifyProbe ? { verifyProbe: this.deps.verifyProbe } : {}),
      });
    }
    return this.deps.probe
      ? this.deps.probe(target)
      : probeWatchRef(target, {
        now: this.clock.now(),
        lockFree: this.deps.lockFree,
        ...(this.deps.cmdRefsEnabled?.() && this.deps.runCommand
          ? { runCommand: (command: string) => this.deps.runCommand!(command, cmdTimeoutMs) }
          : {}),
      });
  }

  private ask(target: WatchRefTarget): Promise<WatchState> {
    const already = this.asked.get(target.ref);
    if (already) return already;
    const probe = this.probeOf(target, WATCH_CMD_TIMEOUT_MS);
    const settled = probe.catch((error): WatchState => ({
      ref: target.ref, state: 'unknown', detail: String((error as Error)?.message ?? error).slice(0, 160),
    }));
    this.asked.set(target.ref, settled);
    return settled;
  }

  /**
   * Fold one verdict into the record. Answers whether anything changed, which
   * is what decides a save — a pass that learned nothing must not rewrite the
   * run file.
   */
  /** Is this a console-minted `cmd:` ref the operator has not enabled? */
  private mintedHeld(record: PhaseRecord, ref: string): boolean {
    if (!record.declared?.minted?.includes(ref)) return false;
    return !this.deps.mintedCmdRefsEnabled?.();
  }

  private apply(
    slug: string, state: RunState, record: PhaseRecord,
    target: WatchRefTarget, verdict: WatchState, now: number,
    opts: { terminal?: boolean; retire?: boolean } = {},
  ): boolean {
    const at = new Date(now).toISOString();
    const store = (record.watchState ??= { at, refs: [] });
    store.at = at;
    const rows = store.refs;
    const idx = rows.findIndex((r) => r.ref === verdict.ref);
    const before = idx >= 0 ? rows[idx] : null;
    // Only a command that actually RAN is charged. With `watchCmdRefs` off the
    // probe answers `unknown` having executed nothing, and counting that spent
    // the budget on twelve non-events — after which the ref read `refused` for
    // ever, which is precisely what this phase's own F12 ruling says must not
    // happen ("turning the pref back on would never resume watching").
    const ran = target.kind === 'cmd' && (verdict.state === 'landed' || verdict.state === 'pending') ? 1 : 0;
    const runs = (before?.runs ?? 0) + ran;
    const row = {
      ref: verdict.ref,
      scheme: target.kind,
      state: verdict.state,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      checkedAt: at,
      ...(record.declared?.minted?.includes(verdict.ref) ? { minted: true as const } : {}),
      ...(runs ? { runs } : {}),
      ...(() => {
        // A terminal verdict (a held minted ref) gets no clock: nothing will
        // ever advance it, and a row with a past clock churns the fingerprint.
        // A `cmd:` ref's clock backs off with the runs it has made — once the
        // declared window is over; inside it, a sixth of the window (#87).
        const next = opts.terminal ? null : nextDueFor(target, verdict.state, now, runs, declaredWindowOf(record));
        return next === null ? {} : { nextDueAt: next };
      })(),
    };
    // A `cmd:` ref the policy refused, one run to the backstop, or one whose
    // wait budget ended, is RETIRED on the record (SLF-8):
    // `clearWatchBookkeeping` forgets the row with the declaration, so without
    // this the same command came back with a fresh count on the next one.
    // An own-lock ref is retired the same way (#42): it can never land.
    if (verdict.state === 'refused' && (target.kind === 'cmd' || opts.retire) && !record.watchRetired?.includes(verdict.ref)) {
      record.watchRetired = [...(record.watchRetired ?? []), verdict.ref];
    }
    // The cap is enforced here as well as by the prune in `dueFor`, and it is
    // not redundant: the prune bounds rows to the DECLARED set, and a single
    // declaration carrying more than eight pollable refs would otherwise grow
    // the record without limit. A verdict that could not be written must not
    // report a transition either — `!before` stays true for ever when the row
    // can never be created, which is what made an over-cap ref journal and
    // re-save on every pass.
    let stored = true;
    if (idx >= 0) rows[idx] = row;
    else if (rows.length < MAX_WATCH_REFS) rows.push(row);
    else stored = false;
    // A landing that is no longer true — a `phase:` ref whose phase was
    // re-opened (#129) — is not a closed landing either: the ref waits again.
    if (stored && before?.state === 'landed' && verdict.state !== 'landed' && record.watchLandedDone?.includes(verdict.ref)) {
      record.watchLandedDone = record.watchLandedDone.filter((ref) => ref !== verdict.ref);
      if (!record.watchLandedDone.length) delete record.watchLandedDone;
    }

    const transitioned = stored
      && (!before || before.state !== verdict.state || before.detail !== verdict.detail);
    if (transitioned) {
      // The legacy single-ref field, kept in step so a reader written before
      // `watchState` existed still sees the newest verdict.
      record.watchChecked = {
        at, ref: verdict.ref, state: verdict.state,
        ...(verdict.detail ? { detail: verdict.detail } : {}),
      };
      // A refusal is said ONCE, ever. It is a verdict about the console's own
      // policy, not about the world, and repeating it every pass would be the
      // console arguing with itself in a journal a person has to read.
      const speak = verdict.state !== 'refused' || !this.refused.has(verdict.ref);
      if (verdict.state === 'refused') this.refused.add(verdict.ref);
      if (speak) {
        try {
          this.deps.journal?.(slug, state, verdict.state === 'refused' ? 'phase.watch-refused' : 'phase.watch-checked', {
            ref: verdict.ref, scheme: target.kind, state: verdict.state, detail: verdict.detail ?? null,
          }, record.phase);
        } catch { /* a journal must never break the poll */ }
      }
    }
    return transitioned;
  }
}
