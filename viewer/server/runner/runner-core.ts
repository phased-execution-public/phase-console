/**
 * `runner`: the module prologue — types, constants and pure helpers.
 *
 * A LEAF by design. The class this file serves is split across an `extends`
 * chain, and every link in that chain needs these declarations; if they had
 * stayed in the file holding the final class, each link would import its own
 * descendant and the cycle would be immediate. Nothing here imports a chunk,
 * so nothing here can close a loop.
 *
 * Re-exported by `runner.ts` under the names it always had, so no importer
 * outside this folder is affected by the split.
 */

import type { OccupiedTree } from './worktree.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { RECOVERY_CLASSES } from '../../shared/recovery-model.js';
import { QA_FIX_STRATEGIES, type QaFixStrategy } from '../../shared/run-settings.js';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import type { ReviewerFacts, ReviewerReport, ReviewerVerdictPolicy } from '../reviewer.ts';
import {
  classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import { markFor, spawnClaude, type SpawnFn, type SpawnHandle, type StreamEvent } from './spawn.ts';
import { killLadder, stopWhereItStands, wake } from './signals.ts';
import {
  FREEZE_ESCALATE_MS, checkpointFrozenRecord, escalatePersistedFreeze, freezeVerdict,
  type PersistedEscalation,
} from './freeze.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './verify.ts';
import { loadVerifyEnv, type VerifyEnv } from './verify-env.ts';
import {
  failureContext, resumeBrief, resumeInstruction, unblockBrief, type BriefFacts,
} from './failure-context.ts';
import {
  applyEvent, evaluateStall, isProductiveEvent, livenessOf, newLaneSignals, stallThresholds,
  type LaneLiveness, type LaneSignals, type StallState, type StallThresholds,
} from './liveness.ts';
import { ingestRulings, rulingsFile, type Ruling } from './rulings.ts';
import {
  classifySituation, collectEvidence, situation as situationOf, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './situation.ts';
import {
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord } from './state.ts';
import {
  childrenOf, loadRun, newRun, phaseRecord, procIdentity, saveRun, pidAlive, processState, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope } from '../../shared/scope.js';
import { DEFAULT_PRIORITY, type RunPriority } from '../../shared/orchestration-model.js';
import {
  DEFAULT_SETTLE, ISOLATED, SETTLE_PUSHES, settleOf,
  type IsolationMode, type IsolationReclaim, type SettleStrategy,
  type WorktreeRoot,
} from '../../shared/worktree-model.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import type { Presence } from '../../shared/run-lifecycle.js';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import type {
  GitMode, PhaseLifecycle, PhaseLifecycleState, ReviewerPolicy, UltraReviewMode,
} from '../../shared/run-lifecycle.js';
import { phaseLifecycle } from '../../shared/run-lifecycle.js';


export type RunnerEvent = (event: string, data: Record<string, unknown>) => void;

/**
 * Recognises the three park sentences `preflightVerification` writes. The
 * drive loop's halt matches record notes against this to name the right
 * remedy and to mark an all-verification halt machine-recoverable; the
 * service's recovery write-back uses the same test to know which parked
 * records a plan repair may reset. Lives beside the code that writes those
 * sentences: change one, change both.
 */
export const VERIFICATION_PARK_NOTE = /§Verification|states no verification/;

/**
 * Recognises the park sentences `preflightMcp` writes, so the halt can name the
 * right remedy and the recovery classifier can pick between "sign it in" and
 * "it is not registered". Lives beside the code that writes those sentences:
 * change one, change both.
 */
export const MCP_PARK_NOTE = /MCP server/;
/** The half of those that a person fixes by signing in, rather than by editing. */
export const MCP_AUTH_PARK_NOTE = /needs authentication/;

/**
 * Recognises the sentence the two-hour lock-wait cap writes, so the halt can
 * say that a Retry restarts the wait. Same rule as the two above: it lives
 * beside the code that writes it.
 */
// `locked by` when a lock holds the phase, `held by` when a grant or a
// reservation does (D2 armed the cap for those too, and "locked" would be the
// wrong word for a sibling lane's grant). Both admission and the belt-check
// write one of the two, and `rearmLockCapParks` recognises a park by this.
export const LOCK_CAP_PARK_NOTE = /is (?:locked|held) by .* and has waited/;

/**
 * The subset of those parks a LOCK caused — the only ones `rearmLockCapParks`
 * may act on, because the only question it can ask is
 * `phase-lock.sh status`, and that script knows nothing about grants.
 *
 * D2 armed the cap for `grant` and `reserved` blockers as well, so a park can
 * now be caused by a sibling lane that hangs. Asking the lock script about one
 * of those answers `free` — truthfully, there is no lock — and the re-arm
 * would clear the park, restart the phase, find the grant still held, and park
 * again with the clock reset: a spin at boarding speed, which is exactly the
 * failure the backoff and the cap exist to prevent. A grant park therefore
 * waits for a deliberate Retry (which resets the clock, as it should).
 */
export const LOCK_CAP_PARK_BY_LOCK = /is locked by .* and has waited/;

/**
 * The OTHER subset a re-arm may act on: a park the live-session CAP caused.
 *
 * D28 made the cap an honest holder, so a phase can now be parked for having
 * waited two hours on a full fleet rather than on anybody's claim. That park
 * had no way back — it is not `BY_LOCK`, so neither re-arm reader would touch
 * it — and a console running three long lanes therefore stranded every fourth
 * phase until a person pressed Retry, for a fleet that was merely BUSY rather
 * than wedged. Busy is the ordinary case; wedged is the one D28 was written
 * about, and they share this path.
 *
 * It is safe to re-arm where a GRANT park is not, and that difference is why
 * this is a second predicate rather than a widening of `LOCK_CAP_PARK_NOTE`:
 * "has the blocker gone?" is answerable here. A grant park can only ask
 * `phase-lock.sh status`, which knows nothing about grants and answers `free`
 * about one, so clearing it would spin. The cap's question is "does the fleet
 * have a free lane?", which the scheduler answers exactly — and a reader with
 * no answer to hand does not re-arm at all.
 *
 * Matched against the sentence `RunnerControl.admit` writes for a `reserved`
 * holder named `session cap`: *phase N is held by 3 of 3 lanes (session cap)
 * and has waited …*. `BY_LOCK` and this one are disjoint by construction —
 * `locked by` versus `held by` — so no park is ever both.
 */
export const LOCK_CAP_PARK_BY_CAP = /is held by .* \(session cap\) and has waited/;

/**
 * What one phase's MCP servers came to, decided once at boarding.
 *
 * `usable` is the set that gets a `--mcp-config`; `degraded` is what it asked
 * for and did not get; `park` is non-null only under `require`. `strict` is the
 * narrow case where every requested server was lost — see `resolveMcp`.
 */
export type McpResolution = {
  usable: string[];
  degraded: McpDegradation[];
  park: string | null;
  strict: boolean;
};

export type RunnerDeps = {
  scriptsDir: string;
  /** Injectable so the loop can be tested without spending money on a model. */
  spawn?: SpawnFn;
  verify?: typeof verifyPhase;
  /** The plan's `**Verification:**` text for a phase, from the service's store. */
  verificationText: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /**
   * The phase's `- **Setup:**` bullet, raw — bring-up run before the
   * verification commands and never part of the verdict (`verify.ts`
   * `runSetup`). Optional: a plan that declares no Setup, and a harness
   * built before the bullet existed, both simply have none.
   */
  setupText?: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /**
   * Whether the phase's raw plan block DECLARES a Verification bullet at all —
   * regardless of what the parser made of it. Separates two park messages that
   * used to be one: "the plan states no verification" was also shown for a
   * plan that stated it in a shape the parser lost, and the operator went
   * looking for a bug in their plan instead of ours.
   */
  verificationDeclared?: (slug: string, phase: number) => Promise<boolean> | boolean;
  /**
   * The plan's `**Verify in:**` path for a phase — where those commands mean to
   * be run, relative to the run's root. Read from the same store and for the
   * same reason: the plan is the only thing that knows.
   */
  verifyIn?: (slug: string, phase: number) => Promise<string | undefined> | string | undefined;
  /**
   * The phase's Repos cell, as tokens. Used only to SUGGEST a `Verify in:` when
   * a verification fails and the plan already says which repo the phase is
   * about — never to choose a directory. See `verifyHint`.
   */
  phaseRepos?: (slug: string, phase: number) => Promise<string[] | undefined> | string[] | undefined;
  /**
   * Admission control. Without one, every phase runs the moment it is ready —
   * which is exactly what this runner did before lanes existed, and is the
   * right behaviour for a test harness that is not exercising concurrency.
   */
  scheduler?: Scheduler;
  /**
   * Is the whole console frozen? The same predicate the Scheduler and the
   * convergence loop ask, handed to the runner for the one auto-start it owns
   * that neither of those two can see: the park poke, which wakes this run's
   * own drive loop when a `waiting-external` window elapses.
   *
   * Absent means never frozen — the right answer for a harness that is not
   * exercising it, and the behaviour before this existed.
   */
  fleetHold?: () => { at: string; by?: string } | null | undefined;
  /**
   * The phase's scope tokens, from the plan's Repos column. What the scheduler
   * admits against, and what the child is told it holds (`PE_SCOPE`).
   *
   * Distinct from `phaseRepos`, which is a repo-NAME view used only to suggest
   * a `Verify in:`. Same cell, two readings, and conflating them would make a
   * cosmetic hint load-bearing for concurrency.
   */
  phaseScope?: (slug: string, phase: number) => Promise<string[] | undefined> | string[] | undefined;
  /** Lanes this run may fill at once. The scheduler still enforces the global cap. */
  maxParallel?: number | (() => number);
  /**
   * The plan's own `**Model:**` / `**Effort:**` bullets for a phase.
   *
   * The plan format has allowed a per-phase model override for as long as there
   * has been a plan format, and the runner ignored it completely — so a plan
   * that said "this phase wants Opus" ran on whatever the run defaulted to and
   * nobody was told. Read from the store, exactly as the verification text is,
   * because the plan is the source for what a phase needs.
   */
  phaseDefaults?: (slug: string, phase: number) => { model?: string; effort?: string } | undefined;
  /**
   * The MCP servers the PLAN says a phase needs — its §Session budget line
   * unioned with the phase's own `**MCP:**` bullet, as `phase-graph.sh --mcp N`
   * computes it. Read from the engine for the same reason `phaseDefaults` is
   * read from the store: the plan is the source for what a phase needs, and a
   * console-side re-derivation would be a second parser to keep in step.
   */
  planMcp?: (slug: string, phase: number) => string[];
  /**
   * What the PLAN says a phase should do when one of its servers is
   * unreachable — its per-phase `**MCP policy:**` bullet, else the
   * §Session budget line. Read from the store for the same reason `planMcp`
   * is: the plan is the durable statement about what the work needs.
   *
   * Absent (no plan, no bullet) means the plan has no opinion, and the run's
   * own setting answers. See `mcpPolicyFor`.
   */
  planMcpPolicy?: (slug: string, phase: number) => McpPolicy | undefined;
  /**
   * A phase boarded without servers it asked for. Told to the service so it
   * can announce it once — the runner has no notification vocabulary of its
   * own, and a degraded phase that only reaches the journal is a degraded
   * phase nobody hears about.
   */
  onMcpDegraded?: (state: RunState, phase: number, degraded: McpDegradation[]) => void;
  /**
   * Resolve a phase's server set into a `--mcp-config` file, and check it can
   * actually connect before the phase boards.
   *
   * Both are one dependency because they must agree: the set that is probed has
   * to be the set that is passed, or the preflight is answering about something
   * else. Absent in harnesses that are not exercising MCP, in which case a run
   * attaches nothing and behaves exactly as it did before this existed.
   */
  mcp?: {
    preflight: (ids: string[], cwd: string) => Promise<{
      ok: boolean;
      blocking: { id: string; status: string; error?: { message: string } }[];
      unknown: string[];
      disabled: string[];
      probeError?: string;
    }>;
    configFor: (runId: string, phase: number, ids: string[]) => Promise<string | null>;
  };
  /**
   * The plan's own `**Branch:**` prose from §Session budget, verbatim. Read
   * only to WARN: when a run's console-set git strategy contradicts a branch
   * the plan names, the session is told about the discrepancy rather than left
   * to discover two authorities disagreeing mid-commit.
   */
  planBranch?: (slug: string) => string | undefined;
  /**
   * The plan's `- **Worktrees:** on|off` directive from §Session budget.
   *
   * A PLAN directive rather than a run setting: whether two lanes may hold two
   * checkouts of the same repository at once is a property of the work. Absent
   * — the overwhelmingly common case — means OFF, and every lane shares the
   * run's root checkout exactly as it always has.
   */
  planWorktrees?: (slug: string) => 'on' | 'off' | undefined;
  /**
   * Every scope token this plan's phases declare, deduped — the union of the
   * Repos column, read through `scopeOfRow` exactly as admission reads it.
   *
   * The run-checkout preamble's confinement check: a plan whose phases work in
   * a repository the run root does not contain gains nothing from a checkout of
   * the root and would be MISLED by one. Absent means the check cannot be made,
   * which reads as confined — a harness with no store behind it is not a hub.
   */
  planScope?: (slug: string) => string[];
  /**
   * The three lifecycle knobs from Settings ▸ Automation, read fresh so a
   * number changed there applies to the next run rather than the next console.
   * Absent means `WORKTREE_DEFAULTS`.
   */
  worktreePrefs?: () => {
    maxConcurrent?: number; setup?: string; copyEnv?: boolean;
    /** Where the run's trees go: inside the project (`.worktrees/`) or the state directory. */
    root?: WorktreeRoot;
    /** May a run switch a CLEAN checkout off its run branch to take it? */
    reclaim?: IsolationReclaim;
    /** Delete `pe/*` branches once their pull request has MERGED (`-d` only). */
    deleteMergedBranches?: boolean;
  };
  /**
   * Does any phase of this run ask to leave the run branch?
   *
   * The plan says so with `- **Checkout:** main` (or `master`, or `default`),
   * meaning *do not stand this phase on the run branch* — board it in a
   * checkout DETACHED at the trunk's head.
   *
   * 🔴 Asked as ONE question over the run's phases rather than per phase, and
   * answered from the PARSED PLAN rather than from `state.phases`. Both halves
   * were defects: `ensureRunCheckout` decides one tree for the whole drive, so
   * a per-phase answer has nowhere to go; and `state.phases` is populated
   * lazily by `phaseRecord`, so on a run's first drive it is EMPTY and a
   * bullet would have taken effect only after a phase had already boarded on
   * the branch it asked to avoid.
   *
   * `phases` is the run's `onlyPhases` when it has one, and undefined for a
   * whole-plan run. Synchronous, off the store the Service already holds;
   * absent means no plan ever asks, which is what a harness is.
   */
  detachRequested?: (slug: string, phases?: number[]) => boolean;
  /**
   * How many managed run checkouts this console holds RIGHT NOW, excluding the
   * run asking. The cap is about the machine's disk, and one Runner can only
   * see its own plan — so the console answers, or nobody does (absent means
   * zero, which is true of a harness with no service behind it).
   */
  isolatedCheckouts?: (excludingRunId: string) => number;
  /**
   * Every LIVE claim the run-checkout reclaim must not move under, for a run
   * whose plan touches `scope` — the fourth precondition of `worktree.ts`
   * §`reclaimBranch`: a clean tree a live session is working in must not be
   * switched off the run branch under that session, however clean it reads at
   * the instant it is asked. A lock that wrote `worktree=` names its tree; one
   * that did not (the boot prompt's own claim shape) holds EVERY tree when its
   * scope intersects `scope` — the unqualified-claim doctrine, applied here.
   * Answered by the Service off the lock files themselves (read live, not the
   * watcher-debounced store), through the scheduler's lapse clock and presence
   * answer, so the preflight and the decide read ONE list. Absent means no
   * lock is known, which is true of a harness.
   */
  occupiedTrees?: (scope: readonly string[]) => readonly OccupiedTree[];
  /** The plan's title, for the PR the final phase is asked to open. */
  planTitle?: (slug: string) => string | undefined;
  /** Without one, sessions run on the deny rules alone and nothing can be asked. */
  approvals?: Approvals;
  /** Where the child posts its hook calls, e.g. `http://127.0.0.1:4123`. */
  origin?: string;
  /**
   * What the session streams back. All three cost nothing but volume, and the
   * volume is what makes an unattended phase legible: without `subagentText` a
   * phase that delegates is a silent gap, and without `partialMessages` its
   * words arrive in lumps minutes apart.
   */
  stream?: { partialMessages?: boolean; subagentText?: boolean; hookEvents?: boolean };
  /**
   * The environment that makes a child run AS a given account — a profile's
   * `CLAUDE_CONFIG_DIR`, a token account's `CLAUDE_CODE_OAUTH_TOKEN`, or null
   * for the machine login. Service-provided (`accounts.envFor`); absent in
   * harnesses that are not exercising accounts. Async because a token may live
   * in a keychain, and resolved per spawn so a switch lands on the very next
   * session.
   */
  accountEnv?: (accountId: string | undefined, trustRoots?: string[]) => Promise<NodeJS.ProcessEnv | null>;
  /**
   * The account a limit-hit run should continue under, from cached meters.
   * Null when no other account has headroom. Sync on purpose — consulted
   * mid-phase with nothing worth awaiting.
   */
  pickAccount?: (excluding: string | undefined, forModel?: string) => string | null;
  /** A limit landed: remember it on the account and tell the operator. */
  onAccountLimited?: (accountId: string | undefined, window: string, resetsAt: Date | null, detail: string) => void;
  /**
   * Probe the RUN's account before spending a session on it. Absent, the
   * legacy probe runs — which only ever answers for the machine login.
   */
  checkAuth?: (accountId: string | undefined) => Promise<AuthStatus>;
  /** Copy a session transcript between two accounts' config dirs. See `accounts/transcripts.ts`. */
  portTranscript?: (sessionId: string, fromAccount: string | undefined, toAccount: string | undefined) => boolean;
  onEvent?: RunnerEvent;
  /**
   * The store's parsed handoff for a phase — its status and its Outstanding
   * section — for the situation classifier and the re-board briefs. Absent in
   * harnesses; the board's own word (`stuck` / `in-progress`) still speaks.
   */
  handoffFor?: (slug: string, phase: number) =>
    { exists?: boolean; status?: string; outstanding?: string } | null | undefined;
  /**
   * THE evidence builder — the console's own (`Service.evidenceDeps`).
   *
   * The runner used to build its own set of `EvidenceDeps`, and the two
   * disagreed: the service read the gate LIVE off the engine and knew whether
   * human gates were delegated, the runner read neither; the service derived
   * lock expiry from the lock clock, the runner shelled `phase-lock.sh status`
   * per classification. Same question, two answers, and the console acted on
   * both. `evidenceOf` overlays only what is RUN-local on top of this.
   *
   * Absent in harnesses — then the runner classifies on its run-local facts
   * alone, which is the honest degradation ("a dependency the console lacks
   * stays absent"), not a second implementation.
   */
  evidenceDeps?: (slug: string) => EvidenceDeps;
  /** The ladder's caps (Settings ▸ Automation). Absent = the shipped defaults. */
  ladderCaps?: () => Partial<LadderCaps>;
  /**
   * Every ladder rung this console climbed TODAY, across every run.
   *
   * A dep and not a field, because the per-day cap is the one ladder cap whose
   * denominator a single run cannot see. `ladderPerDayUsd` is a promise about
   * the MACHINE — "do not spend more than this healing things today" — and a
   * runner that counted only its own rungs would let three runs spend the cap
   * three times over. Absent reads as unknown and therefore uncounted, which
   * is `nextRung`'s own convention for `dayHistory`.
   */
  dayHistory?: () => readonly RungRecord[];
  /**
   * Whether ONE bounded unblock session may be spent on a phase whose handoff
   * declares it blocked (the `unblockAttempts` preference). Absent = yes. Off
   * means the errand is written at once — the operator asked to be asked.
   */
  unblockAttempts?: () => boolean;
  /**
   * May a phase whose plan states NO §Verification board and pass on its
   * handoff alone (the `allowUnverifiedPhases` preference)? Absent = no: the
   * preflight parks it with "add a §Verification command, then Retry".
   */
  allowUnverifiedPhases?: () => boolean;
  /**
   * May a `human` gate be briefed to the phase's own session to verify and
   * clear, instead of stopping the run for a person? Absent = no, and that is
   * the right default: the plan author wrote `human`. See
   * `Prefs.delegateHumanGates`.
   */
  delegateHumanGates?: () => boolean;
  /**
   * The dependencies of this phase on which THIS CONSOLE'S operator has
   * requested changes (`review.ts`).
   *
   * A non-empty answer holds the phase exactly as an unapproved gate does. It
   * is deliberately a dep rather than an engine read: `scripts/phase-graph.sh`
   * knows nothing about reviews, and it must not — a verdict given in one
   * console would otherwise silently change what a session booted from a
   * terminal, or a second console on another machine, believes the board says.
   * Absent means no review surface is wired, and nothing is held.
   */
  reviewHold?: (slug: string, phase: number) => number[] | undefined;
  /**
   * Everything the auto reviewer needs, resolved by the Service: the phase's
   * diff, its exit criteria, and where to put what comes back.
   *
   * A dep for the same reason `reviewHold` is one — the runner owns spawning
   * and money, the console owns the plan, the git window and the review store,
   * and neither reaches into the other. Absent means no reviewer can run at
   * all, whatever the run's settings say, which is what makes
   * `reviewEachPhase` safe to persist on a run the console later reopens
   * without a review surface wired.
   */
  reviewer?: {
    facts: (slug: string, phase: number, policy: ReviewerVerdictPolicy) => Promise<ReviewerFacts | null>;
    record: (slug: string, phase: number, report: ReviewerReport) => void;
  };
  /**
   * The resource ladder's knobs (Settings ▸ Automation), read live so a change
   * applies to the next wall rather than the next run. Absent = the shipped
   * defaults: an auth or usage wall switches to an account that can pay, a
   * spent run budget is raised once by 25% (within the ladder's per-run USD
   * cap), a `require` MCP park continues without its servers after 30 min.
   */
  autoAccountSwitch?: () => boolean;
  budgetAutoRaisePct?: () => number;
  mcpRequireTimeoutMs?: () => number;
  /**
   * The ranked list `pickAccount` takes its head from — for the auth
   * preflight, which PROBES each candidate's login before trusting it
   * (headroom says nothing about whether a login still works). Absent, the
   * preflight tries `pickAccount`'s one answer.
   */
  rankAccounts?: (excluding: string | undefined, forModel?: string) => string[];
  /**
   * The child spawner `claude ultrareview` is started through.
   *
   * A test seam and nothing more — absent means `node:child_process`. It exists
   * because the real subcommand is BILLED cloud work: a suite that could only
   * exercise this tier by running it would either never run or cost money every
   * time somebody typed `npm test`.
   */
  ultraReviewSpawn?: typeof import('node:child_process').spawn;
  /**
   * A `require` MCP park timed out and the phase goes ahead without its
   * servers. Told to the service so the operator hears ONCE — the errand is
   * already on the record by the time this fires.
   */
  onMcpRequireTimeout?: (state: RunState, phase: number, result: McpContinueResult) => void;
  /**
   * The session registry's presence for a lock (Phase 5): `ended` means the
   * holder's session is gone — its SessionEnd arrived, or its process is — so
   * the claim is debris, not a queue: the boarding belt-check releases it as
   * the holder and goes on, instead of waiting out a lease nobody holds.
   * Absent: every lock reads `unknown` and lease rules decide, as before.
   */
  lockPresence?: (lock: { slug: string; phase: number; owner: string; session?: string }) => Presence;
  /**
   * Report that a session this runner spawned is alive — and, on a `step`,
   * that it has just finished a turn.
   *
   * The registry's usual writer is the machine-global session hook, and for an
   * autopilot lane it is not there: the run's own `--settings` file carries a
   * `Stop` hook (the nudge at `/hooks/stop`) which displaces the presence hook
   * at `/hooks/session`, so lanes that worked for hours were recorded with
   * `turns: 0`. The stream is the authoritative view of that session and this
   * runner is already reading it, so the fact is fed back rather than inferred
   * a second time. Called per event; the registry does the throttling, because
   * only it knows what a write costs. Absent in harnesses.
   */
  sessionHeartbeat?: (sessionId: string, opts: { turnEnded?: boolean }) => void;
  /** Verification-card answer window override — tests only; defaults to `VERIFY_ANSWER_MS`. */
  verifyAnswerMs?: number;
  /**
   * The MCP registry's enabled ids, for `PE_MCP_SERVERS` on the runner's own
   * engine calls — the same fact `Service.engineOpts` already passes on the
   * service side, threaded here so the runner's `validate.sh` in `confirm()`
   * carries the F15 advisory too instead of silently running without it.
   */
  mcpIds?: () => string[];
  /** Lease keepalive cadence override — tests only; defaults to `LEASE_REFRESH_MS`. */
  leaseRefreshMs?: number;
  /** Minimum park window override — tests only; defaults to one minute. */
  waitFloorMs?: number;
  now?: () => Date;
  /**
   * The console's stall thresholds (`config.ts` prefs), read fresh on every
   * evaluation so a number changed in Settings applies to the lane already
   * running rather than to the next run. Absent means the shipped defaults.
   */
  stallThresholds?: () => Partial<StallThresholds> | undefined;
};

export type StartOptions = {
  slug: string;
  root: string;
  model?: string;
  effort?: string;
  /**
   * QA's own model, effort and failure budget. Absent means what it always
   * meant: the reviewer inherits the builder's model and effort, and the round
   * budget falls back to `DEFAULT_QA_MAX_ROUNDS`.
   */
  qaModel?: string;
  qaEffort?: string;
  qaMaxRounds?: number;
  /** QA recovery's fix strategy and per-round stop — `shared/run-settings.js`. */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  /** Continue this run id instead of creating one. */
  resumeRunId?: string;
  /** Drive only these phases, then finish. Absent means the whole plan. */
  onlyPhases?: number[];
  /** Per-phase model / effort / tools / skills, keyed by phase number. */
  phaseOptions?: Record<string, PhaseOptions>;
  /** Skills every phase invokes, on top of the plan's own. */
  skills?: string[];
  /** MCP servers every phase attaches, on top of the plan's own. */
  mcpServers?: string[];
  /** What a phase does when a server will not connect. Defaults to `continue`. */
  mcpPolicy?: McpPolicy;
  /** How much this run may do unasked. Defaults to `guarded`. */
  permissionProfile?: PermissionProfile;
  /** Lanes this run may fill. Never above the console's own cap. */
  maxParallel?: number;
  /**
   * Halt after this many phases fail in a row. Absent takes `newRun`'s 2.
   *
   * A declared start field (`shared/run-settings.js`) with a control in the
   * launch dialog and a 1-50 check on the route — and, until this line existed,
   * nothing that carried it to the run: the excess-property check on the route
   * literal was the only thing that knew, and no typecheck ran over `server/`.
   */
  maxConsecutiveFailures?: number;
  /** Work on one plan-wide branch instead of what is checked out. */
  gitMode?: GitMode;
  /** New-branch runs only: tell the final phase to push and open a PR. */
  openPr?: boolean;
  /**
   * New-branch runs only: ask for a console-managed checkout of the run's own
   * branch instead of sharing the console's. Absent = the stored preference.
   */
  isolation?: IsolationMode;
  settle?: SettleStrategy;
  /**
   * Which class this run's admissions are scanned in. Absent = keep what the
   * run has (a resume) or `normal` (a fresh run), and deliberately NOT a stored
   * preference: a class is a statement about THIS plan against the others
   * queued beside it, and a machine-wide default for that says nothing.
   */
  priority?: RunPriority;
  /**
   * Board nothing until this other plan's latest run settles. Start-only, and
   * sticky across a resume for the reason `isolation` is: a resume that read it
   * from nowhere would silently drop a chain the operator set.
   */
  startAfter?: string;
  /** Launch a fresh reviewer at each phase-finish. Absent = the stored preference. */
  reviewEachPhase?: boolean;
  /** What EITHER reviewer may record. Absent = the stored preference. */
  reviewerPolicy?: ReviewerPolicy;
  /** Carry the standing `ultracode` licence into this run's prompts. Absent = off. */
  ultracode?: boolean;
  /** When to spend the operator's cloud budget on `claude ultrareview`. Absent = `off`. */
  ultraReview?: UltraReviewMode;
  /** Heal auto-recoverable halts by launching the fix agent. Sticky on resume. */
  autoRecover?: boolean | { attempts?: number };
  /** The account sessions spawn as. Absent/`default` = the machine login. */
  accountId?: string;
  /** What to do at the shared usage window. Absent = `wait`, the old behavior. */
  onLimit?: OnLimitPolicy;
  /**
   * Consumed by the Service before the runner sees the run — `qa` activates the
   * plan's QA gate at start, `attachDefaultSkills` decides whether the machine's
   * default skills are seeded into `skills`. Carried here so route parsing
   * stays one shape; `Runner.start` itself ignores both.
   */
  qa?: boolean;
  attachDefaultSkills?: boolean;
  /**
   * Resume only: re-board these phases by rung. Each record is reset to
   * `pending` with a `boardingHint` — boarding then assembles the named brief
   * — and the loop drives it under normal admission. This is the seam the
   * convergence loop (Phase 3) acts through: one orchestration, never a
   * second. The CALLER accounts the rung (`recoveries[phase].rungs`); the
   * runner journals `phase.reboard-requested` and boards.
   */
  reboard?: ReboardRequest[];
};

/** One re-board asked of `start({resumeRunId, reboard})`. */
export type ReboardRequest = {
  phase: number;
  /** The `id:sub` situation key the rung was chosen for. */
  situation: string;
  /** The rung vehicle (`ladder.ts` `RungVehicle`). */
  rung: string;
  /** Which brief boarding assembles; defaults by rung (`briefForRung`). */
  brief?: BoardingBrief;
  sessionId?: string;
  instruction?: string;
  escalate?: 'model';
  by?: string;
};

/**
 * The FOUR ways to move a stuck phase forward without starting it over.
 *
 * `repair` is the newest and the one that changed what unattended recovery IS.
 * The other three all act on the phase's OWN session — re-check it, close it
 * out, resume it with an instruction — so they were unavailable the moment that
 * session was gone, and the ladder fell through to a `pty` agent: an
 * interactive `claude` with no `--settings` (so no deny wall and no hooks), no
 * journal, no lane, no scope grant, no lease, started in the console's own root
 * rather than the run's tree, and told to "commit to the branch that is already
 * checked out" — which is how sessions came to invent branches and worktrees
 * nobody asked for. `repair` spawns a FRESH `claude -p` inside the run's own
 * frame instead: same settings file, same permission profile, same lane, same
 * grant, same lease, same journal, same account, same `PE_*` channels.
 */
export type RecoverMode = 'recheck' | 'closeout' | 'resume' | 'repair';

/** The recovery classes a `repair` session can be briefed for (shared vocabulary). */
export type RepairClass = (typeof RECOVERY_CLASSES)[number];

export type RecoverOptions = {
  slug: string;
  root: string;
  /** The stored run holding the phase. Recovery never invents a new run. */
  runId: string;
  phase: number;
  mode: RecoverMode;
  /** `resume` only: what the operator wants the session to do differently. */
  instruction?: string;
  /**
   * `repair` only: which briefing the session gets, and the `id:sub` situation
   * key it was chosen for. Both come from the ladder, which already decided
   * them — recomputing either here would be a second opinion about a question
   * that has an owner.
   */
  cls?: RepairClass;
  situation?: string;
  by?: string;
};

/**
 * A repair is a bounded errand, not a phase: read the situation, do the one
 * thing, declare an outcome. Longer than a closeout because a `fix-agent` may
 * legitimately have to run a suite; far shorter than a phase, so a session that
 * misreads the ask and starts building runs out rather than running on.
 */
export const REPAIR_MAX_TURNS = 90;

/** Per phase: one first try, plus room for a model switch, a resume and a retry. */
export const MAX_ATTEMPTS = 4;
/**
 * Per verification command. Half an hour, stated here rather than left to
 * `verify.ts`'s default, because the number is a statement about what a phase's
 * verification IS: a full suite, often a build, sometimes a container. At the
 * old default a slow-but-green check came back red at fifteen minutes and
 * halted a phase that had done nothing wrong.
 */
export const VERIFY_TIMEOUT_MS = 30 * 60_000;
/**
 * How much of a failed command's output rides the LIVE verify stream.
 *
 * Enough to see the assertion that failed, and not so much that a stream event
 * carries a test suite. The whole tail stays on `record.verification.ran[].output`
 * for the attempt-comparison view — this is the glance, not the evidence.
 */
export const VERIFY_TAIL_CHARS = 2_000;
/** Give a stopped session time to run its own SessionEnd hooks before SIGKILL. */
export const SIGTERM_GRACE_MS = 15_000;

/**
 * The ceiling on the shutdown ladder's own wait.
 *
 * The console's shutdown budget is 120 s (`index.ts`) and it has other
 * handlers to drain, so the children must be settled well inside it. Shorter
 * than `SIGTERM_GRACE_MS` would cut a healthy session's SessionEnd hooks short;
 * longer would spend the budget the drain needs.
 */
export const SHUTDOWN_LADDER_MS = 15_000;

/**
 * The recorded children a probe can still find.
 *
 * "The loop ended" and "the children ended" are different facts, and the code
 * used to treat them as one. Every teardown path asks this instead of deleting
 * the map, so a console that is going away leaves behind exactly the handles
 * the next one needs to find what it could not stop.
 */
export function survivingChildren(state: RunState): Record<string, ChildRef> {
  const kept: Record<string, ChildRef> = {};
  for (const [phase, child] of Object.entries(state.children ?? {})) {
    if (processState(child.pid, procIdentity(child)) === 'gone') continue;
    kept[phase] = child;
  }
  return kept;
}
/**
 * How long a "please check this by hand" card waits. Unlike a tool approval
 * there is no hook holding a socket open, and the honest unit for "open the app
 * and look at the gate stack" is hours, not the ten minutes a permission
 * prompt gets.
 */
export const VERIFY_ANSWER_MS = 12 * 60 * 60 * 1_000;

/**
 * A closeout is paperwork: verify, commit, write the handoff, update the index.
 * Generous enough for a phase whose verification is a full suite, tight enough
 * that a session which misreads the ask and starts coding again runs out.
 */
export const CLOSEOUT_MAX_TURNS = 60;

/* ---- the waiting-external park (console-runtime knobs) ----
 * Runner constants, deliberately NOT in scripts/sizing.env: the F5 single-source
 * rule is for numbers both bash and TS read, and bash never reads these. They
 * are documented in viewer/README.md beside the other runtime knobs. */

/** A waiting-external outcome that names no window: check back in half an hour. */
export const WAIT_DEFAULT_MS = 30 * 60_000;
/**
 * How many waiting-external parks one phase may take. A phase that keeps
 * re-filing the same wait is not waiting, it is stuck — the cap turns that
 * into an honest halt instead of an infinite quiet loop.
 */
export const WAIT_MAX_PER_PHASE = 4;
/** Total wall-clock one phase may spend parked, across all its waits. */
export const WAIT_BUDGET_MS = 8 * 60 * 60_000;
/**
 * How long a phase may queue behind a foreign lock before an honest park
 * naming the holder. Bounds the dead-but-unexpired-lock case.
 */
export const LOCK_WAIT_CAP_MS = 2 * 60 * 60_000;
/**
 * The lease keepalive cadence.
 *
 * `refreshLease` states `RUNNER_LEASE_S` (5400 s) on every claim, so eight of
 * these ticks may be missed — a starved event loop, a console paused under a
 * debugger, a machine asleep — before a claim this run is actively holding can
 * lapse and be taken over by anyone. A lapsed lease being takeable is the
 * cooperative design and it is right; it must simply never fire while the
 * holder is alive and working.
 *
 * `phase-lock.sh`'s own default is 7200 s and is a different number for a
 * different population: the sessions a person drives by hand, which have
 * nothing refreshing anything and need a lease longer than a phase.
 */

export const LEASE_REFRESH_MS = 10 * 60_000;
/**
 * The lease the runner STATES on every claim it makes — 90 minutes.
 *
 * 🔴 A literal, not `3 × LEASE_REFRESH_MS`, and the arithmetic is the reason:
 * that expression is 30 MINUTES, and shipping it wrote `--lease 1800` under a
 * comment claiming 5400. Two units in one line is exactly how that happens, so
 * the number lives here in the unit it is used in and the relationship is
 * stated in words instead of computed: at a 10-minute refresh cadence this
 * survives EIGHT missed ticks.
 *
 * 🔴 It must also outlast a phase on its own, because the runner states it on
 * the REFRESH — so the first refresh REPLACES the 2-hour lease the session's
 * own claim took, and whatever is left standing when a console dies is this
 * number, not that one.
 */
export const RUNNER_LEASE_S = 5400;
/**
 * The boarding belt-check's backoff against a foreign lock the scheduler's
 * store-fed view has not caught up with: 1 s, doubling, capped here. The
 * scheduler owns the real wait (it now reads the entry's own lock file live —
 * see `SchedulerDeps.liveLock`); this bounds the re-board rate for a harness
 * or a console whose store is slower than its belt-check, which used to spin
 * three bash subprocesses a second.
 */
export const LOCK_BACKOFF_MAX_MS = 30_000;

/**
 * WHO holds a lock, out of `phase-lock.sh <slug> status <N>`'s first line.
 *
 * The script writes `held by <owner> since <time>, lease until …`, and the
 * owner is whatever the claiming session called itself: `$PE_OWNER`, or
 * `<user>@<host>`, or — for a person driving phases by hand as one of several
 * — a free-form `"Name Surname/laptop"`. `\S+` read that as `Name`, and every
 * comparison downstream is an equality against the string the script wrote, so
 * a spaced owner never matched itself: `holder !== owner` stayed true for its
 * own session, and the belt-check's debris release (which passes the parsed
 * holder straight back to `phase-lock.sh release --owner`) named a holder that
 * does not exist, so the release was refused while the journal recorded that a
 * release had been attempted. The owner is newline-stripped at write, so the
 * line is unambiguous: everything up to the literal ` since ` is the name.
 *
 * The `\S+` reading stays as a fallback for the older one-clause messages
 * (`held by X, not Y`; `(held by X)`) that carry no ` since `.
 */
export function lockStatusHolder(stdout: string): string | undefined {
  return /held by (.+?) since /.exec(stdout)?.[1]
    ?? /held by (\S+)/.exec(stdout)?.[1];
}

/**
 * The LIFECYCLE state the drive loop's own ladder pass classifies. `interrupted`
 * and `failed` used to be SETTLED full stop — a resumed run whose only open
 * record was one of them parked at once, and the only way forward was a press.
 * `pending` joins the list ONLY for phases the board reads `stuck` or
 * `in-progress` (a handoff exists and is not complete): a ready+pending phase
 * is an ordinary candidate and needs no classification.
 *
 * 🔑 **One word since 3.5.0, and the collapse is the point.** This was
 * `['interrupted', 'failed']` — two status words for one situation, kept apart
 * only because the status could not say WHY a phase failed. The lifecycle
 * folds `interrupted` into `failed` and moves the distinction to
 * `lifecycle.stop.kind` (`interrupted` · `verification` · `ladder`), so the
 * list says what it always meant: **the ladder classifies a failed phase.**
 * Ask it of `phaseLifecycle(record).state`, never of `record.status` — the
 * status word `interrupted` is still written and is no longer a member.
 */
export const LADDER_STATES: readonly PhaseLifecycleState[] = ['failed'];

/**
 * Does the ladder classify this record?
 *
 * 🔑 **Derived from the STATUS WORD, never from a stored `lifecycle`.** The
 * word is what every writer sets — including the ~117 bare assignments this
 * release did not convert — so it is the field that is never stale. The stored
 * lifecycle is the derived one, synced at `saveRun`/`settle`, and between a
 * bare `record.status = 'failed'` and the save that follows it there is a
 * window where it still describes the status before. Reading it here would
 * have made that window mean "the ladder does not classify this phase", which
 * is a phase the autopilot silently stops trying to heal — strictly worse than
 * the two-word list this replaced.
 */
export function ladderClassifies(record: { status?: string }): boolean {
  return LADDER_STATES.includes(phaseLifecycle({ status: record.status }).state);
}

/**
 * The in-flight record statuses a teardown inside this process settles itself.
 *
 * `awaiting-verification` is absent on purpose: `settleAwaitingVerification`
 * owns it, and deliberately leaves it standing on a console with no approvals
 * broker — there was no way to ask, so the claim is honest rather than a
 * phantom. The READ path settles the full `PHASE_IN_FLIGHT`, which is why an
 * `awaiting-verification` record still closes once the run is loaded again.
 */
export const TEARDOWN_SETTLES: readonly PhaseStatus[] = ['running', 'verifying'];

/** The default brief for a rung, when a `start({reboard})` caller names none. */
export function briefForRung(rung: string, hasSession: boolean): BoardingBrief {
  switch (rung) {
    case 'reboard-resume-brief': return 'resume';
    case 'resume-own-session': return hasSession ? 'continue' : 'resume';
    case 'unblock-session': return 'unblock';
    case 'closeout-own-session': return hasSession ? 'closeout' : 'resume';
    default: return 'fresh';
  }
}

/**
 * One step UP the model chain for an `escalate: model` rung — the reverse of
 * `nextModel`, which demotes. Null at the top (or for a model the chain does
 * not know); the CLI's own in-process fallback still applies on the way down.
 */
export function escalateModel(model?: string): string | null {
  if (!model) return null;
  const short = MODEL_FALLBACK.find((m) => model.includes(m));
  if (!short) return null;
  const index = MODEL_FALLBACK.indexOf(short);
  return index > 0 ? MODEL_FALLBACK[index - 1] : null;
}

/** The instruction a `fix-verification` continue carries (situation verify-red). */
export function fixVerificationInstruction(phase: number): string {
  return [
    `Phase ${phase}'s §Verification is RED. Read the failing command(s) and their output below, fix the`,
    'cause, re-run the verification until it is green, then commit with explicit paths and write the',
    'handoff `complete`. Read `git status` and `git diff` FIRST — anything uncommitted is your own',
    'earlier work; never stash, checkout or reset it away.',
  ].join('\n');
}

/**
 * The operator's own words for one attempt, framed so the session knows whose
 * they are.
 *
 * The frame is the whole point. Dropped into the prompt unlabelled, an
 * addendum reads as one more paragraph of console boilerplate and gets the
 * weight of boilerplate; labelled as a person's instruction for THIS attempt,
 * it reads as what it is — the most recent and most specific thing anyone has
 * said about this phase. It is quoted verbatim and never summarised: the
 * console paraphrasing a human instruction would be the console inventing one.
 */
export function retryAddendumBlock(addendum: string): string {
  return [
    'THE OPERATOR RE-BOARDED THIS PHASE WITH AN INSTRUCTION FOR THIS ATTEMPT:',
    '',
    addendum.trim(),
    '',
    'It is about this attempt only — it is not in the plan, and nothing outside this session',
    'has read it. Where it disagrees with the boot prompt above, it is the more recent word;',
    'where it is silent, the plan still governs.',
  ].join('\n');
}

/**
 * Does THIS phase's prompt carry the standing `ultracode` licence?
 *
 * The phase's own answer beats the run's, in both directions and by design —
 * an operator marking one phase "fan out here" on an ordinary run, and one
 * phase "not here" on an ultracode run, are making the same kind of decision
 * and neither should have to reach for the other lever. Silence at the phase
 * level inherits the run; silence at both is off, which is the only default a
 * feature that spends dozens of agents' worth of tokens may have.
 *
 * Exported and tiny on purpose: it is the sentence `test/ultra-tiers.test.ts`
 * asserts, and a resolution rule written inline at its one call site is a rule
 * nothing can test without composing a whole prompt.
 */
export function ultracodeOn(
  state: { ultracode?: boolean } | null | undefined,
  phaseOptions: { ultracode?: boolean } | null | undefined,
): boolean {
  return phaseOptions?.ultracode ?? state?.ultracode ?? false;
}

/**
 * The contract an unattended session cannot be assumed to infer, stated where
 * it cannot be missed. Appended by the RUNNER (never woven into the engine's
 * text) to every boot, closeout and wait-resume prompt, because it is true
 * only under a supervisor: an interactive session may simply keep its turn
 * and wait, and telling it otherwise would be wrong.
 *
 * Born from a live transcript: a phase-8 session did 47 minutes of real work,
 * then called `ScheduleWakeup` and backgrounded two `gh` watchers and ended
 * its turn — all three void under `claude -p`, where the process exits on the
 * turn result and background tasks die seconds later. The exit read `success`;
 * the board read `ready`; the run halted.
 */
export function unattendedDirective(scriptsDir: string, slug: string, phase: number): string {
  return [
    '',
    '',
    'UNATTENDED SESSION CONTRACT (you are running under a supervisor, non-interactively):',
    '- The process EXITS when your turn ends. ScheduleWakeup, Monitor, and backgrounded',
    '  watcher loops do not survive it — never end your turn expecting to be woken.',
    '- Your deliverable is the handoff. A phase with no handoff does not exist to the board,',
    '  and a clean exit without one reads as a failed phase.',
    '- If the work cannot finish because an EXTERNAL process must complete first (a CI build,',
    '  a PR auto-merge, a deploy window): commit what is done, write the handoff now with',
    '  `status: in-progress` (the durable pause marker), then declare the wait and stop:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} waiting-external \\`,
    '        --wait-minutes <realistic-window> --reason "<what you are waiting on>" --watch <ref>',
    '  The supervisor parks the phase and RESUMES THIS SESSION when the window elapses.',
    '- Blocked on a lock or scope conflict? Do not wait for a user reply that cannot come:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} blocked --reason "lock held by <owner>" --watch lock:${slug}/${phase}`,
    '  then stop; the supervisor queues the retry for when the lock frees.',
    '- Need a person (an MCP sign-in, a manual gate, credentials)? Declare it and stop:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} needs-human --reason "<what and why>"`,
    '- Must stop with WORK STILL LEFT (your budget or context is nearly spent)? Commit what is done,',
    '  write the handoff `in-progress`, then declare it so the supervisor RESUMES you instead of',
    '  reading a failed phase:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} partial --reason <budget|context|other>`,
    '- Made a judgement call the plan did not make for you — read an ambiguous instruction one way,',
    '  departed from what the plan said, or deliberately left something for later? RECORD IT. It costs',
    '  one line, nothing acts on it, and it is the thing the next session most needs and handoffs most',
    '  often omit:',
    `      bash ${scriptsDir}/phase-outcome.sh ${slug} ${phase} ruling --kind ambiguity|deviation|deferral \\`,
    '        --what "<what you decided>" --why "<why>" [--cost-if-wrong "<what it costs if this was wrong>"]',
    '  It is not an outcome and it never ends your turn; declare the outcome as well.',
    '- Never end the turn silently waiting. Declare an outcome or finish the closeout.',
    '  Ending your turn with words like "waiting for the build" and NO declared outcome',
    '  reads as a FAILED phase and stops the run.',
    '- The supervisor re-runs §Verification itself in plain bash and SKIPS (records, never',
    '  fails) any command whose binary does not exist on this machine — if your',
    '  §Verification depends on rg/python, verify with what exists and note it in the handoff.',
  ].join('\n');
}

/**
 * What the runner says when a waiting-external park's window elapses and the
 * board still does not read done. Resumes the SAME session — its context is
 * the whole point — and keeps the escape hatch open: an external process that
 * genuinely needs longer gets a re-filed wait, not a lie.
 */
export function waitResumePrompt(slug: string, phase: number, reason?: string, watch?: string[]): string {
  return [
    `The wait window you declared for phase ${phase} of \`${slug}\` has elapsed`
      + `${reason ? ` (you were waiting on: ${reason})` : ''}.`,
    ...(watch?.length ? [`You were watching: ${watch.join(', ')}.`] : []),
    '',
    'Pick up the closeout:',
    '',
    '1. Re-check the external process(es). If they finished, run the plan\'s §Verification',
    '   commands, commit, and write the handoff `complete` (red verification → handoff',
    '   `blocked` with the failure recorded — never `complete` on red).',
    `2. If they are STILL not finished, re-file the wait with a realistic window —`,
    `   \`bash scripts/phase-outcome.sh ${slug} ${phase} waiting-external --wait-minutes <M> --reason "…"\` —`,
    '   and stop. Do not sit in the turn waiting.',
    '3. If they failed, write the handoff `blocked` recording exactly what failed.',
    '',
    'Do not start new work. Never end the turn without a handoff or a declared outcome.',
  ].join('\n');
}

/** A promise the drive loop can be woken through, re-armed after every fire. */
export function wakeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * What the runner says to a session that finished its work and stopped short of
 * recording it.
 *
 * This is `SKILL.md` §Mode 3 steps 1–4 and nothing else. The two constraints
 * that matter are both about honesty: it must not start new work (it is being
 * resumed to write down what happened, not to have second thoughts), and it must
 * hand off `blocked` rather than `complete` when verification is red — otherwise
 * the closeout becomes a machine for turning failures into green boards, which
 * is worse than the halt it replaces.
 */
export function closeoutPrompt(slug: string, phase: number, boardState: string, branch?: string): string {
  return [
    `You exited without closing phase ${phase} of \`${slug}\`. The board still reads `
      + `"${boardState}", which means the handoff was never written or is not marked complete.`,
    '',
    'Finish the closeout, and nothing else:',
    '',
    `1. Run the plan's §Phase ${phase} Verification commands.`,
    '2. If any of them is red, write the handoff with status `blocked` and record the failure in it.',
    '   Never write a `complete` handoff on red verification.',
    '3. Commit the changed files with explicit paths (never `git add -A`), in the relevant submodule(s).',
    ...(branch
      ? [`   This run works on the plan's branch \`${branch}\` — commit there (check it out if`,
        '   needed), never on the default branch.']
      : []),
    '   If verification CANNOT finish because an external process must complete first (a CI',
    '   build, a PR auto-merge, a deploy window), write the handoff `in-progress` instead and',
    `   declare the wait — \`bash scripts/phase-outcome.sh ${slug} ${phase} waiting-external`,
    '   --wait-minutes <M> --reason "…"\` — then stop; the supervisor resumes you when it elapses.',
    `4. Run \`scripts/new-handoff.sh ${slug} ${phase} <title> [status]\`, then fill in the frontmatter`,
    '   and the body. Review the generated "Start next phase(s)" section rather than rewriting it.',
    '5. Update `INDEX.md`.',
    '',
    'Do not start new work, do not refactor anything, and do not revisit decisions the phase already',
    'made. If you cannot close it — the work genuinely is not finished, or something blocks you —',
    'write the handoff `blocked` saying exactly what, and stop.',
  ].join('\n');
}

/** A session's closing words, short enough to sit inside a halt reason. */
export function condenseSaid(said: string): string {
  const line = said.replace(/\s+/g, ' ').trim();
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

/**
 * How long a frozen phase may stay frozen before it is checkpointed instead.
 *
 * `SIGSTOP` is the right answer for the minute you need to look at something —
 * it is instant, it loses nothing, and `SIGCONT` picks up mid-token. It is the
 * wrong answer for going to bed: a stopped process holds its memory, its file
 * handles and — the part that actually bites — a prompt cache that expires
 * underneath it anyway, so a session thawed hours later pays for the whole
 * context again and may find the world it was editing has moved.
 *
 * So a freeze held past this converts into the durable form: the child is asked
 * to stop, its `sessionId` is written into the checkpoint, and Continue starts
 * the phase again with `--resume` against that id.
 *
 * The constant itself moved to `freeze.ts` — both halves of the escalation
 * quote it, and the half that runs at boot has no lane table to reach in here
 * for it. Re-exported nowhere: import it from there.
 */

/** How many idempotency keys are worth remembering. Minutes, not hours. */
export const MAX_INJECT_KEYS = 200;

/** What a write to a live session answers with. */
export type AskResult = {
  ok: boolean;
  reason?: string;
  /** Correlates the console's line, the CLI's echo and the session's reply. */
  mark?: string;
  /** This exact message had already been sent; nothing was written again. */
  repeated?: boolean;
};

/**
 * Things worth knowing before spending a session finding them out.
 *
 * ## The check that used to be here, and why it is not
 *
 * This refused to start a run in a workspace whose trust prompt had not been
 * accepted, on the grounds that Claude Code ignores a repository's own
 * `permissions` and hooks until it has been. That was true once. Measured
 * against CLI v2.1.220, in a directory with no trust record at all, it is not:
 *
 *   - a repo `.claude/settings.json` **PreToolUse hook fired**
 *   - a repo `permissions.deny` rule **blocked the command**
 *
 * (`-p` mode skips the trust dialog outright — the CLI's own help says so —
 * and loads the settings anyway.) So the refusal was blocking runs in every
 * repository the operator happened not to have opened interactively, for a
 * reason that had stopped being true, with a message explaining a danger that
 * was not there. A wrong refusal is not the safe side of a guess.
 *
 * The deeper reason it is not needed: this runner passes its own deny rules to
 * every child through `--settings`, at CLI scope. Those are not workspace
 * settings and workspace trust has no bearing on them, so the layer the
 * console actually relies on holds regardless. The repository's own rules are
 * a bonus on top, and now they load too.
 *
 * `preflight` stays as the place for checks that ARE worth a second before a
 * session — it currently has none, and adding a wrong one back would cost more
 * than the empty function does. Returns a reason to refuse, or null.
 */
export function preflight(_root: string, _configFile = join(homedir(), '.claude.json')): string | null {
  return null;
}

/**
 * One phase in flight: its session, its admission, and whether it is stopped.
 *
 * A run used to be one phase at a time, so "the child", "the handle" and "the
 * frozen pid" could each be a single field on the runner. A run may now drive
 * several disjoint-scope phases, and every one of those fields becomes a
 * question that only makes sense per phase — so they live here, keyed by phase
 * number, and the single fields survive as a MIRROR of one lane. See
 * `syncMirror`.
 */
export type Lane = {
  phase: number;
  pid: number | null;
  /**
   * This lane's own git worktree, when the plan opted into worktree lanes and
   * nothing refused (`runner/worktree.ts`). It is the session's cwd and the
   * base its verification resolves `**Verify in:**` against — so a lane with
   * one is genuinely working in a different tree from its siblings, which is
   * the whole feature. Absent on every run that did not opt in, and the code
   * paths then read exactly as they did before it existed.
   */
  worktree?: string;
  /**
   * The branch that worktree is on — `pe/<slug>-p<N>`, from `laneNames`.
   *
   * Set in the same breath as `worktree` and never on its own: a lane without
   * its own checkout commits to the run's branch, and saying so twice would
   * make "which branch is this session on" a question with two answers. It
   * rides into `state.children` so a later console can still name the branch a
   * lane's commits went to after the process that created it is gone.
   */
  branch?: string;
  /**
   * When this lane's process started, stamped once at spawn. The other half of
   * the `(pid, start-time)` tuple that survives into `state.children`, so a
   * later console can tell this child from whatever recycled its pid.
   */
  procStartedAt?: string;
  handle: SpawnHandle | null;
  grant: ScopeGrant | null;
  /**
   * When the operator stopped this session where it stood, and when that
   * expires — or, with `escalateAt` absent, that it never does: the STANDING
   * form a fleet freeze writes. Same shape as the persisted `FreezeRef`, on
   * purpose, because `syncFreezeMirror` copies one into the other.
   */
  frozen: { at: string; by: string; escalateAt?: string } | null;
  /** Armed while this lane is frozen; fires its escalation to a checkpoint. Null for a standing freeze. */
  freezeTimer: NodeJS.Timeout | null;
  /**
   * The operator ended THIS lane only. Consumed by `attempt()` the way
   * `checkpointed` is, but the record settles `interrupted` and the loop
   * carries on — a per-lane stop is aimed at one session, not at the run.
   */
  stopped: { at: string; by: string } | null;
  /** Set when this lane's freeze was escalated, so exit 143 is not read as a crash. */
  checkpointed: boolean;
  /**
   * Why this lane was checkpointed, when it was NOT the freeze escalation:
   * `carryOn: true` tells the settle guard to keep the loop driving (an
   * account switch re-runs the phase immediately) instead of pausing the run
   * the way an escalated freeze does. Null for the freeze path.
   */
  checkpointNote: { carryOn: boolean } | null;
  /**
   * The lease keepalive: refreshes the lane's phase lock every third of its
   * lease while the lane lives, so a 47-minute session never silently loses
   * its 30-minute claim mid-work. Cleared before the lock is released, and
   * stopped the moment a refresh discovers a foreign takeover.
   */
  leaseTimer: NodeJS.Timeout | null;
  /** A refresh is in flight — see `refreshLease` for why overlap is refused. */
  leaseBusy?: boolean;
  /**
   * What the stream has said about this lane so far (`runner/liveness.ts`).
   * Folded in `onStream`, read by the 60-second ticker, and thrown away with
   * the lane — the durable half is `record.liveness` / `record.stall`.
   */
  signals: LaneSignals;
  /**
   * When the tree was last asked about (ms). `git status` and `git log` are
   * two subprocesses per scope directory, and the question they answer — has
   * this phase produced anything at all — does not change per turn, so it is
   * asked on a much slower cadence than the tick.
   */
  gitAt?: number;
  /**
   * The rate-limit evidence this lane has seen SINCE the last time the live
   * wall acted, newest last (ms). The `onLimit` debounce reads it; see
   * `LIMIT_RETRY_BURST`.
   */
  limitHits?: number[];
  /** When the live wall last acted on this lane (ms) — the cooldown's clock. */
  limitActedAt?: number;
  /**
   * What THIS attempt has spent so far, as the CLI's own `result` messages
   * report it — and absent until one arrives.
   *
   * Deliberately not `record.costUsd`, which is the PHASE's cumulative spend
   * and is only added to when an attempt settles. That makes it two wrong
   * answers at once for anything asking about the live session: it is zero for
   * the whole of the first attempt however much is being spent, and non-zero
   * for the whole of every attempt after it however little. The silent
   * watchdog's safety envelope asks exactly that question, so it reads this.
   */
  spentUsd?: number;
  /**
   * Whether the local-job nudge has already been refused on this lane.
   *
   * In memory on purpose: it exists only to stop one journal line repeating
   * every tick while a call stays open, and a console restart re-arming it
   * costs exactly one extra line.
   */
  localNudgeRefused?: boolean;
};

/** How often the liveness ticker evaluates every live lane. */
export const LIVENESS_TICK_MS = 60_000;

/** How often that tick is allowed to spend subprocesses on the working tree. */
export const LIVENESS_GIT_EVERY_MS = 5 * 60_000;

/**
 * How often the branch probe re-reads the repository for a run that has a
 * checkout of its own.
 *
 * Five minutes, matching `LIVENESS_GIT_EVERY_MS`, and for the same reason
 * rather than by coincidence: both are subprocess-per-tick reads of a working
 * tree that only a commit can move, and the events that actually move this one
 * — a lane landing, a phase settling — refresh it directly. The timer is the
 * floor for facts nothing tells us about (another console's run committing to
 * a branch we watch, an operator merging in their own tree), not the mechanism.
 */
export const GIT_PROBE_MS = 5 * 60_000;

/**
 * How long the FIRST probe waits after the drive arms it.
 *
 * Not zero, and not the full five minutes. Arming happens in the drive
 * preamble, one line before the loop admits its first lanes, and a probe there
 * spends half a dozen subprocesses against the spawns — for an answer that is
 * `0 ahead, 0 behind` by construction, because the run branch was created from
 * HEAD moments earlier. Two seconds is past the burst and far inside the
 * window in which anybody opens the page.
 */
export const GIT_FIRST_PROBE_MS = 2_000;

/**
 * What the silent-session watchdog writes into a lane that booted and then
 * said nothing.
 *
 * Fixed text, on purpose. It is sent to a session that has produced no output
 * at all, so there is nothing about its situation to quote back at it and no
 * way to be specific without inventing a fact. The only true things are that
 * it is being supervised, that nothing has been seen from it, and what it
 * should do — which is the same thing the operator typed by hand the one time
 * this was ever recovered.
 *
 * It is framed as a STEER rather than an Ask (`frameSteer`) because it is not
 * a question: an answer would be one more turn of talking from a session whose
 * problem is that it is not working.
 */
export const SILENT_NUDGE =
  'Supervisor check: this session has produced no output at all since it started, so nothing '
  + 'it has done so far is visible to the console. If you are waiting on something, say what. '
  + 'Otherwise begin the phase now — publish your task list with `phase-tasks.sh` and take the '
  + 'first step. If this session is stuck before its first tool call, it will be recycled '
  + 'shortly and resumed from this same session id, so nothing you have thought through is lost.';

/**
 * What the watchdog writes to a session that is waiting inside its own turn on
 * a job it started itself.
 *
 * The same sentence the PreToolUse guard gives when it denies the call before
 * it runs (`Service.decideToolUse`, rule `in-turn-wait`) — one wording for one
 * rule, because a session that meets it twice must not be told two different
 * things. The guard is the cheap half and catches the loop the session is
 * about to open; this is the expensive half, for the loop that was already
 * open when the console got here, or one the session found a spelling for
 * that the vocabulary does not know.
 *
 * A steer, not an Ask, for `SILENT_NUDGE`'s reason: this session is not owed a
 * question, it is owed a way to keep working.
 */
export const LOCAL_JOB_NUDGE =
  'Supervisor check: this session has had a Bash call open for a while waiting on a background '
  + 'job it started itself. That is not a failure — but the wait is inside the turn, so nothing '
  + 'else can happen while it runs and the phase lock stays held. Put the job in the background '
  + '(`run_in_background: true`, or `… > /tmp/x.log 2>&1 &`) and carry on with work that does '
  + 'not depend on it; poll it with a SINGLE bounded check per turn, never a loop. If there is '
  + 'genuinely nothing else to do until it finishes, commit what you have, write the handoff '
  + '`in-progress`, then declare the wait with `phase-outcome.sh <slug> <N> waiting-external '
  + '--wait-minutes <M> --watch cmd:"<a cheap check that succeeds when it is done>"` and stop.';

/* ---- the live wall: `onLimit` applied while the wall is happening ---- */

/**
 * How many rate-limit events inside `LIMIT_RETRY_WINDOW_MS` before the run's
 * `onLimit` policy acts on a session that is still running.
 *
 * Three inside two minutes. The CLI's retry watchdog fires roughly every
 * thirty seconds, so three is a minute of solid wall rather than one unlucky
 * 429 — and a transient blip the watchdog absorbs never reaches it, because a
 * single turn, token or tool call between retries clears the evidence.
 *
 * Deliberately stricter than the `retrying` STALL signal
 * (`STALL_DEFAULTS.stallRetryBurst`, five): that one raises a card, which is
 * cheap and dismissable, while this one ends a live child to move it.
 */
export const LIMIT_RETRY_BURST = 3;

/** The window those hits have to land inside. */
export const LIMIT_RETRY_WINDOW_MS = 120_000;

/**
 * At most one live-wall action per lane per ten minutes.
 *
 * A switch checkpoints the lane and the phase re-boards with a fresh
 * `LaneSignals`, so in the ordinary case the evidence resets by itself. This
 * exists for the window between deciding and the child actually dying — every
 * retry that lands in it would otherwise re-decide — and for the case where
 * the account we moved to is walled too: one move per ten minutes is a ladder,
 * a move per retry is a loop.
 */
export const LIMIT_ACTION_COOLDOWN_MS = 10 * 60_000;


/**
 * The settings an operator may change on a run that has already started.
 *
 * Deliberately a closed set: a general "patch the checkpoint" endpoint would
 * let a browser rewrite `spentUsd`, `phases` or `status`, which are records of
 * what happened rather than choices anyone gets to make.
 */
export type RunSettingsPatch = {
  model?: string;
  effort?: string;
  /**
   * QA's three, mid-run. An operator watching a run burn rounds on one phase
   * must be able to stop THAT without stopping the run; they land on the next
   * QA dispatch, like every other setting that reaches a session at spawn.
   */
  qaModel?: string;
  qaEffort?: string;
  qaMaxRounds?: number;
  /**
   * QA recovery's two, mid-run for the same reason: an operator watching a
   * recovery loop board fresh sessions it should be resuming, or spend more per
   * round than they meant, must be able to change THAT without stopping the
   * run. They land on the next round.
   */
  qaFixStrategy?: QaFixStrategy;
  qaRoundBudgetUsd?: number | null;
  autonomy?: Autonomy;
  phaseBudgetUsd?: number | null;
  runBudgetUsd?: number | null;
  maxConsecutiveFailures?: number;
  onlyPhases?: number[] | null;
  phaseOptions?: Record<string, PhaseOptions> | null;
  skills?: string[] | null;
  /**
   * The run's MCP servers, changeable mid-run. Lands on the NEXT phase: the
   * config file is written per attempt, and the child already running loaded
   * its own at startup and cannot reload it — the same honesty the settings
   * file is documented with.
   */
  mcpServers?: string[] | null;
  /**
   * The run's answer to an unreachable server, changeable mid-run — which is
   * the point. The "Continue without these servers" button on a halt card is
   * this patch plus a Retry, so a run parked at boarding can be released
   * without editing the plan or signing anything in.
   */
  mcpPolicy?: McpPolicy;
  permissionProfile?: PermissionProfile;
  gitMode?: GitMode;
  openPr?: boolean;
  /**
   * Isolation, mid-run, and **one way only**: an isolated run may be dropped
   * back to the shared checkout, never the reverse.
   *
   * The asymmetry is not caution, it is arithmetic. Turning isolation OFF is
   * safe at any moment — the managed tree stops being used and the run carries
   * on where the console is, which is what a `queue` run was always doing.
   * Turning it ON mid-run would have to move a run that already has commits on
   * a branch, in a checkout its live sessions are sitting in, into a tree that
   * does not exist yet; there is no honest moment to do that, and the dishonest
   * version (create the tree, leave the sessions behind) is two agents in one
   * repository — the exact failure this plan exists to remove.
   *
   * So the route refuses `queue → worktree` with a 409 and says to stop the run
   * and start it isolated. Phase 6 acts on the flip; here it is only stored.
   */
  isolation?: IsolationMode;
  settle?: SettleStrategy;
  /**
   * The scan class, mid-run, and unlike isolation it goes BOTH ways.
   *
   * Nothing has to move for a priority change to be honest: it is read at the
   * next `admit()` and the lanes already granted are unaffected. That is the
   * whole difference — isolation is about where a run's commits already are,
   * priority is about which of two waiting runs is looked at first, and only
   * one of those is a fact about the past.
   *
   * `startAfter` is deliberately NOT here. A chain says where a run BEGINS,
   * and a run that has already begun cannot un-begin; a settings patch that
   * accepted one would either do nothing or retroactively unstart the run.
   */
  priority?: RunPriority;
  /**
   * Turn the per-phase auto reviewer on or off mid-run. Lands on the NEXT
   * phase-finish — the reviewer is launched at that moment and there is
   * nothing in flight to reconfigure.
   */
  reviewEachPhase?: boolean;
  /** What EITHER reviewer may record. See `reviewer.ts`. */
  reviewerPolicy?: ReviewerPolicy;
  /**
   * The two ultra opt-ins, changeable mid-run in both directions and for
   * `reviewEachPhase`'s reason: an operator watching a run fan out further —
   * or bill more cloud review — than they meant must be able to stop THAT
   * without stopping the run. `ultracode` lands on the next phase's prompt,
   * `ultraReview` on the next phase-finish.
   */
  ultracode?: boolean;
  ultraReview?: UltraReviewMode;
  /**
   * Translated by the Service before this patch reaches `applySettings`
   * (into a concrete `skills` list); never stored on the run itself.
   */
  attachDefaultSkills?: boolean;
  /**
   * The on-limit policy, changeable mid-run: it is read at the moment a wall
   * is hit, so a flip lands on the very next limit without any checkpoint.
   * (Changing the ACCOUNT mid-run is the `switch-account` verb — that one
   * checkpoints the live session first.)
   */
  onLimit?: OnLimitPolicy;
};

/**
 * Apply a settings patch to a run state. Shared by the live runner and the
 * on-disk path so the two cannot drift — the whole reason Pause was broken is
 * that one of them existed and the other did not.
 */
export function applySettings(state: RunState, patch: RunSettingsPatch): RunState {
  if (patch.model) state.model = patch.model;
  if (patch.effort !== undefined) {
    if (patch.effort) state.effort = patch.effort;
    else delete state.effort;
  }
  // QA's own three, patched exactly like `model`/`effort` above — an empty
  // string is "stop overriding this", which deletes the field and puts the
  // reviewer back on the builder's setting. `qaMaxRounds` has no empty-string
  // form (the door coerces one to `undefined`), so it is set or left alone.
  if (patch.qaModel !== undefined) {
    if (patch.qaModel) state.qaModel = patch.qaModel;
    else delete state.qaModel;
  }
  if (patch.qaEffort !== undefined) {
    if (patch.qaEffort) state.qaEffort = patch.qaEffort;
    else delete state.qaEffort;
  }
  if (patch.qaMaxRounds !== undefined && patch.qaMaxRounds > 0) {
    state.qaMaxRounds = patch.qaMaxRounds;
  }
  // QA recovery's two. The strategy is a closed vocabulary, so anything off it
  // is "stop overriding" and deletes the field — a typo must never be the reason
  // a loop stops resuming and starts paying for fresh sessions. The round budget
  // takes `null` as a real value (`no per-round stop`), which is why it is
  // tested against `undefined` and not truthiness.
  if (patch.qaFixStrategy !== undefined) {
    if (QA_FIX_STRATEGIES.includes(patch.qaFixStrategy)) state.qaFixStrategy = patch.qaFixStrategy;
    else delete state.qaFixStrategy;
  }
  if (patch.qaRoundBudgetUsd !== undefined) {
    if (typeof patch.qaRoundBudgetUsd === 'number' && patch.qaRoundBudgetUsd > 0) {
      state.qaRoundBudgetUsd = patch.qaRoundBudgetUsd;
    } else delete state.qaRoundBudgetUsd;
  }
  if (patch.autonomy) state.autonomy = patch.autonomy;
  // Off is the absent state (`state.ts`), so turning the reviewer off DELETES
  // the field rather than writing `false`. A run file with `reviewEachPhase:
  // false` and one without it must not be two different things to read.
  if (patch.reviewEachPhase !== undefined) {
    if (patch.reviewEachPhase) state.reviewEachPhase = true;
    else delete state.reviewEachPhase;
  }
  if (patch.reviewerPolicy !== undefined) {
    if (patch.reviewerPolicy === 'may-hold') state.reviewerPolicy = 'may-hold';
    else delete state.reviewerPolicy;
  }
  // The same omission convention for both ultra opt-ins: `off` and absent are
  // one state, so turning either off deletes the key rather than writing the
  // word. `off` is spelled in the vocabulary because a person has to be able to
  // CHOOSE it in a form; it is never spelled on disk.
  if (patch.ultracode !== undefined) {
    if (patch.ultracode) state.ultracode = true;
    else delete state.ultracode;
  }
  if (patch.ultraReview !== undefined) {
    if (patch.ultraReview && patch.ultraReview !== 'off') state.ultraReview = patch.ultraReview;
    else delete state.ultraReview;
  }
  if (patch.phaseBudgetUsd !== undefined) state.phaseBudgetUsd = patch.phaseBudgetUsd;
  if (patch.runBudgetUsd !== undefined) state.runBudgetUsd = patch.runBudgetUsd;
  if (patch.maxConsecutiveFailures !== undefined && patch.maxConsecutiveFailures > 0) {
    state.maxConsecutiveFailures = patch.maxConsecutiveFailures;
  }
  if (patch.onlyPhases !== undefined) {
    if (patch.onlyPhases?.length) state.onlyPhases = [...patch.onlyPhases];
    else delete state.onlyPhases;
  }
  if (patch.phaseOptions !== undefined) {
    if (patch.phaseOptions) state.phaseOptions = { ...patch.phaseOptions };
    else delete state.phaseOptions;
  }
  if (patch.skills !== undefined) {
    if (patch.skills?.length) state.skills = [...patch.skills];
    else delete state.skills;
  }
  if (patch.mcpServers !== undefined) {
    if (patch.mcpServers?.length) state.mcpServers = [...patch.mcpServers];
    else delete state.mcpServers;
  }
  // `continue` is stored as an omission, like every other shipped default, so a
  // run switched back to it reads the same as a run that never left it.
  if (patch.mcpPolicy !== undefined) {
    if (patch.mcpPolicy === 'require') state.mcpPolicy = 'require';
    else delete state.mcpPolicy;
  }
  if (patch.permissionProfile) {
    if (patch.permissionProfile === 'guarded') delete state.permissionProfile;
    else state.permissionProfile = patch.permissionProfile;
  }
  if (patch.gitMode) {
    // Default-branch is the absent state on disk (see `newRun`), so switching
    // back is a delete — and takes the PR flag with it, which has no meaning
    // without a branch to open a PR from.
    if (patch.gitMode === 'new-branch') {
      state.gitMode = 'new-branch';
      if (state.openPr === undefined) state.openPr = patch.openPr ?? true;
      // A run given a branch mid-run needs a strategy to settle it with. The
      // patch's own word wins; otherwise the older field decides, through the
      // one function that folds them.
      if (state.settle === undefined) state.settle = patch.settle ?? settleOf(state);
    } else {
      delete state.gitMode;
      delete state.openPr;
      // Settle goes with them, and for the reason isolation does below: a run
      // on the default branch has no branch of its own to settle, so a stored
      // strategy would read as configured and do nothing.
      delete state.settle;
      // Isolation goes with them: a run on the default branch has no branch of
      // its own to check out, so leaving this set would be a stored setting
      // that reads as configured and does nothing.
      delete state.isolation;
    }
  }
  if (patch.openPr !== undefined && state.gitMode === 'new-branch') {
    state.openPr = patch.openPr;
    // …and the strategy moves with it, because the two are one fact stored
    // twice (`newRun`). Only between the two legacy words: a run settling to
    // `integration` whose operator unticks "open a PR" means `keep`, and one
    // that ticks it back means `pr`. Leaving `settle` behind here would make
    // the header say one thing and the settle do another.
    state.settle = patch.openPr ? DEFAULT_SETTLE : 'keep';
  }
  // BOTH ways, unlike isolation below, and with no door refusing a direction:
  // settle governs what happens when the run ENDS, which has not happened yet.
  // `openPr` is kept in step for the same reason `newRun` writes both — one
  // fact, two fields, and a reader that still consults the older one must not
  // be able to disagree with the newer.
  if (patch.settle !== undefined && state.gitMode === 'new-branch') {
    state.settle = patch.settle;
    state.openPr = patch.settle === DEFAULT_SETTLE;
  }
  // ONE WAY, and only down (see `RunSettingsPatch.isolation`). `queue` is the
  // absent state, so dropping isolation is a delete; the reverse is ignored
  // here and refused with a 409 at the route, which is where an operator can
  // be told why. Ignoring it silently in BOTH places would let the on-disk
  // path (`service-runs.ts`) mint an isolation the live runner never made.
  if (patch.isolation !== undefined && patch.isolation !== ISOLATED) delete state.isolation;
  // Both ways, unlike isolation — and `normal` is the absent state, so a run
  // put back to the default class reads the same as one that never left it.
  // Only the three exact words move anything: an unrecognised value has
  // already been dropped at the door, and `runPriority` folding a typo to
  // `normal` here would be a second, quieter way to lose a class the operator
  // set. `undefined` means "you did not say", which is why this tests for it.
  if (patch.priority !== undefined) {
    if (patch.priority === DEFAULT_PRIORITY) delete state.priority;
    else state.priority = patch.priority;
  }
  if (patch.onLimit !== undefined) {
    // `wait` is the absent state on disk, same convention as everything above.
    if (patch.onLimit === 'wait') delete state.onLimit;
    else state.onLimit = patch.onLimit;
  }
  return state;
}

/**
 * Wrap an operator's question so it cannot be mistaken for a new instruction.
 *
 * A phase is mid-task and holds a plan of its own. Text arriving from the user
 * outranks almost everything in that context, so an unframed "why did you skip
 * the cache?" is read as a change of direction. The frame says what this is,
 * asks for brevity, and — the part that matters — says to carry on afterwards.
 *
 * The tag is not decoration either. Going in it is what lets the CLI's own echo
 * be recognised as *this* message rather than by counting echoes, which is
 * wrong on every resumed session. Coming back it is what turns the reply into
 * an answer the console can put beside the question, instead of two sentences
 * lost in the middle of an hour of build output.
 */
export function frameQuestion(question: string, mark: string): string {
  return `${mark} An out-of-band question from the operator watching this run. It is NOT a change to `
    + 'the phase: answer it briefly, in a sentence or two, then continue exactly where you left '
    + 'off. Do not alter your plan, your task list, or what you were about to do — unless the '
    + `question itself explicitly asks you to.\n\nBegin your answer with the tag ${mark} so the `
    + `console can show it beside the question.\n\nQuestion: ${question}`;
}

/**
 * Steer: the other thing an operator wants to say to a running phase, and the
 * opposite of a question.
 *
 * Ask is framed to be inert — "this is NOT a change to the phase" — because a
 * question that quietly redirects the work is worse than no question at all.
 * That framing makes it useless for the case it kept being reached for: seeing
 * a phase head somewhere wrong and wanting to say so. Sending an instruction
 * through the question frame either got politely ignored or, worse, half
 * followed.
 *
 * So this is the honest version, and it says out loud what it costs: the phase
 * still has to satisfy the plan's exit criteria and the runner still verifies
 * it independently afterwards. An instruction that talks a phase out of its
 * verification does not get it past the gate — it just fails later.
 */
export function frameSteer(instruction: string, mark: string): string {
  return `${mark} A course correction from the operator watching this run. Unlike an out-of-band `
    + 'question, this IS an instruction: fold it into what you are doing and carry on. It does not '
    + 'replace the phase — the plan\'s exit criteria and its verification commands still decide '
    + 'whether this phase passes, and they are checked independently after you finish. If this '
    + 'instruction conflicts with the plan, say so in one line and follow the plan.'
    + `\n\nAcknowledge with the tag ${mark} in one sentence, then continue.\n\nInstruction: ${instruction}`;
}

export function reasonOf(disposition: Disposition): string {
  return 'reason' in disposition ? disposition.reason : 'completed';
}

/**
 * Worded for the person who has to fix it. "Authentication failed" describes
 * the machine's experience; what the operator needs is which command, where.
 */
/** The budget wall's default raise, when no preference reaches the runner. */
export const DEFAULT_BUDGET_RAISE_PCT = 25;

/**
 * The PR block — what a session is told when it is the one to publish the
 * work branch. One author, two readers: `gitStrategy` appends it to the
 * plan's last phase, and `openPrFromLastLeaf` hands it to the last leaf's
 * session when two leaves finished together and neither read as last.
 */
export function prBlockText(branch: string, title: string): string {
  return `Opening the pull request — this is the plan's LAST remaining phase. After the\n`
    + `handoff is written and verification is green, in EACH scoped repository where\n`
    + `\`${branch}\` has commits:\n`
    + `  1. Push the branch: git push -u origin ${branch}\n`
    + `  2. Open a PR with \`gh pr create\` — base: the repository's default branch,\n`
    + `     head: ${branch}, title: "${title}", body: a short per-phase summary of\n`
    + `     what this plan changed (from the handoffs).\n`
    + `  3. If a PR for \`${branch}\` already exists, do not open a second one — say so\n`
    + `     instead.\n`
    + `Record each PR URL in the phase handoff. If pushing or \`gh\` is refused or\n`
    + `unavailable, do not look for another route: write the exact commands you would\n`
    + `have run into the handoff and your final message, and finish the phase normally.`;
}

/**
 * The `merge-queue` settle instruction — rebase, re-verify, THEN push.
 *
 * The order is the entire strategy and it is stated as an order the session
 * cannot reasonably read another way. A queue that pushed first and verified
 * afterwards would be a queue that publishes work broken by whatever landed
 * while this run drove, which is the exact failure a merge queue exists to
 * prevent; so the verification stands between the two acts, and a red one ends
 * the session with the branch rebased locally and nothing published.
 *
 * A conflict is NOT something to resolve creatively at 3am with nobody
 * watching: the session is told to abort and say so. The commits are all on the
 * branch either way, and a person untangling a rebase they can see beats a
 * session guessing at one they cannot.
 */
export function mergeQueuePrompt(branch: string, slug: string): string {
  return `Every phase of ${slug} is done, and this run settles through the MERGE QUEUE — so\n`
    + `\`${branch}\` has to be brought up to date and re-proved before it is published.\n`
    + `Your handoff is written; do not reopen the work. In EACH scoped repository where\n`
    + `\`${branch}\` has commits, in this order:\n`
    + `  1. Rebase onto what has landed since: git fetch origin, then\n`
    + `     git rebase origin/<default-branch>. If it CONFLICTS, run git rebase --abort,\n`
    + `     say exactly which files conflicted, and STOP — do not resolve it and do not\n`
    + `     push. Every commit is still on the branch for a person to merge by hand.\n`
    + `  2. Re-run the plan's §End-to-end verification commands. If ANY of them is red,\n`
    + `     STOP and say which one — do not push a branch that does not pass.\n`
    + `  3. Only with the rebase clean AND verification green: git push --force-with-lease\n`
    + `     origin ${branch}. \`--force-with-lease\`, never a plain \`--force\`: the rebase\n`
    + `     rewrote history, and the lease is what refuses to overwrite a commit somebody\n`
    + `     else pushed while you were verifying.\n`
    + `Record what you did — rebased, verified, pushed, or where you stopped — in the phase\n`
    + `handoff and in your final message. If pushing is refused or unavailable, do not look\n`
    + `for another route: write the exact commands you would have run and finish normally.`;
}

export function authRefusal(detail?: string): string {
  return 'Claude Code is not signed in for this console, so every phase would spend a turn '
    + 'and report success without doing anything. Sign in — the Autopilot page has a button '
    + 'that opens a terminal on it, or run `claude auth login` yourself — then start the run again.'
    + (detail ? ` (${detail})` : '');
}

export type { PhaseStatus, RunState, VerifySummary };
