/**
 * `ServiceRecovery` — link 4 of the `Service` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Service` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `service.ts` holds the concrete class.
 */
import { basename, join, resolve as resolvePath, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { instanceId } from '../shared/instances.mjs';
import {
  INSTANCE, INSTANCE_STATE_DIR, SKILL_DIR, STATE_DIR, agentEnabled, checkRoot, distRev, rememberRoot, loadPrefs, savePrefs,
  serverIsStale, staticRoot,
  type Flags, type Prefs, type RootCheck,
} from './config.ts';
import {
  SessionRegistry, correlate, parseHookPayload,
  type RunLink, type SessionEventName, type SessionRecord, type SessionView,
} from './sessions/registry.ts';
import { hooksStatus, installHooks, uninstallHooks, type HooksStatus, type HooksWrite } from './hooks-install.ts';
import { Store, handoffFor, lockFor, qaFor, readLock, type PlanRecord } from './store.ts';
import {
  ConvergeScheduler, convergePlan, evidenceFingerprint, HALT_DELAY_MS, MAX_BOOT_RESUMES, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView } from './converge.ts';
import { RECOVER_MAX_PER_PHASE } from './runner/runner-core.ts';
import { planWrite, runWrite } from './writes.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
  type GateStatus,
} from './engine.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import { listSkills, type SkillInfo } from './skills.ts';
import { DocsWatcher } from './watch.ts';
import {
  degradedState, hasShutdownWork, onDegraded, requestRestart, requestShutdown, stopPlan, supervisor,
} from './lifecycle.ts';
import { log } from './log.ts';
import {
  CATEGORIES, Push, isPlanProgress, routeFor, sanitiseCategories, tagFor, type CategoryId,
} from './push/index.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import { repoInfo, lastCommit, commitsTouching, type GitRepoInfo, type GitFileInfo } from './git.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, loadMcpSurcharge, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type McpSizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import { rungsToday, spendSummary, type SpendRunView, type SpendView } from './analysis/spend.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, writeAck,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import { STALL_SIGNAL_META, inboxItemId, parseInboxItemId } from '../shared/attention-model.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading,
} from './analysis/stats.ts';
import { mcpServersFor, type Plan, type PhaseDetail, type PhaseRow } from './parse/plan.ts';
import {
  Runner, applySettings, VERIFICATION_PARK_NOTE, MCP_PARK_NOTE,
  type AskResult, type RecoverMode, type RunSettingsPatch, type StartOptions,
} from './runner/runner.ts';
import { Scheduler, lockLapsed, type LockView } from './runner/scheduler.ts';
import { offeredModels } from './runner/models.ts';
import {
  continueMcpParkedRecord, mcpParkDueAt, DEFAULT_MCP_REQUIRE_TIMEOUT_MS, type McpContinueResult,
} from './runner/mcp-park.ts';
import {
  classifySituation, collectEvidence, gitIn, newEvidenceCache, summariseEvidence, workEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './runner/situation.ts';
import {
  accountRung, capRefusal, errandFor, errandSaid, ladderCaps, lastSettledRung, nextRung, parseSituationKey, progressExtension,
  policyAnsweredPayload,
  rungSettledPayload, rungsFor, sameErrand, settleRung, situationLabel, undrivableSentence, type Rung, widenCard, widenInstruction,
} from './runner/ladder.ts';
import { policyForSituation, policyPrefsOf } from './runner/policy.ts';
import { pollableRefs, redeliverAfter, type WatchState } from './watch-refs.ts';

/**
 * How many times a landing's drive may REJECT before the landing becomes an
 * errand (RCV-8) — the same three as `MAX_BOOT_RESUMES`, because a rejection
 * and a void resume are two ways of the same landing buying nothing.
 */
const MAX_WATCH_REJECTIONS = MAX_BOOT_RESUMES;
import type { WatchLandingOutcome } from './watch-scheduler.ts';
import type { ClassifiedBy, McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { doorActor, viaOfTrigger, type StartActor } from './actor.ts';
import { ceilingSentence } from './start-ceiling.ts';
import { consoleEnded } from './runner/session-record.ts';
import { formatScope, scopeOfRow, scopesIntersect } from '../shared/scope.js';
import {
  KIND_PROFILE, NO_HANDOFF_AUTO_RE, VERIFICATION_AUTO_RE, isRecoveryClass, recoveryActionsFor,
} from '../shared/recovery-model.js';
import { environmentReport, type EnvIssue } from './env-doctor.ts';
import { Terminals, type SessionEvent, type SessionInfo, type SessionKind } from './terminal.ts';
import { Journal } from './runner/journal.ts';
import {
  FREEZE_ESCALATE_MS, escalatePersistedFreeze, freezeVerdict, type PersistedEscalation,
} from './runner/freeze.ts';
import type { LaneLiveness } from './runner/liveness.ts';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
import {
  autoResolveRun, childrenOf, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive, retirePhaseHalt,
  reconcileRecordsAgainstBoard, resetForRetry, resolveRunsAgainst, saveRun, setRunState, syncWaitClock,
  slugsNeedingBoard, runDir, waitReasonOf, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText,
  type BoardingBrief, type Errand, type McpPolicy, type PreflightWarning, type RungRecord, type RunState, type VerifySummary, mergeQaHistory,
} from './runner/state.ts';
import { openWaitEntry } from './runner/wait-budget.ts';
import {
  consumeOutcome, inboxOutcomePhase, outcomeFileFor, outcomeInboxDir, readOutcome, type PhaseOutcome,
} from './runner/outcome.ts';
import { readTranscript, transcriptFile, type TranscriptEntry } from './runner/transcript.ts';
import { extractCommands, resolveLead, unresolvableLeads, verifyPhase } from './runner/verify.ts';
import { loadVerifyEnv } from './runner/verify-env.ts';
import { checkAuth, checkAuthFor, forgetAuth, openLoginTerminal, openCommandTerminal, shellQuote, type AuthStatus } from './runner/auth.ts';
import { Accounts, DEFAULT_ACCOUNT_ID, profileConfigDir, type AccountView } from './accounts/index.ts';
import { Mcp, type McpServerView } from './mcp/index.ts';
import { portTranscript } from './accounts/transcripts.ts';
import { FULL_FLAGS, installDesktopLauncher, launcherPlan } from './launcher.ts';
import {
  RECOVERY_TITLES, recoveryKey, recoveryPrompt,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, type QaFacts, type QaRequest,
} from './qa-session.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  autoApproveFor, neverAutoApproves, hitsHidden,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';
import {
  AUTO_GRANT_REASONS, ETA_POOL_MS, EVENT_BUFFER, HOOK_EVENTS_PER_MINUTE, HookPayloadError, HookRateError, INBOX_SOURCES, MAX_TIMER_MS, OUTCOME_INBOX_DEBOUNCE_MS, OUTCOME_INBOX_MAX_AGE_MS, PhaseClaimedError, RecoveryBusyError, UNSUPERVISED_WAIT_DEFAULT_MS, autoRecoveryClass, bucketLabel, describeExit, describeToolInput, effortOf, gitPorcelain, gitRead, lockView, modelAlias, recoveryActions, recoveryOwner, seedSkills, situationOfHalt, titleOf, type AutoRecoverResult, type Cached, type ControlResult, type DriveVehicle, type EtaPool, type EvidenceView, type LiveEvent, type LiveListener, type LockRelease, type PhaseDiagnosis, type PhaseLockView, type PhaseView, type PlanDetail, type PlanSummary, type QaOutcome, type RecoveryAction, type RouteView,
} from './service-core.ts';
import type { Service } from './service.ts';
import { ServiceRuns } from './service-runs.ts';

/*
 * How many times one landed watch ref may resume a phase before the landing
 * becomes a person's errand instead: `MAX_BOOT_RESUMES`, imported from
 * `converge.ts`.
 *
 * It used to be a `MAX_WATCH_RESUMES = 3` of its own here, declared with the
 * note that three "is the same number the boot-resume ladder uses". Two
 * constants agreeing by convention is one constant with a second chance to
 * drift, and the reason it existed at all was that Phase 1 needed the bound
 * before this phase's design was written (its own handoff records the
 * deferral). It is one number now.
 */

/**
 * What a resumed session is actually being asked to do, given HOW the thing it
 * waited on ended.
 *
 * "Landed" is one word for four outcomes and they call for different next
 * moves. The instruction used to say "re-check it now" for all of them, which
 * is wrong in the case that costs the most: a workflow run that ended
 * `cancelled` (the measured p12 shape — a `workflow_run` cancelled at its 24 h
 * expiry) is not a result to read, it is a run that never produced one, and a
 * session told to "re-check it" reads a cancelled run, finds nothing, and
 * declares the same wait again. Naming the conclusion is the difference
 * between resuming a session and resuming a loop.
 *
 * Deliberately a directive and not a decision: none of these tells the session
 * what the answer is, only which question it is now looking at. A failure is
 * still possibly expected; a cancellation is still possibly fine.
 */
export function landingDirective(landed: { detail?: string }): string {
  const detail = (landed.detail ?? '').toLowerCase();
  if (detail.includes('cancelled') || detail.includes('canceled')) {
    return 'It was CANCELLED, so there is no result to read — decide whether to re-run it (`gh run rerun <id>`) or to proceed without it;';
  }
  if (detail.includes('failure') || detail.includes('timed_out')) {
    return 'It FAILED, so read why before anything else — a green step is not waiting for you;';
  }
  if (detail.includes('closed') && !detail.includes('merged')) {
    return 'It was CLOSED rather than merged — check whether the work it carried still needs a home;';
  }
  return 'Re-check it now,';
}

export abstract class ServiceRecovery extends ServiceRuns {
  /* ---------------------------------------------------------------- *
   * Recovery sessions
   * ---------------------------------------------------------------- */

  /**
   * The live recovery session already working on a target, if there is one.
   *
   * Keyed by `(slug, phase)` rather than by class: two sessions repairing the
   * same phase from different angles would edit the same files, and the second
   * one is never what anybody meant to press. The client reads the same fact
   * off the sessions list it already holds, so the button becomes a chip
   * without a round trip.
   */
  liveRecoveryFor(link: { slug?: string; phase?: number }): SessionInfo | undefined {
    const key = recoveryKey(link);
    return this.terminals.state().sessions.find((session) =>
      !session.exited && session.meta?.recovery && recoveryKey(session.meta.recovery) === key);
  }

  /**
   * Turn "recover this" into the briefing a session can act on — or say why not.
   *
   * The browser names the target; every fact in the prompt is read here, from
   * the board, the run record, the phase diagnosis, the lock file and the
   * health issues. That split is the security property (a page cannot dictate
   * what an agent session is told) and the honesty property: a prompt cannot
   * claim a phase failed verification unless the recorded verification failed.
   *
   * Three refusals, all of them 409s that say what to do instead.
   */
  async resolveRecovery(
    request: RecoveryRequest,
  ): Promise<
    { ok: true; facts: RecoveryFacts }
    | { ok: false; status: number; error: string; sessionId?: string }
  > {
    const refuse = (status: number, error: string, sessionId?: string) =>
      ({ ok: false as const, status, error, ...(sessionId ? { sessionId } : {}) });

    const root = this.root?.path;
    if (!root) return refuse(409, 'No source directory is open.');

    const record = this.store?.get(request.slug);
    if (!record) return refuse(404, `No plan named ${request.slug}.`);

    // 1. The autopilot owns the working tree while it drives. A recovery
    //    session editing the same files under it is the one failure mode that
    //    corrupts work that was going to be fine.
    //
    //    Asked of the TARGET plan first. "Is anything running" was the same
    //    question while there was one runner; with the pool it stops being one,
    //    and a check written as "is the current run busy" would then refuse a
    //    recovery on plan A because plan B was mid-phase — or, worse, allow one
    //    because `current()` happened to answer about a third plan.
    const own = this.drivingRun(request.slug);
    if (own) {
      return refuse(409,
        `${own.slug} is mid-run (${own.status}) — pause or stop it before starting a recovery session.`);
    }
    //    A run on ANOTHER plan is a refusal only when it shares this one's
    //    tree. That used to be unconditional — one console, one working tree —
    //    and it is the arm phase 4 replaced with a scope intersection: two
    //    plans in different repositories have no way to collide, and refusing
    //    them bought nothing but a serialised operator.
    const wanted = request.phase != null
      ? this.scopeOf(request.slug, request.phase) ?? ['all']
      : ['all'];
    for (const other of this.runStates()) {
      const held = this.scheduler.granted(other.id);
      // A run holding no grant yet is between phases: nothing is editing
      // anything, so there is nothing to collide with. And a grant whose TREE
      // is not this console's root belongs to a run working in its own mirror
      // checkout (superproject isolation): a recovery session runs in the
      // root, so the two cannot physically collide however their scopes read.
      const sameGround = (a: string, b: string) => {
        const x = resolvePath(a);
        const y = resolvePath(b);
        return x === y || x.startsWith(y + sep) || y.startsWith(x + sep);
      };
      const overlapping = held.filter((grant) => scopesIntersect(grant.scope, wanted)
        && (!grant.tree || sameGround(grant.tree, root)));
      if (!overlapping.length) continue;
      return refuse(409,
        `${other.slug} is mid-run (${other.status}) in ${formatScope(overlapping[0].scope)}, which a `
        + `recovery session for ${request.slug} would edit under. Pause or stop it first — or leave `
        + `it: when the scope frees, the autopilot's own repair retries by itself (and the button works again).`);
    }

    // 2. Signing in is the fix for an auth halt; an AI session would spend a
    //    turn discovering it cannot authenticate and report success anyway.
    //    Probed as the RUN's account — the machine login being healthy says
    //    nothing about the profile the halted run was paying with.
    if (request.class === 'auth-interrupted') {
      const haltedAccount = request.runId && this.root?.ok
        ? loadRun(this.root.path, request.slug, request.runId, this.liveRunId())?.accountId
        : this.runStates().find((run) => run.slug === request.slug)?.accountId;
      const auth = haltedAccount
        ? await checkAuthFor(root, await this.accounts.envFor(haltedAccount), haltedAccount, true)
        : await this.authStatus(true);
      if (!auth.loggedIn) {
        return refuse(409,
          `${haltedAccount ? `${this.accounts.labelFor(haltedAccount)} is` : 'Claude is'} signed out `
          + '— sign in first, then continue the run. A recovery session cannot authenticate for you.');
      }
    }

    // 3. One recovery per target.
    const already = this.liveRecoveryFor(request);
    if (already) {
      return refuse(409,
        `A recovery session for ${request.slug}${request.phase != null ? ` phase ${request.phase}` : ''} `
        + 'is already running.', already.id);
    }

    const [board, runState, diagnosis] = await Promise.all([
      this.board(request.slug),
      request.runId
        ? Promise.resolve(loadRun(root, request.slug, request.runId, this.liveRunId()))
        : this.runFor(request.slug),
      request.phase != null ? this.phaseDiagnosis(request.slug, request.phase) : Promise.resolve(null),
    ]);

    const rows = record.plan?.graph ?? [];
    const facts: RecoveryFacts = {
      ...request,
      scriptsDir: this.flags.scriptsDir,
      skillId: phasedExecutionSkillId(this.skills()),
      newOwner: recoveryOwner(request),
      ...(titleOf(rows, request.phase) ? { phaseTitle: titleOf(rows, request.phase) } : {}),
      ...(runState?.status ? { runStatus: runState.status } : {}),
      ...(runState?.halt?.reason ? { haltReason: runState.halt.reason } : {}),
      // A recovery of a branched run must commit where the run commits — the
      // discipline block flips its branch bullet on this.
      ...(runState?.gitMode === 'new-branch'
        ? { gitStrategy: { branch: `pe/${request.slug}` } }
        : {}),
      // When the interruption WAS a usage limit, say so: the session must know
      // the stop was quota, not the work. It must ALSO not be told that about a
      // park on external work, which shares the clock — `waitReason` is the
      // recorded answer, and reading it beats the regex over prose this used to
      // run, which called any reason without the words "usage limit" a limit.
      ...(runState?.waitUntil && waitReasonOf(runState) === 'usage-limit'
        ? {
          limit: {
            account: this.accounts.labelFor(runState.accountId),
            resetsAt: new Date(runState.waitUntil).toLocaleString(),
          },
        }
        : {}),
      board: rows.length
        ? rows.map((row) => ({
          phase: row.phase,
          state: board.states[row.phase] ?? 'unknown',
          ...(row.title ? { title: row.title } : {}),
        }))
        : Object.entries(board.states).map(([phase, state]) => ({ phase: Number(phase), state })),
      ...(diagnosis
        ? {
          diagnosis: {
            blockedOn: diagnosis.blockedOn,
            boardState: diagnosis.boardState,
            said: diagnosis.said,
            verification: diagnosis.verification,
            lint: diagnosis.lint,
            workingTree: diagnosis.workingTree,
            sessionId: diagnosis.sessionId,
            resumable: diagnosis.resumable,
          },
        }
        : {}),
    };

    if (request.class === 'stale-claim-takeover') {
      // The FILE, not the store's scan — a claim re-taken since the last scan
      // must read as live, exactly as `releaseLock` insists.
      const handoffsDir = this.root?.handoffsDir;
      const lock = handoffsDir ? readLock(handoffsDir, request.slug, request.phase!) : null;
      if (lock) {
        facts.lockOwner = lock.owner;
        facts.lockDetail = lock.expired
          ? 'the lease has expired'
          : `the lease is still live until ${lock.leaseUntil ? new Date(lock.leaseUntil).toISOString() : 'an unrecorded time'}`;
      }
      const detail = await this.phaseLock(request.slug, request.phase!);
      if (detail) facts.lockDetail = detail;
    }

    if (request.class === 'plan-repair') {
      // Refused outright, and said plainly. Closure already demotes this plan's
      // issues to `info`, so the scan below would find nothing and answer "the
      // board and its artefacts agree" — true of the severities, misleading about
      // the plan. Repairing a closed plan is a real thing to want; it just starts
      // with reopening it.
      if (this.isClosedPlan(request.slug)) {
        return refuse(409,
          `${request.slug} is closed — reopen it before repairing it, or its board will go quiet again the moment it is fixed.`);
      }
      const issues = healthIssues(await this.context(record))
        .filter((issue) => issue.severity === 'error' || issue.severity === 'warning')
        // A phase-scoped repair only wants that phase's issues; a plan-wide one
        // takes them all.
        .filter((issue) => request.phase == null || issue.phase == null || issue.phase === request.phase);
      if (!issues.length) {
        return refuse(409,
          `${request.slug} has no plan errors to repair — the board and its artefacts agree.`);
      }
      facts.issues = issues.map((issue) => ({
        kind: issue.kind,
        message: issue.message,
        severity: issue.severity,
        ...(issue.phase != null ? { phase: issue.phase } : {}),
      }));
    }

    return { ok: true, facts };
  }

  /**
   * The gate in front of every recovery: is there anything left to recover?
   *
   * (1) Reconcile records against the live board — a phase finished outside
   * the run closes here, the halt anchored to it dissolves, and the answer is
   * `superseded` with nothing spawned. (2) A standing `resolved` on the run
   * is an answer somebody (or the board resolver) already gave — honored, not
   * relitigated.
   */
  protected async preRecoveryGate(
    slug: string, state: RunState, phase: number,
    /**
     * `verb: true` is the operator's `recover` (`recoverPhase`), which is also
     * held to its own ledger (RCV-4): `unchanged` when the phase's evidence
     * fingerprint is the one the last recovery ran under, `capped` past
     * `RECOVER_MAX_PER_PHASE`. The healer's two calls never ask — its dedup is
     * the situation fingerprint (RCV-9), and an `interrupted` rung must stay
     * re-climbable once over evidence a restart did not move.
     */
    opts: { verb?: boolean } = {},
  ): Promise<'proceed' | 'superseded' | 'resolved' | 'unchanged' | 'capped'> {
    // `if (board)` used to be dead code: `boardStates` caught internally and
    // always returned an object, so this branch ran against an EMPTY board and
    // reconciled records against a read that had never happened. `board.error`
    // is the fact that was missing — an unreadable board supersedes nothing,
    // and the gate falls through to the `resolved` check below.
    const read = await this.board(slug).catch(() => null);
    const board = read && !read.error ? read.states : null;
    if (board) {
      const pooled = this.runners.get(slug);
      const holder = pooled?.current()?.id === state.id && !pooled.busy() ? pooled : null;
      const result = holder
        ? holder.reconcileAgainstBoard(board)
        : reconcileRecordsAgainstBoard(state, board);
      if (!holder && result.changed) {
        try { saveRun(state); } catch { /* a failed write must not block the verdict */ }
        this.emit('run:state', { state });
      }
      // "The board moved past the halt" is tested by `board[phase] === 'done'`,
      // which is exactly true of a phase a QA verdict is HOLDING — and exactly
      // the wrong conclusion about it. That phase is settled as work and
      // unsettled as a blocker: the engine keeps every dependent behind it, and
      // the ladder has a rung for it. The gate refused that rung one line before
      // the spawn, answering "the board had already moved past the halt —
      // records reconciled, nothing to launch" about a plan where nothing had
      // moved past anything.
      //
      // Keyed on the BOARD FACT, deliberately, and NOT on the halt's kind: the
      // run that exposed this was parked by an earlier build, so its halt
      // carries no `kind` and no `phase` at all. A fix that reads the halt
      // leaves every run parked before it shipped wedged for ever — and those
      // are precisely the runs that need it.
      // No `wedgeCleared` term. It asked "does the BOARD have anything ready or
      // in flight?" — a plan-wide fact answering a per-phase question. Whether
      // some unrelated chain has work says nothing about whether THIS phase's
      // verdict is holding its own dependents, so on any plan with a parallel
      // branch the exemption silently evaporated and the gate refused the rung
      // again. It only ever looked right because the run that exposed the bug
      // happened to have an empty ready set.
      if (board[phase] === 'done' && await this.qaHolds(slug, phase)) return 'proceed';
      if (result.closed.includes(phase) || board[phase] === 'done') {
        const now = new Date().toISOString();
        const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        slot.lastOutcome = 'superseded';
        if (!state.resolved) autoResolveRun(state, board);
        try { saveRun(state); } catch { /* as above */ }
        this.emit('run:state', { state });
        // The urgent card this halt raised is now about nothing — stand it
        // down, with the quiet corrective push (same tag replaces the alarm).
        this.retractHalt(state, `the board already shows phase ${phase} done — records reconciled`, { push: true });
        return 'superseded';
      }
    }
    if (state.resolved) return 'resolved';
    if (opts.verb) {
      const ledger = state.recoveries?.[String(phase)]?.recovers;
      if (ledger && ledger.count >= RECOVER_MAX_PER_PHASE) return 'capped';
      if (ledger?.lastFingerprint && board) {
        const now = this.fingerprintFor(slug, state, board, read?.qa);
        if (now === ledger.lastFingerprint) return 'unchanged';
      }
    }
    return 'proceed';
  }

  /**
   * The evidence fingerprint over THIS console's facts — the converge pass's
   * function over the same inputs (`allLocks`, the gate stamp, the board's
   * QA), so a direct caller (the Recover press, the healer without a pass, a
   * test) answers "unchanged" exactly as the loop would.
   */
  protected fingerprintFor(slug: string, state: RunState, board: Record<number, string>, qa?: Parameters<typeof evidenceFingerprint>[4]): string {
    return evidenceFingerprint(state, board, this.allLocks().filter((lock) => lock.slug === slug), this.gateStampFor(slug), qa);
  }

  /**
   * What a finished recovery session actually achieved, checked rather than
   * assumed.
   *
   * The whole point of linking a session to a target is that its exit can be
   * answered with evidence: the board is re-read, the run re-resolved, the
   * plan re-validated. "The session ended" is not an outcome — every session
   * ends.
   */
  async recoveryOutcome(link: {
    kind: string; slug?: string; phase?: number; runId?: string;
  }): Promise<{ fixed: boolean; noDefect?: boolean; headline: string; detail: string }> {
    const slug = link.slug;
    if (!slug || !this.root) {
      return { fixed: false, headline: 'Recovery finished', detail: 'Nothing to check it against.' };
    }

    // The watcher may not have noticed the session's writes yet, and every
    // engine answer is cached by revision — so ask for a fresh read before
    // judging what the session achieved.
    this.reread(slug);

    if (link.kind === 'plan-repair') {
      // A repair launched for a verification-preflight park is judged by the
      // thing that parked the run: does every open phase now extract at least
      // one runnable command? `lint.ok` cannot judge it — F14 is warning-tier
      // and leaves lint green before AND after, which would call every such
      // repair "fixed" no matter what the session did.
      const pooled = this.runners.get(slug)?.current();
      const target = pooled && pooled.slug === slug && (!link.runId || pooled.id === link.runId)
        ? pooled
        : link.runId ? loadRun(this.root.path, slug, link.runId, this.liveRunId()) : null;
      if (target?.halt?.kind === 'verification-preflight') {
        const advisories = await this.verificationPreflight(
          slug, target.onlyPhases?.length ? target.onlyPhases : undefined);
        const fixed = advisories.length === 0;
        return {
          fixed,
          headline: fixed ? `${slug}'s §Verification is runnable` : `${slug} still has unrunnable §Verification`,
          detail: fixed
            ? 'Every open phase now extracts a runnable verification command — boarding will pass.'
            : advisories.join('; '),
        };
      }
      const lint = await this.lint(slug);
      const fixed = Boolean(lint?.ok);
      return {
        fixed,
        headline: fixed ? `${slug} validates` : `${slug} still has plan errors`,
        detail: fixed
          ? 'validate.sh exits 0 — the plan, its handoffs and its INDEX agree again.'
          : lint?.summary ?? 'validate.sh is still red — open the plan and look.',
      };
    }

    const phase = link.phase;
    if (phase == null) {
      return { fixed: false, headline: `Recovery for ${slug} finished`, detail: 'Check the board.' };
    }

    const board = await this.board(slug);
    const state = board.states[phase] ?? 'unknown';
    const fixed = state === 'done';
    if (fixed) {
      return {
        fixed,
        headline: `${slug} P${phase} is done`,
        detail: `The board now reads done — ${RECOVERY_TITLES[link.kind as RecoveryClass] ?? 'the recovery'} worked.`,
      };
    }
    // Before scoring a miss a failure, ask whether there was anything to fix:
    // a verification-shaped recovery whose commands all pass found NO DEFECT,
    // and "found nothing wrong" must not read as "failed to fix" — that
    // scoring is what left halts standing over healthy phases.
    if (link.kind === 'halted-verification') {
      const run = this.runners.get(slug)?.current()
        ?? (this.root ? listRuns(this.root.path, slug, this.liveRunId()).find((r) => r.phases[String(phase)]) : null);
      const record = run?.phases[String(phase)];
      const text = this.store?.get(slug)?.plan?.phases[phase]?.verification;
      if (run && text) {
        try {
          const verification = await verifyPhase(text, {
            cwd: join(run.root, record?.verifiedIn ?? '.'),
            timeoutMs: 5 * 60_000,
          });
          if (verification.ran.length && verification.ran.every((r) => r.ok)) {
            return {
              fixed: false,
              noDefect: true,
              headline: `${slug} P${phase}: nothing to fix`,
              detail: 'Every verification command is green — the recovery found no defect, '
                + 'so the halt is stood down rather than re-armed.',
            };
          }
        } catch { /* an unrunnable re-check keeps the honest miss below */ }
      }
    }
    return {
      fixed,
      headline: `${slug} P${phase} is still ${state}`,
      detail: 'The recovery session ended without moving the board — inspect it before starting another.',
    };
  }

  /**
   * Move the run record to where the board says it now is — the write-back
   * half of a recovery session's exit.
   *
   * `recoveryOutcome` computes the verdict; this makes it true on the run. For
   * a while the verdict went only into a notification, so the phase stayed
   * `failed`, the run stayed `halted`, and the button that had just worked was
   * offered again. Three rules keep the write safe:
   *
   *  - **Never under a live loop.** A busy runner owns its state, and the
   *    resumed loop re-reads the board anyway.
   *  - **The pooled object first.** `runFor` prefers an idle Runner's
   *    in-memory state over disk, so when the pool still holds this run, THAT
   *    object is the one rewritten — a disk-only edit would be shadowed until
   *    the next restart.
   *  - **Annotation on a miss.** A not-fixed outcome only records the attempt;
   *    the halt keeps standing and keeps its words.
   *
   * On success the run lands on `parked` with `Runner.recover`'s own wording —
   * one vocabulary for both recovery paths, and the state auto-continue and
   * the Continue button both already consume.
   */
  syncRecoveredRun(
    link: { kind: string; slug?: string; phase?: number; runId?: string },
    outcome: { fixed: boolean; noDefect?: boolean; headline?: string; detail?: string },
    by = 'an AI recovery session',
  ): RunState | null {
    const slug = link.slug;
    if (!slug || !this.root?.ok) return null;

    const pooled = this.runners.get(slug);
    if (pooled?.busy()) {
      // The loop owns the state — hand it the write instead of skipping it.
      // Returning null here (which this did) is how records stayed `failed`
      // forever while the resumed run drove past them: auto-continue
      // restarts the run inside the same exit handler, so the race was
      // structural, not incidental. Only positive verdicts are queued; a
      // true miss keeps the halt standing by design.
      if (link.phase != null && link.kind !== 'plan-repair' && (outcome.fixed || outcome.noDefect)) {
        pooled.enqueueResolution({
          phase: link.phase,
          outcome: outcome.fixed ? 'done' : 'no-defect',
          by,
        });
        return pooled.current();
      }
      return null;
    }
    const held = pooled?.current();
    const target = held && held.slug === slug && (!link.runId || held.id === link.runId)
      ? held
      : link.runId
        ? loadRun(this.root.path, slug, link.runId, this.liveRunId())
        : latestRun(this.root.path, slug, this.liveRunId());
    if (!target) return null;
    if (!RESOLVABLE.includes(target.status) && target.status !== 'parked') return null;

    const now = new Date().toISOString();
    const phase = link.phase;

    // A plan repair for a run that PARKED at the verification preflight: the
    // parked phases never ran, so "fixed" must not mark anything done — they
    // go back to pending, the halt clears, and the auto-continue resume
    // boards them again through the same preflight that parked them. Checked
    // by the halt's own kind, read BEFORE anything clears it, and checked
    // ahead of the generic phase branch below — which would otherwise write
    // `done` on a phase that has not spent a minute.
    if (link.kind === 'plan-repair' && target.halt?.kind === 'verification-preflight') {
      const slotKey = phase != null ? String(phase) : 'plan';
      return this.writeStoredRun(target, (state) => {
        const slot = ((state.recoveries ??= {})[slotKey] ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        if (!outcome.fixed) {
          if (state.halt?.reason) slot.lastReason = state.halt.reason;
          delete slot.fixed;
          return;
        }
        for (const record of Object.values(state.phases)) {
          if (record.status !== 'parked') continue;
          if (!VERIFICATION_PARK_NOTE.test(record.note ?? '')) continue;
          record.status = 'pending';
          record.note = undefined;
          record.endedAt = undefined;
          delete record.preflight;
          delete record.mcpDegraded;
        }
        slot.fixed = true;
        delete slot.lastReason;
        state.halt = null;
        state.consecutiveFailures = 0;
        state.resolved = null;
        state.reopenedAt = null;
        state.status = 'parked';
        state.finishedReason = `the plan's §Verification is runnable again — repaired by ${by}. `
          + 'Continue to carry on through the rest of the plan.';
      });
    }

    if (link.kind === 'plan-repair' && phase == null) {
      if (!outcome.fixed) return null;
      // A repair may only clear a halt that was ABOUT the plan's paperwork —
      // by kind, or by the words on a record written before kinds existed.
      const halt = target.halt;
      const lintHalt = halt != null
        && (halt.kind === 'plan-lint' || (!halt.kind && /validate\.sh|plan error/i.test(halt.reason)));
      if (!lintHalt) return null;
      return this.writeStoredRun(target, (state) => {
        state.halt = null;
        state.resolved = null;
        state.reopenedAt = null;
        state.status = 'parked';
        state.finishedReason = `the plan validates again — closed by ${by}. `
          + 'Continue to carry on through the rest of the plan.';
        const slot = ((state.recoveries ??= {}).plan ??= { attempts: 0, lastAt: now });
        slot.lastAt = now;
        slot.fixed = true;
      });
    }

    if (phase == null) return null;

    return this.writeStoredRun(target, (state) => {
      const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: now });
      slot.lastAt = now;
      if (outcome.noDefect && !outcome.fixed) {
        // The recovery concluded nothing was wrong. Clearing the halt and
        // resolving the stop is the honest write; inventing `done` on a
        // phase the board does not show done is not — the record keeps its
        // status, annotated by the resolution.
        slot.lastOutcome = 'no-defect';
        delete slot.lastReason;
        state.halt = null;
        retirePhaseHalt(state.phases[String(phase)]);
        state.consecutiveFailures = 0;
        state.resolved ??= {
          at: now,
          auto: true,
          reason: `a recovery by ${by} found nothing wrong — ${outcome.detail ?? outcome.headline ?? 'verification passes'}`,
        };
        return;
      }
      if (!outcome.fixed) {
        // The failed attempt is bookkeeping the auto-recovery budget reads;
        // the halt keeps standing so the operator still sees why it stopped.
        if (state.halt?.reason) slot.lastReason = state.halt.reason;
        delete slot.fixed;
        slot.lastOutcome = 'failed';
        return;
      }
      const record = phaseRecord(state, phase);
      record.status = 'done';
      record.endedAt ??= now;
      record.note = `closed by ${by}`;
      slot.fixed = true;
      slot.lastOutcome = 'fixed';
      delete slot.lastReason;
      state.halt = null;
      // The stored twin of `Runner.runRecovery`'s retire. Without it a phase its
      // own recovery had just closed still carried a `verify-failed` ending, and
      // the classifier read it (arm 11, `verify-red`) over the `done-unrecorded`
      // the evidence actually supports.
      retirePhaseHalt(record);
      state.consecutiveFailures = 0;
      // Same rule as `start` on resume: the resolution was about the stop this
      // recovery just ended, and left in place it silences the next one's card.
      state.resolved = null;
      state.reopenedAt = null;
      state.status = 'parked';
      state.finishedReason = `phase ${phase} was closed by ${by}. `
        + 'Continue to carry on through the rest of the plan.';
    });
  }

  /**
   * Launch the recovery agent for a halted run, if — and only if — every guard
   * passes. The unattended half of the Fix-with-AI button.
   *
   * The guards run in the order a person would apply them: is the run even
   * asking to be healed, is the halt a kind an agent clears, is the console
   * allowed to spawn agents, is there budget left, and did the *identical*
   * failure already burn an attempt (a loop that fails the same way twice is a
   * person's to read, not a third session's). The attempt counter is bumped
   * and persisted BEFORE the mint, so a console that dies mid-recovery
   * relaunches at most what the budget still allows on the next boot.
   */
  /**
   * Commits that landed since the newest settled rung began — the evidence
   * `ladderExtendOnProgress` extends a spent rung count on. Counted in the
   * phase's scoped repositories, the way `workEvidence` counts for the
   * classifier; null when no rung has settled yet (nothing to count from).
   */
  private async progressSinceLastRung(
    slug: string, phase: number, slot: { rungs?: RungRecord[] } | undefined,
  ): Promise<{ commits: number; since: string } | null> {
    const last = lastSettledRung(slot);
    if (!last) return null;
    const deps = this.evidenceDeps(slug);
    const dirs = await Promise.resolve(deps.repos?.(slug, phase) ?? []).catch((): string[] => []);
    const work = await workEvidence(deps.git ?? gitIn(deps.root), last.at, dirs).catch(() => null);
    return { commits: work?.commits ?? 0, since: last.at };
  }

  /**
   * Why the ladder's rungs cannot be driven on THIS console — named on the
   * errand, because `nextRung`'s "no rung … is available on this console yet"
   * reached the journal and never the person who could act (measured: four
   * `plan-broken` stand-downs and two `foreign-stale`, each with a card that
   * read as if no rung existed). It used to answer for three situations by
   * name; since phase 10 (RCV-7) it answers for EVERY table `resolveVehicle`
   * refuses, rung by rung, from the refusal reasons themselves — the flag, the
   * preference, the clock, the account, the missing ref. Null only when some
   * rung is drivable, because then the ladder climbs and no sentence is owed.
   * The drive loop reads the same answer through `RunnerDeps.rungUnavailable`.
   */
  protected unavailableRungHint(
    situation: Situation, record: RunPhaseRecord | undefined, evidence: PhaseEvidence | null,
    slug: string, state: RunState | null,
  ): string | null {
    return undrivableSentence(situation.key, this.rungRefusals(situation, record, evidence, slug, state));
  }

  /**
   * The `wait-heal` rung, driven (phase 10): a `require` MCP park still on
   * its clock. The timer is re-armed — a restart may have lost it — and the
   * rung is accounted ONCE per park, so the ladder card says who is working
   * and the flip (`continueMcpParkedRecord`) settles it when the clock fires.
   * Written through `slot.rungs` directly rather than `accountRung`, like the
   * flip: nothing launched, so the legacy launch counter must not move.
   */
  private driveWaitHeal(
    slug: string, state: RunState, phase: number, situation: Situation,
    vehicle: { kind: 'wait-heal'; until: string }, journal: Journal, signed: { by: string; trigger: string },
  ): void {
    const record = state.phases[String(phase)];
    const parkedAt = record?.mcpPark?.at ?? '';
    const slot = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: new Date().toISOString() });
    const held = (slot.rungs ?? []).some((r) => r.rung === 'wait-heal' && r.situation === situation.key && r.at >= parkedAt);
    if (!held) {
      const at = new Date().toISOString();
      (slot.rungs ??= []).push({ situation: situation.key, rung: 'wait-heal', at, outcome: 'running', note: `waits until ${vehicle.until}` });
      slot.lastAt = at;
      journal.append('phase.rung', {
        situation: situation.key, rung: 'wait-heal', params: null, vehicle: 'timer', attempt: slot.attempts,
        by: signed.by, trigger: signed.trigger, until: vehicle.until,
      }, phase);
      try { saveRun(state); } catch { /* the timer matters more than the write */ }
    }
    this.armMcpRequireTimer(slug, phase, Date.parse(vehicle.until));
  }

  /**
   * The service's ONE settlement door (phase 10, RCV-6): settle the phase's
   * newest open rung and write `phase.rung-settled` with the whole payload —
   * situation, params, cost, note. Every `settleRung` under `service*.ts`
   * goes through here (`test/invariants.test.ts` holds it), so the journal
   * can never again carry a settlement that says only `{outcome, rung}`.
   * Answers the settled record, or null when nothing was open.
   */
  protected settleRungOn(
    state: RunState, phase: number, outcome: NonNullable<RungRecord['outcome']>, note?: string, costUsd?: number,
  ): RungRecord | null {
    const slot = state.recoveries?.[String(phase)];
    if (!slot) return null;
    const settled = settleRung(slot, outcome, costUsd, note);
    if (settled && this.root?.ok) {
      new Journal(this.root.path, state.slug, state.id).append('phase.rung-settled', rungSettledPayload(settled), phase);
    }
    return settled;
  }

  async maybeAutoRecover(
    slug: string,
    pass: { trigger?: string; fingerprint?: string } = {},
  ): Promise<AutoRecoverResult> {
    const no = (reason: string, extra: Partial<AutoRecoverResult> = {}): AutoRecoverResult =>
      ({ launched: false, reason, ...extra });
    // Who is classifying (RCV-9): the healer, on whichever trigger woke the
    // convergence loop — every `phase.situation` and `phase.rung` this pass
    // writes carries the word, the runner's own climb writes `drive`.
    const by: ClassifiedBy = 'heal';
    const trigger = pass.trigger ?? 'direct';
    const healActor = (situation: string, rung: string, attempt: number, perPhase: number): StartActor =>
      doorActor('converge-heal', {
        by, via: viaOfTrigger(trigger), origin: `converge:${trigger}`,
        trigger: situation, guard: `ladder:${rung}`, counter: `ladderPerPhaseRungs:${attempt}/${perPhase}`,
      });
    if (!this.root?.ok) return no('no source directory is open');
    if (this.liveRunner(slug)) return no('the run is live again');

    const state = await this.runFor(slug);
    if (!state) return no('no run of that plan');
    if (!state.autoRecover) return no('the run opted out of auto-recovery');

    // Settle every rung left open by an earlier climb — by the RUNG'S OWN
    // GOAL, never by the record. `record.status === 'done'` was the old
    // judge, and for a QA rung it is always true (the phase finished before
    // the verdict was owed): a shutdown-killed resume with zero turns settled
    // `fixed`, the one-rung table exhausted, and a pending verdict held nine
    // phases for sixteen hours. A rung whose session never effectively ran
    // settles `interrupted` and may climb again (the numeric caps still count
    // it); a rung whose goal is met settles `fixed` even when its phase has
    // left the candidate list — which is also why this runs BEFORE the early
    // returns below, and persists what it settles.
    {
      let touched = false;
      for (const [key, slot] of Object.entries(state.recoveries ?? {})) {
        if (!slot?.rungs?.some((r) => r.outcome === 'running')) continue;
        const phaseNo = Number(key);
        if (!Number.isFinite(phaseNo)) continue;
        const record = state.phases[key];
        const open = [...slot.rungs].reverse().find((r) => r.outcome === 'running')!;
        const sitId = String(open.situation ?? '').split(':')[0];
        let outcome: 'fixed' | 'no-defect' | 'failed' | 'interrupted';
        let note: string;
        // A standing `widen-rule` card is a rung still running (phase 9): the
        // record is `parked` with a declaration behind it, which the `no-defect`
        // arm below would otherwise score on the very next pass — exhausting
        // the one-rung table while the card was still up. Its answer settles
        // it (`widenDecided`, the healer's `decided`); a card that is GONE with
        // the rung still open is a console restart, and reads `interrupted`.
        if (open.rung === 'widen-rule') {
          if (open.cardId && this.approvals.isPending(open.cardId)) continue;
          outcome = 'interrupted';
          note = 'the widen card is gone — the console restarted under it, or it was answered before the rung could settle';
        } else if (open.rung === 'wait-heal' && record?.mcpPark) {
          // A `require` park's wait rung is the timer's (phase 10): the flip
          // settles it when the clock fires — or the healer's own next pass,
          // past the clock, climbs `mcp-continue` and flips. Scoring it here
          // ("the record reads parked") settled it `failed` before the flip,
          // which then wrote a second `wait-heal` retroactively.
          continue;
        } else if (sitId === 'qa-pending' || sitId === 'qa-failed') {
          const verdict = await this.qaVerdict(slug, phaseNo);
          const met = sitId === 'qa-pending'
            ? verdict !== 'pending' && verdict !== 'none'
            : verdict === 'pass' || verdict === 'waived';
          // The record follows the ledger here too, not only when the ladder
          // next climbs: a round the resumed session recorded lands on the
          // run page now, and a situation the verdict has answered does not
          // go on painting "QA failed" over a pass (measured: an hour on
          // phase-console-commerce phase 8).
          if (record) {
            if (mergeQaHistory(record, await this.qaHistory(slug, phaseNo))) touched = true;
            if (met && String(record.situation?.key ?? '').startsWith('qa-')) { delete record.situation; touched = true; }
          }
          if (met) { outcome = 'fixed'; note = `a QA verdict is recorded (${verdict})`; }
          else if (!open.turns) { outcome = 'interrupted'; note = 'the session never effectively ran — no turns before it ended'; }
          else if (consoleEnded(open.endedBy)) { outcome = 'interrupted'; note = `the console ended the session (${open.endedBy}) before its turn was done`; }
          else { outcome = 'failed'; note = `the verdict is still ${verdict}`; }
        } else if (open.rung === 'resume-own-session' && !open.turns && record?.status !== 'done') {
          outcome = 'interrupted'; note = 'the session never effectively ran — no turns before it ended';
        } else if (open.rung === 'resume-own-session' && consoleEnded(open.endedBy) && record?.status !== 'done') {
          // Interrupted turns are booked honestly now, so zero turns is no
          // longer the only witness to a session the console cut short.
          outcome = 'interrupted'; note = `the console ended the session (${open.endedBy}) before its turn was done`;
        } else if (record?.status === 'done') {
          outcome = 'fixed'; note = 'the record reads done';
        } else if ((record?.status === 'parked' || record?.status === 'waiting') && record?.declared) {
          // The rung's session did its job: it re-checked and DECLARED the
          // phase parked (a wait, a blocker, a person). Scoring that `failed`
          // is what escalated a production outage up the model ladder and
          // spent the budget on three identical confirmations.
          outcome = 'no-defect';
          note = `the session declared ${record.declared.status}`
            + (record.declared.reason ? `: ${record.declared.reason.replace(/\s+/g, ' ').slice(0, 120)}` : '');
        } else {
          outcome = 'failed'; note = `the record reads ${record?.status ?? 'absent'}`;
        }
        if (this.settleRungOn(state, phaseNo, outcome, note)) touched = true;
      }
      // A standing qa errand whose ask is now ANSWERED dissolves with the
      // same sweep — the verdict is the rung's goal, and a satisfied ask left
      // on the record renders as a false "needs you" for as long as the run
      // lives (the inbox suppresses it from the same authority; this heals
      // the record itself).
      for (const [key, slot] of Object.entries(state.recoveries ?? {})) {
        const sitId = String(slot?.errand?.situation ?? '').split(':')[0];
        if (sitId !== 'qa-pending' && sitId !== 'qa-failed') continue;
        const phaseNo = Number(key);
        if (!Number.isFinite(phaseNo)) continue;
        const verdict = await this.qaVerdict(slug, phaseNo);
        const answered = sitId === 'qa-pending'
          ? verdict !== 'pending' && verdict !== 'none'
          : verdict === 'pass' || verdict === 'waived';
        if (!answered) continue;
        delete slot!.errand;
        const record = state.phases[key];
        if (record) {
          mergeQaHistory(record, await this.qaHistory(slug, phaseNo));
          if (String(record.situation?.key ?? '').startsWith('qa-')) delete record.situation;
        }
        touched = true;
        new Journal(this.root.path, slug, state.id).append(
          'phase.errand-cleared', { situation: sitId, verdict }, phaseNo,
        );
      }
      if (touched) { try { saveRun(state); } catch { /* the verdict matters more than the write */ } }
    }

    /* Resolve-first, for the halt's own phase when there is one: the board is
     * re-read, records it has overtaken close, the halt about them dissolves
     * and nothing is launched for finished work. A standing resolution is an
     * answer somebody already gave. (The same gate runs again on the anchor
     * below — idempotent, and the anchor may be a different phase.) */
    if (state.halt?.phase != null) {
      const gate = await this.preRecoveryGate(slug, state, state.halt.phase);
      if (gate === 'superseded') {
        return no('the board had already moved past the halt — records reconciled, nothing to launch');
      }
      if (gate === 'resolved') return no('the stop is already resolved');
    } else if (state.resolved) {
      return no('the stop is already resolved');
    }

    /* The anchor is no longer "the halt's phase, else the active phase": every
     * open record is CLASSIFIED (runner/situation.ts) and the anchor is the
     * first whose situation has a rung this console can climb (runner/
     * ladder.ts). That is what cures the measured dead end — a parked run
     * whose only open record was `interrupted` had no halt phase and no active
     * phase, so the old derivation answered "no phase to anchor a recovery
     * on" about a phase that had simply never started. */
    // A board the console could not read is not evidence of anything, and this
    // is the one caller that SPENDS on what it concludes. `boardStates` handed
    // it `{}` — no phase done, no phase waiting — and the healer classified,
    // chose an anchor and could climb a billed rung on that emptiness. Refuse.
    const read = await this.board(slug);
    if (read.error) return no(`the console could not read the board: ${read.error}`);
    const board = read.states;
    // ONE cache for the whole pass (RCV-9): `git status` per scope directory,
    // the plan's health and each gate read are asked once, however many
    // candidates there are. The fingerprint is the converge pass's when it
    // handed one over, else the same function over the same facts — so a
    // direct caller (the Recover press, a test) gets the same "unchanged"
    // answer the loop would.
    const cache = newEvidenceCache();
    const fingerprint = pass.fingerprint ?? this.fingerprintFor(slug, state, board, read.qa);
    const candidates = await this.classifyOpenPhases(slug, state, board, cache);
    if (!candidates.length) {
      // No candidate does NOT mean nothing is wrong. The candidate list is
      // deliberately record-shaped — a phase the board reads done is closed by
      // reconcile, not diagnosed — so a plan wedged by a SETTLED phase (a
      // recorded QA verdict holding its dependents) yields none, and this used
      // to return here, before the errand/journal/push machinery. Converge then
      // swept the run every five minutes for ever, refused with the same
      // sentence each time, and never asked the one person who could fix it.
      //
      // The halt names the phase now (`plan-deadlocked`), and `classifyPhase`
      // reads the board and the QA table directly, so the ask is recoverable
      // without letting a done phase back into the candidate list.
      const anchor = state.halt?.phase;
      if (anchor == null) return no('no open phase of this run has a record to act on');
      try {
        const { situation } = await this.classifyPhase(slug, anchor, state, board, cache);
        if (situation.actor === 'person' || situation.actor === 'machine') {
          const journal = new Journal(this.root.path, slug, state.id);
          const errand = errandFor(situation.key, [], anchor, undefined,
            errandSaid(situation, state.phases[String(anchor)]?.said));
          // A standing errand is not rewritten: this arm runs on every sweep,
          // and each rewrite re-pushed the same ask with a fresh clock.
          const standing = state.recoveries?.[String(anchor)]?.errand;
          if (sameErrand(standing, errand)) {
            return no(`phase ${anchor} reads ${situation.label} — ${situation.label} is a person's to settle (the errand has stood since ${standing!.at})`,
              { phase: anchor, situation: situation.key, label: situation.label });
          }
          this.editStoredRunById(slug, state.id, (stored) => {
            ((stored.recoveries ??= {})[String(anchor)] ??= { attempts: 0, lastAt: errand.at }).errand = errand;
          });
          journal.append('phase.errand', { ...errand }, anchor);
          this.announceErrand({ slug, runId: state.id, phase: anchor, errand });
          return no(`phase ${anchor} reads ${situation.label} — ${situation.label} is a person's to settle`,
            { phase: anchor, situation: situation.key, label: situation.label });
        }
      } catch (error) {
        log.warn('run.anchor-classify-failed', { slug, phase: anchor, error });
      }
      return no('no open phase of this run has a record to act on');
    }

    const journal = new Journal(this.root.path, slug, state.id);
    // ONE per-phase ceiling: the ladder's, from Settings ▸ Automation.
    //
    // There used to be a second — `state.autoRecover.attempts`, hardcoded `2`
    // by `newRun` and unreachable from the UI (the launch dialog's field is a
    // boolean). Both bounded the SAME counter: `accountRung` bumps
    // `slot.attempts` and appends to `slot.rungs` together, so an operator who
    // set `ladderPerPhaseRungs` to 3 still got two, with nothing on any screen
    // saying why — the measured run parked one rung short of its own fix,
    // refusing forever with "recovery budget is spent (2 launches)".
    // `autoRecover` now means only what the dialog offers: opted in, or not.
    const caps = ladderCaps(this.prefs);
    const recoveries = (state.recoveries ??= {});
    const runHistory = Object.values(recoveries).flatMap((slot) => slot.rungs ?? []);
    const totalAttempts = Object.values(recoveries).reduce((sum, slot) => sum + (slot.attempts ?? 0), 0);

    let chosen: {
      phase: number; evidence: PhaseEvidence; situation: Situation; rung: Rung; vehicle: DriveVehicle;
    } | null = null;
    let firstRefusal: AutoRecoverResult | null = null;
    const refuse = (reason: string, c: { phase: number; situation: Situation }) => {
      firstRefusal ??= { launched: false, reason, phase: c.phase, situation: c.situation.key, label: c.situation.label };
    };

    let reJournalled = 0;
    let unchanged = 0;
    for (const c of candidates) {
      const key = String(c.phase);
      const record = state.phases[key];
      const slot = recoveries[key];
      // Signed, and written ONCE per evidence (RCV-9): the same key from the
      // same fingerprint is what the record already says, and every pass
      // used to write it again — 1 332 lines, 1 249 of them unsigned, most
      // of them "still parked". The candidate is still walked and may still
      // climb; only the journal line is spared.
      const same = record?.situation?.key === c.situation.key && record?.situation?.fingerprint === fingerprint;
      if (same) unchanged += 1; else {
        reJournalled += 1;
        journal.append('phase.situation', {
          situation: c.situation.key, sub: c.situation.sub ?? null, label: c.situation.label, why: c.situation.why,
          by, trigger, fingerprint: fingerprint.slice(0, 200),
        }, c.phase);
      }
      if (record) record.situation = { key: c.situation.key, at: c.evidence.at, why: c.situation.why, fingerprint, by };

      /* A DECLARED park is the session's own testimony — a person was asked
       * (needs-human), or the world is being waited on. The ladder does not
       * spend sessions on testimony: it polls the machine-checkable refs and
       * resumes the phase's own session the moment they land; until then it
       * keeps the declared errand standing (replacing one a mis-classification
       * wrote over it) and stands down. A declared `blocked` WITHOUT checkable
       * refs keeps its designed one-shot unblock rung below. This arm is what
       * ended the aug-27 pattern: three sessions boarded overnight against a
       * production outage, each re-declaring the same park, each scored
       * `failed`, the ladder spent, the errand rewritten as "repair the plan".
       */
      const declaredPark = record?.declared
        && ['needs-human', 'waiting-external', 'blocked'].includes(record.declared.status)
        ? record.declared : null;
      const declaredRefs = declaredPark ? pollableRefs(declaredPark.watch ?? record?.watch) : [];
      if (declaredPark && record && (declaredPark.status !== 'blocked' || declaredRefs.length)) {
        // No poll here any more. Watching moved to `watch-scheduler.ts`, which
        // runs on its own timer and calls `onWatchLanded` the moment something
        // lands — rather than whenever a five-minute convergence sweep happened
        // to visit this plan, behind a `noops` latch that had every right to say
        // nothing had changed. What stays is this arm's real job: standing down,
        // and keeping the declared errand standing while it does.
        const slot2 = (recoveries[key] ??= { attempts: 0, lastAt: new Date().toISOString() });
        if (declaredPark.status === 'needs-human'
          && (!slot2.errand || parseSituationKey(slot2.errand.situation).id !== 'blocked-declared')) {
          const errand: Errand = {
            phase: c.phase,
            situation: c.situation.id === 'blocked-declared' ? c.situation.key : 'blocked-declared:unknown',
            at: new Date().toISOString(),
            tried: (slot2.rungs ?? []).map((r) => `${r.rung}${r.outcome ? ` → ${r.outcome}` : ''}`),
            need: declaredPark.reason ?? record.note ?? 'the session asked for a person',
            // The sub-kind's own remedy, then the watch note. One sentence for
            // every kind of blocker was the errand nobody could act on: a
            // permission wall names the policy, a credential names the sign-in.
            how: errandFor(c.situation.id === 'blocked-declared' ? c.situation.key : 'blocked-declared:unknown', [], c.phase).how
              + (declaredRefs.length ? ' The console is also watching its refs and resumes the session when they land.' : ''),
          };
          slot2.errand = errand;
          journal.append('phase.errand', { ...errand }, c.phase);
          this.announceErrand({ slug, runId: state.id, phase: c.phase, errand });
        }
        refuse(
          `phase ${c.phase} declared ${declaredPark.status}`
          + (declaredPark.reason ? `: ${declaredPark.reason.replace(/\s+/g, ' ').slice(0, 140)}` : '')
          + (declaredRefs.length ? ' — the console is watching its refs' : " — a person's to settle"),
          c,
        );
        continue;
      }

      if (c.situation.actor === 'wait' || c.situation.actor === 'none') {
        refuse(`phase ${c.phase} reads ${c.situation.label} — nothing to climb`, c);
        continue;
      }
      // A `require` MCP park still on its clock is the `wait-heal` rung being
      // climbed — by the timer, which continues the phase without its servers
      // when the clock runs out (re-armed here in case the console that parked
      // it is gone), while `healMcpParks` requeues it sooner if the server
      // heals. The rung is accounted ONCE per park (phase 10, RCV-10: the row
      // was refused by name and never climbed, 0 against 104 `phase.mcp`), so
      // the ladder card and the journal say who is working; the flip settles
      // it when the clock fires. Not an errand — that is written when the
      // clock fires, not while it is running.
      if (c.situation.id === 'mcp-unavailable') {
        const held = this.resolveVehicle(rungsFor(c.situation.key)[0], c.situation, record, c.evidence, slug, state);
        if ('vehicle' in held && held.vehicle.kind === 'wait-heal') {
          this.driveWaitHeal(slug, state, c.phase, c.situation, held.vehicle, journal, { by, trigger });
          refuse(`phase ${c.phase} is parked on an MCP server — it continues without it at `
            + `${held.vehicle.until} unless the server heals first`, c);
          continue;
        }
      }
      // The run's own per-phase launch cap (the launch dialog's number) and the
      // per-run cap still bound the healer, for the records and readers that
      // predate rungs; the ladder's caps apply on top.
      //
      // Both write the errand before refusing. They used to `refuse` and move
      // on in silence — and a spent budget is exactly when a person has to be
      // told: "everything the ladder had was tried and none of it worked" is
      // the most actionable thing this system ever knows, and it was the one
      // case that said nothing. (`ladder.ts`'s own exhaustion path always did.)
      const askFor = (c2: { phase: number; situation: Situation }) => {
        const key2 = String(c2.phase);
        const slot2 = (recoveries[key2] ??= { attempts: 0, lastAt: new Date().toISOString() });
        if (slot2.errand) return;
        const errand = errandFor(c2.situation.key, slot2.rungs ?? [], c2.phase, undefined,
          errandSaid(c2.situation, state.phases[key2]?.said));
        slot2.errand = errand;
        journal.append('phase.errand', { ...errand }, c2.phase);
        this.announceErrand({ slug, runId: state.id, phase: c2.phase, errand });
      };
      // No per-phase check here any more — `nextRung` owns it (`perPhaseRungs`
      // against `history.length`), writes the errand through the exhaustion
      // path below, and says which cap and how much of it is spent.
      //
      // The run-wide ceiling is the LADDER's, not a second hardcoded number.
      // `if (totalAttempts >= 5)` contradicted `ladderPerRunRungs` in Settings:
      // an operator who raised the budget to 20 still got five, with nothing
      // saying why.
      if (totalAttempts >= caps.perRunRungs) {
        askFor(c);
        return no(`the run recovery budget is spent (${caps.perRunRungs} launches)`,
          { phase: c.phase, situation: c.situation.key, label: c.situation.label });
      }

      // A legacy slot that tried the identical failure once, before rungs were
      // recorded, is read as having climbed the rung the old healer drove —
      // the own session when it had one, the agent otherwise — so the ladder
      // escalates from there instead of repeating it.
      const history: typeof runHistory = slot?.rungs ? [...slot.rungs] : [];
      if (!slot?.rungs && slot?.lastReason && state.halt?.reason === slot.lastReason && (slot.attempts ?? 0) >= 1) {
        const resumable = Boolean(record?.sessionId ?? record?.resumeSessionId);
        for (const rung of rungsFor(c.situation.key)) {
          const own = rung.vehicle === 'resume-own-session' || rung.vehicle === 'closeout-own-session' || rung.vehicle === 'unblock-session';
          const agent = rung.vehicle === 'fix-agent' || rung.vehicle === 'closeout-agent' || rung.vehicle === 'plan-repair-agent';
          if ((resumable && own) || (!resumable && agent)) {
            history.push({ situation: c.situation.key, rung: rung.vehicle, at: slot.lastAt, outcome: 'failed', ...(rung.params ? { params: rung.params } : {}) });
          }
        }
      }
      // A launch this phase already SPENT counts against the phase's one
      // ceiling even when no rung records it. `accountRung` moves `attempts`
      // and `rungs` together, so for anything this build wrote they are equal
      // and this pads nothing; it matters only for slots written before rungs
      // existed, where `attempts` is the sole record of the spend. Without it,
      // deleting the old `autoRecover.attempts` cap (P6/D5) would have handed
      // exactly those runs a fresh budget — the opposite of one ceiling. The
      // padding is opaque on purpose: it names no vehicle, so it can only be
      // COUNTED, never mistaken for a rung already tried.
      for (let i = history.length; i < (slot?.attempts ?? 0); i += 1) {
        history.push({ situation: c.situation.key, rung: 'legacy-attempt', at: slot!.lastAt, outcome: 'failed' });
      }

      const climbInput = {
        // The same day budget the runner's own climb counts against, so the
        // loop's rungs and the healer's cannot each spend it in full.
        situation: c.situation.key, history, runHistory, caps, dayHistory: this.dayRungs(),
        available: (rung: Rung) => this.vehicleForRung(rung, c.situation, record, c.evidence, slug, state) !== null,
      };
      let next = nextRung(climbInput);
      // One more rung when the newest settled rung landed commits
      // (`ladderExtendOnProgress`, off by default; once per phase; the dollar
      // caps stand). Measured before this existed: fourteen work-in-progress
      // errands for phases whose sessions were committing right up to the count.
      if (!next.ok && next.exhausted && this.prefs.ladderExtendOnProgress === true && !slot?.extended) {
        const progress = await this.progressSinceLastRung(slug, c.phase, slot);
        const widened = progressExtension(next, slot, caps, (progress?.commits ?? 0) > 0, true);
        if (widened && progress) {
          const at = new Date().toISOString();
          (recoveries[key] ??= { attempts: 0, lastAt: at }).extended = {
            at, commits: progress.commits, since: progress.since, situation: c.situation.key,
          };
          journal.append('phase.ladder-extended', {
            situation: c.situation.key, commits: progress.commits, since: progress.since,
            was: next.reason, perPhaseRungs: widened.perPhaseRungs, by: 'ladderExtendOnProgress',
          }, c.phase);
          next = nextRung({ ...climbInput, caps: { ...caps, ...widened } });
        }
      }
      if (!next.ok) {
        if (next.exhausted || c.situation.actor === 'person') {
          // A `plan-broken` card quotes the health issue that raised it. The
          // table's fixed sentence ("make it pass validate.sh") was written 50
          // times for plans whose validate.sh was green — an instruction nobody
          // could act on, about a defect nobody could find (R3).
          const planIssue = c.situation.id === 'plan-broken'
            ? c.evidence?.health?.find((i) => i.phase == null || i.phase === c.phase)
            : null;
          const errand = errandFor(
            c.situation.key, slot?.rungs ?? [], c.phase, undefined,
            // The session's own words when they ARE the evidence — the one
            // rule for both paths (RCV-7, `errandSaid`): a refusal, a skill
            // that would not load, the organisation that said no.
            errandSaid(c.situation, record?.said),
            c.situation.id === 'plan-broken'
              ? {
                kind: planIssue?.kind ?? c.situation.sub,
                detail: planIssue?.detail ?? c.situation.why[0],
                // `plan-broken:lint` IS the lint being red; nothing else here
                // has run validate.sh, and claiming a verdict we do not have is
                // exactly the failure this errand exists to stop repeating.
                ...(c.situation.sub === 'lint' ? { validateOk: false } : {}),
              }
              : null,
            null,
            // The console's own denial, so a permission errand names the rule
            // and the command rather than "a tool" (LFC-3).
            record?.toolDenied && record.toolDenied.rule !== 'in-turn-wait' ? record.toolDenied : null,
            // The answer in force for this situation's manifest row (phase 11,
            // ZTD-10): the run's manifest, this console's `policy.<key>`, the
            // shipped default — the same reading the drive loop makes.
            policyForSituation(c.situation.key, state, policyPrefsOf(this.prefs)),
          );
          // A class whose row answered AUTOMATICALLY is not a person's: the
          // ruling is journalled under its decision key, once per answer per
          // phase, and acted on where the console can act — never an errand,
          // never a push. `blocked-declared:unknown` is pinned and never lands here.
          if (errand.policy) {
            const answered = recoveries[key]?.policyAnswered;
            if (answered && answered.decisionKey === errand.decisionKey && answered.answer === errand.policy.answer) {
              refuse(`phase ${c.phase} reads ${c.situation.label} — answered by policy (${errand.decisionKey} = ${errand.policy.answer}, since ${answered.at})`, c);
              continue;
            }
            (recoveries[key] ??= { attempts: 0, lastAt: errand.at }).policyAnswered = {
              decisionKey: errand.decisionKey!, answer: errand.policy.answer, source: errand.policy.source, at: errand.at,
            };
            journal.append('phase.policy-answered', {
              ...policyAnsweredPayload({ ...errand, decisionKey: errand.decisionKey! }),
              label: c.situation.label, reason: next.reason, by, trigger,
            }, c.phase);
            if (errand.decisionKey === 'qa.exhausted' && errand.policy.answer === 'waive') {
              const rounds = (record?.qa ?? []).filter((entry) => entry.verdict === 'fail').length;
              const result = await this.qaWaive(slug, c.phase, {
                reason: `QA exhausted after ${rounds} failed round${rounds === 1 ? '' : 's'} — waived by policy `
                  + `(qa.exhausted: waive, from the ${errand.policy.source})`,
                by: 'policy',
              }).catch((error: unknown) => ({ ok: false, detail: String((error as Error)?.message ?? error) }));
              if (result.ok) {
                journal.append('phase.qa-waived', {
                  by: 'policy', decisionKey: errand.decisionKey, source: errand.policy.source, rounds,
                }, c.phase);
              } else {
                // The policy could not act: the person's ask stands after all.
                const { policy: _policy, ...asked } = errand;
                recoveries[key]!.policyAnswered = undefined;
                recoveries[key]!.errand = asked;
                journal.append('phase.errand', {
                  ...asked, reason: `qa.exhausted: waive could not record the verdict — ${result.detail}`, by,
                }, c.phase);
                this.announceErrand({ slug, runId: state.id, phase: c.phase, errand: asked });
              }
            }
            refuse(`phase ${c.phase} reads ${c.situation.label} — answered by policy (${errand.decisionKey} = ${errand.policy.answer}, from the ${errand.policy.source})`, c);
            continue;
          }
          // The ladder's rungs were there and THIS console could not drive
          // them: name each and why, or the card reads as if no rung existed.
          const hint = /^no rung for /.test(next.reason)
            ? this.unavailableRungHint(c.situation, record, c.evidence, slug, state)
            : null;
          if (hint) errand.how = `${errand.how} ${hint}`;
          // A standing errand is not rewritten: this path runs on every sweep
          // for every person's situation, and each rewrite re-pushed the same
          // ask with a fresh clock (51 times in a day for one manual gate).
          // The RUN's own errand counts as standing too (phase 9): a credential
          // wall writes its errand at the halt, run-level, and a phase-level
          // twin here would be one wall asked about twice.
          const standing = recoveries[key]?.errand
            ?? (state.errand && state.errand.situation === c.situation.key ? state.errand : undefined);
          if (sameErrand(standing, errand) || (standing && standing === state.errand)) {
            refuse(`phase ${c.phase} reads ${c.situation.label} — ${next.reason} (the errand has stood since ${standing!.at})`, c);
            continue;
          }
          (recoveries[key] ??= { attempts: 0, lastAt: errand.at }).errand = errand;
          // A cap refusal is a journal line, not only a sentence (RCV-6):
          // written beside the errand it produced, once — the errand's own
          // dedupe above is what keeps a sweep from repeating it.
          const cap = capRefusal(next);
          if (cap) journal.append('phase.ladder-refused', { situation: c.situation.key, ...cap, by, trigger }, c.phase);
          journal.append('phase.errand', { ...errand }, c.phase);
          // The healer's errands push on the same channel and through the same
          // dedupe as the runner's. Which of the two exhausted the ladder is an
          // implementation detail; being asked twice is not.
          this.announceErrand({ slug, runId: state.id, phase: c.phase, errand });
        }
        refuse(`phase ${c.phase} reads ${c.situation.label} — ${next.reason}`, c);
        continue;
      }
      const vehicle = this.vehicleForRung(next.rung, c.situation, record, c.evidence, slug, state);
      if (!vehicle) { refuse(`phase ${c.phase} reads ${c.situation.label} — ${next.rung.label} cannot be driven here`, c); continue; }
      chosen = { ...c, rung: next.rung, vehicle };
      break;
    }
    try { saveRun(state); } catch { /* the verdict matters more than the write */ }
    this.emit('run:state', { state });
    log.info('run.heal-pass', {
      slug, runId: state.id, trigger, candidates: candidates.length, journalled: reJournalled, unchanged,
      shellOutsSaved: cache.hits, chose: chosen ? chosen.phase : null,
    });
    if (!chosen) return firstRefusal ?? no('nothing the autopilot can climb');

    const { phase, situation, rung, vehicle } = chosen;
    const key = String(phase);
    const gate = await this.preRecoveryGate(slug, state, phase);
    if (gate === 'superseded') {
      return no('the board had already moved past the halt — records reconciled, nothing to launch', { phase, situation: situation.key, label: situation.label });
    }
    if (gate === 'resolved') return no('the stop is already resolved', { phase, situation: situation.key, label: situation.label });
    // 🔴 Said once the rung is CHOSEN and the gate has let it through — not
    // inside `climb()`, and not before `preRecoveryGate`. A plan-shaped
    // repair that had to skip its FREE rung must say so however the climb then
    // ends — and the case that most needs saying is a console with NEITHER flag,
    // where the launch refuses before `climb()` ever runs and the operator was
    // told only about `--allow-agent`: the expensive one. `vehicleForRung`
    // answers null for the script without `--allow-writes`, which is right (a
    // rung that reported "climbable" and then refused made the paid rung behind
    // it unreachable) — but silence there charges an operator for a session they
    // could have had for nothing and never tells them why.
    if (situation.id === 'plan-broken' && !this.flags.allowWrites && rung.vehicle !== 'plan-repair-script') {
      journal.append('phase.rung-unavailable', {
        rung: 'plan-repair-script',
        chose: rung.vehicle,
        reason: 'the deterministic repair edits INDEX.md, handoff frontmatter and lock files, so it needs '
          + '--allow-writes; this console reached for the paid rung instead',
      }, phase);
    }

    const answer = (extra: Partial<AutoRecoverResult> = {}): AutoRecoverResult =>
      ({ launched: true, phase, situation: situation.key, label: situation.label, rung: rung.vehicle, vehicle: vehicle.kind, ...extra });
    const now = new Date().toISOString();
    const slot = (recoveries[key] ??= { attempts: 0, lastAt: now });
    const climb = () => {
      // Recorded BEFORE the spend, so a console that dies mid-rung still
      // remembers it tried — and the old `attempts`/`lastAt` move with it.
      accountRung(slot, { situation: situation.key, rung: rung.vehicle, params: rung.params, at: now, note: rung.label });
      if (state.halt?.reason) slot.lastReason = state.halt.reason;
      saveRun(state);
      this.emit('run:state', { state });
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: rung.params ?? null, vehicle: vehicle.kind, attempt: slot.attempts, by, trigger }, phase);
      log.info('run.auto-recovery', { slug, runId: state.id, phase, situation: situation.key, rung: rung.vehicle, vehicle: vehicle.kind, attempt: slot.attempts });
      // Plan progress about a phase, not a session ending — on `session` the
      // deep link landed on the terminal list and the card read "A session
      // ended" about a recovery that had just begun.
      this.announce('phase', {
        title: `Auto-recovery started · ${slug} P${phase}`,
        body: `${situation.label} — ${rung.label} (attempt ${slot.attempts} of ${caps.perPhaseRungs}). The run resumes by itself when the board reads fixed.`,
        tag: tagFor('phase', state.id, `auto-recover-${phase}-${slot.attempts}`),
      }, { slug, runId: state.id, phase });
    };

    /* The runner's own re-board: reset the record and continue the run under
     * normal admission — the cheapest vehicle there is, and the right one for
     * a phase that never started. */
    if (vehicle.kind === 'retry') {
      if (!this.flags.allowRun) return no('the runner re-board needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      void this.retryPhase(slug, phase, undefined, healActor(situation.key, rung.vehicle, slot.attempts, caps.perPhaseRungs))
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    /* The `widen-rule` card on a STOPPED run (phase 9, TRS-10): a standing
     * approval card for the deny rule the console's own hook refused. Free —
     * the rung is recorded as climbed with the card's id, nothing spends until
     * a person answers, and `disarm()` never answers it for them. Allow strikes
     * the rule for this plan and resumes the phase's OWN session through the
     * recover verb; Deny or the card's clock settles the rung `failed`, and the
     * next pass writes the errand. (A LIVE run drives the same rung itself —
     * `Runner.offerWidenRule` — so the two never race for one phase.) */
    if (vehicle.kind === 'card') {
      const { approval, decided } = this.approvals.offer(widenCard({ runId: state.id, slug, phase, denied: vehicle.denied }));
      const climbed = accountRung(slot, { situation: situation.key, rung: rung.vehicle, params: rung.params, at: now, note: rung.label });
      climbed.cardId = approval.id;
      if (state.halt?.reason) slot.lastReason = state.halt.reason;
      const record = state.phases[key];
      if (record) {
        record.note = `${situation.label} — a person is asked to widen \`${vehicle.denied.rule}\` (approval card ${approval.id}); nothing spends until they answer`;
      }
      saveRun(state);
      this.emit('run:state', { state });
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: rung.params ?? null, vehicle: 'card', cardId: approval.id, attempt: slot.attempts, by, trigger }, phase);
      log.info('run.auto-recovery', { slug, runId: state.id, phase, situation: situation.key, rung: rung.vehicle, vehicle: 'card', attempt: slot.attempts });
      const denied = vehicle.denied;
      void decided.then((outcome) => {
        const fresh = loadRun(this.root!.path, slug, state.id, null);
        const freshSlot = fresh?.recoveries?.[key];
        const open = freshSlot?.rungs?.find((r) => r.cardId === approval.id && r.outcome === 'running');
        const line = new Journal(this.root!.path, slug, state.id);
        line.append('phase.widen-decided', {
          decision: outcome.decision, by: outcome.by, rule: denied.rule, cardId: approval.id,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        }, phase);
        if (outcome.decision === 'allow') {
          this.editPolicy({ scope: 'plan', slug, remove: { deny: [denied.rule] }, by: outcome.by });
          // `journalPolicy` notes live runners only; this run is stopped.
          line.append('policy.edited', { scope: 'plan', by: outcome.by, removed: [`deny ${denied.rule}`] });
          void this.recoverPhase(slug, phase, 'resume', { instruction: widenInstruction(denied), by: outcome.by })
            .catch((error) => log.warn('run.auto-recovery-failed', { slug, phase, error }));
          return;
        }
        if (fresh && freshSlot && open) {
          this.settleRungOn(fresh, phase, 'failed', `the widen card was ${outcome.by === 'timeout' ? 'not answered' : `denied by ${outcome.by}`}`);
          try { saveRun(fresh); } catch { /* best effort */ }
          this.emit('run:state', { state: fresh });
        }
        this.scheduleAutoRecover(slug);
      }).catch((error) => log.warn('run.auto-recovery-failed', { slug, phase, error }));
      return answer({ vehicle: 'card' });
    }

    /* A `require` MCP park past its clock: continue without the servers. No
     * `climb()` — the flip writes both rungs and the errand itself, and the
     * journal line below is the healer's own voice. */
    if (vehicle.kind === 'mcp-continue') {
      if (!this.flags.allowRun) return no('continuing without the MCP server needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: null, vehicle: 'mcp-continue', attempt: slot.attempts, by, trigger }, phase);
      void this.continueMcpParkedPhase(slug, phase, 'auto-recovery')
        .catch((error) => { log.warn('run.auto-recovery-failed', { slug, phase, error }); });
      return answer();
    }

    /* A `require` MCP park still on its clock (phase 10): the same act the
     * candidate walk makes before any climb — the timer re-armed, the rung
     * accounted once — reachable here only for a caller that climbs the
     * table directly. Nothing launches: the clock is the vehicle. */
    if (vehicle.kind === 'wait-heal') {
      this.driveWaitHeal(slug, state, phase, situation, vehicle, journal, { by, trigger });
      return no(`phase ${phase} is parked on an MCP server — it continues without it at ${vehicle.until} unless the server heals first`,
        { phase, situation: situation.key, label: situation.label, rung: rung.vehicle, vehicle: 'wait-heal' });
    }

    /* The watch clock, one pass now (phase 10): the `waiting-external` row's
     * one act, for a caller that climbs a wait's table directly — the healer's
     * own walk stands down before it. Nothing is accounted: a pass of the
     * clock is not a remedy for a failure. */
    if (vehicle.kind === 'watch-clock') {
      journal.append('phase.rung', { situation: situation.key, rung: rung.vehicle, params: null, vehicle: 'watch-clock', attempt: slot.attempts, by, trigger }, phase);
      void this.watchClock.tick().catch((error: unknown) => log.warn('run.auto-recovery-failed', { slug, phase, error }));
      return no(`phase ${phase} waits on its refs — the watch clock ran a pass`,
        { phase, situation: situation.key, label: situation.label, rung: rung.vehicle, vehicle: 'watch-clock' });
    }

    /* The resource walls and the parks on a STOPPED run (phase 10, LFC-2):
     * each moves the run's own record — the account, the budget, the clock —
     * and then relaunches (or arms the resume) through the run's ordinary
     * door. The rung is accounted first, like every rung, so a console that
     * dies between the edit and the launch still remembers it climbed. */
    if (vehicle.kind === 'switch-account') {
      if (!this.flags.allowRun) return no('the account switch relaunches the run, which needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      const moved = this.switchAccountRun(slug, vehicle.accountId,
        doorActor('converge-heal', { by, via: viaOfTrigger(trigger), origin: `converge:${trigger}`, trigger: situation.key, guard: `ladder:${rung.vehicle}` }));
      if (!moved.ok) {
        this.settleRungOn(state, phase, 'failed', moved.reason ?? 'the account switch was refused');
        try { saveRun(state); } catch { /* best effort */ }
        return no(`phase ${phase} reads ${situation.label} — the switch to ${vehicle.accountId} was refused: ${moved.reason ?? 'unknown'}`,
          { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      }
      journal.append('run.account-switched', { at: 'ladder', reason: situation.key, from: vehicle.from, account: vehicle.accountId, by, phase });
      void this.startRun(slug, {
        actor: healActor(situation.key, rung.vehicle, slot.attempts, caps.perPhaseRungs),
        resumeRunId: state.id,
        accountId: vehicle.accountId,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      }).catch((error) => {
        log.warn('run.auto-recovery-failed', { slug, phase, error });
        this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
        try { saveRun(state); } catch { /* best effort */ }
      });
      return answer();
    }

    if (vehicle.kind === 'raise-budget') {
      if (!this.flags.allowRun) return no('the budget raise relaunches the run, which needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      const raised = this.editStoredRunById(slug, state.id, (stored) => {
        stored.budgetRaise = { from: vehicle.from, to: vehicle.to, pct: vehicle.pct, at: now };
        stored.runBudgetUsd = vehicle.to;
        // The halt this rung answers dissolves with the raise: the run has
        // budget again, and a standing `budget` halt would refuse the relaunch.
        if (stored.halt?.kind === 'budget') { stored.halt = null; stored.status = 'parked'; }
        if (stored.errand?.situation === 'resource-wall:budget') delete stored.errand;
      });
      if (!raised) {
        this.settleRungOn(state, phase, 'failed', 'the stored run could not be edited');
        try { saveRun(state); } catch { /* best effort */ }
        return no('the run could not be edited for the raise', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      }
      journal.append('run.budget-raised', { from: vehicle.from, to: vehicle.to, pct: vehicle.pct, cap: vehicle.cap, spentUsd: state.spentUsd, by, rung: rung.vehicle });
      void this.startRun(slug, {
        actor: healActor(situation.key, rung.vehicle, slot.attempts, caps.perPhaseRungs),
        resumeRunId: state.id,
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      }).catch((error) => {
        log.warn('run.auto-recovery-failed', { slug, phase, error });
        this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
        try { saveRun(state); } catch { /* best effort */ }
      });
      return answer();
    }

    if (vehicle.kind === 'timed-park') {
      climb();
      const parked = this.editStoredRunById(slug, state.id, (stored) => {
        const rec = stored.phases[key];
        if (!rec) return;
        const sessionId = rec.resumeSessionId ?? rec.sessionId;
        rec.status = 'waiting';
        rec.parkedUntil = vehicle.until;
        rec.parkedFrom = now;
        rec.parkReason = vehicle.why;
        rec.note = vehicle.why;
        if (vehicle.refs?.length) rec.watch = vehicle.refs;
        // The console's own park, stamped like the watchdog's: shown on the
        // record, never charged to the session's declared budget (WAI-5).
        openWaitEntry(rec, { parkedFrom: now, parkedUntil: vehicle.until, by: 'ladder' }, Date.now());
        // The clock's resume boards the phase's own session with the
        // instruction to re-check — the ladder's hint, read at boarding.
        rec.boardingHint = {
          situation: situation.key, rung: rung.vehicle, brief: sessionId ? 'continue' : 'resume',
          ...(sessionId ? { sessionId } : {}),
          instruction: vehicle.wait === 'usage-limit'
            ? 'The usage window you were parked on has reopened. Continue the phase from where it stopped.'
            : 'The console parked this phase for a while because you declared it blocked on something outside the '
              + 'session. Re-check that blocker now: if it has landed, continue the phase to its exit criteria; if it has '
              + 'not, declare `waiting-external` with a machine-checkable `--watch` ref (a gh run or PR, a date, a lock, '
              + 'a cmd) so the console can watch it instead of you.',
          at: now, by: 'auto-recovery',
        };
        if (stored.halt?.phase === phase) stored.halt = null;
        setRunState(stored, 'waiting', { kind: vehicle.wait, until: vehicle.until });
        syncWaitClock(stored);
      });
      if (!parked) {
        this.settleRungOn(state, phase, 'failed', 'the stored run could not be edited');
        try { saveRun(state); } catch { /* best effort */ }
        return no('the run could not be edited for the park', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      }
      journal.append('phase.waiting', {
        reason: vehicle.why, until: vehicle.until, watch: vehicle.refs ?? [], by: 'ladder', rung: rung.vehicle, wait: vehicle.wait,
      }, phase);
      this.emit('run:state', { state: parked });
      this.armLimitResume(slug, parked);
      return answer();
    }

    /* The runner's own re-board WITH A BRIEF: resume the run with the phase
     * reset and hinted, and let boarding assemble the resume/unblock brief.
     * `start({reboard})` does not account the rung — this healer did, above. */
    if (vehicle.kind === 'reboard') {
      if (!this.flags.allowRun) return no('the runner re-board needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      const record = state.phases[key];
      void this.startRun(slug, {
        actor: healActor(situation.key, rung.vehicle, slot.attempts, caps.perPhaseRungs),
        resumeRunId: state.id,
        reboard: [{
          phase, situation: situation.key, rung: rung.vehicle, brief: vehicle.brief,
          ...(record?.sessionId ?? record?.resumeSessionId ? { sessionId: record?.sessionId ?? record?.resumeSessionId } : {}),
          ...(vehicle.escalate ? { escalate: vehicle.escalate } : {}),
          by: 'auto-recovery',
        }],
        ...(state.onlyPhases?.length ? { onlyPhases: state.onlyPhases } : {}),
        skills: state.skills ?? [],
      }).catch((error) => {
        log.warn('run.auto-recovery-failed', { slug, phase, error });
        this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
        try { saveRun(state); } catch { /* best effort */ }
      });
      return answer();
    }

    /* The phase's own session through the RUNNER — `claude -p --resume`, with
     * the settings file, the deny rules, the hooks and the journal all
     * applying, under `--allow-run` — never a fresh interactive agent with
     * none of that. */
    if (vehicle.kind === 'session') {
      if (!this.flags.allowRun) return no('session recovery needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      // A `repair` carries no instruction of its own: its briefing is built
      // here, from the SAME `resolveRecovery` facts the pty agent used, plus
      // the situation the ladder chose the rung for. Built BEFORE `climb()` —
      // a rung must not be accounted for a session a refusal is about to stop.
      let instruction = vehicle.instruction;
      if (vehicle.mode === 'repair') {
        const built = await this.repairBriefing(slug, phase, vehicle.cls, chosen);
        if (!built.ok) {
          return no(built.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
        }
        instruction = built.prompt;
      }
      climb();
      void this.recoverPhase(slug, phase, vehicle.mode, {
        by: 'auto-recovery',
        ...(instruction ? { instruction } : {}),
        ...(vehicle.mode === 'repair' && vehicle.cls ? { cls: vehicle.cls } : {}),
        ...(vehicle.mode === 'repair' ? { situation: situation.key } : {}),
      })
        .then(async () => {
          const after = this.runners.get(slug)?.current()
            ?? (this.root ? loadRun(this.root.path, slug, state.id, this.liveRunIds()) : null);
          if (!after || after.id !== state.id) return;
          const afterSlot = ((after.recoveries ??= {})[key] ??= { attempts: 0, lastAt: now });
          if (after.status === 'parked' && !after.halt) {
            // No cost here any more: `chargeRung` books each attempt's own
            // spend as it ends. This line passed `PhaseRecord.costUsd`, which
            // is CUMULATIVE across attempts, so a phase that climbed twice
            // would have had its whole history added again on the second
            // settle. Outcome only — the cost half already happened.
            // Only when this settle actually CLAIMED the rung. Since a repair
            // session's own declaration settles it at the recovery's tail, the
            // rung is usually already closed by the time this runs — and
            // stamping `fixed` over it unconditionally would relabel a rung
            // that honestly reported `no-defect` as one that fixed something.
            // `settleRung` answers null when nothing is open; first writer
            // wins, and the first writer is the session that was there.
            const settled = this.settleRungOn(after, phase, 'fixed', 'the board reads fixed');
            if (settled) {
              afterSlot.fixed = true;
              afterSlot.lastOutcome = 'fixed';
              delete afterSlot.lastReason;
            }
            delete afterSlot.errand;
            saveRun(after);
            // …and not while the console is frozen. A recovery that FIXED
            // something still has to ask, because continuing the run spawns a
            // session — the freeze deliberately makes no exception for the
            // recovery family (see `SchedulerDeps.fleetHold`), and a fix that
            // relaunched under it would be the console starting work the
            // instant the operator stopped it. The verdict is already saved
            // above, so the thaw's converge kick picks the run up.
            const frozen = this.fleetHold();
            if (frozen) {
              log.info('run.recovery-continue-frozen', { slug, runId: after.id, by: frozen.by });
            } else if (this.prefs.autoContinueRecovery !== false && this.flags.allowRun && !this.liveRunner(slug)) {
              log.info('run.recovery-continue', { slug, runId: after.id });
              await this.startRun(slug, {
                // The recovery session's exit is an observation: the run goes
                // on because the board reads fixed after the rung it climbed.
                actor: doorActor('recovery-continue', {
                  by: 'console', via: 'event', origin: `recovery:${vehicle.mode}`,
                  trigger: `${situation.key}:fixed`, guard: 'autoContinueRecovery,allowRun,!liveRunner,!fleetHold',
                  counter: `ladderPerPhaseRungs:${afterSlot.attempts}/${caps.perPhaseRungs}`,
                }),
                resumeRunId: after.id,
                ...(after.onlyPhases?.length ? { onlyPhases: after.onlyPhases } : {}),
                skills: after.skills ?? [],
              });
            }
          } else if (after.status === 'waiting' && after.waitUntil) {
            // The honest middle: the session declared the external clock has
            // still not landed. The park machinery owns it from here.
            this.settleRungOn(after, phase, 'no-defect', 'the session declared an external wait');
            saveRun(after);
            this.armLimitResume(slug, after);
          } else if (IN_FLIGHT.includes(after.status) || this.liveRunner(slug)) {
            // Still driving. `running` is not a verdict — it is the ABSENCE of
            // one — and a run that is still going has not failed at anything.
            // This branch settled it `failed` the moment `recoverPhase`
            // resolved, which on a recovery that hands off to the drive loop is
            // while its own `claude` process is minutes into doing exactly what
            // it was asked. Observed live: a `qa-fix` rung recorded
            // "the run reads running" as a failure at eight minutes in.
            //
            // The rung is left OPEN. It is settled by evidence later — the next
            // climb's `settleRung(... record.status === 'done' ...)` in
            // `maybeAutoRecover`, or the drive loop's own settle when the lane
            // ends — which is the only honest reading of an outcome that has not
            // happened yet. The cost of the old behaviour was a lie in the
            // ledger and a premature escalation to the more expensive rung.
            log.info('run.rung-still-driving', { slug, phase, status: after.status });
          } else if (after.phases[key]?.declared) {
            // The recovery session re-checked and DECLARED the park again (a
            // wait, a blocker, a person). That is the rung doing its job, not
            // failing at it — `failed` here is what escalated a production
            // outage up the model ladder. The declared errand stands.
            const d = after.phases[key]!.declared!;
            this.settleRungOn(after, phase, 'no-defect',
              `the session declared ${d.status}${d.reason ? `: ${d.reason.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
            saveRun(after);
          } else {
            this.settleRungOn(after, phase, 'failed', `the run reads ${after.status}${after.halt ? ` — ${after.halt.reason.slice(0, 120)}` : ''}`);
            saveRun(after);
          }
        })
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    // Naming the flag rather than skipping the rung is deliberate (see
    // `vehicleForRung`) — but the reason reached only a journal line and a
    // HealResult, and the one person who can restart the console with the flag
    // was never asked. A capability wall is a person's to clear, which is what
    // an errand is for.
    const blockedBy = (need: string, how: string, reason: string): AutoRecoverResult => {
      const slot2 = ((state.recoveries ??= {})[String(phase)] ??= { attempts: 0, lastAt: new Date().toISOString() });
      if (!slot2.errand) {
        const errand: Errand = { phase, situation: situation.key, tried: (slot2.rungs ?? []).map((r) => r.rung), need, how, at: new Date().toISOString() };
        slot2.errand = errand;
        try { saveRun(state); } catch { /* the ask is worth more than the write */ }
        journal.append('phase.errand', { ...errand }, phase);
        this.announceErrand({ slug, runId: state.id, phase, errand });
      }
      return no(reason, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
    };

    /* The deterministic repair: `scripts/repair-artefacts.sh`, through the
     * engine's own `execFile`. No session, no money, no model — which is why it
     * is `plan-broken`'s FIRST rung and the agent its second. `fixed` iff
     * `validate.sh` exits 0 afterwards, which is the honest bar HERE (unlike
     * the agent brief's) because every repair this script makes is one the
     * validator checks. */
    if (vehicle.kind === 'script') {
      // No `--allow-writes` check here: `vehicleForRung` already answers null
      // without the flag, so this branch is only ever reached WITH it. The
      // refusal that used to live here was unreachable the moment the vehicle
      // became conditional — and an unreachable errand is worse than none,
      // because it reads as a promise that a person will be told. The flag is
      // named in the journal at `climb()` instead, which is where the timeline
      // an operator actually reads gets it.
      climb();
      void this.runRepairScript(slug, phase, state)
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    /* A fresh REVIEW through the QA recovery loop — `qaRecover` with the verb
     * `qa-rerun` and the `fresh` strategy: `qa-pending`'s second rung, for a
     * phase whose own session cannot be resumed. A session boarded from the
     * boot prompt dispatches the fresh-context QA subagent and records the
     * verdict, and the rung settles by what the ledger then says — the same
     * bar the sweep applies to every QA rung. Needs `--allow-run`, like every
     * vehicle that spends a session. */
    if (vehicle.kind === 'qa-rerun') {
      if (!this.flags.allowRun) return no('a fresh QA review needs --allow-run', { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
      climb();
      void this.qaRecover(slug, phase, {
        verb: 'qa-rerun', strategy: 'fresh', qaMaxRounds: 1, by: 'auto-recovery', settled: true,
        actor: healActor(situation.key, rung.vehicle, slot.attempts, caps.perPhaseRungs),
      })
        .then(async () => {
          const after = this.runners.get(slug)?.current()
            ?? (this.root ? loadRun(this.root.path, slug, state.id, this.liveRunIds()) : null);
          if (!after || after.id !== state.id) return;
          const afterSlot = ((after.recoveries ??= {})[key] ??= { attempts: 0, lastAt: now });
          const verdict = await this.qaVerdict(slug, phase);
          const met = verdict !== 'pending' && verdict !== 'none';
          const settled = met
            ? this.settleRungOn(after, phase, 'fixed', `a QA verdict is recorded (${verdict})`)
            : this.settleRungOn(after, phase, 'failed', 'the review recorded no verdict');
          if (settled && met) {
            afterSlot.fixed = true;
            afterSlot.lastOutcome = 'fixed';
            delete afterSlot.lastReason;
            delete afterSlot.errand;
          }
          saveRun(after);
        })
        .catch((error) => {
          log.warn('run.auto-recovery-failed', { slug, phase, error });
          this.settleRungOn(state, phase, 'failed', (error as Error)?.message ?? String(error));
          try { saveRun(state); } catch { /* best effort */ }
        });
      return answer();
    }

    /* A fresh briefed pty agent — for plan-shaped repairs, for phases whose
     * own session is gone, and for the stronger second try. */
    if (!agentEnabled(this.flags)) {
      // Both flags, when both are missing. Naming only `--allow-agent` sent an
      // operator to the EXPENSIVE remedy: for a plan-shaped repair the free
      // deterministic rung would have been tried first if the console could
      // write, and a person told to restart for the agent never learns that.
      const alsoWrites = situation.id === 'plan-broken' && !this.flags.allowWrites;
      return blockedBy(
        `A console that may run agent sessions — phase ${phase} reads ${situation.label} and the `
          + 'only remaining rung is an agent session, which this console is not allowed to spawn.'
          + (alsoWrites
            ? ' This plan\'s FREE deterministic repair was also unavailable, because it edits '
              + 'INDEX.md, handoff frontmatter and lock files and this console may not write.'
            : ''),
        alsoWrites
          ? 'Restart the console with --allow-writes AND --allow-agent (--allow-writes alone lets the '
            + 'free rung run first), then press Recover & continue — or run the free rung by hand now, '
            + `scripts/repair-artefacts.sh ${slug} --apply, and Retry.`
          : 'Restart the console with --allow-agent, then press Recover & continue — or clear the phase by hand.',
        'agent auto-recovery needs --allow-agent',
      );
    }
    if (this.terminals.availability() === 'no') {
      return blockedBy(
        `A working pty layer — phase ${phase} reads ${situation.label} and the only remaining rung `
          + 'is an agent session, which needs node-pty.',
        'Reinstall the console so node-pty builds (see Settings ▸ Diagnostics), then press Recover & continue.',
        'agent sessions are unavailable (node-pty)',
      );
    }

    const request: RecoveryRequest = { class: vehicle.cls, slug, phase, runId: state.id };
    const resolved = await this.resolveRecovery(request);
    if (!resolved.ok) return no(resolved.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });

    // Spawn as the run's own account: the run's quota, the run's identity.
    const env = state.accountId ? await this.accounts.envFor(state.accountId) : null;
    const account = state.accountId
      ? {
        id: state.accountId,
        env: env
          ? Object.fromEntries(Object.entries(env)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : null,
      }
      : undefined;

    const built = buildAgentLaunch(
      { kind: 'claude', intent: 'recovery', model: state.model },
      {
        skills: () => this.skills(),
        scriptsDir: this.flags.scriptsDir,
        rootOpen: Boolean(this.store),
        ...(this.root?.ok ? { root: this.root.path } : {}),
        recovery: resolved.facts,
        ...(account ? { account } : {}),
      },
    );
    if (!built.ok) return no(built.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });

    // One of the fourteen automatic starts (SLF-1): the pty agent names its
    // door and asks the ceiling before a rung is charged for it.
    const agentActor = doorActor('ladder-pty-agent', {
      by, via: viaOfTrigger(trigger), origin: `converge:${trigger}`,
      trigger: situation.key, guard: `ladder:${rung.vehicle},allowAgent,pty`, counter: `ladderPerPhaseRungs:${slot.attempts + 1}/${caps.perPhaseRungs}`,
    });
    const admitted = this.admitStart(agentActor, slug, state.id);
    if (!admitted.ok) return no(ceilingSentence(admitted), { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
    this.startCeiling.charge(agentActor, slug);
    journal.append('phase.session-start', { ...agentActor, mode: 'pty-agent' }, phase);

    // Bumped before the session exists — see `climb`.
    climb();
    const minted = await this.terminals.mint(undefined, undefined, built.launch);
    if (!minted.ok) {
      this.settleRungOn(state, phase, 'failed', minted.error);
      try { saveRun(state); } catch { /* best effort */ }
      return no(minted.error, { phase, situation: situation.key, label: situation.label, rung: rung.vehicle });
    }
    this.runners.get(slug)?.note('run.auto-recovery', { phase, class: vehicle.cls, situation: situation.key, rung: rung.vehicle, attempt: slot.attempts }, phase);
    return answer();
  }

  /**
   * The briefing a `repair` session gets — the pty agent's facts, plus WHY.
   *
   * `resolveRecovery` already assembles everything a prompt builder may use
   * (board, run, diagnosis, health issues, lock detail); this adds the two
   * things only the ladder knows — the situation it chose the rung for and the
   * evidence that decided it — and the run's own work root, so the discipline
   * block can name the tree instead of leaving a session to go looking for a
   * branch it cannot check out.
   */
  private async repairBriefing(
    slug: string, phase: number, cls: RecoveryClass | undefined,
    chosen: { situation: Situation; evidence: PhaseEvidence },
  ): Promise<{ ok: true; prompt: string } | { ok: false; error: string }> {
    if (!cls) return { ok: false, error: 'a repair session was chosen with no briefing class' };
    const resolved = await this.resolveRecovery({ class: cls, slug, phase });
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const { situation, evidence } = chosen;
    // Measured, never assumed. `plan-broken:lint` IS the lint being red; for
    // every other sub-kind the validator is usually GREEN, and a brief that
    // did not say so sent sessions to satisfy a test they could not fail.
    // `null` (unreadable) stays absent — an unknown is not a convenient yes.
    let validateOk: boolean | undefined;
    if (situation.id === 'plan-broken') {
      if (situation.sub === 'lint') validateOk = false;
      else {
        const lint = await this.lint(slug).catch(() => null);
        if (lint) validateOk = lint.ok;
      }
    }
    const issue = situation.id === 'plan-broken'
      ? (evidence.health ?? []).find((i) => i.phase == null || i.phase === phase)
      : null;
    const declared = evidence.record?.declared ?? null;

    const facts: RecoveryFacts = {
      ...resolved.facts,
      situation: {
        key: situation.key,
        why: situation.why.slice(0, 6),
        ...(declared
          ? {
            declared: {
              status: declared.status,
              ...(declared.reason ? { reason: declared.reason } : {}),
              ...(declared.at ? { at: declared.at } : {}),
            },
          }
          : {}),
        ...(issue || situation.sub
          ? {
            issue: {
              kind: issue?.kind ?? situation.sub ?? situation.id,
              detail: issue?.detail ?? situation.why[0] ?? situation.blurb,
              ...(validateOk === undefined ? {} : { validateOk }),
            },
          }
          : {}),
      },
      // Where the run's branch is actually checked out. Absent for a run with
      // no branch strategy, which is the majority and needs no bullet.
      ...(resolved.facts.gitStrategy && this.root?.path
        ? { gitStrategy: { ...resolved.facts.gitStrategy, workRoot: this.root.path } }
        : {}),
    };
    return { ok: true, prompt: recoveryPrompt(facts) };
  }

  /**
   * Drive the FREE `plan-broken` rung: `scripts/repair-artefacts.sh --apply`.
   *
   * `fixed` iff `validate.sh` exits 0 afterwards. That IS the honest bar here,
   * unlike in the agent's brief: every repair this script makes — an INDEX
   * status cell, a `depends_on` line, lock debris, a did-not-start marker — is
   * one the validator checks, so a green validator afterwards means the thing
   * the script was for is actually gone. A script that changed nothing settles
   * `no-defect`: it looked, and there was nothing mechanical to fix.
   *
   * `--reset-not-started` is fed from the RUN, which is the only place the fact
   * lives: a `blocked` handoff on a phase with `attempts === 0` was written by
   * nothing, so it is a marker rather than testimony.
   */
  private async runRepairScript(slug: string, phase: number, state: RunState): Promise<void> {
    const key = String(phase);
    const slot = ((state.recoveries ??= {})[key] ??= { attempts: 0, lastAt: new Date().toISOString() });
    const journal = this.root ? new Journal(this.root.path, slug, state.id) : null;
    // 🔴 THIS rung's phase, and only when THIS run can prove nothing wrote its
    // handoff. `attempts === 0` across every record is a far weaker warrant than
    // the script's own contract: `phaseRecord()` mints a zero-attempt record for
    // any phase the loop merely READS (and for a recovery's own anchor), and a
    // `blocked` handoff on such a phase may have been written by a previous run,
    // a peer session or a person. Rewriting that to `pending` makes the board
    // read it as not-started and the autopilot boards straight over the blocker.
    // Three signals, all of which must hold: the record exists, it has no
    // attempts, and it has no session and no start — nothing ever ran here.
    const own = state.phases[key];
    const neverRan = own && (own.attempts ?? 0) === 0
      && !own.sessionId && !own.resumeSessionId && !own.startedAt
      ? key
      : '';

    const args = [slug, '--apply', ...(neverRan ? ['--reset-not-started', neverRan] : [])];
    let summary = '';
    try {
      const out = await run(this.engineOpts(), 'repair-artefacts.sh', args);
      summary = out.stdout.trim();
    } catch (error) {
      this.settleRungOn(state, phase, 'failed', `the repair script could not run: ${(error as Error)?.message ?? String(error)}`);
      try { saveRun(state); } catch { /* best effort */ }
      journal?.append('phase.repair-script', { ok: false, error: String(error) }, phase);
      return;
    }

    // The plan's engine answers are now stale by construction — the script just
    // rewrote the artefacts they were computed from.
    invalidate(slug);

    // 🔴 A summary we cannot READ is not a summary saying zero. Reading it as
    // zero settled the rung "found nothing mechanical to fix" over a run that
    // had just rewritten two files — a verdict with no way to know whether it
    // was true, which is the exact shape this plan's QA has caught three times.
    let changed: number | null = null;
    let declined = 0;
    try {
      const parsed = JSON.parse(summary) as { changed?: unknown; declined?: unknown };
      changed = typeof parsed.changed === 'number' && Number.isFinite(parsed.changed) ? parsed.changed : null;
      // Rows the script REPORTED and refused to act on. They are evidence for a
      // person, never work done: counted into `changed` they made this settle
      // `fixed` — stamping `slot.fixed` and DELETING the errand — on a run that
      // had applied nothing at all.
      declined = typeof parsed.declined === 'number' && Number.isFinite(parsed.declined) ? parsed.declined : 0;
    } catch { changed = null; }
    if (changed === null) {
      this.settleRungOn(state, phase, 'failed',
        'the deterministic repair ran but its summary could not be read — what it changed is unknown');
      try { saveRun(state); } catch { /* best effort */ }
      journal?.append('phase.repair-script', { ok: false, reason: 'unreadable summary', summary: summary.slice(0, 2_000) }, phase);
      this.emit('run:state', { state });
      return;
    }
    const lint = await this.lint(slug).catch(() => null);
    const outcome = changed === 0
      ? 'no-defect' as const
      : lint?.ok ? 'fixed' as const : 'failed' as const;
    const declinedNote = declined ? ` (${declined} further disagreement(s) reported and NOT repaired — a person's)` : '';
    this.settleRungOn(state, phase, outcome,
      (changed === 0
        ? 'the deterministic repair found nothing mechanical to fix'
        : lint?.ok
          ? `the deterministic repair fixed ${changed} artefact(s) and validate.sh now passes`
          : `the deterministic repair fixed ${changed} artefact(s) but validate.sh still fails`) + declinedNote);
    // The errand is retired only by a real fix. A run that DECLINED something is
    // exactly the run whose errand a person still needs.
    if (outcome === 'fixed') { slot.fixed = true; slot.lastOutcome = 'fixed'; delete slot.lastReason; if (!declined) delete slot.errand; }
    try { saveRun(state); } catch { /* the verdict matters more than the write */ }
    journal?.append('phase.repair-script', { ok: true, changed, declined, validateOk: lint?.ok ?? null, summary: summary.slice(0, 2_000) }, phase);
    this.emit('run:state', { state });
  }

  /* ---------------------------------------------------------------- *
   * Watch refs — the free half of a declared park
   * ---------------------------------------------------------------- */

  /**
   * Watch-landed delivery drives that have not settled — `"<slug>#<phase>"`.
   *
   * In-memory ON PURPOSE. The promise this tracks dies with the process, and
   * so does the entry — which is the honesty wanted: a console that died
   * mid-drive holds nothing, the landing is offered again on reboot, and the
   * refusals that already exist (`adopt`, the busy guards) answer for whatever
   * survived. Persisting it would recreate H1 — a stamp outliving the thing it
   * describes.
   */
  private watchDrives = new Set<string>();

  /**
   * The scheduler's hold: is a delivery of this phase's landing still being
   * driven? True while the drive's own promise is un-settled, while a runner
   * is driving the plan (a `recoverPhase` would only refuse "in progress"),
   * or while an agent recovery holds the phase. Each of these is a thing the
   * console OBSERVES, not an intent it recorded.
   */
  watchResumeInFlight(slug: string, phase: number): boolean {
    return this.watchDrives.has(`${slug}#${phase}`)
      || Boolean(this.liveRunner(slug))
      || Boolean(this.liveRecoveryFor({ slug, phase }));
  }

  /**
   * Un-charge a delivery whose drive settled without a session ever existing.
   * Guarded on the count still being ours: anything that moved it since has
   * better information than this settlement does. The stamp goes with the
   * charge — both were written in `resumeOnWatchLanded`, which is what makes
   * them reachable from here at all (QA round 3, H1: the scheduler used to
   * write the stamp AFTER the rollback had run, so the delete was a no-op).
   */
  private voidWatchDelivery(record: RunPhaseRecord, ref: string, resumes: number): void {
    if (record.watchResumes === resumes) {
      if (resumes <= 1) delete record.watchResumes;
      else record.watchResumes = resumes - 1;
    }
    const row = record.watchState?.refs.find((r) => r.ref === ref);
    if (row) delete row.deliveredAt;
  }

  /**
   * A landing's drive REJECTED (SLF-8, RCV-8): charge the rejection ledger,
   * back the re-offer off, and say so once per distinct reason per lease.
   *
   * `voidWatchDelivery` un-charges `watchResumes` — correctly, the drive
   * launched nothing — which is exactly why the over-cap errand could never be
   * reached for this class: a foreign lease outside the phase rejected every
   * minute for the whole lease, un-charged every time, 134 warnings in 108
   * minutes and no errand. `watchRejections` is the counter that CAN reach it,
   * and the row's `nextDueAt` is moved to `redeliverAfter` — the series step,
   * or the rejection's own clock (a lock's `lease_until`) when that is later —
   * so the scheduler's next offer waits for the thing to change. Returns
   * whether the cap was hit, so the caller writes the errand.
   */
  private chargeWatchRejection(
    record: RunPhaseRecord, ref: string, error: unknown, now = Date.now(),
  ): { count: number; capped: boolean; until: number | null; reason: string; repeated: boolean } {
    const reason = ((error as Error)?.message ?? String(error)).slice(0, 300);
    const until = error instanceof PhaseClaimedError && typeof error.lock.leaseUntil === 'number' && Number.isFinite(error.lock.leaseUntil)
      ? error.lock.leaseUntil : null;
    const previous = record.watchRejections;
    const count = (previous?.count ?? 0) + 1;
    // Repeated: the same words inside the same lease (or, clockless, the same
    // words again) — logged once, however many minutes the lease has left.
    const repeated = previous !== undefined && previous.reason === reason && (previous.until ?? null) === until;
    record.watchRejections = { count, lastAt: new Date(now).toISOString(), reason, ...(until !== null ? { until } : {}) };
    const row = record.watchState?.refs.find((r) => r.ref === ref);
    if (row && row.state === 'landed') row.nextDueAt = redeliverAfter(count, now, until);
    return { count, capped: count >= MAX_WATCH_REJECTIONS, until, reason, repeated };
  }

  /**
   * The errand a landing becomes when its resumes are spent — over the delivery
   * cap, or over the rejection cap (RCV-8, where it was unreachable). Written
   * ONCE per landing (`watchLandedErrandFor` is the stamp) and the row retires.
   */
  private landingErrand(
    slug: string, state: RunState, record: RunPhaseRecord, c: { phase: number; situation: { id: string; key: string } },
    landed: WatchState, need: string, journal: Journal,
  ): boolean {
    if (record.watchLandedErrandFor === landed.ref) return false;
    record.watchLandedErrandFor = landed.ref;
    const errand: Errand = {
      phase: c.phase,
      situation: c.situation.id === 'blocked-declared' ? c.situation.key : 'blocked-declared:external',
      at: new Date().toISOString(),
      tried: [],
      need,
      how: 'Open the phase, settle what its Outstanding section names, then Retry — or resume the session with an instruction.',
    };
    ((state.recoveries ??= {})[String(c.phase)] ??= { attempts: 0, lastAt: errand.at }).errand = errand;
    journal.append('phase.errand', { ...errand }, c.phase);
    this.announceErrand({ slug, runId: state.id, phase: c.phase, errand });
    try { saveRun(state); } catch { /* the errand matters more than the write */ }
    return true;
  }

  /**
   * A watched ref landed — the scheduler's one call into the healer.
   *
   * The probing that used to live here is gone: `watch-scheduler.ts` owns the
   * clock, the rotation, the per-ref dedupe and `record.watchState`. What is
   * left is the judgement, which was always the part that belonged with the
   * ladder — whether this landing may resume a session, and how many times.
   */
  protected async onWatchLanded(
    slug: string, state: RunState, phase: number, landed: WatchState,
  ): Promise<WatchLandingOutcome> {
    const record = state.phases[String(phase)];
    if (!record) return 'done';
    // Only a phase that is actually WAITING on this is resumed. The scheduler
    // reports the world without opinions about it; a ref that lands under a
    // phase whose session has since moved on is news for the journal and
    // nothing more — and `done` retires the row, because nothing is waiting.
    const declared = record.declared;
    if (!declared || !['needs-human', 'waiting-external', 'blocked'].includes(declared.status)) return 'done';
    if (!this.root?.ok) return 'deferred';
    const key = record.situation?.key ?? 'blocked-declared:external';
    const parsed = parseSituationKey(key);
    const journal = new Journal(this.root.path, slug, state.id);
    const driven = this.resumeOnWatchLanded(
      slug, state,
      { phase, situation: { id: parsed.id, key, label: situationLabel(parsed.id, parsed.sub) } },
      record, landed, journal,
    );
    // A report, not a receipt. `launched` here means exactly "a delivery drive
    // was started" — nothing about it may gate the offer, because at this
    // moment nobody can know whether a session will exist (QA round 3, H1:
    // `recoverPhase` can resolve without launching, and a receipt signed now
    // gated a landing for ever). The hold lives where the knowledge lives —
    // `watchResumeInFlight` while the drive settles, the record's own status
    // while a session runs — and the drive's settlement un-charges a delivery
    // that launched nothing. Every non-drive answer — a freeze, `--allow-run`
    // off, the over-cap errand, a drive already in flight — is a DEFERRAL:
    // nothing spent, asked again (QA round 2, G1).
    return driven?.launched ? 'resumed' : 'deferred';
  }

  /**
   * The declared resume: the external thing the session parked on has landed,
   * so its OWN session continues — the rung table's `poll-park` promise, made
   * real. No rung is accounted: this is not a remedy for a failure, it is the
   * plan the session itself declared, and charging it against the ladder's
   * three would exhaust a phase for waiting well.
   */
  private resumeOnWatchLanded(
    slug: string, state: RunState,
    // Only the three fields this path reads, not a whole `Situation`. It is
    // now called from the watch scheduler, which has a record and a stored
    // situation KEY and no reason to reconstruct a classification around them.
    c: { phase: number; situation: { id: string; key: string; label: string } },
    record: RunPhaseRecord, landed: WatchState, journal: Journal,
  ): AutoRecoverResult | null {
    const frozen = this.fleetHold();
    if (frozen) {
      log.info('run.watch-landed-frozen', { slug, phase: c.phase, ref: landed.ref, by: frozen.by });
      return null;
    }
    if (!this.flags.allowRun) return null;
    // One drive per phase at a time. A second ref of the same phase landing in
    // the same pass must not start a second recovery under the first — it
    // would only reject on the busy guard and buy a rollback. Deferred: the
    // landing is offered again once the drive in flight has settled.
    const driveKey = `${slug}#${c.phase}`;
    if (this.watchDrives.has(driveKey)) return null;
    // Once per LANDING, not once per delivery. The landing is re-offered until
    // a resume actually starts, so a line written here unconditionally appeared
    // four times for one event — three of them saying the world had landed
    // again when nothing had changed but the console's own willingness to act
    // (QA round 2, G6). `watchLandedJournalledFor` is the stamp, and it is
    // cleared with the rest of the watch bookkeeping. A SET, per ref (RCV-8):
    // as one string, two refs landing on one phase overwrote each other's stamp
    // on alternate deliveries and both re-journalled every minute — 56 lines
    // for two landings.
    const journalled = record.watchLandedJournalledFor ?? [];
    if (!journalled.includes(landed.ref)) {
      record.watchLandedJournalledFor = [...journalled, landed.ref];
      journal.append('phase.watch-landed', { ref: landed.ref, detail: landed.detail ?? null }, c.phase);
    }
    const sessionId = record.sessionId ?? record.resumeSessionId;
    // The declaration is NOT deleted here (R1). It used to be — three deletes
    // and a save, BEFORE admission or spawn — so a resume that queued behind
    // another plan's scope, hit the lock-wait cap, or failed to spawn lost the
    // session's own testimony for good, and the phase's next classification
    // read "no handoff, no declaration" and called the plan broken. The
    // declaration is the session's, and only the session producing work
    // (`consumeDeclaration(record, 'session-productive')`) spends it.
    //
    // What IS bounded here is the re-firing: the ref stays landed, so without a
    // count this arm would resume the phase on every sweep. Three, then the
    // landing becomes an errand a person can read.
    const resumes = (record.watchResumes ?? 0) + 1;
    if (resumes > MAX_BOOT_RESUMES) {
      // Once per LANDING, not once per sweep (QA F3). A landed ref stays landed
      // and `watchVerdict` dedupes only its journal line, so without this stamp
      // the errand was re-written with a fresh `at`, re-announced and re-saved
      // on every converge pass — an errand that never ages and a push that
      // never stops. `watchResumes` alone could not carry it: it is already
      // over the cap on the pass that writes the errand.
      this.landingErrand(slug, state, record, c, landed,
        `${landed.ref} landed${landed.detail ? ` (${landed.detail})` : ''}, and ${MAX_BOOT_RESUMES} `
          + 'resumes of this phase produced nothing. Read what it is really waiting for.', journal);
      return null;
    }
    // The other cap: the drive has REJECTED this landing `MAX_WATCH_REJECTIONS`
    // times (a foreign lease, a recovery already in flight) — see
    // `chargeWatchRejection`. An errand a person can read, instead of a
    // re-offer every minute for the whole lease.
    if ((record.watchRejections?.count ?? 0) >= MAX_WATCH_REJECTIONS) {
      this.landingErrand(slug, state, record, c, landed,
        `${landed.ref} landed${landed.detail ? ` (${landed.detail})` : ''}, and ${record.watchRejections!.count} attempts to resume `
          + `this phase were refused — last: ${record.watchRejections!.reason}. Settle that, then Retry.`, journal);
      return null;
    }
    record.watchResumes = resumes;
    // One of the six automatic resumes, journalled in the one shape with what
    // woke it (LFC-7). Its bound is its own — a landing's deliveries, which
    // retire with the declaration they answer — so it is counted there.
    journal.append('phase.resume-automatic', {
      trigger: 'watch', path: 'watch-landed', count: resumes, sessionId: sessionId ?? null, ref: landed.ref, by: 'watch',
    }, c.phase);
    // The delivery stamp — written HERE, beside the charge, where the
    // settlement below can still reach it, and never by the scheduler. Round
    // 3's H1: the scheduler stamped it after `onLanded` returned, so a fast
    // rejection's rollback ran FIRST and its delete was a no-op on a row that
    // had no stamp yet — a receipt nothing could revoke. What it records is
    // "a delivery attempt began"; a settlement that finds the drive launched
    // nothing deletes it again, so a standing value marks the last delivery
    // that actually launched (or one still in flight).
    const offerAt = Date.now();
    const stampRow = record.watchState?.refs.find((r) => r.ref === landed.ref);
    if (stampRow) stampRow.deliveredAt = offerAt;
    // What the record's own bookkeeping said BEFORE the drive: `endedAt` is
    // written by every attempt teardown and unset only by `resetForRetry` — a
    // park writes `parkedFrom` since 5.0.0, never `endedAt` — so it moving past
    // this point is the drive's proof that a session really ran.
    const endedBefore = record.endedAt ? Date.parse(record.endedAt) : null;
    // The landing goes ON the declaration, not beside it.
    //
    // Two things follow from that and both are the point. It is retired with
    // the declaration — `consumeDeclaration` drops both together — so a landing
    // can never outlive the wait it answers and resume a phase against nothing.
    // And a fresh session reading the record sees the session's own testimony
    // and the world's answer to it as one fact, which is how a resume brief can
    // say what was waited on AND what happened, rather than only that something
    // did.
    if (record.declared) {
      record.declared.landed = {
        ref: landed.ref,
        ...(landed.detail ? { detail: landed.detail } : {}),
        at: new Date().toISOString(),
        resumes,
      };
    }
    try { saveRun(state); } catch { /* the launch matters more than the write */ }
    this.emit('run:state', { state });
    const instruction = `The external work this phase declared it was waiting on has landed: `
      + `${landed.ref}${landed.detail ? ` (${landed.detail})` : ''}. ${landingDirective(landed)} then carry the `
      + 'phase to its exit criteria — verify, commit, and write the handoff — or declare the next '
      + 'honest outcome with phase-outcome.sh.';
    // `settled: true`: the continue below decides from the run's state AFTER the
    // recovery, not from the state it had while the recovery was still being
    // admitted. `recover()` answers synchronously, so this `.then` used to run
    // against `status: running` and do nothing at all (R7).
    const watchActor = doorActor('watch-landed', {
      by: 'watch', via: 'timer', origin: 'watch-scheduler', trigger: landed.ref,
      guard: 'autoContinueRecovery,allowRun,!liveRunner,!fleetHold', counter: `watchResumes:${resumes}`,
    });
    const drive = sessionId
      ? this.recoverPhase(slug, c.phase, 'resume', { by: 'watch', instruction, settled: true })
      : this.retryPhase(slug, c.phase, undefined, watchActor);
    // The drive is registered BEFORE anything can observe it and released by
    // whichever settlement handler runs — the scheduler holds the landed offer
    // back exactly as long as this entry lives (`watchResumeInFlight`).
    this.watchDrives.add(driveKey);
    void drive
      .then(async (result) => {
        this.watchDrives.delete(driveKey);
        // The drive settled. What it KNOWS is read from what it left behind,
        // never from the intent that started it: for the retry vehicle a
        // non-null run means the runner is now driving the phase; for the
        // session vehicle the record's own attempt bookkeeping moved iff a
        // session really ran (`endedAt` — see `endedBefore` above), and a
        // record answering `running`/`verifying` is one still alive under it.
        const after = this.runners.get(slug)?.current()
          ?? (this.root ? loadRun(this.root.path, slug, state.id, this.liveRunIds()) : null);
        const rec = after && after.id === state.id ? after.phases[String(c.phase)] : null;
        let launched: boolean;
        if (!sessionId) launched = result != null;
        else if (!rec) launched = true; // the run moved on — nothing left to un-charge against
        else {
          const endedAfter = rec.endedAt ? Date.parse(rec.endedAt) : null;
          launched = rec.status === 'running' || rec.status === 'verifying'
            || (endedAfter !== null && (endedBefore === null || endedAfter > endedBefore));
        }
        if (!launched) {
          // `recoverPhase` RESOLVED without a session ever existing — an adopt
          // refusal, a cancelled or capped admission, a superseded gate, a
          // retry with nothing to edit. Round 3's H1(a): stamped as a delivery,
          // this shape gated the landing for ever with no errand, because
          // `endedAt` was never going to move. Un-charge it: the offer was not
          // spent, and the landing is offered again on the next cadence.
          log.info('run.watch-resume-void', { slug, phase: c.phase, ref: landed.ref });
          this.voidWatchDelivery(record, landed.ref, resumes);
          if (rec && rec !== record) this.voidWatchDelivery(rec, landed.ref, resumes);
          // The FRESH copy is saved when there is one — the drive may have
          // written state of its own (a pause, a reconcile) that a save of
          // this pass's snapshot would regress.
          const target = rec && !this.liveRunner(slug) ? after : state;
          try { saveRun(target ?? state); } catch { /* the next pass re-derives it */ }
          return;
        }
        // The same continue the session vehicle performs after a fix: a run
        // left parked with the phase healthy again resumes under its own
        // admission. Every guard the freeze/flags family imposes re-applies.
        if (!after || after.id !== state.id) return;
        if (after.status !== 'parked' || after.halt) return;
        if (this.fleetHold() || this.prefs.autoContinueRecovery === false || !this.flags.allowRun || this.liveRunner(slug)) return;
        await this.startRun(slug, {
          actor: watchActor,
          resumeRunId: after.id,
          ...(after.onlyPhases?.length ? { onlyPhases: after.onlyPhases } : {}),
          skills: after.skills ?? [],
        });
      }, (error) => {
        this.watchDrives.delete(driveKey);
        // ROLL THE RESUME BACK. The drive REJECTED — a recovery already in
        // flight, a spawn that could not start, a foreign lease — so nothing was
        // resumed, and leaving the charge standing is how three offers were
        // spent in three minutes on a phase where no session had started at all
        // (QA round 2, G1). The stamp is written above, in this same function,
        // which is the only reason this delete reaches it: when the scheduler
        // wrote it, it wrote AFTER this handler had already run (QA round 3,
        // H1(b)). The REJECTION is charged on its own ledger, the re-offer
        // backed off, and the warning said once per reason per lease (SLF-8,
        // RCV-8) — the un-charged offer used to come back every minute.
        this.voidWatchDelivery(record, landed.ref, resumes);
        const rejection = this.chargeWatchRejection(record, landed.ref, error);
        if (!rejection.repeated) {
          log.warn('run.watch-resume-failed', {
            slug, phase: c.phase, ref: landed.ref, error: rejection.reason, rejections: rejection.count,
            ...(rejection.until !== null ? { until: new Date(rejection.until).toISOString() } : {}),
          });
        }
        if (rejection.capped) {
          this.landingErrand(slug, state, record, c, landed,
            `${landed.ref} landed${landed.detail ? ` (${landed.detail})` : ''}, and ${rejection.count} attempts to resume `
              + `this phase were refused — last: ${rejection.reason}. Settle that, then Retry.`, journal);
        }
        try { saveRun(state); } catch { /* the next pass re-derives it anyway */ }
      })
      .catch((error) => {
        // The RESOLVED handler itself failed (a load, a save, a start). The
        // drive settled and its accounting stands; there is nothing here to
        // roll back — say what happened and leave the next cadence to it.
        this.watchDrives.delete(driveKey);
        log.warn('run.watch-resume-settle-failed', { slug, phase: c.phase, ref: landed.ref, error: (error as Error)?.message ?? String(error) });
      });
    this.announce('phase', {
      title: `External work landed · ${slug} P${c.phase}`,
      body: `${landed.ref}${landed.detail ? ` (${landed.detail})` : ''} — the phase's own session resumes to finish.`,
      tag: tagFor('phase', state.id, `watch-landed-${c.phase}`),
    }, { slug, runId: state.id, phase: c.phase });
    return {
      launched: true, phase: c.phase, situation: c.situation.key, label: c.situation.label,
      rung: 'poll-park', vehicle: sessionId ? 'session' : 'retry',
    };
  }

}
