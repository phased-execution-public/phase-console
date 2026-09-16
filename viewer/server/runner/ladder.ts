/**
 * The remediation ladder: per situation, an ordered list of RUNGS — what the
 * autopilot may try next, by itself — bounded by attempts AND dollars, never
 * the same rung twice for one situation on one phase, and an ERRAND for a
 * person when the ladder is exhausted or the situation was theirs to begin
 * with.
 *
 * Pure: it reads the rung history the run carries (`recoveries[phase].rungs`,
 * `state.ts`), the caps (`ladderCaps(prefs)`) and an availability predicate
 * the caller supplies (which vehicles THIS console can drive today), and it
 * answers with a rung or a reason. It launches nothing. Whoever climbs the
 * rung records it with `accountRung` before spending, settles it with
 * `settleRung` when the session ends, and the next call to `nextRung` sees
 * both — that is the whole contract, and `test/ladder.test.ts` holds it.
 *
 * Why dollars as well as counts: the old healer counted launches (2 per
 * phase, 5 per run) and a $40 session followed by two $6 closeouts and a
 * $20 console closeout was "within budget". The caps here default to 3 rungs
 * and $100 per phase, 10 and $400 per run, $600 per day per console — all
 * prefs, all in Settings ▸ Automation. The table itself lives in
 * `shared/ladder-model.js` so the client renders the same rungs by identity.
 */

import type { Errand, RungRecord } from './state.ts';
import {
  SITUATIONS, SITUATION_ACTOR, actorFor, situationKey, situationLabel, parseSituationKey,
} from '../../shared/situation-model.js';
import {
  decisionKeyOfSituation, isAutomaticAnswer, policyRowOf, policyAnsweredPayload, POLICY_DEFAULTS,
  type ResolvedPolicy,
} from '../../shared/policy-model.js';
import {
  RUNG_VEHICLES as SHARED_RUNG_VEHICLES,
  RUNGS_BY_SITUATION as SHARED_RUNGS_BY_SITUATION,
  DEFAULT_LADDER_CAPS as SHARED_DEFAULT_LADDER_CAPS,
  RUNG_DRIVERS,
  RUNG_DRIVER_LABELS,
  VEHICLE_DRIVERS,
  drivableBy,
  operatorOnlyTables,
  rungsFor as sharedRungsFor,
  rungKey as sharedRungKey,
  countedRungs,
  triedRungKeys,
  untriedRungs,
} from '../../shared/ladder-model.js';

/**
 * The bound on interruptions and the two readings of it — the shared file's,
 * re-exported so a server caller never grows a private copy of the rule that
 * let one rung climb nineteen times (`shared/ladder-model.js`
 * `MAX_RUNG_INTERRUPTIONS`). Beside them the drivability column (phase 10,
 * LFC-2/RCV-10): who drives each vehicle, and the tables nobody does.
 */
export { countedRungs, triedRungKeys, untriedRungs, RUNG_DRIVERS, RUNG_DRIVER_LABELS, VEHICLE_DRIVERS, drivableBy, operatorOnlyTables };
export type RungDriver = (typeof RUNG_DRIVERS)[number];
import type { SettledRungOutcome } from '../../shared/run-lifecycle.js';

export type SituationId = (typeof SITUATIONS)[number];

/**
 * Every vehicle a rung may name, and the rung table per situation — the
 * SHARED vocabulary (`shared/ladder-model.js`), re-exported here by identity
 * so the server climbs exactly the table the client renders and the journal
 * names. The vocabulary is the design's, not the console's current ability:
 * a vehicle the console cannot drive yet is simply never `available`, and the
 * ladder skips it. Per-vehicle notes live beside the list in the shared file.
 */
export const RUNG_VEHICLES = SHARED_RUNG_VEHICLES;
export type RungVehicle = (typeof RUNG_VEHICLES)[number];

export type Rung = {
  vehicle: RungVehicle;
  /** What distinguishes two rungs on the same vehicle (an escalation step, a mode). */
  params?: Record<string, string | number | boolean>;
  /** What the rung is called on a card and in the journal. */
  label: string;
  /** The promise: what starts, on what, roughly what it costs. */
  blurb: string;
  /** Whether climbing it spends a session (counts against the USD caps' intent). */
  spends: boolean;
};

/**
 * The ladder, per situation (or `situation:sub`). Order is the climb order.
 * An empty list means the situation has no automatic rung: the errand is
 * written at once (a person's), or nothing is done (a wait's).
 */
export const RUNGS_BY_SITUATION: Readonly<Record<string, readonly Rung[]>> =
  SHARED_RUNGS_BY_SITUATION as Readonly<Record<string, readonly Rung[]>>;

/** The rung list for a situation, by `id:sub` first and then by `id`. */
export function rungsFor(situationKeyOrId: string): readonly Rung[] {
  return sharedRungsFor(situationKeyOrId) as readonly Rung[];
}

/* ------------------------------------------------------------------ *
 * Caps
 * ------------------------------------------------------------------ */

export type LadderCaps = {
  perPhaseRungs: number;
  perPhaseUsd: number;
  perRunRungs: number;
  perRunUsd: number;
  perDayUsd: number;
};

/** The shipped caps — the shared table's numbers, so docs, Settings and the server agree. */
export const DEFAULT_LADDER_CAPS: Readonly<LadderCaps> = SHARED_DEFAULT_LADDER_CAPS;

/** The caps from prefs — the five `ladder*` keys, defaults for anything missing or unusable. */
export function ladderCaps(prefs: {
  ladderPerPhaseRungs?: number; ladderPerPhaseUsd?: number; ladderPerRunRungs?: number;
  ladderPerRunUsd?: number; ladderPerDayUsd?: number;
} | null | undefined): LadderCaps {
  const num = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    perPhaseRungs: num(prefs?.ladderPerPhaseRungs, DEFAULT_LADDER_CAPS.perPhaseRungs),
    perPhaseUsd: num(prefs?.ladderPerPhaseUsd, DEFAULT_LADDER_CAPS.perPhaseUsd),
    perRunRungs: num(prefs?.ladderPerRunRungs, DEFAULT_LADDER_CAPS.perRunRungs),
    perRunUsd: num(prefs?.ladderPerRunUsd, DEFAULT_LADDER_CAPS.perRunUsd),
    perDayUsd: num(prefs?.ladderPerDayUsd, DEFAULT_LADDER_CAPS.perDayUsd),
  };
}

/* ------------------------------------------------------------------ *
 * Choosing the next rung
 * ------------------------------------------------------------------ */

export type NextRungInput = {
  /** The situation to climb for — `id:sub` key (from `Situation.key`). */
  situation: string;
  /** Every rung already climbed on THIS phase, any situation. */
  history: readonly RungRecord[];
  /** Every rung climbed on this RUN, all phases (the per-run caps). */
  runHistory?: readonly RungRecord[];
  /** Every rung climbed by this console TODAY, all runs (the per-day cap). Absent = unknown = uncounted. */
  dayHistory?: readonly RungRecord[];
  caps?: Partial<LadderCaps>;
  /**
   * QA's own budget: how many rounds this phase has been through, and how many
   * it may. Both absent means uncounted, which is what every caller that is not
   * about QA passes.
   *
   * Separate from `caps` on purpose. The five `LadderCaps` count RUNGS and
   * DOLLARS across every situation at once; a QA round driven from inside a
   * phase's own session is neither, which is how one phase reached five rounds
   * under a two-rung cap without anything noticing. This bound is a claim about
   * the WORK — "QA may fail N times on this phase, then a person looks" — so it
   * rides the run's settings, not the console's ladder preferences.
   */
  qaRounds?: number;
  qaMaxRounds?: number;
  /** Which vehicles this console can drive right now. Absent = every vehicle. */
  available?: (rung: Rung) => boolean;
};

/**
 * Which of the ladder's OWN caps refused a climb — the structured word beside
 * the sentence.
 *
 * The sentences say "ladder budget is spent", and a run's dollar budget is
 * spent too; for as long as the only record was the prose, a situation regex
 * read every spent LADDER cap as a spent RUN budget and sent it to a remedy the
 * console refuses (LFC-8). A refusal now names itself — `refusal:
 * 'ladder-budget-spent'` and which `cap` — so nothing has to read the sentence
 * to know which budget it was. The sentences stay as written: journals,
 * fixtures and errands already carry them.
 */
export type LadderCap = 'phase-rungs' | 'phase-usd' | 'run-rungs' | 'run-usd' | 'day-usd';

export type NextRung =
  | { ok: true; rung: Rung; index: number; key: string }
  | {
    ok: false; exhausted: boolean; reason: string; key: string;
    /** Set when one of the ladder's own caps refused — never for a run budget. */
    refusal?: 'ladder-budget-spent';
    cap?: LadderCap;
    /**
     * The two numbers the cap sentence is made of (phase 10, RCV-6): what
     * the ladder had spent and what the cap allows, in the cap's own unit
     * (rungs, or dollars). The journal line a cap refusal now writes —
     * `phase.ladder-refused {cap, spent, limit}` — is built from these, never
     * parsed back out of the sentence.
     */
    spent?: number;
    limit?: number;
  };

const usd = (records: readonly RungRecord[]): number =>
  records.reduce((sum, r) => sum + (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) ? r.costUsd : 0), 0);

/** The identity a "same rung" is judged by: situation key + vehicle + params (the shared helper). */
export function rungKey(situation: string, rung: Pick<Rung, 'vehicle' | 'params'>): string {
  return sharedRungKey(situation, rung);
}

/**
 * The next rung to climb, or why not. Caps first (a capped phase climbs
 * nothing, whatever the situation), then the first untried, available rung in
 * the situation's table.
 */
export function nextRung(input: NextRungInput): NextRung {
  const caps = { ...DEFAULT_LADDER_CAPS, ...(input.caps ?? {}) };
  const key = input.situation;
  const { id, sub } = parseSituationKey(key);
  // QA's budget first, so the refusal names QA rather than a generic ladder
  // total. It is checked ONLY for `qa-failed`: `qa-pending` is a verdict that
  // was never given, and refusing to ask for one because earlier rounds failed
  // would leave the phase held by a row nobody will ever fill.
  if (id === 'qa-failed' && typeof input.qaMaxRounds === 'number' && input.qaMaxRounds > 0) {
    const rounds = input.qaRounds ?? 0;
    if (rounds >= input.qaMaxRounds) {
      return {
        ok: false, exhausted: true, key,
        reason: `QA has failed ${rounds} of the ${input.qaMaxRounds} rounds this run allows on a phase`,
      };
    }
  }
  // An `interrupted` rung never effectively ran — the console died under it, or
  // was restarted — so it is not a remedy that was TRIED, and counting it spends
  // a phase's ladder on the console's own restarts (R11). It stopped consuming
  // the same-rung-once rule when that rule was written; the numeric caps kept
  // counting it until 2026-08-30. Since 2026-09-07 that exemption is bounded:
  // `MAX_RUNG_INTERRUPTIONS` cuts in a row on ONE rung is a rung that cannot
  // run, and `countedRungs` then counts the whole streak — as tried, and as
  // spend — because the alternative was the same `--resume` offered nineteen
  // times (run 31285928, phase 3). One helper, shared with the card's
  // "next: …" and the runner's own exhaustion reason.
  //
  // The DOLLAR caps below deliberately still count every record: an
  // interrupted rung's `costUsd` is booked when its attempt ends, and money
  // that was spent was spent whatever the rung then settled as.
  const phaseRungs = countedRungs(input.history).length;
  const runRungs = countedRungs(input.runHistory ?? input.history).length;
  if (phaseRungs >= caps.perPhaseRungs) {
    return { ok: false, exhausted: true, key, refusal: 'ladder-budget-spent', cap: 'phase-rungs', spent: phaseRungs, limit: caps.perPhaseRungs, reason: `the phase's ladder budget is spent (${phaseRungs} of ${caps.perPhaseRungs} rungs)` };
  }
  const phaseUsd = usd(input.history);
  if (phaseUsd >= caps.perPhaseUsd) {
    return { ok: false, exhausted: true, key, refusal: 'ladder-budget-spent', cap: 'phase-usd', spent: phaseUsd, limit: caps.perPhaseUsd, reason: `the phase's ladder budget is spent ($${phaseUsd.toFixed(2)} of $${caps.perPhaseUsd})` };
  }
  if (runRungs >= caps.perRunRungs) {
    return { ok: false, exhausted: true, key, refusal: 'ladder-budget-spent', cap: 'run-rungs', spent: runRungs, limit: caps.perRunRungs, reason: `the run's ladder budget is spent (${runRungs} of ${caps.perRunRungs} rungs)` };
  }
  const runUsd = usd(input.runHistory ?? input.history);
  if (runUsd >= caps.perRunUsd) {
    return { ok: false, exhausted: true, key, refusal: 'ladder-budget-spent', cap: 'run-usd', spent: runUsd, limit: caps.perRunUsd, reason: `the run's ladder budget is spent ($${runUsd.toFixed(2)} of $${caps.perRunUsd})` };
  }
  if (input.dayHistory) {
    const dayUsd = usd(input.dayHistory);
    if (dayUsd >= caps.perDayUsd) {
      return { ok: false, exhausted: true, key, refusal: 'ladder-budget-spent', cap: 'day-usd', spent: dayUsd, limit: caps.perDayUsd, reason: `today's ladder budget is spent ($${dayUsd.toFixed(2)} of $${caps.perDayUsd})` };
    }
  }

  // Sub-kind applied (LFC-3): an empty sub-table that is a person's says so
  // here, in `loop.md` and on the classifier's `Situation.actor` alike.
  const actor = actorFor(id, sub);
  const table = rungsFor(key);
  if (!table.length) {
    return {
      ok: false, exhausted: actor === 'machine', key,
      reason: actor === 'person' ? `${situationLabel(id)} is a person's to settle`
        : actor === 'wait' ? `${situationLabel(id)} settles itself — nothing to climb`
          : actor === 'none' ? 'nothing is wrong'
            : `no automatic rung exists for ${key}`,
    };
  }
  // Same rule as the caps above, from the same helper: an `interrupted` rung
  // never effectively ran — until it has been cut short twice in a row.
  const tried = triedRungKeys(input.history);
  let sawUnavailable = false;
  for (let index = 0; index < table.length; index += 1) {
    const rung = table[index];
    if (tried.has(rungKey(key, rung))) continue;
    if (input.available && !input.available(rung)) { sawUnavailable = true; continue; }
    return { ok: true, rung, index, key };
  }
  return {
    ok: false, exhausted: true, key,
    reason: sawUnavailable && !tried.size
      ? `no rung for ${key} is available on this console yet`
      : `every rung for ${key} has been tried on this phase`,
  };
}

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

export type RecoverySlot = {
  attempts: number;
  lastAt: string;
  lastReason?: string;
  fixed?: boolean;
  lastOutcome?: SettledRungOutcome;
  rungs?: RungRecord[];
  errand?: Errand;
  bootResumes?: number;
  /** The one progress extension this phase's ladder was granted, if any (`progressExtension`). */
  extended?: LadderExtension;
};

/**
 * Record a rung BEFORE it is climbed — bumped and persisted before the spend,
 * so a console that dies mid-rung still remembers it tried. Keeps `attempts`
 * and `lastAt` in step for readers that predate rungs.
 */
export function accountRung(
  slot: RecoverySlot,
  entry: { situation: string; rung: RungVehicle | string; params?: Rung['params']; at?: string; note?: string },
): RungRecord {
  const at = entry.at ?? new Date().toISOString();
  const record: RungRecord = {
    situation: entry.situation, rung: entry.rung, at, outcome: 'running',
    ...(entry.params ? { params: entry.params } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  };
  (slot.rungs ??= []).push(record);
  slot.attempts = (slot.attempts ?? 0) + 1;
  slot.lastAt = at;
  delete slot.errand;
  return record;
}

/**
 * Book spend against the newest OPEN rung without deciding how it ended.
 *
 * Separate from `settleRung` because the two facts arrive at different
 * moments and from different deciders. What a rung COST is known the instant
 * its attempt ends — it is that attempt's `outcome.costUsd`. Whether the rung
 * FIXED anything is known later, and by someone else: the service's healer
 * re-reads the board once the run stops. Folding the two together is why the
 * cost half never happened. `Runner.climb` accounted every rung and then had
 * nowhere to settle it, the service settled with `undefined` at six of seven
 * sites, and the one exception passed `PhaseRecord.costUsd` — a CUMULATIVE
 * figure that would over-count the moment a phase climbed twice.
 *
 * The consequence was quiet and total: every `RungRecord.costUsd` stayed
 * absent, `usd()` summed a column of zeros, and `ladderPerDayUsd` — a cap the
 * launch dialog offers and the docs describe — had never once refused a rung.
 *
 * A no-op when the phase has no open rung, which is the common case: an
 * ordinary first boarding is not a rung, so only ladder-driven attempts are
 * charged, which is exactly the money the ladder caps are about.
 */
export function chargeRung(slot: RecoverySlot | undefined, costUsd?: number): RungRecord | null {
  if (!slot || typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd === 0) return null;
  const open = [...(slot.rungs ?? [])].reverse().find((r) => r.outcome === 'running' || r.outcome == null) ?? null;
  if (!open) return null;
  open.costUsd = (open.costUsd ?? 0) + costUsd;
  return open;
}

/** Settle the newest open rung with how it ended and what it cost. */
export function settleRung(
  slot: RecoverySlot,
  outcome: NonNullable<RungRecord['outcome']>,
  costUsd?: number,
  note?: string,
): RungRecord | null {
  const open = [...(slot.rungs ?? [])].reverse().find((r) => r.outcome === 'running' || r.outcome == null) ?? null;
  if (!open) return null;
  return settleRungRecord(slot, open, outcome, costUsd, note);
}

/**
 * Settle ONE named rung of the slot — the write `settleRung` makes on the
 * newest open one, for the caller that must settle an OLDER open rung while
 * a younger one legitimately stays open (`Runner.settleRungsAfterAttempt`,
 * phase 10). The one writer of `outcome` and the slot's `fixed`/`lastOutcome`
 * bookkeeping, so the two readings cannot disagree.
 */
export function settleRungRecord(
  slot: RecoverySlot,
  open: RungRecord,
  outcome: NonNullable<RungRecord['outcome']>,
  costUsd?: number,
  note?: string,
): RungRecord {
  open.outcome = outcome;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) open.costUsd = (open.costUsd ?? 0) + costUsd;
  if (note) open.note = note;
  if (outcome === 'fixed') { slot.fixed = true; slot.lastOutcome = 'fixed'; delete slot.lastReason; }
  else if (outcome === 'no-defect' || outcome === 'superseded' || outcome === 'failed' || outcome === 'interrupted') { slot.lastOutcome = outcome; }
  // `work-in-progress` deliberately writes no `lastOutcome`: it is the ABSENCE
  // of a verdict, exactly as `running` is. A session that declared `partial`
  // has neither fixed nor failed anything yet, and stamping either word on the
  // slot would have the cards and the classifier read a decision nobody made.
  return open;
}

/**
 * The journal line a settlement writes — ONE shape for every writer
 * (zero-touch-console phase 10, RCV-6). All 132 `phase.rung-settled` payloads
 * the audit read were exactly `{outcome, rung}`: no situation, no cost, no
 * params — so the journal could not say which rung of which situation spent
 * what, and the dollar caps were spent from a ledger nobody could audit.
 *
 * `costUsd` is always a number (0 when nothing was booked): a reader summing
 * the column must never have to ask whether an absent field means free or
 * unknown. `chargeRung` books the attempt's spend onto the open rung the
 * moment its attempt ends, so by the time anything settles it the figure is
 * the rung's own. The two doors that write this line — `Runner.settleOpenRung`
 * and `Service.settleRungOn` — are the ONLY callers of `settleRung` outside
 * this file (`test/invariants.test.ts` holds that), which is what makes the
 * shape one shape.
 */
export function rungSettledPayload(record: RungRecord): {
  rung: string; outcome: string; situation: string; params: Rung['params'] | null; costUsd: number;
  note?: string; turns?: number; endedBy?: string; cardId?: string;
} {
  return {
    rung: record.rung,
    outcome: record.outcome ?? 'running',
    situation: record.situation,
    params: record.params ?? null,
    costUsd: typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? record.costUsd : 0,
    ...(record.note ? { note: record.note } : {}),
    ...(typeof record.turns === 'number' ? { turns: record.turns } : {}),
    ...(record.endedBy ? { endedBy: record.endedBy } : {}),
    ...(record.cardId ? { cardId: record.cardId } : {}),
  };
}

/**
 * A cap refusal, as the journal records it (RCV-6): which of the ladder's own
 * caps refused, what was spent and what the cap allows — or null when the
 * refusal was not a cap's (a table exhausted, a person's situation, nothing
 * available). Written as `phase.ladder-refused` by both climbers, ONCE per
 * errand rather than per sweep: the healer passes every few minutes and a
 * refusal re-journalled on each would be the RCV-9 noise again.
 */
export function capRefusal(next: NextRung): { cap: LadderCap; spent: number; limit: number; reason: string } | null {
  if (next.ok || next.refusal !== 'ladder-budget-spent' || !next.cap) return null;
  return { cap: next.cap, spent: next.spent ?? 0, limit: next.limit ?? 0, reason: next.reason };
}

/**
 * How long a `timed-park` rung parks a phase before its own session is asked
 * to re-check the blocker (phase 10): half an hour — long enough for a deploy
 * window or a colleague's merge, short enough that a phase parked on a
 * blocker that landed in five minutes is not lost for the afternoon. Bounded
 * by the same-rung-once rule (ONE timed park per situation per phase) and
 * counted against the rung caps like any rung; `parkedMsOf` reads it through
 * `waitHistory` so the wait budget sees the time.
 */
export const LADDER_TIMED_PARK_MS = 30 * 60 * 1000;

/**
 * The session's own last words, when the situation was DECIDED from them
 * (RCV-7) — the one rule for both errand paths, the runner's `parkWithErrand`
 * and the healer's exhausted arm, which used to each carry a copy of the key
 * list and passed `said` on neither for two audits running (373 errands, 0
 * quoted). A classifier arm that read `record.said` or the runner's stamped
 * `cause` flags its answer `fromSaid`; the two keys named here are the arms'
 * answers for a `Situation` built without the flag (a preset, a record
 * classified by an older build). Anything else quotes nothing: `said` on an
 * errand is evidence, and a sign-off that decided nothing is not evidence.
 */
export function errandSaid(
  situation: { id: string; sub?: string; key: string; fromSaid?: boolean },
  said: string | null | undefined,
): string | undefined {
  if (!said?.trim()) return undefined;
  const decided = situation.fromSaid === true
    || (situation.id === 'never-started' && Boolean(situation.sub))
    || situation.key === 'resource-wall:auth';
  return decided ? said : undefined;
}

/**
 * Why a table could not be climbed on THIS console, rung by rung — the
 * sentence the errand's `how` gains when `nextRung` answered "no rung … is
 * available on this console yet" (RCV-7, phase 10). It used to answer for
 * three situations by name and the other refusals reached the journal and
 * never the person who could act: 33 of 41 such errands carried the table's
 * generic sentence. Every refusal now carries its reason
 * (`Service.rungRefusals`), so the sentence names the vehicle and what is in
 * the way — a flag, a preference, a clock, an account, a missing ref.
 */
export function undrivableSentence(
  situationKeyOrId: string,
  refusals: readonly { rung: Rung; why: string }[],
): string | null {
  if (!refusals.length) return null;
  const parts = refusals.map(({ rung, why }) => `**${rung.label}** (${rung.vehicle}, ${drivableBy(rung.vehicle)}): ${why}`);
  return `No rung of ${situationKeyOrId}'s ladder can be driven here — ${parts.join('; ')}.`;
}

/* ------------------------------------------------------------------ *
 * Errands
 * ------------------------------------------------------------------ */

type Ask = { need: string; how: string };

/**
 * An ask with its place in the decision manifest (phase 11, ZTD-10): the row
 * that answers its class and the answer the console ships for that row —
 * `null` where the row has no shipped word (a free-text row: budgets, a
 * permission overlay). `keyedAsks()` derives both from the policy table at
 * load, so the table and the asks cannot drift, and `test/ladder.test.ts`
 * asserts every entry carries a key in the vocabulary.
 */
export type KeyedAsk = Ask & { decisionKey: string; defaultAnswer: string | null };

/** What a person is asked for, per situation — the one card, in words a stranger can act on. */
const ASKS: Readonly<Record<string, Ask>> = Object.freeze({
  'superseded': {
    need: 'Nothing — the board reads this phase done.',
    how: 'If the record still shows otherwise, press Re-check; the run reconciles on its next tick anyway.',
  },
  'qa-failed': {
    need: 'A QA verdict of pass or waived for this phase — the recorded fail holds every dependent.',
    how: 'Press **Fix & re-QA** on the phase to run the fix-and-review loop again with settings of its own, '
      + '**Re-run QA** to review again without a fix session, or **Waive with a reason** to record `waived`.',
  },
  'qa-pending': {
    need: 'A QA verdict for this phase — the plan gates on QA and none is recorded.',
    how: 'Press **Re-run QA** on the phase to dispatch the review the gate is waiting for, or **Waive with a '
      + 'reason** to record `waived`. **Fix & re-QA** does both, when the phase needs work before it is reviewed.',
  },
  'foreign-live': {
    need: 'Nothing — another live session holds this phase; the autopilot waits for it.',
    how: 'If that session is dead, release its claim from the phase page (Force release) and the run queues in.',
  },
  'foreign-stale': {
    need: 'Permission to take over an expired claim over unfinished work.',
    how: 'Press Take over on the phase page, or release the claim and Retry.',
  },
  'waiting-external': {
    need: 'The external work the session declared it is waiting on to land.',
    how: 'Check the watch refs on the phase page; when they have landed, press Re-check (or Resume the session).',
  },
  'gated-manual': {
    need: 'A person to clear the manual gate — its numbered steps are on the Gate card.',
    how: 'Do the steps, then press Approve on the phase\'s Gate card (or run gate-approve.sh); the run retries the phase.',
  },
  'plan-broken': {
    // The fallback, for a plan-broken errand written without the issue that
    // raised it. It deliberately does NOT prescribe validate.sh: this card was
    // written 50 times in the corpus for plans whose validate.sh was green, so
    // "make it pass validate.sh" was an instruction nobody could act on.
    need: 'The plan-health issue this phase stopped on — the health panel names it.',
    how: 'Open the plan, fix what the health panel reports (validate.sh is the lint half of it), then Retry — or press Repair with a new agent.',
  },
  'mcp-unavailable': {
    need: 'The named MCP server signed in and reachable, or a decision to run without it.',
    how: 'Sign the server in under Settings ▸ MCP, or press Continue without these servers on the run page.',
  },
  'resource-wall': {
    need: 'Headroom: an account with usage left, a sign-in, more budget, or a model that is not limited.',
    how: 'Register or sign in an account under Settings ▸ Accounts, raise the budget on the run page, or wait for the window shown on the meter.',
  },
  'resource-wall:usage': {
    need: 'An account whose usage window has room, or the current window to reopen.',
    how: 'Pick another account on the run page, or wait for the reset time the meter shows; the run continues by itself.',
  },
  'resource-wall:auth': {
    need: 'A signed-in Claude account for this run.',
    how: 'Run claude login for the machine account, or sign in a console profile under Settings ▸ Accounts, then Continue.',
  },
  'resource-wall:budget': {
    need: 'More budget — the run or phase has spent what it was allowed.',
    how: 'Raise the budget on the run page and press Continue.',
  },
  'resource-wall:model': {
    need: 'A model that is not rate-limited, or the first model\'s window to reopen.',
    how: 'Pick a model on the run page, or wait for the reset the meter shows.',
  },
  'blocked-declared': {
    need: 'What the session said it is blocked on — read its Outstanding section.',
    how: 'Clear the blocker, then Retry (or Resume the session with an instruction).',
  },
  'blocked-declared:lock': {
    need: 'The lock holder to finish or release — the phase queues behind it.',
    how: 'Nothing, usually; if the holder is dead, Force release on the phase page.',
  },
  'blocked-declared:credential': {
    need: 'The credential the session named and no session holds (a sign-in, a key, a token).',
    how: 'Provide it where the handoff says, then Resume the session with an instruction or Retry.',
  },
  'blocked-declared:permission': {
    need: "A tool the run's permission policy refused — the session named the act and the path it was denied.",
    how: "If the act is one you would let an unattended agent do, widen the policy for this plan (Settings ▸ Permissions, or the plan's autopilot.json) and Retry; otherwise do that step by hand, then Resume the session with an instruction. Never strike a deny rule to get a phase through.",
  },
  'blocked-declared:gate': {
    need: 'The approval or sign-off the session said it is waiting for.',
    how: 'Give it (or clear the gate), then Retry.',
  },
  'blocked-declared:external': {
    need: 'The external thing the session is waiting on (CI, a PR, a deploy window) to land.',
    how: 'Check its watch refs; when it has landed, Re-check or Retry.',
  },
  'blocked-declared:unknown': {
    need: 'A reading of the session\'s Outstanding section — the blocker it named fits no machine category and one unblock session did not clear it.',
    how: 'Clear what it names, then Resume the session with an instruction or Retry; or split the remaining work into a new phase.',
  },
  'verify-red': {
    need: 'The phase\'s §Verification to pass — the ladder\'s sessions could not make it green.',
    how: 'Read What failed on the phase page, fix it (or fix the verification command if it is wrong), then Re-check or Retry.',
  },
  'done-unrecorded': {
    need: 'A complete handoff for work that verifies green.',
    how: 'Run new-handoff.sh for the phase and commit it, or Resume the session and ask it to close out.',
  },
  'work-in-progress': {
    need: 'Someone to finish the phase — the ladder\'s sessions did not carry it to its exit criteria.',
    how: 'Resume the session with an instruction, or boot the phase by hand from its boot prompt; commit and hand off when done.',
  },
  'never-started': {
    need: 'The phase to be run — it never started and the ladder could not board it.',
    how: 'Press Retry, or boot it by hand from its boot prompt.',
  },
  'never-started:refusal': {
    need: 'A person to read what the model refused, and decide what to do about the phase.',
    how: 'Open the phase\'s evidence — the refusal text is quoted there verbatim. Re-boarding gets the same answer to the same prompt, so change what is asked (the plan\'s wording, the phase\'s scope) or run it by hand.',
  },
  'never-started:skill-missing': {
    need: 'The skill the boot prompt invokes to load on THIS machine — the CLI answered "Unknown command".',
    how: 'Check the install: `claude` sees the skill (`/phased-execution` resolves), and Settings ▸ Automation ▸ skills names one that exists. `phase-console install-skill` re-links it. This is an environment fault, not a phase fault — the next attempt runs the same broken install.',
  },
  'unknown': {
    need: 'A person to read the evidence — it fits no situation the autopilot knows.',
    how: 'Open Why is this not done? on the phase page; act on what it shows, then Retry or Re-check — and file the shape so the classifier learns it.',
  },
});

/**
 * The errand for a situation once its rungs are spent (or at once, for a
 * person's). `tried` is the list of rung labels already climbed, so nobody
 * repeats them by hand. Every situation in `SITUATIONS` has a non-empty
 * `need` and `how` — `test/ladder.test.ts` walks the whole list.
 */
/**
 * The health issue that raised a `plan-broken` situation, so the errand can
 * quote it. Optional everywhere: an errand written without one falls back to
 * the table's sentence.
 */
export type PlanIssue = { kind?: string; detail?: string; validateOk?: boolean };

/**
 * The QA rounds behind a `qa-failed` errand, so the ask can name the report a
 * person must actually open.
 *
 * The static ask says "fix what the QA report names" — which report was left
 * as an exercise, and after three rounds there are three of them with only the
 * newest still describing the code. Optional everywhere: an errand written
 * without it falls back to the table's sentence.
 */
export type QaContext = { rounds?: number; max?: number; report?: string };

/** How a rung reads on a card. */
const rungLabel = (t: RungRecord | string): string =>
  (typeof t === 'string' ? t : `${t.rung}${t.params?.mode ? ` (${t.params.mode})` : ''}${t.outcome ? ` → ${t.outcome}` : ''}`);

/**
 * Every ask with its decision key and shipped answer — the table `ASKS` keeps
 * private, read through the policy table (one source for "which row answers
 * this situation"). Exported for the tests and the editor; the runner reads
 * `errandFor`.
 */
export function keyedAsks(): Readonly<Record<string, KeyedAsk>> {
  const out: Record<string, KeyedAsk> = {};
  for (const [key, ask] of Object.entries(ASKS)) {
    const decisionKey = decisionKeyOfSituation(key);
    out[key] = { ...ask, decisionKey, defaultAnswer: POLICY_DEFAULTS[decisionKey] ?? null };
  }
  return Object.freeze(out);
}

export { policyAnsweredPayload, policyRowOf };

export function errandFor(
  situationKeyOrId: string,
  tried: readonly (RungRecord | string)[] = [],
  phase = 0,
  at = new Date().toISOString(),
  said?: string | null,
  issue?: PlanIssue | null,
  qa?: QaContext | null,
  /**
   * The console's own denial for a permission wall (`PhaseRecord.toolDenied`,
   * phase 9): the errand names the RULE and the COMMAND verbatim, because the
   * table's fixed sentence cannot say which line stopped which call (LFC-3).
   */
  denied?: { tool: string; rule: string; command?: string } | null,
  /**
   * The answer in force for this situation's decision key
   * (`shared/policy-model.js` `resolvePolicy`), when the caller resolved one.
   * An AUTOMATIC answer for the class (`isAutomaticAnswer`) marks the errand
   * `policy` — the caller then journals `phase.policy-answered` and raises no
   * card. A pinned class (`blocked-declared:unknown`) ignores it. Absent, the
   * errand is a person's, as it always was.
   */
  policy?: ResolvedPolicy | null,
): Errand {
  const { id, sub } = parseSituationKey(situationKeyOrId);
  const key = situationKey(id, sub);
  const ask = ASKS[key] ?? ASKS[id] ?? ASKS.unknown;
  const decisionKey = decisionKeyOfSituation(key);
  const answered = policy && policy.decisionKey === decisionKey && isAutomaticAnswer(key, policy.answer)
    ? { answer: policy.answer, source: policy.source }
    : null;
  // This situation's rungs, and everything else this phase climbed for some
  // OTHER situation (R11). A string entry names no situation — it comes from a
  // caller that already flattened its history — so it stays where it was.
  const mine: string[] = [];
  const earlier: string[] = [];
  for (const t of tried) {
    const own = typeof t === 'string' || t.situation === key || !t.situation;
    (own ? mine : earlier).push(rungLabel(t));
  }
  // A plan-broken card quotes the issue that raised it, and reports the lint
  // verdict as EVIDENCE rather than as the ask.
  const composed = id === 'plan-broken' && issue
    ? {
      need: `The plan-health issue this phase stopped on: ${issue.kind || sub || 'unknown'}`
        + (issue.detail ? ` — ${issue.detail.replace(/\s+/g, ' ').slice(0, 240)}` : '')
        + '.',
      how: (issue.validateOk === true
        ? 'validate.sh is GREEN, so this is not a lint — fix what the health panel names'
        : issue.validateOk === false
          ? 'validate.sh is RED — fix what it reports'
          : 'Check the health panel and validate.sh')
        + ', then Retry — or press Repair with a new agent.',
    }
    // A spent QA budget is a different ask from a single recorded fail: the
    // run has stopped chasing, and the person needs to know how many rounds
    // went by and WHICH report describes the code as it stands.
    : id === 'qa-failed' && qa?.report
      ? {
        need: qa.rounds && qa.max && qa.rounds >= qa.max
          ? `QA has failed ${qa.rounds} of the ${qa.max} rounds this run allows on a phase, so it has `
            + 'stopped asking. The recorded fail holds every dependent.'
          : ask.need,
        // The VERBS by name, since Phase 9. The errand used to end at "run QA
        // again from the phase page", which named a launcher that starts a
        // review and no way to start the FIX the report is asking for — so the
        // one thing the operator most often wants was the one thing the errand
        // could not say. It still launches nothing by itself: an exhausted
        // budget is the run declining to spend more, and re-arming it is a
        // decision with a price, so it is offered rather than taken.
        how: `Read the latest QA report (${qa.report}) and press **Fix & re-QA** on the phase, which runs `
          + 'the fix-and-review loop again with settings and a round budget of its own. **Re-run QA** '
          + 'reviews again without a fix session, for a verdict that failed on the environment rather '
          + 'than the work; **Waive with a reason** records `waived` for a finding that does not apply. '
          + 'By hand: `bash scripts/qa-record.sh <slug> <phase> <pass|fail|waived> --report <path> '
          + '--round <n>`.',
      }
      // A permission wall the console itself recorded quotes the rule and the
      // command — what a person widens or does by hand is THAT line, not "a
      // tool".
      : key === 'blocked-declared:permission' && denied?.rule
        ? {
          need: `The run's permission policy refused ${denied.tool}`
            + (denied.command ? ` \`${denied.command.replace(/\s+/g, ' ').slice(0, 200)}\`` : '')
            + ` under the rule \`${denied.rule}\`.`,
          how: `Approve the "widen" card to strike \`${denied.rule}\` for this plan and resume the session `
            + '(Settings ▸ Permissions shows and reverses the strike), or do that step by hand and Resume the '
            + 'session with an instruction. A deny rule struck here is struck for every future run of this plan.',
        }
        : ask;
  return {
    phase,
    situation: key,
    decisionKey,
    ...(answered ? { policy: answered } : {}),
    tried: mine,
    ...(earlier.length ? { earlier } : {}),
    need: composed.need,
    how: composed.how,
    at,
    // Verbatim, trimmed of runs of whitespace and nothing else: the point of
    // quoting a refusal is that the operator reads what the model actually
    // said, not a paraphrase of it.
    ...(said?.trim() ? { said: said.replace(/\s+/g, ' ').slice(0, 600) } : {}),
  };
}

/**
 * The approval card the `widen-rule` rung offers (phase 9, TRS-10/LFC-3) —
 * one shape for both drivers (the runner's in-loop climb and the healer on a
 * stopped run). `kind: 'tool'` on purpose: the card the client already
 * renders shows the command, seeds the rule field from `suggestedRule`, and
 * answers through the same route; what differs is the SENTENCE, which says
 * what approving does and what denying leaves.
 */
export function widenCard(input: {
  runId: string; slug: string; phase: number;
  denied: { tool: string; rule: string; command?: string; at: string };
}): {
  runId: string; slug: string; phase: number; kind: 'tool'; title: string; detail: string;
  evidence: { label: string; body: string }[]; tool: { name: string; input: unknown }; suggestedRule: string;
} {
  const { denied } = input;
  return {
    runId: input.runId,
    slug: input.slug,
    phase: input.phase,
    kind: 'tool',
    title: `Phase ${input.phase}: widen \`${denied.rule}\`?`,
    detail: `The run's permission policy refused ${denied.tool}${denied.command ? ` \`${denied.command.slice(0, 160)}\`` : ''} `
      + `under the deny rule \`${denied.rule}\`, and the session declared itself blocked on it. `
      + `Approving strikes that ONE rule for this plan (recorded under Settings ▸ Permissions, reversible there) and `
      + 'resumes the phase\'s own session with the command to re-run. Denying leaves the phase parked with an errand — '
      + 'do the step by hand, then resume the session. Nothing spends until you answer.',
    evidence: [
      { label: 'The rule', body: denied.rule },
      ...(denied.command ? [{ label: 'The command it stopped', body: denied.command }] : []),
      { label: 'Refused at', body: denied.at },
    ],
    tool: { name: denied.tool, input: denied.command ? { command: denied.command } : {} },
    suggestedRule: denied.rule,
  };
}

/** The instruction the resumed session reads once its rule was widened. */
export function widenInstruction(denied: { rule: string; command?: string }): string {
  return `The deny rule \`${denied.rule}\` was struck for this plan by a person, so the call it refused is allowed now. `
    + `${denied.command ? `Re-run \`${denied.command.slice(0, 200)}\` and continue the phase` : 'Retry the refused call and continue the phase'} `
    + 'from where it stopped; do not declare blocked on that rule again.';
}

/* ------------------------------------------------------------------ *
 * Standing errands, and the one extension
 * ------------------------------------------------------------------ */

/**
 * Is `next` the errand `standing` already asks for?
 *
 * The healer, the convergence loop and the watch clock each re-derive a
 * phase's errand on every pass, and every pass wrote it again with a fresh
 * `at`. Measured across the journal corpus: one manual gate written 51 times
 * in a day, one declared blocker 16 times in five hours — and
 * `announceErrand`'s dedupe key carries `at`, so each rewrite was a new push
 * to a person who had already been asked. An errand is a standing ask, not an
 * event: when nothing a person would read has changed, the one on the record
 * stands and keeps its original `at` (the inbox's "since", the announcement's
 * key). `at` is excluded because it is the clock; `said` because it rides a
 * zero-turn exit and is quoted with the errand it arrived on.
 */
export function sameErrand(standing: Errand | null | undefined, next: Errand): boolean {
  if (!standing) return false;
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
    (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((t, i) => t === b?.[i]);
  return standing.phase === next.phase
    && standing.situation === next.situation
    && standing.need === next.need
    && standing.how === next.how
    && same(standing.tried, next.tried)
    && same(standing.earlier, next.earlier);
}

/** The one extension a phase's ladder may be granted (`ladderExtendOnProgress`). */
export type LadderExtension = {
  at: string;
  /** Commits that landed since the rung the count starts from began. */
  commits: number;
  /** `at` of the newest settled rung — where the commits are counted from. */
  since: string;
  situation: string;
};

/**
 * One more rung when the last one moved the work — the `ladderExtendOnProgress`
 * preference, off by default.
 *
 * The per-phase RUNG cap counts tries, and a try that landed commits is not the
 * same as a try that changed nothing: measured, fourteen `work-in-progress`
 * errands were written for phases whose sessions were still committing when
 * the count ran out. Granted at most ONCE per phase, only against the rung
 * count (a spent DOLLAR cap stands — money that was spent was spent), and only
 * when the caller measured progress since the last settled rung. Answers the
 * widened caps, or null when nothing applies; the caller records the grant on
 * the slot (`extended`) and journals it, so the next pass cannot grant it twice.
 */
export function progressExtension(
  next: NextRung,
  slot: Pick<RecoverySlot, 'extended'> | null | undefined,
  caps: LadderCaps,
  progressed: boolean,
  enabled: boolean,
): Partial<LadderCaps> | null {
  if (!enabled || !progressed || next.ok || !next.exhausted || slot?.extended) return null;
  // The structured cap, not the sentence: only the per-phase RUNG count widens.
  if (next.cap !== 'phase-rungs') return null;
  return { perPhaseRungs: caps.perPhaseRungs + 1 };
}

/** The newest rung that actually ran and ended — where a progress measurement counts from. */
export function lastSettledRung(slot: Pick<RecoverySlot, 'rungs'> | null | undefined): RungRecord | null {
  return [...(slot?.rungs ?? [])].reverse()
    .find((r) => Boolean(r.outcome) && r.outcome !== 'running' && r.outcome !== 'interrupted') ?? null;
}

export { SITUATIONS, SITUATION_ACTOR, situationKey, situationLabel, parseSituationKey };
