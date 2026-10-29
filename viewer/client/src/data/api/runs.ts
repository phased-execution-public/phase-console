/**
 * The autopilot — runs, phase records, approvals, the convergence loop, and the
 * ETA shapes every other surface reads. Its shapes are the wire's
 * (`shared/wire/runs.js`, measured-console phase 32); this file keeps the fetches.
 */

import { request, post, q } from '../http';
import type { PreludeDraft } from '../runs';
import type {
  AnswerResult,
  Approval,
  AskResult,
  ClearStreakAnswer,
  ConvergeStatusView,
  DecideResult,
  ErrandTreeAnswer,
  JournalEntry,
  LedgerSummary,
  PhaseActivity,
  PhaseAttempts,
  PhaseDiagnosis,
  PhaseReport,
  PlanDecisionAnswer,
  PlanDecisionBody,
  PlanText,
  PreludeAnswer,
  QaRecoverSettings,
  RaiseBudgetAnswer,
  RaiseBudgetBody,
  RecoverAnswer,
  RetryEdits,
  RulingList,
  RulingRememberAnswer,
  RunDetail,
  RunEnvelope,
  RunIdentityAnswer,
  RunLedger,
  RunNoteBody,
  RunNoteResult,
  RunResumeAnswer,
  RunRetryAnswer,
  RunSettings,
  RunState,
  RunTimeline,
  SlimRun,
  TranscriptEntry,
  TriggerAnswer,
  TriggerArm,
  TriggerList,
  UltraReviewAnswer,
  VerifyCommandAnswer,
  VerifyWaiveAnswer,
} from '@shared/wire/runs.js';

/** Every shape of the run surface — the wire's, by name (a star re-export would carry `WIRE_ROUTES` too). */
export type {
  AccountRequirement,
  ActivityEvent,
  AnswerBody,
  AnswerResult,
  Approval,
  AskBody,
  AskResult,
  AttemptComparison,
  AttemptSummary,
  AttemptVerification,
  Autonomy,
  BarKind,
  BoardingHint,
  BootHoldRelease,
  BootHoldView,
  Cap,
  CapDerivation,
  CheckoutEntry,
  ChildRef,
  CiNotRunView,
  ClearStreakAnswer,
  ContextMark,
  ConvergeActionView,
  ConvergeStatusView,
  ConvergeView,
  DecideResult,
  DeclarationLedgerRow,
  Divergence,
  Errand,
  ErrandTreeAnswer,
  EtaBasis,
  EtaEstimate,
  EtaScore,
  EvaluationCriterion,
  Evidence,
  EvidenceProof,
  GitStrategyLine,
  HaltHolder,
  JournalEntry,
  LaneBody,
  LaneLiveness,
  LaneMarkAnswer,
  LaneTokens,
  LaneYieldAnswer,
  LedgerCap,
  LedgerRung,
  LedgerSession,
  LedgerStart,
  LedgerSummary,
  LedgerSummaryRow,
  LedgerTotals,
  LockReleaseAnswer,
  LockReleaseBody,
  LockRows,
  LoopEvidence,
  MarkKind,
  McpDegradation,
  McpPolicy,
  OnLimitPolicy,
  OpenTool,
  OwedRed,
  PartialMark,
  PermissionProfile,
  PhaseActivity,
  PhaseActor,
  PhaseAttempts,
  PhaseBaseline,
  PhaseDiagnosis,
  PhaseEta,
  PhaseEtaConfidence,
  PhaseEvaluation,
  PhaseForecastUsdView,
  PhaseHolder,
  PhaseLanding,
  PhaseLandingRepo,
  PhaseLive,
  PhaseLiveVia,
  PhaseOptions,
  PhasePressBody,
  PhaseRecord,
  PhaseReport,
  PhaseStatus,
  PhaseSuspect,
  PhaseTask,
  PlanDecisionAnswer,
  PlanDecisionBody,
  PlanText,
  PreflightWarning,
  Prelude,
  PreludeAnswer,
  PreludeRow,
  PreludeStep,
  PressLaunch,
  PressQueued,
  ProbeStatus,
  ProbeVerdict,
  QaFixStrategy,
  QaRecoverBody,
  QaRecoverSettings,
  QaRound,
  RadarPair,
  RaiseBudgetAnswer,
  RaiseBudgetBody,
  RecordedWall,
  RecoverAnswer,
  RecoveryAction,
  RecoverySlot,
  RelayMode,
  ReportSource,
  ResolvedManifest,
  RetryEdits,
  RetryOverride,
  Ruling,
  RulingKind,
  RulingList,
  RulingRememberAnswer,
  RulingRememberBody,
  RunControlBody,
  RunDetail,
  RunEnvelope,
  RunForecastUsdView,
  RunGitView,
  RunHalt,
  RunIdentityAnswer,
  RunIdentityBody,
  RunJournal,
  RunLedger,
  RunList,
  RunNote,
  RunNoteBody,
  RunNoteResult,
  RunProof,
  RunProofs,
  RunRequestAnswer,
  RunRequestBody,
  RunResolution,
  RunResolveBody,
  RunResumeAnswer,
  RunRetryAnswer,
  RunRetryBody,
  RunScopes,
  RunSettings,
  RunState,
  RunStatus,
  RunTimeline,
  RunTranscript,
  RunVerification,
  RunVerifications,
  RunWaitAnswer,
  RungRecord,
  SessionCap,
  SessionCapTable,
  SessionSizing,
  SessionsPerPhase,
  SlimPhaseFacts,
  SlimRun,
  SlowRule,
  StallState,
  StoredTrigger,
  SwitchAccountAnswer,
  SwitchAccountBody,
  TimelineBar,
  TimelineLane,
  TimelineMark,
  TimelineSeriesPoint,
  TokenAttempt,
  TranscriptEntry,
  TreesDetail,
  TriggerAnswer,
  TriggerArm,
  TriggerCancelBody,
  TriggerList,
  UltraReviewAnswer,
  VerificationDetail,
  VerificationFlip,
  VerificationItem,
  VerificationReviewView,
  VerifyCommandAnswer,
  VerifyCommandBody,
  VerifyLimitSource,
  VerifyRun,
  VerifySummary,
  VerifyWaiveAnswer,
  VerifyWaiveBody,
  VerifyWaiver,
  VerifyingLane,
  WaitEntry,
  WaitReason,
  WeekMetrics,
  WeekReportAnswer,
  WipRed,
} from '@shared/wire/runs.js';

/**
 * The halt vocabulary, imported by identity from `shared/recovery-model.js`.
 * This was a hand-kept third copy of the same seventeen words (the server's
 * `runner/state.ts` mirror is the second); nothing compared them, so nothing
 * would have said which one was right on the day they disagreed.
 */
export type { HaltKind } from '@shared/recovery-model.js';

/**
 * What the runner can see about a lane that has NOT stopped.
 *
 * Five signals, worst first, imported by identity from `shared/attention-model.js`
 * rather than restated here — this union used to be a hand-kept copy and it had
 * already drifted: `external-wait` arrived in shared with `stallExternal` and
 * never reached this side, so a lane waiting on someone else's clock had no word
 * on this side of the wire. Deliberately a different list from the inbox's
 * `StallKind`: these are about a session that exists and is spending, and four of
 * the inbox's six kinds describe a phase with no session at all.
 */
export type { StallSignal } from '@shared/attention-model.js';

/** The launch draft the prelude reads — client-only, it rides in the query; `data/runs.ts` declares it. */
export type { PreludeDraft, VerifyAnswers } from '../runs';

/**
 * Every run, one word per phase — a list's read; the whole list is megabytes
 * (#234). Its own export rather than a member of `runsApi`: an object's
 * members ride first paint whether anything presses them or not.
 */
export const runList = () => request<SlimRun[]>('/api/runs?view=slim');

/** One plan's newest run, slim — a strip's read; `null` for a plan that never ran. */
export const runStrip = (slug: string) =>
  request<SlimRun[]>(`/api/runs?latest=1&slug=${q(slug)}`).then((rows) => rows[0] ?? null);

export const runsApi = {
  /* ---- autopilot ---- */
  runs: () => request<RunState[]>('/api/runs'),
  run: (slug: string) => request<RunDetail>(`/api/run/${q(slug)}`),
  runJournal: (slug: string, id?: number, limit?: number) =>
    request<JournalEntry[]>(
      `/api/run/${q(slug)}/journal${id ? `/${id}` : ''}${limit ? `?limit=${limit}` : ''}`,
    ),
  /**
   * The PLAN's whole ruling ledger, oldest first — not the run's slice.
   *
   * Answers before any run exists, which is the common case for a plan
   * somebody is driving by hand.
   */
  runRulings: (slug: string) => request<RulingList>(`/api/run/${q(slug)}/rulings`),
  /**
   * A ruling becomes a standing answer: `plan` writes the plan's `## Decisions`
   * row (behind `--allow-writes`), `global` and `rule` a console preference.
   */
  rememberRuling: (slug: string, id: string, scope: 'plan' | 'global' | 'rule') =>
    post<RulingRememberAnswer>(`/api/run/${q(slug)}/rulings/${q(id)}/remember`, { scope }),
  /** The run projected onto one absolute time axis (`server/analysis/timeline.ts`). */
  runTimeline: (slug: string, id?: string) =>
    request<RunTimeline>(`/api/run/${q(slug)}/timeline${id ? `/${q(id)}` : ''}`),
  /** One phase's boardings, with each consecutive pair already diffed. */
  runAttempts: (slug: string, phase: number, id?: string) =>
    request<PhaseAttempts>(`/api/run/${q(slug)}/attempts/${phase}${id ? `?run=${q(id)}` : ''}`),
  /** Why each start happened and what every session cost, held to the run's spend (`server/analysis/ledger.ts`). */
  runLedger: (slug: string, id?: string) =>
    request<RunLedger>(`/api/run/${q(slug)}/ledger${id ? `/${q(id)}` : ''}`),
  /** Every open plan's newest runs, their ledgers per plan and per account — what Insights draws. */
  ledgerSummary: () => request<LedgerSummary>('/api/ledger'),
  /**
   * The session replay, read from the end of its files. With `phase`, that
   * phase's own replay — one capped file per phase since control-tower phase 94
   * (#133) — or its journal lines, said so, when it has none.
   */
  runTranscript: (slug: string, id?: string, limit?: number, phase?: number) => {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (phase != null) query.set('phase', String(phase));
    const search = query.toString();
    return request<TranscriptEntry[]>(
      `/api/run/${q(slug)}/transcript${id ? `/${id}` : ''}${search ? `?${search}` : ''}`,
    );
  },
  /**
   * A phase's last events, read from its live (or latest) session's own log
   * (control-tower phase 95, #138) — whatever the replay's size. `run` reads
   * the phase as a PAST run of the plan held it (quiet-console phase 11).
   */
  phaseActivity: (slug: string, phase: number, limit = 20, opts: { run?: string | undefined } = {}) =>
    request<PhaseActivity>(
      `/api/run/${q(slug)}/phase/${phase}/activity?limit=${limit}${opts.run ? `&run=${q(opts.run)}` : ''}`,
    ),
  /** A phase's report: doing, done, left, waiting on, why slow, when (#163) — of a named run with `run`. */
  phaseReport: (slug: string, phase: number, opts: { run?: string | undefined } = {}) =>
    request<PhaseReport>(`/api/run/${q(slug)}/phase/${phase}/report${opts.run ? `?run=${q(opts.run)}` : ''}`),
  /** The plan's stored triggers, armed first (control-tower phase 98, #137). */
  runTriggers: (slug: string) => request<TriggerList>(`/api/run/${q(slug)}/triggers`),
  /** Arm one: when `when` holds, press `verb` with `body` — once, or every time until it expires. */
  armTrigger: (slug: string, spec: TriggerArm) => post<TriggerAnswer>(`/api/run/${q(slug)}/triggers`, spec),
  /** Cancel one by id; the ledger keeps it, ended, with who and why. */
  cancelTrigger: (slug: string, id: string, reason?: string) =>
    post<TriggerAnswer>(`/api/run/${q(slug)}/triggers/${q(id)}/cancel`, reason ? { reason } : {}),
  /**
   * Board this phase at the next boundary with these words, ahead of every
   * other candidate — the pause and the resume-phase in one press
   * (control-tower phase 98, #137 item 3).
   */
  runBoardAtBoundary: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/board-at-boundary`, {
      phase,
      ...(instruction ? { instruction } : {}),
    }),
  /**
   * A person's word that the console may move dirty or unpushed content at the
   * run's mount paths aside — never delete it — and rebuild them (control-tower
   * phase 90, #139). Resumes a run parked `isolation-refused`.
   */
  runRepairCheckout: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/repair-checkout`, {}),
  /** Switch a shared-checkout run to a checkout of its own at its next boundary (#150). */
  runIsolate: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/isolate`, {}),
  /** Give ONE phase of a shared-checkout run a worktree of its own (#150). */
  runIsolatePhase: (slug: string, phase: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/isolate-phase`, { phase }),
  /** A stable checkout at the pushed run branch for a phase's errand, which no prune takes (#123). */
  runErrandTree: (slug: string, phase: number) =>
    post<ErrandTreeAnswer>(`/api/run/${q(slug)}/errand-tree`, { phase }),
  runStart: (slug: string, options?: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/start`, options),
  /**
   * The run-start prelude for the launch form's DRAFT (phase 11): the manifest
   * rendered and the probes run over the console's own facts, before
   * Launch is pressed. The draft's answers ride in the query so the form shows
   * exactly what the door will judge.
   */
  runPrelude: (slug: string, draft: PreludeDraft = {}) => {
    const params = new URLSearchParams();
    if (draft.accounts?.length)
      params.set('accounts', draft.accounts.map((a) => `${a.id}:${a.minHeadroomPct}`).join(','));
    if (draft.relay) params.set('relay', draft.relay);
    if (typeof draft.resumeOnRestart === 'boolean')
      params.set('resumeOnRestart', String(draft.resumeOnRestart));
    if (draft.acknowledgedWaivers?.length) params.set('ack', draft.acknowledgedWaivers.join(','));
    if (draft.model) params.set('model', draft.model);
    if (draft.profile) params.set('profile', draft.profile);
    if (draft.mcpPolicy) params.set('mcpPolicy', draft.mcpPolicy);
    if (draft.onlyPhases?.length) params.set('only', draft.onlyPhases.join(','));
    if (draft.autonomy) params.set('autonomy', draft.autonomy);
    if (draft.verifyAnswers?.approve.length) params.set('approve', draft.verifyAnswers.approve.join(','));
    if (draft.verifyAnswers?.waive.length) params.set('waive', draft.verifyAnswers.waive.join(','));
    if (draft.gitMode) params.set('gitMode', draft.gitMode);
    if (draft.isolation) params.set('isolation', draft.isolation);
    const query = params.toString();
    return request<PreludeAnswer>(`/api/run/${q(slug)}/prelude${query ? `?${query}` : ''}`);
  },
  runPause: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/pause`),
  /**
   * One cloud review of this run's branch, now — billed to the operator's own
   * account, one review per press. The answer is the review's own result: a
   * review that could not happen is `unknown` with its reason, never "nothing found".
   */
  runUltraReview: (slug: string) => post<UltraReviewAnswer>(`/api/run/${q(slug)}/ultrareview`),
  /**
   * A person's answer to an identity park (control-tower phase 91, #131):
   * `continue` on the login the account answers now, or `move` to a registered
   * account that answers the identity the run started on. Both resume the run.
   */
  runIdentity: (slug: string, choice: 'continue' | 'move', accountId?: string) =>
    post<RunIdentityAnswer>(`/api/run/${q(slug)}/identity`, {
      choice,
      ...(accountId ? { accountId } : {}),
    }),
  /**
   * A phase's run request answered (turn-by-turn phase 6, #286): the ONE
   * approval per run and act — `approve` takes the act (a budget raise names
   * its dollars in the note), `deny` tells every phase that asked no. The
   * errand's options press the same route through `pressOption`.
   */
  runRequest: (
    slug: string,
    phase: number,
    answer: 'approve' | 'deny',
    note?: string,
    expectRunId?: string,
  ) =>
    post<{ ok: true }>(`/api/run/${q(slug)}/run-request`, {
      phase,
      answer,
      ...(note ? { note } : {}),
      ...(expectRunId ? { expectRunId } : {}),
    }),
  // `resumed` says which of the two it did (control-tower phase 77, #102):
  // took back a pause not yet reached, or started a settled pause again — or,
  // since control-tower phase 110 (#176), a parked, halted or interrupted run.
  runResume: (slug: string) => post<RunResumeAnswer>(`/api/run/${q(slug)}/resume`),
  /**
   * Hold and release — the admission gate, not the phase boundary.
   *
   * Beside Pause/Resume because that is the pair they are compared with, and
   * different from them in the one way that matters: a pause settles the run
   * at the next boundary, a hold refuses the next ADMISSION and lets the
   * running phases finish and write their handoffs.
   */
  runHold: (slug: string, by?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/hold`, by ? { by } : undefined),
  runRelease: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/release`),
  runStop: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/stop`, phase ? { phase } : undefined),
  runSkip: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/skip`, { phase }),
  /**
   * Board this phase again — with `edits`, board it again with words and
   * settings for that ONE attempt.
   *
   * A bare call is byte-identical to the plain Retry this has always been: the
   * server reads an empty payload as "no override" and clears any unspent one,
   * so "Retry" and "Retry with edits, having typed nothing" mean the same thing
   * rather than two things.
   */
  runRetry: (slug: string, phase: number, edits?: RetryEdits) =>
    post<RunRetryAnswer>(`/api/run/${q(slug)}/retry`, { phase, ...(edits ?? {}) }),
  /**
   * Zero the consecutive-failure streak and nothing else.
   *
   * Its own verb because the thing that is wrong is the COUNTER: an outage can
   * spend a run's whole allowance in seconds, and there is no phase to retry.
   * Answers what the counter was, so the button can say what it did. `409` on
   * a finished run — a settled run's record is not editable.
   */
  runClearStreak: (slug: string) => post<ClearStreakAnswer>(`/api/run/${q(slug)}/clear-streak`, {}),
  /**
   * Raise the budget that stopped the work, where it was declared, and retry —
   * one press (control-tower phase 14, #40). `add` is the raise in the
   * budget's unit (minutes, dollars, rungs); a wait writes the plan, so it
   * answers 403 on a console without `--allow-writes`.
   */
  runRaiseBudget: (slug: string, body: RaiseBudgetBody) =>
    post<RaiseBudgetAnswer>(`/api/run/${q(slug)}/raise-budget`, body),
  /** The plan a plan-mode phase presented (control-tower phase 17, #34) — what the halt card's reader draws. */
  runPlanText: (slug: string, phase: number) =>
    request<PlanText>(`/api/run/${q(slug)}/plan-text?phase=${encodeURIComponent(String(phase))}`),
  /** A person's Approve or Reject of that plan (control-tower phase 11). */
  runPlanDecision: (slug: string, body: PlanDecisionBody) =>
    post<PlanDecisionAnswer>(`/api/run/${q(slug)}/plan-approval`, body),
  runRecheck: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/recheck`, { phase }),
  runCloseout: (slug: string, phase: number) => post<RunEnvelope>(`/api/run/${q(slug)}/closeout`, { phase }),
  /** Set the run to `continue` and retry every phase the MCP preflight parked. */
  runMcpContinue: (slug: string) => post<RunEnvelope>(`/api/run/${q(slug)}/mcp-continue`, {}),
  runRecover: (slug: string) => post<RecoverAnswer>(`/api/run/${q(slug)}/recover`, {}),
  runVerifyCommand: (slug: string, phase: number, command: string) =>
    post<VerifyCommandAnswer>(`/api/run/${q(slug)}/verify-command`, { phase, command }),
  runResumePhase: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resume-phase`, {
      phase,
      instruction,
    }),
  /** Hand the acts a phase kept for a person (`--needs human-acts`) to its session. */
  runDelegate: (slug: string, phase: number, instruction?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/delegate`, {
      phase,
      instruction,
    }),
  /**
   * Waive ONE §Verification line of a phase, mid-run, with a reason (one-pool
   * phase 21, #267): a ruling on the plan's ledger, honoured at the phase's
   * next verification.
   */
  runVerifyWaive: (slug: string, phase: number, line: string, reason: string, expectRunId?: string) =>
    post<VerifyWaiveAnswer>(`/api/run/${q(slug)}/verify-waive`, {
      phase,
      line,
      reason,
      ...(expectRunId ? { expectRunId } : {}),
    }),
  /** "Done — continue": a person did the errand the phase is parked on (control-tower phase 88, #124). */
  runErrandAnswered: (slug: string, phase: number, note?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/phase/${phase}/errand-answered`, { note }),
  phaseDiagnosis: (slug: string, phase: number | string) =>
    request<PhaseDiagnosis>(`/api/run/${q(slug)}/diagnosis/${q(String(phase))}`),
  runSettings: (slug: string, patch: RunSettings) => post<RunEnvelope>(`/api/run/${q(slug)}/settings`, patch),
  /**
   * The two QA-recovery verbs that START something (issue #11): the fix-and-
   * review loop, and the review alone. One function because they are one door
   * and one payload, differing by the verb — `qa-rerun` simply boards no fix
   * session, which is what "the review was wrong rather than the work" means.
   *
   * Waiving is NOT here: it writes one row and starts nothing, so it lives with
   * the plan's other write (`qaWaive`, `api/plans.ts`) and is gated on
   * `--allow-writes` rather than `--allow-run`.
   */
  qaRecover: (slug: string, phase: number, options?: QaRecoverSettings) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/qa-recover`, { phase, ...(options ?? {}) }),
  qaRerun: (slug: string, phase: number, options?: QaRecoverSettings) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/qa-rerun`, { phase, ...(options ?? {}) }),
  // `phase` is optional on all five per-session controls: omitted means "the
  // session that is running", which is what they meant before a run could hold
  // more than one. Naming it makes the server refuse rather than act on
  // whichever phase is running by the time the request lands.
  runFreeze: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/freeze`, phase ? { phase } : undefined),
  runThaw: (slug: string, phase?: number) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/thaw`, phase ? { phase } : undefined),
  // Dismissing a stopped run's card, and putting it back. By run id, because
  // the card belongs to the run that raised it — not to whichever run of that
  // plan happens to be newest.
  runResolve: (slug: string, runId: string, note?: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/resolve`, {
      runId,
      ...(note ? { note } : {}),
    }),
  runUnresolve: (slug: string, runId: string) =>
    post<RunEnvelope>(`/api/run/${q(slug)}/unresolve`, { runId }),
  // A person's note on the run, and pinning one (control-tower phase 96, #142).
  runNote: (slug: string, body: RunNoteBody & { text: string }) =>
    post<RunNoteResult>(`/api/run/${q(slug)}/notes`, body),
  runPinNote: (slug: string, id: string, pinned: boolean) =>
    post<RunNoteResult>(`/api/run/${q(slug)}/notes`, { id, pinned }),
  runAsk: (slug: string, question: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/ask`, {
      question,
      key,
      ...(phase ? { phase } : {}),
    }),
  runSteer: (slug: string, instruction: string, key: string, phase?: number) =>
    post<AskResult>(`/api/run/${q(slug)}/steer`, {
      instruction,
      key,
      ...(phase ? { phase } : {}),
    }),

  approvals: () => request<Approval[]>('/api/approvals'),
  // A person's pick on a relayed question, inside its window (phase 14).
  answerQuestion: (slug: string, approvalId: string, answers: { key: string; label: string }[]) =>
    post<AnswerResult>(`/api/run/${q(slug)}/answer`, { approvalId, answers }),
  decide: (id: string, decision: string, reason?: string, remember?: string, rule?: string) =>
    post<DecideResult>(`/api/approvals/${q(id)}`, {
      decision,
      reason,
      ...(remember ? { remember, rule } : {}),
    }),
  // Not yet (control-tower phase 97, #140): the card's deadline, `minutes` later.
  extend: (id: string, minutes: number) =>
    post<{ ok: boolean; standing?: boolean; error?: string; approval?: Approval }>(
      `/api/approvals/${q(id)}/extend`,
      { minutes },
    ),

  /* ---- the convergence loop ---- */
  converge: () => request<ConvergeStatusView>('/api/converge'),
};
