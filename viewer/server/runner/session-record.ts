/**
 * The session ledger: ONE record per `claude -p` session, of one shape, and the
 * two caps every session carries with the policy that set each of them.
 *
 * Zero-touch-console phase 4 (the sep-review audit's chapter 03). Three defects
 * met here, and each was a question the journal could not answer:
 *
 *   **What did it cost?** The CLI books a session's turns and dollars on its
 *   `result` message and nowhere else, and every ending the console caused was
 *   a SIGTERM, which writes no `result`. In the audit's six plans 27 of 88
 *   `phase.session` records read 0 turns and $0 for 18.99 hours of work.
 *   `spawn.ts` now asks the turn to close first (SIGINT) and keeps what the
 *   stream already said — the assistant turns it saw, the last cost reported —
 *   and every record names who ended it (`endedBy`).
 *
 *   **Which sessions ran at all?** Two spawn sites wrote this record; the
 *   resume site wrote three fields under another name and four sites wrote
 *   nothing, so 50 of the 138 sessions those plans spawned were invisible to
 *   every census built on `phase.session`. `RunnerBase.spawnSession` is now the
 *   one door every site goes through, and the door writes the record.
 *
 *   **What bounded it?** No session that did a phase's work carried
 *   `--max-turns` or `--max-budget-usd`: 0 of 507 lifetime argvs carried a
 *   dollar cap. Every spawn now carries both, and the record says which policy
 *   set each (`CAP_SOURCES`), so a spent cap is distinguishable from a crash.
 *
 * This module is a leaf on purpose — `shared/` and type-only imports — so
 * `spawn.ts` can read its defaults without an import cycle through the runner.
 */

import type { CapSource, EndedBy, SessionMode } from '../../shared/run-lifecycle.js';
import { PERMISSION_PROMPTS_CLI_FLOOR, RELAY_CLI_FLOOR, versionAtLeast, type RelayMode } from '../../shared/run-settings.js';
import { PHASE_WORK_MODES, addSessionWindow, phaseClocks } from '../../shared/phase-clocks.js';
import type { SpawnOutcome, SpawnRequest } from './spawn.ts';
import { isTransportFailure } from './errors.ts';

/**
 * How a measured cap was read (control-tower phase 59, #83 SIZ-5): the
 * percentile of which sessions, over which window, and the headroom above it —
 * on every `phase.session` that ran under it, so drift is visible in the ledger
 * rather than discovered when a cap bites. `basis` says whose sessions: this
 * console's own, or the table shipped with the release (measured the same way,
 * on the machine that cut it).
 */
export type CapDerivation = {
  basis: 'this-console' | 'shipped';
  /** 0.99 — the percentile read. */
  percentile: number;
  /** 0.5 — the share added above it. */
  headroom: number;
  /** Sessions of the mode in the window. */
  samples: number;
  /** The window: the oldest and newest session read. */
  from: string | null;
  to: string | null;
  /** The percentile's value — turns, or dollars — before the headroom and the rounding. */
  observed: number;
};

/** One cap and where it came from. `basis` is the arithmetic, in words, when there was any. */
export type Cap = { value: number; source: CapSource; basis?: string; derivation?: CapDerivation };

/** The two caps a session runs under. */
export type SessionCaps = { maxTurns: Cap; maxBudgetUsd: Cap };

/**
 * A closeout is paperwork: verify, commit, write the handoff, update the index.
 * Generous enough for a phase whose verification is a full suite, tight enough
 * that a session which misreads the ask and starts coding again runs out.
 */
export const CLOSEOUT_MAX_TURNS = 60;

/**
 * A repair is a bounded errand, not a phase: read the situation, do the one
 * thing, declare an outcome. Longer than a closeout because a `fix-agent` may
 * legitimately have to run a suite; far shorter than a phase, so a session that
 * misreads the ask and starts building runs out rather than running on.
 */
export const REPAIR_MAX_TURNS = 90;

/**
 * The fewest turns a session that CONTINUES a phase's work is given — a resume
 * with an instruction, a wait-resume (control-tower phase 46, #61). Such a
 * session gets what is left of the phase's size row; this floor is for a phase
 * that has already spent most of it, and it is measured, not chosen: the audit
 * week's 22 continuation stints (a resume, plus whatever directly continued it
 * after a spent cap) ran p50 37, p90 83, p95 98 and at most 107 turns. 120 is
 * that p90 with 45 % headroom, above the longest stint seen, and twice the
 * closeout cap 4 of the week's 5 `max_turns` endings were cut at. It floors a
 * PER-PROMPT cap — the CLI enforces `--max-turns` per prompt (control-tower
 * phase 89, #62's SIZ-7) — so the resumes' measured cap that can raise it is
 * calibrated on each session's largest prompt (`capTurns`), never its sum; the
 * stints above were sums, which only makes the floor the more generous.
 */
export const RESUME_MIN_TURNS = 120;

/* ---- the caps, measured (control-tower phase 59, #83 SIZ-5) ---- */

/**
 * A measured cap is the mode's p99 plus half again. A cap exists to bound a
 * RUNAWAY — it must never bind on routine work, and the p90 is routine work.
 * The per-size table this replaced was "about three times the most any
 * measured session spent" ($41.14 over 213 turns): within a week 47 of 152
 * fresh phase sessions spent more than that premise, M's $60 sat below the
 * observed maximum, M ran at p90 0.84 of its turns and 0.86 of its dollars —
 * one binding at 301/300 — while L never passed 0.70 of either. And the tag
 * did not separate the two: at p90, L used 264 turns and $50.4, M 252 and
 * $51.6. So the caps no longer read the size tag at all.
 */
export const CAP_PERCENTILE = 0.99;
export const CAP_HEADROOM = 0.5;

/** The fewest sessions of a mode in the window before its own p99 stands; below it, the shipped table. */
export const CAP_MIN_SAMPLES = 20;

/** How far back a measured cap reads — two weeks of sessions, re-derived as they accrue. */
export const CAP_WINDOW_MS = 14 * 86_400_000;

/** One mode's measured caps: its turns, and — for the phase's own work — its dollars. */
export type ModeCaps = { turns?: Cap; usd?: Cap };

/** The caps a console measured, by mode; a mode it has not measured takes the shipped table's. */
export type CapTable = { modes: Partial<Record<SessionMode, ModeCaps>>; derivedAt: string | null };

const shippedDerivation = (samples: number, observed: number): CapDerivation => ({
  basis: 'shipped', percentile: CAP_PERCENTILE, headroom: CAP_HEADROOM, samples,
  from: '2026-09-16', to: '2026-09-25', observed,
});

/**
 * The caps shipped with the release — measured, not chosen: `deriveCapTable`
 * over every `phase.session` of the session-ledger shape on this machine's two
 * consoles, 2026-09-16 → 2026-09-25 (`test/fixtures/sizing/sessions-corpus.json`,
 * which `test/sizing-model.test.ts` re-derives them from). A phase session: p99
 * 322 turns over 321 (max 421), and p99 $77.81 over the 274 with a per-spawn
 * figure (max $120.16). A resume: p99 74 turns over 27, so its measured cap is
 * `RESUME_MIN_TURNS` itself. No other mode had twenty sessions, so each keeps
 * its constant. The two consoles alone would have read 490/$115 and 470/$125.
 */
export const SHIPPED_CAP_TABLE: CapTable = Object.freeze({
  modes: Object.freeze({
    phase: Object.freeze({
      turns: Object.freeze({
        value: 490, source: 'measured', basis: 'p99 322 turns + 50 % — 321 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
        derivation: shippedDerivation(321, 322),
      }) as Cap,
      usd: Object.freeze({
        value: 120, source: 'measured', basis: 'p99 $77.81 + 50 % — 274 phase sessions, 2026-09-16 → 2026-09-25 (shipped)',
        derivation: shippedDerivation(274, 77.81),
      }) as Cap,
    }),
    resume: Object.freeze({
      turns: Object.freeze({
        value: 120, source: 'measured', basis: 'p99 74 turns + 50 % — 27 resume sessions, 2026-09-18 → 2026-09-25 (shipped)',
        derivation: { ...shippedDerivation(27, 73.58), from: '2026-09-18' },
      }) as Cap,
    }),
  }),
  derivedAt: null,
}) as CapTable;

/** Turns round up to ten, dollars to five: a cap is read by a person, and nobody reads $114.89 as a decision. */
const roundTurns = (n: number): number => Math.ceil(n / 10) * 10;
const roundUsd = (n: number): number => Math.ceil(n / 5) * 5;

/**
 * One `phase.session` line as the cap derivation reads it. `promptTurns` is
 * the session's largest one prompt (control-tower phase 89); absent on a line
 * written before it, which leaves `turns` the only figure there is.
 */
export type CapSample = {
  mode?: string; at?: string; turns?: number; promptTurns?: number; costUsd?: number; bookedUsd?: number; costSource?: string;
  resumed?: boolean;
};

/** p(`CAP_PERCENTILE`) of `values`, by linear interpolation between order statistics. */
function p99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * CAP_PERCENTILE;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo);
}

/**
 * The per-spawn dollars a line measured: what the console booked for it
 * (`bookedUsd`, control-tower phase 46), else the CLI's reported total for a
 * session that continued nothing — a resumed spawn's total is the whole
 * conversation's (#62) and measures nothing about that spawn.
 */
function spawnUsd(line: CapSample): number | null {
  if (typeof line.bookedUsd === 'number' && Number.isFinite(line.bookedUsd)) return line.bookedUsd;
  if (line.resumed === true || line.costSource === 'none') return null;
  return typeof line.costUsd === 'number' && Number.isFinite(line.costUsd) ? line.costUsd : null;
}

/**
 * The turns a line measured against a turn cap (control-tower phase 89, #62's
 * SIZ-7): its largest one prompt when it carries one, because the CLI enforces
 * `--max-turns` per prompt — a session woken three times summed its prompts
 * past its cap and never neared it in any one — else `turns`, which on a line
 * written before the field existed is the only figure there is.
 */
function capTurns(line: CapSample): number | null {
  if (typeof line.promptTurns === 'number' && Number.isFinite(line.promptTurns) && line.promptTurns > 0) return line.promptTurns;
  return typeof line.turns === 'number' && Number.isFinite(line.turns) ? line.turns : null;
}

/**
 * Derive a console's caps from its own `phase.session` lines (SM-4): per mode,
 * the p99 of the window's turns (and, for the phase's own sessions, its
 * per-spawn dollars) plus `CAP_HEADROOM`, rounded up — a mode with fewer than
 * `CAP_MIN_SAMPLES` sessions in the window is left out, and takes the shipped
 * table's cap. Each cap carries its derivation. Pure: the caller reads the
 * journals and the clock.
 *
 * The turns sampled are each session's largest PROMPT (`capTurns`, control-
 * tower phase 89): the phase's row and the resumes' measured floor
 * (`remainingTurns`) are both per-prompt caps, so they are calibrated on the
 * per-prompt figure, never on a woken session's sum.
 */
export function deriveCapTable(lines: readonly CapSample[], nowMs: number): CapTable {
  const since = nowMs - CAP_WINDOW_MS;
  const byMode = new Map<string, CapSample[]>();
  for (const line of lines) {
    const at = line.at ? Date.parse(line.at) : Number.NaN;
    if (!line.mode || !Number.isFinite(at) || at < since || at > nowMs + 60_000) continue;
    byMode.set(line.mode, [...(byMode.get(line.mode) ?? []), line]);
  }
  const modes: CapTable['modes'] = {};
  const measure = (list: CapSample[], values: number[], round: (n: number) => number, unit: (n: number) => string, what: string): Cap | undefined => {
    if (values.length < CAP_MIN_SAMPLES) return undefined;
    const observed = p99(values);
    const times = list.map((l) => l.at!).sort();
    const derivation: CapDerivation = {
      basis: 'this-console', percentile: CAP_PERCENTILE, headroom: CAP_HEADROOM, samples: values.length,
      from: times[0] ?? null, to: times[times.length - 1] ?? null, observed: Math.round(observed * 100) / 100,
    };
    return {
      value: round(observed * (1 + CAP_HEADROOM)), source: 'measured',
      basis: `p99 ${unit(observed)} + ${Math.round(CAP_HEADROOM * 100)} % — ${values.length} ${what}, ${(derivation.from ?? '').slice(0, 10)} → ${(derivation.to ?? '').slice(0, 10)}`,
      derivation,
    };
  };
  for (const [mode, list] of byMode) {
    const what = `${mode} sessions on this console`;
    const turned = list.filter((l) => (capTurns(l) ?? 0) > 0);
    const turns = measure(turned, turned.map((l) => capTurns(l)!), roundTurns, (n) => `${Math.round(n)} turns`, what);
    let usd: Cap | undefined;
    if (mode === 'phase') {
      const spent = list.filter((l) => (spawnUsd(l) ?? 0) > 0);
      usd = measure(spent, spent.map((l) => spawnUsd(l)!), roundUsd, (n) => `$${n.toFixed(2)}`, what);
    }
    if (turns || usd) modes[mode as SessionMode] = { ...(turns ? { turns } : {}), ...(usd ? { usd } : {}) };
  }
  return { modes, derivedAt: new Date(nowMs).toISOString() };
}

/** The phase's own caps under a table: its measured turns and dollars, else the shipped ones. */
export function phaseCaps(table?: CapTable | null): { turns: Cap; usd: Cap } {
  const own = table?.modes.phase;
  const shipped = SHIPPED_CAP_TABLE.modes.phase!;
  return { turns: own?.turns ?? shipped.turns!, usd: own?.usd ?? shipped.usd! };
}

/**
 * The share of a phase's dollars a side session gets — a closeout, a repair, a
 * QA round, a PR session, the reviewer. A quarter, which is what every one of
 * those sites already spent of `phaseBudgetUsd` when a run set one.
 */
export const SIDE_SESSION_SHARE = 4;

/** What `spawn.ts` applies when a caller hands it no cap at all: the shipped phase caps, named as a floor. */
export const SPAWN_DEFAULT_CAPS: SessionCaps = Object.freeze({
  maxTurns: Object.freeze({ value: SHIPPED_CAP_TABLE.modes.phase!.turns!.value, source: 'spawn-default', basis: 'the shipped phase cap' }) as Cap,
  maxBudgetUsd: Object.freeze({ value: SHIPPED_CAP_TABLE.modes.phase!.usd!.value, source: 'spawn-default', basis: 'the shipped phase cap' }) as Cap,
});

/**
 * The turn cap of a session that CONTINUES the phase's work: the phase's turn
 * cap minus the turns its sessions already spent (`PhaseRecord.turns`), never
 * under the resume floor — `RESUME_MIN_TURNS`, or the resumes' own measured
 * cap when that is higher (control-tower phase 46, #61; phase 59). A resume
 * used to get the closeout's 60, sized for paperwork, while it did the phase's
 * work. `why` names the vehicle in the basis ("a wait-resume").
 */
export function remainingTurns(table: CapTable | null | undefined, spent: number | undefined, why?: string): Cap {
  const row = phaseCaps(table).turns.value;
  const measuredFloor = (table?.modes.resume?.turns ?? SHIPPED_CAP_TABLE.modes.resume?.turns)?.value ?? 0;
  const floor = Math.max(RESUME_MIN_TURNS, measuredFloor);
  const used = typeof spent === 'number' && Number.isFinite(spent) && spent > 0 ? Math.floor(spent) : 0;
  const left = row - used;
  const tail = why ? ` — ${why}` : '';
  if (left >= floor) return { value: left, source: 'remaining', basis: `phase ${row} − ${used} spent${tail}` };
  const named = floor === RESUME_MIN_TURNS ? `RESUME_MIN_TURNS ${RESUME_MIN_TURNS}` : `the resumes' measured ${floor}`;
  return { value: floor, source: 'remaining', basis: `phase ${row} − ${used} spent, floored at ${named}${tail}` };
}

/**
 * A side session's turn cap: its mode's measured p99 + headroom when that is
 * the larger, else the mode's constant. A paperwork session that has never run
 * long on this console still gets the room its brief was written for, so a
 * measurement can raise a side cap and never lower it.
 */
function sideTurns(table: CapTable | null | undefined, mode: SessionMode, constant: number, source: 'closeout' | 'repair'): Cap {
  const measured = table?.modes[mode]?.turns;
  if (measured && measured.value > constant) return measured;
  return { value: constant, source };
}

export type CapsInput = {
  mode: SessionMode;
  /** The run's own dollar cap per phase; null when it set none. */
  phaseBudgetUsd: number | null | undefined;
  /** The turns the phase's sessions have already spent — what a `resume` is capped by the rest of. */
  spentTurns?: number;
  /** A turn cap the caller already decided — a closeout brief's, a wait-resume's, a raise. Wins. */
  turns?: Cap;
  /** A dollar cap the caller already decided — a QA round's own budget. Wins. */
  usd?: Cap;
  /** The console's measured caps (`deriveCapTable`, re-derived as sessions accrue); the shipped table when absent. */
  table?: CapTable | null;
};

/**
 * The caps for one session. Dollars: a phase attempt and a resume get the
 * whole of `phaseBudgetUsd` (`run`) or the phase's measured dollars
 * (`measured`); every side session gets a quarter of the same, never under $1.
 * Turns: the phase's measured cap for a phase; for a resume, what is left of it
 * (`remainingTurns`); the mode's own cap for the rest — `REPAIR_MAX_TURNS` for a
 * repair, `CLOSEOUT_MAX_TURNS` for everything that is paperwork or a bounded
 * review (a closeout, a QA round, a landing, a PR or review session), each
 * raised by its own measurement when that is larger. `docs/session-budget.md`
 * states the same table, and `test/resume-caps.test.ts` holds the two together.
 */
export function capsFor(input: CapsInput): SessionCaps {
  const phase = phaseCaps(input.table);
  const whole = input.mode === 'phase' || input.mode === 'resume';
  const runBudget = typeof input.phaseBudgetUsd === 'number' && input.phaseBudgetUsd > 0 ? input.phaseBudgetUsd : null;

  let usd: Cap;
  if (input.usd) usd = input.usd;
  else if (runBudget !== null) {
    usd = whole
      ? { value: runBudget, source: 'run' }
      : { value: Math.max(1, runBudget / SIDE_SESSION_SHARE), source: 'run', basis: `phaseBudgetUsd ÷ ${SIDE_SESSION_SHARE}` };
  } else {
    usd = whole
      ? phase.usd
      : {
        value: Math.max(1, phase.usd.value / SIDE_SESSION_SHARE), source: 'measured',
        basis: `the phase's $${phase.usd.value} ÷ ${SIDE_SESSION_SHARE}`,
        ...(phase.usd.derivation ? { derivation: phase.usd.derivation } : {}),
      };
  }

  let turns: Cap;
  if (input.turns) turns = input.turns;
  else if (input.mode === 'repair') turns = sideTurns(input.table, 'repair', REPAIR_MAX_TURNS, 'repair');
  else if (input.mode === 'phase') turns = phase.turns;
  else if (input.mode === 'resume') turns = remainingTurns(input.table, input.spentTurns);
  else turns = sideTurns(input.table, input.mode, CLOSEOUT_MAX_TURNS, 'closeout');

  return { maxTurns: turns, maxBudgetUsd: usd };
}

/**
 * A cap the CLI reported spent, doubled for the resume that carries on.
 * Dollars never go under $1; the basis keeps the history readable.
 */
export function raiseCap(cap: Cap, why: string): Cap {
  const doubled = cap.value * 2;
  return {
    value: Math.max(1, doubled),
    source: 'raise',
    basis: `2 × ${cap.value} (${cap.source}${cap.basis ? `: ${cap.basis}` : ''}) — ${why}`,
  };
}

/**
 * The caps `spawn.ts` actually passes: the request's named caps, else a bare
 * number the caller handed in (`caller`), else the floor (`spawn-default`).
 */
export function resolveCaps(request: Pick<SpawnRequest, 'caps' | 'maxTurns' | 'budgetUsd'>): SessionCaps {
  const maxTurns: Cap = request.caps?.maxTurns
    ?? (typeof request.maxTurns === 'number' && request.maxTurns > 0
      ? { value: request.maxTurns, source: 'caller' }
      : SPAWN_DEFAULT_CAPS.maxTurns);
  const maxBudgetUsd: Cap = request.caps?.maxBudgetUsd
    ?? (typeof request.budgetUsd === 'number' && request.budgetUsd > 0
      ? { value: request.budgetUsd, source: 'caller' }
      : SPAWN_DEFAULT_CAPS.maxBudgetUsd);
  return { maxTurns, maxBudgetUsd };
}

/**
 * Whether one session of a run carries `--permission-prompts none` — the floor
 * for a run nobody can answer (zero-touch-console phase 13, QRL-9).
 *
 * A `relay: off` run carries it and a `last-resort` run does not: the relay is
 * the thing that answers a prompt, and the flag would take the prompt away
 * from it. The only refusal is a CLI KNOWN to predate the flag, which rejects
 * it with an unknown-option error. An UNKNOWN version still gets the flag, on
 * purpose: an old CLI then fails loudly at spawn, where leaving the flag off
 * would drop the floor with nobody told. A run with no relay answer reads as
 * `off`, which is what every run before 5.0.0 was.
 */
export function permissionPromptsFor(
  relay: RelayMode | null | undefined, version: string | null | undefined,
): { flag: 'none' | null; refused?: { reason: 'below-floor'; version: string; floor: string } } {
  if (relay === 'last-resort') return { flag: null };
  if (version && versionAtLeast(version, PERMISSION_PROMPTS_CLI_FLOOR) === false) {
    return { flag: null, refused: { reason: 'below-floor', version, floor: PERMISSION_PROMPTS_CLI_FLOOR } };
  }
  return { flag: 'none' };
}

/**
 * Whether the relay arms for a session of this run (zero-touch-console phase
 * 14, QRL-5, AC-13): only on a `relay: last-resort` run, and only when the CLI
 * read at or above `RELAY_CLI_FLOOR` — the first release whose
 * `PermissionRequest` hook fires in `--print` — FROM `system/init`'s
 * `claude_code_version` (`version`: the newest one any session on this console
 * reported; `server/cli-init.ts`). Never from `capabilities`, which names no
 * hook behaviour, and never on a version nobody has read: an unknown version
 * refuses (`version-unknown`), so the first session of a fresh console runs on
 * the floor and its own `system/init` arms the next. A refusal keeps the run on
 * the floor — `--permission-prompts none`, no host, no `PermissionRequest` hook
 * — and is journalled once per run as `run.relay-refused`.
 */
export function relayArmingFor(
  relay: RelayMode | null | undefined, version: string | null | undefined,
): { armed: boolean; version: string | null; floor: string; refused?: 'below-floor' | 'version-unknown' } {
  const read = version || null;
  if (relay !== 'last-resort') return { armed: false, version: read, floor: RELAY_CLI_FLOOR };
  if (!read) return { armed: false, version: null, floor: RELAY_CLI_FLOOR, refused: 'version-unknown' };
  if (versionAtLeast(read, RELAY_CLI_FLOOR) === false) {
    return { armed: false, version: read, floor: RELAY_CLI_FLOOR, refused: 'below-floor' };
  }
  return { armed: true, version: read, floor: RELAY_CLI_FLOOR };
}

/** Did the console end this session, rather than the session itself? */
export function consoleEnded(endedBy: EndedBy | string | null | undefined): boolean {
  return Boolean(endedBy) && endedBy !== 'exit';
}

/** The one shape of `phase.session`. */
export type SessionRecord = {
  mode: SessionMode;
  attempt?: number;
  /** The model the session was ASKED to run on — the request's word, an alias or an id. */
  model: string | null;
  /** The id its `system/init` frame reported — what the request resolved to (#91); null when it never said. */
  resolvedModel: string | null;
  effort: string | null;
  sessionId: string | null;
  /** The session continued an existing conversation (`--resume`). */
  resumed: boolean;
  subtype?: string;
  isError: boolean;
  terminalReason?: string;
  endedBy: EndedBy;
  endedReason?: string;
  /** Every prompt's turns, summed: the session's total. */
  turns: number;
  /** `result` — the CLI's own count; `stream` — the assistant turns the stream showed, for a turn that never closed. */
  turnsSource: 'result' | 'stream';
  /**
   * The largest one prompt's turns (control-tower phase 89, #62's SIZ-7) —
   * what `maxTurns` binds, since the CLI enforces the cap per prompt. Absent
   * only for an outcome that predates it (a test's fake spawn).
   */
  promptTurns?: number;
  /** What the CLI REPORTED: its running total for the conversation, which a `--resume` carries forward. */
  costUsd: number;
  /** `none` — no `total_cost_usd` ever arrived, so `costUsd` is unknown rather than zero. */
  costSource: 'result' | 'stream' | 'none';
  /** What the console BOOKED for this spawn — the total less the session's high-water mark (`bookSpend`). */
  bookedUsd?: number;
  ms: number;
  argv: string[];
  /** The session's last words (`lastWords`): its result, or its own last prose when the result was the network's. */
  said: string;
  /** The CLI's could-not-reach-the-API sentence, when that was the result `said` was kept from (#108). */
  transportError?: string;
  injected?: number;
  maxTurns: Cap;
  maxBudgetUsd: Cap;
  /** How many tool calls the CLI's own permission system denied (`result.permission_denials`). */
  permissionDenials: number;
};

/** A session's words as a record keeps them: whitespace folded, bounded. */
export function condenseWords(text: string | undefined | null): string {
  return (text ?? '').replace(/\s+/g, ' ').slice(0, 1_200);
}

/**
 * What a session is remembered as having said (control-tower phase 80, #108).
 *
 * Its `result` text — except when that text is the CLI saying it could not
 * reach the API. Then the session did not say it; the network did, and the
 * words worth keeping are the session's own last prose before it (`lastText`).
 * Measured: four lanes of one outage each recorded "API Error: Unable to …" as
 * the attempt's summary, so the one account of what a session had been doing
 * when it was cut off was the one thing it never wrote. The transport error is
 * kept beside the words, named, rather than lost. A session that wrote no prose
 * of its own is remembered as saying nothing — an empty `said`, never the
 * error; the phase record then keeps what an earlier attempt said.
 */
export function lastWords(outcome: Pick<SpawnOutcome, 'resultText' | 'lastText'>): { said: string; transportError?: string } {
  const result = condenseWords(outcome.resultText);
  if (!isTransportFailure(result)) return { said: result };
  const own = isTransportFailure(outcome.lastText) ? '' : condenseWords(outcome.lastText);
  return { said: own, transportError: result };
}

/**
 * Build the record for one session. Tolerant of an outcome that predates the
 * ledger's fields — a test's fake spawn — so a missing field reads as the
 * honest default (`exit`, `result`, the request's caps) rather than as a crash.
 */
export function sessionRecordOf(input: {
  mode: SessionMode; request: SpawnRequest; outcome: SpawnOutcome; attempt?: number;
}): SessionRecord {
  const { outcome, request } = input;
  const caps = outcome.caps ?? resolveCaps(request);
  const signal = outcome.signal ?? {};
  return {
    mode: input.mode,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    model: request.model ?? null,
    resolvedModel: outcome.resolvedModel ?? null,
    effort: request.effort ?? null,
    sessionId: outcome.sessionId ?? null,
    resumed: Boolean(request.resume),
    ...(signal.subtype ? { subtype: signal.subtype } : {}),
    isError: signal.isError === true,
    ...(signal.terminalReason ? { terminalReason: signal.terminalReason } : {}),
    endedBy: outcome.endedBy ?? 'exit',
    ...(outcome.endedReason ? { endedReason: outcome.endedReason } : {}),
    turns: outcome.turns ?? 0,
    turnsSource: outcome.turnsSource ?? 'result',
    ...(typeof outcome.promptTurns === 'number' ? { promptTurns: outcome.promptTurns } : {}),
    costUsd: outcome.costUsd ?? 0,
    costSource: outcome.costSource ?? (outcome.costUsd ? 'result' : 'none'),
    ...(typeof outcome.bookedUsd === 'number' ? { bookedUsd: outcome.bookedUsd } : {}),
    ms: outcome.durationMs ?? 0,
    argv: outcome.argv ?? [],
    ...lastWords(outcome),
    ...(outcome.injected ? { injected: outcome.injected } : {}),
    maxTurns: caps.maxTurns,
    maxBudgetUsd: caps.maxBudgetUsd,
    permissionDenials: signal.permissionDenials?.length ?? 0,
  };
}

/**
 * The ledger's defect, as a predicate: a record saying a session ran for more
 * than a minute, did no turn, and was ended by nobody in particular. Every
 * record the 4.1.0 console wrote for a session it SIGTERMed has this shape; no
 * record `sessionRecordOf` builds can, because it always names an ending.
 */
export function sessionLedgerDefect(payload: Record<string, unknown>): boolean {
  return payload.turns === 0 && Number(payload.ms) > 60_000 && !payload.endedBy;
}

/* ---- what a spawn cost (control-tower phase 46, #62) ---- */

/**
 * The cost model a run's dollars were booked under. `1` (absent on the file):
 * each spawn's reported `total_cost_usd` was added whole, so every `--resume`
 * re-booked the conversation's earlier spend — $531–631 of the audit week's
 * ledger. `2`: a spawn books its total less the session's high-water mark
 * (`bookedDelta`). A run born now is `2` from its first spawn (`newRun`); a
 * stored run is brought to `2` ONCE, at boot, from its own journal
 * (`repriceFromLedger`), and the stamp is what makes it once.
 */
export const COST_MODEL = 2;

/**
 * What one spawn of a session cost, given what the CLI reported and the
 * session's mark — the last total booked for it (`PhaseRecord.costHighWater`).
 *
 * From CLI 2.1.278 a `--resume` spawn's `total_cost_usd` is the conversation's
 * running total, so the spawn's own spend is the rise since the mark:
 * `max(0, total − mark)`. `known` is false when no total ever arrived
 * (`costSource: 'none'`): nothing is booked and the mark stays, because that
 * zero is ignorance, and a mark reset to it would re-book the whole
 * conversation at the next resume. A known total BELOW the mark is not the same
 * running counter — a CLI that reports each spawn's own cost, or a count that
 * restarted — so it is booked whole and becomes the mark (`restarted`).
 */
export function bookedDelta(
  mark: number | undefined, total: number, known: boolean,
): { booked: number; mark: number; restarted: boolean } {
  const previous = typeof mark === 'number' && Number.isFinite(mark) && mark > 0 ? mark : 0;
  if (!known || !Number.isFinite(total) || total <= 0) return { booked: 0, mark: previous, restarted: false };
  if (total < previous) return { booked: total, mark: total, restarted: true };
  return { booked: total - previous, mark: total, restarted: false };
}

/**
 * The part of a spawn's booked spend that ran ON CREDIT (control-tower phase
 * 93, #146): the running total's rise past the point the session first
 * reported `isUsingOverage` (`from`, the total at that moment) — or past the
 * session's mark, when the conversation went on credit before this spawn
 * resumed it — capped at what the spawn booked. Zero when it never did.
 */
export function creditBooked(from: number | undefined, mark: number, total: number, booked: number): number {
  if (typeof from !== 'number' || !Number.isFinite(from) || !(booked > 0)) return 0;
  const start = Math.max(from, mark > 0 && total >= mark ? mark : 0);
  return Math.min(booked, Math.max(0, total - start));
}

/** The newest session marks a phase record keeps; a phase runs a handful of conversations. */
export const MAX_COST_MARKS = 32;

/** A `phase.session` line as the re-price reads it off a run's journal. */
export type LedgerLine = { event: string; phase?: number; time?: string; data?: Record<string, unknown> };

/** The slice of a stored run the re-price rewrites — structural, so this module stays a leaf. */
export type RepriceTarget = {
  costModel?: number;
  spentUsd: number;
  phases: Record<string, { costUsd: number; costHighWater?: Record<string, number> } | undefined>;
};

export type RepriceResult = {
  /** `spentUsd` before and after. */
  before: number;
  after: number;
  /** The phases whose figure moved. */
  phases: Record<string, { before: number; after: number }>;
  /** `phase.session` lines that carried a reported total. */
  sessions: number;
};

const dollars = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Bring a stored run to `COST_MODEL` from its own journal (CC-6, CC-7).
 *
 * Every `phase.session` line is walked in order and booked the way a spawn is
 * booked now; at the time, the run booked the whole reported total. The
 * difference is the re-reported part, and it — only it — comes off the phase
 * and the run: money no line explains (a run older than the session ledger, a
 * journal cut short) is never taken away, and no figure goes below zero. Each
 * session's last mark is seeded on its phase, so resuming a stored run's session
 * books against it. Null for a run already at the model: the stamp is written
 * in the same pass, which is the whole of "never twice".
 */
export function repriceFromLedger(state: RepriceTarget, lines: readonly LedgerLine[]): RepriceResult | null {
  if ((state.costModel ?? 1) >= COST_MODEL) return null;
  const before = dollars(state.spentUsd);
  const marks = new Map<string, Map<string, number>>();
  const rereported = new Map<string, number>();
  let sessions = 0;
  for (const line of lines) {
    if (line.event !== 'phase.session' || typeof line.phase !== 'number') continue;
    const data = line.data ?? {};
    const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null;
    const reported = Number(data.costUsd);
    if (!sessionId || data.costSource === 'none' || !Number.isFinite(reported) || reported <= 0) continue;
    const key = String(line.phase);
    const own = marks.get(key) ?? new Map<string, number>();
    marks.set(key, own);
    const booked = bookedDelta(own.get(sessionId), reported, true);
    own.set(sessionId, booked.mark);
    rereported.set(key, (rereported.get(key) ?? 0) + (reported - booked.booked));
    sessions += 1;
  }
  const phases: RepriceResult['phases'] = {};
  let removed = 0;
  for (const [key, own] of marks) {
    const record = state.phases[key];
    if (!record) continue;
    const was = dollars(record.costUsd);
    const take = Math.min(was, rereported.get(key) ?? 0);
    if (take > 1e-9) {
      record.costUsd = was - take;
      phases[key] = { before: was, after: record.costUsd };
      removed += take;
    }
    const seeded = { ...(record.costHighWater ?? {}), ...Object.fromEntries(own) };
    record.costHighWater = Object.fromEntries(Object.entries(seeded).slice(-MAX_COST_MARKS));
  }
  state.spentUsd = Math.max(0, before - removed);
  state.costModel = COST_MODEL;
  return { before, after: state.spentUsd, phases, sessions };
}

/**
 * The clock model a run's phase windows were kept under (control-tower phase
 * 58, #66). `1` (absent): only a phase's own attempts opened a window, so a
 * resume, repair, QA round, closeout, landing or review worked the phase and
 * left no time behind. `2`: every session that works the phase opens one at the
 * spawn door. See `RunState.clockModel`.
 */
export const CLOCK_MODEL = 2;

/** The slice of a stored run the re-measure rewrites — structural, like `RepriceTarget`. */
export type RemeasureTarget = {
  clockModel?: number;
  phases: Record<string, Record<string, unknown> | undefined>;
};

export type RemeasureResult = {
  /** Worked ms before and after, for the phases whose figure moved. */
  phases: Record<string, { before: number; after: number }>;
  /** Session windows added from the ledger. */
  sessions: number;
};

/**
 * Bring a stored run to `CLOCK_MODEL` from its own journal (EE-2).
 *
 * Every `phase.session` line of a work mode other than the attempt's own is a
 * session the record never timed: it becomes a closed window `[time − ms,
 * time]` — the line is written when the session ends, and `ms` is its wall.
 * A window the door already opened for the same session (same mode, an end
 * within ten seconds) is not added twice, which is what makes a run the new
 * door drove before its first re-measure safe. The stamp is written in the same
 * pass, so a second boot is a no-op; null for a run already at the model.
 */
export function remeasureFromLedger(state: RemeasureTarget, lines: readonly LedgerLine[], nowMs = Date.now()): RemeasureResult | null {
  if ((state.clockModel ?? 1) >= CLOCK_MODEL) return null;
  const before = new Map<string, number>();
  let sessions = 0;
  for (const line of lines) {
    if (line.event !== 'phase.session' || typeof line.phase !== 'number') continue;
    const data = line.data ?? {};
    const mode = typeof data.mode === 'string' ? data.mode : '';
    const wall = Number(data.ms);
    const end = typeof line.time === 'string' ? Date.parse(line.time) : Number.NaN;
    if (mode === 'phase' || !(PHASE_WORK_MODES as readonly string[]).includes(mode)) continue;
    if (!Number.isFinite(wall) || wall <= 0 || !Number.isFinite(end)) continue;
    const key = String(line.phase);
    const record = state.phases[key];
    if (!record) continue;
    if (!before.has(key)) before.set(key, phaseClocks(record, nowMs).workedMs ?? 0);
    if (addSessionWindow(record, mode, end - wall, end)) sessions += 1;
  }
  const phases: RemeasureResult['phases'] = {};
  for (const [key, was] of before) {
    const record = state.phases[key]!;
    const now = phaseClocks(record, nowMs).workedMs ?? 0;
    if (Math.abs(now - was) < 1) continue;
    // ONE definition (#28): the stored figure is the windows' sum, as the wire's is.
    record.durationMs = now;
    phases[key] = { before: was, after: now };
  }
  state.clockModel = CLOCK_MODEL;
  return { phases, sessions };
}
