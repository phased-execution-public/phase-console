/**
 * The round (control-tower phase 136, #213, §Architecture 19 "Rounds, and
 * what the AI handled"): ONE pass of the console's own clock over every open
 * item of Your turn — in both editions, with no model.
 *
 * A round runs its passes in this order, each one guarded so a pass that
 * throws is logged and the next still runs:
 *   1. `grants`   — a grant whose clock ran out, or whose phase settled, ends;
 *   2. `clock`    — an interrupted check goes back to waiting, an item nobody
 *                   needs any more is withdrawn, a window that closed expires,
 *                   a reminder that is due is sent;
 *   3. `covered`  — an item the AI can now do is withdrawn and its waiters
 *                   resumed (a permission item a live grant covers), and a
 *                   supervisor's item whose subject settled goes with it;
 *   4. `escalate` — an item returned `turnEscalateAfter` times escalates, once;
 *   5. `due`      — a due-when ref that landed turns `upcoming` into a turn with
 *                   its ONE push; a plan act's proof that landed proves it;
 *   6. `proofs`   — every other open item's proof that the console reads (a
 *                   console's or the supervisor's raise: a watch ref, or
 *                   `credential:<id>`) is read again on its back-off, and one
 *                   that landed proves its item and resumes what waited.
 * Then, when anything above CHANGED the turn — an item came due, was proven,
 * expired, was withdrawn or escalated — the counter rises and ONE server-sent
 * event, `turn`, goes out. A reminder or a grant ending is no change to the
 * turn: the counter stays.
 *
 * The clock is the human-step clock (`HUMAN_STEP_CLOCK_MS`, a minute); a run's
 * journal line wakes a round as well, after `ROUND_DEBOUNCE_MS`, so a burst of
 * lines is one round. One round at a time: a round asked for while one runs
 * is folded into one more round after it.
 */

/** A journal line wakes a round after this long, so a burst of lines is one round. */
export const ROUND_DEBOUNCE_MS = 2_000;

export type RoundTrigger = 'clock' | 'event' | 'press';

/** What one round moved, by item id. */
export type RoundChange = {
  due: string[];
  proven: string[];
  expired: string[];
  withdrawn: string[];
  escalated: string[];
  reminded: string[];
  grantsEnded: number;
};

export type RoundCounts = { [K in keyof RoundChange]: number };

/** The passes, in the order a round runs them — each the console's own. */
export type RoundPasses = {
  grants: (now: number) => number;
  clock: (now: number) => { reminded: string[]; expired: string[]; dismissed: string[] };
  covered: (now: number) => string[];
  escalate: (now: number) => string[];
  due: (now: number) => Promise<{ due: string[]; proven: string[] }>;
  proofs: (now: number) => Promise<string[]>;
};

/** The round as `GET /api/turn` reports it. */
export type RoundState = {
  /** The counter: it rises only when a round changed the turn. */
  n: number;
  /** When the last round ran. */
  at: string | null;
  /** When a round last changed the turn. */
  changedAt: string | null;
  trigger: RoundTrigger | null;
  /** What the last round that changed something moved. */
  last: RoundCounts | null;
};

const empty = (): RoundChange => ({ due: [], proven: [], expired: [], withdrawn: [], escalated: [], reminded: [], grantsEnded: 0 });

/** Did a round move the turn? Reminders and grants ending do not. */
export function roundChanged(change: RoundChange): boolean {
  return change.due.length + change.proven.length + change.expired.length + change.withdrawn.length + change.escalated.length > 0;
}

export function countsOf(change: RoundChange): RoundCounts {
  return {
    due: change.due.length, proven: change.proven.length, expired: change.expired.length,
    withdrawn: change.withdrawn.length, escalated: change.escalated.length, reminded: change.reminded.length,
    grantsEnded: change.grantsEnded,
  };
}

export type RoundOptions = {
  /** ONE server-sent event per round that changed the turn. */
  emit: (state: RoundState) => void;
  /** A pass that threw — logged, and the round carries on. */
  failed?: (pass: string, error: unknown) => void;
  now?: () => number;
  debounceMs?: number;
};

/** The events a round's own moves journal — they never wake another round. */
const OWN_EVENTS = /^phase\.human-step-|^policy\.grant-/;

export class TurnRound {
  private n = 0;
  private at: string | null = null;
  private changedAt: string | null = null;
  private trigger: RoundTrigger | null = null;
  private last: RoundCounts | null = null;
  private running: Promise<RoundState> | null = null;
  private again: RoundTrigger | null = null;
  private wake: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  private readonly passes: RoundPasses;
  private readonly opts: RoundOptions;

  constructor(passes: RoundPasses, opts: RoundOptions) {
    this.passes = passes;
    this.opts = opts;
  }

  state(): RoundState {
    return { n: this.n, at: this.at, changedAt: this.changedAt, trigger: this.trigger, last: this.last };
  }

  /** One round — never two at once; one asked for during a round runs once it is done. */
  run(trigger: RoundTrigger = 'clock'): Promise<RoundState> {
    if (this.running) {
      this.again = this.again ?? trigger;
      return this.running;
    }
    this.running = this.once(trigger).finally(() => {
      this.running = null;
      const next = this.again;
      this.again = null;
      if (next) void this.run(next);
    });
    return this.running;
  }

  /** A run wrote a journal line: a round soon, once for a burst. The round's own lines wake nothing. */
  poke(event: string): void {
    if (this.wake || OWN_EVENTS.test(event)) return;
    this.wake = setTimeout(() => { this.wake = null; void this.run('event'); }, this.opts.debounceMs ?? ROUND_DEBOUNCE_MS);
    this.wake.unref?.();
  }

  /** Arm the clock. */
  start(everyMs: number): void {
    this.stop();
    this.timer = setInterval(() => { void this.run('clock'); }, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
    this.timer = null;
    this.wake = null;
  }

  private guarded<T>(pass: string, fallback: T, fn: () => T): T {
    try { return fn(); } catch (error) {
      this.opts.failed?.(pass, error);
      return fallback;
    }
  }

  private async guardedAsync<T>(pass: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (error) {
      this.opts.failed?.(pass, error);
      return fallback;
    }
  }

  private async once(trigger: RoundTrigger): Promise<RoundState> {
    const now = this.opts.now?.() ?? Date.now();
    const change = empty();
    change.grantsEnded = this.guarded('grants', 0, () => this.passes.grants(now));
    const clock = this.guarded('clock', { reminded: [], expired: [], dismissed: [] }, () => this.passes.clock(now));
    change.reminded.push(...clock.reminded);
    change.expired.push(...clock.expired);
    change.withdrawn.push(...clock.dismissed);
    change.withdrawn.push(...this.guarded('covered', [] as string[], () => this.passes.covered(now)));
    change.escalated.push(...this.guarded('escalate', [] as string[], () => this.passes.escalate(now)));
    const due = await this.guardedAsync('due', { due: [] as string[], proven: [] as string[] }, () => this.passes.due(now));
    change.due.push(...due.due);
    change.proven.push(...due.proven);
    change.proven.push(...await this.guardedAsync('proofs', [] as string[], () => this.passes.proofs(now)));
    this.at = new Date(now).toISOString();
    this.trigger = trigger;
    if (roundChanged(change)) {
      this.n += 1;
      this.changedAt = this.at;
      this.last = countsOf(change);
      try { this.opts.emit(this.state()); } catch (error) { this.opts.failed?.('emit', error); }
    }
    return this.state();
  }
}
