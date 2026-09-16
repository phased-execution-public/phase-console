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

import { DEFAULT_PRIORITY, type RunPriority } from '../../shared/orchestration-model.js';
import { HALT_KINDS, isAdjudicatedHalt } from '../../shared/recovery-model.js';
import type { QaFixStrategy, RelayMode } from '../../shared/run-settings.js';
import type { CredentialClass } from '../../shared/ops-vocab.js';
import { WAIT_REASONS, waitReasonOf } from '../../shared/status-vocab.js';
import {
  DEFAULT_SETTLE, ISOLATED,
  type CheckoutState, type IsolationMode, type SettleStrategy,
} from '../../shared/worktree-model.js';
import { consoleRunsDir, journalFile, runDir, runFile } from './run-paths.ts';
import type { WorktreeRefusal } from './worktree.ts';
import type { HolderEta } from './scheduler.ts';
import { pidAlive, pidHoldsWork, processState, type ProcessState } from '../pid.ts';
import type { PermissionProfile } from './approvals.ts';
// Type-only, so nothing is imported at runtime and the pair that would
// otherwise be a cycle (`rulings.ts` needs `runDir` from here) never forms one.
import type { LaneLiveness, StallState } from './liveness.ts';
import type { Ruling } from './rulings.ts';
import type { TaskItem } from './tasks.ts';
import type { LadderEnding } from './signals.ts';
import {
  DECLARATIONS_MAX_PER_PHASE, WAIT_SETTLE_GRACE_MS, closeWaitEntry, parkedMsOf, type WaitAuthor, type WaitEntry,
} from './wait-budget.ts';
import { Journal } from './journal.ts';
import {
  BOARDING_BRIEFS, DECLARATION_CONSUMERS, MCP_POLICIES, ON_LIMIT_POLICIES, PHASE_IN_FLIGHT, RUN_IN_FLIGHT,
  SETTLED, phaseLifecycle, runLifecycle,
} from '../../shared/run-lifecycle.js';
import type {
  Actor as ActorShape, ActorVia as ActorViaWord, AnyDoor as AnyDoorWord,
  AutonomyMode, CapSource as CapSourceWord, ClassifiedBy as ClassifiedByWord,
  DeclarationConsumer as DeclarationConsumerWord,
  EndedBy as EndedByWord, GitMode, McpPolicy, OnLimitPolicy, OutcomeStatus,
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
  if (wait && lifecycle.state === 'waiting') {
    lifecycle.wait = { kind: wait.kind, until: wait.until ?? state.waitUntil ?? null };
    if (wait.on) lifecycle.wait.on = wait.on;
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
};

export type VerifySummary = {
  ok: boolean;
  reason: string;
  ran: VerifyRun[];
  /** Commands present in the plan that the runner would not execute, and why. */
  notRun: { text: string; reason: string }[];
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
  lint?: { ok: boolean; summary: string };
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
  /** When the last attempt's session ended — the other meaning `endedAt` carried. */
  attemptEndedAt?: string;
  /**
   * Every park this phase took, from its own stamps — what `parkedMsOf`
   * (`wait-budget.ts`) sums, so parked time is correct with no resume at all.
   * Capped at `WAIT_HISTORY_MAX`; older entries fold into `parkedMsCarried`.
   */
  waitHistory?: WaitEntry[];
  /** Declared parked time folded out of the history (or accrued before it existed). */
  parkedMsCarried?: number;
  /**
   * How many times the CONSOLE parked this phase by itself (the stall
   * watchdog's automatic park). Its own ledger: it never spends `waits` or the
   * declared budget (WAI-5).
   */
  watchdogParks?: number;
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
    landed?: { ref: string; detail?: string; at: string; resumes: number };
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
      scheme: 'gh-run' | 'gh-pr' | 'date' | 'lock' | 'cmd';
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
  }[];
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
  halt?: { at: string; reason: string; phase?: number; kind?: HaltKind };
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
 * run was admitted — every row with its state, the four probes' verdicts, the
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

export type Errand = {
  phase: number;
  situation: string;
  tried: string[];
  need: string;
  how: string;
  at: string;
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
};

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

export function childrenOf(state: RunState): ChildRef[] {
  const lanes = state.children ? Object.values(state.children) : [];
  if (lanes.length) return lanes;
  return state.child ? [state.child] : [];
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
   * The account's usage window as the CLI last reported it mid-session. Not a
   * decision the runner makes — a fact worth showing before someone starts a
   * twelve-phase run against a window that is nearly spent.
   */
  limits?: { status: string; window?: string; utilization?: number; utilizationPct?: number; resetsAt?: number; at: string };
  /**
   * The Claude account this run's sessions spawn as, from the instance's
   * registry. Written as an omission when it is the machine login — a run file
   * from before accounts existed means exactly what it meant, and an id that
   * has since been removed degrades to the same place (`envFor` answers null).
   */
  accountId?: string;
  /**
   * What to do when a session hits the SHARED usage window (session/weekly —
   * model-specific limits keep their own model-switch path). Absent means
   * `wait`, which is the pre-accounts behavior: sleep to the reset. `switch`
   * checkpoints and continues under the account with the most headroom;
   * `pause` checkpoints and stops for a person.
   */
  onLimit?: OnLimitPolicy;
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
  phaseBudgetUsd: number | null;
  runBudgetUsd: number | null;
  spentUsd: number;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
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
  halt: { at: string; reason: string; phase?: number; kind?: HaltKind } | null;
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
   * Which impossibility this run hit, when `checkout` is `refused`.
   *
   * One of `worktree.ts` §`REFUSAL_REASON`'s keys — the reason is looked up
   * from there rather than stored, so a run file never carries prose that can
   * fall out of step with the code that explains it.
   */
  isolationRefusal?: WorktreeRefusal;
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
  /** QA recovery's fix strategy and per-round stop — see `RunState`. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  accountId?: string;
  onLimit?: OnLimitPolicy;
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
  /** Heal halts automatically. `true` takes the default budget; an object names it. */
  autoRecover?: boolean | { attempts?: number };
  /** The manifest answers and the resolved manifest — see `RunState`. */
  resumeOnRestart?: boolean;
  relay?: RelayMode;
  accounts?: AccountRequirement[];
  acknowledgedWaivers?: string[];
  manifest?: ResolvedManifest;
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
  return {
    id: randomUUID().slice(0, 8),
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
    // QA recovery's two, conditional for the same reason: an absent strategy
    // means `resume` resolved at the point of use, and an absent round budget
    // means no per-round stop — neither is a number worth freezing into a file.
    ...(opts.qaFixStrategy ? { qaFixStrategy: opts.qaFixStrategy } : {}),
    ...(opts.qaRoundBudgetUsd === undefined ? {} : { qaRoundBudgetUsd: opts.qaRoundBudgetUsd }),
    phaseBudgetUsd: opts.phaseBudgetUsd ?? null,
    runBudgetUsd: opts.runBudgetUsd ?? null,
    spentUsd: 0,
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
    ...(opts.onlyPhases?.length ? { onlyPhases: [...opts.onlyPhases] } : {}),
    ...(opts.phaseOptions ? { phaseOptions: { ...opts.phaseOptions } } : {}),
    ...(opts.skills?.length ? { skills: [...opts.skills] } : {}),
    ...(opts.mcpServers?.length ? { mcpServers: [...opts.mcpServers] } : {}),
    // `continue` is the absent state, so a run file written before the policy
    // existed reads as the shipped default rather than as the old park.
    ...(opts.mcpPolicy && opts.mcpPolicy !== 'continue' ? { mcpPolicy: opts.mcpPolicy } : {}),
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
    journal ??= new Journal(state.root, state.slug, state.id);
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

/**
 * A phase-level `waiting-external-timeout` written onto a STORED run — the
 * twin, for a park no runner holds, of what `Runner.settlePhase` writes when a
 * live runner refuses a wait. The service's overdue ruling is the caller: a
 * clock that went by while nothing ran is re-read at resume, and a park whose
 * parked time is past its budget halts here instead of boarding (WAI-4).
 *
 * Returns what the declaration was, so the caller journals
 * `phase.declaration-consumed` and `phase.halted` on the run's own journal.
 */
export function settleStoredWaitTimeout(
  state: RunState, phase: number, reason: string, at = new Date().toISOString(),
): ReturnType<typeof consumeDeclaration> {
  const record = phaseRecord(state, phase);
  record.status = 'failed';
  record.note = record.parkReason ?? reason;
  record.parkedUntil = undefined;
  record.halt = { at, reason, phase, kind: 'waiting-external-timeout' };
  const spent = consumeDeclaration(record, 'new-outcome');
  endLockWait(record);
  // A new ending is a new fact: a resolution about an earlier stop must not
  // dismiss this one's card (the rule `settlePhase` states).
  state.resolved = null;
  return spent;
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
export function prepareReboard(record: PhaseRecord): void {
  record.status = 'pending';
  record.note = undefined;
  record.endedAt = undefined;
  delete record.preflight;
  delete record.preflightDetail;
  delete record.mcpDegraded;
  delete record.mcpPark;
  delete record.boardingHint;
  record.lockWaitSince = undefined;
  delete record.waitingOn;
  delete record.lockBackoffMs;
  // The stall episode belongs to the attempt being given up on. Kept, it would
  // re-announce itself on the next tick of a lane that has not had time to do
  // anything yet, and its clock would read from before the re-board.
  delete record.stall;
  delete record.idleAttempts;
  delete record.verifyingSince;
  // A new attempt at the work is a new task list. The file behind it is
  // deleted at the next spawn (`armTasksFile`); clearing the fold and its
  // offset together is what keeps the two from disagreeing.
  delete record.tasks;
  delete record.tasksAt;
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
  if (by === 'operator') {
    delete record.stallRemedy;
    delete record.declarations;
    delete record.watchRetired;
    // The wall and the denial the phase last stopped on are the console's
    // evidence about the PREVIOUS attempt; a person asking for the phase from
    // the top has, by pressing, claimed the world has changed (phase 9).
    delete record.cause;
    delete record.toolDenied;
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
  // last week's addendum would be the opposite of that.
  delete record.retryOverride;
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
    const id = /^run-([0-9a-f]{8})\.json$/.exec(name)?.[1];
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
      removed.push(candidate.id);
      survivors--;
    } catch { /* a file we cannot remove is retried next sweep */ }
  }
  return removed;
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

/** Is this run one of the ones something is actually driving? */
export function isLive(id: string, live: LiveRuns): boolean {
  if (!live) return false;
  return typeof live === 'string' ? live === id : live.has(id);
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
function runIsOver(state: RunState): boolean {
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
    delete record.parkedUntil;
    record.resumeSessionId ??= record.sessionId;
    sink(WAIT_SETTLED_EVENT, { ...settlement }, record.phase);
    settled.push(settlement);
  }
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
 * something to write.
 */
export function reconcileRun(state: RunState, liveRunId?: LiveRuns): boolean {
  if (isLive(state.id, liveRunId)) return false;
  if (!IN_FLIGHT.includes(state.status)) return false;

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
    const advice = orphanAdvice(state, alive, 'continue this run');
    state.status = 'parked';
    // The same shape `Runner.adopt` writes for the same fact — ONE orphan
    // kind, so the recovery model and the situation classifier read the two
    // paths identically (the read-path one used to be kindless), and now ONE
    // composer, so the two cannot describe it differently either.
    state.halt ??= { at, kind: 'orphaned-session', reason: advice.reason, phase: advice.phase };
    state.stoppedBy = 'system';
    return true;
  }

  // A run asleep on a usage window is the one in-flight state whose "why" IS
  // recorded: `waitUntil` says exactly when it meant to continue. Flattening
  // it to `interrupted` — which this function did — threw that away, and a
  // console restart during a long window turned a self-resuming run into one
  // waiting for a person. It reconciles to `paused` with the clock intact;
  // whether anything re-arms the wait is the service's boot decision
  // (`readoptIdle`), not this function's — reconcile preserves facts.
  if (state.status === 'waiting' && state.waitUntil) {
    state.status = 'paused';
    state.child = null;
    delete state.children;
    state.pause = null;
    state.freeze = null;
    // Two kinds of run-level wait share the clock: the usage window, and a
    // park on external work some phase declared. `waitReason` says which; the
    // record scan behind it is only the answer for runs written before that
    // field. The boot re-arm (`Service.readoptQueued`) makes the same read.
    const parked = waitReasonOf(state) === 'external';
    state.finishedReason ??= parked
      ? `waiting on external work — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now, or leave it to re-arm.'
      : `usage limit — this run meant to resume at ${state.waitUntil}. `
        + 'Continue now under another account, or leave it to re-arm.';
    for (const record of Object.values(state.phases)) {
      if (!PHASE_IN_FLIGHT.includes(record.status)) continue;
      record.status = 'pending';
      record.resumeSessionId ??= record.sessionId;
    }
    state.stoppedBy = 'system';
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
  state.status = state.status === 'halting' ? 'halted' : 'interrupted';
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
): { changed: boolean; closed: number[] } {
  const closed: number[] = [];
  // Hoisted: `childrenOf` rebuilds an array, and this loop runs per record on a
  // read path. The probe it feeds is the cached, non-blocking one; the
  // allocation was the only per-record cost worth removing.
  const children = childrenOf(state);
  for (const record of Object.values(state.phases)) {
    if (!RECONCILABLE.includes(record.status)) continue;
    if (board[record.phase] !== 'done') continue;
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
    if (record.status === 'failed' && isAdjudicatedHalt(record.halt?.kind)) continue;
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
    record.note = 'closed outside this run (the board reads done)';
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
  if (closed.length && state.halt?.phase != null && closed.includes(state.halt.phase)) {
    // The story moves with the halt: `finishedReason` kept quoting the dead
    // blocker ("phase 7 declared itself blocked…") while the phase list read
    // done — the exact contradiction an operator reported. History lives in
    // the journal; the headline tells the truth as of now.
    state.finishedReason = `halted on phase ${state.halt.phase}; the board has since closed it — `
      + 'nothing is left of the halt';
    state.halt = null;
    state.consecutiveFailures = 0;
  }
  // The same dissolve at the PHASE level, for every record the board closed —
  // not just the one the run's halt happened to be anchored to. A phase the
  // board reads done has no ending left to describe.
  for (const phase of closed) retirePhaseHalt(state.phases[String(phase)]);
  return { changed: closed.length > 0, closed };
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
  const words = Object.values(board);
  if (!words.length) return false;
  if (words.every((word) => word === 'done')) {
    state.status = 'finished';
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
    state.status = 'parked';
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
  const live = isLive(state.id, liveRunId);
  // A run that lost its clock gets the record's BEFORE `reconcileRun` reads the
  // run — see `rearmWaitClock`. Never for a live run: the loop owns its clock.
  const rearmed = live ? null : rearmWaitClock(state);
  // A stamp written as one string before it was a set (RCV-8) reads as a set.
  const folded = foldLegacyWatchStamps(state);
  const reclaimed = reconcileRun(state, liveRunId);
  // A kindless legacy halt gets its word before anything reads it (LFC-1).
  const healed = healLegacyHalt(state);
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
  if (!reclaimed && !settled.length && !healed && !rearmed && !waits.length && !folded) return state;
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

export function loadRun(root: string, slug: string, id: string, liveRunId?: LiveRuns): RunState | null {
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
  try {
    return settle(JSON.parse(readFileSync(target, 'utf8')) as RunState, liveRunId);
  } catch {
    return null;
  }
}

/** Every run recorded for a plan, newest first. */
export function listRuns(root: string, slug: string, liveRunId?: LiveRuns): RunState[] {
  const dir = runDir(root, slug);
  if (!existsSync(dir)) return [];
  const runs: RunState[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^run-([0-9a-f]{8})\.json$/.exec(name)?.[1];
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
export function latestRun(root: string, slug: string, liveRunId?: LiveRuns): RunState | null {
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
