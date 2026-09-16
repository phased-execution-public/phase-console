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
import type { PhaseSize } from '../parse/plan.ts';
import type { SpawnOutcome, SpawnRequest } from './spawn.ts';

/** One cap and where it came from. `basis` is the arithmetic, in words, when there was any. */
export type Cap = { value: number; source: CapSource; basis?: string };

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
 * The caps a session runs under when its run set no `phaseBudgetUsd`, by the
 * phase's `Size:` — the operator's answer of 2026-09-14.
 *
 * About three times the most any measured session spent: the audit's most
 * expensive session was $41.14 over 213 turns, on `opus[1m]` at `max`. A cap
 * that bites is not a failure — `error_max_budget_usd` and `error_max_turns`
 * resume the SAME session with the cap doubled (`raiseCap`), bounded by
 * `MAX_ATTEMPTS` — so the numbers bound a runaway without cutting a long phase.
 */
export const SESSION_CAPS_BY_SIZE: Readonly<Record<PhaseSize, Readonly<{ usd: number; turns: number }>>> = Object.freeze({
  S: Object.freeze({ usd: 25, turns: 150 }),
  M: Object.freeze({ usd: 60, turns: 300 }),
  L: Object.freeze({ usd: 120, turns: 600 }),
});

/**
 * The share of a phase's dollars a side session gets — a closeout, a repair, a
 * QA round, a PR session, the reviewer. A quarter, which is what every one of
 * those sites already spent of `phaseBudgetUsd` when a run set one.
 */
export const SIDE_SESSION_SHARE = 4;

/** What `spawn.ts` applies when a caller hands it no cap at all: the largest row, named as a floor. */
export const SPAWN_DEFAULT_CAPS: SessionCaps = Object.freeze({
  maxTurns: Object.freeze({ value: SESSION_CAPS_BY_SIZE.L.turns, source: 'spawn-default', basis: 'L' }) as Cap,
  maxBudgetUsd: Object.freeze({ value: SESSION_CAPS_BY_SIZE.L.usd, source: 'spawn-default', basis: 'L' }) as Cap,
});

/** The size row's turn cap, as a `Cap` — for a caller that wants a phase's turns on a side session. */
export function sizeTurns(size: PhaseSize): Cap {
  const row = SESSION_CAPS_BY_SIZE[size] ?? SESSION_CAPS_BY_SIZE.M;
  return { value: row.turns, source: 'size', basis: size };
}

export type CapsInput = {
  mode: SessionMode;
  /** The phase's `Size:`. An unreadable size is `M`, the engine's own default. */
  size: PhaseSize;
  /** The run's own dollar cap per phase; null when it set none. */
  phaseBudgetUsd: number | null | undefined;
  /** A turn cap the caller already decided — a closeout brief's, a wait-resume's. Wins. */
  turns?: Cap;
  /** A dollar cap the caller already decided — a QA round's own budget. Wins. */
  usd?: Cap;
};

/**
 * The caps for one session. Dollars: a phase attempt and a resume get the
 * whole of `phaseBudgetUsd` (`run`) or the size row (`size`); every side
 * session gets a quarter of the same, never under $1. Turns: the mode's own
 * cap — `REPAIR_MAX_TURNS` for a repair, `CLOSEOUT_MAX_TURNS` for everything
 * that is paperwork or a bounded review — and the size row for a phase.
 */
export function capsFor(input: CapsInput): SessionCaps {
  const size: PhaseSize = SESSION_CAPS_BY_SIZE[input.size] ? input.size : 'M';
  const row = SESSION_CAPS_BY_SIZE[size];
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
      ? { value: row.usd, source: 'size', basis: size }
      : { value: Math.max(1, row.usd / SIDE_SESSION_SHARE), source: 'size', basis: `${size} ÷ ${SIDE_SESSION_SHARE}` };
  }

  let turns: Cap;
  if (input.turns) turns = input.turns;
  else if (input.mode === 'repair') turns = { value: REPAIR_MAX_TURNS, source: 'repair' };
  else if (input.mode === 'phase') turns = sizeTurns(size);
  else turns = { value: CLOSEOUT_MAX_TURNS, source: 'closeout' };

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
  model: string | null;
  effort: string | null;
  sessionId: string | null;
  /** The session continued an existing conversation (`--resume`). */
  resumed: boolean;
  subtype?: string;
  isError: boolean;
  terminalReason?: string;
  endedBy: EndedBy;
  endedReason?: string;
  turns: number;
  /** `result` — the CLI's own count; `stream` — the assistant turns the stream showed, for a turn that never closed. */
  turnsSource: 'result' | 'stream';
  costUsd: number;
  /** `none` — no `total_cost_usd` ever arrived, so `costUsd` is unknown rather than zero. */
  costSource: 'result' | 'stream' | 'none';
  ms: number;
  argv: string[];
  said: string;
  injected?: number;
  maxTurns: Cap;
  maxBudgetUsd: Cap;
  /** How many tool calls the CLI's own permission system denied (`result.permission_denials`). */
  permissionDenials: number;
};

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
    costUsd: outcome.costUsd ?? 0,
    costSource: outcome.costSource ?? (outcome.costUsd ? 'result' : 'none'),
    ms: outcome.durationMs ?? 0,
    argv: outcome.argv ?? [],
    said: (outcome.resultText ?? '').replace(/\s+/g, ' ').slice(0, 1_200),
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

/** The size row's dollar cap for a whole phase session, as a `Cap`. */
export function sizeUsd(size: PhaseSize): Cap {
  const row = SESSION_CAPS_BY_SIZE[size] ?? SESSION_CAPS_BY_SIZE.M;
  return { value: row.usd, source: 'size', basis: size };
}
