/**
 * `ServiceLive` — link 2 of the `Service` chain.
 *
 * One contiguous section of a class that outgrew one file. The chain is a
 * FILE boundary, not a design boundary: members keep their order, their
 * bodies and their single prototype, so `Service` behaves exactly as it did
 * when this was one declaration — including for the tests that reach its
 * private members. `protected` here means "another link uses it", nothing
 * more. Read the chain in order; `service.ts` holds the concrete class.
 */
import { basename, join } from 'node:path';
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
  ConvergeScheduler, convergePlan, HALT_DELAY_MS, type ConvergeDeps, type ConvergeReport, type ConvergeTrigger, convergeView, type ConvergeView } from './converge.ts';
import { planWrite, runWrite } from './writes.ts';
import {
  run, invalidate, readMemoryBlock, readQaMode, readSessionPlan, readLint, readGateStatus,
  readText, readBoardText, type Board, type QaMode, type SessionPlan, type LintResult,
  type GateStatus,
} from './engine.ts';
import {
  composeFollowUp, isReviewVerdict, MAX_COMMENTS, phaseDiff, reviewHold,
  type CommentSide, type PhaseDiff, type ReviewRecord, type ReviewVerdict,
} from './review.ts';
import type { ReviewerFacts, ReviewerReport, ReviewerVerdictPolicy } from './reviewer.ts';
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
import { isCategory } from './push/catalogue.ts';
import { Notifications, type NotificationQuery, type NotificationRecord } from './notifications.ts';
import {
  branchState, commitsInRange, repoInfo, lastCommit, commitsTouching,
  type BranchState, type GitRepoInfo, type GitFileInfo,
} from './git.ts';
import {
  composeLanding, landingFile, planWindow, readLanding,
  type LandingPacket, type LandingWindow,
} from './landing.ts';
import { findMemory, memoryIndexLines } from './memory.ts';
import {
  loadSizing, loadMcpSurcharge, indexGraph, routeLayout, analysePhases, criticalPath, remainingWork,
  resolveBudget, weightOf, type Sizing, type McpSizing, type PhaseAnalysis,
} from './analysis/graph.ts';
import { loadGateVocab, gateKindOf, type GateVocab, type GateKind } from './analysis/gates.ts';
import {
  planCost, rungsToday, spendSummary, type PlanCostView, type SpendRunView, type SpendView,
} from './analysis/spend.ts';
import {
  buildInbox, inboxIds, pruneAcks, readAcks, removeAck, writeAck,
  INBOX_ACKS_DIR, type InboxAck, type InboxFacts, type InboxView,
} from './inbox.ts';
import {
  STALL_ESCALATE_MS, STALL_SIGNAL_META, inboxItemId, parseInboxItemId,
} from '../shared/attention-model.js';
import { isLiveStatus } from '../shared/status-vocab.js';
import { deriveEvidence } from '../shared/evidence-model.js';
import {
  DOCUMENT_PLAN_FIELDS, HANDOFF_PROSE_FIELDS, PROSE_PHASE_FIELDS, omit, summarizeRun, wants,
} from '../shared/projection.js';
import { mergeDecisions } from '../shared/decisions-model.js';
import { heldIdsCached } from './credentials-probe.ts';
import {
  planStats, portfolio, etaSamples, etaFrom, rateFor, phaseEtaFor, healthIssues, isClosedStatus, splitRepos,
  dutyCycle, forecastFrom,
  type PlanStats, type Portfolio, type PlanContext, type EtaEstimate, type EtaSample,
  type PhaseEta, type RateReading, type Forecast,
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
  classifySituation, collectEvidence, summariseEvidence,
  type EvidenceDeps, type PhaseEvidence, type Situation,
} from './runner/situation.ts';
import {
  accountRung, errandFor, ladderCaps, nextRung, rungsFor, settleRung, type Rung,
} from './runner/ladder.ts';
import type { Actor, McpDegradation, PhaseRecord as RunPhaseRecord } from './runner/state.ts';
import { asActor, pressActor } from './actor.ts';
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
import { DEFAULT_WAIT_BUDGET, waitBudgetFrom, type WaitBudget } from './runner/wait-budget.ts';
import { dateOfRef } from './watch-refs.ts';
import { appendAck as appendRulingAck, ingestRulings, readRulings, rulingsFile, type Ruling } from './runner/rulings.ts';
import {
  autoResolveRun, childrenOf, latestRun, listRuns, loadRun, newRun, phaseRecord, pidAlive,
  reconcileRecordsAgainstBoard, resetForRetry, resolveRunsAgainst, saveRun,
  slugsNeedingBoard, runDir, waitReasonOf, IN_FLIGHT, PHASE_IN_FLIGHT, RESOLVABLE, isMcpPolicy, mcpReasonText,
  type BoardingBrief, type Errand, type McpPolicy, type PreflightWarning, type RungRecord, type RunState, type VerifySummary,
} from './runner/state.ts';
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
import { accessLedger } from './api/access.ts';
import {
  RECOVERY_TITLES, recoveryKey,
  type RecoveryClass, type RecoveryFacts, type RecoveryRequest,
} from './recovery.ts';
import { buildAgentLaunch, phasedExecutionSkillId } from './agent.ts';
import {
  isVerdict, qaKey, type QaFacts, type QaRequest,
} from './qa-session.ts';
import {
  Approvals, classifyTool, matchedDenyRule, loadPolicy, loadPolicyFor, policyExtras, addPolicyRules,
  editPolicy, planPolicyPath, effectivePlanPolicyPath, notifyOutOfBand, carvedPolicy, suggestedRule,
  autoApproveFor, neverAutoApproves, hitsHidden, struckFor,
  parseRule, inertRules, HOOK_TOOLS, WRAPPERS_NOT_STRIPPED,
  PERMISSION_PROFILES, PROFILE_LABELS, DEFAULT_PERMISSION_PROFILE,
  DEFAULT_DENY, DEFAULT_ASK, DEFAULT_ALLOW, POLICY_PATH,
  type Evidence, type PolicyScope, type PermissionProfile,
} from './runner/approvals.ts';
import {
  AUTO_GRANT_REASONS, ETA_POOL_MS, EVENT_BUFFER, HOOK_EVENTS_PER_MINUTE, HookPayloadError, HookRateError, INBOX_SOURCES, MAX_TIMER_MS, OUTCOME_INBOX_DEBOUNCE_MS, OUTCOME_INBOX_MAX_AGE_MS, PhaseClaimedError, RecoveryBusyError, UNSUPERVISED_WAIT_DEFAULT_MS, autoRecoveryClass, bucketLabel, describeExit, describeToolInput, effortOf, gitPorcelain, gitRead, lockView, modelAlias, phaseLive, ptyClaudeSessions, recoveryActions, recoveryOwner, seedSkills, situationOfHalt, titleOf, type AutoRecoverResult, type Cached, type ControlResult, type DriveVehicle, type EtaPool, type EvidenceView, type LiveEvent, type LiveListener, type LockRelease, type PhaseDiagnosis, type PhaseLive, type PhaseLockView, type PhaseView, type PlanDetail, type PlanSummary, type QaOutcome, type RecoveryAction, type RouteView, qaHeldBy,
} from './service-core.ts';
import { factsFor, splitSituation } from '../shared/fact-map.js';
import type { Service } from './service.ts';
import { ServiceBase, trimOldest, NOTIFIED_CAP } from './service-base.ts';
import { parseQaRounds, type QaRoundRow } from './parse/folder.ts';
import { readFileSync } from 'node:fs';

export abstract class ServiceLive extends ServiceBase {
  /* ---------------------------------------------------------------- *
   * Live updates
   * ---------------------------------------------------------------- */

  onEvent(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Events a reconnecting client missed. Browsers resend `Last-Event-ID`
   * automatically, so a dropped SSE connection no longer loses updates — which
   * stops mattering only as long as nothing important flows through here, and
   * run progress will.
   */
  eventsSince(id: number): LiveEvent[] {
    return this.eventLog.filter((entry) => entry.id > id);
  }

  emit(event: string, data: unknown): void {
    const id = ++this.eventCursor;
    this.eventLog.push({ id, event, data });
    if (this.eventLog.length > EVENT_BUFFER) this.eventLog.shift();
    for (const listener of this.listeners) {
      try { listener(event, data, id); } catch { /* a dead client must not stop the others */ }
    }
    this.nudgeInbox(event);
  }

  /**
   * Tell the client its attention inbox may have changed — at most once a beat.
   *
   * The inbox is computed on read from a dozen sources, so it has no single
   * event of its own: an approval, a park, a lock, a sign-in and a health
   * flip all change it. Rather than teach each of them, anything that could
   * change it schedules ONE `inbox` tick, which the client answers with a
   * single fetch. Debounced because a boarding run emits a burst and an inbox
   * that refetched per event would be the noisiest thing on the wire.
   */
  private nudgeInbox(event: string): void {
    if (event === 'inbox' || !INBOX_SOURCES.some((prefix) => event.startsWith(prefix))) return;
    if (this.inboxTimer) return;
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = null;
      this.emit('inbox', { at: new Date().toISOString() });
    }, 400);
    this.inboxTimer.unref?.();
  }

  /**
   * Everything the runner emits, plus the two moments worth waking someone for.
   *
   * A run that halts at 2am and a run that finishes are the only states where
   * nothing further happens until a person acts, so they are the only ones that
   * earn an out-of-band notification. Announcing every phase would train the
   * habit of ignoring them, which costs exactly the halt that mattered.
   */
  protected onRunnerEvent(event: string, data: unknown): void {
    this.emit(event, data);
    if (event === 'run:phase') {
      // A `require` MCP park starts its clock here — the service owns the
      // timer because only the service can restart a run the park stopped.
      const parked = data as { slug?: string; runId?: string; phase?: number; mcpPark?: { at: string } } | undefined;
      if (parked?.slug && parked.runId && typeof parked.phase === 'number' && parked.mcpPark?.at) {
        const due = mcpParkDueAt(
          { status: 'parked', mcpPark: { at: parked.mcpPark.at, degraded: [] } } as never,
          this.mcpRequireTimeoutMs(),
        );
        if (due !== null) this.armMcpRequireTimer(parked.slug, parked.phase, due);
      }
      this.announcePhase(data);
      // `parkWithErrand` puts the errand on this same event; announcing here
      // rather than at the park keeps the one dedupe in one place.
      this.announceErrand(data);
      // `maybeQaVerdict` exiting with the verdict still owed rides the same
      // event — the one arise-moment a LIVE run has (stopped runs reach the
      // channel through the healer's errand).
      this.announceQaHold(data);
      // Second of the three ways a stall stops being true: the phase it was
      // about is over. A lane that stalled and then FINISHED never emits a
      // liveness clear — the ticker stops with the lane — so without this the
      // card would outlive its own subject.
      const ended = data as { slug?: string; runId?: string; phase?: number; status?: string } | undefined;
      // `PHASE_IN_FLIGHT` is the owner of "this phase still has a loop behind
      // it" — read, never re-derived: a second list of running statuses is the
      // shape that lets two readers disagree.
      if (ended?.slug && typeof ended.phase === 'number' && ended.status
        && !PHASE_IN_FLIGHT.includes(ended.status as never)) {
        this.retractStall(
          { runId: ended.runId, slug: ended.slug, phase: ended.phase },
          `phase ${ended.phase} ended (${ended.status})`,
        );
      }
      return;
    }
    if (event === 'run:liveness') { this.announceStall(data); return; }
    if (event === 'run:watchdog') { this.announceWatchdog(data); return; }
    if (event !== 'run:run') return;

    const state = (data as { state?: RunState } | undefined)?.state;
    if (!state) return;
    // A halt that DISSOLVED retracts its urgent card. Reconcile closing the
    // records, a continue, a recovery — whatever moved the run past the halt
    // makes the earlier "halted" notification stale, and 5 of 9 real urgent
    // halts were superseded within 60 seconds. Before the dedupe check on
    // purpose: the retraction must fire exactly when the status changes.
    // `interrupted` rides the `halted` category (below) and so must be retracted
    // by the same rule — the memory holds the STATUS, so both spellings count.
    const said = this.notifiedRun.get(state.id);
    if (!state.halt && (said === 'halted' || said === 'interrupted')) {
      this.retractHalt(state, 'the board moved past the halt', { push: false });
    }
    // Third of the three: the run settled. Whatever a lane was doing when it
    // went quiet, it is not doing it now — and a stall card that outlives its
    // run is exactly how the inbox came to hold 26 of them and release none.
    if (!isLiveStatus(state.status)) {
      this.retractStall({ runId: state.id, slug: state.slug }, `the run ${state.status}`);
    }
    // A stop is also the convergence trigger — a pass a minute out, decided
    // entirely by the loop when it runs: the run may have been continued,
    // fixed by hand or opted out by then. Every stopped shape, not only the
    // halted and verification-parked ones — the loop reads the situation and
    // leaves alone what it must (an operator's stop, a resolved run).
    if (state.status === 'halted' || state.status === 'parked' || state.status === 'interrupted') {
      this.scheduleAutoRecover(state.slug);
    }
    // The wait clock is BOOKKEEPING, not an announcement, so it is armed
    // before the dedupe below and on every waiting emit. It used to live
    // inside the `waiting` case: a run announced `waiting` at its FIRST park
    // kept that status when a SECOND park moved `waitUntil`, the dedupe
    // returned early, and the new clock was never armed — run 258e1cc7 then
    // slept past its own 02:53Z clock until a person pressed Recheck at
    // 06:52Z. `armLimitResume` is a no-op when the clock is already armed.
    if (state.status === 'waiting' && state.waitUntil) this.armLimitResume(state.slug, state);
    // Dedupe on the run *and* its status. Keying on the run alone — which this
    // did — meant a run announced once as parked could later halt, or finish,
    // in silence.
    // Per RUN, not one slot for the console. With two runs live, a single slot
    // makes each announcement erase the other's memory of itself — so the same
    // halt is announced again on the next event, and again, for as long as its
    // neighbour keeps persisting.
    if (this.notifiedRun.get(state.id) === state.status) return;

    const push = (category: 'halted' | 'parked' | 'finished', title: string, body: string) => {
      this.notifiedRun.set(state.id, state.status);
      // Tagged by CATEGORY, not by status: `interrupted` rides `halted`, and
      // the corrective in `retractHalt` rides the halted tag — a status-keyed
      // tag left an interrupted run's urgent card with no card to replace it,
      // and a second, quiet "resolved" card beside it forever.
      this.announce(category, {
        title, body, tag: tagFor('run', state.id, category),
      }, { slug: state.slug, runId: state.id });
    };

    switch (state.status) {
      case 'halted':
        push('halted', `${state.slug} halted`, state.halt?.reason ?? 'the run stopped and needs a person');
        break;
      case 'interrupted':
        // Nothing is driving it and nothing said why — the failure mode that
        // otherwise looks exactly like a run still working.
        push('halted', `${state.slug} interrupted`, 'nothing is driving this run any more');
        break;
      case 'parked':
        push('parked', `${state.slug} parked`, state.halt?.reason ?? 'every remaining phase needs a person');
        break;
      case 'waiting': {
        const parked = waitReasonOf(state) === 'external';
        push('parked', `${state.slug} is waiting`,
          parked
            ? state.finishedReason ?? 'waiting on external work; resumes on its own'
            // The runner writes "usage limit — resets <time>" here; saying
            // when is the whole of what the operator wants from this card.
            : state.finishedReason ?? 'asleep until a usage window reopens');
        // The resume clock is armed ABOVE the dedupe, not here — an arm that
        // rides an announcement is silenced with it.
        break;
      }
      case 'finished': {
        const done = Object.values(state.phases).filter((p) => p.status === 'done').length;
        push('finished', `${state.slug} finished`,
          `${done} phase(s) done · $${state.spentUsd.toFixed(2)} spent`);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Stand a stale "halted" notification down: its subject dissolved.
   *
   * The inbox half annotates (`resolved` + read) — never deletes. The push
   * half sends ONE quiet corrective riding the SAME tag, so the service
   * worker replaces the displayed alarm and an undelivered pending push is
   * superseded by web-push topic — and only when a changed record is younger
   * than 30 minutes (older history must not buzz anew). No new inbox record:
   * a correction annotates, it does not add. `notifiedRun` is cleared so the
   * next REAL halt announces fresh.
   */
  protected retractHalt(state: RunState, reason: string, opts: { push: boolean }): void {
    const changed = this.notifications.resolveWhere({ runId: state.id, category: 'halted' }, reason);
    this.notifiedRun.delete(state.id);
    if (!changed.length) return;
    for (const record of changed) this.emit('notification', record);
    const young = changed.some((record) => Date.now() - Date.parse(record.at) < 30 * 60_000);
    if (opts.push && young) {
      this.push.announce('halted', {
        title: `${state.slug}: resolved on its own`,
        body: reason,
        tag: tagFor('run', state.id, 'halted'),
        url: routeFor('halted', { slug: state.slug }),
        // `replace`: this rides the alarm's own tag ON PURPOSE — without it the
        // 5-second same-tag dedupe reads a fast resolve as a re-render and
        // swallows the all-clear, leaving the stale alarm on the lock screen.
      }, Date.now(), undefined, { urgent: false, replace: true });
    }
    log.info('run.halt-retracted', { slug: state.slug, runId: state.id, reason, records: changed.length });
  }

  /**
   * Each phase as it lands — and the one that lands on a question.
   *
   * `awaiting-verification` reached neither announcer before: `announcePhase`
   * returned early on anything but `done|failed`, and `announceRun` only ever
   * looks at the run. So the single state where a phase has done its work and
   * stopped dead on a check nobody but a person can make was the one state that
   * told nobody. It is not a failure and not a success, so it gets its own
   * category rather than being smuggled into either.
   */
  /**
   * The one ask for a person the ladder leaves behind, pushed once.
   *
   * This is the gap the 2.3.0 ladder shipped with: a phase would exhaust its
   * rungs, park with a perfectly good `Errand {need, how, tried}`, and the
   * operator would find out by opening the console. The errand was written to
   * the record, journalled and rendered — and never pushed. A ladder whose
   * whole promise is "a person is asked once, with an errand" has to do the
   * asking.
   *
   * `needs-you` and not `phase`: this is not progress, it is a request. The
   * category is the one an operator keeps on when they have turned the rest
   * off.
   */
  protected announceErrand(data: unknown): void {
    const event = data as {
      slug?: string; runId?: string; phase?: number;
      errand?: { at?: string; need?: string; how?: string; tried?: string[]; situation?: string };
    } | undefined;
    const { slug, runId, phase, errand } = event ?? {};
    // A RUN-level errand carries no phase — converge writes one for a stop that
    // belongs to no single phase, and `ConvergeDeps.announceErrand` types the
    // parameter `number | null` precisely to allow it. This guard read `typeof
    // phase !== 'number'` and dropped every one of them on the floor: the ask
    // was stored on the run and rendered on the run page, and never pushed. The
    // whole point of an errand is that it reaches somebody who is not looking.
    if (!slug || !errand?.need) return;
    if (phase != null && typeof phase !== 'number') return;

    const key = `${runId ?? slug}:${phase ?? 'run'}:${errand.at ?? ''}`;
    if (this.notifiedErrand.has(key)) return;
    this.notifiedErrand.add(key);
    // The set is per-process and unbounded only in theory; a console that ran
    // long enough to matter has restarted for other reasons first. Trimmed all
    // the same, oldest-first, so a very long-lived instance cannot grow it.
    if (this.notifiedErrand.size > 500) {
      const oldest = this.notifiedErrand.values().next().value;
      if (oldest) this.notifiedErrand.delete(oldest);
    }

    const title = phase != null ? this.store?.get(slug)?.plan?.phases[phase]?.title : undefined;
    // WHICH channel, from the fact map rather than from here. A `gated-manual`
    // errand is a gate: it waits on a decision, nothing is spending while it
    // waits, and the door is one button on the phase page — so it announces on
    // the `gate` category, which an operator can keep on separately from the
    // urgent one. Everything else keeps `needs-you`, which is the category
    // somebody keeps on when they have turned the rest off. A situation whose
    // mapped category is null (a live session, a superseded record) is not an
    // errand and never reaches here.
    const mapped = errand.situation ? factsFor(...splitSituation(errand.situation)) : null;
    // The fact map's word is honoured whenever it is a category: `qa-failed`
    // announces on `qa`, a resource wall on `limits`, a broken plan on
    // `health`, a red verification on `halted`. It used to honour `gate` alone
    // and rewrite the other five to `needs-you` — so an operator who kept `qa`
    // on and muted `needs-you`, the catalogue's own advice, heard nothing.
    const category: CategoryId = isCategory(mapped?.pushCategory) ? mapped.pushCategory : 'needs-you';
    // A gate's card is the SAME card the live runner raised when the phase
    // gated (`announcePhase`): same category, same tag, same Approve button —
    // the errand replaces it rather than standing a second, buttonless copy
    // beside it. Every other ask names its situation in the tag, so two
    // different asks about one phase are two cards rather than one silent
    // replacement.
    const gate = category === 'gate' && phase != null;
    this.announce(category, {
      title: phase != null ? `${slug} · phase ${phase} needs you` : `${slug} needs you`,
      body: errand.need.slice(0, 200),
      // The how is the actionable half; a push that says only "it is stuck"
      // makes the operator open the console to learn what to do.
      ...(errand.how ? { detail: `${errand.how}${title ? ` — ${title}` : ''}`.slice(0, 400) } : {}),
      tag: gate ? tagFor('gate', slug, phase) : tagFor(category, slug, phase, errand.situation),
    }, {
      slug,
      ...(phase != null ? { phase } : {}),
      ...(runId ? { runId } : {}),
      ...(gate ? { answer: { item: inboxItemId({ kind: 'gate', slug, phase }), verbs: ['approve'] } } : {}),
    });
  }

  /**
   * A QA hold arising on a LIVE run: the finish dispatcher (`maybeQaVerdict`)
   * exited with the phase's verdict still owed, so the pending row now holds
   * every dependent and nothing records a verdict by itself. Announced once
   * per (slug, phase, verdict); a closed plan claims nothing about progress,
   * so it is silenced the same way the inbox's qa rows are.
   */
  protected announceQaHold(data: unknown): void {
    const event = data as { slug?: string; runId?: string; phase?: number; qaVerdict?: string } | undefined;
    const { slug, runId, phase, qaVerdict } = event ?? {};
    if (!slug || typeof phase !== 'number' || !qaVerdict) return;
    // `fail` is the catalogue's other half ("or QA recorded a fail") and had no
    // announcer at all: the category's urgent switch guarded a card that was
    // never sent.
    if (qaVerdict !== 'pending' && qaVerdict !== 'none' && qaVerdict !== 'fail') return;
    if (this.isClosedPlan(slug)) return;

    const key = `${slug}:${phase}:${qaVerdict}`;
    if (this.notifiedQaHold.has(key)) return;
    this.notifiedQaHold.add(key);
    if (this.notifiedQaHold.size > 500) {
      const oldest = this.notifiedQaHold.values().next().value;
      if (oldest) this.notifiedQaHold.delete(oldest);
    }

    const failed = qaVerdict === 'fail';
    this.announce('qa', {
      title: failed
        ? `${slug} · phase ${phase} — QA failed`
        : `${slug} · phase ${phase} — QA verdict owed`,
      body: failed
        ? 'QA recorded a fail and this plan gates on QA: every phase that depends on this one is held '
          + 'until the fix lands and a fresh verdict reads pass or waived.'
        : 'The phase is done and this plan gates on QA: until a verdict is recorded it holds '
          + 'every phase that depends on it.',
      detail: failed
        ? 'The report is under docs/handoffs/<slug>/reports/; fix, then re-run QA from the phase page.'
        : 'Run QA from the phase page (the QA launcher) or record pass/waived with qa-record.sh.',
      // One tag per phase: a fail REPLACES the "owed" card rather than joining it.
      tag: tagFor('qa', slug, phase),
    }, { slug, phase, ...(runId ? { runId } : {}) });
  }

  /**
   * A lane that is still running and has stopped being work.
   *
   * Deliberately NOT urgent (`push/catalogue.ts`): nothing is blocked on the
   * operator and the run has not stopped — this is the money question, not the
   * permission question, and a card that buzzed a wrist for it would be turned
   * off inside a week, taking the signal with it.
   *
   * Fires only on a transition, because the runner only emits a stall on one:
   * the ticker evaluates every lane every minute and journals nothing when the
   * answer has not changed. The dedupe here is the belt — a console restarted
   * mid-episode has an empty map and will say it once more, which is right.
   */
  private announceStall(data: unknown): void {
    const event = data as {
      slug?: string; runId?: string; phase?: number; attempt?: number;
      stall?: { signal?: string; detail?: string } | null;
    } | undefined;
    const { slug, runId, phase, stall } = event ?? {};
    if (!slug || typeof phase !== 'number') return;
    // The CLEAR half of the same event. `evaluateLane` emits with `stall: null`
    // the moment a lane starts producing work again — which is the one moment
    // at which "nothing is happening" became false, and therefore the moment
    // the card about it must stand down. Without this every stall card ever
    // raised stayed open forever: 26 issued, 0 resolved, against 34 of 37
    // `halted` cards resolving themselves.
    if (!stall?.signal) {
      this.retractStall({ runId, slug, phase }, 'the lane started producing work again');
      return;
    }

    const key = `${runId ?? ''}:${phase}:${stall.signal}:${event?.attempt ?? 0}`;
    if (this.notifiedStall.has(key)) return;
    this.notifiedStall.add(key);
    // The same bound the errand set keeps, for the same reason: a set that only
    // ever grows is a leak in a console that runs for weeks.
    if (this.notifiedStall.size > 500) {
      const oldest = this.notifiedStall.values().next().value;
      if (oldest) this.notifiedStall.delete(oldest);
    }

    const meta = STALL_SIGNAL_META[stall.signal as keyof typeof STALL_SIGNAL_META];
    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    const headline = `${slug} · phase ${phase} — ${meta?.label.toLowerCase() ?? stall.signal}`;
    const body = stall.detail ?? meta?.blurb ?? 'the session has stopped producing work';
    this.announce('stalled', {
      title: headline,
      body,
      ...(title ? { detail: title.slice(0, 200) } : {}),
      tag: tagFor('stalled', slug, phase, stall.signal),
    }, { slug, phase, ...(runId ? { runId } : {}) });
    this.armStallEscalation(key, {
      slug, phase, runId, signal: stall.signal, title: headline, body, at: Date.now(),
    });
  }

  /**
   * The silent-session watchdog acted on a lane. Say so, once, honestly.
   *
   * The rule this follows is the one `retractStall` was written for: a card
   * must not outlive its subject. A stall card raised at minute ten is about a
   * session; when the watchdog RECYCLES, that session no longer exists, so the
   * card is retracted and replaced by one line saying what the console did.
   * Without this the operator sees a stall card quietly vanish and has no way
   * to know whether it was fixed, ignored, or lost.
   *
   * The three actions get three different amounts of noise, deliberately:
   *
   *   - `nudged`   — nothing. It is one line written to a session that may
   *     answer it in seconds; a push for every nudge is the "we do not buzz for
   *     every stall" policy being spent on the cheapest event of the three. It
   *     is in the journal, which is where a curious operator is already looking;
   *   - `recycled` — one quiet card, plus the retraction. A process was killed
   *     on the operator's behalf and they are owed the sentence;
   *   - `parked`   — nothing HERE. Parking emits `run:phase` carrying the
   *     errand, which `announceErrand` already announces with the one dedupe
   *     that keeps a park from being said twice. A second announcement here
   *     would be the same event twice under two names.
   */
  private announceWatchdog(data: unknown): void {
    const event = data as {
      slug?: string; runId?: string; phase?: number; action?: string;
      recycles?: number; sessionId?: string | null;
    } | undefined;
    const { slug, runId, phase, action } = event ?? {};
    if (!slug || typeof phase !== 'number') return;
    if (action !== 'recycled') return;
    this.retractStall({ runId, slug, phase }, 'the console recycled the silent session');
    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;
    // A sentence is a claim, so it may only use what the writer wrote — the
    // journal renderer's own rule, and it applies here too. A session with no
    // id yet is re-boarded from its boot prompt, and telling the operator it
    // was resumed would be a false sentence in the one place they cannot check
    // it. `checkpointLane` makes exactly the same distinction in its note.
    const resumed = typeof event?.sessionId === 'string' && event.sessionId
      ? 'the session was ended and the phase re-boarded on the same session id. Nothing was lost.'
      : 'the session was ended and the phase re-boarded. It had no session id yet, so it starts '
        + 'again from its boot prompt — and it had done nothing to lose.';
    // `stalled` and not `phase`: the operator who switched stall cards on is
    // exactly the one who wants to know a stall was acted on, and one who muted
    // them does not want a recycle card either. It also keeps the retraction
    // above and the line that replaces it in the same channel, which is what
    // makes them read as one event rather than two.
    this.announce('stalled', {
      title: `${slug} · phase ${phase} — silent session recycled`,
      body: `It produced no output at all and never made a tool call, so ${resumed}`,
      ...(title ? { detail: title.slice(0, 200) } : {}),
      tag: tagFor('watchdog', slug, phase, String(event?.recycles ?? 1)),
    }, { slug, phase, ...(runId ? { runId } : {}) });
  }

  /**
   * Start the second clock on a stall episode.
   *
   * Every stall card this console ever issued was quiet and none was ever
   * re-said, so a 70-minute hang cost exactly one buzz at minute ten. The fix
   * is not a louder first card — at minute ten "it is thinking" is still the
   * likely explanation — but a SECOND look, once, at
   * `stallEscalateMs` (45 min shipped, `STALL_ESCALATE_MS`).
   */
  private armStallEscalation(key: string, info: {
    slug: string; phase: number; runId?: string; signal: string;
    title: string; body: string; at: number;
  }): void {
    if (this.stallEscalations.has(key)) return;
    // Zero is the off switch, not a zero-length timer: an operator who wants
    // the pre-escalation behaviour back sets it, and gets exactly one quiet
    // card per episode as before. `Math.max(1, …)` here would have turned that
    // into an escalation on the next tick — the precise inverse.
    const wanted = this.prefs.stallEscalateMs ?? STALL_ESCALATE_MS;
    if (!(wanted > 0)) return;
    const after = Math.min(wanted, MAX_TIMER_MS);
    const timer = setTimeout(() => { this.escalateStall(key); }, after);
    timer.unref?.();
    this.stallEscalations.set(key, { timer, ...info });
  }

  /**
   * The escalation threshold arrived and nothing resolved this stall.
   *
   * ONE re-announcement, urgent, and then the entry is dropped whatever
   * happens next: a loop here would be the thing the non-urgent policy exists
   * to prevent. The record is fresh rather than a re-send of the first one —
   * a new tag, so the phone shows it beside (not instead of) the quiet card
   * the operator already dismissed an hour ago.
   */
  private escalateStall(key: string): void {
    const open = this.stallEscalations.get(key);
    this.stallEscalations.delete(key);
    if (!open) return;
    clearTimeout(open.timer);
    // The stall must STILL be the lane's state. A run whose process died
    // without emitting a clear leaves an armed timer behind, and waking
    // somebody for a lane that is not running any more is worse than silence.
    const live = open.runId ? this.runners.get(open.slug)?.current() : null;
    if (!live || live.id !== open.runId || !isLiveStatus(live.status)) return;
    if (!live.phases[open.phase]?.stall) return;

    const minutes = Math.max(1, Math.round((Date.now() - open.at) / 60_000));
    const said = this.announce('stalled', {
      title: `Still stalled after ${minutes} min — ${open.title}`,
      body: `${open.body} Nothing has changed since the first notice; the lane is still spending.`,
      tag: tagFor('stalled', open.slug, open.phase, open.signal, 'escalated'),
    }, {
      slug: open.slug, phase: open.phase, ...(open.runId ? { runId: open.runId } : {}),
    }, { urgent: true });
    // Remembered so that the all-clear can replace the card this one left on a
    // lock screen — but only when it actually LEFT one. An escalation the
    // prefs gate suppressed earned no buzz, so it is owed no all-clear push
    // later; remembering it anyway is how "the stall cleared" wakes a phone
    // for an alarm that never sounded. Bounded like every other in-memory
    // dedupe here.
    if (said) {
      this.escalatedStalls.set(key, {
        slug: open.slug, phase: open.phase, runId: open.runId, signal: open.signal,
      });
      if (this.escalatedStalls.size > 200) {
        const oldest = this.escalatedStalls.keys().next().value;
        if (oldest) this.escalatedStalls.delete(oldest);
      }
    }
    log.info('run.stall-escalated', {
      slug: open.slug, phase: open.phase, runId: open.runId, signal: open.signal, minutes,
    });
  }

  /**
   * Stand every open stall card for this scope down: its subject dissolved.
   *
   * The `halted` category has had this since the halt-retraction work
   * (`retractHalt`); `stalled` had nothing, which is why the inbox accumulated
   * every stall it ever raised. Three callers, one per way a stall can stop
   * being true: the lane produced work again, the phase ended, the run
   * settled.
   *
   * No corrective push for the quiet card — it never buzzed, so there is
   * nothing to take back and a push saying "never mind" would be the second
   * interruption the policy exists to avoid. The one exception is an episode
   * that was ESCALATED: that one did buzz, urgently, so the all-clear rides
   * the same tag to replace the card it left on the lock screen.
   */
  protected retractStall(
    scope: { runId?: string; slug?: string; phase?: number },
    reason: string,
  ): void {
    const escalated = this.disarmStallEscalations(scope);
    // `resolveWhere` refuses an empty scope (it would match everything), and
    // a run with no id is a run nothing can be keyed to.
    const query = scope.runId
      ? { runId: scope.runId, category: 'stalled', ...(typeof scope.phase === 'number' ? { phase: scope.phase } : {}) }
      : scope.slug
        ? { slug: scope.slug, category: 'stalled', ...(typeof scope.phase === 'number' ? { phase: scope.phase } : {}) }
        : null;
    if (!query) return;
    // The first-announcement dedupe forgets the episode too, or a lane that
    // stalls, recovers and stalls AGAIN on the same signal and attempt is never
    // announced a second time — and never armed for its 45-minute re-say. The
    // key is `runId:phase:signal:attempt`; slug-only scopes cannot be matched
    // against it, and (per the runner) every stall event carries a runId.
    if (scope.runId) {
      const prefix = `${scope.runId}:`;
      for (const key of [...this.notifiedStall]) {
        if (!key.startsWith(prefix)) continue;
        // The phase is the first segment AFTER the run id, whatever the id holds.
        const ph = key.slice(prefix.length).split(':')[0];
        if (typeof scope.phase === 'number' && ph !== String(scope.phase)) continue;
        this.notifiedStall.delete(key);
      }
    }
    const changed = this.notifications.resolveWhere(query, reason);
    if (!changed.length) return;
    for (const record of changed) this.emit('notification', record);
    for (const key of escalated) {
      this.push.announce('stalled', {
        title: `${key.slug}: the stall cleared`,
        body: reason,
        tag: tagFor('stalled', key.slug, key.phase, key.signal, 'escalated'),
        url: routeFor('stalled', { slug: key.slug, phase: key.phase }),
        // Same-tag replacement as the halt corrective: without `replace`, an
        // escalation resolved inside the dedupe window keeps its urgent card.
      }, Date.now(), undefined, { urgent: false, replace: true });
    }
    log.info('run.stall-retracted', { ...scope, reason, records: changed.length });
  }

  /**
   * Drop the escalation clocks this scope covers, and report which of them had
   * already fired — those are the ones an all-clear push is owed to.
   */
  private disarmStallEscalations(
    scope: { runId?: string; slug?: string; phase?: number },
  ): { slug: string; phase: number; signal: string }[] {
    const covers = (open: { slug: string; phase: number; runId?: string }): boolean => {
      if (scope.runId && open.runId !== scope.runId) return false;
      if (!scope.runId && scope.slug && open.slug !== scope.slug) return false;
      if (typeof scope.phase === 'number' && open.phase !== scope.phase) return false;
      return true;
    };
    for (const [key, open] of [...this.stallEscalations]) {
      if (!covers(open)) continue;
      clearTimeout(open.timer);
      this.stallEscalations.delete(key);
    }
    // An episode that already fired is no longer in the armed map — it removes
    // itself when it escalates — so the ones that BUZZED are remembered
    // separately. They are the only ones owed an all-clear.
    const fired: { slug: string; phase: number; signal: string }[] = [];
    for (const [key, open] of [...this.escalatedStalls]) {
      if (!covers(open)) continue;
      this.escalatedStalls.delete(key);
      fired.push({ slug: open.slug, phase: open.phase, signal: open.signal });
    }
    return fired;
  }

  private announcePhase(data: unknown): void {
    const event = data as {
      slug?: string; phase?: number; status?: string; notRun?: number;
      gate?: { clear?: boolean; kind?: string; detail?: string };
      reviewHold?: unknown[];
    } | undefined;
    const { slug, phase, status } = event ?? {};
    if (!slug || typeof phase !== 'number') return;
    if (status !== 'done' && status !== 'failed' && status !== 'awaiting-verification'
      && status !== 'gated') return;

    const key = `${slug}:${phase}`;
    if (this.notifiedPhase.get(key) === status) return;
    this.notifiedPhase.set(key, status);
    // Its sibling `notifiedErrand` has always trimmed at 500 and this one never
    // did, though it grows on exactly the same axis — one entry per phase of
    // every plan this console has ever watched pass through four statuses, kept
    // for the life of the process. Re-inserting on the far side of a trim is
    // harmless: the worst case is one duplicate announcement of a phase nobody
    // has looked at in 500 phase-events.
    trimOldest(this.notifiedPhase, NOTIFIED_CAP);

    const title = this.store?.get(slug)?.plan?.phases[phase]?.title;

    /* ---- gated ----
     * A gate is the one stop that was reachable by nothing but looking. The
     * runner has always recorded it and the inbox has always raised it, but no
     * category announced it, so a run that parked on an operator's gate at
     * midnight said nothing at all until someone opened the console. It rides
     * the `gate` category — its own, since the catalogue grew one: a gate waits
     * on a DECISION, nothing is spending, and the door is one button. (It rode
     * `needs-you` before that category existed; the healer's later errand for
     * the same gate then announced on `gate`, so one stop became two cards on
     * two categories with the Approve button on the wrong one. Now both ride
     * this tag, and the second replaces the first.)
     *
     * The Approve button is attached only for a PERSON's gate that is really
     * not clear — the inbox raises a gate item for exactly those, and the
     * button looks the item up. An `ai`/`auto` gate is a session's or a
     * machine's to clear; a button on it answered 410 and opened the app. The
     * engine spells a person's gate `manual:` / `OVERDUE:` (`--gate-status`;
     * the word `human` is `--gate-kind`'s), and an unevaluated cmd gate is a
     * read that declined to run, not a decision — the same family
     * `runner-loop.ts` boards on and `situation.ts` classifies. `gated` is also
     * the status of a phase the console's own review hold is keeping back
     * (`runner-loop.ts` says why it reuses the word), and there is no gate on
     * that phase to approve — the reviewer has to lift their own hold. Same
     * notification, no button: the difference is what the button would DO, not
     * how loud the stop is.
     */
    if (status === 'gated') {
      const gate = event?.gate;
      const humanGate = /^(manual|human|OVERDUE)$/i.test(gate?.kind ?? '')
        && !/\bnot executed\b/i.test(gate?.detail ?? '');
      const approvable = Boolean(gate) && gate?.clear === false && humanGate;
      this.announce('gate', {
        title: `${slug} · phase ${phase} is gated`,
        body: event?.reviewHold?.length
          ? `${title ?? 'the phase'} is held by a review`
          : gate?.detail || `${title ?? 'the phase'} is waiting on a gate (${gate?.kind ?? 'manual'})`,
        tag: tagFor('gate', slug, phase),
        ...(title ? { detail: title.slice(0, 200) } : {}),
      }, {
        slug,
        phase,
        ...(approvable
          ? { answer: { item: inboxItemId({ kind: 'gate', slug, phase }), verbs: ['approve'] } }
          : {}),
      });
      return;
    }

    if (status === 'awaiting-verification') {
      const checks = Number(event?.notRun) || 0;
      this.announce('needs-you', {
        title: `${slug} · phase ${phase} needs you`,
        body: checks
          ? `${checks} check${checks === 1 ? '' : 's'} the runner will not make for you — ${title ?? 'the phase is waiting'}`
          : `${title ?? 'the phase'} is waiting to be verified`,
        // Named: the errand path tags its asks by situation, and this one used
        // to share `needs-you:slug:phase` with all of them — two different
        // asks about one phase collapsed into one silent replacement.
        tag: tagFor('needs-you', slug, phase, 'awaiting-verification'),
      }, { slug, phase });
      return;
    }

    // "Each phase as it lands, with what it cost" is the catalogue's promise;
    // the event carries neither the cost nor a failure's reason, but the runner
    // holding the phase record does.
    const record = this.runners.get(slug)?.current()?.phases?.[phase] as
      { costUsd?: number; note?: string } | undefined;
    const cost = typeof record?.costUsd === 'number' && record.costUsd > 0 ? ` · $${record.costUsd.toFixed(2)}` : '';
    const why = status === 'failed' && record?.note ? ` — ${record.note.slice(0, 160)}` : '';
    this.announce('phase', {
      title: `${slug} · phase ${phase} ${status}`,
      body: `${title ?? (status === 'done' ? 'the phase landed' : 'the phase did not land')}${cost}${why}`,
      tag: tagFor('phase', slug, phase, status),
    }, { slug, phase });
  }

  /**
   * Drop every cached answer about one plan.
   *
   * Shared by the watcher and by `reread()`, because "the files changed" and
   * "something we cannot see changed the files" have to forget exactly the
   * same things — a caller that forgets one map serves a stale board from it
   * forever, and the revision key hides the mistake.
   */
  private forget(slug: string): void {
    invalidate(slug);
    this.boards.delete(slug);
    this.qaModes.delete(slug);
    // …and the PER-PHASE QA entries, which are keyed `<slug>#<phase>`.
    //
    // `qaMode(slug, phase)` has always written those, and `forget` has always
    // deleted only the bare `<slug>`. So a plan whose phases state their own
    // `- **QA:** on|off` kept its per-phase regime for the life of the process:
    // editing the bullet, or turning QA on for the plan, changed the answer
    // nowhere the proof panel could see — and `deriveEvidence` reads that word
    // to decide whether a recorded verdict HOLDS dependents. The revision key
    // cannot save this one, because the stale entry is never consulted again
    // under its old revision; it is simply never removed.
    for (const key of [...this.qaModes.keys()]) if (key.startsWith(`${slug}#`)) this.qaModes.delete(key);
    this.lints.delete(slug);
    for (const key of [...this.sessionPlans.keys()]) if (key.startsWith(`${slug}::`)) this.sessionPlans.delete(key);
    const record = this.store?.get(slug);
    if (record) this.search.update(record);
  }

  /**
   * Re-read one plan from disk right now, without waiting for the watcher.
   *
   * The watcher is debounced and a session's last commit lands milliseconds
   * before its process exits, so "check what the recovery achieved" cannot
   * trust the cache. Emits `changed` (so open pages re-render) but deliberately
   * does NOT announce it: a re-read the console asked for is not news, and the
   * outcome notification is sent separately with something to say.
   */
  protected reread(slug: string): void {
    const record = this.store?.get(slug);
    if (this.store && record?.planPath) this.store.refresh([record.planPath]);
    this.forget(slug);
    this.portfolioCache = null;
    this.generation++;
    this.emit('changed', { slugs: [slug], generation: this.generation });
  }

  protected onChange(paths: string[]): void {
    if (!this.store) return;
    const slugs = this.store.refresh(paths);
    for (const slug of slugs) this.forget(slug);
    this.portfolioCache = null;
    this.generation++;
    void this.refreshRepoInfo();
    this.emit('changed', { slugs, generation: this.generation });

    // The watcher is the one place external actors become visible, so both
    // consumers that used to be blind to them are poked here. The scheduler:
    // lock churn lives under docs/handoffs/**/.locks, and a foreign release
    // is exactly the admission the queue may be waiting on. The live loops:
    // a handoff written by a manual session used to go unseen until a lane
    // settled — hours, on a one-lane run.
    if (paths.some((p) => p.includes('/.locks/'))) this.scheduler.poll();
    for (const slug of slugs) this.runners.get(slug)?.noteDocsChanged();
    // …and the convergence loop, debounced: a handoff written by hand, a lock
    // released, a plan edited — any of them may be what a stopped run waited on.
    if (this.convergeAutomatic()) for (const slug of slugs) this.converger.request(slug, 'change');

    if (!slugs.length) return;
    this.announce('changed', {
      title: 'Plans changed',
      body: slugs.length === 1 ? `${slugs[0]} was written` : `${slugs.length} plans were written`,
      tag: tagFor('changed', ...slugs),
      // One plan lands on that plan; several have nowhere better than the list.
    }, slugs.length === 1 ? { slug: slugs[0] } : {});
    void this.announceReady(slugs);
  }

  /**
   * A phase that became startable because what it was waiting on finished.
   *
   * Worth its own category because it is the one notification that is not about
   * a run: it fires just as readily for work you finished yourself in a
   * terminal, which is exactly when nothing else would tell you the graph moved.
   *
   * The first pass after a restart only takes a snapshot. Everything looks new
   * to a console that has just started, and announcing all of it would be a
   * notification per ready phase in the library.
   */
  private async announceReady(slugs: string[]): Promise<void> {
    if (!this.store) return;
    try {
      const boards = await Promise.all(
        this.store.list().map(async (r) => [r.slug, await this.board(r.slug).catch(() => null)] as const),
      );
      const now = new Set<string>();
      for (const [slug, board] of boards) {
        for (const phase of board?.ready ?? []) now.add(`${slug}:${phase}`);
      }

      const before = this.readySnapshot;
      this.readySnapshot = now;
      if (!before) return;

      // Only phases in plans that actually changed — a board recomputed for an
      // unrelated reason is not news. And never a closed plan: the announce gate
      // cannot catch the many-phases case, which carries no slug at all, so a
      // closed plan would still be counted into "4 phases became ready".
      const touched = new Set(slugs);
      const fresh = [...now].filter((key) => {
        const [slug] = key.split(':');
        return !before.has(key) && touched.has(slug) && !this.isClosedPlan(slug);
      });
      if (!fresh.length) return;

      const [first] = fresh;
      const [slug, phase] = first.split(':');
      this.announce('ready', {
        title: fresh.length === 1 ? `${slug} · phase ${phase} is ready` : `${fresh.length} phases became ready`,
        body: fresh.length === 1
          ? (this.store.get(slug)?.plan?.phases[Number(phase)]?.title ?? 'nothing is blocking it now')
          : fresh.join(', '),
        tag: tagFor('ready', ...fresh),
      }, fresh.length === 1 ? { slug, phase: Number(phase) } : {});
    } catch (error) {
      log.warn('push.ready-failed', { error });
    }
  }

  /* ---------------------------------------------------------------- *
   * Stale claims
   * ---------------------------------------------------------------- */

  /**
   * Release a claim, using the owner the lock file already records.
   *
   * The console has always *had* this verb — `writes.ts` `lock-release` — and
   * has never been able to offer it usefully, because `phase-lock.sh release`
   * refuses unless `--owner` matches, and the only place that owner was written
   * down was the lock file the operator could not see. So the UI asked a person
   * to retype `sam.doe@example.com/opus-p2` from a dashboard card that did
   * not show it, and offered "Claim phase" instead — which takes the phase
   * rather than freeing it.
   *
   * Reading the owner from the file closes that, and it is not a weakening of
   * the check: the owner still has to match at release time, so a phase
   * re-claimed between the read and the write fails exactly as it should.
   *
   * A live lease is refused unless `force` is set. A lease that has not run out
   * is someone working, and no card on this dashboard is worth interrupting
   * them for — but a live claim now BLOCKS a run, so refusing with no way past
   * it would strand an operator whose holder is a session that died without
   * releasing. `force` is that way past, and it is never a default: the caller
   * confirms it explicitly, and the audit line below records that it was used.
   */
  async releaseLock(slug: string, phase: number, force = false): Promise<LockRelease> {
    if (!this.flags.allowWrites) throw new Error('Writes are disabled. Restart with --allow-writes to enable them.');
    const handoffsDir = this.root?.handoffsDir;

    // Already gone is a success, not an error — including a source with no
    // handoff folder at all, which cannot be holding a claim. On a bulk release
    // two clients can both be right about a lock only one of them removed.
    const lock = handoffsDir ? readLock(handoffsDir, slug, phase) : null;
    if (!lock) return { slug, phase, ok: true, owner: null, detail: 'already free' };
    // Presence beats the lease — through THE lock clock, not a fourth copy of
    // it. `lockLapsed` is the one definition every reader shares (pinned by
    // `test/invariants.test.ts` and `test/evidence-parity.test.ts`), and this
    // file already imported it. `lockPresenceFor` is the registry's word with
    // this console's own live runs carved out; see its header for why a
    // VERIFYING lane's claim is not debris even though its session has ended.
    //
    // Without this the inbox raised a needs-you Release button the server
    // refused every single time, telling the operator to "stop that session"
    // about a session the same console had just declared ended. Force still
    // overrides everything, an expired lease still releases, and `unknown` — a
    // stopped or zombie holder, a lock with no `session=`, a session this
    // console never saw — still refuses.
    const lapsed = lockLapsed(lock, Date.now(), this.lockPresenceFor(lock));
    if (!lapsed && !force) {
      return {
        slug,
        phase,
        ok: false,
        owner: lock.owner,
        detail: `${lock.owner} is still working this phase — the lease runs until `
          + `${lock.leaseUntil ? new Date(lock.leaseUntil).toISOString() : 'an unrecorded time'}. `
          + 'Stop that session, or release it from a terminal with --force.',
      };
    }

    const outcome = await runWrite(
      planWrite(
        { action: 'lock-release', slug, phase, owner: lock.owner, ...(force ? { force: true } : {}) },
        { root: this.root!.path },
      ),
      { scriptsDir: this.flags.scriptsDir, root: this.root!.path },
    );
    // Every release is audited. A claim vanishing with no record of who removed
    // it is indistinguishable from a lock file that was never written — and a
    // FORCED one, taken from a session that had not finished, is the line
    // someone will come looking for.
    log.info('lock.released', {
      slug, phase, owner: lock.owner, ok: outcome.ok, code: outcome.code,
      claimedAt: lock.claimedAt, leaseUntil: lock.leaseUntil,
      ...(force ? { forced: true, wasLive: !lock.expired } : {}),
      // Which of the three doors this release came through: expired lease,
      // forced, or a claim taken on the registry's word while its lease still
      // ran. The third one names the session it judged — the one fact someone
      // reconstructing "who removed my lock" will want.
      ...(!lock.expired && lapsed ? { debris: true, session: lock.session } : {}),
    });
    if (outcome.ok) this.invalidateAll();
    return {
      slug,
      phase,
      ok: outcome.ok,
      owner: lock.owner,
      detail: (outcome.ok ? outcome.stdout : outcome.stderr).trim() || undefined,
    };
  }

  /**
   * Every expired claim, in one action, reporting each one separately.
   *
   * Serial rather than concurrent on purpose: each release shells out to a
   * script that pulls, removes a file and may sync — and the whole point of the
   * per-lock result is that one failure does not obscure the others.
   */
  async releaseExpiredLocks(): Promise<LockRelease[]> {
    const expired = (this.store?.list() ?? []).flatMap((record) =>
      record.locks.filter((lock) => lock.expired).map((lock) => ({ slug: record.slug, phase: lock.phase })));

    const results: LockRelease[] = [];
    for (const { slug, phase } of expired) {
      try {
        results.push(await this.releaseLock(slug, phase));
      } catch (error) {
        results.push({ slug, phase, ok: false, owner: null, detail: (error as Error).message });
      }
    }
    return results;
  }

  /** Invalidate everything after a write the console itself performed. */
  invalidateAll(): void {
    if (!this.store) return;
    this.store.scan();
    this.search.rebuild(this.store.list());
    this.boards.clear();
    this.qaModes.clear();
    this.lints.clear();
    this.sessionPlans.clear();
    this.portfolioCache = null;
    invalidate();
    this.generation++;
    this.emit('changed', { slugs: this.store.list().map((r) => r.slug), generation: this.generation });
  }

  /* ---------------------------------------------------------------- *
   * Engine-backed reads (the only source of truth for status)
   * ---------------------------------------------------------------- */

  protected engineOpts() {
    return {
      scriptsDir: this.flags.scriptsDir,
      root: this.root!.path,
      // What the engine needs for F15, which it cannot read for itself. Always
      // passed — an empty registry is a real answer and must warn, while an
      // ABSENT one (a bare skill install, with no console) turns the check off.
      mcpServers: this.mcp.enabledIds(),
      // …and the run-level policy behind it, so F15 names the consequence this
      // console would actually produce rather than the default one.
      mcpPolicy: this.prefs.mcpPolicy ?? 'continue',
      // …and the F15 family's other two inputs (phase 11): the credential ids
      // whose probes answered `ok` inside their cache window, and every account
      // this instance has registered. Always passed, for the same reason as
      // `mcpServers` — empty is a real answer, absent is a bare install.
      credentials: heldIdsCached(),
      accounts: [DEFAULT_ACCOUNT_ID, ...this.accounts.accountIds()],
    };
  }

  /**
   * The per-Service, per-revision cache — and the second half of the
   * single-flight the engine cache now provides.
   *
   * The entry is written with the **promise**, before the work is awaited. It
   * used to be written after: `produce()` was awaited and only then stored, so
   * ten concurrent asks about one uncached plan all found an empty map and all
   * called `produce()`. `engine.ts` deduplicates identical script runs, but not
   * every producer here is one script, and nothing should depend on a lower
   * layer to avoid work this layer already knows is in flight.
   *
   * A rejected producer is dropped rather than remembered, so a transient
   * failure does not become this revision's permanent answer.
   */
  private cached<T>(
    map: Map<string, Cached<T>>, key: string, revision: number, produce: () => Promise<T>,
  ): Promise<T> {
    const hit = map.get(key);
    if (hit && hit.revision === revision) return hit.value;
    const value = produce();
    const entry: Cached<T> = { revision, value };
    map.set(key, entry);
    value.then(
      (result) => { if (map.get(key) === entry) entry.settled = result; },
      () => { if (map.get(key) === entry) map.delete(key); },
    );
    return value;
  }

  /**
   * The cached answer IF it has already landed — never a reason to compute one.
   *
   * The read path's companion to `cached()`: a page that has to paint now asks
   * this, gets whatever is already there for the current revision, and lets the
   * real computation arrive over the stream instead of holding the response.
   */
  private settled<T>(map: Map<string, Cached<T>>, key: string, revision: number): T | undefined {
    const hit = map.get(key);
    return hit && hit.revision === revision ? hit.settled : undefined;
  }

  async board(slug: string): Promise<Board> {
    const record = this.store?.get(slug);
    if (!record || !this.root) {
      return readMemoryBlock({ code: 1, stdout: '', stderr: 'no such plan', ms: 0, timedOut: false });
    }
    if (!record.plan?.phased) {
      // The same shape `readMemoryBlock` returns for a board with nothing in
      // it (engine.ts `EMPTY_BOARD`): an empty parse yields `{}` for both, and
      // readers of the `blocked:` contract must not have to tell a non-phased
      // board apart from an empty one.
      return {
        phased: false, states: {}, done: [], inProgress: [], stuck: [], ready: [], waiting: [],
        blockedBy: {}, qa: {},
      };
    }
    // Cached per Service and per plan revision (`this.boards`) — but deliberately
    // NOT in `engine.ts`'s module-level result cache, which is why no
    // `{ slug, revision }` key is passed to `run`.
    //
    // The engine key now carries the source ROOT (`4864db8`, re-instated in P10
    // after P9 re-measured it), so cross-root bleed is closed at the source and
    // this read no longer depends on avoiding that cache to stay correct. It
    // still passes no key, for the smaller reason that survives: the board is
    // the read the HEALER decides on, and this Service's own `boards` map
    // already provides the hit, so a second cache buys nothing and adds a way
    // to be wrong. (`boardStates`, which this replaced, passed no key either;
    // the suite went red the moment one was added, on a plan slug two test
    // roots happened to share — the bug the root in the key now prevents.)
    //
    // On the retraction, because the figure outlived the fact: `4864db8` was
    // once reverted (`c67624b`) on a claim that root-in-the-key cost 10× — two
    // engine-parity tests going ~100 s → 1007 s and 1893 s. The same test then
    // took 2556 s with the change already reverted, so the key never caused it;
    // a foreign VM at 361–494% CPU and ~1,740 leaked `pc-*` scratch dirs did.
    // P9 settled it by MECHANISM rather than a stopwatch: same-root Services
    // still share, different-root Services stop sharing, and adding a field to
    // a cache key can only split entries that DIFFER in that field — so the
    // 10× is structurally impossible, not merely unobserved. **Never quote it
    // as a measured fact.** See the P6 and P9 handoffs.
    return this.cached(this.boards, slug, record.revision, async () =>
      readMemoryBlock(await run(this.engineOpts(), 'phase-graph.sh', [slug, '--memory-block'])));
  }

  /**
   * What one phase costs a session: its size PLUS its MCP surcharge.
   *
   * `_phase_weight` in `phase-graph.sh` has always charged both; this side
   * charged only the size, so the console drew, batched and forecast every
   * MCP-bearing phase as cheaper than the engine batching it — and
   * `references/sizing.md` documented a surcharge no JavaScript had ever read.
   * The server count is the plan-wide line unioned with the phase's own bullet,
   * exactly as `mcp_for_phase` resolves it.
   */
  protected weightOfPhase(plan: Plan | undefined, phase: number): number {
    return weightOf(
      plan?.phases[phase]?.size, this.sizing, mcpServersFor(plan, phase).length, this.mcpSizing,
    );
  }

  /** Every phase's weight, computed once — see `weightOfPhase`. */
  protected phaseWeights(plan: Plan | undefined): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const row of plan?.graph ?? []) out.set(row.phase, this.weightOfPhase(plan, row.phase));
    return out;
  }

  /**
   * The QA regime — for the PLAN, or for one phase of it.
   *
   * With a phase, the engine answers that phase's own `- **QA:** on|off` bullet
   * where it has one and the plan's word otherwise, and says which in the
   * reason. Cached per phase for the same revision, because every candidate
   * classification asks and the answer only moves when the plan file does.
   */
  async qaMode(slug: string, phase?: number): Promise<QaMode> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return { mode: 'off' };
    const key = phase == null ? slug : `${slug}#${phase}`;
    const args = phase == null
      ? [slug, '--qa-mode']
      : [slug, '--qa-mode', String(phase)];
    return this.cached(this.qaModes, key, record.revision, async () =>
      readQaMode(await run(this.engineOpts(), 'phase-graph.sh', args, { slug, revision: record.revision })));
  }

  /**
   * The structural validator — still the engine's word, still cached by
   * revision, and no longer on the plan-detail read path.
   *
   * `GET /api/plans/<slug>/lint` calls this and waits, which is what a caller
   * that has ASKED for the lint should get. `detail()` does not; see the note
   * there.
   */
  async lint(slug: string): Promise<LintResult | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    return this.cached(this.lints, slug, record.revision, async () =>
      readLint(await run(this.engineOpts(), 'validate.sh', [slug], { slug, revision: record.revision })));
  }

  /**
   * Compute the lint off the request, and push it when it lands.
   *
   * Fire-and-forget by design: the caller is a response that has already been
   * built. A failure is swallowed for the same reason — the page rendered
   * without the lint a moment ago and is no worse off, and `GET .../lint` will
   * report the failure to anyone who asks for it directly.
   *
   * The revision is captured, not re-read: by the time this resolves the plan
   * may have been written again, and pushing a lint labelled with the current
   * revision when it was computed against an older one is exactly the kind of
   * stale-but-confident answer the revision key exists to prevent.
   */
  private lintInBackground(slug: string, revision: number): void {
    // Deferred to a later turn, not merely un-awaited.
    //
    // Starting it inline would put `validate.sh` into the engine's 8-slot
    // semaphore alongside the reads this very response is still waiting on —
    // the response would queue behind the walk it just stopped awaiting, which
    // is most of the cost back. A macrotask hop puts it strictly after the
    // response is built. `unref` so a pending lint can never be the reason a
    // process stays alive.
    setTimeout(() => this.lintNow(slug, revision), 0).unref();
  }

  private lintNow(slug: string, revision: number): void {
    // The plan may have been rewritten during the hop, in which case this
    // revision's lint is nobody's answer any more.
    if (this.store?.get(slug)?.revision !== revision) return;
    void this.lint(slug).then((lint) => {
      if (!lint) return;
      // Dropped rather than pushed if the plan moved underneath us: the next
      // read starts a fresh one against the revision that is actually current.
      if (this.store?.get(slug)?.revision !== revision) return;
      this.emit('plan:lint', { slug, revision, lint });
    }, () => { /* the direct route reports this; a page that never had it is unharmed */ });
  }

  async sessionPlan(slug: string, model?: string): Promise<SessionPlan | null> {
    const record = this.store?.get(slug);
    if (!record?.plan?.phased) return null;
    const alias = model || record.plan.sessionBudget.targetModel || '';
    return this.cached(this.sessionPlans, `${slug}::${alias}`, record.revision, async () =>
      readSessionPlan(await run(
        this.engineOpts(), 'phase-graph.sh',
        alias ? [slug, '--session-plan', alias] : [slug, '--session-plan'],
        { slug, revision: record.revision },
      )));
  }

  async boardText(slug: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readBoardText(await run(this.engineOpts(), 'phase-graph.sh', [slug], { slug, revision: record.revision }));
  }

  /** The boot prompt for a phase, copied verbatim from the engine. */
  async bootPrompt(slug: string, phase: number): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--boot-prompt', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  /** The end-of-phase banner: board, batching advice and every ready prompt. */
  async nextPhasePrompt(slug: string, completed: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'next-phase-prompt.sh', [slug, completed],
      { slug, revision: record.revision },
    ));
  }

  /**
   * A phase's wait budget, through the engine — the service's twin of
   * `RunnerBase.waitBudgetOf`, for the paths no runner drives: the unsupervised
   * inbox and the boot's overdue ruling. An engine that cannot answer reads as
   * the console default with nothing countersigned.
   */
  async waitBudget(slug: string, phase: number): Promise<WaitBudget> {
    const record = this.store?.get(slug);
    if (!record) return DEFAULT_WAIT_BUDGET;
    try {
      const [line, refs] = await Promise.all([
        run(this.engineOpts(), 'phase-graph.sh', [slug, '--wait-budget', String(phase)], { slug, revision: record.revision }),
        run(this.engineOpts(), 'phase-graph.sh', [slug, '--waits-on', String(phase)], { slug, revision: record.revision }),
      ]);
      const text = (result: typeof line): string => (result.code === 0 && !result.timedOut ? result.stdout : '');
      return waitBudgetFrom(text(line), text(refs), dateOfRef);
    } catch {
      return DEFAULT_WAIT_BUDGET;
    }
  }

  async gateStatus(slug: string, phase: number) {
    const record = this.store?.get(slug);
    if (!record) return null;
    return readGateStatus(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--gate-status', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  /**
   * Approve (or revoke) a phase's gate — the clearance record every gate kind
   * honours (`gate-approve.sh` → docs/handoffs/<slug>/gate-status.md). The
   * verdict is the POSTCONDITION read back from the engine, not the script's
   * exit code, the same shape as activateQa. With `continueRun`, a run that
   * parked on this gate is retried at once — approving from the phase page is
   * one action, not two. Revoking reports the write's own outcome: an auto
   * gate may legitimately still read clear on its own merits afterwards.
   */
  async approveGate(
    slug: string,
    phase: number,
    opts: { approve: boolean; by?: string; note?: string; continueRun?: boolean; actor?: Actor },
  ): Promise<{ ok: boolean; gate: GateStatus | null; detail: string; resumed?: boolean }> {
    if (!this.flags.allowWrites) {
      return { ok: false, gate: null, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, gate: null, detail: `No plan named ${slug}.` };

    let outcome;
    try {
      outcome = await runWrite(
        planWrite(
          { action: 'gate-approve' as const, slug, phase, by: opts.by, reason: opts.note, revoke: !opts.approve },
          { root: this.root.path, docsDir: this.root.docsDir },
        ),
        { scriptsDir: this.flags.scriptsDir, root: this.root.path },
      );
    } catch (error) {
      return { ok: false, gate: null, detail: (error as Error).message };
    }

    this.reread(slug);
    const gate = await this.gateStatus(slug, phase);
    const ok = opts.approve ? Boolean(gate?.clear) : outcome.ok;
    log.info('gate.approve', { slug, phase, approve: opts.approve, ok, by: opts.by, code: outcome.code });
    if (ok) this.invalidateAll();

    let resumed = false;
    if (ok && opts.approve && opts.continueRun) {
      try {
        // "Approve and continue" is a person's press on the gate — the
        // request's own actor, through the operator's door.
        resumed = Boolean(await this.retryPhase(slug, phase, undefined, pressActor(opts.actor ?? asActor(opts.by, 'Service.approveGate'))));
      } catch (error) {
        return {
          ok, gate, detail: `Gate approved, but the run did not continue: ${(error as Error).message}`,
        };
      }
    }
    return {
      ok,
      gate,
      ...(resumed ? { resumed } : {}),
      detail: ok
        ? (opts.approve
          ? `Gate approved for ${slug} phase ${phase}${resumed ? ' — the run is continuing' : ''}.`
          : `Gate approval revoked for ${slug} phase ${phase} — the gate is back in force.`)
        : (outcome.stderr || outcome.stdout).trim() || 'The write did not change the gate.',
    };
  }

  /* ---------------------------------------------------------------- *
   * Review — the diff, and the verdict on it (`review.ts`)
   * ---------------------------------------------------------------- */

  /**
   * A phase's diff, with this console's verdict on it.
   *
   * Read-only and unflagged. Looking at what a session changed is display —
   * the same class as reading its handoff — and a console started with no
   * flags at all is exactly where an operator most wants to check the work
   * before deciding whether to turn anything on.
   */
  async phaseReview(
    slug: string, phase: number, opts: { base?: string; tip?: string } = {},
  ): Promise<{ diff: PhaseDiff; review: ReviewRecord | null; staleTip: boolean } | null> {
    const record = this.store?.get(slug);
    if (!record || !this.root) return null;
    const handoff = handoffFor(record, phase);
    const diff = await phaseDiff({
      root: this.root.path,
      slug,
      phase,
      ...(handoff?.path ? { handoffPath: handoff.path } : {}),
      ...(record.handoffDir ? { handoffDir: record.handoffDir } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.tip ? { tip: opts.tip } : {}),
    });
    const review = this.reviews.get(slug, phase) ?? null;
    // The one thing only this call can answer: was the verdict given on THIS
    // tip? Computed here rather than in `detail()` because it needs the window,
    // and the window is a `git log` — per phase, that would make opening a plan
    // cost N subprocesses to decorate a chip nobody asked to see.
    const staleTip = Boolean(
      review?.tip && diff.window.tip && review.tip !== diff.window.tip,
    );
    return { diff, review, staleTip };
  }

  /* ---------------------------------------------------------------- *
   * Landing — how a finished plan leaves the machine (`landing.ts`)
   * ---------------------------------------------------------------- */

  /** `runs/<instance>/<slug>/landing`, or null with no source root open. */
  protected landingDir(slug: string): string | null {
    return this.root ? join(STATE_DIR, 'runs', instanceId(this.root.path), slug, 'landing') : null;
  }

  /**
   * The plan's landing: the branch it sits on, the range it would carry, and
   * the packet if one has been composed.
   *
   * Read-only and unflagged, like the review. The branch state and the commit
   * count are the operator's answer to "is this finished work actually
   * anywhere?" — the question a console with no flags on is exactly the right
   * place to ask, and answering it costs two `git rev-parse`s.
   *
   * `finished` is the board's, not a guess: every phase `done`. It decides how
   * loudly the card presents itself, never whether composing is allowed — a
   * half-finished plan whose first phases need handing to somebody else is a
   * real use, and refusing it would only teach people to wait.
   */
  async landing(slug: string): Promise<{
    slug: string;
    repo: BranchState;
    window: LandingWindow;
    commitCount: number;
    finished: boolean;
    packet: LandingPacket | null;
    /** Composing is a write; the card says so instead of offering a button that 403s. */
    writable: boolean;
  } | null> {
    const record = this.store?.get(slug);
    if (!record || !this.root) return null;
    const dir = this.landingDir(slug);

    const repo = await branchState(this.root.path);
    const window = repo.available
      ? await planWindow({
        root: this.root.path,
        ...(record.planPath ? { planPath: record.planPath } : {}),
        ...(record.handoffDir ? { handoffDir: record.handoffDir } : {}),
      })
      : { kind: 'none' as const, note: 'That source directory is not a git repository.' };

    // The count, not the list: the plan page wants "34 commits", and the list
    // is what the composed packet carries. Asking for the range's whole log to
    // render one number is the shape that made `staleTip` expensive in P13.
    const commits = repo.available && window.kind !== 'none'
      ? await commitsInRange(this.root.path, window.base, repo.branch ?? 'HEAD', 1_000)
      : [];

    const board = await this.board(slug);
    const finished = board.phased
      && board.done.length > 0
      && board.ready.length === 0 && board.waiting.length === 0
      && board.inProgress.length === 0 && board.stuck.length === 0;

    return {
      slug,
      repo,
      window,
      commitCount: commits.length,
      finished,
      packet: dir ? readLanding(dir) ?? null : null,
      writable: this.flags.allowWrites,
    };
  }

  /**
   * Write the landing packet — a bundle and a patch series, on this machine.
   *
   * `--allow-writes`, and no more than that. It creates files under the run's
   * own state directory and runs two git verbs that touch no ref and no remote
   * (`git.ts` §Landing plumbing), so it is the same class of act as recording a
   * verdict: it changes this console's state, never the repository's and never
   * anybody else's. Pushing what it produces stays a person's decision, which
   * is the entire reason the packet is a file.
   */
  async composeLandingPacket(
    slug: string, opts: { base?: string; tip?: string } = {},
  ): Promise<{ ok: boolean; packet: LandingPacket | null; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, packet: null, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    const dir = this.landingDir(slug);
    if (!record || !this.root || !dir) {
      return { ok: false, packet: null, detail: `No plan named ${slug} in the open source directory.` };
    }
    const outcome = await composeLanding({
      root: this.root.path,
      slug,
      dir,
      ...(record.planPath ? { planPath: record.planPath } : {}),
      ...(record.handoffDir ? { handoffDir: record.handoffDir } : {}),
      ...(opts.base ? { base: opts.base } : {}),
      ...(opts.tip ? { tip: opts.tip } : {}),
    });
    log.info('landing.compose', {
      slug, ok: outcome.ok, commits: outcome.packet?.commitCount, files: outcome.packet?.files.length,
    });
    if (outcome.ok) this.emit('landing', { slug, at: outcome.packet.at });
    return outcome.ok
      ? { ok: true, packet: outcome.packet, detail: outcome.detail }
      : { ok: false, packet: null, detail: outcome.detail };
  }

  /**
   * The absolute path of one artefact, or null.
   *
   * The manifest is the whitelist — see `landingFile`. Resolving through it
   * rather than sanitising the requested name is what makes a traversal
   * uninteresting: a name is served because the packet says it exists.
   */
  landingArtifact(slug: string, name: string): string | null {
    const dir = this.landingDir(slug);
    return dir ? landingFile(dir, name) : null;
  }

  /**
   * Everything an auto reviewer needs to read a phase: its diff, what it was
   * asked to deliver, and how it was meant to prove it.
   *
   * Null when there is no plan or no source root — the runner journals that as
   * a skip rather than reviewing a diff it could not resolve.
   */
  async reviewerFacts(
    slug: string, phase: number, policy: ReviewerVerdictPolicy,
  ): Promise<ReviewerFacts | null> {
    const record = this.store?.get(slug);
    if (!record || !this.root) return null;
    const handoff = handoffFor(record, phase);
    const detail = record.plan?.phases[phase];
    const diff = await phaseDiff({
      root: this.root.path,
      slug,
      phase,
      ...(handoff?.path ? { handoffPath: handoff.path } : {}),
      ...(record.handoffDir ? { handoffDir: record.handoffDir } : {}),
    });
    // `extractCommands` returns `{ commands, notRun }` — the second half is
    // the leads that cannot run on this machine, which is the verifier's
    // business and not a reviewer's.
    const commands = detail?.verification ? extractCommands(detail.verification).commands : [];
    return {
      slug,
      phase,
      ...(detail?.title ? { title: detail.title } : {}),
      // The plan's own words, not a paraphrase: a reviewer told what the phase
      // "was about" reviews an impression, and the exit criteria are the only
      // text in this system that says what finished MEANS for this phase.
      ...(detail?.exitCriteria ? { exitCriteria: detail.exitCriteria } : {}),
      ...(commands.length ? { verification: { commands } } : {}),
      diff,
      policy,
    };
  }

  /**
   * Store what a reviewer session found: the verdict, then each finding as an
   * ordinary comment.
   *
   * Ordinary on purpose — a finding is written through the same `addComment`
   * an operator's own comment uses, so Send back composes one follow-up over
   * both without knowing which came from a machine. `by` is what tells them
   * apart, and it is stamped here rather than trusted from the session.
   */
  recordReviewerReport(slug: string, phase: number, report: ReviewerReport): void {
    const by = 'auto-reviewer';
    this.reviews.set(slug, phase, {
      verdict: report.verdict,
      ...(report.note ? { note: report.note } : {}),
      by,
    });
    for (const f of report.findings) {
      this.reviews.addComment(slug, phase, {
        path: f.path,
        ...(f.line != null ? { line: f.line } : {}),
        ...(f.side ? { side: f.side } : {}),
        body: f.body,
        by,
      });
    }
    this.invalidateAll();
    this.emit('review', { slug, phase, verdict: report.verdict });
  }

  /**
   * Add, resolve or delete an inline comment on a phase's diff.
   *
   * Behind `--allow-writes` like the verdict, and for a subtler reason than
   * the verdict's: a comment is not itself a hold, but Send back turns a
   * comment set into a re-boarded phase, and a read-only console must not be
   * able to put a finished phase back to work by two clicks.
   */
  async commentOnReview(
    slug: string, phase: number,
    input:
      | { action: 'add'; path: string; line?: number; side?: CommentSide; hunk?: string; code?: string; body: string; by?: string }
      | { action: 'resolve' | 'unresolve' | 'delete'; id: string },
  ): Promise<{ ok: boolean; review: ReviewRecord | null; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, review: null, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, review: null, detail: `No plan named ${slug}.` };

    let review: ReviewRecord | null = null;
    let detail = '';
    if (input.action === 'add') {
      const body = (input.body ?? '').trim();
      if (!body) return { ok: false, review: null, detail: 'A comment needs something in it.' };
      if (!input.path) return { ok: false, review: null, detail: 'A comment needs the file it is about.' };
      review = this.reviews.addComment(slug, phase, {
        path: input.path,
        ...(Number.isInteger(input.line) ? { line: input.line } : {}),
        ...(input.side ? { side: input.side } : {}),
        ...(input.hunk ? { hunk: input.hunk } : {}),
        ...(input.code ? { code: input.code } : {}),
        body,
        ...(input.by ? { by: input.by } : {}),
      });
      if (!review) {
        return {
          ok: false, review: null,
          detail: `Phase ${phase} already has ${MAX_COMMENTS} comments — send the phase back before adding more.`,
        };
      }
      detail = `Comment added on ${slug} phase ${phase}.`;
    } else if (input.action === 'delete') {
      review = this.reviews.removeComment(slug, phase, input.id);
      detail = review ? 'Comment deleted.' : `There is no comment ${input.id} on ${slug} phase ${phase}.`;
    } else {
      review = this.reviews.resolveComment(slug, phase, input.id, input.action === 'resolve');
      detail = review
        ? (input.action === 'resolve' ? 'Comment marked answered.' : 'Comment reopened.')
        : `There is no comment ${input.id} on ${slug} phase ${phase}.`;
    }
    if (!review) return { ok: false, review: null, detail };

    log.info('review.comment', { slug, phase, action: input.action, comments: review.comments?.length ?? 0 });
    this.invalidateAll();
    this.emit('review', { slug, phase, verdict: review.verdict });
    return { ok: true, review, detail };
  }

  /**
   * Send a reviewed phase back to work with its comments as the instruction.
   *
   * The prompt is composed HERE, from the stored comments, and never taken
   * from the request body. Same rule the QA and recovery briefings follow in
   * `agent.ts`: a browser names WHICH phase to send back, never what the
   * session is told — otherwise the review surface is an arbitrary
   * prompt-injection endpoint wearing a review's name.
   *
   * `--allow-run` and not `--allow-writes`: this spawns a session that edits a
   * repository. Reading a diff, recording a verdict and starting work on it
   * are three different permissions and this is the third.
   */
  async sendBackReview(
    slug: string, phase: number, opts: { by?: string } = {},
  ): Promise<{ ok: boolean; detail: string; followUp?: string; boarded?: boolean }> {
    if (!this.flags.allowRun) {
      return { ok: false, detail: 'Running sessions is disabled. Restart with --allow-run to enable it.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, detail: `No plan named ${slug}.` };

    const review = this.reviews.get(slug, phase);
    const comments = review?.comments ?? [];
    const open = comments.filter((c) => !c.resolved);
    if (!open.length && !review?.note) {
      // Nothing to say means nothing to send. Re-boarding here would look
      // exactly like a Retry to the phase and exactly like a follow-up to the
      // operator, which is the worst of both.
      return {
        ok: false,
        detail: `There is nothing to send back on ${slug} phase ${phase} — no unresolved comments and no note.`,
      };
    }

    const followUp = composeFollowUp({
      slug, phase, comments,
      ...(review?.verdict ? { verdict: review.verdict } : {}),
      ...(review?.note ? { note: review.note } : {}),
      ...(review?.by ? { by: review.by } : {}),
    });

    // `runnerFor` MAKES a runner when there is none, so a missing run is not
    // detectable here — it is detectable inside `sendBack`, which refuses an
    // unloaded state by name. Letting that refusal be the single answer keeps
    // one message for one condition instead of two that can drift.
    const outcome = this.runnerFor(slug).sendBack(phase, followUp, opts.by ?? 'console');
    if (!outcome.ok) return { ok: false, detail: outcome.reason, followUp };

    log.info('review.send-back', { slug, phase, comments: open.length, boarded: outcome.boarded });
    this.invalidateAll();
    this.emit('review', { slug, phase, verdict: review?.verdict ?? null });
    return {
      ok: true,
      followUp,
      boarded: outcome.boarded,
      detail: `Phase ${phase} of ${slug} was sent back with ${open.length} comment`
        + `${open.length === 1 ? '' : 's'}`
        + (outcome.boarded
          ? ' — the run will board it next.'
          : ' — it is queued; start or resume the run to board it.'),
    };
  }

  /**
   * Record (or withdraw) a verdict on a phase's diff.
   *
   * Behind `--allow-writes` — not because it touches the repository (it does
   * not; the verdict lives under `runs/`) but because `requested-changes`
   * HOLDS every dependent phase from boarding, and a console the operator
   * started read-only should not be able to stop a run.
   */
  async setReview(
    slug: string, phase: number,
    input: { verdict: ReviewVerdict | 'withdraw'; note?: string; by?: string; base?: string; tip?: string },
  ): Promise<{ ok: boolean; review: ReviewRecord | null; detail: string }> {
    if (!this.flags.allowWrites) {
      return { ok: false, review: null, detail: 'Writes are disabled. Restart with --allow-writes to enable them.' };
    }
    const record = this.store?.get(slug);
    if (!record || !this.root) return { ok: false, review: null, detail: `No plan named ${slug}.` };

    if (input.verdict === 'withdraw') {
      const had = this.reviews.clear(slug, phase);
      log.info('review.withdraw', { slug, phase, had });
      this.invalidateAll();
      this.emit('review', { slug, phase, verdict: null });
      return {
        ok: had,
        review: null,
        detail: had
          ? `Review withdrawn for ${slug} phase ${phase} — nothing is held by it any more.`
          : `There was no review on ${slug} phase ${phase}.`,
      };
    }
    if (!isReviewVerdict(input.verdict)) {
      return { ok: false, review: null, detail: `Unknown verdict "${String(input.verdict)}".` };
    }

    const review = this.reviews.set(slug, phase, {
      verdict: input.verdict,
      ...(input.note ? { note: input.note } : {}),
      ...(input.by ? { by: input.by } : {}),
      ...(input.base ? { base: input.base } : {}),
      ...(input.tip ? { tip: input.tip } : {}),
    });
    log.info('review.record', { slug, phase, verdict: review.verdict, by: review.by });
    this.invalidateAll();
    this.emit('review', { slug, phase, verdict: review.verdict });
    return {
      ok: true,
      review,
      detail: review.verdict === 'requested-changes'
        ? `Changes requested on ${slug} phase ${phase} — every phase that depends on it is held until this is approved or withdrawn.`
        : review.verdict === 'approved'
          ? `Phase ${phase} of ${slug} approved.`
          : `Note recorded on ${slug} phase ${phase} — nothing is held by it.`,
    };
  }


  async qaPrompt(slug: string, phase: number): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--qa-prompt', String(phase)],
      { slug, revision: record.revision },
    ));
  }

  async memoryBlock(slug: string): Promise<string> {
    const record = this.store?.get(slug);
    if (!record) return '';
    return readText(await run(
      this.engineOpts(), 'phase-graph.sh', [slug, '--memory-block'],
      { slug, revision: record.revision },
    ));
  }

  /* ---------------------------------------------------------------- *
   * Composed views
   * ---------------------------------------------------------------- */

  /**
   * `planRuns` is an OPTIONAL pre-read of this plan's run files.
   *
   * `detail()` needs the same directory scan for its own verification pass, and
   * used to do it separately — one `listRuns` here and another there, over the
   * same directory, in the same request, for facts that cannot differ between
   * them. The caller that already has them passes them in; every other caller
   * is unchanged.
   */
  protected async context(record: PlanRecord, planRuns?: RunState[]): Promise<PlanContext> {
    const [board, qaMode] = await Promise.all([this.board(record.slug), this.qaMode(record.slug)]);
    // The plan's runs ride along for the record-vs-board check (`healthIssues`
    // `record-ahead-of-board`): a run file is the only place a phase can read
    // done while the board does not.
    const source = this.root && record.plan?.phased
      ? planRuns ?? listRuns(this.root.path, record.slug, this.liveRunIds())
      : [];
    const runs = source.map((run) => ({ id: run.id, status: run.status, phases: run.phases }));
    return { record, board, qaMode, runs };
  }

  private toSummary(ctx: PlanContext, ownSamples?: EtaSample[]): PlanSummary {
    const stats = planStats(ctx, this.sizing, this.mcpSizing);
    const issueCounts = { error: 0, warning: 0, info: 0 };
    for (const issue of stats.issues) issueCounts[issue.severity]++;
    // `remainingWork` already excludes done phases by weight; the phase count
    // beside it is only metadata on the estimate, so it is derived rather than
    // recomputed from the graph a second time.
    const eta = etaFrom(this.planRate(stats.slug, ownSamples), {
      weight: stats.remainingWeight,
      phases: Math.max(0, stats.phases - stats.done),
    });
    return {
      ...stats,
      engineError: ctx.board.error,
      issueCounts,
      hasHandoffs: ctx.record.handoffs.length > 0,
      ...(eta ? { eta } : {}),
    };
  }

  async summaries(): Promise<PlanSummary[]> {
    const records = this.store?.list() ?? [];
    const contexts = await Promise.all(records.map((r) => this.context(r)));
    return contexts.map((ctx) => this.toSummary(ctx)).sort((a, b) => b.activity - a.activity);
  }

  async portfolio(): Promise<Portfolio> {
    if (this.portfolioCache?.generation === this.generation) return this.portfolioCache.value;
    const records = this.store?.list() ?? [];
    const contexts = await Promise.all(records.map((r) => this.context(r)));
    // `rateFor([], pool)` and not `rateFor(pool)`: the number IS the pool, so it
    // has to be labelled `portfolio` — reading it as one plan's own evidence
    // would put "(estimate)" under a figure that is an average of everything.
    const value = portfolio(contexts, this.sizing, rateFor([], this.etaPool().all), this.mcpSizing);
    this.portfolioCache = { generation: this.generation, value };
    return value;
  }

  /**
   * One plan, projected to what the caller asked for.
   *
   * `include` names the groups from `shared/projection.js`; an empty set is the
   * BOARD projection — what the Route tab, the dashboard rows, the gate card
   * and the command palette all read — and `full` is the shape this method
   * returned before projections existed.
   *
   * The full object is assembled first and projected last, deliberately. Every
   * field here comes from a record the store has already parsed, so building it
   * costs nothing measurable; what cost 286.5 KB was serializing and shipping
   * it. Projecting at the end is therefore the cheap half AND the safe one:
   * there is exactly one construction path, so `include=full` cannot drift away
   * from the default response by an edit that touches only one of two branches.
   */
  async detail(slug: string, model?: string, include?: Set<string>): Promise<PlanDetail | null> {
    const record = this.store?.get(slug);
    if (!record || !this.root) return null;

    // The plan's own run files, read ONCE for every reader on this path: the
    // record-vs-board check inside `context`, the per-phase verification scan,
    // the money, the rate and the duty cycle behind the forecast date. It used
    // to be one `listRuns` per reader — one directory scan each, in the same
    // request, for facts that cannot differ between them.
    const planRuns = listRuns(this.root.path, slug, this.liveRunId());

    const ctx = await this.context(record, planRuns);
    const plan = record.plan;
    const rows = plan?.graph ?? [];
    const sizes = new Map(rows.map((r) => [r.phase, plan?.phases[r.phase]?.size ?? 'M' as const]));
    const budget = resolveBudget(plan?.sessionBudget.targetModel, this.sizing);
    const index = indexGraph(rows);
    const weights = this.phaseWeights(plan);
    // This plan's OWN finished phases, from the runs already in hand.
    //
    // Every eta reading below used to reach `etaPool()`, which scans the run
    // directory of EVERY plan in the portfolio — 121 of them, to render one. The
    // pool is still the fallback and still the right answer when this plan has
    // no evidence of its own (`planRate` asks for it then, and only then), but
    // opening one plan no longer pays for all the others as a matter of course.
    const ownSamples = etaSamples(planRuns, new Map(weights));
    const summary = this.toSummary(ctx, ownSamples);
    const critical = criticalPath(index, ctx.board, sizes, this.sizing, budget, weights);
    const analyses = analysePhases(rows, ctx.board, sizes, this.sizing, critical.phases, weights);
    const layout = routeLayout(index);

    // One rate for the whole page. The plan total and every phase row are the
    // same reading applied to different weights, so they cannot drift apart —
    // and the `basis` each carries is the same basis, which is what lets the
    // header and a row hedge in the same words.
    const rate = this.planRate(slug, ownSamples);
    const eta = {
      plan: etaFrom(rate, remainingWork(rows, ctx.board, sizes, this.sizing, budget, weights)),
      perPhase: rows.map((row) =>
        phaseEtaFor(row.phase, this.weightOfPhase(plan, row.phase), rate)),
    };

    // What it cost, and when it lands. The forecast is deliberately NOT
    // `now + eta`: `forecastFrom` stretches the working estimate by a measured
    // duty cycle and reports every assumption it used, because a date is quoted
    // long after the caveats around it are forgotten.
    const cost = planCost({ slug, runs: planRuns });
    const forecast = forecastFrom(eta.plan, dutyCycle(ownSamples), Date.now());

    // THE LINT IS NOT AWAITED HERE — and it is the reason this whole phase
    // exists.
    //
    // `lint()` shells `validate.sh`, which re-enters `phase-graph.sh` once per
    // handoff file, serially, each re-parsing the whole plan and every handoff.
    // Measured on the live hub: 11.27 s for the 22-handoff plan somebody was
    // actually working on, against 0.58 s for a closed one — closed plans
    // short-circuit and never walk, so the slow case is exactly an open plan
    // with a full handoff set. Every plan-page view paid it before it could
    // paint a table that does not show the lint.
    //
    // Nothing is removed. The lint is still computed, still revision-keyed,
    // still reachable synchronously at `GET /api/plans/<slug>/lint`, and now
    // arrives on the page over SSE (`plan:lint`) the moment it lands. What the
    // response carries is whatever has ALREADY landed for this revision — a
    // second open, or a reload, has it immediately.
    const lint = this.settled(this.lints, slug, record.revision) ?? null;

    const [batches, boardText, gitInfo] = await Promise.all([
      this.sessionPlan(slug, model),
      plan?.phased ? this.boardText(slug) : Promise.resolve(''),
      record.planPath ? lastCommit(this.root.path, record.planPath) : Promise.resolve({}),
    ]);

    // Verification is recorded on a RUN, not on a plan, so the page that says
    // "done" has to go and look for the proof. One scan for the whole detail,
    // not one per phase — and the newest record wins, because a phase that was
    // retried is evidenced by its latest attempt, not its first.
    const latestRecords = new Map<number, {
      verification?: unknown; status?: string; attempts?: number; verifiedIn?: string; runId?: string;
      inFlight?: boolean; sessionId?: string; pid?: number;
    }>();
    for (const run of planRuns) {
      // The lanes this run recorded, so a phase still in flight can name the
      // process behind it. `listRuns` has already run `settle`, so a record
      // that is STILL in flight here is one whose child held work when the
      // probe was asked — or one this console is driving itself.
      const pids = new Map<number, number>();
      for (const child of childrenOf(run)) pids.set(child.phase, child.pid);
      for (const [key, rec] of Object.entries(run.phases ?? {})) {
        const n = Number(key);
        if (!Number.isInteger(n) || !rec) continue;
        const prev = latestRecords.get(n);
        const at = rec.endedAt ?? rec.startedAt ?? '';
        if (!prev || at >= ((prev as { at?: string }).at ?? '')) {
          const pid = pids.get(n);
          latestRecords.set(n, {
            verification: rec.verification, status: rec.status, attempts: rec.attempts,
            verifiedIn: rec.verifiedIn, runId: run.id,
            inFlight: PHASE_IN_FLIGHT.includes(rec.status),
            ...(rec.sessionId ?? rec.resumeSessionId ? { sessionId: rec.sessionId ?? rec.resumeSessionId } : {}),
            ...(pid ? { pid } : {}),
            ...({ at } as object),
          });
        }
      }
    }
    // The plan-wide regime, plus a per-phase reading for every phase that
    // states its own `- **QA:** on|off`.
    //
    // `deriveEvidence` uses this word to decide whether a recorded verdict
    // HOLDS dependents, so applying the plan's answer to every phase told the
    // proof panel a phase's verdict gated when the phase had opted out (and the
    // reverse). Asking the engine per phase for all N would be N subprocesses
    // per cold read of a plan detail; asking only for the phases that said
    // something is one extra call in the case that exists, and none otherwise.
    // The JS reading decides only WHETHER to ask — the engine still answers, so
    // a mis-parse here degrades to exactly the old behaviour and never invents
    // a regime.
    const planQaMode = (await this.qaMode(slug)).mode;
    const stated = rows.filter((row) => plan?.phases[row.phase]?.qa);
    // The whole answer is kept, not only the word: its reason names WHICH
    // line decided (`phase directive` or the plan's), and that is what the
    // phase view's `qaMode.source` reports.
    const perPhaseQa = new Map<number, QaMode>();
    await Promise.all(stated.map(async (row) => {
      const mode = await this.qaMode(slug, row.phase).catch(() => null);
      if (mode) perPhaseQa.set(row.phase, mode);
    }));

    // The rounds ledger, read once per detail — the same file `record.qa` came
    // from, parsed for its SECOND table. Per phase: how many rounds, and the
    // latest, so a surface can say "round 3 · fail" without fetching the run.
    const roundsByPhase = new Map<number, QaRoundRow[]>();
    if (record.handoffDir) {
      let ledger = '';
      try { ledger = readFileSync(join(record.handoffDir, 'test-status.md'), 'utf8'); } catch { ledger = ''; }
      for (const round of parseQaRounds(ledger)) {
        const list = roundsByPhase.get(round.phase) ?? [];
        list.push(round);
        roundsByPhase.set(round.phase, list);
      }
    }

    // This console's review verdicts for the plan, read once. Cheap — one
    // readdir over a directory with at most one small JSON per phase — and
    // deliberately NOT a git call: `staleTip` and the diff itself belong to
    // `phaseDiff`, which is asked for one phase at a time. A plan detail that
    // shelled `git log` per phase to decorate a chip would make opening a plan
    // cost N subprocesses for something nobody had asked to see.
    const reviewBy = new Map(this.reviews.all(slug).map((r) => [r.phase, r]));

    // The console's own live claude ptys, once per detail — `phaseLive` uses
    // the set to name the ACTOR behind a lock- or registry-witnessed session.
    const ptyClaude = ptyClaudeSessions(this.terminals.state().sessions);

    const phases: PhaseView[] = rows.map((row) => {
      const detail: PhaseDetail | undefined = plan?.phases[row.phase];
      const handoff = handoffFor(record, row.phase);
      const lock = lockFor(record, row.phase);
      const qa = qaFor(record, row.phase);
      const rec = latestRecords.get(row.phase);
      const analysis = analyses.find((a) => a.phase === row.phase);
      const recorded = reviewBy.get(row.phase);
      const rounds = roundsByPhase.get(row.phase);
      const review = recorded ? {
        verdict: recorded.verdict,
        at: recorded.at,
        ...(recorded.by ? { by: recorded.by } : {}),
        ...(recorded.note ? { note: recorded.note } : {}),
        ...(recorded.base ? { base: recorded.base } : {}),
        ...(recorded.tip ? { tip: recorded.tip } : {}),
      } : undefined;
      // Direct dependencies only — the same shape the engine's own readiness
      // rule has. `reviewHold` is imported rather than re-derived so the runner
      // and this view can never disagree about what holds a phase.
      const hold = reviewHold(analysis?.dependsOn ?? [], [...reviewBy.values()]);
      // What is ACTUALLY working this phase, asked before the claim is
      // described — `deriveEvidence` needs it to tell a stale `in-progress`
      // from a live one, and the chips need it to decide whether to pulse or
      // to link. Every input is already in hand: the settled run record, the
      // store's lock with the registry's word on its session, and the
      // registry's own word on the session the record last named.
      const live = phaseLive({
        run: rec ? { inFlight: rec.inFlight === true, ...(rec.sessionId ? { session: rec.sessionId } : {}), ...(rec.pid ? { pid: rec.pid } : {}) } : null,
        lock: lock ? {
          expired: lock.expired,
          presence: this.lockPresenceFor(lock),
          ...(lock.session ? { session: lock.session } : {}),
          ...(lock.session ? { kind: this.sessions.get(lock.session)?.kind } : {}),
        } : null,
        registry: rec?.sessionId ? {
          session: rec.sessionId,
          presence: this.sessions.presence(rec.sessionId),
          kind: this.sessions.get(rec.sessionId)?.kind,
        } : null,
        ptySessions: ptyClaude,
      });
      const proof = deriveEvidence({
        phase: row.phase,
        board: ctx.board.states?.[row.phase],
        // Ambiguity 9 — `null`, never an absent key: this caller LOOKED.
        live: live ?? null,
        ...(ctx.board.error ? { boardError: ctx.board.error } : {}),
        // `handoffFor` answers undefined for a phase with no handoff file at
        // all, which is most of a young plan — the missing `?.` here crashed
        // every plan detail that had one.
        // `handoffFor` answers the parsed handoff or `undefined` — there is no
        // `exists` field on a `Handoff`, so `handoff?.exists` was ALWAYS
        // undefined and every phase with a real handoff derived `{exists:
        // false}`. The same API response then carried `phase.handoff.status:
        // 'complete'` beside `proof.handoff: 'absent'`, and the phase card said
        // "board: done but the store reads handoff absent — re-scan" about a
        // file that was present, complete and parsed. Holding it IS existing.
        handoff: handoff
          ? { exists: true, status: handoff.status, ...(handoff.outstanding ? { outstanding: handoff.outstanding } : {}) }
          : { exists: false },
        ...(rec?.verification ? { verification: rec.verification as never } : {}),
        qa: {
          mode: perPhaseQa.get(row.phase)?.mode ?? planQaMode,
          ...(qa?.result ? { result: qa.result } : {}),
        },
        ...(rec ? { record: {
          ...(rec.status ? { status: rec.status } : {}),
          ...(rec.attempts != null ? { attempts: rec.attempts } : {}),
          ...(rec.verifiedIn ? { verifiedIn: rec.verifiedIn } : {}),
          ...(rec.runId ? { runId: rec.runId } : {}),
        } } : {}),
      });
      return {
        phase: row.phase,
        title: detail?.title || row.title,
        state: ctx.board.states[row.phase] ?? 'waiting',
        proof,
        ...(live ? { live } : {}),
        size: detail?.size ?? 'M',
        weight: this.weightOfPhase(plan, row.phase),
        gated: detail?.gated ?? false,
        gates: detail?.gates,
        gateCheck: detail?.gateCheck,
        gateKind: gateKindOf(detail?.gateCheck, detail?.gated ?? false, this.gateVocab),
        model: detail?.model,
        effort: detail?.effort,
        goal: detail?.goal,
        readFirst: detail?.readFirst,
        files: detail?.files,
        steps: detail?.steps,
        exitCriteria: detail?.exitCriteria,
        verification: detail?.verification,
        mcpServers: detail?.mcpServers,
        handoffMustRecord: detail?.handoffMustRecord,
        bullets: detail?.bullets ?? [],
        row,
        analysis,
        qa: qa ? { result: qa.result, report: qa.report } : undefined,
        qaMode: {
          mode: perPhaseQa.get(row.phase)?.mode ?? planQaMode,
          source: /phase directive/.test(perPhaseQa.get(row.phase)?.reason ?? '') ? 'phase' : 'plan',
        },
        ...(rounds?.length ? {
          qaRounds: {
            count: rounds.length,
            latest: {
              round: rounds[rounds.length - 1].round,
              result: rounds[rounds.length - 1].result,
              ...(rounds[rounds.length - 1].report ? { report: rounds[rounds.length - 1].report } : {}),
            },
          },
        } : {}),
        ...(review ? { review } : {}),
        ...(hold.length ? { reviewHold: hold } : {}),
        lock: lockView(lock),
        handoff: handoff ? {
          file: handoff.file, status: handoff.status, completed: handoff.completed,
          title: handoff.title, outstanding: handoff.outstanding,
          skillsUsed: handoff.skillsUsed, prompts: handoff.prompts.length,
        } : undefined,
      };
    });

    const memoryKey = plan?.memoryKey ?? `project_${slug}`;
    const memoryEntry = findMemory(memoryKey);

    // Scheduled HERE — after the response is fully built, and never earlier.
    //
    // The hop has to be the last thing this function does. Scheduled where the
    // lint is READ, a hundred lines above, the timer fires during the awaits
    // that follow it and `validate.sh` is running before the caller ever sees
    // a response — which is the thing this phase removed.
    //
    // `plan?.phased` guards it because `lint()` answers `null` for a document
    // rather than running anything: without the guard, every open of every
    // non-plan document in the library would arm a timer to discover that.
    if (lint === null && plan?.phased) this.lintInBackground(slug, record.revision);

    // What this caller asked for. Read once, applied in four places below.
    const wantProse = wants(include, 'prose');
    const wantDocument = wants(include, 'document');
    const wantHandoffs = wants(include, 'handoffs');
    const wantMemory = wants(include, 'memory');

    return {
      summary,
      plan: plan ? omit({
        slug, title: plan.title, provenance: plan.provenance, context: plan.context,
        architecture: plan.architecture, endToEnd: plan.endToEnd, sessionBudget: plan.sessionBudget,
        graph: plan.graph, callouts: plan.callouts,
        sections: plan.sections.map((s) => ({ title: s.title, body: s.body })),
        // The manifest as it HOLDS — the plan's rows with the twin merged over
        // them, the same answer `phase-graph.sh --decisions` prints — then each
        // phase's OWN rows merged the same way (`--decisions N`, zero-touch
        // phase 19), so a per-phase answer is shown rather than dropped.
        decisions: [
          ...mergeDecisions(plan.decisions, record.decisionsTwin),
          ...[...new Set(
            [...plan.decisions, ...(record.decisionsTwin ?? [])]
              .map((row) => row.phase)
              .filter((phase): phase is number => typeof phase === 'number'),
          )]
            .sort((a, b) => a - b)
            .flatMap((phase) =>
              mergeDecisions(plan.decisions, record.decisionsTwin, phase).filter((row) => row.phase === phase)),
        ],
        path: record.planPath,
      }, wantDocument ? [] : DOCUMENT_PLAN_FIELDS) : null,
      // The handoff REFERENCE stays on every phase — a `handoff <status>` chip
      // is board furniture. Only its `outstanding` paragraph is projected, and
      // only when it is present: a phase with no handoff keeps `undefined`
      // rather than gaining an empty object.
      phases: wantProse && wantHandoffs
        ? phases
        : phases.map((phase) => {
          const projected = wantProse ? phase : omit(phase, PROSE_PHASE_FIELDS);
          if (wantHandoffs || !projected.handoff) return projected;
          return { ...projected, handoff: omit(projected.handoff, HANDOFF_PROSE_FIELDS) };
        }),
      route: {
        nodes: layout.map((node) => {
          const detail = plan?.phases[node.phase];
          const nodeLock = lockFor(record, node.phase);
          return {
            phase: node.phase, layer: node.layer, row: node.row,
            state: ctx.board.states[node.phase] ?? 'waiting',
            size: detail?.size ?? 'M',
            gated: detail?.gated ?? false,
            title: detail?.title || rows.find((r) => r.phase === node.phase)?.title || `Phase ${node.phase}`,
            locked: nodeLock ? (nodeLock.expired ? 'stale' as const : 'live' as const) : undefined,
          };
        }),
        edges: rows.flatMap((row) => (index.deps.get(row.phase) ?? []).map((dep) => ({ from: dep, to: row.phase }))),
        layers: layout.reduce((max, n) => Math.max(max, n.layer + 1), 0),
        rows: layout.reduce((max, n) => Math.max(max, n.row + 1), 0),
      },
      batches,
      boardText,
      lint,
      handoffs: record.handoffs.map((h) => ({
        phase: h.phase, file: h.file, title: h.title, status: h.status, completed: h.completed,
        bytes: h.bytes, mtime: h.mtime, prompts: h.prompts.length, skillsUsed: h.skillsUsed,
      })),
      index: record.index,
      eta,
      cost,
      forecast,
      qa: record.qa,
      qaHeld: qaHeldBy(ctx.board),
      locks: record.locks.map((l) => ({ phase: l.phase, ...lockView(l)! })),
      git: { ...gitInfo, dirty: record.planPath ? this.repo.dirty.some((d) => record.planPath!.endsWith(d)) : undefined },
      // ABSENT when it was not asked for, rather than `null`.
      //
      // `null` already means something here — "this plan has no memory file" —
      // and a default response that said `null` for "you did not ask" would
      // make the Source tab render "no memory recorded" about a file that is
      // sitting on disk. One reader (the Source tab), 18 KB, so it asks.
      ...(wantMemory
        ? {
          memory: memoryEntry
            ? { key: memoryKey, path: memoryEntry.path, text: memoryEntry.text, indexLines: memoryIndexLines(memoryKey) }
            : null,
        }
        : {}),
    };
  }

  /**
   * A live run without its transcripts — what `/api/state` carries by default.
   *
   * One live run of a long plan is a 340 KB record, and `/api/state` is fetched
   * by every page on every navigation. `phases[].verification` alone was 227 KB
   * of it (the captured stdout of every command every phase ran) and the run's
   * `rulings` ledger another 58 KB. Nothing reads either off this endpoint —
   * the run views fetch `/api/runs` and `/api/run/<slug>`, which are unchanged.
   *
   * The drop lists are OMISSIONS (`shared/projection.js`), so a field added to
   * `RunState` tomorrow appears here without anyone remembering to add it. The
   * full records stay one query parameter away at `?include=runs`.
   */
  private runSummaries(): RunState[] {
    return this.runStates().map((run) => summarizeRun(run));
  }

  handoff(slug: string, phase: number) {
    const record = this.store?.get(slug);
    const handoff = record ? handoffFor(record, phase) : undefined;
    if (!handoff) return null;
    return {
      ...handoff,
      frontMatter: handoff.frontMatter.values,
      sections: handoff.sections.map((s) => ({ title: s.title, body: s.body })),
    };
  }

  searchAll(query: string): SearchResult { return this.search.search(query); }

  /**
   * Every skill a phase of this plan could invoke.
   *
   * Read from the Claude home the spawned session will use, not from wherever
   * this file happens to live — the console can be started from any of several
   * homes and the child inherits its environment.
   */
  skills(): SkillInfo[] { return listSkills(this.root?.path); }

  /**
   * The rules an unattended session runs under, and — the part that matters —
   * which layer actually enforces each one.
   *
   * `deny` is evaluated inside the CLI and was measured holding with this
   * console unreachable. `ask` goes through the HTTP hook, and that hook FAILS
   * OPEN: with nothing listening the tool call simply proceeds. Presenting the
   * two as one list would be the most dangerous thing this page could do.
   */
  policy(slug?: string | null) {
    const rules = [
      ...DEFAULT_DENY, ...DEFAULT_ASK, ...DEFAULT_ALLOW,
      ...policyExtras().deny, ...policyExtras().ask, ...policyExtras().allow,
    ];
    return {
      defaults: { deny: DEFAULT_DENY, ask: DEFAULT_ASK, allow: DEFAULT_ALLOW },
      extra: policyExtras(),
      // The plan's own file, so the editor can show which scope a rule is at
      // rather than presenting one merged list nobody can edit confidently.
      // `path` is where an edit would be WRITTEN (always keyed to this
      // instance); `extra` is what is currently in force, which on a machine
      // that predates instances is still the unkeyed file. They differ exactly
      // once per plan — until the first edit rewrites it to the keyed path.
      plan: slug ? { slug, path: planPolicyPath(slug), extra: policyExtras(effectivePlanPolicyPath(slug)) } : null,
      effective: loadPolicyFor(slug ?? null),
      // Who answers permission asks: plan ?? global ?? the shipped default
      // (ON). Nulls are "this scope says nothing", which is what lets the
      // editor render provenance instead of one flattened answer.
      autoApprove: autoApproveFor(slug ?? null),
      // Which shipped defaults have been struck, as a fact rather than as a
      // gap. `mergePolicy` has computed these since strikes shipped and only
      // ever subtracted them, so a reader could see the EFFECT of a strike and
      // never the strike — it had to diff the effective list against the
      // shipped one and infer. That is the wrong shape for the deny half in
      // particular: striking a shipped deny widens what every future run may
      // do, and a page that can only infer it cannot say so plainly.
      struck: struckFor(slug ?? null),
      // The profile a new run here would get. `profiles` below is the
      // CATALOGUE — it says what exists, never which one is chosen, so a
      // composed view built from it alone could not answer the first question
      // anybody asks a permissions page. There is no profile PREFERENCE: it is
      // per-run, and this is the word the run door falls back to.
      profile: DEFAULT_PERMISSION_PROFILE,
      file: POLICY_PATH,
      profiles: PERMISSION_PROFILES.map((id) => ({ id, label: PROFILE_LABELS[id] })),
      // What the syntax accepts but nothing honours, named rather than left to
      // be discovered at 3am — judged against the tools this console has seen
      // sessions offer, so a tool newer than the shipped list is never inert.
      inert: inertRules(loadPolicyFor(slug ?? null), this.toolsSeen),
      // What the policy in force cannot do (phase 12, TRS-9): an empty ask
      // list, a struck deny wall — each with whether it was acknowledged
      // against exactly these rules. Non-empty until a person has read it.
      advisory: this.policyAdvisories(slug ?? null),
      // Which of these this console can enforce itself, and which are the CLI's
      // job — the distinction that decides whether a rule you just wrote will
      // hold at the hook.
      support: [...new Set(rules)]
        .map((rule) => parseRule(rule, this.toolsSeen))
        .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
        .map(({ raw, tool, form, support, note }) => ({ raw, tool, form, support, note })),
      hookTools: HOOK_TOOLS,
      wrappersNotStripped: WRAPPERS_NOT_STRIPPED,
      /** Every tool this console has actually seen a call for. */
      seen: [...this.toolsSeen].sort(),
    };
  }

  addPolicy(rules: { deny?: string[]; ask?: string[] }) {
    addPolicyRules(rules);
    return this.policy();
  }

  /**
   * Add or remove rules at one scope. The widening direction is deliberate —
   * see `editPolicy` — and every call says who asked.
   */
  editPolicy(edit: {
    scope?: PolicyScope;
    slug?: string | null;
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /** Return these parts to stock at the chosen scope — see `approvals.editPolicy`. */
    reset?: ('deny' | 'ask' | 'allow')[];
    /** Forgive individual strikes against shipped defaults — deny included. */
    restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /** Set (true/false) or clear (null) the auto-grant scalar at this scope. */
    set?: { autoApprove?: boolean | null };
    by?: string;
  }) {
    const scope: PolicyScope = edit.scope === 'plan' ? 'plan' : 'global';
    if (scope === 'plan' && !edit.slug) throw new Error('a plan-scoped rule needs a plan');
    const file = scope === 'plan' ? planPolicyPath(edit.slug as string) : POLICY_PATH;
    editPolicy({
      add: edit.add, remove: edit.remove, reset: edit.reset, restore: edit.restore,
      ...(edit.set ? { set: edit.set } : {}),
      by: edit.by ?? 'console',
      // A rule naming a tool this console has seen is never refused as inert.
      known: this.toolsSeen,
    }, file);
    this.journalPolicy(scope, edit);
    return this.policy(edit.slug ?? null);
  }

  /**
   * Answer one card, optionally writing the rule that stops it coming back.
   *
   * The rule is written *before* the decision is settled, so the session's very
   * next call is already classified under it. The other order has a real gap:
   * the session resumes the instant it is answered, and a fast phase can reach
   * the same command before the file lands — which looks exactly like "Always
   * allow didn't work".
   *
   * A rule that will not parse is refused and nothing is written, but the card
   * is still answered: the operator's decision about *this* call stands on its
   * own, and swallowing it because the remembering failed would be the worse
   * half to lose.
   */
  decideApproval(
    id: string,
    decision: 'allow' | 'deny',
    by: string,
    reason: string | undefined,
    remember?: { scope: PolicyScope; rule: string },
  ): { ok: boolean; decision?: string; wrote?: string; scope?: PolicyScope; error?: string } {
    const approval = this.approvals.all().find((entry) => entry.id === id);
    let wrote: string | undefined;
    let failed: string | undefined;

    if (remember?.rule) {
      const rule = remember.rule.trim();
      if (!parseRule(rule)) {
        failed = `"${rule}" is not a rule this syntax accepts — nothing was written`;
      } else if (remember.scope === 'plan' && !approval?.slug) {
        failed = 'this card is not attached to a plan, so it cannot write a plan-scoped rule';
      } else {
        // An allow decision writes an allow rule; a deny writes an ask rule
        // rather than a deny one. Widening from a card is deliberate and
        // reversible; *narrowing* to the wall from a card is not offered at
        // all — `deny` is what holds when this console is dead, and it should
        // take more than a tap to put something there.
        const list = decision === 'allow' ? 'allow' : 'ask';
        this.editPolicy({
          scope: remember.scope,
          slug: approval?.slug ?? null,
          add: { [list]: [rule] },
          by,
        });
        wrote = rule;
      }
    }

    const settled = this.approvals.settle(id, decision, by, reason);
    if (!settled) return { ok: false, error: 'no such pending approval' };
    return {
      ok: true,
      decision,
      ...(wrote ? { wrote, scope: remember?.scope } : {}),
      ...(failed ? { error: failed } : {}),
    };
  }

  /**
   * Write the rule change into the live run's journal.
   *
   * A policy file records what the rules ARE. It cannot record that the run
   * which was interrupted at 02:14 is the reason one of them exists — and that
   * is the question anyone reviewing an unattended run actually asks.
   */
  private journalPolicy(scope: PolicyScope, edit: {
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    set?: { autoApprove?: boolean | null };
    by?: string;
  }): void {
    const flatten = (part?: { deny?: string[]; ask?: string[]; allow?: string[] }) => [
      ...(part?.deny ?? []).map((rule) => `deny ${rule}`),
      ...(part?.ask ?? []).map((rule) => `ask ${rule}`),
      ...(part?.allow ?? []).map((rule) => `allow ${rule}`),
    ];
    const added = flatten(edit.add);
    const removed = flatten(edit.remove);
    // A scalar flip is as much a rule change as a list edit: from the very
    // next hook call, asks answer themselves (or stop doing so).
    const set = edit.set && 'autoApprove' in edit.set ? edit.set : undefined;
    if (!added.length && !removed.length && !set) return;
    // Every live run's journal. A policy edit changes what each of them is
    // allowed to do from its very next tool call, so recording it in one run's
    // journal and not the others would leave the rest unexplainable.
    for (const runner of this.liveRunners()) {
      runner.note('policy.edited', {
        scope, by: edit.by ?? 'console',
        ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}),
        ...(set ? { set } : {}),
      });
    }
  }

  /**
   * The console's own state. `include=runs` (or `full`) restores the complete
   * run records; the default carries summaries — see `runSummaries()`.
   */
  state(include?: Set<string>) {
    return {
      root: this.root,
      prefs: this.prefs,
      // What the doctor found about this process's own environment (PATH rot,
      // and — appended at runtime — broken push delivery). Additive; the
      // client renders it on the dashboard's console-health block.
      environment: this.environment,
      // Which console this is. The client needs all three: the name for the tab
      // title (two consoles are indistinguishable in a tab strip otherwise),
      // `pinned` to know whether the source picker can do anything, and the id
      // because it is what every message and lifecycle verb identifies it by.
      instance: { id: INSTANCE.id, name: INSTANCE.name, pinned: INSTANCE.pinned },
      allowWrites: this.flags.allowWrites,
      // Present only on a server that has the run endpoints at all. The client
      // is read from disk per request but the server is whatever Node loaded at
      // startup, so upgrading the skill under a running console leaves a new UI
      // talking to an old API. Without something to test, that shows up as a
      // wall of 404s and error toasts instead of "restart me".
      autopilot: true,
      // True once the server files on disk are newer than this process. The
      // browser reloads from disk; this process cannot.
      serverStale: serverIsStale(),
      // Which client this server would serve right now — `dist` once a build
      // exists, else the legacy `web/`. Picked per request, so it can change
      // under a long-lived process; Settings reports it rather than leaving the
      // answer in a startup log written hours ago.
      staticRoot: staticRoot(),
      // Which commit `dist` was built from — the Settings Interface row
      // compares this against the tab's own baked rev to say whether the page
      // someone is looking at is the page this server serves.
      distRev: distRev(),
      // Whether a clean exit comes back. The Restart button is only honest if
      // it knows this before it is pressed — under `./run` there is nothing to
      // restart it, and a button that ends the console is not a Restart button.
      supervisor: supervisor(),
      unread: this.notifications.unread(),
      // How many cards this console has put in front of a person, and since when
      // (TRS-5): "0 cards in N days" visible rather than assumed benign.
      approvals: { ...this.approvals.counts(), pending: this.approvals.pending().length },
      allowRun: this.flags.allowRun,
      // The shell gate, so the nav can offer a Terminal only where there is one
      // to offer. `/api/terminal` carries the richer answer (whether node-pty
      // actually loaded, and what is open); this is the one bit the shell needs
      // on every page.
      allowTerminal: this.flags.allowTerminal,
      // The agent gate, same shape — the nav-level fact; the richer answer
      // still lives on `/api/terminal` (`agentAllowed` beside `allowed`).
      allowAgent: agentEnabled(this.flags),
      // The account-registration gate. The meters and the account LIST are not
      // behind it — watching your own quota is display — this only decides
      // whether the Add/Sign-in/Remove verbs exist.
      allowAccounts: this.flags.allowAccounts,
      // The MCP-registration gate. The registry LIST, the catalog and the
      // connection statuses are not behind it — seeing what your own sessions
      // connect to is display — this only decides whether Add/Remove/Sign-in exist.
      allowMcp: this.flags.allowMcp,
      // The outbound-webhook gate. The registered LIST is not behind it —
      // seeing where your own console would speak is display — this decides
      // whether the Add/Remove/Test verbs exist AND whether any POST is made.
      allowWebhooks: this.flags.allowWebhooks,
      // Every live run. The old singular `run` — "the FIRST live run of any
      // plan" — was dropped once the pool made it a lie: with two plans
      // driving, any consumer of it read plan B's run while looking at plan A.
      // Grep found zero readers, and a stale tab is carried over the gap by
      // the console's own reload machinery (`generation`/`serverStale`).
      runs: wants(include, 'runs') ? this.runStates() : this.runSummaries(),
      // What the scheduler is doing, so a header can say "2 of 3 running, 1
      // queued" instead of leaving a queued phase looking like a stalled one.
      concurrency: this.concurrency(),
      // The panic button's state. On `/api/state` rather than only on
      // `/api/queue` because the banner it drives renders app-wide, on every
      // destination — a console that is frozen must say so on the page the
      // operator happens to be looking at, not only on the one about runs.
      // The runs this console's own restart stopped, waiting on an answer. An
      // empty list is the normal case and costs one array; the app opens the
      // question only when there is one.
      resumeAsk: [...this.resumeAsks.values()]
        .filter((ask) => !this.resumeDecisions.has(ask.runId))
        .map((ask) => ({ ...ask, phases: [...ask.phases] })),
      fleet: this.fleetState(),
      // Why this console holds its automation, when it does (SHD-5, FLT-9) —
      // the banner and Settings' release read it.
      bootHold: this.bootHold(),
      scriptsDir: this.flags.scriptsDir,
      // Which hostnames this console answers to besides localhost, and who may
      // arrive through them. Both are on the state rather than only on
      // `/api/tailscale` because the interesting question is a *disagreement*
      // between two places: `tailscale serve` can be publishing this port with
      // no `--remote` flag set (every request 421s), or the flags can name a
      // host nothing is serving (the URL never resolves). Either way the
      // console looks broken from the phone and fine from here, so Settings
      // needs both halves to say which one it is.
      remoteHosts: this.flags.remoteHosts,
      remoteUsers: this.flags.remoteUsers,
      // Where those settings — and the notifier, the webhook rows, the device
      // defaults and the machine ceiling — came from: a flag, the environment,
      // this console's own override in `fleet.json`, or the machine profile
      // every console reads (FLT-3). An inherited setting is visible, not a surprise.
      profile: this.flags.profile ?? null,
      // What this console has SERVED, by scope, and when a phone last reached it
      // (FLT-10) — the counters that make "has the phone path ever worked?"
      // answerable. Logins are hashed; none is ever carried in clear.
      access: accessLedger.snapshot(),
      // The port this console is actually on, because the setup commands the
      // Settings card prints embed it. A card that hard-codes 4123 tells
      // somebody on `--port 5000` to publish a port nothing is listening on,
      // and the resulting 502 looks like a Tailscale problem.
      port: this.flags.port,
      // For the same setup cards: which OS this server runs on (the commands
      // differ), and the home dir so absolute paths render as "$HOME/…" —
      // portable to paste, and free of the username in a screenshot.
      platform: process.platform,
      home: homedir(),
      // What a NEW run would start with, so the picker can pre-check them and
      // say where they came from. Not what any existing run has — that is on
      // the run.
      defaultSkills: this.flags.defaultSkills,
      // The model lineup, from the one file that defines it. The client used
      // to carry its own copy of this list, which is a second source of truth
      // for a vocabulary the server 400s on — so the form now asks.
      models: offeredModels(),
      sizing: this.sizing,
      generation: this.generation,
      repo: this.repo,
      recentRoots: this.prefs.recentRoots.map((path) => ({ path, label: basename(path) })),
      searchDocs: this.search.size,
      // Health, so the UI can say "stale" instead of quietly showing an old
      // board: a deaf watcher and a crashed subsystem both look fine otherwise.
      watcher: this.watcher.status(),
      health: degradedState(),
    };
  }

}
