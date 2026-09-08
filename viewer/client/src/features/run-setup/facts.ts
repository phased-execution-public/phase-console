/**
 * What the launch knows about the PLAN — the facts the stages and the review
 * show beside the form's values, read from the board this console already
 * holds.
 *
 * `usePlan(slug)` with no include is the board projection: the key every
 * plan page and the palette already read, so opening the launch dialog from
 * the run page costs no request. The verify-preflight is its own read (the
 * plan's health panel asks for the same key, and it is cheap but not free);
 * a server that predates the endpoint answers nothing, and nothing is what
 * the review then shows — never a claim that the plan is clean.
 */

import type { BatchGroup, PhaseLock, PhaseView, PlanDetail, PreflightWarning } from '@/lib/api';
import { usePlan, useVerifyPreflight } from '@/lib/queries';
import { useSetupForm } from './form-context';
import { resumeTarget } from './modes';
import { parsePhases } from './schema';

/** Who clears a gate — the gate's category, in a sentence. */
export function gateWho(phase: PhaseView): string | null {
  if (!phase.gated) return null;
  switch (phase.gateKind) {
    case 'human':
      return 'a person approves it';
    case 'ai':
      return 'the session clears it at boarding';
    case 'auto':
      return 'checked at boarding';
    default:
      return 'gated';
  }
}

/** A live claim on the phase — a lapsed one blocks nothing and is not returned. */
export function liveClaim(phase: PhaseView): PhaseLock | undefined {
  return phase.lock && !phase.lock.expired ? phase.lock : undefined;
}

export interface LaunchFactsView {
  slug: string | undefined;
  detail: PlanDetail | undefined;
  /** Every phase the board knows — from the detail when it has arrived, else what the caller passed. */
  phases: PhaseView[];
  /** The typed scope, when it parses. */
  scoped: number[] | undefined;
  /** Ready now, on the board. */
  ready: PhaseView[];
  /** What this launch will board first: the scope when there is one, the phase for a phase launch, else the ready set. */
  willRun: PhaseView[];
  /** Phases that will hold at a gate, among what will run — or among every open phase when unscoped. */
  gated: PhaseView[];
  /** Phases with a live claim this run would queue behind. */
  claimed: PhaseView[];
  batches: BatchGroup[];
  budget: string | undefined;
  resumeRunId: string | undefined;
  /** Boarding-preflight findings for the phases in play. `undefined` = the server could not say. */
  warnings: { phase: number; warnings: PreflightWarning[] }[] | undefined;
}

export function useLaunchFacts(): LaunchFactsView {
  const f = useSetupForm();
  const slug = f.context.slug;
  const { data: detail } = usePlan(slug);
  const { data: preflight } = useVerifyPreflight(slug);
  const phases = detail?.phases ?? f.planPhases;
  const scoped =
    f.mode === 'phase' && f.context.phase != null ? [f.context.phase] : parsePhases(f.values.onlyPhases);
  const open = phases.filter((p) => p.state !== 'done');
  const ready = phases.filter((p) => p.state === 'ready');
  const inScope = (p: PhaseView) => !scoped || scoped.includes(p.phase);
  const willRun = scoped ? open.filter(inScope) : ready;
  const considered = scoped ? willRun : open;
  const gated = considered.filter((p) => p.gated);
  const claimed = considered.filter((p) => liveClaim(p));
  const resumeRunId = f.mode === 'live' ? undefined : resumeTarget(f.mode, f.context.run ?? null);
  const warnings = preflight?.phases.filter((entry) => !scoped || scoped.includes(entry.phase));
  return {
    slug,
    detail,
    phases,
    scoped,
    ready,
    willRun,
    gated,
    claimed,
    batches: detail?.batches?.groups ?? [],
    budget: detail?.batches?.budget,
    resumeRunId,
    warnings,
  };
}
