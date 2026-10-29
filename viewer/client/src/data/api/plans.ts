/**
 * Plans, phases, handoffs and gates — the plan surface — and the guarded write
 * verbs that act on it. The shapes are the wire's (`shared/wire/plans.js`);
 * this file keeps only the fetches.
 */

import { request, post, q } from '../http';
import { PLAN_INCLUDES, includeParam } from '../../../../shared/projection.js';
import type {
  EngineQueue,
  GateApprovalBody,
  GateApprovalOutcome,
  GateStatus,
  HandoffDetail,
  IsolationPreflight,
  LandingComposeBody,
  LandingComposeOutcome,
  LandingView,
  LintResult,
  LockRelease,
  PhaseNotes,
  PhaseReview,
  PlanDetail,
  PlanList,
  PlanWork,
  QaActivateOutcome,
  QaModeSetOutcome,
  QaReportView,
  QaWaiveBody,
  QaWaiveOutcome,
  ReviewCommentBody,
  ReviewOutcome,
  ReviewVerdictBody,
  SendBackBody,
  SendBackOutcome,
  SessionPlanView,
  VerifyPreflight,
  WriteRequest,
  WriteResult,
} from '@shared/wire/plans.js';

export type {
  BatchGroup,
  BranchState,
  DecisionRowView,
  DiffFile,
  DiffHunk,
  DiffLine,
  DutyCycle,
  DutyUnknownReason,
  EngineQueue,
  Forecast,
  GateApprovalBody,
  GateApprovalOutcome,
  GateRead,
  GateStatus,
  HandoffBootPrompt,
  HandoffDetail,
  HandoffRow,
  HealthIssue,
  IsolationPreflight,
  LandingArtifact,
  LandingComposeBody,
  LandingComposeOutcome,
  LandingPacket,
  LandingView,
  LandingWindow,
  LintRead,
  LintResult,
  LockRelease,
  NoteKind,
  PhaseAnalysis,
  PhaseCost,
  PhaseDiff,
  PhaseHandoffRef,
  PhaseLock,
  PhaseNote,
  PhaseNotes,
  PhaseReview,
  PhaseReviewMark,
  PhaseRow,
  PhaseView,
  PlanActuals,
  PlanCost,
  PlanDetail,
  PlanFile,
  PlanGitHead,
  PlanList,
  PlanReviewer,
  PlanSizing,
  PlanSummary,
  PlanSummaryFull,
  PlanTextBody,
  PlanWork,
  QaActivateOutcome,
  QaModeAnswer,
  QaModeBody,
  QaModeSetOutcome,
  QaReportView,
  QaWaiveBody,
  QaWaiveOutcome,
  ReviewComment,
  ReviewCommentBody,
  ReviewOutcome,
  ReviewRecord,
  ReviewVerdict,
  ReviewVerdictBody,
  ReviewWindow,
  RouteNode,
  RouteView,
  SendBackBody,
  SendBackOutcome,
  SessionBudgetView,
  SessionPlanRead,
  SessionPlanView,
  VerifyPreflight,
  WriteRequest,
  WriteResult,
} from '@shared/wire/plans.js';

/** The plan surface's fetchers — merged into `api` by `./index`. */
export const plansApi = {
  plans: () => request<PlanList>('/api/plans'),
  /** The engine's lint, run again now — the plan page reads the cached verdict; this is the fresh one. */
  planLint: (slug: string) => request<LintResult | null>(`/api/plans/${q(slug)}/lint`),
  /** What is left: its weight, its phases, and the sessions it forecasts at this plan's budget. */
  planWork: (slug: string) => request<PlanWork>(`/api/plans/${q(slug)}/work`),

  /* ---- plans ----
     The prompt endpoints answer `text/plain`; `request` already returns a
     string for a non-JSON content type, so they are typed as one. */
  /**
   * One plan, projected. `include` names groups from `shared/projection.js`;
   * omitted, the server answers the board projection — 47.8 KB on the measured
   * 23-phase plan, against 286.5 KB for `include=full`.
   */
  /** The engine pool now — what a plan page whose own read is queued says while it waits (#44). */
  engineQueue: () => request<EngineQueue>('/api/engine'),
  plan: (slug: string, opts?: { model?: string; include?: Iterable<string> }) => {
    const params = new URLSearchParams();
    if (opts?.model) params.set('model', opts.model);
    const include = opts?.include ? includeParam(opts.include, PLAN_INCLUDES) : '';
    if (include) params.set('include', include);
    const query = params.toString();
    return request<PlanDetail>(`/api/plans/${q(slug)}${query ? `?${query}` : ''}`);
  },
  planRaw: (slug: string) => request<string>(`/api/plans/${q(slug)}/raw`),
  handoff: (slug: string, phase: number | string) =>
    request<HandoffDetail>(`/api/plans/${q(slug)}/handoff/${phase}`),
  prompt: (slug: string, phase: number | string) => request<string>(`/api/plans/${q(slug)}/prompt/${phase}`),
  nextPrompt: (slug: string, phase?: number | string) =>
    request<string>(`/api/plans/${q(slug)}/next-prompt/${phase ?? 'none'}`),
  qaPrompt: (slug: string, phase: number | string) =>
    request<string>(`/api/plans/${q(slug)}/qa-prompt/${phase}`),
  boardText: (slug: string) => request<string>(`/api/plans/${q(slug)}/board`),

  /* ---- landing ----
     GET is unflagged like the review's: which branch the work is on and
     whether it is anywhere else is display. POST composes the packet and is
     `--allow-writes`. Neither can push — see `server/landing.ts`. */
  landing: (slug: string) => request<LandingView>(`/api/plans/${q(slug)}/landing`),
  composeLanding: (slug: string, range?: LandingComposeBody) =>
    post<LandingComposeOutcome>(`/api/plans/${q(slug)}/landing`, range ?? {}),
  /* A plain href, not a fetch: the browser's own download machinery names the
     file from `content-disposition` and streams it to disk, which is the whole
     point of the packet. Each segment is encoded separately so a patch's
     `patches/0001-….patch` keeps its slash. */
  landingFileHref: (slug: string, name: string) =>
    `/api/plans/${q(slug)}/landing/${name.split('/').map(q).join('/')}`,
  memoryBlock: (slug: string) => request<string>(`/api/plans/${q(slug)}/memory-block`),
  gate: (slug: string, phase: number | string) => request<GateStatus>(`/api/plans/${q(slug)}/gate/${phase}`),
  approveGate: (slug: string, phase: number, body: GateApprovalBody) =>
    post<GateApprovalOutcome>(`/api/plans/${q(slug)}/gate/${phase}`, body),
  /* What earlier phases LEFT for this one — the same block its boot prompt
     carries, from the same engine arm. Unflagged and read-only: it reads a
     handoff, a rulings ledger and a messages ledger, all of which a console
     with no flags may already read. */
  notes: (slug: string, phase: number | string) =>
    request<PhaseNotes>(`/api/plans/${q(slug)}/notes/${phase}`),
  /* Read-only, and deliberately unflagged: looking at what a session changed
     is display, the same class as reading its handoff. */
  review: (slug: string, phase: number | string, range?: { base?: string; tip?: string }) => {
    const params = new URLSearchParams();
    if (range?.base) params.set('base', range.base);
    if (range?.tip) params.set('tip', range.tip);
    const query = params.toString();
    return request<PhaseReview>(`/api/plans/${q(slug)}/review/${phase}${query ? `?${query}` : ''}`);
  },
  /* `--allow-writes`, because `requested-changes` holds every dependent phase
     from boarding — a read-only console must not be able to stop a run. */
  setReview: (slug: string, phase: number, body: ReviewVerdictBody) =>
    post<ReviewOutcome>(`/api/plans/${q(slug)}/review/${phase}`, body),
  /* `--allow-writes` like the verdict: a comment cannot hold anything by
     itself, but Send back turns a comment set into a re-boarded phase. */
  commentOnReview: (slug: string, phase: number, body: ReviewCommentBody) =>
    post<ReviewOutcome>(`/api/plans/${q(slug)}/review-comment/${phase}`, body),
  /* `--allow-run`, not `--allow-writes`: this re-boards the phase, which
     spawns a session that edits the repository. The follow-up prompt is
     composed on the SERVER from the stored comments — this body names the
     phase and nothing else, so it cannot put words in front of a session. */
  sendBackReview: (slug: string, phase: number, body: SendBackBody = {}) =>
    post<SendBackOutcome>(`/api/plans/${q(slug)}/review-send-back/${phase}`, body),
  sessionPlan: (slug: string, model?: string) =>
    request<SessionPlanView | null>(`/api/plans/${q(slug)}/session-plan${model ? `?model=${q(model)}` : ''}`),
  /* Read-only and advisory: what boarding would find, per open phase. It costs
     the plan's own extractor plus a PATH lookup per lead — cheap, but not free,
     so it is its own request rather than a field on `detail()`. */
  verifyPreflight: (slug: string) => request<VerifyPreflight>(`/api/plans/${q(slug)}/verify-preflight`),
  isolationPreflight: (slug: string) =>
    request<IsolationPreflight>(`/api/plans/${q(slug)}/isolation-preflight`),
  write: (body: WriteRequest, dry?: boolean) => post<WriteResult>(`/api/write${dry ? '?dry=1' : ''}`, body),

  /* ---- stale claims ----
     The owner comes off the lock file on the server, so nothing here asks a
     person to retype `someone@example.com/opus-p2` from a card that never
     showed it. A live lease answers 409 and stays claimed. */
  /* `force` takes a claim whose lease is still running. That is the operator
     deciding another session is gone, and it is the only way past a live claim
     now that one blocks a run — so it is a separate argument, never a default,
     and every caller that passes it asks for confirmation first. */
  releaseLock: (slug: string, phase: number, force = false) =>
    post<LockRelease>('/api/locks/release', force ? { slug, phase, force } : { slug, phase }),
  releaseExpiredLocks: () =>
    post<{ results: LockRelease[]; released: number }>('/api/locks/release', { expired: true }),

  /**
   * Turn QA on for a plan that has it off.
   *
   * Write-class rather than agent-class: it creates `test-status.md` and
   * backfills the already-complete phases as waived, which is a change to the
   * repository whether or not a review is ever minted.
   */
  qaActivate: (slug: string, phase: number) =>
    post<QaActivateOutcome>(`/api/plans/${q(slug)}/qa-mode`, { phase }),
  /**
   * Set the QA regime — for the plan (no phase) or for one phase — through
   * `scripts/qa-mode.sh`. Write-class like `qaActivate`. The answer is what
   * the ENGINE reads back, not the directive echoed: with a ledger on disk a
   * written `off` reads as `waived`.
   */
  qaModeSet: (slug: string, request: { mode: 'on' | 'off' | 'inherit'; phase?: number }) =>
    post<QaModeSetOutcome>(`/api/plans/${q(slug)}/qa-mode`, request),
  /** The text of one QA report — the latest round when `round` is absent. */
  qaReport: (slug: string, phase: number, round?: number) =>
    request<QaReportView>(`/api/plans/${q(slug)}/qa-report/${phase}${round ? `?round=${round}` : ''}`),
  /**
   * Waive a recorded verdict with a reason — the third QA-recovery verb, and
   * the only one that starts nothing.
   *
   * Write-class for `qaActivate`'s reason and beside it for the same reason:
   * what it does is write one row of `test-status.md`, and a console that may
   * write but may not run must still be able to release a gate.
   */
  qaWaive: (slug: string, phase: number, reason: string) =>
    post<QaWaiveOutcome>(`/api/plans/${q(slug)}/qa-waive`, { phase, reason } satisfies QaWaiveBody),
};
