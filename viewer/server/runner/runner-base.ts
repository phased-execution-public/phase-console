/**
 * `RunnerBase` — link 1 of the `Runner` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Runner` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `runner.ts` holds the concrete class.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { detachedRef, worktreeRootOf, WORKTREE_ROOTS, type WorktreeRoot} from '../../shared/worktree-model.js';
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
  isRegistered, laneNames, scopeConfined,
  type LaneNames, type RadarState, type RunGitView,
  managedRoots,
  stagingHome,
  stagingNames,
  worktreeHome,
  type StagingNames,
} from './worktree.ts';
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
  settleInFlightRecords, runDir,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
  consoleRunsDir,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope } from '../../shared/scope.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import type { Runner } from './runner.ts';

export abstract class RunnerBase {
  /** Set while `ensureRunCheckout` is between the cap check and the finished tree. */
  protected abstract reservingCheckout: boolean;
  protected abstract applyReconcile(board: Board): void;
  protected abstract armLeaseTimer(lane: Lane, owner: string): void;
  protected abstract armLivenessTicker(): void;
  protected abstract armParkPoke(phase: number, untilIso: string): void;
  protected abstract askHuman(
    phase: number,
    verification: VerifySummary,
    askable?: VerifySummary['notRun'],
  ): Promise<boolean>;
  protected abstract attempt(phase: number, prompt: string, model: string, owner: string, lane: Lane, chosen?: PhaseOptions, opts?: { maxTurns?: number; mcp?: McpResolution; }): Promise<{ carryOn: boolean; completed: boolean; }>;
  protected abstract board(): Promise<Board>;
  protected abstract boardingBlocked(): 'stopped' | 'halted' | 'pause' | 'frozen' | null;
  protected abstract checkpointForShutdown(): Promise<void>;
  protected abstract clearLeaseTimer(lane: Lane): void;
  protected abstract clearParkPoke(phase: number): void;
  protected abstract climb(record: PhaseRecord, board: Board, by: string, preset?: { situation?: Situation; declared?: PhaseEvidence['declared']; sessionId?: string; }): Promise<boolean>;
  protected abstract climbLadder(board: Board, asked: Set<number> | null): Promise<void>;
  protected abstract composeBrief(phase: number, board: Board, hint: BoardingHint, engineText: string): Promise<{ prompt: string; brief: BoardingBrief; resume?: string; maxTurns?: number; degraded?: string; }>;
  protected abstract confirmed(phase: number): Promise<boolean>;
  protected abstract disarmLivenessTicker(): void;
  protected abstract syncGitProbe(): void;
  protected abstract disarmGitProbe(): void;
  abstract refreshGit(): Promise<boolean>;
  protected abstract drive(): Promise<void>;
  protected abstract emit(event: string, data: Record<string, unknown>): void;
  protected abstract engine(args: string[], env?: Record<string, string>): Promise<import("../engine.ts").EngineResult>;
  protected abstract enterRunWaiting(nowIso: string, asked?: Set<number> | null): boolean;
  protected abstract evaluateLane(lane: Lane, thresholds: StallThresholds, now: number): Promise<boolean>;
  protected abstract gitOrNull(args: string[]): Promise<string | null>;
  protected abstract halt(reason: string, phase?: number, kind?: HaltKind): void;
  protected abstract now(): Date;
  protected abstract onStream(phase: number, event: StreamEvent): void;
  protected abstract armOutcomeFile(phase: number): string;
  protected abstract outcomePath(phase: number): string;
  protected abstract armTasksFile(phase: number): string;
  protected abstract tasksPath(phase: number): string;
  protected abstract drainTasks(phase: number): boolean;
  protected abstract parkWaiting(phase: number, declared: PhaseOutcome): boolean;
  protected abstract persist(): void;
  /** `persist()` without the debounce — for the moments that must reach disk now. */
  protected abstract persistNow(): void;
  protected abstract preflightVerification(phase: number): Promise<string | null>;
  protected abstract rearmLockCapParks(board: Board): Promise<void>;
  protected abstract reboardWith(record: PhaseRecord, hint: BoardingHint): void;
  protected abstract record(event: string, data?: Record<string, unknown>, phase?: number): void;
  protected abstract release(phase: number, owner: string): Promise<void>;
  protected abstract resolveMcp(phase: number, chosen: PhaseOptions): Promise<McpResolution>;
  protected abstract resumedStatus(): RunStatus;
  protected abstract retryContext(record: PhaseRecord, halt?: string | null): string;
  protected abstract scopeDirs(phase: number): Promise<string[]>;
  protected abstract script(script: string, args: string[]): Promise<import("../engine.ts").EngineResult>;
  protected abstract settleAwaitingVerification(): void;
  protected abstract sleep(ms: number): Promise<void>;
  protected abstract takeOutcome(phase: number): PhaseOutcome | null;
  /* The two halves of "act on what the session declared", implemented in
   * RunnerAttempt and called from RunnerControl's `repair` recovery — which
   * sits BELOW it in the chain (Base → Control → Loop → Attempt → Runner), so
   * the call has to travel up through an abstract exactly as `confirmed` does.
   * A recovery's tail routes its declaration through the SAME function a
   * phase's tail does; two routers would be two policies. */
  protected abstract routeOutcome(phase: number, declared: PhaseOutcome, board: Board): Promise<'waiting' | 'halted' | null>;
  protected abstract settleRungFromOutcome(phase: number, declared: PhaseOutcome | null, said?: string): void;

  protected deps: RunnerDeps;
  protected state: RunState | null = null;
  protected journal: Journal | null = null;
  protected transcript: Transcript | null = null;
  protected abort: AbortController | null = null;
  protected driving: Promise<void> | null = null;
  /**
   * Every phase this run has in flight, keyed by phase number.
   *
   * The source of truth for "what is running"; `state.child`,
   * `state.activePhase` and `state.freeze` are all derived from it.
   */
  protected lanes = new Map<number, Lane>();

  /**
   * The directory a phase's session runs in: its own worktree when this plan
   * opted into worktree lanes, the run's root otherwise.
   *
   * Read from the LANE rather than recomputed from the plan directive, so a
   * lane whose worktree could not be created (a refusal, a git failure) reads
   * as the root here without a second chance to disagree with the runner about
   * where the session actually is.
   *
   * 🔴 Lives HERE, on the base, and not next to the attempt that first needed
   * it. Three other spawn sites are spread across `runner-control.ts` and
   * `runner-loop.ts` — recovery, resume-with-instruction, the pull-request
   * session — and every one of them hardcoded `state.root` for as long as this
   * method was out of their reach (D7). A lane phase recovered from the wrong
   * tree finds its own edits absent and the wrong branch checked out, which is
   * indistinguishable from the work never having happened.
   */
  protected laneRoot(phase: number): string {
    return this.lanes.get(phase)?.worktree ?? this.state!.workRoot ?? this.state!.root;
  }

  /**
   * The branch this phase's session commits on, or undefined for the shared one.
   *
   * TWO features answer here and the order is the specific one: a lane's own
   * `pe/<slug>-pN` first, then — when the RUN has a checkout of its own — the
   * run branch `pe/<slug>`, and otherwise nothing at all.
   *
   * "Nothing at all" is a real answer and the safe one. It writes an
   * UNQUALIFIED lock, which `phase-lock.sh conflicts` reads as colliding with
   * every other claim on the repository — the pre-carve-out behaviour, and the
   * truth for a session editing the tree everyone shares.
   *
   * 🔴 On the BASE, beside `laneRoot`, for the reason `laneRoot` is here (D7):
   * the sites that need it are spread across `runner.ts` (the lease refresh)
   * and `runner-attempt.ts` (the session environment), and P7 could only reach
   * `lane.branch` from where it stood. A run-level isolated run then wrote an
   * unqualified lock and got no carve-out at all — the field shipped, the rule
   * shipped, and the one run shape they existed for was not covered.
   */
  protected branchFor(phase: number): string | undefined {
    const lane = this.lanes.get(phase)?.branch;
    if (lane) return lane;
    // A DETACHED run owns no ref at all, so there is no branch name to give —
    // and `undefined` here would write an unqualified lock that collides with
    // every claim on the repository, which is the exact opposite of what the
    // detached shape exists for. `detached@<sha12>` is the honest
    // qualification: two detached claims are the same ground when they stand
    // at the same commit, and different ground when they do not, which is what
    // `claimsDisjoint` already decides by comparing branch strings.
    if (this.state?.detachAt) return detachedRef(this.state.detachAt);
    // Any `new-branch` run: its sessions commit on `pe/<slug>` wherever they
    // stand — the boot prompt says so in as many words — and the claim should
    // say what the session does. This used to be gated on `workRoot` so that a
    // shared-checkout run stayed unqualified ("claims strictly less"), because
    // a branch alone could not distinguish two runs sharing one directory.
    // The TREE dimension now carries that distinction (`treeFor`): two shared
    // runs present the same tree and still collide, so the branch may finally
    // tell the truth for everyone. A default-branch run has no branch to name.
    return this.state?.gitMode === 'new-branch' ? `pe/${this.state.slug}` : undefined;
  }

  /**
   * The working tree this phase's session edits — the second qualification
   * dimension, for the lock's `worktree=` line and the admission's `tree`.
   * ACTED ON since the carve rule grew the tree dimension: two intersecting
   * claims are disjoint only when the branches AND the trees both differ.
   * Falls all the way to `state.root`, because a shared-checkout session's
   * tree is a fact too — the SAME fact for every shared run, which is exactly
   * what keeps two of them colliding whatever branches they name.
   */
  protected treeFor(phase: number): string | undefined {
    return this.lanes.get(phase)?.worktree ?? this.state?.workRoot ?? this.state?.root;
  }

  /**
   * The checkout this phase's session works in when it has ONE OF ITS OWN —
   * `treeFor` without the shared-root fallback. Kept for the readers that ask
   * "does this session have its own tree" (the git card, the lane view),
   * where the shared root would be a false yes.
   */
  protected worktreeFor(phase: number): string | undefined {
    return this.lanes.get(phase)?.worktree ?? this.state?.workRoot;
  }

  /**
   * The CLAIM a phase's session makes — both qualification dimensions, or
   * neither. The one answer behind the admission request, the session's
   * `PE_BRANCH`/`PE_WORKTREE`, the lease refresh's `--branch`/`--worktree`,
   * and the honesty probe, so the four cannot disagree about one session.
   *
   * 🔴 NEITHER when the phase's scope names a tree the run root does not
   * contain. `branchFor`/`treeFor` describe the run root — the branch the
   * console told sessions to use and the directory it spawns them in — and
   * for a plan whose Repos cell names a repository elsewhere on the machine
   * (a skill checkout under the home directory, driven from a hub) the
   * session's edits land in THAT repository, on whatever it has checked out.
   * A claim of `{pe/<slug>, <root>}` is then exact about a tree nobody
   * edits and silent about the one that is edited: a hand session `--here`
   * in the real repository on its own branch presents a different pair,
   * `claimsDisjoint` carves the two apart, and both write one working tree —
   * the collision the whole apparatus exists to refuse. An unqualified claim
   * collides with everything, which is the truth the console can vouch for.
   * `scopeConfined` is the same question the worktree preamble asks before it
   * would mint a tree (`scope-outside-root`), asked here of the shared shape
   * too. (console-parallel-repaint P1, W5.)
   */
  protected qualificationFor(
    phase: number, scope: readonly string[],
  ): { branch?: string; tree?: string } {
    const root = this.state?.root;
    if (!root || !scopeConfined(root, scope)) return {};
    const branch = this.branchFor(phase);
    const tree = this.treeFor(phase);
    return { ...(branch ? { branch } : {}), ...(tree ? { tree } : {}) };
  }

  /**
   * The directories a phase's session may write BESIDES the one it runs in.
   *
   * Exactly one, and only when it is needed: the run's root, when the session
   * is somewhere else. Being told where work-state goes (`DOCS_ROOT`) is not
   * the same as being allowed to write it — a lane session without this fails
   * on `new-handoff.sh`, at the very end of a phase that otherwise succeeded,
   * which is the most expensive moment to discover a permission wall.
   *
   * `undefined` rather than an empty array when the cwd already IS the root,
   * so the overwhelmingly common spawn's argv is byte-identical to what it was
   * before this existed.
   */
  protected addDirsFor(phase: number): string[] | undefined {
    const root = this.state!.root;
    return resolve(this.laneRoot(phase)) === resolve(root) ? undefined : [root];
  }

  /**
   * The homes this run's trees may stand in, the configured one first.
   *
   * `active` is the home to CREATE in and to prune from: the one whose
   * `<runId>/` directory already exists — a run resumed after the operator
   * flipped *Worktree root* keeps its trees where they are, or its next lane
   * would be minted beside a branch the old tree still holds — else the
   * configured one. `all` is what a sweep and a registry read take, so nothing
   * is orphaned by a flip. Asked of the filesystem, the way every other
   * checkout question here is, so it cannot go stale.
   */
  protected worktreeHomes(): { active: string; all: string[] } {
    const state = this.state!;
    const stateDir = runDir(state.root, state.slug);
    const mode = worktreeRootOf(this.deps.worktreePrefs?.().root);
    const at = (m: WorktreeRoot): string => worktreeHome({ mode: m, root: state.root, slug: state.slug, stateDir });
    const configured = at(mode);
    const all = [...new Set([configured, ...WORKTREE_ROOTS.map(at)])];
    const active = all.find((home) => existsSync(join(home, state.id))) ?? configured;
    return { active, all };
  }

  /** `laneNames` for this run, in the home its trees stand in. */
  protected laneNamesFor(phase: number): LaneNames {
    const state = this.state!;
    return laneNames({ home: this.worktreeHomes().active, runId: state.id, slug: state.slug, phase });
  }

  /**
   * The console-wide staging checkout, wherever it already is: git allows a
   * branch ONE working tree, so a `pe/integration` tree standing under the
   * other root keeps its place until an operator removes it.
   */
  protected async stagingFor(): Promise<StagingNames> {
    const state = this.state!;
    const consoleDir = consoleRunsDir(state.root);
    const mode = worktreeRootOf(this.deps.worktreePrefs?.().root);
    const at = (m: WorktreeRoot): StagingNames => stagingNames(stagingHome({ mode: m, root: state.root, consoleDir }));
    // Asked of git, not of the filesystem: a directory that merely exists
    // under the other root (restored, recreated by hand) is not a checkout,
    // and pinning the settle to it would refuse every settle for ever.
    for (const other of WORKTREE_ROOTS) {
      if (other !== mode && await isRegistered(state.root, at(other).dir)) return at(other);
    }
    return at(mode);
  }

  /** Every directory a console-made tree may stand under — `managed` for the sweeps and the registry. */
  protected managedDirs(): string[] {
    const state = this.state!;
    return managedRoots({ root: state.root, consoleDir: consoleRunsDir(state.root) });
  }
  /**
   * The lane this phase HAS on disk, asked of git — or null.
   *
   * `laneRoot` reads the in-memory lane table, which is the right answer while
   * a phase is in flight and no answer at all afterwards: `this.lanes` is
   * cleared the moment a phase settles, and the two sessions that run after
   * that point — a recovery, and the last leaf's pull-request session — were
   * both spawned in the shared root as a result. This is the durable question,
   * and it never CREATES anything: an absent lane means the phase shared the
   * root, which is exactly what the caller should then do.
   *
   * `isRegistered` rather than a directory check: a directory git has forgotten
   * is not a worktree, and a session committing inside one commits where
   * nothing merges from.
   */
  protected async registeredLane(phase: number): Promise<LaneNames | null> {
    const state = this.state;
    if (!state) return null;
    try {
      const names = this.laneNamesFor(phase);
      return (await isRegistered(state.root, names.dir)) ? names : null;
    } catch (error) {
      // Never a reason to refuse a session: not knowing means the shared root,
      // which is where every one of these ran before lanes existed.
      log.warn('runner.lane-unknown', { slug: state.slug, phase, error });
      return null;
    }
  }

  /** The 60-second liveness ticker; armed with the first lane, retired with the last. */
  protected livenessTimer: NodeJS.Timeout | null = null;
  /**
   * The five-minute branch probe; armed only for a run that has a checkout of
   * its own, because a shared run's branch IS the base and there is nothing to
   * diverge from.
   */
  protected gitTimer: NodeJS.Timeout | null = null;
  /** The one-shot that fires the FIRST probe clear of the admission burst. */
  protected gitFirst: NodeJS.Timeout | null = null;
  /**
   * The last probe, cached — the whole point of the ticker. A run page asking
   * for it must not cost a `worktree list`, a `du` and a `merge-tree` per pair
   * per request; nor may every reader get a different answer.
   */
  protected gitView: RunGitView | null = null;
  /**
   * The radar verdict per pair as it was last JOURNALLED.
   *
   * Transitions only, and this is the memory that makes that possible. A run
   * with three live branches probes three pairs every five minutes; without
   * this the journal would gain a `run.git-radar` line per pair per tick for as
   * long as the run lives, which is a firehose of "still clean" that buries the
   * one line that was news. Cleared with the run, never persisted: the journal
   * is where a verdict is durable, and re-announcing a standing conflict once
   * after a console restart is the right amount of noise.
   */
  protected radarSeen = new Map<string, RadarState>();
  protected childPid: number | null = null;
  /** The live session, while there is one — what `/btw` talks to. */
  protected handle: SpawnHandle | null = null;
  /** Set when the operator stopped us, so exit 143 is not read as a mystery. */
  protected stopRequested = false;
  /**
   * Fired by `halt()` so lanes sleeping on a retry backoff or a usage window
   * wake and re-check, instead of spawning another attempt on a stopped run.
   */
  protected haltSignal = new EventTarget();
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  protected settingsPath: string | null = null;
  /** Idempotency keys of operator messages already written, newest last. */
  protected injected = new Map<string, AskResult>();
  /** Set while `recover` drives a single session rather than the phase loop. */
  protected recovering = false;
  /**
   * The docs watcher's poke. The FLAG is the truth; the promise only ends the
   * drive loop's sleep — a wake that lands between the race settling and the
   * signal re-arming is still seen, because the loop top reads the flag.
   */
  protected docsDirty = false;
  protected wake = wakeSignal();
  /**
   * Resolutions the Service could not write because this loop owns the state
   * (`syncRecoveredRun` used to return null there and the record stayed
   * failed forever). Drained at the top of every drive tick.
   */
  protected pendingResolutions: { phase: number; outcome: 'done' | 'no-defect'; by: string }[] = [];
  /** Per-phase pokes armed at `parkedUntil`, so a live loop resumes a wait on time. */
  protected parkPokes = new Map<number, NodeJS.Timeout>();
  /**
   * What the loop's ladder pass last judged, per phase, as a fingerprint of the
   * record and the board. A record the ladder left standing (deferred, or
   * nothing to climb) is not re-classified — and re-journalled — every tick;
   * it is looked at again when its status, its attempt count or the board's
   * word about it changes. Cleared on start and on retry.
   */
  protected ladderSeen = new Map<number, string>();
  /**
   * Set by the console's shutdown checkpoint: the stop about to land on the
   * lanes is the SYSTEM's, not the operator's — the run is stamped so the
   * convergence loop may pick it back up at the next boot.
   */
  protected shuttingDown = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  current(): RunState | null { return this.state; }

  /**
   * Does this run hold one of the console's managed checkouts, or is it about to?
   *
   * The question `worktreeMaxConcurrent` is really asking, and `state.checkout`
   * alone answers it too late: the word is written only once the tree is made,
   * prepared and journalled, which can be minutes after the cap said yes. The
   * `reservingCheckout` half closes that window; without it two runs starting
   * together both read the pre-count and both passed a cap of one.
   */
  holdsIsolatedCheckout(): boolean {
    return this.reservingCheckout || this.state?.checkout === 'worktree';
  }
  busy(): boolean { return this.driving !== null; }

  /**
   * The docs watcher saw the plan or a handoff (or a lock) change. Wakes the
   * drive loop so the board is re-read NOW rather than when the current lane
   * settles — which, on a one-lane run, used to be hours away.
   */
  noteDocsChanged(): void {
    this.docsDirty = true;
    this.wake.resolve();
  }

  /**
   * A recovery finished while this loop owns the run: queue its write so the
   * loop applies it under its own ownership next tick, instead of the Service
   * skipping the write-back entirely (the stale-failed-record bug).
   */
  enqueueResolution(resolution: { phase: number; outcome: 'done' | 'no-defect'; by: string }): void {
    if (!this.state) return;
    this.pendingResolutions.push(resolution);
    this.wake.resolve();
  }

  /**
   * Rewrite this run's records from a board the caller already read. The
   * stopped-run counterpart of the drive loop's own reconcile pass — the
   * Service calls it before deciding a halt still needs a recovery.
   */
  reconcileAgainstBoard(board: Record<number, string>): { changed: boolean; closed: number[] } {
    const state = this.state;
    if (!state) return { changed: false, closed: [] };
    const result = reconcileRecordsAgainstBoard(state, board);
    if (result.changed) {
      for (const phase of result.closed) {
        this.clearParkPoke(phase);
        this.record('phase.reconciled', { by: 'the board', outcome: 'done' }, phase);
      }
      this.persist();
      this.emit('run', { state });
    }
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Lanes
   * ---------------------------------------------------------------- */

  /** The phases with a live session right now. */
  livePhases(): number[] { return [...this.lanes.keys()].sort((a, b) => a - b); }

  /**
   * Every live lane's liveness, computed NOW rather than read off the last
   * tick.
   *
   * The record's own `liveness` is at most a minute old, which is right for a
   * checkpoint and wrong for a page that just asked. A caller with no runner
   * falls back to the records; a caller with one gets the current answer.
   */
  liveness(): LaneLiveness[] {
    return [...this.lanes.values()]
      .map((lane) => livenessOf(lane.phase, lane.signals))
      .sort((a, b) => a.phase - b.phase);
  }

  /**
   * Fold a freshly-read ruling ledger into this run, journalling each new one.
   *
   * Scoped to rulings written since this run STARTED. The ledger is per plan
   * and outlives every run — a plan on its fourth run would otherwise ingest
   * three runs' worth of history the first time the watcher fired, and journal
   * every line of it. `GET /api/run/:slug/rulings` reads the whole file, so
   * nothing is hidden; this is the run's own slice.
   */
  ingestRulings(ledger: readonly Ruling[]): number {
    const state = this.state;
    if (!state) return 0;
    const mine = ledger.filter((ruling) => !state.createdAt || ruling.at >= state.createdAt);
    const { rulings, added } = ingestRulings(state.rulings, mine);
    if (!added.length) return 0;
    state.rulings = rulings;
    for (const ruling of added) {
      this.record('phase.ruling', {
        id: ruling.id, kind: ruling.kind, what: ruling.what,
        ...(ruling.why ? { why: ruling.why } : {}),
        ...(ruling.costIfWrong ? { costIfWrong: ruling.costIfWrong } : {}),
        ...(ruling.sessionId ? { sessionId: ruling.sessionId } : {}),
        at: ruling.at,
      }, ruling.phase);
    }
    this.persist();
    this.emit('rulings', { added: added.length });
    return added.length;
  }

  /**
   * The lane a control is aimed at: the one named, or the mirror.
   *
   * Naming nothing means "whatever is running", which is what every caller
   * before lanes meant and still means when only one thing is.
   */
  protected laneFor(phase?: number | null): Lane | undefined {
    if (phase != null) return this.lanes.get(phase);
    return this.mirrorLane();
  }

  /**
   * The one lane the single-lane fields describe.
   *
   * Lowest phase number rather than "most recent": it has to be *stable*, or
   * `state.child` would flip between lanes on every write and a console
   * watching it would see a run bouncing between phases it is calmly running
   * in parallel.
   */
  private mirrorLane(): Lane | undefined {
    let chosen: Lane | undefined;
    for (const lane of this.lanes.values()) {
      if (!chosen || lane.phase < chosen.phase) chosen = lane;
    }
    return chosen;
  }

  /**
   * Rewrite the single-lane fields from the lane table.
   *
   * `state.child` and `state.activePhase` are **load-bearing mirrors**, not
   * leftovers: `reconcileRun`, every console built before lanes, and the run
   * header all read them to answer "is something running, and what?". Dropping
   * them in favour of `children` would make every one of those report a busy
   * run as idle. So both recordings are kept in step here, in one place, and
   * `children` is the complete one.
   */
  protected syncMirror(): void {
    const state = this.state;
    if (!state) return;

    // MERGED, never rebuilt.
    //
    // This used to project `this.lanes` wholesale over `state.children`, which
    // made the map a picture of one process's memory rather than a record of a
    // fact. A fresh console's first lane therefore erased the previous
    // generation's entry — and that entry was the only durable handle on a
    // child that had outlived its console. With it gone, `reconcileRun`'s
    // orphan branch, `adopt`, and `converge.runIsDead` all went blind at once,
    // the run was reclaimed around a live session, and its lock was released as
    // debris while the session was still holding it.
    //
    // So: this process's lanes are authoritative for their own phases, and
    // every other entry is left alone unless the PROBE says it is gone.
    const children: Record<string, ChildRef> = {};
    for (const [phase, existing] of Object.entries(state.children ?? {})) {
      if (this.lanes.has(Number(phase))) continue;          // ours; rewritten below
      if (processState(existing.pid, procIdentity(existing)) === 'gone') continue;
      children[phase] = existing;
    }
    for (const lane of this.lanes.values()) {
      if (lane.pid == null) continue;
      const previous = state.children?.[String(lane.phase)];
      children[String(lane.phase)] = {
        pid: lane.pid,
        phase: lane.phase,
        sessionId: state.phases[String(lane.phase)]?.sessionId ?? '',
        startedAt: state.phases[String(lane.phase)]?.startedAt ?? new Date().toISOString(),
        // Kept across writes: it is stamped once, when the lane's process is
        // spawned, and a later `syncMirror` has no better source for it.
        ...(lane.procStartedAt ?? previous?.procStartedAt
          ? { procStartedAt: lane.procStartedAt ?? previous!.procStartedAt }
          : {}),
        // WHERE this session is editing, and on WHAT branch — the lane's own
        // answer only, deliberately NOT carried forward from `previous` the way
        // `procStartedAt` is.
        //
        // The two fields look alike and their merge rules are opposites,
        // because their sources are. `procStartedAt` is stamped once at spawn
        // and no later `syncMirror` has any way to recover it, so losing it
        // means losing half the identity tuple. A worktree is decided BEFORE
        // the pid exists (`acquireWorktree` runs at lane creation) and lives as
        // long as the lane, so the lane always knows — and carrying a previous
        // attempt's answer forward would state the one thing that must never be
        // stated wrongly: a phase that DEGRADED to the shared root on its second
        // attempt would go on claiming a checkout of its own, and every reader
        // of "absent means shared" would read the opposite of the truth.
        //
        // Read through `worktreeFor`/`branchFor` so an ISOLATED RUN answers too.
        // While these read `lane.worktree` alone, a run-level isolated session's
        // durable record said "absent", which under `ChildRef.worktree`'s own
        // documented convention means "this session shared the run's root" —
        // the exact opposite of where the process actually was. Every reader of
        // a child that outlived its console (`reconcileRun`'s orphan branch,
        // `adopt`, the client's session card) was told the wrong directory.
        ...(this.worktreeFor(lane.phase) ? { worktree: this.worktreeFor(lane.phase)! } : {}),
        ...(this.worktreeFor(lane.phase) && this.branchFor(lane.phase)
          ? { branch: this.branchFor(lane.phase)! } : {}),
        // On the lane's own entry, not only the single `freeze` slot — several
        // lanes can be frozen at once, and reconcile + the client read per pid.
        ...(lane.frozen ? { frozen: lane.frozen } : {}),
      };
    }
    if (Object.keys(children).length) state.children = children;
    else delete state.children;

    const mirror = this.mirrorLane();
    state.child = mirror?.pid != null ? children[String(mirror.phase)] ?? null : null;
    this.childPid = state.child?.pid ?? null;
    this.handle = mirror?.handle ?? null;
    // A run between phases points at nothing; one driving lanes points at the
    // mirror. Left stale, a finished phase goes on rendering a "running now"
    // chip in the phases table.
    if (this.lanes.size) state.activePhase = mirror?.phase ?? state.activePhase;
    else if (!this.recovering) state.activePhase = null;
  }

  /**
   * Record a spawned child against its lane — or, with no lane, against the
   * single-lane fields directly.
   *
   * The no-lane path is not dead code: `closeout` and `resumeWithInstruction`
   * are spawns like any other, and both can be reached on a run whose lane
   * table has already been torn down.
   */
  protected attachPid(phase: number, pid: number | null): void {
    const lane = this.lanes.get(phase);
    if (lane) {
      lane.pid = pid;
      if (pid != null) lane.procStartedAt = new Date().toISOString();
      else delete lane.procStartedAt;
      this.syncMirror();
      return;
    }
    const state = this.state;
    this.childPid = pid;
    if (!state) return;
    state.child = pid == null
      ? null
      : {
        pid, phase,
        sessionId: state.phases[String(phase)]?.sessionId ?? '',
        startedAt: new Date().toISOString(),
      };
  }

  protected attachHandle(phase: number, handle: SpawnHandle | null): void {
    const lane = this.lanes.get(phase);
    if (lane) { lane.handle = handle; this.syncMirror(); return; }
    this.handle = handle;
  }

  /**
   * Is the whole console frozen? Asked by everything in this runner that spawns.
   *
   * The scheduler's fleet holder covers every session that goes through
   * `admit()`, which is every PHASE — and the runner has three sessions that do
   * not: the auto-reviewer, the closeout, and the final pull-request session.
   * All three are paperwork spawned from inside the loop, after a phase's own
   * lane has already resolved and its pid has been nulled, so a Freeze-all
   * landing in that window used to mark the lane frozen and start a fresh
   * `claude` anyway. That is precisely the "it said frozen and kept working"
   * report, and the admission gate could never have caught it.
   *
   * A throwing dep reads as NOT frozen, the same fail-open direction the
   * scheduler and the convergence loop take: a console that wrongly believes
   * itself frozen stops silently and looks like a console with nothing to do.
   */
  protected fleetFrozen(): { at: string; by?: string } | null {
    try { return this.deps.fleetHold?.() ?? null; } catch { return null; }
  }

  /** How many phases of THIS run may be in flight. The scheduler caps the fleet. */
  protected maxLanes(): number {
    const max = typeof this.deps.maxParallel === 'function'
      ? this.deps.maxParallel()
      : this.deps.maxParallel;
    const wanted = this.state?.maxParallel ?? max ?? 1;
    return Math.max(1, wanted);
  }

  /**
   * The shutdown-handler key for a run.
   *
   * Named per run because the registry is name-keyed: with a pool, two runners
   * registering `'runner'` would evict each other's checkpoint handler, and the
   * evicted one would be the run that silently failed to checkpoint on the way
   * out.
   */
  protected shutdownKey(runId: string): string { return `runner:${runId}`; }

  /** What this phase touches, for admission and for the child's `PE_SCOPE`. */
  protected async scopeFor(phase: number): Promise<string[]> {
    const state = this.state!;
    const declared = await this.deps.phaseScope?.(state.slug, phase);
    // Saying nothing means it could touch anything — the same fail-safe
    // `scopeOfRow` takes on an empty Repos cell.
    return declared?.length ? declared : ['all'];
  }

  /**
   * Whether what is driving is a recovery rather than the phase loop.
   *
   * Both set `driving`, and they answer differently to exactly one control:
   * there is no phase boundary in a recovery for a Pause to wait at. See `pause`.
   */
  recoveringNow(): boolean { return this.recovering; }

  /**
   * Why a control aimed at a named phase cannot act, or null when it can.
   *
   * Naming a phase is not decoration. A control tapped on a phone reaches this
   * server whole seconds later, by which time the phase it was aimed at may
   * have ended — and freezing whatever started next is a different act from the
   * one that was asked for. Naming nothing still means "whatever is running",
   * which is what every caller before per-phase controls did, so this answers
   * null and changes nothing for them.
   */
  phaseMismatch(phase?: number | null): string | null {
    if (phase == null) return null;
    // Asked of the lane table, not of the mirror. With several phases in
    // flight, `state.child` names one of them — so a control correctly aimed
    // at a live lane that happens not to be the mirror would be refused with
    // "phase 5 is not the one running", while phase 5 was running perfectly.
    if (this.lanes.has(phase)) return null;
    const running = this.livePhases();
    if (!running.length) {
      return this.driving
        ? `phase ${phase} has no session running just now — the run is between phases, or verifying`
        : `phase ${phase} has nothing running to act on`;
    }
    return running.length === 1
      ? `phase ${phase} is not the one running — phase ${running[0]} is`
      : `phase ${phase} is not one of the ones running — phases ${running.join(', ')} are`;
  }
  /** Resolves once the loop has stopped driving. */
  async wait(): Promise<void> { await this.driving; }

}
