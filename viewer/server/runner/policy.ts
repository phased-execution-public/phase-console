/**
 * The runner's and the healer's one reading of the policy table (phase 11,
 * ZTD-10/QRL-3): which manifest row a situation belongs to and what answer is
 * in force for it — the run's own manifest first (the plan's `## Decisions`
 * and its twin as the door resolved them), then this console's `policy.<key>`
 * preference, then the shipped default (`shared/policy-model.js`).
 *
 * A leaf on purpose: `runner.ts`, `service-recovery.ts` and `converge.ts`
 * all ask the same question about a stored run, and three private copies of
 * the resolution order would be the drift this file exists to prevent.
 */

import {
  decisionKeyOfSituation, resolvePolicy, type PolicyInputs, type ResolvedPolicy,
} from '../../shared/policy-model.js';
import type { DecisionKey } from '../../shared/decisions-model.js';
import type { RunState } from './state.ts';

/** This console's policy preferences, as `resolvePolicy` reads them. */
export type PolicyPrefs = NonNullable<PolicyInputs['prefs']>;

/**
 * The slice of the console's preferences the resolver reads — the `policy`
 * overrides and the one legacy switch that IS the `gates` answer.
 */
export function policyPrefsOf(prefs: { policy?: Readonly<Record<string, unknown>> | null; delegateHumanGates?: unknown } | null | undefined): PolicyPrefs {
  return { policy: prefs?.policy ?? null, delegateHumanGates: prefs?.delegateHumanGates };
}

/** The run's own answers, which outrank the plan and the console for their keys. */
function runAnswers(state: Pick<RunState, 'resumeOnRestart' | 'relay'> | null | undefined): PolicyInputs['run'] {
  if (!state) return null;
  return { resumeOnRestart: state.resumeOnRestart ?? null, relay: state.relay ?? null };
}

/** The answer in force for a decision key on this run. */
export function policyForKey(
  key: DecisionKey,
  state: Pick<RunState, 'manifest' | 'resumeOnRestart' | 'relay'> | null | undefined,
  prefs: PolicyPrefs | null | undefined,
): ResolvedPolicy | null {
  return resolvePolicy(key, {
    plan: state?.manifest?.decisions ?? [],
    prefs: prefs ?? null,
    run: runAnswers(state),
  });
}

/**
 * The answer in force for a key on a PLAN with no run yet — the plan's rows
 * (with the twin merged over them) and the console's word; what the classifier
 * and the prelude read before a run exists.
 */
export function policyForPlan(
  key: DecisionKey,
  rows: readonly { key: string; state: string; value: string }[],
  prefs: PolicyPrefs | null | undefined,
): ResolvedPolicy | null {
  return resolvePolicy(key, { plan: rows, prefs: prefs ?? null, run: null });
}

/** The answer in force for the manifest row a situation belongs to. */
export function policyForSituation(
  situationKey: string,
  state: Pick<RunState, 'manifest' | 'resumeOnRestart' | 'relay'> | null | undefined,
  prefs: PolicyPrefs | null | undefined,
): ResolvedPolicy | null {
  return policyForKey(decisionKeyOfSituation(situationKey), state, prefs);
}
