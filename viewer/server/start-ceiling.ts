/**
 * The per-instance ceiling over every automatic `claude` start.
 *
 * Fourteen doors start a `claude` with no person asking (`START_DOORS`), and
 * each is bounded on its own — a boot re-adopts once per plan, the wait clock
 * fires once per wait, the ladder climbs its rungs — but nothing bounded the
 * SUM: five starts in 109 seconds, a $22.23 re-board, an 11.76-hour stale
 * resume all began "a session started" and nothing in the console could have
 * refused the next one (chapter 02 SLF-1, requirement ii). This is that bound:
 * one sliding hour, so many starts and so many dollars, per instance.
 *
 * Three rules.
 *
 *  - **Automatic only.** A press through `OPERATOR_DOOR` is never counted and
 *    never refused: a ceiling that could stop a person from starting a run
 *    they are looking at would be the console overruling the operator, which
 *    is the one thing zero-touch may not mean.
 *  - **Refuse by name, announce once.** A refused start writes
 *    `run.start-refused {door, ceiling, limit, count, until}` on the run it
 *    would have started (or the console log when there is no run), and the
 *    `health` announcement goes out ONCE per window — the second refusal in
 *    the same hour is the same fact.
 *  - **The dollars are what sessions REPORT.** `spend()` is charged from the
 *    session ledger's `costUsd` as each session ends, so the money ceiling
 *    reads the last hour's spend and refuses the next start over it. A session
 *    whose cost never arrived (`costSource: 'none'`) charges nothing — a wall
 *    that counted guesses would refuse work for money nobody spent.
 *
 * `0` on either limit switches that limit off. The two prefs are
 * `ceilingStartsPerHour` and `ceilingUsdPerHour` (`shared/automation-model.js`
 * puts them under `caps`).
 */

import type { Actor, StartDoor } from './runner/state.ts';
import { isAutomatic } from './actor.ts';

/** The sliding window every count is taken over. */
export const CEILING_WINDOW_MS = 60 * 60_000;

/**
 * The shipped limits. Forty starts an hour is roomy for a healthy console —
 * twelve of them are the MCP health probe on its five-minute clock when a
 * registry exists, and a busy three-lane console relaunches a handful more —
 * and still catches a once-a-minute self-invocation loop inside the hour.
 * $250 an hour is above any session's own cap (`SESSION_CAPS_BY_SIZE` tops
 * out at $120) and below what three runaway lanes would burn.
 */
export const DEFAULT_STARTS_PER_HOUR = 40;
export const DEFAULT_USD_PER_HOUR = 250;

export type CeilingLimits = {
  /** Automatic starts allowed per sliding hour; 0 = unbounded. */
  startsPerHour: number;
  /** Session dollars allowed per sliding hour before the next start is refused; 0 = unbounded. */
  usdPerHour: number;
};

export type CeilingRefusal = {
  ok: false;
  ceiling: 'startsPerHour' | 'usdPerHour';
  limit: number;
  /** The count (starts) or the sum (dollars, two decimals) inside the window. */
  count: number;
  /** ISO — when the oldest entry in the window leaves it, so a start could be admitted again. */
  until: string;
  door: StartDoor;
};

export type CeilingVerdict = { ok: true; starts: number; usd: number } | CeilingRefusal;

type StartEntry = { at: number; door: StartDoor; slug: string | null };
type SpendEntry = { at: number; usd: number };

export class StartCeiling {
  private starts: StartEntry[] = [];
  private spend: SpendEntry[] = [];
  /** The window (its `until`) the last `health` announcement covered — once per window. */
  private announcedUntil = 0;

  private readonly limits: () => CeilingLimits;
  private readonly now: () => number;

  constructor(limits: () => CeilingLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  /**
   * May this actor start a `claude` now? A press is always admitted and never
   * counted; an automatic door is judged against both limits over the last
   * hour. Judging does not charge — `charge()` does, once the start is real —
   * so a refusal elsewhere (a claimed phase, a preflight wall) never spends a
   * slot.
   */
  admit(actor: Actor, at = this.now()): CeilingVerdict {
    this.prune(at);
    const starts = this.starts.length;
    const usd = round(this.spend.reduce((sum, entry) => sum + entry.usd, 0));
    if (!isAutomatic(actor)) return { ok: true, starts, usd };
    const limits = this.limits();
    if (limits.startsPerHour > 0 && starts >= limits.startsPerHour) {
      return {
        ok: false, ceiling: 'startsPerHour', limit: limits.startsPerHour, count: starts,
        until: new Date(this.starts[0].at + CEILING_WINDOW_MS).toISOString(), door: actor.door,
      };
    }
    if (limits.usdPerHour > 0 && usd >= limits.usdPerHour) {
      return {
        ok: false, ceiling: 'usdPerHour', limit: limits.usdPerHour, count: usd,
        until: new Date((this.spend[0]?.at ?? at) + CEILING_WINDOW_MS).toISOString(), door: actor.door,
      };
    }
    return { ok: true, starts, usd };
  }

  /** A start happened through an automatic door: count it. A press counts for nothing. */
  charge(actor: Actor, slug: string | null = null, at = this.now()): void {
    if (!isAutomatic(actor)) return;
    this.prune(at);
    this.starts.push({ at, door: actor.door, slug });
  }

  /** A session ended and reported what it cost. */
  spendUsd(usd: number, at = this.now()): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.prune(at);
    this.spend.push({ at, usd });
  }

  /**
   * Should this refusal be announced? Once per window: the answer is `true`
   * the first time a refusal lands whose `until` is past the last announced
   * one, and `false` for every further refusal inside that window.
   */
  shouldAnnounce(refusal: CeilingRefusal): boolean {
    const until = Date.parse(refusal.until);
    if (until <= this.announcedUntil) return false;
    this.announcedUntil = until;
    return true;
  }

  /** What the window holds right now, for a status surface or a test. */
  snapshot(at = this.now()): { starts: number; usd: number; limits: CeilingLimits; windowMs: number; doors: Record<string, number> } {
    this.prune(at);
    const doors: Record<string, number> = {};
    for (const entry of this.starts) doors[entry.door] = (doors[entry.door] ?? 0) + 1;
    return {
      starts: this.starts.length,
      usd: round(this.spend.reduce((sum, entry) => sum + entry.usd, 0)),
      limits: this.limits(),
      windowMs: CEILING_WINDOW_MS,
      doors,
    };
  }

  private prune(at: number): void {
    const floor = at - CEILING_WINDOW_MS;
    while (this.starts.length && this.starts[0].at <= floor) this.starts.shift();
    while (this.spend.length && this.spend[0].at <= floor) this.spend.shift();
  }
}

/** The sentence a refusal is thrown and announced with. */
export function ceilingSentence(refusal: CeilingRefusal): string {
  const what = refusal.ceiling === 'startsPerHour'
    ? `${refusal.count} automatic starts in the last hour (the ceiling is ${refusal.limit})`
    : `$${refusal.count.toFixed(2)} of session spend in the last hour (the ceiling is $${refusal.limit})`;
  return `the start ceiling refused the ${refusal.door} door: ${what}. Nothing automatic starts before `
    + `${refusal.until}; a person's Start, Retry or Continue is never refused by it, and Settings ▸ Automation raises the ceiling.`;
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}
