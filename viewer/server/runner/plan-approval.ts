/**
 * A plan-mode phase hands its plan to a person (control-tower phase 11, #34).
 *
 * The CLI's `ExitPlanMode` is how a session in `--permission-mode plan` says
 * "here is what I will do" — its input is `{plan, planFilePath}` — and under
 * autopilot nothing used to receive it. The console's hook now holds it
 * (`PLAN_CLASS`, `Service.holdPlan`): the text is captured under the run's
 * directory, `phase.plan-presented {bytes, sha}` is journalled, and the plan's
 * `plan-approval` decision answers — `continue` lets the console approve it,
 * `hold` (the default) parks the phase for a person.
 *
 * The park is DECLARED, not improvised: the console writes the session's
 * outcome on its behalf — `needs-human --needs plan-approval` — into the very
 * file `phase-outcome.sh` writes. So the Stop hook lets the turn end (an
 * outcome is declared), the ordinary declared-outcome path parks the phase
 * with the halt kind `plan-approval` and files the errand, and all of it is
 * restart-safe for the reason every declared park already is. Approve resumes
 * the SAME session through the recover verb, whose spawn runs `acceptEdits`.
 *
 * Measured, not assumed (spike `test/fixtures/spikes/exit-plan-mode.json`, CLI
 * 2.1.280): the tool exists only for a session with a permission host, a deny
 * reaches the model as a tool error and the session ends its turn at once, and
 * `--resume <same id> --permission-mode acceptEdits` carries the plan out.
 *
 * Pure helpers here; the runner and the service own the effects.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { runDir } from './state.ts';

/** The largest plan the console keeps, in bytes. A plan is a page, not a transcript. */
export const PLAN_MAX_BYTES = 512 * 1024;

/**
 * How long a session may go on after its plan was held before the console
 * interrupts it through the signal ladder. The measured session ended its turn
 * at once; this is the backstop for one that keeps working instead.
 */
export const PLAN_HOLD_GRACE_MS = 90_000;

/** The `--needs` word the console declares a held plan with — the decision key. */
export const PLAN_APPROVAL_NEED = 'plan-approval';

/** What `ExitPlanMode` carried: the plan and where the CLI wrote it. */
export type PresentedPlan = { text: string; planFilePath?: string };

/** A plan the console captured: its digest, its size and where the text lives. */
export type PlanPresented = { sha: string; bytes: number; path: string; truncated: boolean };

/** The two answers a person gives a held plan. */
export const PLAN_DECISIONS = Object.freeze(['approve', 'reject'] as const);
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

/** `ExitPlanMode`'s input as a plan, or null when it carries none. */
export function planOf(input: unknown): PresentedPlan | null {
  const record = input as { plan?: unknown; planFilePath?: unknown } | null;
  if (typeof record?.plan !== 'string' || !record.plan.trim()) return null;
  return {
    text: record.plan,
    ...(typeof record.planFilePath === 'string' && record.planFilePath ? { planFilePath: record.planFilePath } : {}),
  };
}

/** The plan's text as it is kept — bounded to `PLAN_MAX_BYTES`, never mid-character. */
export function boundedPlan(text: string): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= PLAN_MAX_BYTES) return { text, truncated: false };
  // `toString` drops an incomplete trailing sequence to U+FFFD; trimming it
  // keeps the kept file honest UTF-8 that ends where the plan was cut.
  return { text: buffer.subarray(0, PLAN_MAX_BYTES).toString('utf8').replace(/�+$/, ''), truncated: true };
}

/** The sha256 of the plan AS PRESENTED — what the journal and the inbox name it by. */
export function planDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Where one presented plan's text is kept: beside the run's outcome files. */
export function planTextFile(root: string, slug: string, runId: string, phase: number, sha: string): string {
  return join(runDir(root, slug), `run-${runId}-p${phase}-plan-${sha.slice(0, 12)}.md`);
}

/**
 * The declaration the console writes on the session's behalf — the shape
 * `readOutcome` accepts, so the park it produces is the one a session's own
 * `phase-outcome.sh … needs-human --needs plan-approval` would have produced.
 */
export function planHoldOutcome(opts: {
  slug: string; phase: number; sha: string; bytes: number; sessionId?: string; now?: Date;
}): Record<string, unknown> {
  return {
    version: 1,
    slug: opts.slug,
    phase: opts.phase,
    status: 'needs-human',
    needs: PLAN_APPROVAL_NEED,
    reason: `the session presented its plan (${opts.bytes} bytes, sha ${opts.sha.slice(0, 12)}) and a person `
      + 'decides it: Approve resumes this session in acceptEdits to carry it out, Reject records why',
    watch: [],
    written_at: (opts.now ?? new Date()).toISOString(),
    ...(opts.sessionId && /^[A-Za-z0-9._-]{1,128}$/.test(opts.sessionId) ? { session_id: opts.sessionId } : {}),
  };
}

/**
 * What the hook tells the session when its plan is held. Worded against what
 * the model does with a deny: it says whose decision this is, that nothing was
 * refused, and the one thing to do — end the turn. The measured session read a
 * plainer deny and did exactly that; this one also stops it declaring twice.
 */
export function planHeldReason(presented: PlanPresented): string {
  return `The console has captured your plan (${presented.bytes} bytes, sha ${presented.sha.slice(0, 12)}) and `
    + 'handed it to a person for approval. This is NOT a rejection of the plan or of your work. Do not call '
    + 'ExitPlanMode again, do not start the work, and do not declare an outcome — the console has declared '
    + 'this one for you. End your turn now: you will be resumed in this same session when the plan is decided.';
}

/** What the hook tells the session when the plan's `plan-approval: continue` answers for a person. */
export function planContinueReason(presented: PlanPresented): string {
  return `The plan (sha ${presented.sha.slice(0, 12)}) is approved by this plan's own decision `
    + '(plan-approval: continue) and kept in the run journal as the record of what you said you would do. '
    + 'Carry it out.';
}

/** The instruction Approve resumes the session with. */
export function planApprovedInstruction(by: string, presented: { sha: string }): string {
  return `Your plan (sha ${presented.sha.slice(0, 12)}) was approved by ${by}. You are no longer in plan mode: `
    + 'this session now runs in acceptEdits. Carry the plan out as you presented it, then finish the phase as '
    + 'you normally would — verification, commit, handoff.';
}
