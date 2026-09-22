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
import type { ResolvedPolicy } from '../../shared/policy-model.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { log } from '../log.ts';
import { onShutdown, offShutdown, type ShutdownContext } from '../lifecycle.ts';
import { run as engineRun, readMemoryBlock, readGateStatus, readLint, readText, type Board } from '../engine.ts';
import { mcpDirective, skillDirective } from '../skills.ts';
import { detachedRef, worktreeRootOf, WORKTREE_ROOTS, type WorktreeRoot} from '../../shared/worktree-model.js';
import {
  childEnvDecisions, classify, fallbackChain, limitBucket, nextModel, resetWaitUntil, MODEL_FALLBACK, type Disposition,
} from './errors.ts';
import { continueMcpParkedRecord, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult } from './mcp-park.ts';
import {
  markFor, spawnClaude, type SpawnFn, type SpawnHandle, type SpawnOutcome, type SpawnRequest, type StreamEvent,
} from './spawn.ts';
import { permissionPromptsFor, relayArmingFor, sessionRecordOf, type Cap, type SessionCaps } from './session-record.ts';
import { loadModelsEnv } from './models.ts';
import { contextWindowOf, MAX_TOKEN_ATTEMPTS, type TokenAttempt } from './usage.ts';
import type { PollLoopState } from '../../shared/poll-loop.js';
import { writeMcpConfigFile, type McpConfigDoc } from '../mcp/config.ts';
import { RELAY_HOST_SERVER, RELAY_HOST_TOOL, relayHostConfig } from '../relay-host.ts';
import type { PhaseSize } from '../parse/plan.ts';
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
// FREE: the shared owner of the messaging words, which the free tree reads
// too — only the ledger path below it is Pro.
import { DEFAULT_MESSAGING } from '../../shared/message-model.js';
import {
  isRegistered, laneNames, realish, scopeConfined,
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
  accountRung, chargeRung, errandFor, nextRung, rungKey, rungsFor, rungSettledPayload, settleRung, settleRungRecord,
  DEFAULT_LADDER_CAPS, type LadderCaps, type Rung,
} from './ladder.ts';
import type { RungRecord, Actor } from './state.ts';
import { stoppedByOf } from '../actor.ts';
import {
  childrenOf, loadRun, newRun, phaseRecord, procIdentity, saveRun, pidAlive, processState, IN_FLIGHT, SETTLED,
  PHASE_IN_FLIGHT, reconcileRecordsAgainstBoard, mcpReasonText, resetForRetry, consoleStoppedNote,
  settleInFlightRecords, runDir,
  type Autonomy, type BoardingBrief, type BoardingHint, type ChildRef, type Errand, type HaltKind, type SessionMode,
  type McpDegradation, type McpPolicy,
  type OnLimitPolicy, type PhaseOptions, type PhaseRecord, type PreflightWarning,
  type RunState, type PhaseStatus, type RunStatus, type VerifySummary,
  consoleRunsDir, type DeclarationSink,
} from './state.ts';
import { consumeOutcome, outcomeFileFor, readOutcome, type PhaseOutcome } from './outcome.ts';
import {
  AdmissionAborted, autopilotOwner, type Scheduler, type ScopeGrant,
} from './scheduler.ts';
import { formatScope, repoKeyOf } from '../../shared/scope.js';
import { Journal } from './journal.ts';
import { Transcript } from './transcript.ts';
import { checkAuth, type AuthStatus } from './auth.ts';
import {
  buildSettings, writeSettingsFile, loadPolicyFor,
  type Approvals, type PermissionProfile,
} from './approvals.ts';
import {
  CLOSEOUT_MAX_TURNS, DEFAULT_BUDGET_RAISE_PCT, LADDER_STATES, ladderClassifies, LEASE_REFRESH_MS, LIMIT_ACTION_COOLDOWN_MS, LIMIT_RETRY_BURST, LIMIT_RETRY_WINDOW_MS, LIVENESS_GIT_EVERY_MS, LIVENESS_TICK_MS, LOCK_BACKOFF_MAX_MS, LOCK_CAP_PARK_NOTE, LOCK_WAIT_CAP_MS, MAX_ATTEMPTS, MAX_INJECT_KEYS, MCP_AUTH_PARK_NOTE, MCP_PARK_NOTE, SHUTDOWN_LADDER_MS, SIGTERM_GRACE_MS, TEARDOWN_SETTLES, VERIFICATION_PARK_NOTE, VERIFY_ANSWER_MS, VERIFY_TIMEOUT_MS, DEFAULT_WAIT_BUDGET_MS, WAIT_DEFAULT_MS, WAIT_MAX_PER_PHASE, applySettings, authRefusal, briefForRung, closeoutPrompt, condenseSaid, escalateModel, fixVerificationInstruction, frameQuestion, frameSteer, prBlockText, preflight, reasonOf, survivingChildren, unattendedDirective, waitResumePrompt, wakeSignal, type AskResult, type Lane, type McpResolution, type ReboardRequest, type RecoverMode, type RecoverOptions, type RunSettingsPatch, type RunnerDeps, type RunnerEvent, type StartOptions,
} from './runner-core.ts';
import type { Runner } from './runner.ts';
import { DEFAULT_WAIT_BUDGET, waitBudgetFrom, type WaitBudget } from './wait-budget.ts';
import type { ResumeVerdict, SessionRequest } from './runner-core.ts';
import { dateOfRef } from '../watch-refs.ts';

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
  protected abstract attempt(phase: number, prompt: string, model: string, owner: string, lane: Lane, chosen?: PhaseOptions, opts?: { maxTurns?: Cap; mcp?: McpResolution; }): Promise<{ carryOn: boolean; completed: boolean; }>;
  protected abstract board(): Promise<Board>;
  protected abstract boardingBlocked(): 'stopped' | 'halted' | 'pause' | 'frozen' | null;
  protected abstract checkpointForShutdown(context?: ShutdownContext): Promise<void>;
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
  protected abstract halt(reason: string, phase: number | undefined, kind: HaltKind): void;
  protected abstract now(): Date;
  protected abstract onStream(phase: number, event: StreamEvent): void;
  protected abstract noteContext(phase: number, event: Extract<StreamEvent, { kind: 'usage' }>): void;
  protected abstract armOutcomeFile(phase: number): string;
  protected abstract outcomePath(phase: number): string;
  protected abstract armTasksFile(phase: number): string;
  protected abstract tasksPath(phase: number): string;
  protected abstract drainTasks(phase: number): boolean;
  protected abstract parkWaiting(
    phase: number, declared: PhaseOutcome,
    opts?: { by?: import('./wait-budget.ts').WaitAuthor; budget?: WaitBudget; minted?: string[] },
  ): boolean;
  protected abstract persist(): void;
  /** `persist()` without the debounce — for the moments that must reach disk now. */
  protected abstract persistNow(): void;
  protected abstract preflightVerification(phase: number): Promise<string | null>;
  /** The policy answer in force for a situation's manifest row (phase 11; `runner.ts`). */
  protected abstract policyFor(situationKey: string): ResolvedPolicy | null;
  /** The phase's `Person-check:` word and its source (phase 11; `runner.ts`). */
  protected abstract personCheckFor(phase: number): { answer: string | null; source: string };
  protected abstract rearmLockCapParks(board: Board): Promise<void>;
  /** Rewrite this run's settings with the relay armed or not, keeping the token (phase 14; `runner-control.ts`). */
  protected abstract rearmRelay(armed: boolean): void;
  protected abstract reboardWith(record: PhaseRecord, hint: BoardingHint): void;
  protected abstract record(event: string, data?: Record<string, unknown>, phase?: number): void;
  /**
   * This run's journal as a `DeclarationSink` — what the state helpers that
   * spend testimony (`resetForRetry`, `reconcileRecordsAgainstBoard`) write
   * through. A LIVE runner always passes its own: a second `Journal` over the
   * same file would diverge the sequence numbers.
   */
  protected declarationSink(): DeclarationSink {
    return (event, data, phase) => this.record(event, data, phase);
  }

  /**
   * The runner's ONE settlement door (zero-touch-console phase 10, RCV-6):
   * settle the phase's newest open rung and write `phase.rung-settled` with
   * the whole payload — situation, params, cost, note. Every `settleRung`
   * under `runner/` goes through here (`test/invariants.test.ts` holds it; the
   * service has its own door, `settleRungOn`), which is what makes the
   * journal's settlement one shape: all 132 the audit read said only
   * `{outcome, rung}`. A no-op, answering null, when nothing is open.
   */
  protected settleOpenRung(
    phase: number, outcome: NonNullable<RungRecord['outcome']>, note?: string, costUsd?: number,
  ): RungRecord | null {
    const slot = this.state?.recoveries?.[String(phase)];
    if (!slot) return null;
    const settled = settleRung(slot, outcome, costUsd, note);
    if (settled) this.record('phase.rung-settled', rungSettledPayload(settled), phase);
    return settled;
  }

  /**
   * Settle whatever this phase's ladder still holds OPEN once its attempt has
   * ended — the backstop behind the outcome-driven settles, so no rung stays
   * `running` past its attempt (RCV-6: 21 of 168 records did, and
   * `chargeRung` went on booking every later attempt's spend onto them). The
   * verdict is read off the record the attempt left, the healer's sweep's own
   * table: done → `fixed`; a declared park → `no-defect`; an interruption →
   * `interrupted`; anything else `failed`, naming the status. Only rungs
   * climbed BEFORE `since` are settled: a rung the attempt itself climbed on
   * its way out — a re-board hint for the next lane — is that lane's to
   * settle, not this one's.
   */
  protected settleRungsAfterAttempt(phase: number, since: string): void {
    const state = this.state;
    const slot = state?.recoveries?.[String(phase)];
    if (!state || !slot?.rungs?.some((r) => (r.outcome === 'running' || r.outcome == null) && r.at < since)) return;
    const record = state.phases[String(phase)];
    // Only when an attempt actually RAN in this lane. A lane that ended at the
    // gate, the queue or a preflight park spawned nothing: its re-board hint
    // is kept for the next tick, and the rung behind that hint has not been
    // tried yet — settling it here would spend the remedy on a boarding that
    // never happened and lose its cost from the ledger.
    if (!record?.attemptStartedAt || record.attemptStartedAt < since) return;
    const status = record?.status ?? 'absent';
    const verdict: { outcome: NonNullable<RungRecord['outcome']>; note: string } =
      status === 'done' ? { outcome: 'fixed', note: 'the record reads done' }
        : (status === 'parked' || status === 'waiting') && record?.declared
          ? { outcome: 'no-defect', note: `the session declared ${record.declared.status}` }
          : status === 'interrupted'
            ? { outcome: 'interrupted', note: record?.note ? `the attempt was interrupted — ${record.note.slice(0, 120)}` : 'the attempt was interrupted' }
            : status === 'pending' && record?.boardingHint
              ? { outcome: 'interrupted', note: `the ladder re-boarded the phase (${record.boardingHint.rung}) before this rung settled` }
              : { outcome: 'failed', note: `the record reads ${status}` };
    // Oldest first, every open rung older than the attempt — a phase that
    // climbed twice without settling holds two, and both are past.
    for (const open of slot.rungs.filter((r) => (r.outcome === 'running' || r.outcome == null) && r.at < since)) {
      settleRungRecord(slot, open, verdict.outcome, undefined, verdict.note);
      this.record('phase.rung-settled', { ...rungSettledPayload(open), by: 'attempt-end' }, phase);
    }
  }
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
    const tree = this.lanes.get(phase)?.worktree ?? this.state?.workRoot ?? this.state?.root;
    // The PHYSICAL path (SCH-1). This is one half of the pair a claim is
    // decided on, and it was returned verbatim — so a run whose root is reached
    // through a symlink (`/tmp/x` for `/private/tmp/x`, which is every macOS
    // temp path, and any `~/work` behind one) presented a tree that did not
    // string-match the one a hand session derives with `pwd -P`. Two claims in
    // ONE directory then read as disjoint, which is the exact collision the
    // pair exists to refuse. `realish` resolves what exists and walks up for
    // what does not, so a tree not yet created still answers.
    return tree ? realish(tree) : undefined;
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
  ): { branch?: string; tree?: string; repo?: string } {
    const root = this.state?.root;
    if (!root || !scopeConfined(root, scope)) return {};
    const branch = this.branchFor(phase);
    const tree = this.treeFor(phase);
    // The repository the tree rides in — the per-repository cap's key. Derived
    // from the tree rather than from `state.root`, so it is absent for exactly
    // the admissions that state no tree, which is exactly the set that must
    // not be capped (`AdmitRequest.repo`).
    const repo = tree ? repoKeyOf(tree) : '';
    return {
      ...(branch ? { branch } : {}),
      ...(tree ? { tree } : {}),
      ...(repo ? { repo } : {}),
    };
  }

  /**
   * The four environment variables a spawned session claims its lock with.
   *
   * `phase-lock.sh` reads all four (`PE_OWNER`, `PE_SCOPE`, `PE_BRANCH`,
   * `PE_WORKTREE`) and DECIDES on the pair: a claim that names a branch and a
   * tree carves against another that names a different pair; one missing either
   * collides with everything. Five of the six phase-scoped spawn sites injected
   * the first two only — the reviewer, the closeout, the repair and both resume
   * sites — so each of those sessions' own first claim was unqualified, and
   * stayed so until the runner's keepalive rewrote the lock up to a third of a
   * lease later. Two isolated runs that should have carved cleanly serialised
   * against each other for ten minutes, every time one of them spawned.
   *
   * One helper, because the failure was five places agreeing about two fields
   * and forgetting two. `qualificationFor` is still the single source of the
   * pair — including its refusal to state EITHER for a scope the run root does
   * not contain, which is why this returns a whole env fragment rather than
   * letting each caller assemble one.
   */
  /**
   * How many times each phase's PROVISIONAL claim has been refused this process
   * (S1-a). In memory rather than on the record: it is about this run's
   * boarding attempts, not about the phase's history, and it is only ever read
   * to stop a cycle.
   */
  protected readonly provisionalRefusals = new Map<number, number>();

  protected async claimEnv(phase: number, over: { owner?: string; scope?: readonly string[] } = {}): Promise<Record<string, string>> {
    const scope = over.scope ?? this.lanes.get(phase)?.grant?.scope ?? await this.scopeFor(phase);
    const claim = this.qualificationFor(phase, scope);
    return {
      PE_OWNER: over.owner ?? autopilotOwner(this.state!.id),
      PE_SCOPE: formatScope(scope),
      ...(claim.tree ? { PE_WORKTREE: claim.tree } : {}),
      ...(claim.branch ? { PE_BRANCH: claim.branch } : {}),
    };
  }

  /**
   * This plan's `**Messaging:**` word; where the plan is silent, the RUN's
   * own (phase 15 — the launch form's); after both, the shipped `on`.
   */
  protected messagingOn(): boolean {
    const state = this.state;
    const own = (state?.messaging ?? DEFAULT_MESSAGING) === 'on';
    if (!state?.slug || !this.deps.messaging?.on) return own;
    // A plan read that throws must not stop a phase boarding: messaging is a
    // convenience and the default is on.
    try { return this.deps.messaging.on(state.slug) ?? own; } catch { return own; }
  }

  /**
   * `claimEnv`'s sibling: how a session says something to a PEER.
   *
   * One helper for the same reason `claimEnv` is one — every `sessionEnv` site
   * needs the pair, and a site that stated the ledger and forgot the token
   * would give a session a channel that 401s on every send. Both, or neither.
   *
   * `PE_MESSAGES_FILE` is per PLAN, not per attempt, and that is the one place
   * this differs from the outcome and task channels next door: those name one
   * file belonging to one attempt and are deliberately never inherited, while a
   * note left for phase 7 must outlive the run that wrote it. So it is not
   * armed (nothing is deleted) and a resumed session finds its own mail.
   *
   * Empty when the plan's `**Messaging:**` word is `off`: a session with no
   * token cannot reach the console's door, `phase-msg.sh` says so and appends
   * to the ledger instead, and nothing is silently half-on.
   */
  protected messagingEnv(): Record<string, string> {
    const state = this.state;
    if (!state || !this.messagingOn()) return {};
    const token = this.deps.messaging?.token?.(state.id) ?? null;
    return {
      ...(token ? { PE_MSG_TOKEN: token } : {}),
    };
  }

  /**
   * `messagingEnv`'s sibling (phase 12): where `phase-issue.sh` records a
   * problem the session tripped over that is not its phase's.
   *
   * Per PLAN like the mailbox, and for the mailbox's reason: the dedupe has
   * to see what an earlier run's phases already drafted, so the file is never
   * armed and a resumed session finds the plan's drafts where it left them.
   * Always stated, whatever the plan's `Issues:` word — the script reads the
   * word itself and refuses under `off`; a session with no ledger would fall
   * back to the console's own inbox, which is the same file by another route.
   *
   * Pro on both lines, the import above and this one — the defect
   * `messagingEnv` documents, not repeated: the free tree's method is a body
   * that returns `{}`, and every spawn site spreads it without knowing.
   */
  protected issuesEnv(): Record<string, string> {
    const state = this.state;
    if (!state) return {};
    return {
    };
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
  protected async stagingFor(repoKey?: string): Promise<StagingNames> {
    const state = this.state!;
    const consoleDir = consoleRunsDir(state.root);
    const mode = worktreeRootOf(this.deps.worktreePrefs?.().root);
    // `repoKey` is a MOUNT's root-relative path, empty for the root itself —
    // which keeps the bare `staging/` it has always had, so an existing tree
    // is still found. One staging tree per REPOSITORY is what lets a mirror
    // run settle `integration` at all: the branch name is the same in N
    // unrelated object databases, and they never meet.
    const at = (m: WorktreeRoot): StagingNames =>
      stagingNames(stagingHome({ mode: m, root: state.root, consoleDir }), repoKey);
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
  /** Set when somebody stopped us, so exit 143 is not read as a mystery. */
  protected stopRequested = false;
  /**
   * WHO asked for the stop (LFC-6, SHD-3) — the actor `stop()` was handed,
   * kept until the loop settles so every arm that stamps `stoppedBy` and
   * writes the "stopped by …" note reads the same answer. Null between stops.
   */
  protected stopActor: Actor | null = null;
  /**
   * Fired by `halt()` so lanes sleeping on a retry backoff or a usage window
   * wake and re-check, instead of spawning another attempt on a stopped run.
   */
  protected haltSignal = new EventTarget();
  /** Path to the 0600 settings file carrying this run's deny rules and hook. */
  protected settingsPath: string | null = null;
  /** The run whose `run.permission-prompts-skipped` line is already written — once per run. */
  private promptsSkippedFor: string | null = null;
  /** `run.relay-degraded` once per run per reason (phase 14). */
  private relayDegradedFor = new Set<string>();
  /** Idempotency keys of operator messages already written, newest last. */
  protected injected = new Map<string, AskResult>();
  /**
   * The questions an operator asked a live session that are still waiting for
   * their answer, by mark (`ask:<id>`) — what pairs a `phase.asked` with its
   * `phase.answered` (TRS-6). Bounded; in memory, because the stdin a question
   * went down dies with the console that wrote to it.
   */
  protected openAsks = new Map<string, { question: string; by: string; at: number; phase?: number }>();
  /** Set while `recover` drives a single session rather than the phase loop. */
  protected recovering = false;
  /**
   * The phase a `recheck` recovery is re-checking right now, or null. While
   * set, `settlePhase`/`halt` leave an IDENTICAL standing ending untouched and
   * the paperwork charges to the failure streak skip (phase 9, RCV-4): a
   * recheck spawns nothing, so it is neither a failed attempt nor a new stop.
   */
  protected rechecking: number | null = null;
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

  /**
   * The two facts every stop arm writes, from one source: `stoppedBy` folded
   * from the actor (`stoppedByOf`), and the note's wording. A shutdown is the
   * system's whatever actor pressed it — the run must resume at boot — and a
   * stop nobody attributed is still a person's, because the console never
   * stops a run without saying so.
   */
  protected stopStamp(): { stoppedBy: 'operator' | 'system'; by: string; note: string } {
    if (this.shuttingDown) return { stoppedBy: 'system', by: 'console', note: 'the console shut down' };
    const actor = this.stopActor;
    const by = actor?.by ?? 'unattributed';
    return {
      stoppedBy: actor ? stoppedByOf(actor) : 'operator',
      by,
      note: `stopped by ${by === 'operator' ? 'the operator' : by}`,
    };
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
   * Is a `claude` process of this run spending `accountId` RIGHT NOW? The
   * usage poller's active probe (ACT-3): a lane holding a live child is the
   * one account whose meters are moving, and it is polled at the active
   * cadence; everything else waits the idle ten minutes. A queued or waiting
   * lane holds no child and spends nothing.
   */
  isSpending(accountId: string): boolean {
    const state = this.state;
    if (!state || !this.driving) return false;
    if ((state.accountId ?? 'default') !== accountId) return false;
    for (const lane of this.lanes.values()) {
      if (lane.pid != null && !lane.checkpointed && !lane.stopped) return true;
    }
    return false;
  }

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
    const result = reconcileRecordsAgainstBoard(state, board, undefined, this.declarationSink());
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
      .map((lane) => ({
        ...livenessOf(lane.phase, lane.signals),
        // The unbooked half of the run's spend (`LaneLiveness.spentUsd`).
        ...(lane.sessionUsd ? { spentUsd: lane.sessionUsd } : {}),
      }))
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
        // The lock the runner fastened on that tree, on git's word (phase 15).
        // Only a LANE's own — a run-level checkout locks the run tree, which
        // is not this child's to claim — and only alongside the directory.
        ...(lane.worktree && lane.lockReason ? { locked: lane.lockReason } : {}),
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

  /** The phase sizes this runner has read, so a retry does not ask the engine again. */
  protected phaseSizes = new Map<number, PhaseSize>();

  /**
   * A phase's `Size:` from the plan, through the engine (`--size N`) — the
   * input to its session caps. Read once per phase; an engine that cannot
   * answer reads as `M`, the engine's own default for a phase with no size.
   */
  protected async sizeOf(phase: number): Promise<PhaseSize> {
    const known = this.phaseSizes.get(phase);
    if (known) return known;
    let size: PhaseSize = 'M';
    try {
      const said = (await this.engine(['--size', String(phase)])).stdout.trim();
      if (said === 'S' || said === 'M' || said === 'L') size = said;
    } catch { /* unreadable: the engine's own default stands */ }
    this.phaseSizes.set(phase, size);
    return size;
  }

  /** The wait budgets this runner has read — one pair of engine reads per phase. */
  protected waitBudgets = new Map<number, WaitBudget>();

  /**
   * A phase's wait budget from the plan, through the engine: `--wait-budget N`
   * (the phase's own `Waits on:` max, else the plan's `Wait budget:`) and
   * `--waits-on N`, whose `date:` refs countersign a longer wait. Read once per
   * phase; an engine that cannot answer reads as the console default with
   * nothing countersigned — the degradation `sizeOf` makes, for the same reason.
   */
  protected async waitBudgetOf(phase: number): Promise<WaitBudget> {
    const known = this.waitBudgets.get(phase);
    if (known) return known;
    let budget: WaitBudget = DEFAULT_WAIT_BUDGET;
    try {
      const [line, refs] = await Promise.all([
        this.engine(['--wait-budget', String(phase)]),
        this.engine(['--waits-on', String(phase)]),
      ]);
      budget = waitBudgetFrom(line.code === 0 ? line.stdout : '', refs.code === 0 ? refs.stdout : '', dateOfRef);
    } catch { /* unreadable: the console default stands */ }
    this.waitBudgets.set(phase, budget);
    return budget;
  }

  /** The budget already read for a phase — for a synchronous path (a watchdog tick) that cannot ask. */
  protected knownWaitBudget(phase: number): WaitBudget {
    return this.waitBudgets.get(phase) ?? DEFAULT_WAIT_BUDGET;
  }

  /**
   * THE door every `claude -p` session under the runner goes through.
   *
   * Seven sites spawn a session — a phase attempt, a resume with an
   * instruction, a repair, a QA round, a closeout, the pull-request session and
   * the reviewer — and until zero-touch-console phase 4 two of them wrote a
   * `phase.session`, one wrote three fields under another name, and four wrote
   * nothing: 50 of the 138 sessions the audit's six plans spawned were
   * invisible to every census built on the record (SES-6). A door that writes
   * the record cannot be forgotten by a site that does not know it exists, and
   * `test/invariants.test.ts` holds every spawn to this one call.
   *
   * It also puts both caps on every session with the policy that set them
   * (SES-8), and journals the two CLI-side ceilings the child runs under
   * (`phase.retry-ceiling`, DOC-2 and SES-12) before it starts.
   */
  protected async spawnSession(
    phase: number, mode: SessionMode, request: SessionRequest, ctx: { caps: SessionCaps; attempt?: number },
  ): Promise<SpawnOutcome> {
    // `--resume` only ever arrives vetted (`resumableSession`, REG-1/SLF-10):
    // the type admits nothing else, and this is the one line that unwraps it.
    const { resumeFrom, ...rest } = request;
    // The floor for a run nobody can answer (QRL-9): every session of a
    // `relay: off` run carries `--permission-prompts none`, unless the CLI is
    // known to predate the flag — which is said once, on the run.
    let version: string | undefined;
    // Asked only when there is someone to ask, so a harness spawns in the same
    // tick it always did.
    if (this.deps.cliVersion) {
      try { version = await this.deps.cliVersion(); } catch { version = undefined; }
    }
    // The relay (phase 14): armed only for the phase's own attempts — a boarding
    // and the `--resume` of its own session, both `mode: 'phase'` — on a `relay:
    // last-resort` run whose CLI read at or above the floor from `system/init`.
    // Every other session of any run (a QA round, a repair, a resume with an
    // instruction, a closeout, the PR and the reviewer), and every session of a
    // run the relay refused, keeps the floor below and its own MCP set.
    let relay: McpConfigDoc | null = null;
    if (this.state?.relay === 'last-resort' && mode === 'phase') {
      let initVersion: string | null = null;
      try { initVersion = this.deps.initVersion?.(version) ?? null; } catch { initVersion = null; }
      const arming = relayArmingFor(this.state.relay, initVersion);
      this.noteRelayArming(arming);
      if (arming.armed) relay = this.relayMcpDoc(rest.mcpConfig);
    }
    const armedPath = relay && this.state ? this.writeRelayConfig(phase, relay) : null;
    const prompts = permissionPromptsFor(armedPath ? 'last-resort' : 'off', version);
    if (prompts.refused && this.state && this.promptsSkippedFor !== this.state.id) {
      this.promptsSkippedFor = this.state.id;
      this.record('run.permission-prompts-skipped', {
        version: prompts.refused.version, floor: prompts.refused.floor, relay: this.state.relay ?? 'off',
      });
    }
    const armed = Boolean(armedPath);
    const onEvent = rest.onEvent;
    // Every session on a lane starts from nothing: the lane must not go on
    // showing the context of the session before it until this one's first call.
    // The window goes too, because only the phase's OWN session is judged
    // against one (`noteContext` sets it) — a closeout must not read as the
    // checkpoint it is exempt from. That session's status checks count from here.
    const shared = this.lanes.get(phase);
    if (shared) {
      delete shared.signals.tokens;
      delete shared.signals.contextWindow;
      // …and the dollars shown as live (`Lane.sessionUsd`): a closeout or a
      // retry on this lane must not open showing what the session before it
      // cost — that sum is already booked (autopilot-token-drain H7).
      delete shared.sessionUsd;
    }
    const lane = mode === 'phase' ? shared : undefined;
    const pollTracker = lane?.signals.pollLoop;
    const pollBefore = pollTracker ? { ...pollTracker.counts } : undefined;
    const sent: SpawnRequest = {
      ...rest,
      ...(resumeFrom ? { resume: resumeFrom.sessionId } : {}),
      ...(prompts.flag ? { permissionPrompts: prompts.flag } : {}),
      ...(armedPath ? { permissionPromptTool: RELAY_HOST_TOOL, mcpConfig: armedPath } : {}),
      caps: ctx.caps,
      maxTurns: ctx.caps.maxTurns.value,
      budgetUsd: ctx.caps.maxBudgetUsd.value,
      // What the session's own `system/init` says is read here, at the door:
      // the version every later arming is judged on, and — on an armed session —
      // whether the relay actually has a tool to answer and a host to hold it.
      onEvent: (event) => {
        try { this.noteSessionEvent(phase, event, armed, version); } catch { /* bookkeeping never costs the stream */ }
        onEvent?.(event);
        // The context thresholds, after the lane has taken the event, and for
        // the phase's OWN sessions only: a closeout, a QA round or a repair is
        // never told to wrap up, nor ended in the middle of its handoff.
        if (event.kind === 'usage' && mode === 'phase') this.noteContext(phase, event);
      },
    };
    const ceilings = childEnvDecisions(sent.env ?? process.env);
    this.record('phase.retry-ceiling', {
      mode,
      ceiling: Number(ceilings.maxRetries.value),
      source: ceilings.maxRetries.source,
      bgWaitCeilingMs: Number(ceilings.bgWaitCeilingMs.value),
      bgWaitSource: ceilings.bgWaitCeilingMs.source,
    }, phase);
    // Whose prompt cache this session writes — read at the spawn, because a
    // switch can move the run's account while the session is still running.
    const account = this.state?.accountId ?? 'default';
    const outcome = await (this.deps.spawn ?? spawnClaude)(sent);
    // Ended, so its cost is the caller's to book (`state.spentUsd +=`, right
    // after this returns): the lane stops reporting it as live, or the run view
    // would count it twice until the next session's first `result`.
    if (shared) delete shared.sessionUsd;
    this.record('phase.session', sessionRecordOf({ mode, request: sent, outcome, attempt: ctx.attempt }), phase);
    this.noteTokens(phase, mode, sent, outcome, ctx.attempt, lane ? { lane, tracker: pollTracker, before: pollBefore } : undefined, account);
    // What this session REPORTED costing goes to the instance's start ceiling
    // — its dollars-per-hour half reads the last hour's session spend. A cost
    // that never arrived charges nothing (`costSource: 'none'`).
    if (outcome.costUsd > 0) this.deps.startCeiling?.spendUsd(outcome.costUsd);
    return outcome;
  }

  /**
   * `phase.tokens`, and the session's entry on the phase record (`record.tokens`)
   * — once per session, as it ends (autopilot-token-drain phase 3). Only for a
   * session that made an API call: a harness's fake and a child that never
   * started report none, and a line of zeros would claim it cost nothing.
   *
   * `poll` is the phase's own lane and its poll-loop counts when this session
   * started, so the status checks booked are this session's rather than the
   * lane's since boarding; a tracker replaced mid-session counted only this
   * session's calls, so it is read whole. `account` is the one it was spawned
   * under — what the resume policy compares with the account paying later.
   */
  protected noteTokens(
    phase: number, mode: SessionMode, request: SpawnRequest, outcome: SpawnOutcome, attempt: number | undefined,
    poll: { lane: Lane; tracker: PollLoopState | undefined; before: { status: number; denied: number } | undefined } | undefined,
    account = 'default',
  ): void {
    const tokens = outcome.tokens;
    if (!tokens || tokens.calls <= 0) return;
    const record = this.state?.phases[String(phase)];
    const window = contextWindowOf([request.model, record?.actualModel], loadModelsEnv(this.deps.scriptsDir));
    let polls: { pollCalls: number; pollDenied: number } | undefined;
    if (poll) {
      const now = poll.lane.signals.pollLoop?.counts;
      const from = poll.tracker && poll.lane.signals.pollLoop === poll.tracker ? poll.before : undefined;
      polls = {
        pollCalls: Math.max(0, (now?.status ?? 0) - (from?.status ?? 0)),
        pollDenied: Math.max(0, (now?.denied ?? 0) - (from?.denied ?? 0)),
      };
    }
    const line = {
      mode,
      ...(attempt !== undefined ? { attempt } : {}),
      sessionId: outcome.sessionId ?? null,
      resumed: Boolean(request.resume),
      model: request.model ?? null,
      window,
      ...tokens,
      ...(polls ?? {}),
      account,
    };
    this.record('phase.tokens', line, phase);
    if (!record) return;
    const entry: TokenAttempt = { ...line, endedAt: this.now().toISOString() };
    record.tokens = [...(record.tokens ?? []), entry].slice(-MAX_TOKEN_ATTEMPTS);
    this.persist();
  }

  /**
   * The relay's arming for this run, recorded when it CHANGES (phase 14): the
   * run's `relayArming`, one `run.relay-refused {version, floor, reason}` for a
   * refusal and one `run.relay-armed {version, floor}` when it arms, and the
   * settings file rewritten so the next child loads — or no longer loads — the
   * `PermissionRequest` hook.
   */
  protected noteRelayArming(arming: { armed: boolean; version: string | null; floor: string; refused?: 'below-floor' | 'version-unknown' }): void {
    const state = this.state;
    if (!state) return;
    const before = state.relayArming;
    if (before && before.armed === arming.armed && before.reason === arming.refused) return;
    state.relayArming = {
      armed: arming.armed, version: arming.version, floor: arming.floor,
      ...(arming.refused ? { reason: arming.refused } : {}), at: this.now().toISOString(),
    };
    if (arming.refused) {
      this.record('run.relay-refused', { version: arming.version, floor: arming.floor, reason: arming.refused });
    } else if (arming.armed) {
      this.record('run.relay-armed', { version: arming.version, floor: arming.floor });
    }
    if (!before || before.armed !== arming.armed) {
      try { this.rearmRelay(arming.armed); } catch (error) { log.warn('runner.relay-arming-failed', { what: 'settings', error: String(error) }); }
    }
    this.persist();
  }

  /**
   * The phase's MCP document with the relay's presence-only host added — the
   * servers this phase already resolved (read back from the file `armMcp` just
   * wrote) and `pcrelay` beside them. A relay-armed session therefore always
   * runs `--strict-mcp-config`: the host has to be IN the set, and the flag is
   * what makes the resolved set the whole set.
   */
  private relayMcpDoc(existing: string | undefined): McpConfigDoc {
    let doc: McpConfigDoc = { mcpServers: {} };
    if (existing) {
      try {
        const parsed = JSON.parse(readFileSync(existing, 'utf8')) as Partial<McpConfigDoc>;
        if (parsed.mcpServers && typeof parsed.mcpServers === 'object') doc = { mcpServers: { ...parsed.mcpServers } };
      } catch { /* an unreadable phase document: the host alone, and the phase's servers are named in its prompt */ }
    }
    doc.mcpServers[RELAY_HOST_SERVER] = relayHostConfig();
    return doc;
  }

  /** Write the relay-armed document, or null — a session that cannot have its host runs on the floor. */
  private writeRelayConfig(phase: number, doc: McpConfigDoc): string | null {
    try {
      return writeMcpConfigFile(this.state!.id, phase, doc);
    } catch (error) {
      log.warn('runner.relay-arming-failed', { what: 'mcp-config', error: String(error) });
      return null;
    }
  }

  /**
   * One stream event, read at the door for the ledgers that belong to no lane:
   * the CLI version a session's `system/init` reports (every later arming is
   * judged on it), the relay's two degradations on an armed session — no
   * `AskUserQuestion` in `system/init.tools`, or its host not `connected` in
   * `system/init.mcp_servers` (the exit code never says, DOC-5) — a
   * `control_request` the CLI sent, and a turn that ended on a `defer`.
   */
  private noteSessionEvent(phase: number, event: StreamEvent, armed: boolean, binary: string | undefined): void {
    const state = this.state;
    if (!state) return;
    if (event.kind === 'init') {
      if (event.version) this.deps.noteCliInit?.(event.version, binary);
      if (!armed) return;
      if (event.version) {
        const read = relayArmingFor(state.relay, event.version);
        if (!read.armed) this.noteRelayArming(read);
      }
      const degraded = (reason: string, data: Record<string, unknown>) => {
        const key = `${state.id}:${reason}`;
        if (this.relayDegradedFor.has(key)) return;
        this.relayDegradedFor.add(key);
        this.record('run.relay-degraded', { reason, ...data }, phase);
      };
      if (event.toolNames && !event.toolNames.includes('AskUserQuestion')) {
        degraded('tool-absent', { tools: event.toolNames.length });
      }
      const host = event.mcpServers?.find((server) => server.name === RELAY_HOST_SERVER);
      if (event.mcpServers && host?.status !== 'connected') {
        degraded('host-not-connected', { status: host?.status ?? 'absent' });
      }
      return;
    }
    if (event.kind === 'control-request') {
      this.record('phase.control-request', {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.subtype ? { subtype: event.subtype } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
      }, phase);
      return;
    }
    if (event.kind === 'deferred') {
      this.record('phase.tool-deferred', {
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
        ...(event.tool ? { tool: event.tool } : {}),
      }, phase);
    }
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
