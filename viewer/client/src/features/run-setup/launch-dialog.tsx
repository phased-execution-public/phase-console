/**
 * The dialog around `RunSetup` — banners, heading, and the claim that refuses.
 *
 * Every field, every seed and every payload moved into `features/run-setup` in
 * Phase 6. What is left here is what is genuinely a DIALOG's: the words at the
 * top, the three banners a launch needs before its fields (a live claim, a
 * lapsed one, a verdict already recorded), and the mapping from the
 * `LaunchRequest` its callers already build onto a RunSetup mode.
 *
 * Since Phase 8 the overlay itself is the form's (`RunSetup`'s `overlay`
 * prop → `launch-shell.tsx`): a `phase` launch gets the four-stage flow, a QA
 * review or a recovery the framed flat form with its buttons fixed under a
 * scrolling body. `launch-dialog.test.tsx` and `qa-launcher.test.tsx` still
 * assert the field matrix and the verbatim submit payloads through this
 * component, so the surface stays the refactor's guard.
 */

import { useQuery } from '@tanstack/react-query';
import { Banner } from '@/components/ui';
import { api, type PhaseLock, type PlanReviewer, type RunState } from '@/lib/api';
import { keys } from '@/lib/queries';
import { countdown, relativeTime } from '@/lib/format';
import { ReleaseStaleButton } from '@/components/release-lock';
import { isVerdict } from '@/lib/qa';
import { RECOVERY_BLURBS, RECOVERY_LABELS, type RecoveryClass } from '@/lib/recovery';
import { RunSetup } from '@/features/run-setup/run-setup';
import type { RunSetupMode } from '@/features/run-setup/modes';
import { headingFor } from './stages';

/** What the phase itself asks for, when the plan says. Mirrors the runner's resolution. */
export interface QaTarget {
  slug: string;
  phase: number;
  title?: string;
  /** The plan's `**Model:**` for this phase, when it names one. */
  model?: string;
  effort?: string;
  /** `off` turns the activation checkbox on. */
  qaMode?: string;
  /** The verdict already recorded for this phase, when there is one. */
  qa?: { result: string; report?: string };
  /** Skills the plan asks every session to invoke. */
  planSkills?: string[];
  planMcp?: string[];
}

export type LaunchRequest =
  | {
      kind: 'recovery';
      recoveryClass: RecoveryClass;
      slug: string;
      phase?: number;
      runId?: string;
      lock?: PhaseLock;
    }
  | {
      kind: 'phase';
      slug: string;
      phase: number;
      run: RunState | null;
      qaMode?: string;
      allowWrites?: boolean;
      planSkills?: string[];
      planMcp?: string[];
      /** Where the plan orders its own reviewer — the doubled-review advisory reads it. */
      planReviewers?: PlanReviewer[];
      /** Who holds this phase, if anyone. Decides whether this dialog may submit. */
      lock?: PhaseLock;
    }
  | {
      kind: 'continue';
      slug: string;
      run: RunState;
      qaMode?: string;
      allowWrites?: boolean;
      planSkills?: string[];
      planMcp?: string[];
      planReviewers?: PlanReviewer[];
    }
  | { kind: 'qa'; target: QaTarget; allowWrites?: boolean; lock?: PhaseLock }
  /**
   * Fix & re-QA (issue #11) — the same target as a review, a different act.
   *
   * `qa` opens ONE reviewer over finished work; `qa-fix` opens the LOOP that
   * answers a recorded verdict: a fix session carrying the last report's
   * findings, then a review, round after round. They share `QaTarget` because
   * they are about the same phase and the same recorded row, and they are two
   * kinds because everything else about them differs — the door, the field set,
   * the money, and whether anything writes to the tree.
   */
  | { kind: 'qa-fix'; target: QaTarget; allowWrites?: boolean; lock?: PhaseLock };

/**
 * The claim standing between this dialog and its Start button.
 *
 * A `continue` names no phase — it picks the run up wherever it is, and the
 * runner's own boarding check parks whatever it finds claimed — so it has no
 * lock to read. Every other kind names exactly one phase, and for those a live
 * claim is a refusal rather than a warning: the server answers 409 now, and a
 * dialog that submits into a 409 is a dialog that lied about what its button
 * would do.
 */
function claimOn(request: LaunchRequest): PhaseLock | undefined {
  return request.kind === 'continue' ? undefined : request.lock;
}

/** Which phase this launch is about, when it is about one. */
function phaseOfRequest(request: LaunchRequest): number | undefined {
  return request.kind === 'qa' || request.kind === 'qa-fix'
    ? request.target.phase
    : request.kind === 'continue'
      ? undefined
      : request.phase;
}

function slugOfRequest(request: LaunchRequest): string {
  return request.kind === 'qa' || request.kind === 'qa-fix' ? request.target.slug : request.slug;
}

/**
 * The words at the top. A recovery is named by its class — "Repair the plan
 * with a new agent" says what will happen — and everything else by the mode's
 * own heading in `stages.ts`, which is the one table a new mode adds to.
 */
function heading(request: LaunchRequest): { title: string; description: string } {
  if (request.kind === 'recovery') {
    return {
      title: RECOVERY_LABELS[request.recoveryClass],
      description: RECOVERY_BLURBS[request.recoveryClass],
    };
  }
  return headingFor(request.kind, { phase: phaseOfRequest(request) });
}

export function LaunchDialog({
  request,
  onClose,
  onDone,
}: {
  request: LaunchRequest;
  onClose: () => void;
  /** Called after a successful submit, once the dialog's own bookkeeping ran. */
  onDone?: (sessionId?: string) => void;
}) {
  const { title, description } = heading(request);
  // The one fact from `/api/state` this dialog needs: an `openPr` run WILL stop
  // for an approval tap, and push is the only thing that says a card is up.
  const state = useQuery({ queryKey: keys.state(), queryFn: api.state });
  const pushBroken = (state.data?.environment?.issues ?? []).some((i) => i.kind === 'push-broken');
  const claim = claimOn(request);
  // A live claim refuses; a lapsed one does not. The server agrees with both,
  // so this is the same rule shown early rather than a second, softer one.
  const blocked = Boolean(claim && !claim.expired);
  const qaTarget = request.kind === 'qa' ? request.target : null;
  const mode: RunSetupMode = request.kind;

  return (
    <RunSetup
      mode={mode}
      context={contextFor(request)}
      {...(request.kind === 'qa' || request.kind === 'qa-fix'
        ? { qaMode: request.target.qaMode }
        : request.kind !== 'recovery'
          ? { qaMode: request.qaMode }
          : {})}
      {...(request.kind !== 'recovery' && request.allowWrites !== undefined
        ? { allowWrites: request.allowWrites }
        : {})}
      planSkills={planSkillsOf(request)}
      planMcp={planMcpOf(request)}
      planReviewers={planReviewersOf(request)}
      pushBroken={pushBroken}
      blocked={blocked}
      {...(blocked ? { blockedReason: 'The claim has to be released before a session can start here.' } : {})}
      footerNote={
        request.kind === 'qa'
          ? 'The session records the verdict, not the console.'
          : request.kind === 'qa-fix'
            ? 'Each round is one session: it fixes what the report named and dispatches the reviewer itself.'
            : 'Opens with the Automation defaults from Settings; this launch overrides them.'
      }
      overlay={{
        open: true,
        onOpenChange: (next) => {
          if (!next) onClose();
        },
        title,
        description,
      }}
      onDone={(sessionId) => {
        onDone?.(sessionId);
        onClose();
      }}
    >
      {qaTarget?.title && (
        <p className="mb-3 text-sm text-ink-muted">
          <span className="font-mono text-2xs text-ink-muted">{qaTarget.slug}</span> · {qaTarget.title}
        </p>
      )}

      {/* The refusal, before the fields rather than after them. A live
          claim disables Start, so a person who reads top-down learns why
          the button is grey before they reach it. */}
      {claim && !claim.expired && (
        <Banner severity="error" className="mb-3">
          <strong>
            Phase {phaseOfRequest(request)} is claimed by <span className="font-mono">{claim.owner}</span>
            {claim.host ? (
              <>
                {' '}
                on <span className="font-mono">{claim.host}</span>
              </>
            ) : null}
            .
          </strong>{' '}
          {claim.claimedAt ? `Claimed ${relativeTime(claim.claimedAt)}` : 'Claimed'}
          {claim.leaseUntil ? `, and the lease runs ${countdown(claim.leaseUntil)} more` : ''}. Booting a
          second session into this phase is how two agents overwrite each other. Wait for that session, or
          release the claim from the phase's row.
        </Banner>
      )}

      {claim?.expired && (
        <Banner severity="warn" className="mb-3">
          A claim by <span className="font-mono">{claim.owner}</span> lapsed on this phase — the session
          holding it stopped renewing, so nothing is working here. It does not block this launch; releasing it
          just tidies the board.
          <span className="mt-2 block">
            <ReleaseStaleButton
              slug={slugOfRequest(request)}
              phase={phaseOfRequest(request) ?? 0}
              label="Release it"
            />
          </span>
        </Banner>
      )}

      {qaTarget?.qa && isVerdict(qaTarget.qa.result) && (
        <Banner severity={qaTarget.qa.result === 'fail' ? 'warn' : 'info'} className="mb-3">
          This phase already records <strong>{qaTarget.qa.result}</strong>
          {qaTarget.qa.report ? <> ({qaTarget.qa.report})</> : null}. The session is told to read that report
          first and judge the phase as it stands now.
        </Banner>
      )}
    </RunSetup>
  );
}

/** What the form needs to know that is not a field: the run, the phase, the target. */
function contextFor(request: LaunchRequest) {
  switch (request.kind) {
    case 'recovery':
      return {
        slug: request.slug,
        recoveryClass: request.recoveryClass,
        ...(request.phase != null ? { phase: request.phase } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
      };
    case 'phase':
      return { slug: request.slug, phase: request.phase, run: request.run };
    case 'continue':
      return { slug: request.slug, run: request.run };
    // The loop, not the review: no activation checkbox (a plan whose gate is
    // off has no verdict to recover), and the recorded row rides along so the
    // form can say which report it is answering.
    case 'qa-fix':
      return {
        slug: request.target.slug,
        phase: request.target.phase,
        ...(request.target.qa?.result ? { qaVerdict: request.target.qa.result } : {}),
        ...(request.target.qa?.report ? { qaReport: request.target.qa.report } : {}),
        ...(request.target.planSkills ? { planSkills: request.target.planSkills } : {}),
      };
    case 'qa':
      return {
        slug: request.target.slug,
        phase: request.target.phase,
        // The activation checkbox is offered only where turning the gate on can
        // actually be done, and it opens ticked — the operator asked for a
        // review on a plan that gates nothing, which is usually the point.
        activate: request.target.qaMode === 'off' && request.allowWrites !== false,
        ...(request.target.model ? { qaModel: request.target.model } : {}),
        ...(request.target.effort ? { qaEffort: request.target.effort } : {}),
        ...(request.target.planSkills ? { planSkills: request.target.planSkills } : {}),
      };
  }
}

function planSkillsOf(request: LaunchRequest): string[] {
  if (request.kind === 'qa' || request.kind === 'qa-fix') return request.target.planSkills ?? [];
  if (request.kind === 'recovery') return [];
  return request.planSkills ?? [];
}

function planMcpOf(request: LaunchRequest): string[] {
  if (request.kind === 'qa' || request.kind === 'qa-fix') return request.target.planMcp ?? [];
  if (request.kind === 'recovery') return [];
  return request.planMcp ?? [];
}

/** Only the two kinds that offer Review each phase carry the plan's own reviewer. */
function planReviewersOf(request: LaunchRequest): PlanReviewer[] {
  return request.kind === 'phase' || request.kind === 'continue' ? (request.planReviewers ?? []) : [];
}
