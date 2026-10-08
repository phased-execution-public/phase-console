/**
 * Run state: the checkpoint that survives a crash.
 *
 * A run is a long-lived thing — hours, many child processes, possibly a
 * console restart in the middle. Everything needed to pick it back up lives in
 * one JSON file per run, written after every transition and outside the repo
 * (`~/.local/state/phase-console/runs/…`), so a supervised plan never leaves
 * uncommitted machine state in someone's working tree.
 *
 * Writes are atomic: a half-written checkpoint read after a power cut is worse
 * than no checkpoint at all, because it looks valid.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { DEFAULT_PRIORITY, type RunPriority } from '../../shared/orchestration-model.js';
import type { AttemptWindow } from '../../shared/phase-clocks.js';
import {
  DEFAULT_CONFLICT, DEFAULT_LAND,
  type ConflictPolicy, type LandPolicy, type LandingState,
} from '../../shared/landing-model.js';
import { DEFAULT_ISSUES, type IssueMode } from '../../shared/issues-model.js';
import { DEFAULT_MESSAGING, type MessagingWord } from '../../shared/message-model.js';
import { HALT_KINDS, isAdjudicatedHalt, isPlanHalt } from '../../shared/recovery-model.js';
import type { QaFixStrategy, RelayMode } from '../../shared/run-settings.js';
import type { RungCause } from '../../shared/ladder-model.js';
import type { LadderCap, LadderCapSetting } from './ladder.ts';
import type { TreeStamp } from './tree-state.ts';
import type { HaltHolderKind, HaltHolderVerb } from '../../shared/recovery-model.js';
import type { CredentialClass } from '../../shared/ops-vocab.js';
import type { RetirementEvidence } from './errors.ts';
import type { PolicySource } from '../../shared/policy-model.js';
import { BOARD_BUCKETS, WAIT_REASONS, waitReasonOf } from '../../shared/status-vocab.js';
import {
  DEFAULT_SETTLE, ISOLATED,
  type CheckoutState, type IsolationMode, type SettleStrategy,
} from '../../shared/worktree-model.js';
import { consoleRunsDir, isRunSidecar, journalFile, runDir, runFile } from './run-paths.ts';
import type { BudgetFact, BudgetKind } from '../../shared/budget-model.js';
import { adoptionHeld } from '../crash-ledger.ts';
import type { LandingProof, WorktreeRefusal } from './worktree.ts';
import type { HolderEta } from './scheduler.ts';
import type { CiNotRun } from '../watch-refs.ts';
import { pidAlive, pidHoldsWork, processState, type ProcessState } from '../pid.ts';
import type { PermissionProfile } from './approvals.ts';
import type { RecordedWall } from '../permissions/walls.ts';
import type { PermissionMode } from './spawn.ts';
// Type-only, so nothing is imported at runtime and the pair that would
// otherwise be a cycle (`rulings.ts` needs `runDir` from here) never forms one.
import type { LaneLiveness, PhaseSuspect, StallState } from './liveness.ts';
import type { ContextMark, PartialMark, TokenAttempt } from './usage.ts';
import { CLOCK_MODEL, COST_MODEL, type Cap } from './session-record.ts';
import type { Ruling } from './rulings.ts';
import type { TaskItem } from './tasks.ts';
import type { LadderEnding } from './signals.ts';
import type { PressDoor } from '../../shared/door-model.js';
import {
  DECLARATIONS_MAX_PER_PHASE, WAIT_SETTLE_GRACE_MS, closeWaitEntry, parkedMsOf, type WaitAuthor, type WaitEntry,
} from './wait-budget.ts';
import { Journal } from './journal.ts';
import {
  BOARDING_BRIEFS, DECLARATION_CONSUMERS, DEFAULT_MODEL_POLICY, MCP_POLICIES, MODEL_POLICIES, ON_LIMIT_POLICIES, PHASE_IN_FLIGHT, RUN_IN_FLIGHT,
  SETTLED, SETTLED_WELL, phaseLifecycle, phaseSettledWell, runLifecycle, waitOnOf,
} from '../../shared/run-lifecycle.js';
import type {
  Actor as ActorShape, ActorVia as ActorViaWord, AnyDoor as AnyDoorWord,
  AutonomyMode, CapSource as CapSourceWord, ClassifiedBy as ClassifiedByWord,
  DeclarationConsumer as DeclarationConsumerWord,
  EndedBy as EndedByWord, FenceLiftReason, GitMode, HolderClass, HolderKind, McpPolicy, ModelPolicy, OnLimitPolicy, OutcomeStatus,
  PhaseLifecycle, PhaseStatus as PhaseStatusWord,
  PhaseStopKind, ReviewerPolicy, RunLifecycle, RungOutcome, RunStatus as RunStatusWord,
  SessionMode as SessionModeWord, SettledRungOutcome, StartDoor as StartDoorWord, UltraReviewMode,
  UsageDecisionAction as UsageDecisionActionWord, WatchStateWord,
} from '../../shared/run-lifecycle.js';

/**
 * The lifecycle vocabularies live in `shared/run-lifecycle.js`, which is the
 * one place their members are written down — the console's bash halves and the
 * client read the same file. These are the TS shadows of its typedefs, kept
 * here so every consumer of this module keeps importing `RunStatus` from where
 * it always has. Adding a word means editing the owner; adding it here is a
 * type error the moment the owner disagrees.
 */
export type RunStatus = RunStatusWord;
export type PhaseStatus = PhaseStatusWord;
/**
 * The attribution vocabularies (`START_DOORS`, `ACTOR_VIAS`, the `Actor`
 * shape) — shadows of `run-lifecycle.js`'s typedefs like the two above. Owned
 * there since zero-touch-console phase 2; phase 7 wired the emitters
 * (`run.start`'s actor with a door on every start, the derived actor on the
 * verbs that stop, restart, switch or classify). `AnyDoor` admits the one
 * non-automatic word, `OPERATOR_DOOR`; `ClassifiedBy` is the `by` on
 * `phase.situation` and `phase.rung`.
 */
export type StartDoor = StartDoorWord;
export type AnyDoor = AnyDoorWord;
export type ActorVia = ActorViaWord;
export type Actor = ActorShape;
export type ClassifiedBy = ClassifiedByWord;
/**
 * The session-ledger vocabularies (zero-touch-console phase 4, SES-1/SES-8/
 * SES-9): who ended a session, what it was for, where its caps came from, and
 * what the console decided about a usage warning. Shadows of
 * `run-lifecycle.js`'s typedefs, like the ones above.
 */
export type EndedBy = EndedByWord;
export type SessionMode = SessionModeWord;
export type CapSource = CapSourceWord;
export type UsageDecisionAction = UsageDecisionActionWord;
/**
 * The licences a declaration is spent under (zero-touch-console phase 6,
 * WAI-9) — owned by `run-lifecycle.js` `DECLARATION_CONSUMERS`, shadowed here
 * like the rest, and re-exported so the lints that count the licences read the
 * owner's object.
 */
export type DeclarationConsumer = DeclarationConsumerWord;
export { DECLARATION_CONSUMERS };
/** One row of `PhaseRecord.declarations` — see the field. */
export type DeclarationLedgerRow = { count: number; lastAt: string; refused?: number };

/**
 * Terminal for this run: the loop will not pick these up again by itself.
 *
 * `queued` is absent on purpose — it is the opposite of settled. A queued phase
 * is one the loop is actively waiting to start, and listing it here would make
 * `drive()` filter it out of its own candidate list the moment it was admitted.
 *
 * `gated` IS here: a human/auto gate the runner cannot clear would otherwise be
 * re-admitted every loop iteration — an infinite gate-check spin. Approving the
 * gate (the phase page's Gate card) retries the phase, which resets the record.
 */
export { SETTLED };

/**
 * `phaseSettledWell(record, errand)` — the ONE predicate for "may a run that
 * asked for this phase call it over" (#43), owned by `shared/run-lifecycle.js`
 * and re-exported here, beside `SETTLED`, for the runner's readers. Its three
 * callers: the drive loop's scoped finish (`runner-loop.ts`, through
 * `scopeLeftOpen`), the read path's correction of a stored run
 * (`honestScopedFinish` below, from `settle`) and the inbox's attention gate
 * (`inbox.ts`). None re-derives it.
 */
export { phaseSettledWell };

/** The standing recovery errand for `phase`, if it has one. */
export function errandOf(state: RunState, phase: number): Errand | undefined {
  return state.recoveries?.[String(phase)]?.errand;
}

/**
 * The phases a SCOPED run asked for that are not settled well — ascending, and
 * empty for a run that was not scoped. A phase with no record at all never
 * boarded, so it is open too.
 */
export function scopeLeftOpen(state: RunState): number[] {
  return [...new Set(state.onlyPhases ?? [])]
    .filter((phase) => !phaseSettledWell(state.phases[String(phase)], errandOf(state, phase)))
    .sort((a, b) => a - b);
}

/** "scope not done: phases 10, 11" — the words both halves of #43 lead with. */
export function scopeNotDoneSentence(open: readonly number[]): string {
  return `scope not done: ${open.length === 1 ? 'phase' : 'phases'} ${open.join(', ')}`;
}

/**
 * Retire the errands whose phase is already settled well (#43). An errand asks
 * a person for what a phase needs, and a phase that reads `done` (or that the
 * operator skipped) needs nothing more — but three doors re-board a phase
 * without spending a rung (Retry, a Continue's reboard, the operator's resume),
 * so the ask used to outlive the answer. Left standing it would hold a scoped
 * run open for ever, since `phaseSettledWell` reads any standing errand as
 * owed. Journalled `phase.errand-cleared {reason: done|skipped}`.
 */
export function retireSettledErrands(state: RunState, journal: DeclarationSink = journalOf(state)): number[] {
  const retired: number[] = [];
  for (const [key, slot] of Object.entries(state.recoveries ?? {})) {
    if (!slot?.errand || !/^\d+$/.test(key)) continue;
    const status = state.phases[key]?.status;
    if (!status || !(SETTLED_WELL as readonly string[]).includes(status)) continue;
    const errand = slot.errand;
    delete slot.errand;
    journal('phase.errand-cleared', { reason: status, situation: errand.situation, since: errand.at }, Number(key));
    retired.push(Number(key));
  }
  return retired;
}

/**
 * The read path's half of #43, for a run an older console already wrote. A
 * scoped run used to finish when none of its asked phases read `parked`,
 * `gated` or `failed`, so a run whose phase 10 held an open errand and whose
 * phase 11 never boarded says "those are settled". Such a run keeps its
 * status word — flipping a months-old run to `parked` would hand it back to
 * the healer as its plan's open run — but its sentence is corrected to name
 * what is still open. Idempotent: a sentence already correct is left alone.
 * Returns whether it changed anything.
 */
export function honestScopedFinish(state: RunState): boolean {
  if (state.status !== 'finished' || !state.onlyPhases?.length) return false;
  const retired = retireSettledErrands(state);
  const open = scopeLeftOpen(state);
  if (!open.length) return retired.length > 0;
  const sentence = `${scopeNotDoneSentence(open)} — this run stopped with ${open.length === 1 ? 'it' : 'them'} `
    + 'unsettled, and the console that wrote it called that finished. Continue the run, or Retry '
    + `${open.length === 1 ? 'that phase' : 'those phases'}, to carry on.`;
  if (state.finishedReason === sentence) return retired.length > 0;
  state.finishedReason = sentence;
  return true;
}

/**
 * Statuses that assert work is in flight — each one a claim made by a process
 * that can be killed between writing it and acting on it.
 *
 * `queued` is not one of them: it claims the opposite. See `RunStatus`.
 */
export const IN_FLIGHT: readonly RunStatus[] = RUN_IN_FLIGHT;

/** The same, per phase. A phase in one of these had a live loop behind it. */
export { PHASE_IN_FLIGHT };

/* ------------------------------------------------------------------ *
 * The two status writers
 * ------------------------------------------------------------------ */

/**
 * Set a run's status — and its lifecycle, which is the point.
 *
 * Until 3.5.0 there was no named status writer at all: `state.status = '…'`
 * appeared at fifty-nine sites across six files, and `record.status = '…'` at
 * fifty-eight more. That is survivable while the status is one word; it is not
 * survivable the moment a second field has to agree with it, because "every
 * writer sets both" is a promise no reviewer can check against 117 assignments.
 *
 * So this is the chokepoint, and it is deliberately thin: it writes the word,
 * derives the lifecycle from the word plus whatever the run already knows
 * (`waitReason`, `waitUntil`, `freeze`), and lets the caller override the wait
 * axis for the two waits the status cannot express — `scope` and `schedule`,
 * which are both spelled `queued`.
 *
 * It does NOT journal, emit or save. Those belong to `Runner`, which knows the
 * phase and the reason; a writer that did them would make every caller pay for
 * a side effect most of them already perform themselves.
 *
 * Since control-tower phase 52 it is the ONLY run-status writer (#50): every
 * other `state.status =` was converted — sixty-two of them, one in this file —
 * and `invariants.test.ts` refuses a new one. The reason is `waitReason`. It is
 * written with a wait and read by everything that asks "why is this run
 * waiting?", and a raw write that ended the wait left it behind: a run stopped
 * while queued on scope read `paused` beside `waitReason: 'scope'`, and every
 * reader keying on the reason saw a run waiting for a scope nothing would ever
 * free. So a word that is not a wait drops the reason with the wait — unless
 * the run still holds a wait CLOCK (`waitUntil`): a usage window reconciled to
 * `paused` keeps its clock, and the clock's reason is how the boot re-arm and
 * `waitHoldWhy` tell a usage wall from a park on external work.
 *
 * @param wait Overrides the derived wait axis. Pass it when the run is queued
 *   for a schedule rather than for scope, or when the reason is known before
 *   `waitReason` has been written.
 */
export function setRunState(
  state: RunState,
  status: RunStatus,
  wait?: { kind: WaitReason; until?: string | null; on?: string } | null,
): void {
  state.status = status;
  // "Is this word a wait?" is the fold's question (`queued` and `waiting` fold
  // to it), asked of the word alone so no stored axis can answer it.
  if (state.waitReason && !wait && !state.waitUntil && runLifecycle({ status }).state !== 'waiting') state.waitReason = null;
  // Derive from the run as it is AFTER the word lands, so `waitUntil` and
  // `freeze` written moments earlier are already visible to the fold. The
  // stored `lifecycle` is deliberately not consulted — this is the writer, and
  // trusting the previous answer is how a stale axis outlives its status.
  const { lifecycle: _stale, ...facts } = state;
  // Recorded BEFORE the fold reads it: `waitReason` is the only thing that can
  // tell `scope` from `schedule` (both are spelled `queued`) or hold a reason a
  // fresh run has no phases to imply. Writing it here is what makes the
  // writer's answer survive the next `syncLifecycle`, rather than being
  // re-derived away by a fold that could not have known.
  if (wait) state.waitReason = wait.kind;
  const lifecycle = runLifecycle({ ...facts, status, waitReason: state.waitReason });
  // Every wait keeps its kind, its clock and what it is ON (control-tower
  // phase 88, #148) — as the caller stated them, else as the run implies them —
  // so no reader has to re-derive a wait the writer knew. A pause that carries
  // a clock (an operator's pinned wait, `onLimit: pause`) carries the wait too:
  // it stays a pause, and still says which wall it is sitting out. It used to be
  // written only for a stated wait on a `waiting` word, so a run reconciled off
  // a wait stored `{state: 'paused'}` and nothing else, and read "Paused".
  if (lifecycle.state === 'waiting' || (lifecycle.state === 'paused' && (wait || state.waitUntil))) {
    const kind = wait?.kind ?? lifecycle.wait?.kind ?? waitReasonOf(state);
    const on = wait?.on ?? waitOnOf(state, kind);
    lifecycle.wait = { kind, until: wait?.until ?? state.waitUntil ?? lifecycle.wait?.until ?? null };
    if (on) lifecycle.wait.on = on;
  }
  state.lifecycle = lifecycle;
}

/**
 * Set a phase record's status and its lifecycle. `setRunState`'s twin, same
 * contract, same reasons.
 *
 * @param stop Overrides the derived stop axis, for the reasons the record
 *   cannot show — a ladder that gave up, an MCP park not yet written.
 */
export function setPhaseState(
  record: PhaseRecord,
  status: PhaseStatus,
  stop?: { kind: PhaseStopKind; declared?: string } | null,
): void {
  record.status = status;
  const { lifecycle: _stale, ...facts } = record;
  const lifecycle = phaseLifecycle({ ...facts, status });
  // `stated`, so the sync can tell a reason a WRITER gave from one the fold
  // guessed. It is the difference between "the console decided this park is a
  // scope cap" and "nothing contradicts that", and without it the three
  // lock-cap parks lose their reason the moment the record carries anything
  // the fold reads as a better answer — an unspent `declared`, say — and go
  // back to painting `needs-you`.
  if (stop) {
    lifecycle.stop = stop.declared
      ? { kind: stop.kind, declared: stop.declared, stated: true }
      : { kind: stop.kind, stated: true };
  }
  record.lifecycle = lifecycle;
}

/**
 * Make every `lifecycle` on this run agree with the `status` beside it.
 *
 * 🔑 **This, and not a hundred-and-seventeen edits, is what makes the dual-write
 * true.** The obvious reading of "every writer sets both shapes" is to convert
 * all 117 assignment sites to `setRunState`/`setPhaseState`. That is a very
 * large diff whose correctness rests on nobody having been missed, and whose
 * failure mode — one site still writing a bare `status` — is silent: the record
 * keeps a lifecycle describing the status it used to have, which is worse than
 * having none, because a reader cannot tell a stale axis from a fresh one.
 *
 * Deriving at the two chokepoints instead makes the invariant structural. Every
 * run reaches disk through `saveRun` and comes back through `settle`, so a
 * lifecycle that disagrees with its status cannot survive either crossing, and
 * the 118th assignment site somebody adds next year is covered before it is
 * written. The named writers stay, and are used where the caller knows a reason
 * the fold cannot recover — scope versus schedule, a spent ladder versus a red
 * verification — but forgetting one costs a less specific reason, never a
 * wrong state.
 *
 * The RUN's half was converted after all, in control-tower phase 52 — not for
 * the lifecycle, which this still keeps honest, but for `waitReason`, which no
 * fold re-derives and only a writer can clear (#50; see `setRunState`). The
 * phase records' writes are still bare. Deliberately, nothing here drops a
 * stale reason on read: `paused` with `usage-limit` and no clock is a reason a
 * WRITER stated (`onLimit: pause`), and a read cannot tell it from a leftover —
 * a file written before phase 52 keeps its reason until its next status write.
 *
 * Agreement is judged on the state AND the reason axis — see `axisStale`. It
 * was `state` alone for one commit, which let the axes go permanently stale:
 * a phase parked on an unreachable MCP server and later parked on an errand
 * kept `stop.kind: 'mcp'` and went on painting `waiting`. A reason a WRITER
 * stated is kept while its state holds; a reason the fold guessed is refreshed
 * whenever the fold has a newer answer.
 */
function syncLifecycle(state: RunState): void {
  const { lifecycle: storedRun, ...runFacts } = state;
  const derivedRun = runLifecycle(runFacts);
  // The STATE, and the reason axis with it. Comparing only `.state` left the
  // axes to go permanently stale, which is worse than having none: a phase
  // parked on an unreachable MCP server and later parked on an errand kept
  // `stop.kind: 'mcp'` and went on painting `waiting`, so the one park that
  // needs a person read as the one park that does not. Same shape for a run
  // that moved `queued` → `waiting`: both fold to `waiting`, so the scope wait
  // survived over a usage window.
  //
  // 🔑 **The fold WINS wherever it has an answer; the writer's answer survives
  // where the fold is silent.** Both halves are load-bearing, and the second
  // one more than it looks: the three lock-cap parks CLEAR `lockWaitSince` in
  // the same block that sets `parked` — the clock stops with the wait — so a
  // fold run afterwards has no evidence left and cannot tell a scope park from
  // one that needs a person. `setPhaseState(record, 'parked', {kind:
  // 'scope-cap'})` is what states it, and this rule is what stops the next save
  // from erasing it. A sync that overwrote on absence would make every one of
  // those parks paint `needs-you` again.
  if (storedRun?.state !== derivedRun.state || axisStale(storedRun?.wait, derivedRun.wait)) {
    state.lifecycle = derivedRun;
  } else if (storedRun?.wait && derivedRun.wait && storedRun.wait.until !== derivedRun.wait.until) {
    // The same wait on a clock that moved (`syncWaitClock` follows the waiters
    // that remain without a status write): the clock is the run's, and what
    // the writer said it is ON stays (#148).
    state.lifecycle = { ...storedRun, wait: { ...storedRun.wait, until: derivedRun.wait.until ?? null } };
  }

  for (const record of Object.values(state.phases ?? {})) {
    if (!record) continue;
    const { lifecycle: stored, ...facts } = record;
    const derived = phaseLifecycle(facts);
    if (stored?.state !== derived.state || axisStale(stored?.stop, derived.stop)) {
      record.lifecycle = derived;
    }
  }
}

/**
 * Does the stored reason axis disagree with the one the record now implies?
 *
 * `undefined` on the derived side is "the fold cannot tell", which is never a
 * disagreement — it is the one case a writer's answer is worth more than a
 * re-derivation.
 */
function axisStale(
  stored: { kind?: string; stated?: true } | undefined,
  derived: { kind?: string } | undefined,
): boolean {
  // A reason a WRITER gave outranks one the fold guessed, for as long as the
  // state it was given for still holds — the caller had evidence the record no
  // longer carries, which is exactly why it had to say so. `syncLifecycle`
  // re-derives wholesale the moment the STATE changes, so a stated reason
  // cannot outlive the park it describes.
  if (stored?.stated) return false;
  if (!derived?.kind) return false;
  return stored?.kind !== derived.kind;
}

export type VerifyRun = {
  command: string;
  ok: boolean;
  code: number;
  ms: number;
  /** Tail only — a full test-suite log does not belong in a checkpoint. */
  output: string;
  /** `terminal` when a person re-ran it in the integrated terminal and the
   * exit was reflected here — evidence with its provenance named. */
  via?: 'terminal';
  /**
   * How a timed-out or cancelled command ENDED, from the signal ladder:
   * `gone` (already over), `exited` (SIGTERM was enough), `killed` (it was
   * not). Only set when the run was cut short — a 124 that does not say
   * whether the command's children were reaped is a 124 nobody can act on.
   * Never `interrupted`: a verification command is a `bash -c` with no turn to
   * close, so its ladder skips the SIGINT (`verify.ts`).
   */
  how?: LadderEnding;
  /** The second attempt of a command whose first exited red — the verdict is
   * judged on this one; the first stays on the record beside it. */
  retry?: boolean;
  /**
   * The verification's OWN clock cut this command (control-tower phase 83,
   * #95) — not the abort signal, and not a command that exited 124 by itself.
   * A cut proves only "longer than the limit": the command is retried once at
   * twice the limit, and a cut on its last attempt is `verify-timeout`, never
   * a red verdict.
   */
  timedOut?: boolean;
  /** The limit this attempt ran under, in ms — what `timedOut` was measured against. */
  limitMs?: number;
  /**
   * The failing tests this command's output named, one identity each (node's
   * spec and TAP reporters, bats' TAP — `verify.ts` `failureIds`), bounded.
   * What a baseline is compared by (#103): absent when the output named none.
   */
  failures?: string[];
  /**
   * What this command ran AGAINST: the repository its cwd is in, the branch it
   * stood on and its head (control-tower phase 40, #41). Absent on a record
   * stored before stamps existed — every reader treats it as optional.
   */
  tree?: { repo: string; branch: string | null; head: string | null };
  /**
   * The console did NOT run this command: the phase's session proved it green
   * at an equivalent tree and recorded it (`phase-outcome.sh … verified`,
   * control-tower phase 62, #68). `tree` is the working tree it ran against,
   * `paperwork` what changed since — only paths no suite reads. `code: 0` and
   * `ms: 0` on such a row are the proof's, never a run's.
   */
  proven?: { tree: string; at: string; session?: string; paperwork: string[] };
  /**
   * The command failed on the MACHINE, not on the work (control-tower phase 89,
   * #41's 2026-09-25 comment): a runtime exit 127, a line naming a
   * `PRECONDITION`, or a connection refused to a loopback port the phase's own
   * session served on — the sentence says which (`verify.ts`
   * `environmentOf`). Such a row is never red: the verdict reads it
   * `unproven`, nothing is charged, nothing re-opens, and it is not retried,
   * since an unchanged precondition fails the same way twice. Since
   * control-tower phase 106 also a dependency that is not installed (#185) and
   * a sibling repository a clean export could not provide (#191).
   */
  environment?: string;
  /**
   * Processes the command left in its process GROUP after its leader exited
   * (control-tower phase 106, #168) — named, then stopped through the signal
   * ladder. The row's code is still the leader's: a sweep that passed and left
   * Metro holding its stdout passed.
   */
  stragglers?: { pid: number; comm?: string }[];
};

/**
 * A §Verification command the runner did not run because its lead binary does
 * not exist on this machine's verification PATH. Neither `ran` (no verdict was
 * produced) nor `notRun` (not a human chore by itself): "I could not check"
 * and "it failed" are different facts, and 15 of 16 observed verify-failed
 * halts were the first fact reported as the second.
 */
export type VerifySkip = { command: string; lead: string; reason: string };

/**
 * One boarding-preflight finding about a phase's §Verification, structured.
 * `human-check`: a fragment only a person can confirm; `missing-lead`: a
 * command whose binary this machine lacks (it will be SKIPPED at verify
 * time); `cwd-unpinned`: cwd-sensitive commands with no **Verify in:**;
 * `nothing-runnable`: the whole bullet yields no executable command (the
 * phase will park at boarding).
 */
export type PreflightWarning = {
  kind: 'human-check' | 'missing-lead' | 'cwd-unpinned' | 'nothing-runnable';
  message: string;
  lead?: string;
  command?: string;
  /** Boarding will PARK on this (the verification review's `parks` verdict), not merely note it. */
  parks?: boolean;
  /** `commandFingerprint` of the whole command — what an approval at the start door is bound to. */
  fp?: string;
  /** One exact approval at the start door would make it run. */
  approvable?: boolean;
};

/**
 * A §Verification fragment the runner will not execute, and why.
 *
 * `code` names which wall refused it (`verify.ts` `RefusalCode`), `lead` the
 * program when the objection is "not a command I know", and `fp` is the
 * sha256 of the WHOLE normalised command — `text` is display-truncated, so it
 * cannot key anything. `approvable` is true only when an operator's exact
 * approval would make it run: nothing destructive, off-machine or unparseable
 * ever is. All four are optional because records written before 2026-09-18
 * carry only `text` and `reason`.
 */
export type VerifyNotRun = {
  text: string;
  reason: string;
  code?: string;
  lead?: string;
  fp?: string;
  approvable?: boolean;
};

/**
 * The operator's answers to the verification review, given ONCE at the start
 * door (2026-09-18, the zero-touch launch): commands the run may execute that
 * the built-in tier would not, and fragments it may set aside.
 *
 * Bound to EXACT text — `fp` is `commandFingerprint` of the whole command — so
 * a plan edited after the start is a new, unapproved command and takes the
 * Person-check path it always took; an answer never widens to a program name.
 * An approval relaxes only "is this a command I know": the deny wall, the
 * off-machine gates and the wrapper recursion still judge it. `waive` is per
 * phase. `text` is kept for the record a person reads later.
 */
export type RunVerifyApprovals = {
  approve: { fp: string; text: string }[];
  waive: { phase: number; fp: string; text: string }[];
  by?: string;
  at?: string;
};

export type VerifySummary = {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  /** Commands present in the plan that the runner would not execute, and why. */
  notRun: VerifyNotRun[];
  /** Fragments the run's start-door answers set aside for this phase. */
  waived?: VerifyNotRun[];
  /** Commands skipped because their lead is not installed here. Optional —
   * records written before the skip machinery simply never have it. */
  skipped?: VerifySkip[];
  /**
   * The phase's `- **Setup:**` preamble, and ONLY when one of its commands
   * failed.
   *
   * Present means something in the bring-up did not work; absent means either
   * the phase declared no Setup or all of it ran clean. It is diagnostic
   * context and never a verdict: a Setup command's exit code cannot make
   * `ok` false, cannot raise a card, and cannot colour the phase red. It is
   * here so that when §Verification then fails for the obvious downstream
   * reason, the record already says the database never came up.
   */
  setup?: { ok: false; command: string; output: string };
  /**
   * `{repo, branch, head}` of every repository this verification compared
   * against — the one it ran in first, then the scoped ones, the ones a command
   * reached with `cd` or `git -C`, and every other one under the run's root
   * (`runner/tree-state.ts` `stampTrees`). Absent on a record stored before
   * control-tower phase 40.
   */
  trees?: TreeStamp[];
  /**
   * The commands whose LAST attempt the verification's clock cut (control-tower
   * phase 83, #95) — the `verify-timeout` outcome: `ok` is false, and nothing
   * here is a red verdict. Absent when nothing timed out.
   */
  timedOut?: string[];
  /**
   * Reds this phase INHERITED (control-tower phase 83, #103): failing tests
   * already present in its baseline, each with the phase that owns it when the
   * ledger or the commits name one. They travel on the record and are charged
   * to nobody here. Absent when the phase inherited nothing.
   */
  inherited?: InheritedRed[];
  /**
   * The commands whose last attempt failed on the machine rather than the work
   * (control-tower phase 89) — each with the sentence `environmentOf` gave. Not
   * a red: the phase is neither charged nor re-opened, and its record says the
   * line is UNPROVEN rather than green. Absent when nothing was.
   */
  unproven?: { command: string; why: string }[];
  /**
   * Where the commands ran, when it was not the working tree (control-tower
   * phase 89, #103, #41): a clean checkout of the phase's HEAD in a temporary
   * directory, because the tree held changes that were not the phase's own —
   * `reason` names them and `owners` the phases whose they were. Absent when
   * the verification ran in place, as a clean tree still does.
   */
  export?: VerifyExport;
};

/** A verification's clean checkout — see `VerifySummary.export`. */
export type VerifyExport = {
  /** The commit it was checked out at: the verified repository's HEAD. */
  head: string;
  /** The repository whose HEAD it was (absolute). */
  repo: string;
  /** Why the working tree was not used, as a person reads it. */
  reason: string;
  /** The foreign paths that sent it there, bounded. */
  paths: string[];
  /** Whose they were: a phase of this run, or null for a path nobody's session wrote for sure. */
  owners: (number | null)[];
};

/**
 * Which word set a §Verification command's limit (control-tower phase 83,
 * #95): the phase's `- **Verify timeout:**`, the plan's `**Verify timeout:**`,
 * the line's own measured runs, or the console's default.
 */
export type VerifyLimitSource = 'phase' | 'plan' | 'history' | 'default';

/** One command's inherited reds, and whose they are — see `VerifySummary.inherited`. */
export type InheritedRed = {
  command: string;
  /**
   * The `&&` chain this command is a member of — a red chain is attributed
   * member by member, each run alone (control-tower phase 83, #103's
   * chained-gate comment). Absent for a line of the plan's own.
   */
  chain?: string;
  /** The failing tests; empty when the output named none and the whole command was compared. */
  failures: string[];
  /** The phase that owns them, when one is known. */
  owner?: number;
  /**
   * How the owner was found: charged with them by its own verification, the
   * commits between, the UNCOMMITTED paths its session wrote (`wip`), or its
   * wrap-up's fast gate recording the same red on a commit this head carries
   * (`wip-red`, control-tower phase 89).
   */
  how?: 'charged' | 'commit' | 'wip' | 'wip-red';
  /** Several phases committed in the range and none can be told from the others: all are named. */
  candidates?: number[];
  /** A `wip` red: the uncommitted paths that were the only difference from a tree it was green on. */
  paths?: string[];
};

/**
 * A red another phase's §Verification INHERITED and named this phase as its
 * owner (control-tower phase 83, #103) — kept on the OWNER's record, so what
 * it owes is said where its own work is read. Dropped when this phase's own
 * verification runs the line green; never a charge against it by itself.
 */
export type OwedRed = {
  command: string;
  chain?: string;
  failures: string[];
  /** The phase whose verification found it, and when. */
  by: number;
  at: string;
  how: 'charged' | 'commit' | 'wip' | 'wip-red';
  paths?: string[];
};

/**
 * A phase's COMMITTED work-in-progress is red (control-tower phase 89, #127):
 * after its session handed off at the console's context wrap-up, the plan's
 * fast gate (`fastGateLines`) ran on the commit it left and failed. `sha` is
 * that commit, `files` what the phase's WIP changed since it boarded, `lines`
 * the gate's red commands with the failing tests each named. Read by the
 * boarding order (the WIP's owner boards first), by every sibling's brief
 * (`siblingWipBlock` — "these files are red and are P43's"), by the
 * verification's attribution (a red on one of these lines is the owner's) and
 * by the failure streak's root-cause key (phase 87). Cleared when a gate or a
 * verification of the phase's own reads those lines green.
 */
/** Who set an operator's queue mark, when, and why (control-tower phase 99, #135) — `reason` is phase 96's. */
export type QueueMark = { at: string; by: string; reason?: string };

/**
 * An operator's standing word on one phase's place in the admission queue
 * (control-tower phase 99, #135 B and E) — `PhaseRecord.queueControl`.
 *
 *   - `bump` — to the front of its class; `stamp` (ms) orders two bumps, the
 *     most recent first, across plans. Spent when the phase is admitted.
 *   - `hold` — kept in the queue, never admitted, until released.
 *   - `defer` — a hold that ends by itself at `until`.
 *   - `withdrawn` — out of the queue: the run boards its other phases and names
 *     this one, never boarding it, until it is re-queued.
 */
export type QueueControl = {
  bump?: QueueMark & { stamp: number };
  hold?: QueueMark;
  defer?: QueueMark & { until: string };
  withdrawn?: QueueMark;
  /** Pinned next in its plan (control-tower phase 100, #135 B.8) — spent when it boards. */
  pin?: QueueMark;
  /**
   * The next lane on its scope is kept for it (control-tower phase 100, #135
   * D.15–16): when `lane` ends — a yield names the lane that gave up — or at
   * once. Spent when it boards; the scheduler holds it while it stands.
   */
  reserve?: QueueMark & { lane?: { slug: string; phase: number }; via?: 'yield' };
};

export type WipRed = {
  sha: string;
  files?: string[];
  lines?: { command: string; failures?: string[] }[];
  at?: string;
};

/**
 * What a phase's §Verification read on its BASE tree, before its session
 * touched it (control-tower phase 83, #103) — taken at the phase's first
 * boarding and kept for the rest of the run, so its own work can never become
 * its baseline. Each command is the last run of that line on the base tree
 * (`reused`), or a run made then (`measured`).
 */
export type VerifyBaseline = {
  at: string;
  /** The working tree the baseline describes — a git tree object; null when git could not name it. */
  tree: string | null;
  head: string | null;
  commands: {
    command: string;
    /** A member of this `&&` chain, run alone because the chain was red. */
    chain?: string;
    ok: boolean;
    code: number;
    failures?: string[];
    /**
     * A red line's output tail (`outputTail`, control-tower phase 106, #195) —
     * what it said, kept for a baseline as for a verdict and shown on the phase.
     */
    tail?: string;
    /**
     * Why the MACHINE stopped it (`environmentOf`: a dependency not installed,
     * a sibling the export cannot provide, an exit 127, …) — not a red the
     * session inherits (control-tower phase 106, #185).
     */
    environment?: string;
    from: 'reused' | 'measured';
    /**
     * A measured red, run ONCE and never retried (control-tower phase 105,
     * #190): the one recorded retry is the verdict's alone.
     */
    once?: true;
    /**
     * The run that stood in, for a reused line — since control-tower phase 105
     * any plan's of this console (`slug`), with its age when it was reused.
     */
    by?: { phase: number; run: string; at: string; slug?: string; ageMs?: number };
  }[];
  /**
   * Measured BESIDE the session, in a clean checkout of the boarding head
   * (control-tower phase 105, #190 ask 2); false when git would not export the
   * repository and it was measured before boarding, in place.
   */
  concurrent?: boolean;
  /** How long its commands waited under the machine-load guard (phase 100's). */
  loadWaitMs?: number;
};

/**
 * One MCP server a phase asked for and did not get.
 *
 * `reason` is the machine-readable half — it decides which remedy the console
 * offers, since "sign this in" and "this is not registered here" are different
 * errands — and `detail` carries whatever the CLI said, when it said anything.
 */
export type McpDegradation = {
  id: string;
  reason: 'needs-auth' | 'failed' | 'unregistered' | 'switched-off';
  detail?: string;
};

/** The one place the four reasons become the sentence a person reads. */
export function mcpReasonText(reason: McpDegradation['reason']): string {
  switch (reason) {
    case 'needs-auth': return 'needs authentication';
    case 'unregistered': return 'is not registered on this console';
    case 'switched-off': return 'is switched off here';
    default: return 'will not connect';
  }
}

/**
 * One QA round on a phase — a review that HAPPENED, with what it cost.
 *
 * The verdict and the report come from `test-status.md` (through the engine's
 * `--qa-history`), which is the shared work-state every clone reads. The rest —
 * the session, the brief, the spend — is knowable only to the run that boarded
 * the reviewer, and is exactly what issue #7 found missing: "cost, turns, and
 * one word", with the report itself never linked.
 *
 * `verdict` is a plain string rather than the `QaResult` union because it comes
 * off a file a person may have hand-broken; an unparseable cell must be able to
 * arrive here and be shown, not throw.
 */
export type QaRoundRecord = {
  round: number;
  verdict: string;
  /** Relative to the plan's handoff folder, as `test-status.md` records it. */
  reportPath?: string;
  /** The session that produced it, when the run boarded one (a hand-recorded round has none). */
  sessionId?: string;
  /** The instruction that session was given — what "the brief that was sent" means on a card. */
  brief?: string;
  costUsd?: number;
  turns?: number;
  /** When the run observed this round, ISO. Not when the reviewer wrote its report. */
  at?: string;
};

/** Where the landing engine is, per phase — see `PhaseRecord.landing`. */
export type PhaseLanding = {
  /** The policy the plan resolved for this phase (`--land N`). */
  policy: LandPolicy;
  /** The plan's conflict policy, read once at the landing so a mid-run edit cannot change a landing already under way. */
  conflict: ConflictPolicy;
  /** The ledger's word for the phase as a whole: the least-advanced repository. */
  state: LandingState | 'pending';
  /**
   * The engine's own position, which is finer than the ledger's word and is
   * what a restart continues from: `local` (nothing remote has happened),
   * `push` (about to / mid push), `session` (the landing session is owed or in
   * flight), `verify` (a row was recorded and awaits `gh pr view`),
   * `watch` (the PR is open and the watch clock owns it), `done`, `parked`.
   */
  step: 'local' | 'push' | 'session' | 'verify' | 'watch' | 'done' | 'parked';
  /**
   * Where a PARKED landing resumes from on the next drive, when it may: a
   * refused push re-asks the flag, a session that recorded nothing is spent
   * again, a verifier that could not answer is asked again. Absent on a park
   * a person owns (a closed pull request, a conflict, the attempt cap).
   */
  resumeFrom?: 'local' | 'push' | 'session' | 'verify';
  /** One entry per mounted repository the phase touched, keyed by the ledger's repo key. */
  repos: Record<string, PhaseLandingRepo>;
  /** How many times the remote half has been attempted (a restart resumes; it never re-pushes). */
  attempts: number;
  /**
   * How many rebase sessions the LOCAL half spent on a lane conflict (`On
   * conflict: rebase-session`): the plan allows exactly one, so a second
   * conflict parks. Absent means none.
   */
  rebases?: number;
  /** When the landing last moved. */
  at: string;
  /** Why it parked or degraded, in one sentence, for the run page. */
  note?: string;
};

export type PhaseLandingRepo = {
  /** The branch this repository's work is on — the lane branch, else the run branch. */
  branch: string;
  /** The ledger row's state for this repository, as last recorded or verified. */
  state: LandingState | 'pending';
  /** The sha the push put on the remote, once it did. */
  pushed?: string;
  /** The pull request, once the landing session's row was VERIFIED against `gh pr view`. */
  pr?: {
    repo: string;
    number: number;
    url: string;
    state: string;
    mergedAt?: string;
    mergeCommit?: string;
    checkedAt: string;
  };
};

export type PhaseRecord = {
  phase: number;
  status: PhaseStatus;
  /**
   * What the phase IS, and why it stopped — see `shared/run-lifecycle.js`.
   *
   * Written beside `status` by `setPhaseState` under the same dual-write rule
   * as `RunState.lifecycle`. Read through `phaseLifecycle(record)`, never
   * directly, so a record written before 3.5.0 answers identically.
   */
  lifecycle?: PhaseLifecycle;
  attempts: number;
  costUsd: number;
  /** The part of `costUsd` spent on credit past a plan window (control-tower phase 93, #146). */
  creditUsd?: number;
  /**
   * Each session's mark: the last `total_cost_usd` booked for it. A `--resume`
   * re-reports the conversation's running total, so a spawn books only its rise
   * over this (control-tower phase 46, #62; `RunnerBase.bookSpend`,
   * `bookedDelta`). Seeded for a stored run by the boot re-price.
   */
  costHighWater?: Record<string, number>;
  /**
   * How the phase's newest session ended — what `closed()` reads before it
   * calls a missing handoff a failure (control-tower phase 46, #61): a spent cap
   * on a resume is resumed with the cap raised, and a console that shut the
   * session down settles `interrupted`. Written by the spawn door for every
   * session; the caps are the ones it ran under, so a raise doubles the right one.
   */
  lastSession?: {
    mode: SessionMode; sessionId: string | null; at: string; endedBy: EndedBy;
    subtype?: string; terminalReason?: string; maxTurns?: Cap; maxBudgetUsd?: Cap;
  };
  /**
   * The recorded cost is known to be INCOMPLETE — the session really ran, and
   * its spend was never harvested.
   *
   * `costUsd` comes only from the CLI's terminal `result` message
   * (`spawn.ts` `total_cost_usd`), so a child the console's own shutdown killed
   * books `$0` for hours of real work, and `run.spentUsd` never repairs. `$0.00`
   * then reads as "this was free", which is the one thing it certainly was not.
   * Marked rather than guessed: a wrong number is worse than an honest gap, and
   * this is the posture the usage meters already take.
   */
  costUnknown?: boolean;
  /** Turns and wall-clock across every attempt, so a phase can be read at a glance. */
  turns?: number;
  durationMs?: number;
  /**
   * Wall-clock this phase spent stopped by the operator, already subtracted
   * from `durationMs`. Kept rather than merely deducted so "it took two hours"
   * and "it worked for twenty minutes and waited for me for the rest" can be
   * told apart — the second is not a slow phase.
   */
  frozenMs?: number;
  /**
   * One window per session this phase spawned, oldest first (#28) — kept by
   * `openAttemptWindow` / `closeAttemptWindow` / `noteFirstTool` in
   * `shared/phase-clocks.js`, and summed (minus `frozenMs`) into `durationMs`.
   * Absent on a record written before 6.0, which `phaseClocks` reads from its
   * `attemptStartedAt`/`attemptEndedAt` instead.
   */
  attemptWindows?: AttemptWindow[];
  /**
   * Admission waits already over, summed (#28) — `phaseClocks.queuedMs`. Since
   * control-tower phase 60 (#81) every queue EPISODE joins it when it closes,
   * whatever closed it (`queue-episodes.ts`), not only an admission.
   */
  queuedMs?: number;
  /** When the queue episode now open began; cleared when it closes (#28, #81). */
  queuedAt?: string;
  /**
   * The queue entry's AGE — when this phase's current wait first joined a queue
   * (control-tower phase 60, #81). Outlives a withdrawal and a console restart,
   * so the next admission is born this old; only an admission clears it.
   */
  queueSince?: string;
  /** The current wait's queued time over its episodes already closed (#81) — what `phase.admitted`'s `waitedMs` adds up. */
  queueWaitedMs?: number;
  /** The entry had aged into RESERVING before the wait was interrupted (#81); restored at the next admission. */
  queueReserving?: true;
  /**
   * An operator's standing word on this phase's place in the queue
   * (control-tower phase 99, #135 B and E) — `QUEUE_VERBS`. On the RECORD, not
   * the scheduler's entry, so it survives the entry: a pause, a retry, a
   * wrap-up, a relaunch and a restart each re-create the entry, and each new
   * one is born carrying it (`admit`). Absent when nobody said anything.
   */
  queueControl?: QueueControl;
  /** The last moment the open episode was seen waiting — where a restart ends it (#81). */
  queueSeenAt?: string;
  /** The open episode's head holder class and since when (#64) — each stretch is charged to `queuedByClass`. */
  queueHead?: { class: HolderClass; since: string };
  /** Closed queue time by the class of the holder at its head (`HOLDER_CLASSES`, #64). */
  queuedByClass?: Partial<Record<HolderClass, number>>;
  /**
   * This ready phase's scope meets a LIVE lane of its own run in the same tree
   * (control-tower phase 60, #64): it is serial work behind that phase, not a
   * queue — so it never joins one, and reads `ready (behind this run's P<n>)`.
   * Cleared when it boards or stops being a candidate.
   */
  serialBehind?: number;
  /**
   * How many times this phase actually called each attached MCP server, by id.
   *
   * The only honest answer to "was attaching that worth it". Every attached
   * server costs context on every turn and adds names that can collide with
   * another server's tools, so the advice everyone converges on is three to six
   * — but nobody can act on that advice without knowing which of their six were
   * ever touched. Absent means the phase attached none, or ran before this was
   * recorded; zero for an id means it was attached and never used, which is the
   * interesting number.
   */
  mcpCalls?: Record<string, number>;
  /**
   * A session to hand to `--resume` when this phase next runs, left behind by a
   * freeze that was checkpointed. Cleared as soon as it is used: a session id
   * offered twice is the "Session ID … is already in use" refusal that killed
   * two real retries.
   */
  resumeSessionId?: string;
  model?: string;
  /** The reasoning effort this phase ran at. */
  effort?: string;
  /** What the session's own `init` message said it was running on. */
  actualModel?: string;
  sessionId?: string;
  /**
   * The account `sessionId`'s transcript was recorded under. What the port
   * needs when a resume happens under a DIFFERENT account: the file lives in
   * the config dir of the account that wrote it, not the one about to read it.
   */
  sessionAccountId?: string;
  /**
   * A session `--resume` can no longer reach — the CLI answered `No
   * conversation found with session ID`, or its transcript could not be
   * carried to the account paying. Stamped once by the runner, read by every
   * "is this resumable?" predicate (`isSessionGone`), and outlived by a fresh
   * session id: a new `sessionId` is a different conversation, so the marker
   * names the id it is about rather than being cleared.
   */
  sessionGone?: { sessionId: string; at: string; reason: string };
  startedAt?: string;
  endedAt?: string;
  note?: string;
  gate?: { clear: boolean; kind: string; detail: string };
  /**
   * Boarding-preflight warnings for the phase's §Verification — refused
   * fragments, cwd-sensitive commands with no `Verify in:`, leads missing
   * from the PATH. Non-blocking by design, but they used to live only in the
   * journal, which nothing renders: an operator's first sight of them was the
   * verification failing an hour later. Overwritten each boarding, absent
   * when clean, cleared on retry.
   */
  preflight?: string[];
  /**
   * The same findings, structured for the UI — `preflight`'s string shape is
   * frozen for old readers; this is what a page filters and badges by. The 44
   * journal-only warnings that predicted the dominant halt class had no
   * surface at all before this field existed.
   */
  preflightDetail?: PreflightWarning[];
  /**
   * MCP servers this phase asked for and boarded WITHOUT, under `continue`.
   *
   * The receipt for a degraded run. A phase that quietly did without half its
   * tools and a phase that had all of them look identical in the handoff
   * afterwards, so the fact is recorded where the run page and the operator's
   * notification both read it. Overwritten each boarding, absent when every
   * server connected, cleared on retry — exactly like `preflight`.
   */
  mcpDegraded?: McpDegradation[];
  /**
   * The credentials the plan named for this phase that the console could not
   * find before the spawn (phase 11, ZTD-4), under `credential policy:
   * continue` — the phase boarded and was told. Overwritten each boarding,
   * absent when every named credential is held or none is named; the
   * `require` case parks instead and writes none.
   */
  credentialsMissing?: { id: string; reason: string }[];
  /**
   * Where this phase's LANDING has got to — the console's own copy of what the
   * ledger (`docs/handoffs/<slug>/landing.md`) records, plus the steps the
   * ledger does not hold (a push that succeeded but was not yet recorded, a
   * session in flight). Written by the landing engine (Pro,
   * `server/pro/landing/engine.ts`); absent on every phase of a plan whose
   * policy is `hold` and on every record written before 5.1.0.
   *
   * `state` is the LEDGER's word for the phase as a whole (worst repository
   * wins); `step` is the engine's own position, which is what a restart
   * resumes from (`resumeLanding`). `repos` is keyed by the mount's
   * root-relative path (`''` for a plain repository or the root itself), which
   * is the ledger's own key.
   */
  landing?: PhaseLanding;
  /**
   * The `require` park this record is sitting in: when it began and which
   * servers it waits for. The resource ladder's clock reads `at` — after
   * `mcpRequireTimeoutMs` the phase continues without them, with an errand —
   * and `degraded` is what the errand and the boarding name. Cleared on
   * retry with the rest of the park (`resetForRetry`). Records written before
   * this field existed never time out; they wait for a heal or a person, as
   * they always did.
   */
  mcpPark?: { at: string; degraded: McpDegradation[] };
  verification?: VerifySummary;
  /**
   * Where the verification commands actually ran, relative to the run's root
   * (`.` for the root itself). Recorded because a suite that passed in the
   * wrong directory and one that passed in the right one look identical
   * afterwards — and for a whole class of monorepo plans the first is what was
   * happening. Set from the plan's `**Verify in:**`, or `.` when it says
   * nothing or names a directory that is not there.
   */
  verifiedIn?: string;
  /**
   * Every QA ROUND this phase has been through, oldest first.
   *
   * The run record carried no QA at all before this: cost, turns and one word
   * in a journal line, while the report the QA method REQUIRES the reviewer to
   * write was never read back, never linked and never rendered on any run
   * surface. A verdict appeared only on the Plans destination, parsed out of
   * `test-status.md`, showing the final row alone — so on the run this was
   * written from, ten of the twelve phases' earlier rounds were invisible to
   * the API and to every screen while costing real money.
   *
   * Sourced from the engine's `--qa-history` (which reads `test-status.md`, the
   * shared work-state) and enriched with what only the run knows: the session
   * that produced the round, the brief it was given, and what it spent. Absent
   * on every record written before this shipped, so read it as `?? []`.
   *
   * It is HISTORY, so it survives an operator Retry the way `verification` and
   * the session ids do — a phase re-boarded for a third attempt has still been
   * reviewed twice, and forgetting that is how a QA budget resets itself.
   */
  qa?: QaRoundRecord[];
  /**
   * A QA round in flight on this phase — set the moment the reviewer is
   * spawned, cleared when it ends. The board reads the phase `done` the whole
   * time (a review happens AFTER the work), so without this marker no pane
   * existed for the session the run was paying for. Read-path settle clears it
   * when no child of the run holds work, so a console crash leaves no phantom.
   */
  qaSession?: { round: number; report: string; verb?: string; sessionId?: string; startedAt: string };
  lint?: { ok: boolean; summary: string; crashed?: boolean };
  /**
   * The one continuation this phase is allowed when its session exits without
   * writing a handoff — recorded so a second attempt cannot happen by accident,
   * and so the panel can say a closeout was tried and what came of it.
   */
  closeout?: {
    at: string; ok: boolean; sessionId?: string; note?: string;
    /**
     * The closeout session's own closing words. Kept HERE, never written over
     * `said` below: the halt that follows a failed closeout quotes the PHASE
     * session (the words that explain why no handoff was written), and the
     * closeout's "I could not" used to overwrite them before the halt read them.
     */
    said?: string;
  };
  /**
   * The session's own closing words. When a phase exits clean and changes
   * nothing this is the only account of why, and it used to live solely in the
   * journal — so the halt said "no handoff was written" and the reason it was
   * not written took a manual dig through NDJSON to recover.
   *
   * The PHASE session's words — a wait-resume or an operator-instructed resume
   * is the same session continuing and may update it; a closeout's words go to
   * `closeout.said`.
   */
  said?: string;
  /**
   * The session's own task list, as it last published it.
   *
   * Folded here — not merely streamed — because the panel that renders it has
   * to survive a reload and a console restart, and because the stream's own
   * replay is a 400-entry tail that excluded every `create` in a measured
   * 10,792-entry run: the list arrived as updates to rows the browser had
   * never seen. The record is the complete fold; the stream is the live edge.
   *
   * Written by `runner/tasks.ts` from `PE_TASKS_FILE` and by `onStream` from
   * the CLI's own task tools, through one `foldTaskEvent` so the two sources
   * cannot build different lists.
   */
  tasks?: TaskItem[];
  /**
   * How far the active task's long operation has got, as the session last
   * said with `phase-outcome.sh … progress` (control-tower phase 95, #163) —
   * `task` is the id that was in progress when it was said. Journalled as
   * `phase.progress`; cleared with the task list.
   */
  progress?: { label: string; done: number; of: number; at: string; task?: string };
  /**
   * How far into `PE_TASKS_FILE` the tail has read, in bytes.
   *
   * Persisted with the record rather than held on the lane, because the offset
   * and the list it produced must stay consistent across a console restart: a
   * restart that re-read the file from zero onto a list already holding those
   * rows would double every task on it.
   */
  tasksAt?: number;
  /**
   * When the CURRENT attempt's boarding started (ISO) — rewritten per boarding,
   * unlike `startedAt`, which is set once at the phase's first boarding and is
   * the commit window `producedWork` measures from. The outcome protocol's
   * staleness guard (`readOutcome` `notBefore`) reads THIS one: an outcome file
   * written by an earlier attempt must never speak for the next.
   */
  attemptStartedAt?: string;
  /**
   * How the ladder asked this phase to board next (`runner.ts` boarding picks
   * the brief by it). Written by the drive loop's own classification, by
   * `closed()` on a stuck board, by a `partial` outcome, or by a caller of
   * `start({reboard})` (the convergence loop); consumed — deleted — the moment
   * the session spawns, and cleared by an operator Retry (`resetForRetry`),
   * which always means a fresh boot.
   */
  boardingHint?: BoardingHint;
  /**
   * The operator's edits for the NEXT boarding of this phase, and only that
   * one. Written by Retry-with-edits, read by `optionsFor` and the prompt
   * assembly, deleted the moment the session it asked for exists. See
   * `RetryOverride`.
   */
  retryOverride?: RetryOverride;
  /**
   * The errand tree a person asked for (control-tower phase 90, #123):
   * `.worktrees/hand/<slug>/p<N>-errand`, detached at the pushed run branch in
   * every repository the run mounts. A parked phase's `!` lines belong there —
   * the run's own mirror is pruned on the console's schedule, this one only
   * when a person removes it. The errand card names it.
   */
  errandTree?: { dir: string; at: string; by: string; mounts: { rel: string; sha: string; pushed: boolean }[] };
  /**
   * The plan this phase's session last presented through `ExitPlanMode`
   * (control-tower phase 11, #34): its sha256, its size, where the console
   * kept the text, and what became of it. `pending` is a plan a person has
   * not decided yet — the one state the inbox offers Approve and Reject for.
   */
  planApproval?: {
    sha: string;
    bytes: number;
    path: string;
    at: string;
    sessionId?: string;
    truncated?: boolean;
    state: 'pending' | 'approved' | 'rejected' | 'continued';
    by?: string;
    reason?: string;
    decidedAt?: string;
  };
  /**
   * The boarding belt-check's backoff against a foreign lock the scheduler's
   * store-fed view has not caught up with. Doubles 1 s → 30 s per refused
   * boarding so the loop re-boards at most once per half minute against a
   * stale store instead of ~1 Hz; reset on a successful claim.
   */
  lockBackoffMs?: number;
  /**
   * When a `waiting` park elapses and the runner re-checks / resumes. Absolute
   * ISO so a console outage does the right thing on boot: an expired clock
   * resumes immediately, an unexpired one re-arms for the remainder.
   */
  parkedUntil?: string;
  /** The session's own words for what it is waiting on. */
  parkReason?: string;
  /** Machine-ish refs for the external things being waited on (`gh:…#run/N`, `lock:slug/N`). */
  watch?: string[];
  /**
   * Declared refs no watch scheme can parse, each with why (WAI-11). Nothing will
   * ever probe them, so they are named on the park instead of dropped in silence.
   */
  watchUnpollable?: { ref: string; reason: string }[];
  /**
   * When the park now holding (or the last one) began — split off `endedAt`,
   * which used to mean "the park began", "the attempt ended" and "a session
   * ran" at once, and so measured parked time from the wrong instant (WAI-4).
   */
  parkedFrom?: string;
  /**
   * Parked because the session started on another model than the one the
   * phase is pinned to (control-tower phase 54, #91, `phase.model-mismatch`).
   * Read with the status: a phase that boards again keeps the fact, not the park.
   */
  modelMismatch?: { requested: string; resolved: string; at: string };
  /**
   * The usage wall this park waits on, when it is one (control-tower phase 54,
   * #78): the wall's reset is "until at the latest", never the clock taken on
   * trust. `Runner.rereadWalls` asks the account's headroom on every fresh
   * reading, every spend and a back-off re-probe (`probes` of them so far), and
   * lifts or shortens the park — never lengthens it. `latest` is the reset the
   * park began with; `lastReading` is what the newest re-read answered. It ends
   * with its park: every boarding and every re-board deletes it, so no later
   * park is ever read as a wall.
   */
  usageWall?: {
    account: string; bucket: string; latest: string; probes: number;
    lastReading?: { at: string; by: 'reading' | 'spend' | 'reprobe'; ok: boolean; resetsAt?: string };
  };
  /** When the last attempt's session ended — the other meaning `endedAt` carried. */
  attemptEndedAt?: string;
  /**
   * Every park this phase took, from its own stamps — what `parkedMsOf`
   * (`wait-budget.ts`) sums, so parked time is correct with no resume at all.
   * Capped at `WAIT_HISTORY_MAX`; older entries fold into `parkedMsCarried`.
   */
  waitHistory?: WaitEntry[];
  /**
   * This phase's budgets already warned at `BUDGET_WARN_PCT` (control-tower
   * phase 14, #40): budget → the attempt-and-limit key it was claimed under,
   * so each warns once per attempt and again after a raise.
   */
  budgetWarned?: Record<string, string>;
  /**
   * A budget past its warning line and not yet raised (control-tower phase 25,
   * #40): budget → the fact as `noteBudgetApproaching` measured it, so the run
   * page draws the approach with its raise before the park. A raise removes it.
   */
  budgetApproaching?: Record<string, BudgetFact>;
  /** Declared parked time folded out of the history (or accrued before it existed). */
  parkedMsCarried?: number;
  /**
   * How many times the CONSOLE parked this phase by itself (the stall
   * watchdog's automatic park). Its own ledger: it never spends `waits` or the
   * declared budget (WAI-5).
   */
  watchdogParks?: number;
  /**
   * The API's safeguards flagged this phase's sessions (control-tower phase
   * 111, #177): how many times, and what was tried in answer — in the words
   * the person's park says them ("a fresh session", a model's name). The
   * third flag asks a person; an operator's Retry starts the count again.
   */
  safeguard?: { flags: number; tried: string[] };
  /**
   * Every status this phase's sessions have DECLARED, counted (WAI-8, SLF-4).
   * `waits` counts only the two `waiting-external` parks; this ledger counts
   * all six words, so a `partial` or a `needs-human` re-filed for free has a
   * bound too. `count` is acts taken on that word, `lastAt` the last time it
   * was declared, `refused` the declarations recorded as evidence and NOT acted
   * on — past the cap (`DECLARATIONS_MAX_PER_PHASE`) or inside the cooldown
   * (`DECLARATION_COOLDOWN_MS`, unsupervised paths only). Cleared by an
   * operator's Retry and by nothing automatic.
   */
  declarations?: Partial<Record<OutcomeStatus, DeclarationLedgerRow>>;
  /**
   * The `parkedUntil` whose overrun has already been announced once as
   * `park-overdue` (WAI-6). A dead clock is announced when the inbox row would
   * first appear, never again for the same clock, and a restart does not repeat
   * it because the stamp rides the record.
   */
  parkOverdueAnnouncedFor?: string;
  /**
   * The last `--resume` the console refused because the session it would
   * resume is still live (REG-1) — shown on the phase, cleared when a resume
   * or a fresh boarding goes ahead.
   */
  resumeRefused?: { sessionId: string; at: string; why: 'session-live' | 'session-lease'; pid?: number; lock?: string };
  /**
   * This phase's replay file crossed 80 % of its cap (`near-full`) or reached it
   * (`full`) — journalled once per file as `phase.replay-limit` and kept here
   * for the card (control-tower phase 94, #133). Past `full` the live view still
   * streams; nothing more of this phase is replayed.
   */
  replay?: { state: 'near-full' | 'full'; bytes: number; cap: number; at: string };
  /**
   * The outcome the session itself declared (`phase-outcome.sh`), persisted so
   * the situation classifier still sees it after the run stops, the console
   * restarts, or the halt loses its kind. Written by the runner's outcome
   * ingestion; cleared when a new attempt boards, on Retry, and when the
   * board closes the phase. Without it, a declared needs-human park was
   * re-classified from prose — and a park note that merely MENTIONED
   * §Verification read as "the plan is broken" (the aug-27 filters p12
   * incident: three rungs burned re-confirming a production outage, then the
   * honest errand overwritten with a plan-repair prescription).
   */
  declared?: {
    /* `no-defect` joins the three parks here as a REPAIR session's testimony —
     * "I looked, and there was nothing to fix". It parks nothing and asks for
     * nobody, so every reader that acts on a declaration (the classifier's
     * arm 5, the watch scheduler, the errand writers) goes on ignoring it; what
     * it buys is that the record still SAYS what the session concluded, instead
     * of the silence a rung then gets blamed for. */
    status: 'waiting-external' | 'blocked' | 'needs-human' | 'no-defect'; reason?: string; watch?: string[]; at: string;
    /**
     * Who wrote this declaration (SLF-9): the session itself, a hand session
     * through the inbox, or the console's own watchdog. A watchdog-authored
     * wait is the console's inference, never the session's testimony.
     */
    by?: WaitAuthor;
    /** The instant a `waiting-external` declaration asked for, when it named one. */
    requested?: string;
    /** Refs the CONSOLE minted into `watch` (the watchdog's `cmd:`), never the session's. */
    minted?: string[];
    /**
     * The decision key a `blocked`/`needs-human` declaration named with
     * `--needs` (chapter 10 ZTD-3) — read by the classifier BEFORE the prose,
     * so the sub-kind is the session's word rather than a regex's guess.
     * Absent on a declaration written without one (a 4.1.0 session, a
     * `waiting-external`). `rule`/`command` structure a permission block.
     */
    needs?: string;
    rule?: string;
    command?: string;
    /**
     * The landing that resumed this declaration, written ON the declaration
     * rather than beside it.
     *
     * It belongs here because it is a fact ABOUT the session's own testimony —
     * "the thing you said you were waiting for is done" — and because the two
     * must be retired together: `consumeDeclaration` drops the declaration when
     * the session produces work, and a landing that outlived it would resume a
     * phase against a wait nobody is holding any more. `resumes` is the count at
     * the moment of this landing, so a resume brief can say "the third time".
     */
    landed?: {
      ref: string; detail?: string; at: string; resumes: number;
      /** A person's turn proven (phase 43): the resume says the step was done, not that external work landed. */
      step?: { id: string; kind: string; by: string };
    };
    /**
     * The phase's wait budget as the PARK read it (`--wait-budget N`, else the
     * console default) — stamped on a `needs-human`, `blocked` or
     * `waiting-external` declaration so the two synchronous readers that end
     * with it can ask without an engine call: the watch clock stops running a
     * `cmd:` ref at `waitBudgetEndOf`, and the scope fence lifts there
     * (control-tower phase 6, #19). Absent on a declaration written before
     * the stamp; `waitBudgetEndOf` reads the console default for it.
     */
    budget?: {
      ms: number; source: 'phase' | 'plan' | 'default';
      /** The declared-wait count in force, when a plan raised it (control-tower phase 121, #40). */
      waits?: number; waitsSource?: 'phase' | 'plan' | 'default';
    };
    /**
     * The human step this declaration raised (control-tower phase 41): its
     * ledger id and kind — the step itself lives in `human-steps.ndjson`. A
     * declaration with a step is a person's turn: situation
     * `blocked-declared:human-acts` (person, no rungs), no wait budget.
     *
     * `proof` and `until` ride here from phase 43, so the watch scheduler can
     * poll the proof straight off the record and stop a `cmd:` proof at the
     * step's window rather than at a wait budget; `settled` is written when
     * the step is expired, refused (*I can't do this*) or dismissed, and ends
     * that watch.
     */
    step?: { id: string; kind: string; proof?: string; until?: string; settled?: 'proven' | 'declined' | 'expired' | 'cannot' | 'dismissed' };
    /**
     * Set when this declaration met a SPENT wait budget (control-tower phase
     * 45, #59): the phase parks `waiting` with no clock and a `budgets` errand
     * — never `failed`, never a streak charge, never a rung — and its refs go
     * on being watched, so a landing still resumes it (`parkOnSpentBudget`).
     * `ledger` is which allowance ran out: the hours (`budget`), the count of
     * declared waits (`waits`), or the console's own parks (`watchdog`). A
     * `cmd:` ref keeps running past the budget's end on such a park, bounded
     * by its per-phase run cap, because nothing else can end the wait.
     */
    budgetSpent?: { at: string; ledger: 'waits' | 'budget' | 'watchdog' };
    /**
     * Set when the RUNNER parked this `blocked` declaration on the refs it
     * names (control-tower phase 87, #122, #126): the table's `poll-park` rung,
     * driven by the loop itself rather than deferred to a healer that only
     * acts on a stopped run. The phase waits `waiting` exactly as a
     * `waiting-external` one does — phase 45's budget, phase 50's window — and
     * its window or its landing resumes its own session; the status stays the
     * session's word, so the sub-kind, the errand and the resume brief still
     * read a block.
     */
    parked?: 'poll-park';
  };
  /**
   * The watch poller's last verdict about this phase's refs — bookkeeping so
   * converge sweeps journal transitions once, not every pass.
   *
   * ⚠️ Kept for readers written before `watchState` (below) existed: it holds
   * ONE ref, whichever was probed last, which is why a phase watching a run and
   * a deadline could only ever show one of them. New readers take `watchState`.
   */
  watchChecked?: { at: string; ref: string; state: WatchStateWord; detail?: string };
  /**
   * Every declared ref this phase is being watched on, and when each is next
   * due — **a CONTRACT**: the scheduler writes it, the engine-parity readers and
   * the Pulse read it, and it is persisted with the run, so a shape change here
   * is a shape change for a checkpoint written by an older build.
   *
   * Written ADDITIVELY: a ref that was not probed on this pass keeps the row it
   * had. `refs` is capped at 8 — the same bound `phase-outcome.sh` puts on
   * `--watch` — so a malformed declaration cannot make the record grow without
   * limit.
   */
  watchState?: {
    at: string;
    refs: {
      ref: string;
      scheme: 'gh-run' | 'gh-pr' | 'date' | 'lock' | 'phase' | 'verify' | 'cmd' | 'unit' | 'credential';
      state: WatchStateWord;
      detail?: string;
      checkedAt: string;
      /** Epoch ms. Absent means "never again" — a refused ref. */
      nextDueAt?: number;
      /**
       * How many times a `cmd:` ref's command has actually been EXECUTED for
       * this phase. Only `cmd:` rows carry it, because only `cmd:` runs
       * anything, and a probe that ran nothing (the pref is off) is not counted;
       * bounded by `MAX_CMD_RUNS_PER_PHASE`.
       */
      runs?: number;
      /**
       * Epoch ms of the last delivery of this LANDING that actually launched a
       * resume — history for a person and the Pulse, NOT a gate.
       *
       * Written by `resumeOnWatchLanded` beside the charge it records — never
       * by the scheduler — and deleted again by the settlement that finds the
       * drive launched nothing, so a standing value marks the last delivery
       * that really launched (or one still in flight). The hold against
       * re-offering a landing comes from the things that can observe it: the
       * healer's un-settled drive (`resumeInFlight`) and the record's own
       * status while a session runs. A receipt the scheduler signed before the
       * work happened gated one landing for ever, silently (QA round 3, H1).
       */
      deliveredAt?: number;
      /**
       * The console minted this ref itself — the watchdog lifted it out of a
       * poll loop (SLF-9, SLF-8) — rather than the session declaring it. Marked
       * so it is never mistaken for the session's instruction; whether a minted
       * `cmd:` is ever executed is `watch-scheduler.ts`'s policy.
       */
      minted?: true;
      /**
       * A `gh-run` GitHub never started (control-tower phase 111, #166) — what
       * the probe read. Kept on the row: the next reading's room is a landing
       * only against this one's spent budget, and the Tower draws one state
       * per repository from it (`shared/ci-refusal.js`).
       */
      notRun?: CiNotRun;
    }[];
  };
  /**
   * How many times a LANDED watch ref has resumed this phase. Bounded, because
   * a landed ref stays landed: without a count the healer would resume the
   * phase on every sweep for ever. Retired with the declaration it bounds
   * (`clearWatchBookkeeping`) — left standing across declarations, a phase's
   * second wait started life over the cap and got zero offers (QA round 3, H2).
   * A delivery whose drive launched nothing is un-charged at settlement
   * (`voidWatchDelivery`).
   */
  watchResumes?: number;
  /**
   * The watch ref whose landing already produced an over-cap errand. The
   * errand is written, announced and saved ONCE per landing; without this the
   * healer re-wrote it on every converge sweep, because a landed ref stays
   * landed and only its journal line was deduped.
   */
  watchLandedErrandFor?: string;
  /**
   * Landed refs the healer answered `done` for — nothing in this declaration
   * waits on them any more (the phase moved on, or the ref was the console's
   * own) — so the scheduler never offers them again (control-tower phase 87,
   * #126). Deleting only the row's `nextDueAt` made a landed row read "due"
   * again, and the same landing was offered and retired every minute. Cleared
   * with the rest of the watch bookkeeping: a NEW declaration naming the same
   * ref is a new wait, watched afresh.
   */
  watchLandedDone?: string[];
  /**
   * The watch refs whose landings have already been journalled
   * `phase.watch-landed` — a SET, one entry per ref (RCV-8).
   *
   * A landing is re-offered until a resume actually starts, so an unconditional
   * line said the world had landed once per delivery — four times for one event,
   * three of them reporting a change that was the console's own willingness to
   * act rather than anything outside it. And one string was not enough: two refs
   * landing on one phase overwrote each other's stamp and both re-journalled on
   * every redelivery — 56 lines for two landings. A record written before this
   * was a set carries a bare string; `settle` folds it into a one-element list.
   */
  watchLandedJournalledFor?: string[];
  /**
   * The healer's rejections of this phase's landed watch refs, bounded (SLF-8,
   * RCV-8). A drive that throws for a reason OUTSIDE the phase — a foreign
   * lock, a lease, a live runner — used to un-charge `watchResumes` (right: it
   * launched nothing) and so could never reach the over-cap errand; it was
   * retried every minute for the whole lease, 134 warnings in 108 minutes.
   * This counter is what bounds it: past `MAX_WATCH_REJECTIONS` the landing
   * becomes the same errand an over-cap delivery does. `until` is the clock the
   * rejection named (a lease end), which the re-offer backs off to; `reason` is
   * the message, so a repeat inside one lease is logged once.
   */
  watchRejections?: { count: number; lastAt: string; reason: string; until?: number };
  /**
   * `cmd:` refs this phase will never probe again — refused by the verify
   * policy, or run `MAX_CMD_RUNS_PER_PHASE` times without landing (SLF-8).
   * Deliberately NOT cleared by `clearWatchBookkeeping`: a new declaration of
   * the same command is the same command, and the world's answer to it was
   * final. Only an operator's Retry un-retires (`resetForRetry` by `operator`).
   */
  watchRetired?: string[];
  /**
   * How many waiting-external parks this phase has taken. Capped: a phase that
   * keeps re-filing the same wait is not waiting, it is stuck, and the cap is
   * what turns that into an honest halt instead of an infinite quiet loop.
   */
  waits?: number;
  /**
   * Declared parked time at the last evaluation — a CACHE of `parkedMsOf` for
   * readers and the page. The budget is never read from it once `waitHistory`
   * exists; on a record from before the history it is the legacy accrual.
   */
  parkedMs?: number;
  /**
   * When this phase first started waiting on a foreign LOCK (queued-behind-a-
   * holder). Bounds the lock wait: past the cap the phase parks honestly with
   * the holder named instead of queueing forever behind a dead-but-unexpired
   * claim.
   */
  lockWaitSince?: string;
  /**
   * WHO the queue says this phase is waiting behind — the durable sibling of
   * `lockWaitSince`'s WHEN. Stamped when the lane announces `queued`, cleared
   * when the wait ends any way at all (granted, parked at the cap, or Retry).
   * The inbox reads the owner to tell another plan's holder from this run's
   * own sibling lane: queueing behind a sibling is pipelining, not a stall.
   */
  waitingOn?: {
    slug: string;
    phase?: number;
    owner: string;
    /**
     * How much longer the holder's own plan has (`Holder.eta`).
     *
     * The one question an operator asks of a queue that the record could not
     * answer. Absent when nothing is known — a plan with nothing finished has
     * no measurable rate, and a number invented here would be indistinguishable
     * on the card from a measured one.
     */
    eta?: HolderEta;
    /**
     * What KIND of holder this is (`HOLDER_KINDS`). Written for the scope
     * fence (`fence`, control-tower phase 6) and absent on the queue's own
     * shadows, which name another claim by slug and owner as they always did.
     */
    kind?: HolderKind;
    /** A `fence` holder's live watch refs — what the fencing phase is still waiting on. */
    refs?: string[];
    /** When a `fence` lifts by itself: the fencing phase's wait budget end (epoch ms), null for none known. */
    until?: number | null;
    /** A `fence` holder's declaration instant — which wall this fence is (`declared.at`). */
    wall?: string;
    /** A `branch` holder's repository, root-relative (`.` for the root). */
    repo?: string;
    /** A `branch` holder's branch — the one the repository stands on. */
    branch?: string;
    /** A `branch` holder's run — the run that put the repository there. */
    run?: string;
  }[];
  /**
   * An operator's act that took this phase's wall DOWN as a fence — a Retry
   * (`resetForRetry` by `operator`) or a Release of its lock — stamped so the
   * siblings it fenced read WHY the fence lifted (`phase.fence-lifted`). It
   * outranks only the declaration it post-dates: a later wall fences again.
   */
  fenceLifted?: { why: FenceLiftReason; at: string };
  /**
   * How this PHASE stopped, when it stopped for a reason that is about the
   * phase and not about the run (`shared/recovery-model.js` `PHASE_HALT_KINDS`).
   *
   * The runner used to write every ending into `state.halt`, which flipped the
   * RUN to `halting` and drained every queued sibling lane — 125 `phase.not-started`
   * events reading "the run was stopped / halted while this phase waited for its
   * scope", later re-read as `never-started` and answered by re-boarding a phase
   * that had never had a chance. `settlePhase()` writes here instead: the phase
   * is settled with its reason and kind, the run keeps its other candidates, and
   * the classifier reads `rec.halt ?? state.halt` so nothing downstream had to
   * learn a second vocabulary.
   */
  halt?: {
    at: string; reason: string; phase?: number; kind?: HaltKind;
    /**
     * How many registered accounts the breaker refuses, and how many there
     * are — written on a halt whose remedy might be "use another account", so
     * the halt card can say whether there IS another one. Four runs once read
     * "halted — the API refused the connection" while the fact that every
     * account on the machine was unusable lived on a page nobody opened.
     */
    accounts?: { unusable: number; total: number };
    /**
     * `credential-refused` (control-tower phase 54, #57): what the refusal
     * stood on — a kind the API returned or a sentence on its error channel,
     * the words, and whose stop — so the halt says why, not only that.
     */
    evidence?: RetirementEvidence;
  };
  /**
   * What the classifier last said this phase's situation was (`situation.ts`),
   * with the `id:sub` key the journal and the rung history use. Written by
   * whoever classified (the healer, the diagnosis read path, later the
   * convergence loop) — a cache for the phase table, never an input to the
   * next classification, which always re-reads the evidence.
   */
  situation?: {
    key: string; at: string; why?: string[];
    /**
     * The evidence fingerprint (`converge.ts` `evidenceFingerprint`) the
     * healer classified under, and who did (RCV-9). A pass that re-derives
     * the same key from the same fingerprint writes no new `phase.situation`
     * line — the record already says it, and 1 332 lines of "still parked"
     * every five minutes is a journal nobody can read.
     */
    fingerprint?: string;
    by?: ClassifiedBy;
  };
  /**
   * The WALL this phase last stopped on, as the runner's own classifier named
   * it — stamped by the halt, read by the situation classifier before any
   * prose (zero-touch-console phase 9, RCV-2/SES-3). The defect it closes: a
   * refused credential halted the phase; the healer classified the RESULT of
   * each rung it then climbed (`no-handoff` → `done-unrecorded`; a reset
   * record → `never-started`) as a fresh situation with an untried rung, and
   * answered one wall with five paid remedies. With the cause on the record,
   * `resource-wall:auth` is the answer however the last attempt looked.
   *
   * Carried across every console re-board (`prepareReboard` keeps it, like
   * `said`); cleared by an operator's Retry and by a boarding that actually
   * spawns — the admission door proved the wall no longer refuses.
   */
  cause?: {
    kind: 'credential-refused';
    /** The refusal's class when the classifier named one; the admission door (a `retired` breaker) knows none. */
    class?: CredentialClass;
    reason: string;
    at: string;
    /** The account the credential belonged to, when the run named one. */
    account?: string;
    /** What the refusal stood on (#57) — the same evidence the retirement keeps. */
    evidence?: RetirementEvidence;
  };
  /**
   * The last tool call THIS CONSOLE refused for the phase (`phase.tool-denied`
   * — the hook's own decision, never the CLI's). First-class evidence for
   * `blocked-declared:permission` (LFC-3): the corpus held 50 of these and the
   * classifier read none, deciding the sub-kind from the session's prose
   * instead — `:unknown` 267 times, each one an unblock session walking into
   * the wall the console had already recorded. `rule` is the deny-list line
   * (or `in-turn-wait` for the guard that refuses waiting inside a turn, which
   * is NOT a permission block — the session was told what to do instead);
   * `command` is bounded. Cleared with `cause`.
   */
  toolDenied?: {
    tool: string;
    rule: string;
    command?: string;
    matched?: string;
    at: string;
  };
  /**
   * Every wall this phase's lane met, newest last (control-tower phase 135,
   * #212): the console's own hook (a deny rule, every guard) and the CLI's own
   * refusal (a tool outside the allow list, an MCP tool not granted). The
   * evidence a `permission` item cites — G5 refuses a declaration that names
   * none of them. At most `WALLS_KEPT`; cleared with `toolDenied`.
   */
  walls?: RecordedWall[];
  /**
   * What this phase's lane looked like when it was last measured
   * (`runner/liveness.ts`) — the last output, the last tool call, the turns
   * since one, whether the tree has anything in it, and the call that has been
   * open longest.
   *
   * Persisted rather than kept only in the runner's memory, because the
   * question it answers outlives the lane: a console restarted while a phase
   * was silent still has to be able to say the phase was silent, and the inbox
   * — which is computed on read, from disk, with no runner necessarily alive —
   * has nowhere else to read it from. Stale by construction once the lane is
   * gone; every reader pairs it with the record's own status.
   */
  liveness?: LaneLiveness;
  /**
   * What each session of this phase cost in context, newest last, at most
   * `MAX_TOKEN_ATTEMPTS` (autopilot-token-drain phase 3; `runner/usage.ts`).
   * Written when a session ends, by `spawnSession` — the same moment
   * `phase.tokens` is journalled — for every session that made an API call.
   *
   * HISTORY, like `qa`: it survives a Retry and a re-board. Phase 4's resume
   * gate reads the entry for the session it would resume (its `lastContext`,
   * `endedAt`, `resumed`). Absent on every record written before this shipped.
   */
  tokens?: TokenAttempt[];
  /**
   * The context wrap-up this phase's session was sent at `CONTEXT_WRAPUP_FRACTION`
   * of its window — which session, at what context, and whether it arrived.
   * Spent once per SESSION: a `--resume` of the session already told is not told
   * again, a new session is.
   */
  contextWrapup?: ContextMark;
  /**
   * How many times the phase was re-boarded fresh because its session obeyed
   * the wrap-up notice (`phase.resume-automatic {path: 'wrapup'}`) — the
   * console's own park, spending no rung (control-tower phase 5, #14).
   */
  wrapupResumes?: number;
  /**
   * The checkpoint the console took at `CONTEXT_CHECKPOINT_FRACTION` of the
   * window: the session it ended, and the context it ended at. The next attempt
   * boarded fresh with the resume brief rather than `--resume` it — what Phase 4's
   * gate reads to refuse resuming that session by any other path.
   */
  contextCheckpoint?: ContextMark;
  /**
   * The newest `partial` declared for this phase — which session, why, when
   * (autopilot-token-drain phase 4). The resume gate reads it: a session that
   * declared `partial --reason budget|context` said itself that it is spent, so
   * the next attempt boards fresh with the resume brief rather than `--resume` it.
   * Kept like `contextCheckpoint`, replaced by the next `partial`.
   */
  lastPartial?: PartialMark;
  /**
   * The stall episode in progress, when there is one. Written when a signal
   * first holds and DELETED when it clears — its presence is the episode, so
   * `phase.stall` is journalled once per episode rather than once per tick.
   *
   * Cleared by `resetForRetry`: an operator pressing Retry is asking for a
   * fresh boot, and a stall inherited from the attempt they gave up on would
   * announce itself again the moment the new one started.
   */
  stall?: StallState;
  /**
   * What the console SUSPECTS of this lane, and has deliberately not acted on
   * (many-plans-one-repo phase 13). Today one kind: `loop` — three identical
   * failing tool calls in a row. Written once per (phase, attempt, call) and
   * cleared with the rest of the attempt's evidence on a retry, so a suspicion
   * inherited from the attempt an operator gave up on never speaks twice.
   *
   * Deliberately separate from `stall`, which is a live EPISODE the ladder acts
   * on. This is testimony: it is kept after the episode clears, because the
   * question it answers — "what did this lane look like when it went wrong" —
   * is asked after the fact.
   */
  suspect?: PhaseSuspect;
  /**
   * What the silent-session watchdog has already done about this phase.
   *
   * Absent means "never" — no rung has ever been climbed — which is the state
   * every record written before the watchdog existed is in, and the state a
   * phase that simply never went silent stays in.
   *
   * It is the BOUND, not a log: the watchdog's one promise is nudge once,
   * recycle once, and then stop, and the promise is only keepable if what it
   * already did survives the checkpoint that ends the attempt. So this is
   * deliberately NOT reset by a recycle — a recycle re-boards the phase as a
   * fresh attempt, and a ledger keyed on the attempt would hand the new one a
   * clean slate and recycle for ever. It is reset by an operator's Retry
   * (`resetForRetry`, who is asking for a fresh start and is present to see
   * what happens) and by nothing else.
   *
   * **Counts of RUNGS CLIMBED, not of episodes seen**, and the difference was a
   * real defect: a ledger that counted silent episodes could close one WITHOUT
   * spending a rung — a session that answered the nudge and then wedged again —
   * so the phase parked with the recycle, the rung that might have fixed it,
   * never reached, and the errand claimed it had been. Counting what was
   * actually done cannot do that, and it is what lets the errand's `tried` list
   * be built from evidence rather than from assumption.
   */
  stallRemedy?: {
    /** How many times the watchdog has written to this phase's session. */
    nudges: number;
    /** How many times it has ended one and let the loop re-board the phase. */
    recycles: number;
    /** When the nudge was written (ISO) — the grace clock the recycle waits. */
    nudgedAt?: string;
    /** When the recycle ended the child (ISO). */
    recycledAt?: string;
    /** The attempt each rung was climbed on, for the errand's `tried`. */
    attempts?: number[];
    /**
     * The RETRY-storm ladder's own rungs, deliberately not sharing `recycles`.
     *
     * The two ladders answer different silences — one a session that says
     * nothing, one a session that says only "retrying" — and a rung spent on
     * either must not read as a rung spent on the other. Sharing the counter
     * would mean a lane that had already been recycled for silence could never
     * be recycled for a storm, and its errand would tell the operator a rung
     * had been climbed that never was: the exact bookkeeping defect the silent
     * ladder's own docblock is a monument to.
     */
    retryRecycles?: number;
    retryRecycledAt?: string;
    retryParkedAt?: string;
    /**
     * The LOCAL-job ladder's own rung, for the same reason `retryRecycles` has
     * one: a nudge sent because the session was silent and a nudge sent
     * because it is watching its own suite are two different sentences on two
     * different clocks, and sharing `nudges` would let either silence the
     * other. On the record rather than the in-memory lane so a console restart
     * mid-wait does not re-nudge a session that has already been told.
     */
    localNudges?: number;
    localNudgedAt?: string;
    /**
     * The EXTERNAL-clock ladder's nudge (control-tower phase 111, #179): the
     * session is told before the console parks it, and the park comes only
     * once `EXTERNAL_PARK_GRACE_MS` has passed since a nudge it received.
     */
    externalNudges?: number;
    externalNudgedAt?: string;
  };
  /**
   * How many attempts of THIS phase in a row ended with nothing committed and
   * a clean tree — the `stalemate` counter. Reset by any attempt that produced
   * work, and by `resetForRetry`.
   */
  idleAttempts?: number;
  /**
   * When the runner started running this phase's own §Verification (ISO), and
   * absent the rest of the time.
   *
   * Two readers, one fact: the live detector suppresses every stall signal
   * while it is set (a build is silent and fine), and the inbox's
   * `verify-hanging` row measures from it — the runtime half of lint F16,
   * which warns at plan time about a §Verification that waits on a clock the
   * session does not control.
   */
  verifyingSince?: string;
  /**
   * A §Verification the console's going-down cut short (control-tower phase
   * 48, #69): when, why — the console shut down or restarted (`shutdown`),
   * the run was stopped (`stop`), or a checkpoint still read `verifying` at
   * boot because the process died mid-run (`crash`) — and how much of it ran.
   *
   * While it is set the phase is owed its proof. Reconcile never closes the
   * record on the board's word (the board reads `done` from the moment the
   * handoff landed, which is exactly what the verification was checking), a
   * run is never called finished over it, and the next drive re-runs the
   * §Verification before anything else is decided about the phase
   * (`phase.reverify-after-restart`). The re-verification consumes it; a cut
   * that happens again writes it again.
   */
  reverify?: {
    at: string;
    /**
     * `checkpoint` (control-tower phase 89, #121) is a different debt from the
     * other three: the console's checkpoint ended the phase's SESSION while it
     * waited on a job of its own, and the group signal took the job with it —
     * so the next SESSION must re-run it. It is read by that boarding's brief
     * (`checkpointJobsBlock`) and never by the console's own re-verification
     * (`owesVerification` says which is which).
     */
    cause: 'shutdown' | 'stop' | 'crash' | 'checkpoint';
    ran?: number;
    notRun?: number;
    /** `checkpoint` only: what the killed job was waiting to produce (the wait chain's key). */
    jobs?: string[];
  };
  /**
   * The limit this phase's §Verification commands ran under (control-tower
   * phase 83, #95): each command's, and `ms` their sum — the bound the restart
   * drain reads for a verifying lane. `source` is the plan's word when it gave
   * one (`phase`, `plan`), else `history` when a line's measured runs raised
   * it, else `default`. Written when the verification starts.
   */
  verifyLimit?: {
    ms: number;
    source: VerifyLimitSource;
    commands?: { command: string; ms: number; source: VerifyLimitSource }[];
  };
  /** What this phase's §Verification read before its session touched the tree — see `VerifyBaseline`. */
  baseline?: VerifyBaseline;
  /** Reds other phases' verifications inherited and attributed to THIS phase — see `OwedRed`. */
  owed?: OwedRed[];
  /**
   * This phase's COMMITTED work-in-progress is red: the commit, and the files
   * its fast gate failed on. Written by control-tower phase 89's wrap-up gate;
   * read here by the failure streak's root-cause key (phase 87, #122) — a block
   * that names this phase (`phase:<slug>/<N>`, `lock:<slug>/<N>`) is blamed on
   * this commit, so every sibling it stops is ONE cause, charged once.
   */
  wipRed?: WipRed;
  /**
   * A wrap-up KEEPS its lane (control-tower phase 109, #192): the session
   * handed off `partial` at the console's notice with its own WIP uncommitted
   * in a tree its siblings share (`paths` files). Until it boards again it
   * ranks right after a person's re-board (`boardingOrder`), and its scope is
   * held against every sibling whose scope meets it — in the very pass its lane
   * was released in, too. Written by `resumeAfterWrapup`, spent at boarding.
   */
  keepsLane?: { at: string; reason: string; sessionId: string | null; paths: number };
  /**
   * The background agents this phase's last session ended with still running,
   * stopped by the CLI's ceiling mid-work (control-tower phase 109, #188):
   * each one's description and newest words, when its session handed off, and
   * the uncommitted paths written after that. Written as the session settles,
   * consumed by the next boarding's brief (`boardingWipBlock`).
   */
  agentsKilled?: {
    at: string; handedOffAt: string | null; paths: string[];
    agents: { id: string; description?: string; lastText?: string; tool?: string }[];
  };
  /**
   * The loopback ports this phase's sessions served on (control-tower phase
   * 89, `LaneSignals.ownPorts`), kept past the lane: a refused connection to
   * one in the console's §Verification is `environment`, never a red.
   */
  ownPorts?: number[];
  /**
   * The baseline is being MEASURED, since then (control-tower phase 83, #103):
   * the §Verification commands own the lane, so the stall detector stands down
   * and the restart drain counts it as verifying — exactly as for
   * `verifyingSince`, which it is kept apart from on purpose: a console that
   * dies mid-baseline owes no re-verification (the next boarding simply takes
   * the baseline again), while one that dies mid-verification does.
   */
  baselineSince?: string;
  /**
   * §Verification's FINAL verdict was red over a phase the board reads done,
   * and this run RE-OPENED it (control-tower phase 62, #68) rather than record
   * a failure after "done". While it stands: reconcile never closes the record
   * on the board's word (the board is reading the handoff the verdict was
   * about), the run is never called finished over it, the phase's direct
   * dependents are held (`phase.verification-held`), and the ladder gives it
   * ONE fix rung (`verify-red:reopened`) before its errand. A verification of
   * it that comes back green ends it — the fix session's, or a person's
   * Re-check. `failed` is the commands that were red; `times` how often the
   * verdict re-opened it.
   */
  reopened?: { at: string; failed: string[]; times: number };
  /**
   * A person answered this phase's errand — "Done — continue" (control-tower
   * phase 88, #124): who, their note, when, and the declaration it answered
   * (`declared`, that declaration's `at`). The answered declaration is spent
   * (`applyErrandAnswer`), and this stamp is evidence (`phaseEvidence`), so a
   * Recover after the answer never re-derives the ask it answered.
   */
  errandAnswered?: { by: string; note: string; at: string; declared?: string };
  /**
   * Reconcile closed this record on the BOARD's word, not this run's own
   * verification (control-tower phase 79, #113): `at` is when. It is what the
   * drive tick re-reads — a board that no longer reads the phase done reopens
   * the record `pending` (`reopenRegressedRecords`, `phase.reopened`) with its
   * `resumeSessionId` kept, because the thing that made it read done (an
   * untracked scaffold, a reverted commit) can go away. A record this run
   * verified never carries it, and is never reopened.
   */
  reconciled?: { at: string };
  /**
   * The phase reads `in-progress` or `stuck` on the board, and nothing of this
   * live run drives it — no lane, no queue entry, no boarding hint, no park, no
   * errand (control-tower phase 79, #114). Stamped by the drive tick
   * (`Runner.noteUndriven`), cleared the tick it is driven again; `since` holds
   * for the episode, which is the clock the inbox's `undriven` stall reads.
   * `deferred` is the ladder's deferral to a healer that only climbs a STOPPED
   * run — the one undriven shape raised at once rather than after the clock.
   * Read through `undrivenPhases` (`shared/run-lifecycle.js`), which answers
   * only for a live run.
   */
  undriven?: UndrivenStamp;
};

/** See `PhaseRecord.undriven`. */
export type UndrivenStamp = {
  since: string;
  /** The board's word for the phase: `in-progress` or `stuck`. */
  board: string;
  /** The last situation the phase was classified in, when it was. */
  situation: string | null;
  /** Why nothing drives it, in one sentence. */
  why: string;
  /** The ladder deferred it to the healer (`phase.ladder-deferred`). */
  deferred?: { at: string; situation: string; next: string | null; remaining: string[]; reason: string };
};

/**
 * One rung of the remediation ladder, as it was climbed on one phase.
 *
 * `situation` is the `id:sub` key the rung was chosen FOR, `rung` the vehicle
 * it drove (`ladder.ts` `RungVehicle`), `costUsd` what the session it launched
 * spent once known, `outcome` how it ended. The ladder reads this list to keep
 * its one hard promise — never the same rung twice for one situation on one
 * phase — and its caps count and sum it.
 */
/**
 * A checkout or branch that appeared while one of this run's sessions was
 * running — and that nothing sweeps.
 *
 * `pruneWorktrees` covers only the console's own lane directories and never
 * deletes a branch; `sweepStaleWorktrees` covers only `runs/<slug>/worktrees`.
 * So a session that ran `git worktree add ../repo-pe-<slug>` or created a
 * branch of its own left something permanent that no code path could see, let
 * alone remove — five trees under `/private/tmp` and a
 * `pe/aug-create-order-filters-p12-fix` branch are the measured result.
 *
 * This does not sweep them either: deleting a checkout that may hold
 * uncommitted work is a person's decision. What it does is make them KNOWN, so
 * the operator is told what exists and the phase that made it is named.
 */
export type RunArtefact = {
  kind: 'worktree' | 'branch';
  /** The directory, or the branch name. */
  name: string;
  /** The branch a worktree stands on, when it has one. */
  branch?: string;
  /** Which scoped repository it appeared in, relative to the run root (`.` = the root). */
  repo?: string;
  /** The phase whose session it appeared under. */
  phase: number;
  at: string;
};

export type RungRecord = {
  situation: string;
  rung: string;
  at: string;
  params?: Record<string, string | number | boolean>;
  costUsd?: number;
  /** `interrupted`: the rung's session was cut off before it effectively ran
   * (a console shutdown, zero turns) — it does NOT consume the same-rung-once
   * rule, though the numeric caps still count it, so restarts stay bounded.
   *
   * `work-in-progress`: the rung's session ran, did work, and declared
   * `partial` — "work remains, resume me". Unlike `interrupted` it DID
   * effectively run, so it consumes the same-rung-once rule (climbing the same
   * remedy again is not what a session that asked to be resumed wants); unlike
   * `failed` it is not a verdict against the rung, so it never becomes
   * `lastOutcome`. */
  outcome?: RungOutcome;
  /** Turns the rung's own session actually got — stamped at resume completion,
   * the fact that separates "tried and failed" from "never effectively ran". */
  turns?: number;
  /**
   * Who ended the rung's session (`ENDED_BY`), stamped beside `turns`.
   *
   * "Zero turns" used to be the whole test for "the console cut it off": every
   * session the console ended was a SIGTERM, which books no `result` and so no
   * turns. Since zero-touch-console phase 4 an ended session is asked to close
   * its turn first and is booked honestly — a shutdown-killed resume that
   * worked for ten minutes now carries its turns — so the ending is read from
   * this word, and a rung the console cut short still does not consume itself.
   */
  endedBy?: EndedBy;
  note?: string;
  /**
   * The approval card a `widen-rule` rung offered (phase 9). Here rather than
   * in `params` because `params` is the same-rung-once identity, and a card
   * id there would make every offer a "different" rung.
   */
  cardId?: string;
  /**
   * WHY it ended (`shared/ladder-model.js` `RUNG_FAILURE_CAUSES`), stamped by
   * every settlement: `merit` unless the arm that knew said otherwise —
   * `environment` for an ending the machine caused (a refused credential, no
   * network, a zero-turn transient), which neither consumes the rung nor
   * spends a rung cap — and `never-ran` for a `withdrawn` one. Absent on a
   * record an older console settled, which reads as `merit` (#36).
   */
  cause?: RungCause;
  /**
   * Re-armed, and by whom: an operator's Retry (`by: 'operator'`) forgives a
   * phase's interruptions and environment records; a usable account arriving
   * (`by: 'accounts-changed'`) forgives the rungs a resource wall defeated. A
   * forgiven record counts toward nothing but the dollars (#14, #36).
   */
  forgiven?: { at: string; by: string };
  /**
   * `operator` — a person's press, in the PERSON slot (control-tower phase 53,
   * #56; `shared/ladder-model.js` `PERSON_SLOT_BY`): the phase was boarded
   * outside the automatic ladder, and the record counts toward no rung cap and
   * never marks a remedy tried. Absent on every rung the ladder climbed.
   */
  by?: string;
};

/**
 * What a person is asked for, ONCE, when the ladder for a phase is exhausted
 * or the situation is intrinsically human. Structured so one card, one push
 * and one journal line can all say the same thing: what the situation is,
 * what was already tried (so nobody tries it again by hand), what is needed,
 * and how to give it.
 */
/** One account a run may spend, and the five-hour headroom (percent) it must show first. */
export type AccountRequirement = { id: string; minHeadroomPct: number };

/** A person's account switch, as the run remembers it — see `RunState.accountChoice`. */
export type AccountChoice = { accountId: string; from: string; at: string; by: string };

/**
 * The account an AUTOMATIC mover took the run off, and when its wall resets
 * (control-tower phase 92, #100): the run owes it a move back at the next
 * boarding after that reset. The first origin is kept across later moves.
 */
export type SwitchedFrom = { accountId: string; resetsAt: string; at: string; reason: string };

/**
 * The account a run is on is ALWAYS one of its listed accounts (control-tower
 * phase 78, #100): a run that declared a pool and runs on an account outside it
 * reads as spending an account it may not spend, and failover — which ranks
 * inside the pool — could never come back to it. Appended at `minHeadroomPct: 0`
 * because nobody stated a floor for it (`applySettings`' and
 * `switchAccountRun`'s rule, which this is now the one copy of). A run with no
 * pool is left without one: no rows means every account is a candidate.
 */
export function keepAccountInPool(state: { accountId?: string; accounts?: AccountRequirement[] }): void {
  const rows = state.accounts;
  if (!rows?.length) return;
  const on = state.accountId ?? 'default';
  if (!rows.some((row) => row.id === on)) rows.push({ id: on, minHeadroomPct: 0 });
}

/**
 * The run's account POOL (control-tower phase 53, #55): the ids its `accounts`
 * rows name — what the manifest's `accounts` row answered at launch, plus any
 * account a person has since switched it to — or null when it declared none,
 * and every account of the machine is a candidate, as before.
 *
 * `state.accounts` was written at launch and then read by nothing: a run with
 * a declared pool of three failed over at preflight onto a fourth account the
 * operator had never named, without probing the pool's own members first.
 */
export function accountPool(state: { accounts?: readonly AccountRequirement[] | null }): string[] | null {
  const ids = [...new Set((state.accounts ?? []).map((row) => row.id))];
  return ids.length ? ids : null;
}

/**
 * Failover's candidates, best first, INSIDE the pool (#55): the ranked ids the
 * pool names, then the pool's remaining members (the rank left them out —
 * retired, cooling, walled or signed out — and a caller that asks each in turn
 * records why), never the account being left. No pool: the rank, untouched.
 * Never an id outside the pool — failover does not leave it by itself.
 */
export function rankInPool(ranked: readonly string[], pool: readonly string[] | null, leaving: string): string[] {
  if (!pool) return [...ranked];
  const inside = ranked.filter((id) => pool.includes(id));
  return [...inside, ...pool.filter((id) => !inside.includes(id) && id !== leaving)];
}

/**
 * One manifest row as the door resolved it: the plan's `## Decisions` row, the
 * twin's, the run's own answer, or a shipped default — `origin` says which.
 */
export type ManifestDecision = {
  key: string;
  state: string;
  source: string;
  value: string;
  blocking: 'yes' | 'no';
  origin: string;
  owner?: string;
};

/**
 * What `run.start` echoes (phase 11, ZTD-2): the manifest as it stood when the
 * run was admitted — every row with its state, the probes' verdicts, the
 * accounts clause in force, the credentials named and held, the delivery
 * channel found — and the recorded override when a blocking row was passed
 * on purpose. Stored on the run so a person reading a halted run six hours
 * later sees what was asked and what was answered before the first token was
 * spent.
 */
export type ResolvedManifest = {
  decisions: ManifestDecision[];
  accounts: AccountRequirement[];
  credentials: { policy: string; ids: string[]; held: string[]; missing: string[] };
  delivery: { ok: boolean; channels: string[]; acknowledged: boolean };
  probes: Record<string, { status: string; reason: string }>;
  overridden?: { rows: string[]; by: string; at: string };
  at: string;
};

/**
 * The manifest as `run.start` carries it: the same shape, every row's value
 * cut to 200 characters — a plan's `relay` row is a paragraph, and the journal
 * line that says a run started should not be. Everything else verbatim.
 */
export function manifestEcho(manifest: ResolvedManifest): ResolvedManifest {
  return {
    ...manifest,
    decisions: manifest.decisions.map((row) => ({
      ...row,
      value: row.value.length > 200 ? `${row.value.slice(0, 199)}…` : row.value,
    })),
  };
}

/** Who a run's account answered when the run bound to it (`RunState.identity`). No secret, no path. */
export type BoundIdentity = { account: string; key: string; email?: string; org?: string; at: string };

type IdentityLike = { account: string; key: string; email?: string; org?: string };

/** What a journal line or a stored binding carries of an identity — these four fields, never more. */
export function identityEcho(identity: IdentityLike): IdentityLike {
  return {
    account: identity.account, key: identity.key,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.org ? { org: identity.org } : {}),
  };
}

/**
 * The words for a run whose account now answers another identity
 * (control-tower phase 91, #131): the halt says what happened — the login
 * changed identity, never "expired or signed out" — and the errand offers the
 * two ways on, each with the verb that takes it. One copy, shared by the
 * runner's park and the service's park of a run no loop drives.
 */
export function identityChangeWords(slug: string, was: IdentityLike, now: IdentityLike): { halt: string; need: string; how: string } {
  const who = (i: IdentityLike) => i.email ?? i.org ?? `identity ${i.key.slice(0, 8)}`;
  const label = was.account === 'default' ? 'the machine login' : `account ${was.account}`;
  return {
    halt: `${label} changed identity — it is now ${who(now)} (was ${who(was)}, whom this run started on); `
      + 'parked until a person chooses: continue on the new login, or move to the profile of the identity it started on',
    need: `A person's choice: ${label} now answers ${who(now)}, not ${who(was)}, whose login this run started on — `
      + 'nothing resumes on somebody else\'s login by itself.',
    how: `Continue on the new login (${who(now)}): press "Continue on the new login" on the run `
      + `(POST /api/run/${slug}/identity {"choice":"continue"}). Or move the run to the profile of ${who(was)}: `
      + `press "Move to ${who(was)}'s profile" ({"choice":"move"}) — register and sign in a profile as ${who(was)} `
      + 'under Settings ▸ Accounts first if there is none.',
  };
}

/** A person's answer to a phase's errand — "Done — continue" (control-tower phase 88, #124). */
export type ErrandAnswer = { by: string; note: string; at: string; situation?: string };

/**
 * Record a person's answer on a run: the stamp on the record (evidence — phase
 * 51's fingerprint reads it), the answered declaration SPENT and the errand
 * cleared, so the healer and Recover stop re-deriving an ask a person has
 * answered — which is what re-halted P27 with the same text (#124).
 */
export function applyErrandAnswer(state: RunState, phase: number, answer: ErrandAnswer): void {
  const record = phaseRecord(state, phase);
  record.errandAnswered = {
    by: answer.by, note: answer.note, at: answer.at, ...(record.declared ? { declared: record.declared.at } : {}),
  };
  delete record.declared;
  const slot = state.recoveries?.[String(phase)];
  if (slot) { delete slot.errand; delete slot.foldedInto; }
}

export type Errand = {
  phase: number;
  situation: string;
  tried: string[];
  need: string;
  how: string;
  at: string;
  /**
   * `how` ends, wherever it is SHOWN, with the clause over the phase's live
   * watch state (`watch-refs.ts` `liveErrandHow`) — never frozen into `how`
   * when the errand is written (control-tower phase 88, #125): the first probe
   * comes after the errand, and its refusal must be what the card says.
   */
  watching?: boolean;
  /**
   * The act this park waits on is not due yet — a human step born `upcoming`
   * (control-tower phase 121, #182). The errand stands for the healer, but it
   * announces nothing and draws no needs-you row: the ledger's *Coming up* row
   * is its face, and its due-when ref landing is its ONE push.
   */
  upcoming?: boolean;
  /**
   * Other phases of this run whose declared external wall is THIS one — the
   * same scope, `--needs external`, and reason fingerprint — folded in rather
   * than written, parked and announced again (control-tower phase 6, #19
   * ask 2). Each carries `recoveries[N].foldedInto` pointing back here.
   */
  alsoPhases?: number[];
  /**
   * The decision-manifest row this ask belongs to (phase 11, ZTD-10/QRL-3):
   * one of `shared/decisions-model.js` `DECISION_KEYS`, derived from the
   * policy table (`shared/policy-model.js` `POLICY_TABLE`) by the errand's
   * situation. It is what lets an operator say "never ask me about X" — the
   * plan's `## Decisions` row, or this console's `policy.<key>` preference,
   * answers the class, and the errand is never written. Always set on an
   * errand this build writes; absent on one a 4.1.0 console wrote.
   */
  decisionKey?: string;
  /**
   * Set when the class RESOLVED to an automatic answer (`isAutomaticAnswer`):
   * the caller journals `phase.policy-answered` with these two words instead
   * of `phase.errand`, and no card is raised. Absent = a person is asked.
   */
  policy?: { answer: string; source: string };
  /**
   * The budget that stopped this phase, when a budget did (control-tower phase
   * 14, #40): which one, its arithmetic and what spent it. Present, it is the
   * errand's first line (`budgetFirst`), the `budget` push, and the raise the
   * card offers — never the sentence of whatever the budget stopped.
   */
  budget?: BudgetFact;
  /**
   * The session's own last words, verbatim, when they are the evidence.
   *
   * One producer today: a zero-turn exit whose `said` named the cause
   * (`never-started:refusal`, `never-started:skill-missing` — D26). A refusal
   * cannot be acted on without reading what was refused, and the table's
   * `need`/`how` are fixed sentences that by construction cannot quote it.
   * Additive and optional: an errand written before this, or by any other
   * situation, simply has none.
   */
  said?: string;
  /**
   * The human step this errand IS (control-tower phase 44): phase 39's
   * protected path — `blocked-declared:protected-path` — as a step of kind
   * `protected-path`, carrying the act and the path the session named, so its
   * card offers the patch to apply by hand or an interactive session here.
   * Absent on every other errand.
   */
  step?: { kind: 'protected-path'; act?: string; path?: string };
  /**
   * The ledger item this errand IS (control-tower phase 132, #209): the step a
   * session declared, or the item a preflight raised. Its push was the item's
   * own, so the errand announces nothing, and its row's action is *I've done
   * this — check* on that item. Absent on an errand no item stands behind.
   */
  stepId?: string;
  /**
   * Rungs climbed on this phase for a DIFFERENT situation than the one this
   * errand is about.
   *
   * `tried` used to be the phase's whole unfiltered rung history (R11), so a
   * card asking about a red verification listed the reboard that had been tried
   * back when the phase read `never-started` — and the "next: …" it offered was
   * a rung the server would refuse, because the same-rung-once rule is keyed on
   * the situation. Additive and optional: an errand with nothing earlier simply
   * has none.
   */
  earlier?: string[];
  /**
   * A CAP errand's arithmetic (control-tower phase 5, #14): which of the
   * ladder's own caps refused (`LadderCap`), what it had spent and what it
   * allows, in the cap's unit; how many counted rungs sit on phases the board
   * already reads done (spent, and no longer charged); and the preference or
   * run setting that raises it. A cap errand carries NO `decisionKey`: it used
   * to be keyed `budgets`, a free-text row the caps never read, so no answer a
   * plan could give lifted the park.
   */
  cap?: LadderCap;
  spent?: number;
  limit?: number;
  onDonePhases?: number;
  setting?: LadderCapSetting;
  /** Whether a Retry of this phase would forgive anything the cap counted — said BEFORE the press (#14 ask 3). */
  replenishes?: boolean;
};

/**
 * One thing that holds a run the drive loop parked with nothing ready — the
 * data the `nothing-ready` sentence is built from (control-tower phase 5): the
 * phase, what kind of holder it is, the ONE verb that clears it, and why.
 * `setting` names what a `settings` verb changes; `gate` quotes the gate.
 */
export type HaltHolder = {
  phase: number;
  kind: HaltHolderKind;
  verb: HaltHolderVerb;
  why: string;
  setting?: string;
  gate?: string;
  /**
   * The gate's `--gate-status` verdict word (`manual`, `blocked`, …) — what
   * tells a person's gate from one that clears itself, so a park held only by
   * the second reads as a wait (control-tower phase 17, #48).
   */
  gateKind?: string;
  /**
   * An `errand` holder's errand situation key (`blocked-declared:external`, …)
   * — what kind of wall holds the phase, so a park behind a declared external
   * wall reads as one rather than as the park kind's own family
   * (control-tower phase 33).
   */
  situation?: string;
};

/** The briefs boarding can assemble for a phase the ladder re-boards. */
export { BOARDING_BRIEFS };
export type BoardingBrief = (typeof BOARDING_BRIEFS)[number];

/**
 * How the ladder asked a phase to board. `situation` (`id:sub`) and `rung`
 * (the vehicle) are the journal's vocabulary and the rung history's identity;
 * `brief` is what boarding assembles:
 *
 *   `fresh`     the engine's boot prompt and nothing else (never-started)
 *   `resume`    the boot prompt + a runner-appended RESUMING evidence block
 *   `unblock`   the boot prompt + the handoff's Outstanding + "you MAY do the work"
 *   `continue`  `--resume` the phase's own session with a continue instruction
 *   `closeout`  `--resume` the phase's own session with the closeout procedure
 *
 * `sessionId` is what `continue`/`closeout` resume; `instruction` rides the
 * own-session briefs; `escalate` asks boarding for the next model step.
 */
/**
 * The vehicle name a review follow-up boards under.
 *
 * It lives HERE, with the rest of the boarding vocabulary, rather than in
 * `review.ts` where the feature does: `state.ts` is the bottom of the import
 * graph and the reconciler below has to recognise the word. `review.ts`
 * re-exports it so the review surface still reads as owning its own name.
 */
export const FOLLOW_UP_RUNG = 'reboard-review-follow-up';

export type BoardingHint = {
  situation: string;
  rung: string;
  brief: BoardingBrief;
  sessionId?: string;
  instruction?: string;
  escalate?: 'model';
  at: string;
  by?: string;
};

/**
 * What a person's press set in motion (control-tower phase 53, #54 #55 #56) —
 * the answer every boarding verb gives instead of a 200 over nothing.
 *
 * `session` names the phase's own session when the press resumes it, with
 * `brief` saying how (`continue` for a resume with an instruction, `closeout`
 * for Finish in its own session). `session: null` is a FRESH session — the CLI
 * is handed its id at the spawn — boarding with `brief` (`fresh` for a Retry,
 * `resume` for a resume the console boarded fresh), and `why` says why a
 * resume that was asked for did not resume.
 */
export type PressLaunch = {
  runId: string;
  phase: number;
  session: string | null;
  brief: BoardingBrief;
  why?: string;
};

/**
 * What a press QUEUED rather than boarded (control-tower phase 86, RS-5): the
 * same account of what will run, plus where it waits — its 1-based position in
 * the line (null when the loop decided nothing in time to say) and what holds
 * it. A re-board is a hint, and a hint is not a launch.
 */
export type PressQueued = PressLaunch & {
  position: number | null;
  behind?: { kind: string; slug: string; phase: number | null; owner: string };
};

/** A press's whole answer: what it launched or queued, or a refusal with the reason (and the session that holds the phase, when one does). */
export type PressAnswer =
  | { ok: true; run: RunState; launched: PressLaunch }
  | { ok: true; run: RunState; queued: PressQueued }
  | { ok: false; status: number; error: string; sessionId?: string };

/**
 * Why a stopped run has stopped demanding a person.
 *
 * A `halted` or `interrupted` run is a permanent claim: nothing ever revisits
 * it, so the console goes on asking about a phase that was finished by hand
 * three weeks ago. The oldest card on this dashboard said a plan had halted
 * because phase 6 wrote no handoff — the handoff landed four hours later and
 * the board has read 7/7 done ever since.
 *
 * Resolution is the correction, and it is *annotation, never deletion*: the run
 * keeps its status, its halt reason and its whole record, and gains a note
 * saying why it is no longer waiting on anyone. `auto` distinguishes the two
 * ways that happens — the board overtook it, or a person dismissed it — because
 * only one of those is something the console is allowed to decide by itself.
 */
export type RunResolution = {
  at: string;
  /** True when the board settled it; false when a person did. */
  auto: boolean;
  reason: string;
  /** Who dismissed it, on a manual resolution. */
  by?: string;
  /** What they said about it, if anything. */
  note?: string;
  /**
   * The phases the board read ready when it was dismissed (control-tower phase
   * 110, #176) — so work that turns ready AFTER it reads as new. Absent on a
   * dismissal written before this was kept, or when the board could not be read.
   */
  ready?: number[];
};

/**
 * The `by` a request is derived as when it named nobody and came from neither
 * a browser nor the console's own CLI — a watchdog agent, a cron, a `curl`
 * (`actorOfRequest`, SHD-3).
 */
export const SCRIPT_BY = 'script';

/**
 * Was this dismissal a PERSON's judgement (control-tower phase 110, #176)? A
 * script's is not, whatever its sentence said — the hub's watchdog dismissed a
 * run that was then recorded "dismissed by the operator" — and only a person's
 * pins a run against ready work that appears after it. A manual dismissal with
 * no `by` at all predates the field and keeps the benefit of the doubt.
 */
export function dismissedByPerson(resolved: RunResolution | null | undefined): boolean {
  return Boolean(resolved && !resolved.auto && resolved.by !== SCRIPT_BY && resolved.by !== 'unattributed');
}

/**
 * The phases that turned ready AFTER this run was dismissed (#176): ready on
 * the board, never boarded by the run, inside its scope, and not in the ready
 * set the dismissal recorded. A dismissal that recorded none (written before
 * it was kept) saw nothing ready — the shape of the `nothing-ready` park it was
 * written over.
 */
export function readySinceDismissal(
  run: Pick<RunState, 'resolved' | 'phases' | 'onlyPhases'>, board: Record<number, string>,
): number[] {
  const seen = new Set(run.resolved?.ready ?? []);
  const asked = run.onlyPhases?.length ? new Set(run.onlyPhases) : null;
  return Object.entries(board)
    .map(([phase, word]) => ({ phase: Number(phase), word }))
    .filter(({ phase, word }) => word === 'ready' && !run.phases[String(phase)] && !seen.has(phase) && (!asked || asked.has(phase)))
    .map(({ phase }) => phase)
    .sort((a, b) => a - b);
}

/**
 * Stopped, with nothing driving it and nothing that will.
 *
 * These are the only statuses a run can be resolved out of. A `parked` run is
 * excluded deliberately: `reconcileRun` uses `parked` for the one case where a
 * child is *still alive* under a dead console, and a live session editing a
 * working tree is the last thing that should quietly stop being mentioned.
 */
export const RESOLVABLE: readonly RunStatus[] = ['halted', 'interrupted'];

/**
 * A freeze on one lane: when, who, and when it stops being cheap.
 *
 * `escalateAt` is OPTIONAL, and its absence is a word rather than a gap: this
 * is a **standing** freeze — the fleet-freeze form — which never converts to a
 * checkpoint on a clock. `freezeVerdict` has always read an absent or
 * unparseable deadline as "leave the operator's freeze standing", so the two
 * shapes need no branch anywhere downstream; the client's countdown simply has
 * nothing to count, which is the honest rendering of a freeze with no end.
 */
export type FreezeRef = { at: string; by: string; escalateAt?: string };

/** One live session, as the checkpoint records it. */
/** One of the console's own verification lanes — see `RunState.verifying`. */
export type VerifyingLane = {
  phase: number;
  /** Which pass: the phase's verdict, its baseline at boarding, or a wrap-up's fast gate. */
  purpose: 'verify' | 'baseline' | 'wip-gate';
  /** The command running now, and where it sits in the pass. */
  command: string;
  index: number;
  total: number;
  /** When the PASS started, and when this command did. */
  startedAt: string;
  commandStartedAt: string;
  /** The clean checkout it runs in, when it is not the working tree. */
  exported?: boolean;
  /** The console's own pid — the process whose children the commands are. */
  pid: number;
  /** The pass is in its `Setup:` preamble — `command` is the bring-up command (control-tower phase 105). */
  stage?: 'setup';
  /**
   * The running command's own process, as `(pid, procStartedAt)` — the fact a
   * reader that does not know the run is live can still check (#173): a lane
   * in its Setup or its baseline is work in flight while this holds work.
   */
  child?: { pid: number; procStartedAt: string };
};

export type ChildRef = {
  pid: number;
  phase: number;
  sessionId: string;
  /**
   * When the PHASE started — not the process. On a second attempt the two are
   * hours apart, which is why the identity probe may never be keyed on it.
   * `procStartedAt` is the one to use for that.
   */
  startedAt: string;
  /**
   * When this PROCESS started, as the console saw it at spawn.
   *
   * Half of the `(pid, start-time)` tuple that makes a pid mean something on a
   * platform with no pidfd. Without it a recycled pid reads as the child that
   * used to hold it, and the console offers `kill -CONT` advice aimed at an
   * innocent process. Optional because checkpoints written before this field
   * existed have no answer, and "I do not know when it started" must not read
   * as "it started at the epoch".
   */
  procStartedAt?: string;
  /**
   * The console that LAUNCHED this process — its pid and the instant it booted
   * (control-tower phase 110, #175). The one fact an orphan is judged by: a
   * child is orphaned only when this console is no longer the live one (its
   * pid gone, or the pid held by a later boot), never because a record went
   * quiet or a reader did not know the run was live. Absent on a record an
   * older console wrote, which reads as "cannot tell" — never as "mine".
   */
  launcher?: ConsoleRef;
  /**
   * Set while this lane's process sits under SIGSTOP. Recorded on the lane and
   * not only in the run-level `freeze` slot because several lanes can be frozen
   * at once, and a reader deciding per pid — reconcile telling a stopped orphan
   * from a running one, a client drawing one lane's controls — needs the fact
   * where the pid is. The single slot can only name one.
   */
  frozen?: FreezeRef;
  /**
   * The lane's own git worktree — the directory this session is actually
   * editing. **Absent means SHARED**: the session is working in the run's own
   * root, which is what every run did before worktree lanes existed and what
   * every run that does not opt in still does.
   *
   * Recorded here, on the durable checkpoint, and not only on the in-memory
   * `Lane`, because the question it answers is asked most often by whoever
   * arrives AFTER the process that knew: a console restarted mid-run, an
   * operator reading a parked orphan, `git worktree list` showing a checkout
   * nobody can attribute. `Lane.worktree` dies with its process; this survives
   * it, which is the only reason it is worth writing down twice.
   */
  worktree?: string;
  /**
   * The branch that checkout is on — `pe/<slug>-p<N>` for a lane, per
   * `worktree.ts` §`laneNames`. **Absent means the run's own branch**, the same
   * absent-means-shared convention as `worktree` and for the same reason: a
   * lane is the exception, so the exception is what gets written down.
   *
   * Stored rather than recomputed from the slug and the phase because a name
   * derived at read time is a guess about what the writer did — and the two
   * disagree exactly when it matters, on a record written by another version.
   */
  branch?: string;
  /**
   * The `git worktree lock` reason fastened on `worktree` (phase 7), written
   * only when git accepted it (phase 15). **Absent means not locked by this
   * console** — a shared-root lane, a run-level checkout (whose lock is the
   * run tree's, not this child's), or a lock git refused. What lets a row say
   * "locked" in the runner's own words instead of inferring it from the fact
   * that a lock is always asked for.
   */
  locked?: string;
};

/**
 * Every lane a run has open, however the checkpoint spells it.
 *
 * The single `child` and the `children` map are two recordings of the same
 * fact, and a run written by an older console only has the first. Reading them
 * through one function is what keeps "reconcile a one-lane run" and "reconcile
 * a three-lane run" the same code path — the alternative is two orphan checks
 * that drift, and the one that drifts is the one that leaves a live session
 * editing a tree nobody is watching.
 */
/**
 * How to ask the probe about a recorded child.
 *
 * Only the `(pid, start-time)` tuple, and only when the record carries one.
 * Deliberately NOT `expect`: a `comm` check can only ever turn a live pid into
 * `gone`, and every caller of this treats `gone` as licence to take something
 * away — reclaim a run, drop a handle. A record written before `procStartedAt`
 * existed gets no identity check at all, because "I cannot tell" must not read
 * as "it is gone".
 */
export function procIdentity(child: ChildRef): { startedAt?: string } {
  return child.procStartedAt ? { startedAt: child.procStartedAt } : {};
}

export function childrenOf(state: Pick<RunState, 'children' | 'child'>): ChildRef[] {
  const lanes = state.children ? Object.values(state.children) : [];
  if (lanes.length) return lanes;
  return state.child ? [state.child] : [];
}

/** A console process, as a child record names the one that launched it. */
export type ConsoleRef = { pid: number; bootedAt: string };

/**
 * The console this module runs in — the LIVE console, to every child it
 * launches (control-tower phase 110, #175). `bootedAt` is the process's own
 * start, the instance's boot id: a later boot that is handed the same pid is a
 * different console, and its predecessor's children are orphans.
 */
export const THIS_CONSOLE: Readonly<ConsoleRef> = Object.freeze({
  pid: process.pid,
  bootedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
});

/** How far two readings of one boot may differ: one clock, read moments apart. */
const BOOT_SLACK_MS = 2_000;

/**
 * Is the console that launched this child still the live one?
 *
 * `true` for this console's own children, `false` when the console that
 * launched it is gone — its pid exited, or now belongs to a later boot — and
 * `null` when the record names no launcher: one an older console wrote, which
 * is never read as this console's own. This console is asked by pid and boot
 * alone; any other console by the probe on that `(pid, boot)` tuple, so a
 * reader that is not the console (the CLI, a test) answers for the console
 * that wrote the record — never for itself.
 */
export function launcherAlive(child: Pick<ChildRef, 'launcher'>): boolean | null {
  const launcher = child.launcher;
  if (!launcher || !Number.isInteger(launcher.pid) || launcher.pid <= 0) return null;
  const booted = Date.parse(launcher.bootedAt);
  if (!Number.isFinite(booted)) return null;
  if (launcher.pid === THIS_CONSOLE.pid) return Math.abs(booted - Date.parse(THIS_CONSOLE.bootedAt)) <= BOOT_SLACK_MS;
  return pidHoldsWork(launcher.pid, { startedAt: launcher.bootedAt });
}

export type Autonomy = AutonomyMode;

/**
 * What a phase does when one of its MCP servers cannot be reached.
 *
 * `continue` — the shipped default — drops the unreachable servers from the
 * `--mcp-config`, tells the session which ones are missing and why, warns the
 * operator, and runs the phase anyway. `require` is the older, unconditional
 * behaviour: park at boarding before a token is spent.
 *
 * The default moved because the park was answering the wrong question. It was
 * built for the phase that genuinely cannot work without its server, but it
 * fires for every phase that merely has one attached — and a run whose ready
 * phases all park has nothing left to do, so one signed-out server stopped an
 * eleven-phase plan that named no MCP servers at all (observed live, 0 phases
 * done). `require` is still exactly right, per phase, when the plan says so.
 */
export { MCP_POLICIES };
export type { McpPolicy };

export function isMcpPolicy(value: unknown): value is McpPolicy {
  return typeof value === 'string' && (MCP_POLICIES as readonly string[]).includes(value);
}

/**
 * What the operator chose for one phase, before it runs.
 *
 * Every field is optional and an absent field means "inherit". Three sources
 * are consulted in order — this, then the plan's own `**Model:**` /
 * `**Effort:**` bullets for that phase, then the run's defaults — so a plan
 * that already says a phase wants Opus gets Opus without anyone re-typing it,
 * and an operator who disagrees can say so for one run without editing a
 * versioned file.
 */
export type PhaseOptions = {
  model?: string;
  effort?: string;
  /** Restrict the built-in tool set for this phase. Empty means every tool. */
  tools?: string[];
  permissionMode?: string;
  /** Skills to invoke on top of the plan's own, for this phase. */
  skills?: string[];
  /**
   * Drop the RUN's skills for this phase — its own `skills` still apply.
   *
   * The escape hatch that makes a machine-level default safe to set. A skill
   * that is right for eighty-five phases can be exactly wrong for one (a phase
   * that touches no repository, a phase whose whole job is the thing the skill
   * would do), and without this the only way to exclude it would be to turn it
   * off for the entire run. `false` and absent are the same thing, so an older
   * checkpoint reads as "inherit" — which is what it meant.
   */
  skillsOff?: boolean;
  /** MCP servers to attach on top of the plan's and the run's, for this phase. */
  mcpServers?: string[];
  /**
   * Drop the RUN's MCP servers for this phase — its own still apply, and so
   * does the plan's own `**MCP:**` bullet, which is a versioned statement about
   * what this phase needs rather than an operator's choice for one run.
   *
   * Exactly `skillsOff`'s escape hatch, for the same reason and with the same
   * cost model: a server attached to every phase of a run is dead weight in the
   * one phase that touches nothing it can see, and every attached server is paid
   * for on every turn.
   */
  mcpOff?: boolean;
  /**
   * What this phase does when one of its servers cannot be reached.
   *
   * The most specific answer there is, and the only one that can overrule the
   * plan: an operator looking at a parked phase knows something the versioned
   * document cannot, which is whether THIS attempt can proceed without it.
   */
  mcpPolicy?: McpPolicy;
  /**
   * Whether the console answers this phase's permission asks itself.
   *
   * BOTH values are stored, like `mcpPolicy` and unlike `skillsOff`: this is
   * the one level that can overrule the plan's policy file and the console's
   * global one, so "the operator said hands-on for this phase" (false) must be
   * distinguishable from "nobody said anything" (absent), which falls through
   * to the plan's and then the console's answer. Resolved in
   * `Service.decideToolUse`; the file scopes live in `runner/approvals.ts`
   * (`autoApproveFor`).
   */
  autoApprove?: boolean;
  /**
   * Whether THIS phase's prompt carries the standing `ultracode` licence.
   *
   * Both values are stored, like `autoApprove` and for the same reason: a phase
   * is where an operator knows something the run-wide answer cannot. "Fan out
   * here" (true) on a run that did not ask for it, and "not here" (false) on a
   * run that did, are both real choices; absent inherits the run's.
   */
  ultracode?: boolean;
};

/**
 * What the operator changed for ONE more attempt at a phase.
 *
 * Retry was all-or-nothing: it cleared the failure and boarded the phase again
 * with byte-identical settings, so the only way to say "same phase, stronger
 * model, and read the review comment first" was to edit the plan — a versioned
 * file — or the run's sticky `phaseOptions`, which would then govern every
 * later attempt too. Both are the wrong shape for a one-off, and the plan is
 * the wrong shape twice over: it is the durable statement of what the phase
 * NEEDS, and an operator reacting to one failure is not amending that.
 *
 * So an override is:
 *
 *   - **one-shot** — spent at the boarding it causes, exactly like
 *     `boardingHint`, which is the field this one is modelled on;
 *   - **on the attempt** — it lives on the phase RECORD, is journalled
 *     verbatim as `phase.retry-override`, and never touches `docs/plans/`;
 *   - **the most specific answer there is** — `optionsFor` reads it ahead of
 *     the run's own `phaseOptions`, which already outrank the plan.
 */
export type RetryOverride = {
  /**
   * Extra words for the boot prompt, appended after the failure context so the
   * session reads what went wrong and then what the operator wants done about
   * it. Verbatim: this is a person talking to the session, and paraphrasing it
   * into a template would be the console inventing an instruction.
   */
  addendum?: string;
  /**
   * Settings for this attempt only. The same shape the operator can already
   * choose per phase — so nothing new to learn, and `optionsFor` resolves it
   * with one extra line rather than a second resolution order.
   */
  options?: PhaseOptions;
  at: string;
  by?: string;
};

/**
 * Every kind a halt can carry, written at the halt site. The runtime list —
 * and the profile that decides how each kind is treated — lives in
 * `shared/recovery-model.js` (`HALT_KINDS`), and this is that list's type,
 * DERIVED rather than mirrored: the union this used to spell out claimed a
 * test pinned it identical, and `plan-deadlocked` was written by the drive
 * loop for weeks while in neither (LFC-1). It escaped through
 * `HaltKind | (string & {})`, which is gone too. A record written by another
 * version still LOADS — JSON does not consult types — and `settle()` gives a
 * kindless legacy halt its word (`healLegacyHalt`), so the type says what this
 * console writes and nothing wider.
 */
export type HaltKind = (typeof HALT_KINDS)[number];

/**
 * One person's note on a run (control-tower phase 96, #142).
 *
 * The watchdog that supervised four runs on 2026-09-25/26 kept about 400 lines
 * a day of decisions and their reasons in a log of its own, because the
 * console had nowhere to put them. A note is that line, on the run it is
 * about: journalled as `run.note`, drawn on the timeline, and — when PINNED —
 * shown on the run page and read into the boot prompt of every phase it
 * applies to, until somebody unpins it.
 */
export type RunNote = {
  /** Twelve hex characters — what an unpin names. */
  id: string;
  at: string;
  by: string;
  text: string;
  /** A standing decision rather than a remark: it stays in front of every reader until unpinned. */
  pinned: boolean;
  /** The phase it is about; absent means the whole run. */
  phase?: number;
  /**
   * The door it was written through (control-tower phase 131, #208) — the
   * supervisor's notes reach a session under their own header, never as a
   * person's decision (`pinnedNotesBlock`). Absent on a note written before.
   */
  door?: PressDoor;
};

/** The longest note a run keeps — a paragraph, not a file. */
export const RUN_NOTE_MAX = 2000;

/** How many UNPINNED notes a run record keeps; a pinned one is never dropped. The journal keeps them all. */
export const RUN_NOTES_KEPT = 200;

/** A run's notes after one more: every pinned note, and the newest `RUN_NOTES_KEPT` of the rest. */
export function keepNotes(notes: readonly RunNote[]): RunNote[] {
  const loose = notes.filter((note) => !note.pinned);
  const drop = new Set(loose.slice(0, Math.max(0, loose.length - RUN_NOTES_KEPT)));
  return notes.filter((note) => !drop.has(note));
}

export type RunState = {
  id: string;
  slug: string;
  root: string;
  status: RunStatus;
  autonomy: Autonomy;
  /** The model each phase starts on; a limited model falls back from here. */
  model: string;
  /** The reasoning effort each phase starts at, unless the phase overrides it. */
  effort?: string;
  /**
   * QA's own model and effort. Absent means "the phase's, then the run's" —
   * exactly what QA got before these existed, so a run file written without
   * them means what it always meant.
   *
   * The review is a different job from the build and is regularly worth a
   * different tier in EITHER direction: "build with Fable at high, review with
   * Opus at max", or a cheap reviewer over a mechanical phase. Until this,
   * saying so was impossible — QA inherited the builder's settings and there
   * was no line to write anywhere that would change it.
   */
  qaModel?: string;
  qaEffort?: string;
  /**
   * How many rounds QA may FAIL on one phase before the run stops asking and
   * hands the phase to a person. Absent means {@link DEFAULT_QA_MAX_ROUNDS}.
   *
   * This is a budget the `ladder*` caps could not express. They count rungs and
   * dollars; a QA round driven from inside a phase's own session is neither, so
   * nothing counted rounds at all — one phase on the run issue #7 was written
   * from reached five. `state.consecutiveFailures` does not help either: it
   * counts phase ATTEMPT failures, and a `fail` verdict never touched it.
   */
  qaMaxRounds?: number;
  /**
   * Minutes an approval card waits for a person before it times out
   * (control-tower phase 97, #140). Absent: the hook call's own hour, less
   * the broker's margin — which is also the ceiling: past it the call fails
   * open, so a longer wait is an Extend and a card that stands, never this.
   */
  approvalTimeoutMinutes?: number;
  /**
   * QA RECOVERY's two: how a fix session is boarded, and what ONE ROUND of the
   * loop may spend. `shared/run-settings.js` owns both vocabularies and the
   * strategy's default; absent means `resume` and no per-round stop.
   *
   * The round budget is deliberately not `phaseBudgetUsd`: a loop under a phase
   * budget alone spends the whole allowance on round one, and the round that
   * would have fixed it has nothing left. It is a hard stop for the ROUND and
   * never for the run.
   */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  /**
   * This run's own ladder rung caps (control-tower phase 5, #14) — how many
   * counted rungs the run may climb across its OPEN phases, and one phase
   * may climb. Absent = the console's `ladderPerRunRungs` /
   * `ladderPerPhaseRungs` preference speaks (`runLadderCaps`); a value here
   * beats it. Set at the launch door and by a settings patch (the verb
   * phase 14's raise announces); `null` on a patch clears it.
   */
  ladderPerRunRungs?: number;
  ladderPerPhaseRungs?: number;
  /**
   * The account's usage window as the CLI last reported it mid-session. Not a
   * decision the runner makes — a fact worth showing before someone starts a
   * twelve-phase run against a window that is nearly spent.
   */
  limits?: {
    status: string; window?: string; utilization?: number; utilizationPct?: number; resetsAt?: number; at: string;
    /** The session is running on credit past the window (control-tower phase 93, #146), and the CLI's overage words. */
    usingOverage?: boolean; overageStatus?: string; overageDisabledReason?: string;
  };
  /**
   * What this run's sessions spent ON CREDIT, past their plan windows
   * (control-tower phase 93, #146) — booked with `spentUsd` by `bookSpend`,
   * from the turns after a session's first `isUsingOverage`. Part of
   * `spentUsd`, never beside it. Absent: nothing ran on credit.
   */
  creditUsd?: number;
  /**
   * The Claude account this run's sessions spawn as, from the instance's
   * registry. Written as an omission when it is the machine login — a run file
   * from before accounts existed means exactly what it meant, and an id that
   * has since been removed degrades to the same place (`envFor` answers null).
   */
  accountId?: string;
  /**
   * The last account switch a PERSON made on this run (control-tower phase 78,
   * #106) — what they moved it to, from what, when and who. The ladder reads it:
   * a switch that moves the run back onto `from` reverses that person, and is
   * journalled `run.account-switch-reverted` and announced. Written by the
   * operator's verb (live or stored), never by an automatic mover; replaced by
   * the next person's switch.
   */
  accountChoice?: AccountChoice;
  /**
   * Where an automatic switch moved the run FROM (control-tower phase 92,
   * #100): the next boarding after that account's reset moves the run back —
   * past the horizon rule, which would weigh a just-reset window against the
   * new account's days-off wall — and a wall wait on the new account wakes at
   * that reset. Cleared by the move back and by a person's switch.
   */
  switchedFrom?: SwitchedFrom;
  /**
   * The identity this run is bound to (control-tower phase 91, #131) — who its
   * account answered when the run started, or when a person last chose (a
   * switch, "continue on the new login"). `default` is a SLOT that follows the
   * machine login: a re-login as somebody else must never move the run onto
   * their quota unseen, so every boarding compares the account's identity NOW
   * with this, and a difference parks the run with an errand
   * (`run.identity-changed`, halt kind `identity-changed`). Absent on a run an
   * older console started, or one no registry could name — nothing is compared.
   */
  identity?: BoundIdentity;
  /**
   * What to do when a session hits the SHARED usage window (session/weekly —
   * model-specific limits keep their own model-switch path). Absent means
   * `wait`, which is the pre-accounts behavior: sleep to the reset. `switch`
   * checkpoints and continues under the account with the most headroom;
   * `pause` checkpoints and stops for a person.
   */
  onLimit?: OnLimitPolicy;
  /**
   * What the run may do to a phase's model (control-tower phase 54, #91) —
   * `pinned` keeps it: no `--fallback-model`, no step down on a wall, no step
   * up on a rung. Absent = `ladder`, the behaviour before the word existed. A
   * plan's `**Model policy:**` outranks it (`modelPolicyFor`).
   */
  modelPolicy?: ModelPolicy;
  /**
   * What each model this run ASKED for resolved to, the first time and the
   * latest (control-tower phase 54, #91) — keyed by the request (`opus[1m]`,
   * `claude-opus-5-5[1m]`). `run.model-resolved` is journalled when an entry is
   * born and when its `resolved` moves, so an alias moving under a live run
   * says so once, and the run view shows it.
   */
  resolvedModels?: Record<string, { resolved: string; at: string; from?: string }>;
  /**
   * The run's answers to the decision manifest (phase 11, ZTD-2/ZTD-8): the
   * four the launch form requires, and the manifest as it resolved at the
   * door. `resumeOnRestart` is THE answer `converge.ts` reads when a console
   * restart stopped this run — `true` relaunches, `false` writes the errand,
   * absent (a run from before 5.0.0) falls back to the `resumeAtBoot`
   * preference and its ask. `relay` is Tier 2's switch (phase 14). `accounts`
   * is the ordered list this run may spend with the minimum five-hour
   * headroom each must show. `manifest` is what `run.start` echoed: every row
   * with its state and source, the probes' verdicts, and the override if the
   * door was passed on one. All optional and all omitted when absent, so a
   * run file from an older console reads exactly as it did.
   */
  resumeOnRestart?: boolean;
  relay?: RelayMode;
  /**
   * Whether the relay is ARMED for this run's sessions (phase 14) — `relay:
   * last-resort` asks for it, and it arms only at a CLI read at or above
   * `RELAY_CLI_FLOOR` from `system/init.claude_code_version`
   * (`session-record.ts` `relayArmingFor`). Decided at the spawn door, moved
   * again by a session's own init, and what the hook reads before relaying a
   * question: `armed: false` with a `reason` is a run on the floor, journalled
   * `run.relay-refused`. Absent until a relay-on run first spawns.
   */
  relayArming?: { armed: boolean; version: string | null; floor: string; reason?: 'below-floor' | 'version-unknown'; at: string };
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  manifest?: ResolvedManifest;
  /**
   * The operator's answers at the start door for §Verification (2026-09-18) —
   * what the run may execute that the built-in tier would not, and what it may
   * set aside. See `RunVerifyApprovals`. Absent on runs started before it.
   */
  verifyApprovals?: RunVerifyApprovals;
  /**
   * The plan git lines this run runs over, answered `override` at launch — by
   * a person, or `automatic` from a door no person pressed (control-tower
   * phase 11, #18). The boot prompt turns each into a concrete instruction
   * instead of asking the session to record a discrepancy.
   */
  gitStrategyOverride?: { lines: { kind: string; plan: string; run: string; phases?: number[] }[]; ack: 'override' | 'automatic'; by?: string; at?: string };
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  /**
   * The WALL-CLOCK time this run had at least one phase waiting in the
   * admission queue, by the class of what held it (control-tower phase 60,
   * #64; `queue-episodes.ts` `foldRunBlocked`). Each instant is charged once,
   * to the first class in `BLOCKED_BY_ORDER` heading any phase then queued, so
   * three siblings behind one stranger for an hour are one blocked hour — the
   * phases' own `queuedMs` would say three. Closed stretches only; the one
   * open now is `blockedOpen`. `phase_console_run_blocked_seconds_total`.
   */
  blockedMs?: Partial<Record<HolderClass, number>>;
  /** The stretch of `blockedMs` open now: the class it is charged to, and since when. */
  blockedOpen?: { class: HolderClass; since: string };
  /**
   * The cost model `spentUsd` and every `PhaseRecord.costUsd` were booked under
   * (`COST_MODEL`, control-tower phase 46, #62): absent is `1`, every spawn's
   * reported total added whole; `2` is each spawn's rise over its session's mark.
   * A new run is born `2`; a stored run is re-priced to `2` once, at boot.
   */
  costModel?: number;
  /**
   * The clock model every `PhaseRecord.attemptWindows` was kept under
   * (`CLOCK_MODEL`, control-tower phase 58, #66): absent is `1`, where only a
   * phase's own attempts opened a window; `2` is every session that worked the
   * phase. A new run is born `2`; a stored run is re-measured from its journal's
   * `phase.session` lines once, at boot (`remeasureFromLedger`).
   */
  clockModel?: number;
  maxConsecutiveFailures: number;
  /**
   * The failure streak's SIZE — `failureStreak.length` whenever this build
   * wrote it, and kept on the wire under its old name because every surface
   * (the tiles, the ways-forward card, the relaunch refusal) reads a number.
   * Raised only by `chargeFailure`; zeroed only by `resetStreak`.
   */
  consecutiveFailures: number;
  /**
   * The failure streak itself (control-tower phase 45, #45, #59): the ordered
   * set of DISTINCT phases whose ending was a merit failure
   * (`MERIT_FAILURE_CAUSES`) since the last phase that settled done. A second
   * ending of a phase already here charges nothing, and a phase the board
   * closes leaves it (`reconcileRecordsAgainstBoard`). Read it through
   * `streakPhases`, which answers `[]` for a zero count whatever is stored.
   * Absent on a run written before the set existed, whose count names no phase.
   */
  failureStreak?: number[];
  /**
   * The run-wide budgets already warned at `BUDGET_WARN_PCT` (control-tower
   * phase 14, #40): budget → the key it was claimed under (`claimBudgetWarning`),
   * so the run budget is announced once per limit, across restarts.
   */
  budgetWarned?: Record<string, string>;
  /**
   * A budget past its warning line and not yet raised (control-tower phase 25,
   * #40): budget → the fact as `noteBudgetApproaching` measured it, so the run
   * page draws the approach with its raise before the park. A raise removes it.
   */
  budgetApproaching?: Record<string, BudgetFact>;
  /**
   * What each counted phase was charged ON, where the charge named a root cause
   * (control-tower phase 87, #122): the blamed commit, else the refs a block
   * watched (`failureRootOf`). A second charge on a key already here is held —
   * one sibling's red WIP stopping four phases is one failure, not four — and
   * the streak's halt names each cause. Entries leave with their phases
   * (`pruneStreak`, `resetStreak`); a charge that named nothing has none.
   */
  failureRoots?: { phase: number; key: string; label: string }[];
  createdAt: string;
  updatedAt: string;
  activePhase: number | null;
  /**
   * Set while a child is alive, so a restarted console can tell what it
   * interrupted.
   *
   * **A MIRROR of one live lane, and load-bearing as such.** A run may now
   * drive several phases at once (`children`), but this field is what every
   * console built before lanes reads to answer "is something running, and
   * what?" — including `reconcileRun`'s own orphan check, the freeze/stop
   * paths, and any older build of this client still open in a browser tab.
   * Dropping it in favour of `children` alone would make all of them report a
   * busy run as idle, which is the one lie this file exists to prevent. So the
   * runner writes BOTH: `children[phase]` for every live lane, and this for
   * whichever lane is currently the mirror. See `Runner.attempt`.
   */
  child: ChildRef | null;
  /**
   * Every live lane, keyed by phase number as a string.
   *
   * Absent on a run written before lanes existed, which is exactly why every
   * reader spells it `children ?? {child}` — one lane recorded the old way and
   * one recorded the new way must reconcile identically.
   */
  children?: Record<string, ChildRef>;
  /**
   * The console's OWN lanes, keyed by phase (control-tower phase 89, #68's
   * 2026-09-25 05:44Z comment): a §Verification, a baseline or a wrap-up's
   * fast gate the runner is running right now, under the phase's grant, with
   * no session behind it. `children` holds only sessions, so a run mid-
   * verification read `running` with nothing in it and the Runs page showed
   * nothing working. Written as each command starts, removed when the pass
   * ends; a console that dies mid-pass leaves one whose `pid` is gone, which
   * readers treat as over.
   */
  verifying?: Record<string, VerifyingLane>;
  /**
   * The lane's beat (control-tower phase 105, #173): stamped when a lane's
   * lock is claimed and at every refresh of it, with the identity of the
   * console process doing the refreshing. A lock the lane refreshes keeps the
   * run `running` on a read that does not know it is live (`laneInFlight`) —
   * the quiet steps with no child to point at (the gap between two commands, a
   * post-verify lint) included.
   */
  laneBeat?: { at: string; pid: number; procStartedAt: string };
  waitUntil: string | null;
  /** Which wait `waitUntil` is — see `WAIT_REASONS`. Absent on older runs. */
  waitReason?: WaitReason | null;
  /**
   * What the run IS, with the transitions and the reasons lifted out of
   * `status` — see `shared/run-lifecycle.js`.
   *
   * Written BESIDE `status` by `setRunState`, never instead of it: 3.5.0 writes
   * both shapes so an older console reading a file this one produced still
   * finds the word it knows, and 3.6.0 drops `status`. Absent on every run
   * written before 3.5.0, which is why nothing reads this field directly —
   * `runLifecycle(state)` answers from it when it is there and derives the
   * identical answer from `status` when it is not.
   */
  lifecycle?: RunLifecycle;
  /**
   * The budget wall's one rung, once climbed: the run budget was raised from
   * `from` to `to` by `pct` percent (`budgetAutoRaisePct`, within the ladder's
   * per-run USD cap) when it was first spent. Its presence is what makes the
   * raise happen ONCE per run — the second exhaustion halts with the errand —
   * and survives a console restart, which a flag in memory would not.
   */
  budgetRaise?: { from: number; to: number; pct: number; at: string };
  /**
   * Why the run stopped and started asking for a person. `kind` is the
   * machine-readable class (`verify-failed`, `needs-human`, …) written at the
   * halt site so the auto-recovery classifier reads a name instead of parsing
   * a sentence; absent on records written before kinds existed, which is why
   * every reader keeps a fallback on the words.
   */
  halt: {
    at: string; reason: string; phase?: number; kind?: HaltKind;
    /** The accounts fact a credential-class halt carries (`ACCOUNT_HALT_KINDS`, phase 3). */
    accounts?: { unusable: number; total: number };
    /** A drive-loop park with nothing ready: one row per phase holding it (`haltHolders`, phase 5). */
    holders?: HaltHolder[];
    /**
     * The budget a `budget` or `failure-streak` halt spent (control-tower phase
     * 14, #40): its arithmetic and what spent it, for the card and its raise.
     */
    budget?: BudgetFact;
    /**
     * The approval card whose timeout raised this park (control-tower phase 97,
     * #140) — what lets the park LIFT when the phase it was about completes.
     */
    approvalId?: string;
  } | null;
  /**
   * A pause that has been asked for but not yet reached.
   *
   * `status: "pausing"` on its own tells an operator almost nothing — not when
   * they asked, not what it is waiting for, and not whether the request even
   * landed. It landed silently for so long that pressing Pause looked like a
   * no-op. This records the request the moment it is made, names the phase that
   * has to finish first, and is cleared either by the pause taking effect or by
   * the operator cancelling it.
   */
  pause: { requestedAt: string; afterPhase: number | null; by: string } | null;
  /**
   * A session stopped where it stands, and when that stops being the cheap
   * option. Null whenever nothing is frozen — including immediately after a
   * `thaw()` or an escalation, so a stale block can never make a live run look
   * held.
   *
   * `escalateAt` is optional for the reason it is optional on `FreezeRef`: a
   * STANDING freeze — the fleet-freeze form — has no deadline, and
   * `freezeVerdict` already reads its absence as "leave this freeze standing".
   */
  freeze: { at: string; phase: number | null; pid: number; by: string; escalateAt?: string } | null;
  /**
   * Why the loop stopped, in the words the operator needs.
   *
   * `status` says *that* a run ended and `halt` says why it was halted, but the
   * ordinary endings — the plan is finished, the phases this run was asked for
   * are all settled, the budget is spent — went to the journal and nowhere the
   * console could show them. A run that stops after one phase because it was
   * scoped to one phase looks broken without this.
   */
  finishedReason?: string;
  /**
   * Run only these phases, in the usual ready order, then stop. Empty or absent
   * means "every phase that becomes ready", which is the normal run.
   */
  onlyPhases?: number[];
  /** Per-phase choices, keyed by phase number. See `PhaseOptions`. */
  phaseOptions?: Record<string, PhaseOptions>;
  /** Skills every phase of this run invokes, on top of the plan's own. */
  skills?: string[];
  /**
   * MCP servers every phase of this run attaches, on top of the plan's own.
   *
   * Registry ids, checked against the live registry when the run starts —
   * they become a child process's configuration, so an id that no longer
   * resolves is reported to the session rather than silently dropped.
   */
  mcpServers?: string[];
  /**
   * This run's answer to an unreachable MCP server, seeded from the console
   * preference at launch. Absent means the shipped default, `continue`.
   *
   * The plan outranks it, deliberately: a run-wide "carry on regardless" is an
   * operator's convenience for one launch, while a phase that says it requires
   * its server is a versioned statement about the work.
   */
  mcpPolicy?: McpPolicy;
  /**
   * The run's DEFAULT permission mode (control-tower phase 11, #34) — what a
   * phase's session starts in when neither the attempt, the run's per-phase
   * choice nor the plan's bullet or line says (`resolvePermissionMode`).
   * Absent means `acceptEdits`, so every run written before it reads the same.
   */
  permissionMode?: PermissionMode;
  /**
   * How many phases of THIS run may be in flight at once.
   *
   * Absent means the console's own `--max-sessions`. A run may ask for fewer
   * — a plan whose phases share a repo gains nothing from lanes and an
   * operator may simply want to watch one thing at a time — but never for
   * more: the scheduler's global cap is about the machine, and a run does not
   * get to raise it.
   */
  maxParallel?: number;
  /**
   * How much this run may do without stopping to ask — `guarded` (the default
   * and what every run did before profiles existed), `trusted`, or `bypass`.
   *
   * On the state rather than only in the settings file because it is the thing
   * an operator most needs to see in the header: a run quietly on `bypass` and
   * a run on `guarded` look identical otherwise, and only one of them is
   * committing without asking.
   */
  permissionProfile?: PermissionProfile;
  /**
   * The run works on one plan-wide branch (`pe/<slug>`) instead of whatever is
   * checked out. **Absent means default-branch** — a run file written before
   * this feature keeps meaning what it meant, so the only branching state a
   * reader ever tests is `state.gitMode === 'new-branch'`.
   */
  gitMode?: 'new-branch';
  /**
   * Whether the final phase is told to push the branch and open a PR.
   * Meaningful only with `gitMode: 'new-branch'`; absent there means true.
   */
  openPr?: boolean;
  /**
   * What this run ASKED for — its own checkout, or the shared one.
   *
   * **Absent means `queue`**, the same omission convention `gitMode` uses and
   * for the same reason: every run file written before isolation existed keeps
   * meaning exactly what it meant, and the only isolation state a reader tests
   * is `state.isolation === 'worktree'`.
   *
   * This is the REQUEST and not the outcome — `checkout` below is what the run
   * actually got. Keeping the two apart is what lets a refusal degrade to the
   * shared checkout visibly instead of failing the run.
   */
  isolation?: IsolationMode;
  /**
   * What happens to this run's work branch when the run ENDS.
   *
   * **Absent means "ask `openPr`"**, not "`pr`" — and the difference is the
   * whole back-compatibility story. Every run file written before this field
   * existed carries `openPr`, and a run that said `openPr: false` asked for
   * precisely what `keep` means. `settleOf()` in `shared/worktree-model.js` is
   * the single place that folds the two, and every reader goes through it
   * rather than testing this field directly.
   *
   * Written only under `gitMode: 'new-branch'`, like `isolation` and for the
   * same reason: a run with no branch of its own has nothing to settle, and a
   * strategy stored on one would read as configured and do nothing.
   */
  settle?: SettleStrategy;
  /**
   * What this run actually GOT, once the drive preamble has tried.
   *
   * **Absent means `shared`** — every run file written before isolation
   * existed, and every run that never asked. A reader tests
   * `state.checkout === 'worktree'` and nothing else: `refused` and absent are
   * both "this run is in the console's own checkout", they differ only in
   * whether anyone asked for otherwise, and that difference is for the operator
   * to read rather than for admission to act on.
   *
   * Written ONCE per run, by the preamble, and never by a settings patch:
   * isolation goes one way mid-run (`RunSettingsPatch.isolation`) and a
   * checkout that already exists is a fact about a directory on disk, not a
   * setting.
   */
  checkout?: CheckoutState;
  /**
   * The directory this run's sessions work in — its managed worktree.
   *
   * **Absent means `root`**, which is what every reader falls back to
   * (`RunnerBase.laneRoot`: `lane.worktree ?? state.workRoot ?? state.root`).
   * MINTED only in the same breath as `checkout: 'worktree'` and never on its
   * own, so a run that degraded can never claim a tree it does not have — the
   * same rule `ChildRef.worktree`/`branch` follow, and for the same reason.
   *
   * The reverse direction is not symmetric, and deliberately so: when a settle
   * removes the tree this field goes and `checkout` STAYS `worktree`. The field
   * points at a directory, so a path to nothing is a lie; `checkout` records
   * what the run GOT, which does not stop being true once the checkout has been
   * swept up after it.
   *
   * `root` itself is NOT rewritten. It stays the console's own checkout, which
   * is where work-state (the handoff, `.locks/`, QA rows) lives and where
   * `DOCS_ROOT` points; the split between "where the code is" and "where the
   * plan is" is the whole reason a lane session needs `--add-dir`.
   */
  workRoot?: string;
  /**
   * The repositories a MIRROR workRoot holds, as root-relative paths.
   *
   * Present only when `workRoot` is a mirror — a superproject run's checkout,
   * one linked worktree per scoped repository rather than one tree of the
   * (refused) root. MINTED and CLEARED in exactly the same breaths as
   * `workRoot`, so a reader may treat `workRoot && mountedRepos?.length` as
   * "the work tree is a mirror" and plain `workRoot` as "a single checkout".
   * The on-disk manifest (`worktree.ts` §`MIRROR_MANIFEST`) stays the
   * authority for sweeps of runs whose state file is gone.
   */
  mountedRepos?: string[];
  /**
   * Mounts whose `pe/<slug>` this run DELETED before a final phase's
   * §Verification, because it held nothing (`settleIdleMirrorBranches`,
   * control-tower phase 62, #47): each is detached at the commit it stood on.
   * While this stands, the next session spawned into the mirror first puts
   * each branch back (`restoreSettledMirror`), so no session ever commits to a
   * settled mount's detached HEAD; a red final verdict puts them back at once.
   */
  mirrorSettled?: { phase: number; at: string; mounts: string[] };
  /**
   * The repositories whose run branch was NOT on its trunk when every phase
   * was done (control-tower phase 112, #184) — set with the `unlanded` park,
   * from `landingProofs`. `phase` is the last phase this run finished: the
   * errand card's merge errand tree is made for it.
   */
  unlanded?: { at: string; phase: number | null; repos: LandingProof[] };
  /**
   * Which impossibility this run hit, when `checkout` is `refused`.
   *
   * One of `worktree.ts` §`REFUSAL_REASON`'s keys — the reason is looked up
   * from there rather than stored, so a run file never carries prose that can
   * fall out of step with the code that explains it.
   */
  isolationRefusal?: WorktreeRefusal;
  /**
   * The refusal's own words — git's message, or the occupied mounts and their
   * state (control-tower phase 90) — which the park's halt and the inbox
   * errand quote. A fact about THIS refusal, not the category's sentence
   * (that stays `REFUSAL_REASON`'s), and cleared with `isolationRefusal`.
   */
  isolationRefusalDetail?: string;
  /**
   * A person pressed Repair checkout (control-tower phase 90, #139): the next
   * checkout decision may move DIRTY or UNPUSHED foreign content at a mount to
   * `stale-mounts/` (clean content moves without it). One-shot — spent by the
   * decision it was pressed for, because the word covered what the person was
   * shown, not whatever a session puts there next.
   */
  repairCheckout?: { at: string; by: string };
  /**
   * The operator asked to switch this shared-checkout run to its OWN checkout
   * at its next boundary (control-tower phase 90, #150): applied by the first
   * fill with no lane of the run live, and cleared either way — a switch the
   * checkout then refuses leaves the run shared and says why.
   */
  isolateAtBoundary?: { at: string; by: string };
  /**
   * Phases of a SHARED-checkout run the operator gave their own worktree
   * (`isolate-phase`, control-tower phase 90, #150): each boards in a lane
   * worktree on `pe/<slug>-p<N>` and merges back, the `phase-lane.sh` shape,
   * and no run-long branch hold reaches it.
   */
  isolatePhases?: number[];
  /**
   * The commit this run's checkout is DETACHED at, when it owns no branch.
   *
   * Present only for the third checkout shape: a run whose `pe/<slug>` has
   * been merged and deleted and which still has phases to drive, or one whose
   * plan says `- **Checkout:** main`. There is no branch to stand on, and
   * minting one would re-open work the merge closed — so the tree is detached
   * at the default branch's head instead. It claims no ref, so any number of
   * them may stand beside each other and beside whoever holds the branch.
   *
   * Read by `branchFor`, which reports it as `detached@<sha12>` — the lock's
   * qualification, and the one string that distinguishes two detached claims
   * exactly when their trees genuinely differ.
   */
  detachAt?: string;
  /**
   * When this run's branch had its fate decided — the moment `settleRun` ran.
   *
   * The one fact that separates *"the run branch was merged away"* from
   * *"the run branch has not been created yet"*, and they are otherwise
   * IDENTICAL to a `rev-parse`: both are a missing ref. Without it, every
   * brand-new run detached on its very first drive, which is a defect the whole
   * P8 concurrency suite caught the moment it was written.
   */
  settledAt?: string;
  /**
   * The branch each SHARED repository stood on when this run first boarded
   * into it (physical path → branch, or `detached@<sha12>`), so the run's
   * settle can return a tree it checked out to where it found it
   * (control-tower phase 40, #41). Never written for a run whose trees are
   * its own (a mirror, a lane, an isolated run).
   */
  treesFound?: Record<string, string>;
  /**
   * The shared repositories this run holds on its branch until it SETTLES —
   * one per repository, written at `run.tree-hold` beside its record under
   * `<state>/trees/`, dropped at `run.tree-released`. A lock is per phase;
   * this is per run.
   */
  treeHolds?: { repo: string; dir: string; branch: string; foundOn?: string; at: string }[];
  /**
   * Which class this run's admissions are scanned in.
   *
   * **Absent means `normal`**, the same omission convention `isolation` and
   * `gitMode` use: every run file written before priorities existed keeps
   * meaning exactly what it meant, and the only priority a reader ever tests
   * is the one `runPriority()` gives it.
   *
   * It orders the scan and nothing else. It does not raise a cap, does not
   * bypass a lock, and — this is the load-bearing part — does not defeat the
   * aging promotion: a starved `low` still reserves its tokens against every
   * fresh `high` behind it. A class is a preference; starvation is a bug.
   */
  priority?: RunPriority;
  /**
   * The seven words the launch form gained in many-plans-one-repo phase 15 —
   * each ALSO a plan line, and the plan outranks every one of them (the
   * `mcpPolicy` precedent: a plan's statement is versioned and describes the
   * work; a launch choice speaks only where the plan is silent). Each is
   * written only when it says something, so a run file from before the field
   * means what it always meant.
   *
   * `baseBranch` — what `pe/<slug>` (and every lane's `pe/<slug>-pN`) is cut
   * from, when the plan's `**Base branch:**` says nothing; absent means the
   * console's `baseBranch` preference, then `origin/HEAD`. Immutable once the
   * branch EXISTS (`checkout` set): the fork already happened, and a new word
   * would describe one that never did. The route refuses it with a 409.
   */
  baseBranch?: string;
  /**
   * What `baseBranch` (or the plan's line, or the preference, or the shipped
   * word) RESOLVED to, pinned at the moment the run's branch was cut — the
   * ref as a person writes it, the commit it stood at, which arm answered
   * (`origin-head` · `trunk` · `head` · `ref`, `worktree.ts` `BaseSource`)
   * and who declared the word (`plan` · `run` · `console` · `default`).
   * Written once by the runner's `baseFor()` (phase 15) beside the
   * `run.base-branch` journal line; absent on a run whose word resolved to
   * nothing, and on every run file from before the field.
   */
  base?: { ref: string; sha: string; source: string; declaredBy: PolicySource };
  /**
   * How many isolated runs this run will stand BESIDE in its repository — the
   * admission threshold it is judged against, clamped to the console's own
   * `maxConcurrentPerRepo` (a run may make itself more conservative, never
   * outbid the console; the `maxParallel`/`--max-sessions` rule). Absent
   * means the console's number.
   */
  maxConcurrentPerRepo?: number;
  /**
   * What becomes of the trees the console mints for this run when it
   * settles — `WORKTREE_RETENTION`, or `ttl:<h>`. Absent means the console's
   * `worktreeRetention` preference, read fresh at the settle.
   */
  worktreeRetention?: string;
  /**
   * What happens to a phase's commits when it settles, when neither the
   * phase's `- **Land:**` nor the plan's `**Landing:**` says. **Absent means
   * `hold`** — the one policy that writes nothing.
   */
  landing?: LandPolicy;
  /**
   * What a landing that will not merge cleanly does, when the plan's
   * `**Conflicts:**` says nothing. **Absent means `halt`.**
   */
  conflictPolicy?: ConflictPolicy;
  /**
   * Whether this run's sessions may message each other, when the plan's
   * `**Messaging:**` says nothing. **Absent means `on`**, so only `off` is
   * ever written. Lands on the next spawn: a session's settings file and its
   * token are written per attempt.
   */
  messaging?: MessagingWord;
  /**
   * Whether a session may open an issue for something outside its phase, when
   * neither the phase's `- **Issues:**` nor the plan's `**Issues:**` says.
   * **Absent means `off`** — an outward write is never a default. A patch
   * may only TIGHTEN it (`file` → `draft` → `off`); the route refuses the
   * other direction with a 409.
   */
  issuesMode?: IssueMode;
  /**
   * The operator has stopped this run boarding anything new.
   *
   * Deliberately NOT a status, and deliberately not `pause`. A pause is a
   * boundary the LOOP waits for and it settles the run; a hold is an admission
   * gate — live lanes keep running to their ends, and only the next `admit()`
   * is refused. That is what makes it the right verb for "let this plan finish
   * what it started, and let the other one go first".
   *
   * `null` and absent both mean not held; the object records when and by whom
   * so the queue page can say more than "held".
   */
  hold?: { at: string; by?: string } | null;
  /**
   * Board nothing until this OTHER plan's latest run settles.
   *
   * A slug, not a run id: the operator is chaining plans, and the run they
   * would have named may not exist yet when they set it. Start-only — a chain
   * is a statement about where a run begins, and a run already mid-plan cannot
   * un-begin — and durable, so the chain survives a console restart.
   */
  startAfter?: string;
  /**
   * Launch a fresh reviewer session at each phase-finish (`reviewer.ts`).
   *
   * Absent means off, and that is the default on purpose: this spends money
   * per phase and — under `reviewerPolicy: 'may-hold'` — can park every phase
   * behind the one it reviewed. A console someone upgraded must not start
   * doing either without being asked.
   */
  reviewEachPhase?: boolean;
  /**
   * What that reviewer is ALLOWED to record. Absent reads as the cautious
   * `comment-only`, where a `requested-changes` is downgraded to `commented`
   * on the way in — findings recorded and shown, nothing held.
   */
  reviewerPolicy?: ReviewerPolicy;
  /**
   * Carry the standing `ultracode` licence into every prompt this run composes.
   *
   * Absent means off, the same omission convention as `reviewEachPhase`: a run
   * file that says `ultracode: false` and one that says nothing must not be two
   * different things to read. What the word does is `server/skills.ts`
   * (`ULTRACODE_LINE`) — it licenses the session's Workflow tool, which fans
   * out dozens of agents, so it is a token bill nobody may inherit by upgrade.
   */
  ultracode?: boolean;
  /**
   * When this run spends the operator's cloud budget on `claude ultrareview`.
   *
   * Absent reads as `off` — the third word is never written, for the same
   * reason `reviewEachPhase: false` is not. `each-phase` reviews the phase that
   * just finished in the checkout it worked in; `at-settle` reviews the run's
   * branch once, before the branch's fate is decided. Its verdict obeys
   * `reviewerPolicy` exactly as the session reviewer's does — one rule, two
   * readers (`server/runner/ultrareview.ts`).
   */
  ultraReview?: UltraReviewMode;
  /**
   * Set once this run stopped being something a person has to deal with — by
   * the board overtaking it, or by someone dismissing it. Never a reason to
   * hide or delete the run: see `RunResolution`.
   */
  resolved?: RunResolution | null;
  /**
   * The convergence loop's "nothing changed" latch, persisted WITH the run
   * (SLF-7). `lastNoop` is the evidence fingerprint of the last heal pass that
   * found nothing to climb; while the evidence still reads the same the planner
   * skips instead of re-deriving and re-journalling "found nothing". It lived
   * only in the scheduler's memory, so every boot started blank — 1 392 of
   * 1 524 heal passes launched nothing, and each of 15 restarts began the
   * churn again. Cleared by the pass that launches something.
   */
  converge?: { lastNoop: string; at: string } | null;
  /**
   * A person put this run's card back, and the board resolver does not get to
   * overrule that on the next read.
   *
   * Without it, un-dismissing an auto-resolved run is a no-op you can watch
   * happen: the card returns, the next read finds the same settled board, and
   * it resolves all over again. An operator saying "no, I still want to see
   * this" is a stronger signal than the inference, so it sticks until they
   * dismiss it themselves.
   */
  reopenedAt?: string | null;
  /**
   * What people decided about this run, and why, in their own words
   * (control-tower phase 96, #142) — oldest first. The journal has every note
   * as `run.note`; this is the copy the run page and the next boarding read,
   * so it keeps every PINNED note and the latest `RUN_NOTES_KEPT` others.
   */
  notes?: RunNote[];
  /**
   * Who last stopped this run — the operator (Stop, Pause, a freeze that
   * escalated into a checkpoint) or the system (a halt or park the loop
   * wrote, a usage-window sleep, a console shutdown, a crash reconciled at
   * the next read). The one bit the convergence loop needs that the status
   * does not carry: `paused` after a deliberate Pause and `paused` after a
   * console restart look identical on disk, and only one of them may be
   * picked up again without anyone asking. Cleared when the run starts
   * again. Absent on records written before it existed — readers treat those
   * as the operator's when the status is a pause and as the system's
   * otherwise (`converge.ts` `stoppedByOperator`).
   */
  stoppedBy?: 'operator' | 'system';
  /**
   * The one open ask for a person at RUN level — a stop with no phase to
   * hang it on (a sign-in, an unreadable plan, a killed lane the operator has
   * asked not to resume by itself). Per-phase errands live on
   * `recoveries[phase].errand`; this is the run-wide one the recover verb
   * answers with when nothing else can. Cleared when the run starts again.
   */
  errand?: Errand | null;
  /**
   * Recovery bookkeeping, keyed by phase number as a string (`plan` for a
   * plan-wide repair). `attempts` counts sessions the console launched BY
   * ITSELF — bumped at launch, so a console that dies mid-recovery still
   * remembers it tried — while `lastAt` / `lastReason` / `fixed` record how
   * the newest session ended, whoever started it. Absent on runs that predate
   * the feature, which reads as "never tried".
   */
  /**
   * Checkouts and branches that appeared under this run's sessions and that no
   * sweeper owns. Append-only, capped, deduped by kind+name — a register, not a
   * bin: the console can TELL the operator what exists, and nothing here
   * deletes anything (see `RunArtefact`).
   */
  artefacts?: RunArtefact[];
  recoveries?: Record<string, {
    attempts: number;
    lastAt: string;
    lastReason?: string;
    fixed?: boolean;
    /**
     * How the newest recovery actually ended — `fixed` kept in parallel for
     * old readers. `no-defect` (the recovery concluded nothing was wrong) and
     * `superseded` (the board had already moved past the halt before anything
     * was launched) both exist so an unnecessary recovery is RECORDED as
     * unnecessary instead of scored as a failure that clears nothing.
     */
    lastOutcome?: SettledRungOutcome;
    /**
     * The ladder's own history for this phase — every rung climbed, in
     * order, with what it was for and what it cost (`ladder.ts`). `attempts`
     * and `lastOutcome` above stay in step for readers that predate rungs.
     */
    rungs?: RungRecord[];
    /** The one open ask for a person, when the ladder is exhausted; cleared when the phase moves. */
    errand?: Errand;
    /**
     * This phase's declared external wall was FOLDED into another phase's
     * errand (control-tower phase 6, #19 ask 2): the same scope, the same
     * `--needs external`, the same reason fingerprint. It has no errand of its
     * own and is announced by nobody; that phase's errand names it in
     * `alsoPhases`. A fold whose target errand no longer stands is void, and
     * the phase is given an errand of its own again.
     */
    foldedInto?: number;
    /**
     * The ask the policy table answered instead of a person (phase 11,
     * ZTD-10): which manifest row, which word, from which source. The
     * fingerprint that keeps `phase.policy-answered` to one line per answer
     * per phase, and what the phase page shows in the errand's place.
     */
    policyAnswered?: { decisionKey: string; answer: string; source: string; at: string };
    /**
     * How many times the convergence loop resumed this phase's own session
     * after a console restart killed its lane. Bounded (`converge.ts`
     * `MAX_BOOT_RESUMES`): a lane killed by three restarts in a row is a
     * console problem a person should hear about, not a loop to run forever.
     * Deliberately NOT a ladder rung — a restart is not a remediation, and a
     * resume the console owes the run must not spend the phase's rung budget.
     */
    bootResumes?: number;
    /**
     * The one extra rung this phase's ladder was granted because the rung
     * before it landed commits (`ladderExtendOnProgress`, off by default;
     * `ladder.ts` `progressExtension`). Recorded before the rung is climbed,
     * so a second pass cannot grant it again.
     */
    extended?: { at: string; commits: number; since: string; situation: string };
    /**
     * The `recover` verb's own ledger for this phase (phase 9, RCV-4): how
     * many times it ran, when, under which evidence fingerprint and mode. A
     * recovery over the SAME fingerprint is refused — 16 of 127 recoveries
     * re-halted within seconds having changed nothing, each resetting the
     * halt card's clock — and the count is bounded by `RECOVER_MAX_PER_PHASE`.
     * Cleared by an operator's Retry, never by the console.
     */
    recovers?: { count: number; lastAt: string; lastFingerprint: string | null; lastMode: string };
  }>;
  /**
   * The run heals itself: an auto-recoverable halt launches the fix agent, and
   * a fixed board resumes the run. Absent means off — a run file written
   * before the feature keeps meaning what it meant; new runs get it from the
   * launch dialog, seeded by the `autoRecoverByDefault` pref.
   */
  autoRecover?: {
    /**
     * RETIRED in 3.5.0, and no longer written.
     *
     * It was a second per-phase ceiling, hardcoded `2` and unreachable from the
     * UI, and it silently beat the operator's `ladderPerPhaseRungs` because
     * both bounded the same counter (P6/D5). `nextRung` has owned the per-phase
     * bound since, so the field spent two releases being written and read by
     * nothing — which is the state in which a number is most likely to be
     * picked up again by somebody who assumes it means what it says.
     *
     * Optional rather than deleted: a run file written before 3.5.0 still
     * carries it and must still parse. Nothing reads it, and the ARMING is the
     * object's presence, which is what every reader asked all along.
     */
    attempts?: number;
  };
  /**
   * Decisions this plan's sessions recorded while this run drove it
   * (`runner/rulings.ts`), newest last and bounded.
   *
   * A COPY of what the append-only ledger holds, not the ledger itself: the
   * file at `runs/<instance>/<slug>/rulings.ndjson` is per PLAN and outlives
   * every run, and `GET /api/run/:slug/rulings` reads it directly so it can
   * answer before a run exists. This is the run's own slice, so the timeline
   * and the journal can show a ruling beside the attempt it was made during
   * without going back to disk.
   */
  rulings?: Ruling[];
  phases: Record<string, PhaseRecord>;
};

/* ------------------------------------------------------------------ *
 * Where a run lives
 * ------------------------------------------------------------------ */

/**
 * The four path helpers live in `./run-paths.ts` (a leaf shared with the
 * journal) and are re-exported here so every importer keeps its spelling.
 */
export { consoleRunsDir, journalFile, runDir, runFile };

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

/** The on-limit policies a browser may name; anything else reads as `wait`. */
export { ON_LIMIT_POLICIES };
export type { OnLimitPolicy };

export function isOnLimitPolicy(value: unknown): value is OnLimitPolicy {
  return typeof value === 'string' && (ON_LIMIT_POLICIES as readonly string[]).includes(value);
}

/** A model policy a door may name (control-tower phase 54); anything else is refused. */
export function isModelPolicy(value: unknown): value is ModelPolicy {
  return typeof value === 'string' && (MODEL_POLICIES as readonly string[]).includes(value);
}

/**
 * Why a run is sleeping on `waitUntil`. ONE owner — `shared/status-vocab.js`,
 * which the client reads through `lib/status-vocab.ts` — so the server's fallback
 * for a run written before the field and the browser's cannot drift apart.
 * Written wherever `waitUntil` is written, cleared wherever it is cleared.
 */
export { WAIT_REASONS, waitReasonOf };
export type WaitReason = (typeof WAIT_REASONS)[number];

export type NewRunOptions = {
  slug: string;
  root: string;
  model?: string;
  effort?: string;
  /** QA's own model, effort and failure budget — see `RunState`. */
  qaModel?: string;
  qaEffort?: string;
  qaMaxRounds?: number;
  /** An approval card's timeout, in minutes — see `RunState`. */
  approvalTimeoutMinutes?: number;
  /** QA recovery's fix strategy and per-round stop — see `RunState`. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  ladderPerRunRungs?: number | null;
  ladderPerPhaseRungs?: number | null;
  accountId?: string;
  onLimit?: OnLimitPolicy;
  /**
   * What the run may do to a phase's model (control-tower phase 54, #91) —
   * `pinned` keeps it: no `--fallback-model`, no step down on a wall, no step
   * up on a rung. Absent = `ladder`, the behaviour before the word existed. A
   * plan's `**Model policy:**` outranks it (`modelPolicyFor`).
   */
  modelPolicy?: ModelPolicy;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
  onlyPhases?: number[];
  phaseOptions?: Record<string, PhaseOptions>;
  skills?: string[];
  mcpServers?: string[];
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  permissionMode?: PermissionMode;
  maxParallel?: number;
  gitMode?: GitMode;
  openPr?: boolean;
  isolation?: IsolationMode;
  settle?: SettleStrategy;
  priority?: RunPriority;
  startAfter?: string;
  reviewEachPhase?: boolean;
  reviewerPolicy?: ReviewerPolicy;
  ultracode?: boolean;
  ultraReview?: UltraReviewMode;
  /** Phase 15's seven — see `RunState`. */
  baseBranch?: string;
  maxConcurrentPerRepo?: number;
  worktreeRetention?: string;
  landing?: LandPolicy;
  conflictPolicy?: ConflictPolicy;
  messaging?: MessagingWord;
  issuesMode?: IssueMode;
  /** Heal halts automatically. `true` takes the default budget; an object names it. */
  autoRecover?: boolean | { attempts?: number };
  /** The manifest answers and the resolved manifest — see `RunState`. */
  resumeOnRestart?: boolean;
  relay?: RelayMode;
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  manifest?: ResolvedManifest;
  verifyApprovals?: RunVerifyApprovals;
  gitStrategyOverride?: { lines: { kind: string; plan: string; run: string; phases?: number[] }[]; ack: 'override' | 'automatic'; by?: string; at?: string };
};

/**
 * The strategy a fresh run is born with, from the two fields a launch may send.
 *
 * `settle` wins when it is there — it is the newer, more specific instruction.
 * When it is not, `openPr: false` still means what it has always meant, so it
 * is read as `keep` rather than defaulted past. That ordering is the whole
 * reason this is a named function: a launch surface that has been updated sends
 * both, an older client sends only `openPr`, and neither may surprise the
 * operator who used it.
 */
function settleFor(opts: Pick<NewRunOptions, 'settle' | 'openPr'>): SettleStrategy {
  if (opts.settle) return opts.settle;
  return opts.openPr === false ? 'keep' : DEFAULT_SETTLE;
}

export function newRun(opts: NewRunOptions): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    // TWELVE hex digits, not eight (S9-b). A run id is not merely a filename:
    // `autopilot/<runId>` is what a lane writes into a lock's `owner=`, so it
    // is the name two consoles use to decide whose lock a lock is — and two
    // runs sharing an id share their locks, their journal and their run file.
    // `randomUUID()` is dash-separated, so the dashes come out before the
    // slice; `.slice(0, 12)` on the raw string would have taken one.
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    slug: opts.slug,
    root: opts.root,
    status: 'running',
    // The opening posture, changed deliberately (2026-08-03).
    //
    // These were `halt-on-everything` / `sonnet` / no effort / `guarded`, which
    // was right for the first weeks of an unattended system — stop and show your
    // work — and wrong for what the autopilot is actually used for: a phase of
    // real engineering, left running while nobody watches. On those settings a
    // phase thought less hard than the operator would have asked for and then
    // stopped at the first commit to ask about something the deny list already
    // governs. The two failures compound, because the cheap model is the one
    // that needs supervision and nobody is there to give it.
    //
    // `trusted` is not "unguarded": the deny list still refuses pushes,
    // destructive git, deploys and publishes, from inside the CLI, so it holds
    // even with this console dead. What changes is that the reversible things
    // stop raising a card. See `client/src/views/run/defaults.ts` — the client
    // sends all four explicitly, and `api/routes.ts` still reads an
    // *unrecognised* profile as `guarded` so a typo cannot grant trust.
    autonomy: opts.autonomy ?? 'keep-going',
    model: opts.model ?? 'opus',
    // A conditional spread, because `effort: undefined` and no key are different
    // things on disk. An explicit empty string is a caller saying "this
    // machine's default" and must survive as one.
    ...(opts.effort === '' ? {} : { effort: opts.effort ?? 'max' }),
    // QA's own three, all conditional spreads: absence is a real state here.
    // An absent `qaModel`/`qaEffort` means "the reviewer inherits the builder's",
    // which is not the same fact as any particular model, and storing a default
    // would freeze today's answer into every run file. `qaMaxRounds` gets its
    // default at the CALL SITE instead, so a run file written before the budget
    // existed and one written by an operator who cleared the field mean the same
    // thing — and changing the shipped number changes both.
    ...(opts.qaModel ? { qaModel: opts.qaModel } : {}),
    ...(opts.qaEffort ? { qaEffort: opts.qaEffort } : {}),
    ...(typeof opts.qaMaxRounds === 'number' ? { qaMaxRounds: opts.qaMaxRounds } : {}),
    ...(typeof opts.approvalTimeoutMinutes === 'number' ? { approvalTimeoutMinutes: opts.approvalTimeoutMinutes } : {}),
    // QA recovery's two, conditional for the same reason: an absent strategy
    // means `resume` resolved at the point of use, and an absent round budget
    // means no per-round stop — neither is a number worth freezing into a file.
    ...(opts.qaFixStrategy ? { qaFixStrategy: opts.qaFixStrategy } : {}),
    ...(opts.qaRoundBudgetUsd === undefined ? {} : { qaRoundBudgetUsd: opts.qaRoundBudgetUsd }),
    ...(typeof opts.ladderPerRunRungs === 'number' ? { ladderPerRunRungs: opts.ladderPerRunRungs } : {}),
    ...(typeof opts.ladderPerPhaseRungs === 'number' ? { ladderPerPhaseRungs: opts.ladderPerPhaseRungs } : {}),
    phaseBudgetUsd: opts.phaseBudgetUsd ?? null,
    runBudgetUsd: opts.runBudgetUsd ?? null,
    spentUsd: 0,
    // Booked as deltas from its first spawn, so the boot re-price never touches it.
    costModel: COST_MODEL,
    // Every session's window from its first spawn, so the boot re-measure never touches it.
    clockModel: CLOCK_MODEL,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 2,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    // Same omission convention as `permissionProfile`: the machine login and
    // the `wait` policy are the absent states, so old run files and old
    // readers agree without a migration.
    ...(opts.accountId && opts.accountId !== 'default' ? { accountId: opts.accountId } : {}),
    ...(opts.onLimit && opts.onLimit !== 'wait' ? { onLimit: opts.onLimit } : {}),
    ...(opts.modelPolicy && opts.modelPolicy !== DEFAULT_MODEL_POLICY ? { modelPolicy: opts.modelPolicy } : {}),
    // The manifest answers are written whenever the door answered them — a
    // `false` resume-on-restart is a decision, not an omission, and the
    // difference between "answered hold" and "never asked" is exactly what
    // `converge.ts` needs to read (ZTD-8). `relay: off` is written too: a run
    // that said `off` and a run that predates the field must not be confused
    // once phase 14 arms the relay.
    ...(typeof opts.resumeOnRestart === 'boolean' ? { resumeOnRestart: opts.resumeOnRestart } : {}),
    ...(opts.relay ? { relay: opts.relay } : {}),
    ...(opts.accounts?.length ? { accounts: opts.accounts.map((a) => ({ ...a })) } : {}),
    ...(opts.acknowledgedWaivers?.length ? { acknowledgedWaivers: [...opts.acknowledgedWaivers] } : {}),
    ...(opts.manifest ? { manifest: opts.manifest } : {}),
    ...(opts.gitStrategyOverride?.lines.length
      ? { gitStrategyOverride: { ...opts.gitStrategyOverride, lines: opts.gitStrategyOverride.lines.map((line) => ({ ...line })) } }
      : {}),
    ...(opts.verifyApprovals && (opts.verifyApprovals.approve.length || opts.verifyApprovals.waive.length)
      ? {
        verifyApprovals: {
          approve: opts.verifyApprovals.approve.map((a) => ({ ...a })),
          waive: opts.verifyApprovals.waive.map((w) => ({ ...w })),
          ...(opts.verifyApprovals.by ? { by: opts.verifyApprovals.by } : {}),
          ...(opts.verifyApprovals.at ? { at: opts.verifyApprovals.at } : {}),
        },
      }
      : {}),
    ...(opts.onlyPhases?.length ? { onlyPhases: [...opts.onlyPhases] } : {}),
    ...(opts.phaseOptions ? { phaseOptions: { ...opts.phaseOptions } } : {}),
    ...(opts.skills?.length ? { skills: [...opts.skills] } : {}),
    ...(opts.mcpServers?.length ? { mcpServers: [...opts.mcpServers] } : {}),
    // `continue` is the absent state, so a run file written before the policy
    // existed reads as the shipped default rather than as the old park.
    ...(opts.mcpPolicy && opts.mcpPolicy !== 'continue' ? { mcpPolicy: opts.mcpPolicy } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.maxParallel && opts.maxParallel > 0 ? { maxParallel: opts.maxParallel } : {}),
    // **Absent still means `guarded` when reading**, and that does not change:
    // a run file written before profiles existed must not become trusted because
    // the default moved under it. So `guarded` is the one value written as an
    // omission, and everything else — including the new `trusted` default — is
    // written out explicitly.
    ...(opts.permissionProfile === 'guarded'
      ? {}
      : { permissionProfile: opts.permissionProfile ?? 'trusted' }),
    // Same omission convention as `permissionProfile`: default-branch is the
    // absent state, so old readers and old run files agree. `openPr` is written
    // both ways under new-branch so the header can show the run's own record —
    // and since P12 it is written as the MIRROR of the settle strategy rather
    // than as an independent flag. `pr` is the one strategy that ends at a pull
    // request, so `openPr === (settle === 'pr')`, and the two legacy cases come
    // out byte-identical: no settle and no `openPr` is still `openPr: true`,
    // and `openPr: false` still stores `false` (via `keep`).
    ...(opts.gitMode === 'new-branch'
      ? {
        gitMode: 'new-branch' as const,
        settle: settleFor(opts),
        openPr: settleFor(opts) === DEFAULT_SETTLE,
      }
      : {}),
    // Same omission convention once more: `queue` is the absent state. Written
    // ONLY under new-branch, because a run with no branch of its own has
    // nothing to check out — an `isolation: 'worktree'` on a default-branch run
    // would read as configured and do nothing, which is the shape of setting
    // this codebase keeps deciding not to have.
    ...(opts.gitMode === 'new-branch' && opts.isolation === ISOLATED
      ? { isolation: ISOLATED }
      : {}),
    // Same omission convention once more: `normal` is the absent state, so a
    // run at the default class is byte-identical to every run written before
    // priorities existed. Unlike isolation this is written regardless of the
    // git strategy — the scan order has nothing to do with what is checked out.
    ...(opts.priority && opts.priority !== DEFAULT_PRIORITY ? { priority: opts.priority } : {}),
    // A chain is written only when there is a plan to chain behind. An empty
    // string would read as configured and hold nothing, which is the shape of
    // setting this codebase keeps deciding not to have.
    ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
    // Phase 15's seven, each written only when it says something (see
    // `RunState`). The first three are written whatever the git strategy:
    // retention governs any tree the console mints, the cap counts the run in
    // its repository, and the base is what a LANE's branch is cut from even
    // when the run itself took none. The last four store their shipped default
    // as no key — a run file that says `landing: hold` and one that says
    // nothing are one fact.
    ...(opts.baseBranch?.trim() ? { baseBranch: opts.baseBranch.trim() } : {}),
    ...(typeof opts.maxConcurrentPerRepo === 'number' && opts.maxConcurrentPerRepo > 0
      ? { maxConcurrentPerRepo: opts.maxConcurrentPerRepo } : {}),
    ...(opts.worktreeRetention ? { worktreeRetention: opts.worktreeRetention } : {}),
    ...(opts.landing && opts.landing !== DEFAULT_LAND ? { landing: opts.landing } : {}),
    ...(opts.conflictPolicy && opts.conflictPolicy !== DEFAULT_CONFLICT ? { conflictPolicy: opts.conflictPolicy } : {}),
    ...(opts.messaging && opts.messaging !== DEFAULT_MESSAGING ? { messaging: opts.messaging } : {}),
    ...(opts.issuesMode && opts.issuesMode !== DEFAULT_ISSUES ? { issuesMode: opts.issuesMode } : {}),
    // Same omission convention again: off is absent. The POLICY is written only
    // when a reviewer is on, because a policy on a run with no reviewer is a
    // setting that reads as configured and does nothing — and there are TWO
    // reviewers now, so the condition is either of them. A run that asked for
    // the cloud tier and `may-hold` and got the policy dropped because it had
    // not also asked for the session reviewer would be silently downgraded.
    ...(opts.reviewEachPhase ? { reviewEachPhase: true as const } : {}),
    ...(opts.ultracode ? { ultracode: true as const } : {}),
    ...(opts.ultraReview && opts.ultraReview !== 'off' ? { ultraReview: opts.ultraReview } : {}),
    ...((opts.reviewEachPhase || (opts.ultraReview && opts.ultraReview !== 'off'))
      && opts.reviewerPolicy === 'may-hold'
      ? { reviewerPolicy: 'may-hold' as const }
      : {}),
    // Off is the absent state, like everything above — but unlike them the ON
    // value is chosen by the caller (the pref-resolved default), not here: a
    // pure constructor does not get to decide what "unset" means for automation.
    // 3.5.0 writes the ARMING and nothing else. `attempts` was a second
    // per-phase ceiling, hardcoded 2, unreachable from the UI, and it silently
    // beat the operator's `ladderPerPhaseRungs` because both bounded the same
    // counter (P6/D5). It has had no reader since; the object's PRESENCE is
    // what every reader actually asks, so an older console still sees "armed".
    ...(opts.autoRecover ? { autoRecover: {} } : {}),
    phases: {},
  };
  // The account it starts on is one of its listed accounts (control-tower
  // phase 78, #100) — observability-plane ran on `account` with a pool of three
  // others, so failover could never come back to the account it began on.
  keepAccountInPool(state);
  return state;
}

export function phaseRecord(state: RunState, phase: number): PhaseRecord {
  const key = String(phase);
  if (!state.phases[key]) {
    state.phases[key] = { phase, status: 'pending', attempts: 0, costUsd: 0 };
  }
  return state.phases[key];
}

/**
 * Clear a phase's terminal state so the loop will pick it up again — the ONE
 * reset, used by `Runner.retry` (a live loop) and `Service.retryPhase` (a
 * stored run) alike. The two used to carry their own copies and drifted twice:
 * a retried phase kept showing the preflight and the missing servers of an
 * attempt that was no longer going to happen, and the lock-cap clock survived
 * into the retry so it parked again instantly.
 *
 * Everything the last boarding concluded goes: the note, the end time, the
 * preflight, the degraded servers, the lock-wait clock (Retry means the wait
 * starts over), and the ladder's boarding hint — an operator's Retry is a
 * fresh boot by definition. What stays is history: attempts, cost, session
 * ids, verification, the situation cache.
 */
/**
 * An operator's Retry-with-edits payload as a record, or `undefined` when they
 * changed nothing.
 *
 * The `undefined` is load-bearing and is why this is a function rather than an
 * object literal at each call site: `resetForRetry` reads an absent override as
 * "a plain Retry — clear any unspent one", and an empty `{}` would instead
 * stamp an override that says nothing, keeping the phase's model cleared for no
 * reason and journalling a decision nobody made.
 */
export function retryOverrideFrom(
  input: { addendum?: string; options?: PhaseOptions; by?: string } | undefined,
  at = new Date().toISOString(),
): RetryOverride | undefined {
  const addendum = input?.addendum?.trim();
  const options = input?.options && Object.keys(input.options).length ? input.options : undefined;
  if (!addendum && !options) return undefined;
  return {
    ...(addendum ? { addendum } : {}),
    ...(options ? { options } : {}),
    ...(input?.by ? { by: input.by } : {}),
    at,
  };
}

/**
 * Retire a phase's own ending (`PhaseRecord.halt`).
 *
 * `settlePhase` writes it and `classifySituation` reads it IN PREFERENCE to
 * `state.halt`, so a halt left standing outlives the ending it described and
 * pins the phase's classification for the life of the run: a retried
 * `verify-failed` phase keeps answering `verify-red`, and — worse — a retired
 * `needs-human`/`phase-blocked` keeps `declaredBlocked` true, which suppresses
 * all three plan-health arms for ever. Every path that clears `state.halt`
 * clears this too, and so does every path that starts the phase over.
 *
 * Idempotent; a record that never halted is untouched.
 */
export function retirePhaseHalt(record: PhaseRecord | undefined | null): void {
  if (record) delete record.halt;
}

/**
 * End a phase's lock wait — the clock AND who it was waiting behind.
 *
 * `lockWaitSince` is cumulative by design (`??=`), so it survives a boarding
 * attempt that queues, backs off and queues again. That is right while the
 * phase is still waiting and wrong the moment the wait ENDS for any other
 * reason: the measured incident (filters p12, 2026-08-27) declared
 * `needs-human` after 25.4 hours queued, nobody cleared the stamp, and the
 * NEXT admission computed `remaining = max(0, 2h - 25.4h) = 0` and fired its
 * cap 1 ms after `phase.queued`. A declaration, a park and a successful claim
 * all end the wait; only a re-arm of the same wait does not.
 *
 * Idempotent, so a park that follows a declaration is free to call it again.
 */
export function endLockWait(record: PhaseRecord): void {
  record.lockWaitSince = undefined;
  delete record.waitingOn;
  delete record.lockBackoffMs;
}

/**
 * Why a declaration was spent. Deliberately a closed list — `DECLARATION_CONSUMERS`
 * in `shared/run-lifecycle.js` owns the words: `record.declared` is
 * the session's own testimony, and every place that quietly deleted it is a
 * place the console forgot what it had been told.
 *
 *   - `new-outcome`        — the session declared something ELSE. The newest
 *     declaration is the fact; the old one is spent by definition.
 *   - `board-closed`       — the board now reads the phase done, so there is no
 *     phase left for the declaration to be about.
 *   - `session-productive` — a resumed session produced a turn. It is working
 *     again, and whatever it declares next is the fact. This is the licence the
 *     boarding path used to take FOR it, before the session had done anything:
 *     a resume that queued, capped or failed to spawn lost the testimony for
 *     good (R1), which is exactly the case the watch-landed resume hits.
 *   - `retry`              — a person pressed Retry. An operator present at the
 *     console is entitled to supersede a declaration; nothing else is.
 */


/** The journal event written when `consumeDeclaration` answers non-null. */
export const DECLARATION_CONSUMED_EVENT = 'phase.declaration-consumed';

/**
 * Where a settlement writes its journal line: `(event, data, phase)`, the
 * shape of `Journal.append`. A live runner passes its own journal (two
 * `Journal` instances over one file diverge their `seq`); the read-path
 * settlements in this module fall back to `journalOf(state)`.
 */
export type DeclarationSink = (event: string, data: Record<string, unknown>, phase?: number) => void;

/**
 * A journal sink for a run this module is settling on a READ path — constructed
 * lazily, because `Journal`'s constructor tail-reads the file to recover `seq`,
 * and a plain load must stay a plain load. Never for a run a live runner
 * drives: the loop owns that journal and its sequence numbers.
 */
export function journalOf(state: RunState): DeclarationSink {
  let journal: Journal | null = null;
  return (event, data, phase) => {
    journal ??= Journal.for(state.root, state.slug, state.id);
    journal.append(event, data, phase);
  };
}

/** What `consumeDeclaration` spent — the payload of `phase.declaration-consumed`. */
export type DeclarationSpend = {
  why: DeclarationConsumer;
  status: string;
  reason?: string;
  watch?: string[];
  /** When the declaration was made. */
  at?: string;
  /** When it was spent. */
  spentAt: string;
  /** How many waits the phase had taken when it was spent. */
  waits: number;
  /** Declared parked time at the spend, from the parks' own stamps. */
  parkedMs: number;
};

/**
 * Forget everything the watch clock knows about this phase.
 *
 * The ONE writer, because the two fields are one fact and a caller that
 * remembers only `watchChecked` leaves a `landed` row behind — which retires
 * the ref from the rotation for ever, so the next declaration of the SAME ref
 * is never watched. Every reset path (`consumeDeclaration`, `resetForRetry`,
 * the three outcome arms, `service-runs`' unsupervised arm) goes through here.
 */
export function clearWatchBookkeeping(record: PhaseRecord): void {
  delete record.watchChecked;
  delete record.watchState;
  delete record.watchLandedJournalledFor;
  // The delivery count and the errand stamp retire WITH the wait they bound.
  // They were left out of this list once, and the cost was silent: a phase's
  // SECOND declaration inherited a spent count and a standing errand stamp, so
  // its very first landing went straight to the over-cap branch — zero offers,
  // and an errand about resumes that never happened (QA round 3, H2). This is
  // round 1's own rule — bookkeeping that retires something is cleared
  // wherever its subject is cleared — applied to the two fields it missed.
  delete record.watchResumes;
  delete record.watchLandedErrandFor;
  // A landing retired `done` was retired for THIS declaration (#126).
  delete record.watchLandedDone;
  // The healer's rejection count bounds THIS landing's deliveries; a new wait
  // is a new landing. `watchRetired` is deliberately NOT here — see the field.
  delete record.watchRejections;
}

/**
 * Spend a phase's declaration, under a named licence. Returns what was spent,
 * or null when there was nothing to spend — so a caller can act exactly when
 * something really happened.
 *
 * Given a `journal`, it writes `phase.declaration-consumed` itself; without
 * one the CALLER writes it (the `new-outcome` arms add `next`, the status that
 * superseded the old word). Either way the line is written — every licence
 * journals (WAI-9), and `test/invariants.test.ts` holds each call site to one
 * of the two forms.
 *
 * This is the ONLY writer that may delete `record.declared`. Everything else
 * reads it.
 */
export function consumeDeclaration(
  record: PhaseRecord, why: DeclarationConsumer, journal?: DeclarationSink,
): DeclarationSpend | null {
  const declared = record.declared;
  if (!declared) return null;
  const spentAt = new Date().toISOString();
  const parkedMs = parkedMsOf(record, Date.parse(spentAt));
  delete record.declared;
  // A spent declaration ends the park it held, if one is still open: the wait
  // it testified to is over, whatever spent it. Stamped here because this is
  // the one place every such ending passes through, so `parkedMsOf` measures
  // the park from its own two instants instead of guessing an end.
  closeWaitEntry(record, new Date().toISOString());
  // The record-level `watch` shadow goes with it. Every live writer copies it
  // from the declaration in the same breath (`parkWaiting`, the outcome arms),
  // so a copy that outlives the declaration testifies to a wait that is over:
  // the classifier's arm 5 reads `rec.watch` as a declared wait, and a park
  // the CONSOLE later makes on this phase — a retry-storm park — was narrated
  // as the session's own testimony because of exactly this leftover
  // (QA round 3, M1).
  delete record.watch;
  // The poller's bookkeeping belongs to the declaration it was watching — BOTH
  // halves of it. `watchState` is the one that matters: a row reading `landed`
  // or `refused` is retired from the rotation for ever (`dueFor`), so a stale
  // one left behind means the SAME ref, re-declared by the next attempt, is
  // never watched again and the phase parks with nothing looking at it. That is
  // the two-day p12 park this whole phase exists to prevent, re-created by the
  // machinery meant to close it. Written as one statement because they are one
  // fact; splitting them is how the second was forgotten (QA F1).
  clearWatchBookkeeping(record);
  const spend: DeclarationSpend = {
    why,
    status: declared.status,
    ...(declared.reason ? { reason: declared.reason } : {}),
    ...(declared.watch?.length ? { watch: declared.watch } : {}),
    ...(declared.at ? { at: declared.at } : {}),
    spentAt,
    waits: record.waits ?? 0,
    parkedMs,
  };
  journal?.(DECLARATION_CONSUMED_EVENT, { ...spend }, record.phase);
  return spend;
}

/** The journal event written when a declaration is recorded as evidence and NOT acted on (WAI-8). */
export const DECLARATION_REFUSED_EVENT = 'phase.declaration-refused';

/** What `chargeDeclaration` decided about one more declaration of one word. */
export type DeclarationCharge = {
  status: OutcomeStatus;
  /** `act`: the caller acts. `cooled`: inside the cooldown — one act already stands. `refused`: past the cap. */
  verdict: 'act' | 'cooled' | 'refused';
  /** Acts taken on this word so far (after this one, when it is an act). */
  count: number;
  max: number;
  cooldownMs?: number;
  /** Declarations of this word recorded and not acted on, this one included when it was refused. */
  refused: number;
};

/**
 * Count one more declaration of `status` for this phase on the record's
 * ledger (WAI-8, SLF-4), and say whether the caller may act on it.
 *
 * `waits` counted only the two `waiting-external` parks; the other five words
 * had no bound at all — a hand session could re-file `partial` for free and
 * buy a paid re-board each time. Past `max` a declaration is recorded and NOT
 * acted on, the rule `phase.wait-budget-spent` already applied to one word;
 * `waiting-external` itself is counted here but refused only by `waits`, so no
 * word is refused twice. Inside `cooldownMs` of the last act of the same word,
 * a second declaration collapses into the first — recorded, not acted on. The
 * cooldown is the UNSUPERVISED paths' (the supervised path reads one file per
 * attempt); a caller that wants none passes none. An operator's Retry clears
 * the ledger (`resetForRetry` by `operator`); nothing automatic does.
 */
export function chargeDeclaration(
  record: PhaseRecord, status: OutcomeStatus,
  opts: { now?: number; max?: number; cooldownMs?: number } = {},
): DeclarationCharge {
  const now = opts.now ?? Date.now();
  const max = opts.max ?? DECLARATIONS_MAX_PER_PHASE;
  const ledger = (record.declarations ??= {});
  const row = ledger[status];
  const at = new Date(now).toISOString();
  const cooled = row && opts.cooldownMs !== undefined && row.count > 0
    && now - Date.parse(row.lastAt) < opts.cooldownMs;
  if (cooled) {
    row.refused = (row.refused ?? 0) + 1;
    return { status, verdict: 'cooled', count: row.count, max, cooldownMs: opts.cooldownMs, refused: row.refused };
  }
  if (status !== 'waiting-external' && row && row.count >= max) {
    row.refused = (row.refused ?? 0) + 1;
    return { status, verdict: 'refused', count: row.count, max, refused: row.refused };
  }
  const next: DeclarationLedgerRow = { count: (row?.count ?? 0) + 1, lastAt: at, ...(row?.refused ? { refused: row.refused } : {}) };
  ledger[status] = next;
  return { status, verdict: 'act', count: next.count, max, refused: next.refused ?? 0 };
}

/**
 * Prepare a record for another boarding of the SAME work — the attempt-scoped
 * state goes, the phase's memory stays.
 *
 * The console's own re-boards go through here (an unsupervised `partial`,
 * the converge relaunch, the ladder's rungs): what they may clear is what the
 * last attempt left mid-flight — its stall episode, its idle count, its task
 * list, its ending. What they must NOT clear is what bounds the NEXT attempt:
 * `stallRemedy`, the watchdog's nudge-and-recycle budget, which used to be
 * wiped on every unsupervised `partial` re-board so the phase that went silent
 * bought itself a fresh watchdog each time (SLF-4); `said`, the session's last
 * words, which phase 9's classifier reads; and the declarations ledger, which
 * is the bound on re-boards itself. Only an operator's Retry (`resetForRetry`
 * by `operator`) clears those.
 */
/**
 * Does the CONSOLE owe this phase a §Verification — one a shutdown, a stop or
 * a crash cut (`reverify`, control-tower phase 48)? Not a checkpoint's killed
 * job (control-tower phase 89): that debt is the next SESSION's, read by its
 * brief, and must never send the phase into a session-less re-verification.
 */
export function owesVerification(record: Pick<PhaseRecord, 'reverify'>): boolean {
  return Boolean(record.reverify) && record.reverify!.cause !== 'checkpoint';
}

export function prepareReboard(record: PhaseRecord): void {
  record.status = 'pending';
  record.note = undefined;
  record.endedAt = undefined;
  delete record.preflight;
  delete record.preflightDetail;
  delete record.mcpDegraded;
  delete record.mcpPark;
  delete record.boardingHint;
  // A checkpoint's session goes with the attempt that left it (control-tower
  // phase 86, #134): the boarding this record is prepared for resumes a
  // session only when its HINT names one. Left here, a Retry boarding `fresh`
  // found a usage wall's old checkpoint at its spawn, asked the resume gate a
  // second time, and re-boarded — handing its lane to a sibling.
  record.resumeSessionId = undefined;
  record.lockWaitSince = undefined;
  delete record.waitingOn;
  delete record.lockBackoffMs;
  // The stall episode belongs to the attempt being given up on. Kept, it would
  // re-announce itself on the next tick of a lane that has not had time to do
  // anything yet, and its clock would read from before the re-board.
  delete record.stall;
  delete record.idleAttempts;
  delete record.verifyingSince;
  // A fresh attempt verifies itself; an owed re-verification goes with the old
  // one. A checkpoint's killed job is owed by the NEXT session and stays until
  // its brief has named it (control-tower phase 89).
  if (record.reverify?.cause !== 'checkpoint') delete record.reverify;
  // A new attempt at the work is a new task list. The file behind it is
  // deleted at the next spawn (`armTasksFile`); clearing the fold and its
  // offset together is what keeps the two from disagreeing.
  delete record.tasks;
  delete record.tasksAt;
  delete record.progress;
  // A usage wall ends with the park it bounded (control-tower phase 54, #78).
  // Left on the record, the next park — a declared wait, a live-session hold —
  // would read as the wall's, and a reading with headroom would lift it.
  delete record.usageWall;
  // A record being boarded is being driven, and one being boarded again was
  // not closed by the board (control-tower phase 79).
  delete record.undriven;
  delete record.reconciled;
  // …and the phase's own ending. A new attempt makes the reason the LAST one
  // stopped history — left standing it would classify the reset record from a
  // halt that no longer describes anything (QA F1).
  retirePhaseHalt(record);
}

/** Who asked for the reset — the one word `resetForRetry` reads. */
export type ResetBy = 'operator' | 'console';

/**
 * Reset a record for a Retry — `prepareReboard` plus what only a RETRY may do.
 *
 * `by` decides how much (WAI-8, SLF-4). An `operator` pressed the button, is
 * present to watch, and is asking for the phase from the top: the watchdog's
 * bound (`stallRemedy`), the declarations ledger and the retired watch refs go
 * too — including, if it wedges again, the nudge and the recycle. The
 * `console` (a converge relaunch, the ladder, a lock-cap rearm) carries every
 * one of those bounds forward, which is what stops a recycle from buying
 * itself another recycle. Either way the old declaration (a wait, a blocker, a
 * needs-human) is spent under the `retry` licence and journalled through
 * `journal` — the one writer, so "who spent the testimony" is always
 * answerable. The unsupervised `partial` arms never reach this function.
 */
export function resetForRetry(
  record: PhaseRecord,
  { by, override, journal }: { by: ResetBy; override?: RetryOverride; journal: DeclarationSink },
): DeclarationSpend | null {
  prepareReboard(record);
  // An operator's Retry of a phase parked on a declared wall takes the wall
  // down as a FENCE too (control-tower phase 6, #19): its siblings read why.
  const walled = by === 'operator'
    && (record.declared?.status === 'needs-human' || record.declared?.status === 'blocked');
  if (walled) record.fenceLifted = { why: 'retry', at: new Date().toISOString() };
  if (by === 'operator') {
    delete record.stallRemedy;
    delete record.declarations;
    delete record.watchRetired;
    delete record.safeguard;
    // The wall and the denial the phase last stopped on are the console's
    // evidence about the PREVIOUS attempt; a person asking for the phase from
    // the top has, by pressing, claimed the world has changed (phase 9).
    delete record.cause;
    delete record.toolDenied;
    delete record.walls;
    // …and the count of declared waits opens again (control-tower phase 14,
    // #40's 2026-09-28 thread): `WAIT_MAX_PER_PHASE` had no reset path, so a
    // release phase whose four waits were four honest hops could never wait
    // again. A person's Retry is the reset, as it replenishes the ladder; the
    // parked MINUTES stay the phase's, raised by `raise-budget`.
    delete record.waits;
  }
  const spent = consumeDeclaration(record, 'retry', (event, data, phase) => journal(event, { ...data, by }, phase));
  // `consumeDeclaration` clears the watch bookkeeping (and the record-level
  // `watch` shadow) only when there WAS a declaration to spend; a Retry on a
  // phase that never declared one must still start the clock over — including
  // a pre-`declared` checkpoint whose refs ride `record.watch` alone. The
  // delivery count and errand stamp live inside `clearWatchBookkeeping` now
  // (QA round 3, H2), so nothing here repeats them.
  clearWatchBookkeeping(record);
  delete record.watch;
  // A plain Retry clears any override the previous one left unspent — pressing
  // the button with no edits means "again, as the plan says", and inheriting
  // last week's addendum would be the opposite of that. Only a PERSON's Retry
  // says so (control-tower phase 86, #134): the console's own re-board — the
  // ladder, converge, a lock-cap re-arm — carries a person's override forward,
  // because nobody asked it to drop the fix and the steps an operator wrote.
  if (by === 'operator') delete record.retryOverride;
  if (!override) return spent;
  record.retryOverride = override;
  // `record.model` and `record.effort` are STICKY across attempts — boarding
  // writes them with `??=` so a phase that fell back to a weaker model keeps
  // it. That is right for a plain retry and exactly wrong here: an operator
  // choosing a model for this attempt would have been silently ignored, which
  // is the one failure mode a settings override cannot survive. Cleared only
  // for the fields the override actually names.
  if (override.options?.model) record.model = undefined;
  if (override.options?.effort) record.effort = undefined;
  return spent;
}

/**
 * Write the checkpoint atomically — rename is the only step a reader can see —
 * and durably: the file is fsync'd before the rename and the directory after,
 * so a power cut can lose at most the newest write, never leave a torn one.
 * The directory fsync is best-effort (not every platform permits it); rename
 * already covers the torn-write case on its own.
 */
export function saveRun(state: RunState): void {
  state.updatedAt = new Date().toISOString();
  // The write half of the dual-write. Every run reaches disk through here, so
  // no file can carry a lifecycle that disagrees with its status — whichever of
  // the 117 assignment sites last touched it. See `syncLifecycle`.
  syncLifecycle(state);
  const target = runFile(state.root, state.slug, state.id);
  const dir = runDir(state.root, state.slug);
  mkdirSync(dir, { recursive: true });
  // The directory entry only needs flushing when the rename CREATES it. On
  // every later save the name is already durable and the second fsync buys
  // nothing — and it was being paid on a path that runs once per stream event.
  const creating = !existsSync(target);
  const tmp = `${target}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  pendingSaves.delete(target);
  runsGen++;
  if (!creating) return;
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* best-effort */ }
}

/* ------------------------------------------------------------------ *
 * Coalesced persistence
 * ------------------------------------------------------------------ */

/**
 * Bumped by every completed run write in this process.
 *
 * A cache over "every run on disk" cannot be keyed by a plan revision — runs
 * are not plan files and no watcher covers them — so before this the only
 * available key was a clock, and a 5 s clock over a whole-portfolio directory
 * scan is a scan every 5 seconds forever. This is the missing invalidation
 * signal: a reader that holds the generation it built at can reuse its answer
 * for as long as nothing has written, which on an idle console is indefinitely.
 * Writes by ANOTHER console are not counted here, which is why the readers
 * still carry a long TTL as a floor.
 */
let runsGen = 0;

/** The current run-write generation. See `runsGen`. */
export function runsGeneration(): number {
  return runsGen;
}

/**
 * Runs with a save owed, keyed by the file they write to.
 *
 * The record is held by REFERENCE, not serialized on arrival: a save owed at
 * `t` and paid at `t+debounce` should write what the run looks like when the
 * write happens. That is what collapses a burst of appends into one write —
 * and what makes the whole mechanism safe, since no intermediate state is ever
 * the thing a reader would have seen.
 */
const pendingSaves = new Map<string, { state: RunState; timer: NodeJS.Timeout }>();

/** How long a save may wait for the ones behind it. */
let saveDebounceMs = 150;

/** Tests need the debounce collapsed or lengthened; nothing else sets this. */
export function setRunSaveDebounce(ms: number): void {
  saveDebounceMs = Math.max(0, ms);
}

/**
 * Persist this run soon, folding in every other save owed for it meanwhile.
 *
 * `saveRun` rewrites the WHOLE record — 318 KB on a real run — and it was
 * called from per-stream-event paths, so a phase that emitted N events wrote
 * O(N²) bytes and fsync'd 2N times. Nothing in the record is append-only, so
 * the writes cannot be made incremental; they can be made FEWER, which is what
 * this does. Durability is unchanged for anything that asks for it directly:
 * `saveRun` is still the immediate, fsync'd path, and every deferred save is
 * flushed on shutdown by `flushRunSaves`.
 */
export function saveRunSoon(state: RunState): void {
  const target = runFile(state.root, state.slug, state.id);
  const existing = pendingSaves.get(target);
  if (existing) {
    // Same run, later state — the reference is what gets written, so the
    // pending entry simply adopts it and the clock keeps running. A burst
    // therefore costs ONE write at the end of it, not one per event.
    existing.state = state;
    return;
  }
  const timer = setTimeout(() => {
    const owed = pendingSaves.get(target);
    pendingSaves.delete(target);
    if (owed) { try { saveRun(owed.state); } catch { /* reported by the caller's next save */ } }
  }, saveDebounceMs);
  timer.unref?.();
  pendingSaves.set(target, { state, timer });
}

/**
 * Pay every owed save now.
 *
 * Called on shutdown and by any test that needs the disk to agree with memory.
 * Returns how many writes it made, which is the seam a test uses to prove the
 * coalescing happened rather than assuming it.
 */
export function flushRunSaves(): number {
  const owed = [...pendingSaves.values()];
  for (const entry of owed) clearTimeout(entry.timer);
  pendingSaves.clear();
  let written = 0;
  for (const entry of owed) {
    try { saveRun(entry.state); written++; } catch { /* nothing left to report to */ }
  }
  return written;
}

/** How many runs currently owe a write. Test seam. */
export function pendingRunSaves(): number {
  return pendingSaves.size;
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * How long a finished run's files are kept.
 *
 * The same shape as `sessions/registry.ts`'s `RETAIN_ENDED_MS` /
 * `RETAIN_SILENT_MS`, deliberately: sessions were already swept and runs were
 * not, so nothing in the tree ever unlinked a `run-*.json` and `listRuns()`
 * re-read a monotonically growing set on every plan open, forever.
 */
export const RETAIN_RUNS_MS = 30 * 24 * 60 * 60_000;

/** Runs kept per plan regardless of age, newest first. */
export const RETAIN_RUNS_MIN = 20;

/**
 * Delete the run files a plan no longer needs, and their journals.
 *
 * Age AND count, both floors rather than either: a plan that ran twice a year
 * ago keeps both records, and a plan that ran two hundred times this week keeps
 * the newest 20 whatever the clock says. A run still in flight is never a
 * candidate — `keep` names the ones a live process is driving, and any status
 * other than `finished` is left alone because only a finished run is certain
 * to have nothing more to say.
 */
export function pruneRuns(
  root: string,
  slug: string,
  keep: LiveRuns,
  now = Date.now(),
  retainMs = RETAIN_RUNS_MS,
  retainMin = RETAIN_RUNS_MIN,
): string[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const candidates: { id: string; file: string; at: number }[] = [];
  let total = 0;
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8,32})\.json$/.exec(name)?.[1];  // 8..32 — see S9-b in scheduler.ts
    if (!id) continue;
    total++;
    if (isLive(id, keep)) continue;
    const file = join(dir, name);
    let state: RunState | null = null;
    try { state = JSON.parse(readFileSync(file, 'utf8')) as RunState; } catch { /* unreadable */ }
    // An unreadable or unfinished record is never swept: the first is evidence
    // of something worth keeping to look at, the second may still be written to.
    if (!state || state.status !== 'finished') continue;
    let at = Date.parse(state.updatedAt ?? state.createdAt ?? '');
    if (!Number.isFinite(at)) { try { at = statSync(file).mtimeMs; } catch { continue; } }
    candidates.push({ id, file, at });
  }
  candidates.sort((a, b) => b.at - a.at);
  const removed: string[] = [];
  let survivors = total;
  for (const candidate of candidates) {
    if (survivors <= retainMin) break;
    if (now - candidate.at <= retainMs) continue;
    try {
      rmSync(candidate.file, { force: true });
      rmSync(journalFile(root, slug, candidate.id), { force: true });
      for (const sidecar of runSidecars(dir, candidate.id)) rmSync(sidecar, { recursive: true, force: true });
      removed.push(candidate.id);
      survivors--;
    } catch { /* a file we cannot remove is retried next sweep */ }
  }
  return removed;
}

/**
 * Everything else a run leaves behind, so a swept record takes its evidence
 * with it instead of leaving five orphans nobody can name.
 *
 * Before 5.1.0 this was the record and the journal and nothing more: the
 * replays (`.log.jsonl`, one per phase since control-tower phase 94, each capped
 * at 16 MB, and any moved aside), every phase's task ledger,
 * every phase's declared outcome, the folded git trace and the run's raw
 * Trace2 directory all outlived the run by exactly forever. Nothing read them
 * — `loadRun` returns null for a record that is gone — so they were pure
 * residue, and a console driving a plan for a month accumulated hundreds.
 *
 * The id is matched EXACTLY rather than by prefix. Run ids are 8–32 hex, so
 * `run-aaaaaaaa*` also matches `run-aaaaaaaabbbb.log.jsonl` — a different run,
 * whose transcript a prefix sweep would take while its record stayed.
 */
function runSidecars(dir: string, id: string): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  // `isRunSidecar` is retention's pattern too, so a replay kept per phase or
  // moved aside (`.old`, `.full-<stamp>`) goes with its run (control-tower
  // phase 94, #133) instead of outliving it.
  for (const name of names) {
    if (isRunSidecar(name, id)) out.push(join(dir, name));
  }
  // The raw Trace2 directory the drain folds from, `git-trace/<runId>/`.
  const raw = join(dir, 'git-trace', id);
  if (existsSync(raw)) out.push(raw);
  return out;
}

/* ------------------------------------------------------------------ *
 * Reclaiming a run whose writer died
 * ------------------------------------------------------------------ */

/**
 * The note every killed-lane record carries, whichever path wrote it —
 * `reconcileRun` (a crash found at the next read), `Runner.adopt` (a resume
 * finding dead children) and the console's own shutdown checkpoint. ONE
 * sentence shape, so the convergence loop can recognise the lanes a console
 * restart killed without a second vocabulary; `CONSOLE_STOPPED_NOTE` is the
 * reader every one of them answers to.
 */
export const CONSOLE_STOPPED_NOTE = /^the console stopped while phase \d+ was /;

export function consoleStoppedNote(phase: number, was?: string, suffix?: string): string {
  const doing = was === 'awaiting-verification' ? 'waiting to be verified' : 'running';
  return `the console stopped while phase ${phase} was ${doing}${suffix ? ` ${suffix}` : ''}`;
}

/**
 * Which runs are genuinely being driven right now.
 *
 * A single id was the whole answer while one `Runner` existed. With a pool
 * there are several, and the shape has to widen without breaking the dozens of
 * callers that pass one id — so both are accepted and every reader goes
 * through `isLive`. Passing the wrong shape is the failure that matters here:
 * a Set silently compared with `===` would mark every live run as dead and
 * reconcile a fleet of working runs into `interrupted`.
 */
export type LiveRuns = string | null | undefined | ReadonlySet<string>;

/**
 * What a READER of run files must say about liveness (control-tower phase 110,
 * #175): the live set, one id, or `null` for "nothing here is live". There is
 * no default. The hourly sizing census read every run with none, `undefined`
 * meant "nothing is live" by omission, and every run its console was driving
 * was reconciled as abandoned — parked on disk, once an hour, with no journal
 * line, until the runner's next save wrote over it.
 */
export type LiveRunsKnown = string | null | ReadonlySet<string>;

/** Is this run one of the ones something is actually driving? */
export function isLive(id: string, live: LiveRuns): boolean {
  if (!live) return false;
  return typeof live === 'string' ? live === id : live.has(id);
}

/**
 * How fresh a lane beat must be to count: two of the lease keepalive's
 * ten-minute cadences and a minute's grace (`LEASE_REFRESH_MS` in
 * `runner-core.ts`) — one missed tick is a busy event loop, not a dead lane.
 */
export const LANE_BEAT_FRESH_MS = 21 * 60_000;

/**
 * Is a lane of this run demonstrably at work — by a fact about PROCESSES,
 * which any reader can check, rather than a status, which is only a claim
 * (control-tower phase 105, #173)?
 *
 *  - a `Setup:`, baseline or §Verification command the console is running
 *    for a phase, recorded on `verifying[N].child` as `(pid, procStartedAt)`,
 *    still holds work; or
 *  - the lane's lock was refreshed within `LANE_BEAT_FRESH_MS` by a console
 *    process that still holds work (`laneBeat`).
 *
 * The run this answers for was being reclaimed as `interrupted` by any read
 * that lacked the live set: no session child, and an `updatedAt` frozen at the
 * last write while a half-hour `task verify:local` ran. Neither fact outlives
 * its process: a dead console's beat holds nothing, and the run is reclaimed
 * the moment its last command ends.
 *
 * And a session the LIVE console launched (control-tower phase 110, #175):
 * `launcher` names its console, and while that console is the live one and the
 * session holds work, the lane is at work — however long its record has been
 * quiet, and whatever a reader was told about which runs are live.
 */
export function laneInFlight(state: Pick<RunState, 'verifying' | 'laneBeat' | 'children' | 'child'>, now = Date.now()): boolean {
  for (const check of Object.values(state.verifying ?? {})) {
    const child = check?.child;
    if (child && Number.isInteger(child.pid) && pidHoldsWork(child.pid, { startedAt: child.procStartedAt })) return true;
  }
  for (const child of childrenOf(state)) {
    if (launcherAlive(child) === true && pidHoldsWork(child.pid, procIdentity(child))) return true;
  }
  const beat = state.laneBeat;
  if (beat && Number.isInteger(beat.pid)) {
    const at = Date.parse(beat.at);
    if (Number.isFinite(at) && now - at <= LANE_BEAT_FRESH_MS
      && pidHoldsWork(beat.pid, { startedAt: beat.procStartedAt })) return true;
  }
  return false;
}

/**
 * Close every phase record that still claims work in flight with nothing
 * behind it — keyed on the RECORD's own probe, never on the run's status.
 *
 * This loop used to live inside `reconcileRun`, below two early returns, and
 * that placement was the defect: `reconcileRun` gives up unless the RUN is
 * `IN_FLIGHT`, so for a `parked`, `halted` or `interrupted` run — the three a
 * dead console leaves behind most often — the loop was simply unreachable. No
 * other writer closes a `PHASE_IN_FLIGHT` record either: `RECONCILABLE`
 * excludes them, `Runner.adopt` needs a non-empty `childrenOf`, and
 * `reconcileRecordsAgainstBoard` needs the board to read `done`. That is the
 * whole mechanism behind a phase reading `running` for three and a half hours
 * over a run that had already parked, with every surface faithfully painting
 * the claim.
 *
 * The probe is asked PER PHASE, not once for the run: a three-lane run whose
 * phase 9 child outlived its console must settle 10 and 11 while leaving 9
 * exactly where it is.
 *
 * A record is settled unless its process still HOLDS WORK (`pidHoldsWork`).
 * `stopped` holds work: that something is recoverable with a single
 * `kill -CONT` — which is the remedy `reconcileRun`'s orphan branch prints, and
 * rewriting the record to `interrupted` would contradict the advice the
 * operator is being given on the same screen. A `zombie` holds NONE: it has
 * exited, its files are closed, and only its parent's `wait()` is outstanding.
 * The rule this used to share with the orphan branch was `!== 'gone'`, which
 * asks about existence — so a reaped-but-unwaited child kept a phase reading
 * `running` with nothing behind it, which is B2(a) exactly. The two paths still
 * share ONE rule; the rule is now "holds work", not "exists".
 *
 * `statuses` narrows which in-flight statuses are the caller's to settle —
 * `drive()`'s teardown passes the two it owns, because `awaiting-verification`
 * belongs to `settleAwaitingVerification` and its no-broker carve-out. Returns
 * the phases it closed, so a caller with listeners can emit for each.
 */
export function settleInFlightRecords(
  state: RunState,
  at = new Date().toISOString(),
  statuses: readonly PhaseStatus[] = PHASE_IN_FLIGHT,
): number[] {
  const closed: number[] = [];
  for (const record of Object.values(state.phases)) {
    if (!statuses.includes(record.status)) continue;
    const surviving = childrenOf(state).some(
      (child) => child.phase === record.phase
        && pidHoldsWork(child.pid, procIdentity(child)),
    );
    if (surviving) continue;
    // A phase left mid-flight may have half-finished something, so it is marked
    // interrupted rather than failed: continuing asks about it instead of
    // silently running it a second time.
    const was = record.status;
    record.status = 'interrupted';
    record.note ??= consoleStoppedNote(record.phase, was);
    record.endedAt ??= at;
    // Died mid-verification: whatever the board reads, the proof is owed
    // (control-tower phase 48, #69) — the next drive re-runs it.
    if (was === 'verifying' || record.verifyingSince) {
      record.reverify ??= { at, cause: 'crash' };
      delete record.verifyingSince;
    }
    // The session survives the console that was watching it. Keeping its id
    // here is what makes the difference between offering to CONTINUE this phase
    // and offering only to start it over: an interrupted phase may be twenty
    // minutes of work from done, and a restart throws all of it away.
    record.resumeSessionId ??= record.sessionId;
    closed.push(record.phase);
  }
  // The QA-round marker lives on a `done` record — outside every in-flight
  // status — and says a reviewer is running. Same fact, same probe: a marker
  // whose process holds no work is a review that is over, however it ended.
  for (const record of Object.values(state.phases)) {
    if (!record.qaSession) continue;
    const surviving = childrenOf(state).some(
      (child) => child.phase === record.phase && pidHoldsWork(child.pid, procIdentity(child)),
    );
    if (!surviving) delete record.qaSession;
  }
  return closed;
}

/* ------------------------------------------------------------------ *
 * Waiting records and their clocks (WAI-6)
 * ------------------------------------------------------------------ */

/** The journal event a settlement of a `waiting` record writes — `to` says which. */
export const WAIT_SETTLED_EVENT = 'phase.wait-settled';

/** The soonest `parkedUntil` among this run's `waiting` records, or null. */
export function soonestWaitingClock(state: RunState): string | null {
  let soonest: string | null = null;
  for (const record of Object.values(state.phases)) {
    if (record.status !== 'waiting' || !record.parkedUntil) continue;
    if (soonest === null || Date.parse(record.parkedUntil) < Date.parse(soonest)) soonest = record.parkedUntil;
  }
  return soonest;
}

/**
 * The clock a wait on this run should fire at — the ONE reader both re-arm
 * paths use (`waitClockVerdict`, the boot readopt, `armLimitResume`). The run's
 * own `waitUntil` when it has one; otherwise the soonest `waiting` record's
 * `parkedUntil`. The audit read `state.waitUntil` null in 53 of 53 run files
 * while two records still said `waiting`: the record carries the clock the
 * run lost, and a reader that asks only the run cannot see it.
 */
export function waitClockOf(state: RunState): string | null {
  return state.waitUntil ?? soonestWaitingClock(state);
}

/**
 * Every park writes BOTH clocks: the record's `parkedUntil` and the run's
 * `waitUntil`, kept as the soonest waiting record's. Called by every writer of
 * `parkedUntil` on a `waiting` record and at every wait-resume, so the run's
 * clock follows the waiters that remain. Touches no status — `setRunState` is
 * for the transitions, and a run still driving other lanes stays `running`.
 */
export function syncWaitClock(state: RunState): void {
  const soonest = soonestWaitingClock(state);
  // A usage window's or a person's card is the run's OWN clock, set and
  // cleared by its writer; a park's clock joins it as the sooner of the two
  // and never replaces it.
  const own = state.waitUntil && waitReasonOf(state) !== 'external' ? state.waitUntil : null;
  if (soonest && own) state.waitUntil = Date.parse(soonest) < Date.parse(own) ? soonest : own;
  else if (soonest) state.waitUntil = soonest;
  else if (!own) state.waitUntil = null;
}

/** What `settleWaitingRecords` / `rearmWaitClock` did to one record. */
export type WaitSettlement = {
  phase: number;
  to: 'rearmed' | 'pending' | 'interrupted';
  why: 'clock-read-from-record' | 'operator-stopped' | 'clock-unarmed' | 'run-over';
  clock: string;
  lateByMs: number;
  runStatus: RunStatus;
};

const TERMINAL_RUN: readonly RunStatus[] = ['finished'];

/** Is the run over — nothing, not even an operator's press, will drive it again? */
export function runIsOver(state: RunState): boolean {
  return TERMINAL_RUN.includes(state.status) || Boolean(state.resolved);
}

/**
 * Give a run that lost its clock the clock its `waiting` record still carries.
 *
 * Runs BEFORE `reconcileRun`, on purpose: its waiting arm preserves a `waiting`
 * run only when the run HAS a `waitUntil`; without one the run falls to
 * `interrupted-by-restart` and the record is orphaned for good — a park whose
 * loop was killed between the record's park and the run's `enterRunWaiting`
 * (other lanes were still running) is exactly that shape. Only for a run the
 * console will rule on: an operator's stop is pinned (`waitHoldWhy`), so its
 * record is settlement's, below.
 */
export function rearmWaitClock(state: RunState, now = Date.now()): WaitSettlement | null {
  if (state.waitUntil) return null;
  if (state.status !== 'waiting' && state.status !== 'paused') return null;
  if (state.stoppedBy === 'operator' || runIsOver(state)) return null;
  const soonest = soonestWaitingClock(state);
  if (!soonest) return null;
  state.waitUntil = soonest;
  state.waitReason ??= 'external';
  const phase = Object.values(state.phases)
    .find((record) => record.status === 'waiting' && record.parkedUntil === soonest)?.phase ?? 0;
  return {
    phase, to: 'rearmed', why: 'clock-read-from-record', clock: soonest,
    lateByMs: Math.max(0, now - Date.parse(soonest)), runStatus: state.status,
  };
}

/**
 * The stop a sibling phase ended on while the run waits on another phase's
 * clock (#53) — what `run.waiting-external` carries as `beside`.
 */
export type WaitBeside = { phase: number; kind: string | null; reason: string };

/**
 * A park that must happen keeps the clock a sibling's `waiting` record holds
 * (#53) — `rearmWaitClock`'s shape, written AT the park rather than read back
 * after it. A run whose lane ended needs-human while another lane waited on a
 * CD window used to be written `parked` with no `waitUntil`, so every reader
 * that asks the run lost the clock the moment the park landed. Carried, not
 * fired: nothing drives a parked run, and `settleWaitingRecords` still rules
 * on the record once its clock has passed. Answers the clock it wrote, or null.
 */
export function carryWaitClock(state: RunState): string | null {
  if (state.waitUntil) return null;
  const soonest = soonestWaitingClock(state);
  if (!soonest) return null;
  state.waitUntil = soonest;
  state.waitReason ??= 'external';
  return soonest;
}

/**
 * The clocks whose settlement this process has already journalled, keyed
 * `<run>:<phase>:<clock>` (#53 — one settlement per clock). Observed: the same
 * `phase.wait-settled` three times for one clock (10, 11 and 59 minutes past
 * it), because the settled record kept coming back `waiting` — a copy written
 * over the settle before it reached disk. The record is settled again each
 * time (the write is idempotent, and the stale copy must not stand); the line
 * is written once. Bounded, oldest first out.
 */
const SETTLED_CLOCKS = new Set<string>();
const SETTLED_CLOCKS_MAX = 512;

function firstSettlement(key: string): boolean {
  if (SETTLED_CLOCKS.has(key)) return false;
  SETTLED_CLOCKS.add(key);
  if (SETTLED_CLOCKS.size > SETTLED_CLOCKS_MAX) {
    const oldest = SETTLED_CLOCKS.values().next().value;
    if (oldest !== undefined) SETTLED_CLOCKS.delete(oldest);
  }
  return true;
}

/**
 * Settle every `waiting` record whose clock nothing will fire (WAI-6).
 *
 * A `waiting` record is the CONSOLE's to rule on only while its run is
 * `waiting`/`paused` with a clock and was not stopped by the operator —
 * `resumeOverdueWait` handles lateness there, however late. Every other
 * `waiting` record is a claim no clock backs: `PHASE_IN_FLIGHT` excludes
 * `waiting`, so `settleInFlightRecords` never saw them, and `SETTLED` excludes
 * it too, so the drive loop would have boarded them — if a loop existed. Two
 * hub records stood that way for 189 and 113 hours, painted "waiting until
 * <eight days ago>" on every surface with the budget reading unspent.
 *
 * Two endings, both leaving the declaration where the session wrote it:
 * a run that is OVER (`finished`, or resolved) takes the record to
 * `interrupted`, naming the dead clock; a run that may still be driven — by
 * the operator whose stop pinned it, or by a converge pass once its status is
 * one the loop reads — takes it to `pending` with the declaration intact and
 * the session id kept, after `WAIT_SETTLE_GRACE_MS`, so a Retry or a relaunch
 * boards a resume rather than a restart. Each settlement is journalled
 * `phase.wait-settled {to, why, clock, lateByMs}` through `journal`, else the
 * run's own journal — a settlement nobody can read back is the defect again.
 */
export function settleWaitingRecords(
  state: RunState,
  { now = Date.now(), journal }: { now?: number; journal?: DeclarationSink } = {},
): WaitSettlement[] {
  const settled: WaitSettlement[] = [];
  const over = runIsOver(state);
  const consolesClock = !over && state.stoppedBy !== 'operator'
    && (state.status === 'waiting' || state.status === 'paused') && Boolean(state.waitUntil);
  if (consolesClock) return settled;
  const sink = journal ?? journalOf(state);
  for (const record of Object.values(state.phases)) {
    if (record.status !== 'waiting' || !record.parkedUntil) continue;
    const clock = record.parkedUntil;
    const lateByMs = now - Date.parse(clock);
    if (!over && lateByMs <= WAIT_SETTLE_GRACE_MS) continue;
    const at = new Date(now).toISOString();
    let settlement: WaitSettlement;
    if (over) {
      record.status = 'interrupted';
      record.note = `parked until ${clock}, and the run ended before the clock fired — nothing will resume it`;
      record.endedAt ??= at;
      settlement = { phase: record.phase, to: 'interrupted', why: 'run-over', clock, lateByMs, runStatus: state.status };
    } else {
      record.status = 'pending';
      record.note = `parked until ${clock}; the clock passed with nothing to fire it — `
        + `the declaration stands, and a Retry or a relaunch resumes the session`;
      settlement = {
        phase: record.phase, to: 'pending',
        why: state.stoppedBy === 'operator' ? 'operator-stopped' : 'clock-unarmed',
        clock, lateByMs, runStatus: state.status,
      };
    }
    // The declaration is NOT spent: it is the session's testimony about a wait
    // that never got its resume, and the next boarding reads it. The record's
    // clock goes, because it is what every surface painted as "waiting until".
    // Its END is kept as the phase's age (control-tower phase 86, #132): that
    // is when the phase rejoined the line, and the relaunch that boards it — the
    // ladder's hint, a Retry — ranks it by that seniority (`seniorityOf`), not
    // by the moment somebody noticed the clock had passed.
    if (!over && !(Date.parse(record.queueSince ?? '') <= Date.parse(clock))) record.queueSince = clock;
    delete record.parkedUntil;
    record.resumeSessionId ??= record.sessionId;
    // Said once per clock (#53); settled — and so saved — every time.
    if (firstSettlement(`${state.id}:${record.phase}:${clock}`)) sink(WAIT_SETTLED_EVENT, { ...settlement }, record.phase);
    settled.push(settlement);
  }
  // A clock a park CARRIED (`carryWaitClock`) goes with the record it was
  // carried for; one another waiting record still holds is kept.
  if (settled.length) syncWaitClock(state);
  return settled;
}

/**
 * What to tell a person about sessions an earlier console left behind — the
 * ONE composer, for the two paths that find them.
 *
 * `reconcileRun` (the read path) and `Runner.adopt` (the start path) ask the
 * same question about the same fact and used to answer it differently: only
 * reconcile split FROZEN orphans out. A SIGSTOPped child satisfies
 * `processState(...) !== 'gone'`, so `adopt` classified it as alive and wrote
 * "let it finish or stop it" — advice that cannot be taken, because nothing is
 * scheduling it and no console is coming back to continue it. It also stamped
 * the phase `running`, which is a claim about a process that is not running.
 *
 * The probe is over BOTH stored flags and the kernel, and the kernel wins:
 * the flags are a claim a dead console left behind, and a console killed
 * between its SIGSTOP and its checkpoint records no freeze at all for a child
 * that is stopped anyway.
 *
 * `resume` is the only thing the two callers differ on — reconcile is talking
 * about a run it is holding open ("continue this run"), adopt about one being
 * started again.
 */
export function orphanAdvice(
  state: RunState,
  alive: ChildRef[],
  resume: 'continue this run' | 'start this run again',
): { reason: string; phase: number; frozen: ChildRef[]; running: ChildRef[] } {
  const first = alive[0]!;
  const frozen = alive.filter((child) => processState(child.pid) === 'stopped'
    || child.frozen || state.freeze?.pid === child.pid);
  const running = alive.filter((child) => !frozen.includes(child));
  // A frozen orphan is the one case where "let it finish" is wrong advice:
  // nothing is scheduling it, so it will sit stopped forever waiting for a
  // console that is not coming back.
  const frozenAdvice = frozen.length === 1
    ? `phase ${frozen[0]!.phase} was frozen by the operator (pid ${frozen[0]!.pid}) and the `
      + 'console that stopped it is gone, so nothing will start it again. Continue it with '
      + `\`kill -CONT ${frozen[0]!.pid}\`, or stop it with \`kill ${frozen[0]!.pid}\` and run the phase again.`
    : `${frozen.length} phases were frozen by the operator and the console that stopped them `
      + 'is gone, so nothing will start them again. Continue each with `kill -CONT <pid>` '
      + `(${frozen.map((child) => `pid ${child.pid} — phase ${child.phase}`).join('; ')}), `
      + 'or stop them and run the phases again.';
  const reason = frozen.length
    ? frozenAdvice + (running.length
      ? ` Meanwhile ${running.length === 1 ? 'a session is' : `${running.length} sessions are`}`
        + ` still running (${running.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}).`
      : '')
    : alive.length === 1
      ? `a session from an earlier console is still running (pid ${first.pid}, `
        + `phase ${first.phase}). Let it finish or stop it, then ${resume}.`
      : `${alive.length} sessions from an earlier console are still running (`
        + `${alive.map((child) => `pid ${child.pid}, phase ${child.phase}`).join('; ')}). `
        + `Let them finish or stop them, then ${resume}.`;
  return { reason, phase: frozen.length ? frozen[0]!.phase : first.phase, frozen, running };
}

/**
 * Make a loaded run tell the truth about whether anything is driving it.
 *
 * `status: "running"` is not an observation, it is a claim — written by a
 * process that can be killed in the next microsecond, and then never corrected,
 * because correcting it was that process's job. A console that reads the claim
 * back and believes it shows a run as live forever, offers a Stop button whose
 * handler has nothing to stop, and hides the one fact the operator needs: that
 * this run ended some time ago and nobody wrote down why.
 *
 * This is the ordinary stale-lease problem, and it takes the ordinary fix:
 * liveness is *derived* at read time from evidence that cannot be faked — is
 * this the run the in-process loop is actually driving, and is the recorded
 * child pid still alive — rather than trusted from a field.
 *
 * `liveRunId` is the id the current `Runner` is driving, and it is the only
 * thing that licenses an in-flight status. Everything else gets reclaimed.
 * Returns whether anything changed, so callers only write when there is
 * something to write. `journal`, when given, is where a REAL orphan's park is
 * said (#175) — the read path used to write it to the record alone.
 */
export function reconcileRun(
  state: RunState, liveRunId?: LiveRuns, opts: { journal?: DeclarationSink } = {},
): boolean {
  if (isLive(state.id, liveRunId)) return false;
  if (!IN_FLIGHT.includes(state.status)) return false;
  // A lane in its `Setup:` or its baseline, one whose lock its console is
  // still refreshing, or a session the live console launched, IS driven —
  // whatever this reader was told (#173, #175).
  if (laneInFlight(state)) return false;

  const at = new Date().toISOString();
  // Whether the OPERATOR had asked this run to stop before the console died —
  // a stop or pause in flight, or a pause armed. That intent outlives the
  // crash: the convergence loop must not pick the run back up on their behalf.
  const askedToStop = state.status === 'stopping' || state.status === 'pausing' || Boolean(state.pause);

  // The dangerous case: the console went away but its child did not. That
  // session is still editing the working tree, unobserved. Say so precisely —
  // with the pid — rather than reclaiming a run something is still writing.
  //
  // Every lane is checked, not just the mirror: a three-lane run whose mirror
  // happened to be the one that exited would otherwise reconcile to
  // `interrupted` while two sessions carried on writing the tree.
  //
  // Identity by `procIdentity`, which is the (pid, start-time) tuple when the
  // record carries one and nothing at all when it does not — never `child.
  // startedAt` (the PHASE's start; hours off the process's on a retry) and
  // never a `comm` check. This branch decides whether a run may be RECLAIMED,
  // so not-holding-work is the answer that takes something away, and the two
  // errors are not equal: a missed orphan means two sessions editing one
  // working tree, while a recycled pid merely parks a run until a person looks.
  //
  // `pidHoldsWork`, not `!== 'gone'`: a `zombie` child is an ORPHAN THAT HAS
  // ALREADY EXITED, so parking the run and telling the operator a session is
  // "still editing the tree, unobserved" names a process that closed its files
  // before we looked. `stopped` still counts — that one is exactly what the
  // frozen half of `orphanAdvice` is for.
  const alive = childrenOf(state).filter(
    (child) => pidHoldsWork(child.pid, procIdentity(child)),
  );
  if (alive.length) {
    // A boot hold reaches here too, and THIS is the act it exists to stop.
    // `readoptQueued` and `convergeAutomatic()` were already gated; the park
    // that actually happened was written here, on the run-file READ path, by a
    // page view or the ten-second sweep — so a console in a crash loop parked
    // two live autopilot runs it had never driven, once per boot, while their
    // `claude` children carried on at PPID 1 unsupervised. Deferred rather than
    // skipped: the run keeps its status untouched, and the release does this
    // pass once.
    // Said once by the latch's own setter rather than per read: this is the
    // run-file read path, and a line here is a line per page view.
    if (adoptionHeld()) return false;
    const advice = orphanAdvice(state, alive, 'continue this run');
    setRunState(state, 'parked');
    // The same shape `Runner.adopt` writes for the same fact — ONE orphan
    // kind, so the recovery model and the situation classifier read the two
    // paths identically (the read-path one used to be kindless), and now ONE
    // composer, so the two cannot describe it differently either.
    state.halt ??= { at, kind: 'orphaned-session', reason: advice.reason, phase: advice.phase };
    state.stoppedBy = 'system';
    // Said where a person reads, once (#175): this park was written to the
    // record alone, so the false ones left nothing to date them by — and a real
    // one is the moment an operator most needs the line. `launcher` says what
    // was known of the console that launched them: gone, or never recorded.
    opts.journal?.('run.orphaned', {
      pids: alive.map((child) => child.pid), phases: alive.map((child) => child.phase),
      launcher: alive.some((child) => launcherAlive(child) === null) ? 'unknown' : 'gone',
      ...(advice.frozen.length ? { frozen: advice.frozen.map((child) => child.pid) } : {}),
    }, advice.phase);
    return true;
  }

  // A run asleep on a usage window is the one in-flight state whose "why" IS
  // recorded: `waitUntil` says exactly when it meant to continue. Flattening
  // it to `interrupted` — which this function did — threw that away, and a
  // console restart during a long window turned a self-resuming run into one
  // waiting for a person. It reconciles to `paused` with the clock intact;
  // whether anything re-arms the wait is the service's boot decision
  // (`readoptIdle`), not this function's — reconcile preserves facts.
  //
  // The word is `paused` because the resume machinery keys on it and a dead
  // run left `waiting` would be in flight and re-reconciled on every read; the
  // LIFECYCLE stays the wait it is (control-tower phase 88, #148) — its kind,
  // its clock and what it is on — because nobody paused this run. So the stop
  // is stamped the system's BEFORE the word lands: the fold reads it.
  if (state.status === 'waiting' && state.waitUntil) {
    state.stoppedBy = 'system';
    state.pause = null;
    const kind = waitReasonOf(state);
    const stated = state.lifecycle?.wait?.kind === kind ? state.lifecycle.wait.on : undefined;
    setRunState(state, 'paused', { kind, until: state.waitUntil, ...(stated ? { on: stated } : {}) });
    state.child = null;
    delete state.children;
    state.freeze = null;
    // Every run-level wait shares the clock — the usage window, a park on
    // external work some phase declared, a person's card, the network, a busy
    // engine. `waitReason` says which; the record scan behind it is only the
    // answer for runs written before that field. The boot re-arm
    // (`Service.readoptQueued`) makes the same read. Only the usage window
    // offers another account: a card or a CD run is not an account's wall.
    const waitWords: Partial<Record<WaitReason, string>> = {
      external: 'waiting on external work',
      person: 'waiting for a person to answer a card',
      connectivity: 'waiting for the network',
      'engine-busy': 'waiting for the machine to read the plan',
    };
    state.finishedReason ??= waitWords[kind]
      ? `${waitWords[kind]} — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now, or leave it to re-arm.'
      : `usage limit — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now under another account, or leave it to re-arm.';
    for (const record of Object.values(state.phases)) {
      if (!PHASE_IN_FLIGHT.includes(record.status)) continue;
      record.status = 'pending';
      record.resumeSessionId ??= record.sessionId;
    }
    return true;
  }

  const phase = childrenOf(state)[0]?.phase ?? state.activePhase ?? undefined;
  // Named, since LFC-1 — `interrupted-by-restart` on BOTH arms. The child is
  // dead by the time this branch is reached (the live-orphan case parked above
  // as `orphaned-session`, and `test/phase-liveness.test.ts` holds that an
  // exited child is never an orphan), so whether a phase was in flight only
  // changes the sentence and the `phase` anchor, not what happened: the run
  // was interrupted by a console restart. Every writer of a halt supplies a
  // kind; this one used to be the exception that made the field optional.
  state.halt ??= {
    at,
    reason: phase === undefined
      ? `nothing has been driving this run since ${state.updatedAt} — the console that started it stopped without recording why.`
      : `nothing has been driving this run since ${state.updatedAt} — the console stopped while phase ${phase} was in flight, without recording why.`,
    phase,
    kind: 'interrupted-by-restart',
  };
  // A dead `halting` run DID record why it stopped — its halt is the reason —
  // so it finalizes to the `halted` its drive loop never got to write.
  // `interrupted` remains the word for "nothing recorded why".
  const settled: RunStatus = state.status === 'halting' ? 'halted' : 'interrupted';
  // A stop the operator had asked for stays theirs; everything else — a
  // crash, a kill, a console that went away — is the system's to pick up.
  state.stoppedBy = askedToStop ? 'operator' : 'system';
  state.child = null;
  // Every lane, not only the mirror — a leftover `children` entry would keep
  // presenting a dead session as live on every page that reads the map.
  delete state.children;
  // A pause waiting for a phase that is no longer running will never arrive.
  state.pause = null;
  // Same for a freeze whose child is already gone: the block would otherwise
  // make a dead run look held, and offer a Continue that resumes nothing.
  state.freeze = null;
  // The word lands LAST, through the one writer (#50): a run that died queued
  // on scope drops the queue's reason with it, and the lifecycle is derived
  // with the freeze above already gone rather than from the run as it died.
  setRunState(state, settled);

  // The records, on the same evidence. Reached only with `alive` empty, so
  // every per-phase probe below answers `gone` too and this settles the same
  // set the inlined loop always did — the difference is that the function is
  // now reachable from the paths where this one returns early.
  settleInFlightRecords(state, at);
  return true;
}

/* ------------------------------------------------------------------ *
 * Letting the board settle a run that stopped
 * ------------------------------------------------------------------ */

/**
 * The phases whose fate decides whether a stopped run still needs a person.
 *
 * A halt is always *about* something: the phase it stopped on. A scoped run is
 * about its scope as well — finishing the phase it halted on while three other
 * requested phases never ran is not a run anybody is done with.
 *
 * Empty means the run stopped without recording what it stopped on, and that
 * is deliberately not resolvable: there is no evidence to overtake, so a person
 * decides. Same fail-safe shape as `reconcileRun` — derive from what can be
 * checked, never from what can be assumed.
 */
export function decidingPhases(state: RunState): number[] {
  const phases = new Set<number>();
  for (const phase of state.onlyPhases ?? []) phases.add(phase);
  const stoppedOn = state.halt?.phase ?? state.activePhase;
  if (typeof stoppedOn === 'number') phases.add(stoppedOn);
  return [...phases].sort((a, b) => a - b);
}

/**
 * The ending to quote when several phases stopped — the one that happened LAST.
 *
 * Two branches of the drive loop write a headline over a set of settled phases,
 * and both reached for "the last element of `Object.values(state.phases)`",
 * which is integer-keyed: that is the highest phase NUMBER, not the newest
 * stop. A run where phase 5 lost its handoff at 10:00 and phase 2 failed its
 * verification at 12:00 headlined phase 5, sending a person to the wrong phase
 * page. One helper so the two cannot drift again.
 */
export function latestEnding(records: readonly PhaseRecord[]): PhaseRecord | null {
  const settled = records.filter((r) => r.halt);
  if (!settled.length) return null;
  return settled.reduce((a, b) => (b.halt!.at > a.halt!.at ? b : a));
}

/**
 * A park on a SPENT wait budget has ended — its ref landed, or a person gave it
 * a session again (control-tower phase 45). The `budgets` errand that asked
 * for more budget is answered, and the stamp that kept its `cmd:` refs running
 * past the budget's end goes with it. Answers whether there was one.
 */
export function retireSpentBudget(state: RunState, phase: number): boolean {
  const record = state.phases[String(phase)];
  if (!record?.declared?.budgetSpent) return false;
  delete record.declared.budgetSpent;
  const slot = state.recoveries?.[String(phase)];
  if (slot?.errand?.decisionKey === 'budgets') delete slot.errand;
  return true;
}

/**
 * A person raised the budget that held this work (control-tower phase 14,
 * #40): answer the hold it left — a spent wait's stamp (which re-arms the
 * watch: its `cmd:` refs are bounded by the budget again), the errand that
 * asked for more, and a run halted on its dollars. Never anything a raise did
 * not answer: another budget's errand, a streak, a failure. Answers what it
 * cleared, for the journal.
 */
export function clearBudgetHold(state: RunState, budget: BudgetKind, phase: number | null): string[] {
  const cleared: string[] = [];
  if (budget === 'wait' && phase != null && retireSpentBudget(state, phase)) cleared.push('spent-wait');
  const slot = phase != null ? state.recoveries?.[String(phase)] : undefined;
  const errand = slot?.errand;
  if (slot && errand && (errand.budget?.budget === budget || (budget === 'ladder' && errand.cap)
    || (budget === 'wait' && errand.decisionKey === 'budgets'))) {
    delete slot.errand;
    cleared.push('errand');
  }
  if (budget === 'run-usd') {
    if (state.halt?.kind === 'budget') { state.halt = null; cleared.push('halt'); }
    if (state.errand && (state.errand.budget?.budget === 'run-usd' || state.errand.situation === 'resource-wall:budget')) {
      state.errand = null;
      cleared.push('run-errand');
    }
  }
  return cleared;
}

/* ------------------------------------------------------------------ *
 * The failure streak — the ordered set (control-tower phase 45)
 * ------------------------------------------------------------------ */

/**
 * The phases the failure streak counts, oldest first. `[]` whenever the count
 * reads zero — a writer that zeroed the number zeroed the streak, whatever an
 * older set still says. A run written before the set existed carries a count
 * with no phases; it reads `[]` here, and `chargeFailure` carries that count
 * ahead of the set it starts rather than dropping a failure it cannot name.
 */
export function streakPhases(state: Pick<RunState, 'consecutiveFailures' | 'failureStreak'>): number[] {
  if (!(state.consecutiveFailures > 0)) return [];
  return (state.failureStreak ?? []).filter((phase) => Number.isInteger(phase));
}

/**
 * Zero the streak — the count and the set together, and the only writer of
 * either besides `chargeFailure`. Answers what the count was.
 */
export function resetStreak(state: Pick<RunState, 'consecutiveFailures' | 'failureStreak' | 'failureRoots'>): number {
  const was = state.consecutiveFailures;
  state.consecutiveFailures = 0;
  delete state.failureStreak;
  delete state.failureRoots;
  return was;
}

/** What one charge of the failure streak is blamed on — see `failureRootOf`. */
export type FailureRoot = { key: string; label: string };

/** A ref naming a phase of a plan: `phase:<slug>/<N>` (phase 88's scheme) or `lock:<slug>/<N>`. */
const PHASE_REF_RE = /^(?:phase|lock):([^/\s]+)\/(\d+)$/;

/**
 * The ROOT CAUSE a failure is charged on (control-tower phase 87, #122) — the
 * key the streak counts once, whichever phase meets it.
 *
 * #122's third comment: P50 (1 of 4) and P41 (2 of 4) were ONE cause, P43's red
 * WIP commit, and the streak counted each honest sibling. The key, in order:
 *
 *  1. the BLAMED COMMIT — named outright, or read from a phase of THIS run a ref
 *     points at (`phase:<slug>/<N>`, `lock:<slug>/<N>`) whose committed WIP is
 *     red (`wipRed`, control-tower phase 89);
 *  2. else the refs the block watched, deduped and sorted, so one wait declared
 *     in two orders is one cause.
 *
 * Null when neither names anything: the charge is the phase's own, exactly as
 * before. Phase 83's attribution needs no key — a red it names another phase
 * for is `inherited` and never reaches the charge at all.
 */
export function failureRootOf(opts: {
  commit?: string | null;
  refs?: readonly string[] | null;
  state?: Pick<RunState, 'slug' | 'phases'> | null;
}): FailureRoot | null {
  const blamed = opts.commit ?? blamedCommitOf(opts.refs ?? [], opts.state ?? null);
  if (blamed) return { key: `commit:${blamed}`, label: `commit ${blamed.slice(0, 8)}` };
  const refs = [...new Set((opts.refs ?? []).map((ref) => ref.trim()).filter(Boolean))].sort();
  return refs.length ? { key: `ref:${refs.join(' ')}`, label: refs.join(', ') } : null;
}

/** The red WIP commit of the first phase of this run a ref names, if it has one. */
function blamedCommitOf(refs: readonly string[], state: Pick<RunState, 'slug' | 'phases'> | null): string | null {
  if (!state) return null;
  for (const ref of refs) {
    const m = PHASE_REF_RE.exec(ref.trim());
    if (!m || m[1] !== state.slug) continue;
    const sha = state.phases[String(Number(m[2]))]?.wipRed?.sha;
    if (sha) return sha;
  }
  return null;
}

/**
 * Take phases OUT of the streak — the board has closed them, so the ending
 * that put each one there is contradicted, and "an ending the board
 * contradicts charges nothing" holds after the fact too. Only ever lowers the
 * count. Answers the phases it removed.
 */
export function pruneStreak(
  state: Pick<RunState, 'consecutiveFailures' | 'failureStreak' | 'failureRoots'>, phases: readonly number[],
): number[] {
  const counted = streakPhases(state);
  const removed = counted.filter((phase) => phases.includes(phase));
  if (!removed.length) return [];
  state.consecutiveFailures -= Math.min(state.consecutiveFailures, removed.length);
  if (state.consecutiveFailures > 0) {
    state.failureStreak = counted.filter((phase) => !phases.includes(phase));
    // A pruned phase's cause leaves with it: a new block on it is a new failure.
    const roots = (state.failureRoots ?? []).filter((root) => !phases.includes(root.phase));
    if (roots.length) state.failureRoots = roots; else delete state.failureRoots;
  } else resetStreak(state);
  return removed;
}

/**
 * The failure-streak halt's sentence, naming what it counts: "2 phases failed
 * in a row: phase 3, then phase 5". A count the set cannot name (a run from
 * before the set) says the number alone rather than inventing phases. A phase
 * charged on a root cause says it (control-tower phase 87, #122): "phase 5 (on
 * commit 1c8164e9)".
 */
export function streakSentence(state: Pick<RunState, 'consecutiveFailures' | 'failureStreak' | 'failureRoots'>): string {
  const phases = streakPhases(state);
  const count = state.consecutiveFailures;
  const head = `${count} ${count === 1 ? 'phase' : 'phases'} failed in a row`;
  if (!phases.length) return head;
  const causeOf = (phase: number) => state.failureRoots?.find((root) => root.phase === phase)?.label;
  const named = phases.map((phase) => `phase ${phase}${causeOf(phase) ? ` (on ${causeOf(phase)})` : ''}`);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')}, then ${named[named.length - 1]}`;
  return `${head}: ${list}`;
}

/**
 * Rewrite phase records the board has overtaken: any not-in-flight, not-done
 * record whose phase the board now reads `done` becomes `done` with a note
 * saying the work was closed outside this run.
 *
 * This is the record-level half the run-level resolver below never did — it
 * annotates the RUN but leaves every `failed` phase record standing, which is
 * how a live plan ended up with eight "failed" chips over a board reading
 * done. Never the reverse: a phase the board does NOT read done is untouched,
 * whatever its record says — reconcile closes records, it never re-opens or
 * re-runs them. Clearing the halt is part of the same truth: a halt anchored
 * to a phase that is now done is a card about nothing.
 */
/** The reconcile note for a record this run attempted — see `reconcileRecordsAgainstBoard`. */
export const RECONCILED_ATTEMPTED_NOTE = 'closed while checkpointed — the board reads done; not verified by this run';

export const RECONCILABLE: readonly PhaseStatus[] = [
  'failed', 'parked', 'waiting', 'pending', 'interrupted', 'gated', 'queued',
];

export function reconcileRecordsAgainstBoard(
  state: RunState,
  board: Record<number, string>,
  now = new Date().toISOString(),
  /**
   * Where the `board-closed` spend is journalled (WAI-9). A live runner passes
   * its own journal; a read path takes the run's — lazily, so a reconcile that
   * closes nothing opens nothing.
   */
  journal: DeclarationSink = journalOf(state),
  /**
   * `hold`: phases whose `done` the board reads off handoff content that is NOT
   * committed (control-tower phase 79, #113) — an untracked scaffold, a status
   * flipped in the working tree. They are not closed, and are answered in
   * `held`. The live drive tick asks git for the set; a caller that cannot
   * ask passes none, which is the old rule.
   */
  opts: { hold?: ReadonlySet<number> } = {},
): { changed: boolean; closed: number[]; held: number[] } {
  const closed: number[] = [];
  const held: number[] = [];
  // Hoisted: `childrenOf` rebuilds an array, and this loop runs per record on a
  // read path. The probe it feeds is the cached, non-blocking one; the
  // allocation was the only per-record cost worth removing.
  const children = childrenOf(state);
  for (const record of Object.values(state.phases)) {
    if (!RECONCILABLE.includes(record.status)) continue;
    if (board[record.phase] !== 'done') continue;
    // Only COMMITTED handoff content closes a record (#113): the board's
    // `done` is only as durable as the file it read, and an untracked
    // scaffold that is moved aside takes it back.
    if (opts.hold?.has(record.phase)) { held.push(record.phase); continue; }
    // A verification the console's going-down cut is owed before any close on
    // the board's word (control-tower phase 48, #69). This very line closed
    // one phase "done, not verified by this run" with 0 of its 5 commands run,
    // a second after the restart that cut them; the next drive re-verifies.
    if (owesVerification(record)) continue;
    // …and a phase this run RE-OPENED on a red final verdict (control-tower
    // phase 62, #68), for the same reason: the board reads the handoff the
    // verdict was about. A green verification of it is what ends it.
    if (record.reopened) continue;
    // A phase an operator SENT BACK is not one the board has overtaken — the
    // board is merely still reading the handoff the phase wrote before the
    // review, which is the very handoff being sent back. Closing it here would
    // undo the operator's act between two ticks, silently: the record flips to
    // `done`, the hint goes with it, and the follow-up session never boards.
    // Every other reconcilable record still closes exactly as before.
    if (record.boardingHint?.rung === FOLLOW_UP_RUNG) continue;
    // Nor is a phase whose §Verification THIS RUN just ran and failed. Exactly
    // the reasoning one line up, from the other direction: the board is reading
    // the handoff that the verification contradicted, so "the board has
    // overtaken it" is false — the board never knew.
    //
    // Measured (D27): a phase's `pnpm verify:local` ran for 9.7 minutes,
    // failed, and halted the run; sixty seconds later this function wrote
    // `phase.reconciled {outcome: done}` and dissolved that halt, because the
    // phase's own handoff read complete. The runner and its own reconciler
    // reached opposite verdicts about one phase a minute apart, and the one
    // that had actually RUN the commands lost. What the operator was left with
    // is a green board over a red suite, and no trace of the disagreement.
    //
    // Narrow on purpose: `failed` stays reconcilable for every other cause — a
    // session that died, a halt on a lint, a phase the board closed while this
    // run was busy elsewhere. Only a recorded verification that ran and failed
    // holds, because that is evidence this process produced itself and no
    // handoff can outrank it.
    if (record.status === 'failed' && record.verification?.ok === false
      && (record.verification.ran?.length ?? 0) > 0) continue;
    // …and the same rule for the ONE case the guard above cannot see: a manual
    // sign-off a person rejected. The plan's §Verification was prose, nothing
    // ran, so `verification.ran` is empty and the halt KIND is the only surviving
    // evidence that anybody looked. Same principle either way — this run
    // adjudicated the phase and said no, and the board's `done` is the very
    // handoff that verdict was about, so it is not new evidence.
    //
    // Narrow for the same reason the guard above is: `record.halt` is written by
    // `settlePhase` for the `PHASE_HALT_KINDS`, and for the `RUN_HALT_KINDS` the
    // run never reached a verdict at all (the two lists are
    // `shared/recovery-model.js`'s; this sentence used to count them, and
    // counted wrong — LFC-10). `no-handoff` is the plain case — the complaint is
    // literally "no handoff was written", so a board that now reads `done` means
    // one exists and the complaint is void. Holding those back would strand the
    // ending forever (a done phase never re-boards and never retries, so no other
    // retire path can fire), which is the misclassification wedge this phase
    // exists to close, through a new door.
    //
    // One shape is NOT an adjudication, though it carries the kind: a
    // `verify-failed` halt over a verification that reads GREEN. That is the
    // contradiction #45 recorded — a command rescued on its retry, a verdict of
    // `ok: true`, and a halt written in the same second from the rescued row.
    // This run's own verdict was green, so the board's `done` outranks nothing
    // and the record closes like any other.
    const rescuedContradiction = record.halt?.kind === 'verify-failed' && record.verification?.ok === true;
    if (record.status === 'failed' && isAdjudicatedHalt(record.halt?.kind) && !rescuedContradiction) continue;
    // A PROCESS IS A FACT; A RECORD IS A CLAIM. The board reads a handoff, and a
    // handoff cannot know that a child of this run is still on the machine
    // holding this phase's work. `pidHoldsWork` is true of a `stopped` process
    // as well as a running one, which is the case that matters here: a FROZEN
    // orphan's record is written `interrupted` (`Runner.adopt`), and
    // `interrupted` is reconcilable — so without this the board would close the
    // record, overwrite the note, and dissolve the very halt that names the pid
    // and the `kill -CONT` an operator needs. Same probe and same identity tuple
    // as `settleInFlightRecords`, so the two cannot disagree about one process.
    const surviving = children.some(
      (child) => child.phase === record.phase
        && pidHoldsWork(child.pid, procIdentity(child)),
    );
    if (surviving) continue;
    record.status = 'done';
    // Whose work the board is reading is not something the board can say. A
    // phase this run never started was closed by someone else; one it DID start
    // — a session checkpointed by a wall, a lane parked or waiting — may have
    // been finished by a sibling lane of this very run (autopilot-token-drain H7:
    // P3's session closed P2's artefacts, and P2 read "outside this run"). Either
    // way nothing here ran the phase's §Verification, and the note says so.
    record.note = record.attempts > 0 || record.startedAt
      ? RECONCILED_ATTEMPTED_NOTE
      : 'closed outside this run (the board reads done)';
    // The close is the board's, and says so: what `reopenRegressedRecords`
    // re-reads every drive tick (#113).
    record.reconciled = { at: now };
    delete record.undriven;
    record.endedAt ??= now;
    // A record that STARTED and reports no spend did not cost nothing — its
    // session was lost before the CLI's terminal `result` arrived. Say so.
    if (record.startedAt && !record.costUsd) record.costUnknown = true;
    delete record.parkedUntil;
    delete record.parkReason;
    endLockWait(record);
    // The commonest way a declaration ends — 19 of the audit's 22 never-resumed
    // waits died here — and it left no line at all (WAI-9). Now it journals.
    consumeDeclaration(record, 'board-closed', journal);
    closed.push(record.phase);
  }
  // …except a stop about the PLAN (control-tower phase 81, #97). A `plan-lint`
  // halt is anchored on the phase whose handoff broke the lint, and that phase
  // reads done by construction — the lint runs after it closes — so this used
  // to dissolve every fresh one on its first read. The record still closes; the
  // stop stands until the plan answers it (a clean lint: converge, Recover).
  if (closed.length && state.halt?.phase != null && closed.includes(state.halt.phase) && !isPlanHalt(state.halt.kind)) {
    // The story moves with the halt: `finishedReason` kept quoting the dead
    // blocker ("phase 7 declared itself blocked…") while the phase list read
    // done — the exact contradiction an operator reported. History lives in
    // the journal; the headline tells the truth as of now.
    state.finishedReason = `halted on phase ${state.halt.phase}; the board has since closed it — `
      + 'nothing is left of the halt';
    state.halt = null;
    // A count the set cannot name — a run written before the set existed —
    // keeps the rule it was written under: the halt it ended in is gone, and
    // so is the count.
    if (streakPhases(state).length < state.consecutiveFailures) resetStreak(state);
  }
  // The board closing a phase contradicts the ending that put it in the
  // failure streak, so it leaves the set (control-tower phase 45). The rest of
  // the set stands: those phases' failures are still what they were. This used
  // to zero the whole count, and only when the RUN's halt happened to be
  // anchored on the closed phase.
  if (closed.length) pruneStreak(state, closed);
  // The same dissolve at the PHASE level, for every record the board closed —
  // not just the one the run's halt happened to be anchored to. A phase the
  // board reads done has no ending left to describe.
  for (const phase of closed) retirePhaseHalt(state.phases[String(phase)]);
  // …and the asks that are void now that their phase is (#43): the board closing
  // a record, or one that already read done, is the answer an errand waited for.
  const retired = retireSettledErrands(state, journal);
  return { changed: closed.length > 0 || retired.length > 0, closed, held };
}

/**
 * The reverse of the close above, re-read on every drive tick (control-tower
 * phase 79, #113). A record reconcile closed on the board's word — and ONLY
 * such a record (`reconciled`): one this run verified is its own evidence —
 * whose phase the board no longer reads `done` goes back to `pending`, with
 * `resumeSessionId` kept, so the next boarding resumes the session it was
 * checkpointed from.
 *
 * Measured: an untracked scaffold reading `complete` turned a phase done, this
 * pass's twin closed the record while the phase's session was checkpointed,
 * the scaffold was moved aside — and the record stayed `done` while the board
 * read `in-progress`, undriven for fourteen hours. A close whose reason has
 * gone away is not a close.
 *
 * A board that said nothing about the phase (`unknown`, absent — a read that
 * failed) is not a regression: nothing is reopened on it.
 */
export function reopenRegressedRecords(
  state: RunState,
  board: Record<number, string>,
  now = new Date().toISOString(),
): { changed: boolean; reopened: { phase: number; board: string; closedAt: string | null; resumeSessionId: string | null }[] } {
  const reopened: { phase: number; board: string; closedAt: string | null; resumeSessionId: string | null }[] = [];
  for (const record of Object.values(state.phases)) {
    if (record.status !== 'done' || !record.reconciled) continue;
    const word = board[record.phase];
    if (!word || word === 'done' || !(BOARD_BUCKETS as readonly string[]).includes(word)) continue;
    const closedAt = record.reconciled.at ?? null;
    delete record.reconciled;
    record.status = 'pending';
    delete record.endedAt;
    delete record.costUnknown;
    // The session the checkpoint named is what the next boarding resumes; one
    // that named none resumes the phase's own, as an elapsed park does.
    if (!record.resumeSessionId && record.sessionId && !isSessionGone(record, record.sessionId)) {
      record.resumeSessionId = record.sessionId;
    }
    record.note = `reopened — the board no longer reads it done (it reads ${word}); reconcile had closed it`
      + `${closedAt ? ` at ${closedAt}` : ''} on the board's word, and that word is gone`;
    reopened.push({ phase: record.phase, board: word, closedAt, resumeSessionId: record.resumeSessionId ?? null });
  }
  return { changed: reopened.length > 0, reopened };
}

/**
 * Resolve a stopped run the board has already moved past.
 *
 * The reconciliation above answers "is anything still driving this?"; this
 * answers the question after it — "does what it stopped on still matter?" Both
 * are derived at read time from evidence that cannot be faked, which is the
 * only way a record written by a process that then died can ever be corrected.
 *
 * `board` is the engine's live classification (`phase-graph.sh --memory-block`,
 * `states` in `Board`). Every deciding phase must read `done` on it: an empty
 * or unreadable board therefore resolves nothing, which is the safe direction —
 * a run that still wants attention and does not get it is the failure this
 * whole surface exists to prevent, so uncertainty keeps the card.
 *
 * Returns whether anything changed, so callers only write when there is
 * something to write.
 */
export function autoResolveRun(
  state: RunState, board: Record<number, string>, qaHeld: ReadonlySet<number> = new Set(),
): boolean {
  if (state.resolved || state.reopenedAt) return false;
  if (!RESOLVABLE.includes(state.status)) return false;
  // A run parked because its work is not on its trunk is not superseded by the
  // board: every phase reading done is the very premise of that park
  // (control-tower phase 112, #184).
  if (state.halt?.kind === 'unlanded') return false;
  // A stop about the plan is not superseded by any phase reading done — its
  // anchor always does (control-tower phase 81, #97). Only a clean lint answers
  // it, and "superseded" here pinned the run against the relaunch that would.
  if (isPlanHalt(state.halt?.kind)) return false;
  // A run owing a verification a restart cut is not superseded by the board's
  // word — the board is reading the very handoff the verification was checking
  // (control-tower phase 48, #69). The next drive re-verifies; then this may.
  if (Object.values(state.phases).some((record) => owesVerification(record) || record.reopened)) return false;

  const phases = decidingPhases(state);
  if (!phases.length) return false;
  if (!phases.every((phase) => board[phase] === 'done')) return false;
  // `board[phase] === 'done'` is not "nothing is wrong" when a QA verdict is
  // still holding that phase's dependents.
  //
  // Every QA rung anchors on a phase the board reads done — that is the point of
  // admitting one as a candidate — so a rung whose session does not end cleanly
  // leaves the run stopped ON a done phase, and this resolver read exactly that
  // as superseded. Stamping `resolved` is what `converge.ts` treats as pinned:
  // boot, timer, change and halt passes all skip the plan for ever after. One
  // imperfect QA session and the unattended path terminated permanently, on its
  // most likely first stumble — the shape this whole change set exists to remove.
  //
  // Narrow deliberately: only a phase this run STOPPED on counts (both anchors,
  // `halt.phase` and `activePhase`, since the common failed-verification route
  // nulls the halt). A verdict holding some unrelated phase must not keep a
  // finished run on the attention surface.
  if (phases.some((phase) => qaHeld.has(phase))) return false;

  state.resolved = {
    at: new Date().toISOString(),
    auto: true,
    reason: `superseded — the board shows ${
      phases.length === 1 ? `phase ${phases[0]}` : `phases ${phases.join(', ')}`
    } done`,
  };
  return true;
}

/**
 * A run that is OVER stops asking for attention.
 *
 * `reconcileRecordsAgainstBoard` dissolves a halt the board has overtaken — it
 * clears `state.halt`, resets the failure streak and rewrites `finishedReason`
 * to say so — but it never touches `state.status`. `autoResolveRun` adds a
 * `resolved` annotation and likewise leaves the status alone, and returns early
 * for a run already resolved, so nothing ever revisits one.
 *
 * `shared/status-vocab.js` maps both `halted` and `parked` to `needs-you`, the
 * worst-first attention state. The result, measured across a real console's
 * fleet: three runs reading `halted` with `halt: null` and a reason that said
 * "nothing is left of the halt" — one of them 15/15 done, another shipped as
 * v3.0.0 — permanently at the top of the operator's attention surface. An
 * attention surface that is mostly false is one nobody reads, which is how the
 * single run that did need a person went unnoticed for a day.
 *
 * Conservative on purpose: only a run nobody is driving, that the OPERATOR did
 * not stop (theirs to restart, and a stopped run with work left is not over),
 * and only when the board is readable AND has nothing outstanding at all. An
 * empty or unreadable board settles nothing — uncertainty keeps the card, the
 * same direction `autoResolveRun` takes.
 */
export const SETTLEABLE: readonly RunStatus[] = ['halted', 'parked', 'interrupted'];

/**
 * The statuses whose phase RECORDS are corrected against the board — wider
 * than `SETTLEABLE` by exactly one word, `paused`.
 *
 * 🔑 **Correcting a record is not resuming a run.** `SETTLEABLE` gates three
 * things at once: closing overtaken records, annotating the run as superseded,
 * and settling it to `finished`. The last two are claims about the RUN and must
 * keep their narrow gate — an operator paused that run on purpose, and this
 * console has four of them that must stay exactly where they are. The first is
 * a claim about the WORLD: the board says phase 3 is done, so a record reading
 * `failed` is simply wrong, and it is no less wrong for the run being paused.
 *
 * The shape this fixes is the one an operator meets when they pause a run and
 * finish a phase by hand in their own session: the run page went on showing the
 * phase red for as long as the pause lasted, because the only code that would
 * have corrected it was gated on the run being stopped for a reason other than
 * a person. `settleFinishedRun` keeps `SETTLEABLE` *and* refuses anything
 * `stoppedBy: 'operator'`, so nothing here can turn a pause into a finish.
 */
export const RECORD_RECONCILABLE: readonly RunStatus[] = [...SETTLEABLE, 'paused'];

export function settleFinishedRun(state: RunState, board: Record<number, string>): boolean {
  if (!SETTLEABLE.includes(state.status)) return false;
  if (state.stoppedBy === 'operator') return false;
  // 🔴 Never over an `unlanded` park (control-tower phase 112, #184): it is
  // exactly "every phase done, and the work NOT landed", so settling it here
  // would write `finished` over unlanded work on the next page view — the
  // claim #184 measured as false. Its way out is a landing and a person's
  // Recover & continue, which proves it again.
  if (state.halt?.kind === 'unlanded') return false;
  // A phase still owed the verification a restart cut is not finished work,
  // however the board reads it (control-tower phase 48, #69).
  if (Object.values(state.phases).some((record) => owesVerification(record) || record.reopened)) return false;
  const words = Object.values(board);
  if (!words.length) return false;
  if (words.every((word) => word === 'done')) {
    setRunState(state, 'finished');
    state.halt = null;
    delete state.stoppedBy;
    state.finishedReason ??= `every phase of ${state.slug} is done.`;
    return true;
  }
  // Work remains, so this run is not finished — but `halted` with NO halt is a
  // contradiction all the same, and it is the shape the dissolve path leaves
  // behind. Measured live: a run reading `halted`, `halt: null`, `$240 spent`,
  // with a phase still in progress on the board. `parked` is the honest word —
  // stopped, work outstanding, nothing wrong that anybody named — and unlike
  // `halted` it is what the recovery paths already expect to find.
  if (state.status === 'halted' && !state.halt) {
    setRunState(state, 'parked');
    return true;
  }
  return false;
}

/**
 * Which plans a batch of runs would need a board for.
 *
 * Split out from the batch itself so the caller can pay for exactly the engine
 * reads that could change something: a fleet of two hundred finished runs asks
 * for no boards at all, and twelve stopped runs across three plans ask for
 * three.
 */
export function slugsNeedingBoard(runs: readonly RunState[]): string[] {
  return [...new Set(
    runs
      // `SETTLEABLE` is wider than `RESOLVABLE` (it includes `parked`) and does
      // not exclude an already-resolved run — a run resolved days ago is
      // exactly the one still reading `halted` on the fleet page.
      .filter((run) => RECORD_RECONCILABLE.includes(run.status)
        || (!run.resolved && !run.reopenedAt && RESOLVABLE.includes(run.status)))
      .map((run) => run.slug),
  )];
}

/**
 * Apply the board resolver across a batch, and report what changed.
 *
 * A slug missing from `boards` — an engine failure, a plan that no longer
 * exists — resolves nothing, which is the same fail-safe `autoResolveRun`
 * takes on an empty board.
 */
export function resolveRunsAgainst(
  runs: readonly RunState[], boards: ReadonlyMap<string, Record<number, string>>,
  /**
   * Per slug, the phases whose QA verdict is holding their dependents. A run
   * that stopped on one of those has NOT been overtaken by anything — see
   * `autoResolveRun`. Absent for a slug means "no hold", which is the same
   * fail-safe direction an unreadable board takes.
   */
  qaHeld: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): RunState[] {
  const changed: RunState[] = [];
  for (const run of runs) {
    const board = boards.get(run.slug);
    if (!board) continue;
    // Records first, run second: closing the overtaken phase records is what
    // makes the run-level "superseded" annotation match what the phase table
    // shows. Only stopped runs — a live loop owns its records and does the
    // same reconcile itself at the top of every drive tick.
    // `SETTLEABLE`, not `RESOLVABLE`: since the halt-kind split a phase-level
    // ending leaves the run **`parked`**, so gating the record half on
    // `RESOLVABLE` (`halted`/`interrupted`) skipped exactly the runs this split
    // creates — every read showed a red `failed` chip, and a stranded
    // `record.halt`, over a board reading `done`. That is the defect this
    // function exists to fix, and `parked` is now its commonest shape.
    //
    // `parked` is also the word for the case `RESOLVABLE` excluded it FOR — a
    // child still alive under a dead console — so widening the gate is only
    // safe because `reconcileRecordsAgainstBoard` asks the PROCESS. Status
    // alone is not enough: a FROZEN orphan's record reads `interrupted`, which
    // is reconcilable, so "no in-flight status" would have dissolved the very
    // halt that names its pid and the `kill -CONT` that recovers it.
    // `autoResolveRun` below deliberately keeps the narrower gate — annotating
    // the RUN as superseded is the claim that would be wrong while a session is
    // editing a tree. And a run a person REOPENED is still left alone.
    const records = RECORD_RECONCILABLE.includes(run.status) && !run.reopenedAt
      ? reconcileRecordsAgainstBoard(run, board)
      : { changed: false, closed: [] };
    const resolved = autoResolveRun(run, board, qaHeld.get(run.slug));
    // Last, and independent of the two above: both of those annotate a run that
    // is over without ever moving it off a status the UI paints `needs-you`, and
    // `autoResolveRun` returns early for one already resolved — so nothing
    // revisits the runs that most need settling. This one is idempotent and
    // refuses on an unreadable board, so running it every pass is free.
    const settled = settleFinishedRun(run, board);
    if (records.changed || resolved || settled) changed.push(run);
  }
  return changed;
}

/**
 * Reclaim on read, and make the correction stick so it is done once.
 *
 * The correction is persisted through `saveRunSoon`, NOT `saveRun`: every read
 * of every run goes through here — `listRuns` calls it once per file, and a
 * plan open calls `listRuns` — so a synchronous fsync'd write here put disk IO
 * inside a GET handler, and a corrupted-or-not-yet-reconciled fleet of records
 * meant one write per file per request. Deferring costs nothing that matters:
 * the in-memory `state` returned to the caller is already corrected, so the
 * response is identical, and the write it schedules is the same write.
 */
/**
 * A legacy halt's word, from its sentence — read-side only.
 *
 * Every writer supplies a kind since zero-touch-console phase 2 (LFC-1); run
 * files written before it carry the reason alone — four of the hub's 53 did,
 * all from the drive loop's "nothing left to run" park — and every reader keyed
 * on the kind (`classifyRun`, `situationOfHalt`, `HALT_KIND_SITUATION`) needs
 * the word, not the prose. Only the sentences the formerly kindless sites wrote
 * are recognised; anything else is left as it is, because guessing a kind from
 * an unknown sentence is the misclassification the vocabulary exists to stop.
 * Returns true when it assigned one, so `settle()` persists the correction the
 * way it persists every other.
 */
export function healLegacyHalt(state: RunState): boolean {
  const halt = state.halt;
  if (!halt || halt.kind) return false;
  const reason = halt.reason ?? '';
  let kind: HaltKind | undefined;
  if (/^nothing (left to run on its own|is ready to run)/.test(reason)) {
    kind = /its QA verdict is (pending|fail)\b/.test(reason) ? 'plan-deadlocked' : 'nothing-ready';
  } else if (/^stopped by the operator/.test(reason)) {
    kind = 'operator-stop';
  } else if (/^nothing has been driving this run/.test(reason)) {
    kind = 'interrupted-by-restart';
  }
  if (!kind) return false;
  halt.kind = kind;
  return true;
}

function settle(state: RunState, liveRunId?: LiveRuns): RunState {
  // Live by the caller's word, or by a fact any reader can check: a lane in its
  // Setup or its baseline, or one whose lock is being refreshed (#173).
  // Only for a run that claims to be in flight: a stopped run's last beat says
  // nothing about now, and its wait clock and records must still settle.
  const live = isLive(state.id, liveRunId) || (IN_FLIGHT.includes(state.status) && laneInFlight(state));
  // A run that lost its clock gets the record's BEFORE `reconcileRun` reads the
  // run — see `rearmWaitClock`. Never for a live run: the loop owns its clock.
  const rearmed = live ? null : rearmWaitClock(state);
  // A stamp written as one string before it was a set (RCV-8) reads as a set.
  const folded = foldLegacyWatchStamps(state);
  const reclaimed = reconcileRun(state, liveRunId, { journal: journalOf(state) });
  // A kindless legacy halt gets its word before anything reads it (LFC-1).
  const healed = healLegacyHalt(state);
  // A scoped run an older console called finished with its scope still open
  // gets the honest sentence (#43) — never a new status; see `honestScopedFinish`.
  const honest = live ? false : honestScopedFinish(state);
  // The read half. A run file written by 3.4.0 has no `lifecycle` at all, and
  // one written seconds ago by a bare `state.status = …` has a stale one; both
  // come back correct, and neither is a reason on its own to schedule a write.
  syncLifecycle(state);
  // Unconditionally, and NOT inside the `reclaimed` branch: `reconcileRun`
  // answers a question about the RUN, and returns false both when the run is
  // genuinely live and when it is long since `parked`/`halted`/`interrupted`.
  // Only the first of those is a reason to leave a `running` record standing.
  // Settling the records separately is what makes a claim of work in flight
  // answerable on every read, whatever the run around it says.
  const settled = live ? [] : settleInFlightRecords(state);
  // …and the records that claim a WAIT no clock backs (WAI-6) — after the run
  // has been reconciled, so the verdict reads the run's settled status.
  const waits = live ? [] : settleWaitingRecords(state);
  if (rearmed) journalOf(state)(WAIT_SETTLED_EVENT, { ...rearmed }, rearmed.phase);
  if (!reclaimed && !settled.length && !healed && !rearmed && !waits.length && !folded && !honest) return state;
  saveRunSoon(state);
  return state;
}

/**
 * `watchLandedJournalledFor` was one string until zero-touch-console phase 6
 * made it a per-ref set (RCV-8). A run file written before then reads as a
 * one-element set, so the healer's `includes` never meets a string.
 */
function foldLegacyWatchStamps(state: RunState): boolean {
  let folded = false;
  for (const record of Object.values(state.phases)) {
    const stamp: unknown = record.watchLandedJournalledFor;
    if (typeof stamp === 'string') {
      record.watchLandedJournalledFor = [stamp];
      folded = true;
    }
  }
  return folded;
}

export function loadRun(root: string, slug: string, id: string, liveRunId: LiveRunsKnown): RunState | null {
  const target = runFile(root, slug, id);
  // A save OWED for this run means this process is holding a copy newer than
  // the file. Reading the file would hand back a state the console has already
  // moved past — the one real cost of a debounced write, and the reason the
  // coalescing has to be invisible from here rather than merely fast. Cloned,
  // so a reader can never mutate the writer's object; and deliberately NOT
  // re-settled, because a run this process is still writing is by definition
  // not one that died without writing.
  const pending = pendingSaves.get(target)?.state;
  if (pending) {
    try {
      // Synced, though NOT settled: a run this process is still writing is by
      // definition not one that died without writing, so the settle pass has
      // nothing to correct — but the debounce is a window in which a bare
      // `state.status = …` has landed and the save that would have synced its
      // axes has not run yet. A reader inside that window used to be handed a
      // status and a lifecycle describing the status before it.
      const clone = structuredClone(pending);
      syncLifecycle(clone);
      return clone;
    } catch { /* unclonable — read the file */ }
  }
  const raw = readRunFile(target);
  if (!raw) return null;
  try {
    return settle(raw, liveRunId);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The parse cache
 * ------------------------------------------------------------------ */

/**
 * One parsed run record per version of its file.
 *
 * Keyed on `(mtimeMs, size)` — the key `runRulings` already uses — because a
 * run file changes when something writes it and at no other time, while the
 * readers reach it on a ten-second clock over every plan in the store. On the
 * console where the out-of-memory exits were measured that was seven megabytes
 * of JSON re-read 8,640 times a day for no news at all.
 *
 * Only the PARSE is held. `settle()` runs on every read from a clone, because
 * its answer depends on which runs are live and a remembered "no lane was
 * driving this" would outlive the moment it was true. That is also why the
 * cached object is never handed out: `settle`, `reconcileRun` and most of the
 * service mutate what they are given, so one reader's repair would silently
 * become the next reader's fact.
 */
const parseCache = new Map<string, { stamp: string; raw: RunState }>();

/**
 * How many entries the cache may hold.
 *
 * A bound, because this is a fix for a process that ran out of heap and an
 * unbounded map over every run file a long-lived console ever touches is the
 * same bug wearing a different hat. Oldest-first eviction: `Map` iterates in
 * insertion order, and the run a sweep is about to ask for again is the one it
 * just asked for.
 */
const PARSE_CACHE_MAX = 256;

let runFileReadCount = 0;

/** How many run files this process has actually read off disk. Tests and the debug bundle. */
export function runFileReads(): number {
  return runFileReadCount;
}

/** Forget every parsed run file. The retention sweep and tests. */
export function clearRunFileCache(): void {
  parseCache.clear();
}

function readRunFile(target: string): RunState | null {
  let stamp: string;
  try {
    const info = statSync(target);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    // No file is not a cache miss to retry — it is an answer, and a stale entry
    // for a run that has been pruned must not outlive it.
    parseCache.delete(target);
    return null;
  }
  const hit = parseCache.get(target);
  if (hit && hit.stamp === stamp) {
    try { return structuredClone(hit.raw); } catch { parseCache.delete(target); }
  }
  let raw: RunState;
  try {
    runFileReadCount += 1;
    raw = JSON.parse(readFileSync(target, 'utf8')) as RunState;
  } catch {
    parseCache.delete(target);
    return null;
  }
  try {
    const keep = structuredClone(raw);
    parseCache.delete(target);
    parseCache.set(target, { stamp, raw: keep });
    while (parseCache.size > PARSE_CACHE_MAX) {
      const oldest = parseCache.keys().next();
      if (oldest.done) break;
      parseCache.delete(oldest.value);
    }
  } catch { /* unclonable: serve it, cache nothing */ }
  return raw;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Carry what ONE writer changed in its copy of a run onto the record as it
 * stands now (control-tower phase 110, #178) — a three-way merge of plain
 * JSON. Every path where `mine` differs from `base` (the copy the writer read)
 * is set on `target`; every other path keeps `target`'s value, which a runner,
 * a person or a later pass may have moved meanwhile. Objects merge key by key;
 * a list merges entry by entry, and what the writer APPENDED is appended after
 * whatever was appended meanwhile (a rung history keeps both); anything else is
 * one value. Answers whether `target` changed.
 *
 * The heal pass read a run, spent minutes classifying it under load, and then
 * saved that whole copy: the live attempt the operator's Retry had boarded in
 * the meantime was written over with the park it had already answered.
 */
export function mergeRunChanges(base: unknown, mine: unknown, target: Record<string, unknown>): boolean {
  if (!isPlainObject(base) || !isPlainObject(mine)) return false;
  let changed = false;
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const had = Object.hasOwn(base, key) && base[key] !== undefined;
    const has = Object.hasOwn(mine, key) && mine[key] !== undefined;
    if (!has) {
      if (had && Object.hasOwn(target, key)) { delete target[key]; changed = true; }
      continue;
    }
    const before = base[key];
    const after = mine[key];
    if (had && isDeepStrictEqual(before, after)) continue;
    const current = target[key];
    if (had && isPlainObject(before) && isPlainObject(after) && isPlainObject(current)) {
      if (mergeRunChanges(before, after, current)) changed = true;
      continue;
    }
    if (had && Array.isArray(before) && Array.isArray(after) && Array.isArray(current) && after.length >= before.length) {
      if (mergeListChanges(before, after, current)) changed = true;
      continue;
    }
    if (isDeepStrictEqual(current, after)) continue;
    target[key] = structuredClone(after);
    changed = true;
  }
  return changed;
}

/** `mergeRunChanges` for a list the writer edited in place or appended to. */
function mergeListChanges(before: unknown[], after: unknown[], current: unknown[]): boolean {
  let changed = false;
  for (let i = 0; i < before.length && i < current.length; i += 1) {
    if (isDeepStrictEqual(before[i], after[i])) continue;
    const was = before[i];
    const now = after[i];
    const at = current[i];
    if (isPlainObject(was) && isPlainObject(now) && isPlainObject(at)) {
      if (mergeRunChanges(was, now, at)) changed = true;
    } else if (!isDeepStrictEqual(at, now)) {
      current[i] = structuredClone(now);
      changed = true;
    }
  }
  for (const added of after.slice(before.length)) {
    current.push(structuredClone(added));
    changed = true;
  }
  return changed;
}

/** Every run recorded for a plan, newest first. */
export function listRuns(root: string, slug: string, liveRunId: LiveRunsKnown): RunState[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const runs: RunState[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8,32})\.json$/.exec(name)?.[1];  // 8..32 — see S9-b in scheduler.ts
    if (!id) continue;
    const state = loadRun(root, slug, id, liveRunId);
    if (state) runs.push(state);
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The run to offer when someone opens a plan: the one still in flight, else the
 * most recent. A finished run is still worth showing — it is the record of what
 * happened — but it must never be silently resumed.
 */
export function latestRun(root: string, slug: string, liveRunId: LiveRunsKnown): RunState | null {
  const runs = listRuns(root, slug, liveRunId);
  return runs.find((r) => r.status !== 'finished') ?? runs[0] ?? null;
}

/**
 * Is a process with this pid still alive? Used to reconcile after a restart.
 *
 * A re-export, deliberately: this was one of two probes in the tree, and the
 * bare `kill(pid, 0)` it used to be could not tell a SIGSTOPped child from a
 * working one — which is how a frozen orphan read as live for three hours.
 * `server/pid.ts` is the single implementation now; callers that need to know
 * whether the process will ever move again ask `processState` instead of this.
 */
export { pidAlive, pidHoldsWork, processState };
export type { ProcessState };

/**
 * Is the session a `--resume` would reach for known to be gone?
 *
 * The id asked about — else the record's own — against the one the runner
 * stamped in `sessionGone`. A different id is a different conversation, and a
 * record with no stamp has never been refused.
 */
export function isSessionGone(record: PhaseRecord, sessionId?: string): boolean {
  const asked = sessionId ?? record.sessionId ?? record.resumeSessionId;
  return Boolean(asked) && record.sessionGone?.sessionId === asked;
}

/**
 * Fold the ledger's rounds into a record — MERGE, never replace.
 *
 * The file's verdict wins for a round it holds, and the run's own extras
 * (session, brief, spend) survive because only this console ever knew them —
 * but a round the FILE does not hold has to survive too: a reviewer that
 * recorded nothing still leaves one on the record, with what it spent, and
 * replacing the array dropped it (QA round 3, F3). One fold for the ladder's
 * climb, the healer's sweep and the QA loop, so the record on the run page
 * follows `test-status.md` wherever the round was recorded — by a resumed
 * session, by hand, or from another clone. Answers whether anything changed.
 */
export function mergeQaHistory(
  record: PhaseRecord,
  rows: readonly { round: number; verdict: string; reportPath?: string }[],
): boolean {
  if (!rows.length) return false;
  const before = JSON.stringify(record.qa ?? []);
  const merged = new Map((record.qa ?? []).map((entry) => [entry.round, entry]));
  for (const entry of rows) merged.set(entry.round, { ...merged.get(entry.round), ...entry });
  record.qa = [...merged.values()].sort((a, b) => a.round - b.round);
  return JSON.stringify(record.qa) !== before;
}
