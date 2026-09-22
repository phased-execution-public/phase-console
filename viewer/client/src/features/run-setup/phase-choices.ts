/**
 * What one phase will run as, field by field, and where the plan and this run
 * disagree about it — read BEFORE the launch (autopilot-token-drain phase 5).
 *
 * Run `deadaff9`'s plan asked `high` for its four hardest phases, under a run
 * default of `max`. The per-phase table showed `high (plan)` inside a closed
 * disclosure whose summary said every phase inherited the run, so nothing on the
 * form said the plan's word sat BELOW the default, and the four phases went on
 * to run at `max` by an explicit choice nobody was warned about.
 *
 * The value itself is never computed here: `resolvePhaseChoice` and the plan
 * readers are the runner's own (`shared/run-settings.js`), so this module only
 * decides what to SAY about them.
 */

import {
  planEffortOf,
  planModelOf,
  resolvePhaseChoice,
  type PhaseChoiceSource,
} from '@shared/run-settings.js';
import { EFFORTS } from '@/features/runs/defaults';
import type { PhaseOptions, PhaseView } from '@/lib/api';

export type ChoiceField = 'model' | 'effort';

export interface PhaseChoice {
  value: string | undefined;
  source: PhaseChoiceSource | undefined;
}

/**
 * How each level reads on this form. `run` is the runner's word for a choice
 * made in THIS table for this run, so it reads "set here" — the run's default is
 * `default`, and calling it "run" too is how one label came to mean both.
 */
export const SOURCE_LABEL: Readonly<Record<PhaseChoiceSource, string>> = Object.freeze({
  retry: 'this attempt',
  run: 'set here',
  plan: 'plan',
  default: 'run default',
});

/** One sentence about one field of one phase where the plan and this run disagree. */
export interface ChoiceNote {
  phase: number;
  field: ChoiceField;
  kind: 'plan-differs' | 'choice-replaces-plan';
  text: string;
}

const PLAN_READER: Readonly<Record<ChoiceField, (text: string | undefined) => string | undefined>> = {
  model: planModelOf,
  effort: planEffortOf,
};

/** What the plan's own bullet asks for this field, read the way the runner reads it. */
export function planChoice(p: PhaseView, field: ChoiceField): string | undefined {
  return PLAN_READER[field](p[field]);
}

/** What `p` will run as for `field`: this table's choice, then the plan, then the run default. */
export function phaseChoice(
  p: PhaseView,
  own: PhaseOptions,
  field: ChoiceField,
  runDefault: string,
): PhaseChoice {
  return resolvePhaseChoice({ run: own[field], plan: planChoice(p, field), fallback: runDefault });
}

/** `below` or `above`, in the order the CLI's effort levels are offered. */
function relativeEffort(asked: string, other: string): 'below' | 'above' {
  const rank = (level: string) => (EFFORTS as readonly string[]).indexOf(level);
  return rank(asked) < rank(other) ? 'below' : 'above';
}

/**
 * Every place the plan and this run disagree about a phase that has not run yet.
 *
 * Two shapes, and a field gets at most one: a choice made here that replaces a
 * different plan value, or — with no choice here — a plan value that differs
 * from the run's default (the plan wins that one, which is the part worth
 * saying). A done phase is skipped: nothing on this form changes what it ran as.
 */
export function choiceNotes(
  phases: readonly PhaseView[],
  overrides: Readonly<Record<string, PhaseOptions>>,
  run: { model: string; effort: string },
): ChoiceNote[] {
  const notes: ChoiceNote[] = [];
  for (const p of phases) {
    if (p.state === 'done') continue;
    const own = overrides[String(p.phase)] ?? {};
    for (const field of ['model', 'effort'] as const) {
      const asked = planChoice(p, field);
      if (!asked) continue;
      const chosen = own[field];
      if (chosen) {
        if (chosen !== asked) {
          notes.push({
            phase: p.phase,
            field,
            kind: 'choice-replaces-plan',
            text: `Phase ${p.phase}: ${field} ${chosen} chosen here replaces the plan's ${asked}.`,
          });
        }
        continue;
      }
      const fallback = run[field];
      if (!fallback || fallback === asked) continue;
      const relation = field === 'effort' ? relativeEffort(asked, fallback) : 'not';
      notes.push({
        phase: p.phase,
        field,
        kind: 'plan-differs',
        text:
          `Phase ${p.phase}: the plan asks ${field} ${asked}, ${relation} the run default ${fallback}` +
          ` — the plan wins, so phase ${p.phase} runs ${asked}.`,
      });
    }
  }
  return notes;
}
