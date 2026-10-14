/**
 * Run requests (turn-by-turn phase 6, #286, §Architecture 5.1): an act only the
 * RUN can take — relaunch isolated, switch account, raise the budget, stop,
 * hold — asked by a phase. A session cannot press its own console
 * (`console-forge`), so a run-level ask declared as a permission reached nobody:
 * G5 refused it ("nothing refused this — run it"), its errand claimed a
 * permission item that did not exist, and Handled said the AI could run it.
 *
 *   - The declaration: `phase-outcome.sh … blocked --needs run --run-act <act>`
 *     (`RUN_ACTS`, `shared/verb-model.js`; bash twin `scripts/turn.env`).
 *   - The compatibility rule, from recorded facts, for plans that already ask
 *     through `permission.policy` (hub's "Autopilot contract item 1"): a
 *     `permission` declaration that names no rule and no command, on a run whose
 *     checkout is SHARED and whose lane's `PE_BRANCH` is not `pe/<slug>`, is an
 *     `isolate` request (`isolateCompat`).
 *   - The item: ONE approval per (run, act), the declaring phases its waiters
 *     (`runRequestTurnInput`, `isRunRequestOf`) — Approve takes the act, Deny
 *     resumes every waiter told no. In Pro the supervisor's `run-requested`
 *     remedy presses the reversible acts itself and the item settles as its.
 *
 * Pure: facts in, words and inputs out.
 */

import { subKindOfNeed } from '../../shared/decisions-model.js';
import { RUN_ACT_META, isRunAct, type RunAct } from '../../shared/verb-model.js';
import type { DeclareInput } from '../human-steps.ts';

/** The source kind a run request's ledger item carries; its `ref` is the act. */
export const RUN_REQUEST_SOURCE = 'run-request';

/** The two answers of a run request's approval. */
export const RUN_REQUEST_OPTIONS = Object.freeze(['approve', 'deny'] as const);
export type RunRequestAnswer = (typeof RUN_REQUEST_OPTIONS)[number];

/** The facts the compatibility rule reads — each one the console RECORDED, never a guess. */
export type CompatFacts = {
  slug: string;
  declared: { status?: string; needs?: string | null; rule?: string | null; command?: string | null } | null | undefined;
  /** The run's checkout is the shared one: `RunState.checkout !== 'worktree'` and the lane has no worktree of its own. */
  shared: boolean;
  /** The branch the lane's `PE_BRANCH` named (the claim's qualification), when it named one. */
  branch: string | null | undefined;
};

/**
 * The compatibility rule (§Architecture 5.1): a `blocked` permission declaration
 * — `--needs permission` or `permission.policy` — that names no rule and no
 * command, on a shared checkout whose lane's branch is not `pe/<slug>`, is an
 * `isolate` request. A declaration naming a rule or a command cites a wall,
 * and stays a permission ask (G5 judges it).
 */
export function isolateCompat(facts: CompatFacts): boolean {
  const d = facts.declared;
  if (!d || d.status !== 'blocked') return false;
  if (subKindOfNeed(d.needs ?? undefined) !== 'permission') return false;
  if ((d.rule ?? '').trim() || (d.command ?? '').trim()) return false;
  if (!facts.shared) return false;
  return (facts.branch ?? '') !== `pe/${facts.slug}`;
}

/** The act a declared record asks the run for, or null — `needs: run` with a known act. */
export function runActOf(declared: { needs?: string | null; runAct?: string | null } | null | undefined): RunAct | null {
  if (!declared || declared.needs !== 'run') return null;
  return isRunAct(declared.runAct) ? declared.runAct : null;
}

/** Is this ledger step a run request — and for which act? */
export function isRunRequestOf(step: { birth?: string; source?: { kind: string; ref?: string } }): RunAct | null {
  if (step.birth !== 'console' || step.source?.kind !== RUN_REQUEST_SOURCE) return null;
  return isRunAct(step.source.ref) ? step.source.ref : null;
}

/** "Phase 3", or "Phases 3, 4 and 5" — who asked. */
export function phasesWords(phases: readonly number[]): string {
  const list = [...new Set(phases)].sort((a, b) => a - b);
  if (list.length <= 1) return `Phase ${list[0] ?? '?'}`;
  return `Phases ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The ONE approval a run request is (Free, and Pro when the supervisor does
 * not take it): a decision with two options, Approve recommended, proven by the
 * answer. `reason` is the phase's own words; `compat` says the console read it
 * from a permission declaration.
 */
export function runRequestTurnInput(
  at: { slug: string; phase: number; runId: string; sessionId?: string },
  act: RunAct, reason: string | null | undefined, compat = false,
): DeclareInput {
  const meta = RUN_ACT_META[act];
  const said = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'decision', title: meta.title, why: 'decision', proof_type: 'answer',
      lines: [
        `Phase ${at.phase} asked the run for this — a session cannot take an act of the run itself.`,
        ...(said ? [`It said: "${said}"`] : []),
        ...(compat ? ['It declared a permission block naming no rule or command on a shared checkout — read as a request to run isolated.'] : []),
        `Approve: ${meta.ifApproved}`,
        `Deny: ${meta.ifDenied}`,
      ],
      options: [
        { id: 'approve', label: 'Approve', consequence: meta.ifApproved },
        { id: 'deny', label: 'Deny', consequence: meta.ifDenied },
      ],
      recommended: 'approve',
      source: { kind: RUN_REQUEST_SOURCE, ref: act },
    },
  };
}

/** The approval block of a run request's item — what, who asked, and what each answer does. */
export function runRequestApproval(act: RunAct, phases: readonly number[]): {
  what: string; askedBy: string; ifApproved: string; ifDenied: string;
} {
  const meta = RUN_ACT_META[act];
  return { what: meta.title, askedBy: phasesWords(phases), ifApproved: meta.ifApproved, ifDenied: meta.ifDenied };
}

/** What a waiting phase is told when its run request is answered. */
export function runRequestInstruction(act: RunAct, answer: RunRequestAnswer, by: string, note?: string): string {
  const meta = RUN_ACT_META[act];
  const noted = note ? ` They said: "${note.slice(0, 300)}".` : '';
  if (answer === 'approve') {
    return `Your run request was approved by ${by}: ${meta.title.toLowerCase()}. ${meta.ifApproved}${noted} `
      + 'Carry on with the phase from the handoff and the tree as they stand; do not ask for it again.';
  }
  return `Your run request was denied by ${by}: ${meta.title.toLowerCase()} will not happen.${noted} `
    + 'Do not ask again. Carry on without it inside the plan, or hand off blocked naming exactly what remains.';
}
