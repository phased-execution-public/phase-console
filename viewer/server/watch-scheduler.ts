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
import { type ConvergeClock, REAL_CLOCK } from './converge.ts';
import type { RunState, PhaseRecord } from './runner/state.ts';
import {
  pollableRefs, probeWatchRef, nextDueFor, WATCH_FLOOR_MS, WATCH_CMD_TIMEOUT_MS,
  WATCH_INELIGIBLE_STATUSES, MAX_CMD_RUNS_PER_PHASE,
  type WatchRefTarget, type WatchState,
} from './watch-refs.ts';

/** The same bound `phase-outcome.sh` puts on `--watch`, enforced on the read side too. */
export const MAX_WATCH_REFS = 8;

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
  fleetHold?: () => { at: string; by?: string } | null | undefined;
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
};

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
    let hold: { by?: string } | null | undefined;
    try { hold = this.deps.fleetHold?.(); } catch { hold = null; }
    if (hold) { this.arm(); return; }
    this.passes += 1;
    this.asked.clear();

    let runs: { slug: string; state: RunState }[] = [];
    try { runs = this.deps.runs(); } catch (error) { log.warn('watch.runs-failed', { error }); }

    const now = this.clock.now();
    for (const { slug, state } of runs) {
      let changed = false;
      // The rotation's own writes — a terminal row's retired due time, a pruned
      // row — must reach the save exactly like a verdict: production re-loads
      // the run from disk on every pass, so a delete that lives only in this
      // object protects nothing (QA round 3, M2).
      const sink = { changed: false };
      const landings: { phase: number; landed: WatchState }[] = [];
      for (const record of Object.values(state.phases ?? {})) {
        const due = this.dueFor(slug, record, now, sink);
        if (!due.length) continue;
        for (const target of due) {
          // A row that already says `landed` is due for RE-DELIVERY, not for a
          // second probe: `gh` is rate-limited and a `cmd:` ref runs a command.
          // The stored verdict is the world's final answer; re-asking for it
          // would cost a network round trip to be told the same thing.
          const known = record.watchState?.refs.find((r) => r.ref === target.ref);
          const verdict: WatchState = known?.state === 'landed'
            ? { ref: known.ref, state: 'landed', ...(known.detail ? { detail: known.detail } : {}) }
            // A `cmd:` ref RUNS something on every pass, for as long as the
            // phase is parked. Bounded per phase (see `MAX_CMD_RUNS_PER_PHASE`)
            // and refused in words when the bound is spent, so an operator sees
            // a state rather than a silence.
            : target.kind === 'cmd' && (known?.runs ?? 0) >= MAX_CMD_RUNS_PER_PHASE
              ? {
                ref: target.ref, state: 'refused' as const,
                detail: `run ${MAX_CMD_RUNS_PER_PHASE} times without landing — this console will not run it again`,
              }
              : await this.ask(target);
          if (this.apply(slug, state, record, target, verdict, now)) changed = true;
          if (verdict.state === 'landed') landings.push({ phase: record.phase, landed: verdict });
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
        const row = state.phases[String(phase)]?.watchState?.refs.find((r) => r.ref === landed.ref);
        if (row && row.nextDueAt !== undefined) { delete row.nextDueAt; changed = true; }
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
  ): WatchRefTarget[] {
    if (WATCH_INELIGIBLE_STATUSES.has(record.status)) return [];
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
    const targets = pollableRefs(refs).slice(0, MAX_WATCH_REFS);
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
      const live = new Set(targets.map((t) => t.ref));
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
      // A LANDING is re-offered, not re-probed — the world's answer is final,
      // the healer's chance to act on it is not. Three things end the offer:
      //
      //   - the declaration is spent (a session produced work, so nothing is
      //     waiting on this any more);
      //   - the healer has written its over-cap ERRAND for this exact ref, which
      //     is its way of saying it has nothing left to try. `watchResumes` alone
      //     cannot carry this: the errand branch returns without incrementing it,
      //     so the count sits one below the cap for ever and the offer would
      //     recur every minute to be early-returned every minute;
      //   - the count is over the cap anyway, which covers a record written by a
      //     build that had no errand stamp.
      if (row.state === 'landed') {
        if (!record.declared
          || record.watchLandedErrandFor === row.ref
          || (record.watchResumes ?? 0) > MAX_LANDING_DELIVERIES) {
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
      return row.nextDueAt === undefined || row.nextDueAt <= now;
    });
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

  /** One ref, asked at most once per pass however many phases declared it. */
  private ask(target: WatchRefTarget): Promise<WatchState> {
    const already = this.asked.get(target.ref);
    if (already) return already;
    const probe = this.deps.probe
      ? this.deps.probe(target)
      : probeWatchRef(target, {
        now: this.clock.now(),
        lockFree: this.deps.lockFree,
        ...(this.deps.cmdRefsEnabled?.() && this.deps.runCommand
          ? { runCommand: (command: string) => this.deps.runCommand!(command, WATCH_CMD_TIMEOUT_MS) }
          : {}),
      });
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
  private apply(
    slug: string, state: RunState, record: PhaseRecord,
    target: WatchRefTarget, verdict: WatchState, now: number,
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
    const row = {
      ref: verdict.ref,
      scheme: target.kind,
      state: verdict.state,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      checkedAt: at,
      ...(before?.runs || ran ? { runs: (before?.runs ?? 0) + ran } : {}),
      ...(() => {
        const next = nextDueFor(target, verdict.state, now);
        return next === null ? {} : { nextDueAt: next };
      })(),
    };
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
