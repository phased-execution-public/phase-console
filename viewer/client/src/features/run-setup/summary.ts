/**
 * The review, as data — what a launch will do, in the operator's words.
 *
 * Pure on purpose. The review stage renders these; the desktop ticket pane
 * renders a shorter cut of the same; `summary.test.ts` asserts them without a
 * DOM. Every sentence here is composed from the same values the payload is
 * built from, so the review cannot describe a different run from the one
 * `buildRunPayload` sends.
 *
 * Two questions, answered separately because they are different:
 *
 * - **What is notable?** A row is listed when its value differs from what a
 *   fresh console ships with (`BASELINE`), OR the operator changed it here —
 *   a value changed BACK to the default is still a decision worth a line.
 *   A preference is therefore listed (it changed the default; it says "from
 *   Settings"), and an untouched default is not.
 * - **Where does it stop?** The stop conditions are read off the values into
 *   plain clauses, so "no ceiling" is said rather than left as an empty box.
 */

import { money } from '@/lib/format';
import { EFFORT_NOTE, MODEL_NOTE } from '@/features/runs/defaults';
import { PRIORITY_LABELS } from '@shared/orchestration-model.js';
import { QA_FIX_STRATEGY_LABELS } from '@shared/run-settings.js';
import { ISOLATED, SETTLE_LABELS } from '@shared/worktree-model.js';
import type { Source } from './fields';
import { sourceOf } from './fields';
import type { RunSetupContext, RunSetupMode } from './modes';
import { MODES, buildRunPayload } from './modes';
import type { RunSetupField, RunSetupValues } from './schema';
import { WIRE, parsePhases } from './schema';
import { BASELINE, type Origins } from './seed';
import { FIELD_LABELS, STAGE_OF, isLive, type ControlStage } from './stages';

/** The words the review needs that the form owns — passed in, never re-declared here. */
export interface NameSources {
  /** The profile's short name — `Guarded`, `Trusted`, `Bypass` — from the one label table. */
  permission: (value: string) => string;
  /** Who an account id is, or `auto`. */
  account: (id: string) => string;
}

export interface SummaryRow {
  field: RunSetupField;
  stage: ControlStage;
  label: string;
  /** The value as a person reads it. */
  value: string;
  source: Source;
  /** Equal to what a fresh console ships with. */
  baseline: boolean;
  /**
   * Whether the control this row describes is on screen right now.
   *
   * A row can be true and still not be editable HERE: `reviewerPolicy` reaches
   * the payload through the cloud reviewer as well as the per-phase one, and
   * `mcpPolicy` is always posted while its control appears only where servers
   * are in play. Those values are real and belong in the review; what they must
   * not carry is a "Change" link into a stage where the control is not drawn.
   */
  live: boolean;
}

/** How a value reads — one place, so the ticket and the review agree. */
export function valueText(field: RunSetupField, values: RunSetupValues, names: NameSources): string {
  const v = values[field];
  switch (field) {
    case 'model':
      return values.model ? (MODEL_NOTE[values.model] ?? values.model) : 'this machine’s default';
    case 'effort':
      return values.effort ? (EFFORT_NOTE[values.effort] ?? values.effort) : 'this machine’s default';
    case 'qaModel':
      return values.qaModel
        ? (MODEL_NOTE[values.qaModel] ?? values.qaModel)
        : 'same as the phase being reviewed';
    case 'qaEffort':
      return values.qaEffort
        ? (EFFORT_NOTE[values.qaEffort] ?? values.qaEffort)
        : 'same as the phase being reviewed';
    case 'autonomy':
      return values.autonomy === 'halt-on-everything' ? 'stop and ask me' : 'keep going where it safely can';
    case 'permissionProfile':
      return names.permission(values.permissionProfile);
    case 'permissionMode':
      return values.permissionMode || 'the profile’s own';
    case 'accountId':
      return names.account(values.accountId);
    case 'onLimit':
      return values.onLimit === 'switch'
        ? 'switch account, else wait'
        : values.onLimit === 'pause'
          ? 'pause and ask me'
          : 'wait for the reset';
    case 'phaseBudgetUsd':
    case 'runBudgetUsd':
      return values[field].trim() === '' ? 'no ceiling' : money(Number(values[field]));
    case 'gitMode':
      return values.gitMode === 'new-branch' ? 'a work branch per run' : 'the current branch';
    case 'openPr':
      return values.openPr ? 'yes' : 'no';
    case 'isolation':
      return values.isolation === ISOLATED ? 'its own checkout' : 'the shared checkout';
    case 'settle':
      return SETTLE_LABELS[values.settle] ?? values.settle;
    case 'priority':
      return PRIORITY_LABELS[values.priority] ?? values.priority;
    case 'startAfter':
      return values.startAfter.trim() || 'as soon as the queue allows';
    case 'reviewEachPhase':
      return values.reviewEachPhase ? 'a fresh reviewer after every phase' : 'off';
    case 'reviewerPolicy':
      return values.reviewerPolicy === 'may-hold' ? 'may hold dependent phases' : 'comments only';
    case 'ultracode':
      return values.ultracode ? 'licensed' : 'off';
    case 'ultraReview':
      return values.ultraReview === 'each-phase'
        ? 'after every phase'
        : values.ultraReview === 'at-settle'
          ? 'once, before the branch settles'
          : 'never';
    case 'qa':
      return values.qa ? 'turned on for this plan' : 'as the plan says';
    case 'qaMaxRounds':
      return values.qaMaxRounds.trim() === '' ? 'the shipped default of 3' : `${values.qaMaxRounds} rounds`;
    case 'qaFixStrategy':
      return values.qaFixStrategy === 'fresh' ? QA_FIX_STRATEGY_LABELS.fresh : QA_FIX_STRATEGY_LABELS.resume;
    case 'qaRoundBudgetUsd':
      return values.qaRoundBudgetUsd.trim() === ''
        ? 'no per-round ceiling'
        : `$${values.qaRoundBudgetUsd} per round`;
    case 'attachDefaultSkills':
      return values.attachDefaultSkills ? 'attached' : 'not attached';
    case 'skills':
    case 'mcpServers':
      return (v as string[]).length ? (v as string[]).join(', ') : 'none';
    case 'mcpPolicy':
      return values.mcpPolicy === 'require' ? 'park the phase' : 'run the phase without it';
    case 'autoRecover':
      return values.autoRecover ? 'on — at most 2 tries per phase' : 'off';
    case 'maxParallel':
      return values.maxParallel.trim() === '' ? 'the console’s ceiling' : `${values.maxParallel} lanes`;
    case 'maxConsecutiveFailures':
      return values.maxConsecutiveFailures.trim() === ''
        ? 'the run’s own ceiling'
        : `${values.maxConsecutiveFailures} in a row`;
    case 'onlyPhases': {
      const phases = parsePhases(values.onlyPhases);
      return phases ? `P${phases.join(', P')}` : 'the whole plan';
    }
    case 'phaseOptions': {
      const n = Object.keys(values.phaseOptions).length;
      return n ? `${n} ${n === 1 ? 'phase' : 'phases'} overridden` : 'none';
    }
    case 'prompt':
      return values.prompt.trim() ? 'set' : 'none';
    // The Decisions stage's five (phase 11).
    case 'resumeOnRestart':
      return values.resumeOnRestart ? 'continue by itself' : 'wait for a person, with one errand';
    case 'relay':
      return values.relay === 'last-resort' ? 'last resort — a person, then the rule table' : 'off';
    case 'accounts':
      return values.accounts.trim() ? values.accounts.trim() : 'not yet named';
    case 'acknowledgedWaivers':
      return values.acknowledgedWaivers.length ? values.acknowledgedWaivers.join(', ') : 'none';
    case 'manifestOverride':
      return values.manifestOverride.trim() ? `signed by ${values.manifestOverride.trim()}` : 'none';
    default:
      return String(v);
  }
}

/**
 * Which wire fields this launch would actually SEND, asked of the builder that
 * sends them.
 *
 * The review's whole claim is that it "cannot describe a different run from the
 * one `buildRunPayload` sends", and until QA round 1 that was enforced by
 * nothing: rows were gated on `shows(mode, field)`, which is a fact about the
 * MODE and says nothing about the values. So a settle strategy chosen under a
 * work branch and then abandoned by switching back to the current branch stayed
 * "changed here" in the review while the payload dropped it — the review
 * describing a decision the run would not carry (H1).
 *
 * Asking the builder rather than restating its rules is what makes this general:
 * a fourth field that grows a payload condition is covered the day it is
 * written, with nothing here to update. Context is deliberately EMPTY — the
 * question is per-field carry conditions, which read the mode and the values
 * only; the two context-derived additions (`resumeRunId`, and a `phase`
 * launch's own scope) are facts the departure line states in words instead.
 */
function carriedFields(mode: RunSetupMode, values: RunSetupValues): ReadonlySet<string> {
  const door = MODES[mode].door;
  if (door !== 'runStart' && door !== 'runSettings') return new Set<string>();
  return new Set(Object.keys(buildRunPayload(mode, values, {})));
}

/** Every field this launch carries or can still be changed here — the review's long form. */
export function summaryRows(
  mode: RunSetupMode,
  values: RunSetupValues,
  seed: RunSetupValues,
  origins: Origins,
  names: NameSources,
): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const carried = carriedFields(mode, values);
  for (const field of Object.keys(FIELD_LABELS) as RunSetupField[]) {
    // Two questions, and a row needs a yes to either. **Is the control on
    // screen?** — then the value is editable here and worth stating, even where
    // it is an empty default the payload omits (`mcpServers: none`). **Is the
    // value carried?** — then it is part of this run whether or not this stage
    // can edit it, and dropping the row would be the opposite lie. Neither is
    // H1: a value the launch will not send, under a Change link pointing at a
    // control that is no longer drawn.
    const wire = WIRE[field];
    const live = isLive(mode, field, values);
    if (!live && !(wire != null && carried.has(wire))) continue;
    // `openPr` is edited under `settle`'s name (`reachability.test.tsx`
    // OWNED_BY) and `permissionMode` under the profile's — listing either
    // would show one decision twice.
    if (field === 'openPr' || field === 'permissionMode') continue;
    // A per-phase matrix with nothing in it is not a choice.
    if (field === 'phaseOptions' && !Object.keys(values.phaseOptions).length) continue;
    const source = sourceOf(values[field], seed[field], origins[field] ?? 'defaults');
    rows.push({
      field,
      stage: STAGE_OF[field],
      label: FIELD_LABELS[field],
      value: valueText(field, values, names),
      source,
      // An EMPTY account list is the baseline too: it means "the prelude's
      // resolved clause", which for a plan naming none IS `default:0` — the
      // form holds it empty until the prelude answers (`run-setup.tsx`).
      baseline:
        JSON.stringify(values[field]) === JSON.stringify(BASELINE[field]) ||
        (field === 'accounts' && values.accounts.trim() === ''),
      live,
    });
  }
  return rows;
}

/** The rows worth a line: not the shipped default, or changed here. */
export function notableRows(rows: readonly SummaryRow[]): SummaryRow[] {
  return rows.filter((row) => !row.baseline || row.source === 'changed');
}

/** How many rows the operator changed in THIS dialog, per stage — the stepper's note. */
export function changedPerStage(rows: readonly SummaryRow[]): Record<ControlStage, number> {
  const out: Record<ControlStage, number> = { decisions: 0, what: 0, how: 0, money: 0 };
  for (const row of rows) if (row.source === 'changed') out[row.stage] += 1;
  return out;
}

/** What the review knows that the values do not: the plan and its board. */
export interface LaunchFacts {
  slug?: string;
  /** The phases ready now, when the board can say. */
  ready?: number[];
  /** The typed scope, when it parses; a `phase` launch's one phase. */
  scoped?: number[];
  /** The run a `continue`/`start` picks up, when there is one. */
  resumeRunId?: string;
}

/** "phases 8 and 23" / "phase 3" / "nothing". */
export function phraseOfPhases(phases: number[] | undefined): string {
  if (!phases?.length) return 'nothing';
  if (phases.length === 1) return `phase ${phases[0]}`;
  const ids = phases.map((p) => String(p));
  return `phases ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

/**
 * The departure line — one sentence saying what will happen, in the display
 * face on screen. Composed from the values, so it cannot disagree with the
 * payload; hedged nowhere, because it states a configuration rather than a
 * prediction.
 */
export function departureLine(
  mode: RunSetupMode,
  values: RunSetupValues,
  context: RunSetupContext,
  facts: LaunchFacts,
  names: NameSources,
): string {
  const plan = facts.slug ?? context.slug ?? 'this plan';
  const scoped =
    mode === 'phase' && context.phase != null
      ? [context.phase]
      : (facts.scoped ?? parsePhases(values.onlyPhases));
  const model = values.model || 'this machine’s default model';
  const effort = values.effort ? `at ${values.effort} effort` : 'at the default effort';
  const profile = names.permission(values.permissionProfile).toLowerCase();
  const branch =
    values.gitMode === 'new-branch'
      ? `on a work branch (pe/${plan})${settleClause(values.settle)}`
      : 'on the current branch';
  const how = `on ${model} ${effort}, ${profile}, ${branch}.`;

  if (mode === 'live') return `From the next phase, ${plan} runs ${how}`;
  if (mode === 'phase') return `Runs ${phraseOfPhases(scoped)} of ${plan} on its own, ${how}`;
  const run = facts.resumeRunId ? ` (run ${facts.resumeRunId})` : '';
  if (scoped) {
    return mode === 'continue'
      ? `Continues ${plan}${run} through ${phraseOfPhases(scoped)}, ${how}`
      : `Runs ${phraseOfPhases(scoped)} of ${plan} ${how}`;
  }
  const from = facts.ready?.length
    ? `from ${phraseOfPhases(facts.ready)}`
    : facts.ready
      ? 'from nothing — no phase is ready'
      : 'from whatever is ready';
  return mode === 'continue' ? `Continues ${plan}${run} ${from}, ${how}` : `Runs ${plan} ${from}, ${how}`;
}

function settleClause(settle: RunSetupValues['settle']): string {
  switch (settle) {
    case 'pr':
      return ', then opens a pull request';
    case 'keep':
      return ', then keeps the branch';
    case 'integration':
      return ', then merges it into the staging checkout';
    case 'merge-queue':
      return ', then rebases, re-verifies and pushes';
    default:
      return '';
  }
}

/** Where the run stops, and what it does instead of stopping — plain clauses. */
export function stopsWhen(values: RunSetupValues): { stops: string[]; carriesOn: string[] } {
  const stops: string[] = [];
  const carriesOn: string[] = [];
  const run = values.runBudgetUsd.trim() === '' ? null : Number(values.runBudgetUsd);
  const phase = values.phaseBudgetUsd.trim() === '' ? null : Number(values.phaseBudgetUsd);
  if (run != null && Number.isFinite(run)) stops.push(`the run has spent ${money(run)}`);
  if (phase != null && Number.isFinite(phase)) stops.push(`one phase spends ${money(phase)}`);
  if (run == null && phase == null)
    carriesOn.push('there is no spending ceiling — only the account’s own windows');
  stops.push(
    values.maxConsecutiveFailures.trim() === ''
      ? 'phases fail in a row past the run’s own ceiling'
      : `${values.maxConsecutiveFailures} ${values.maxConsecutiveFailures === '1' ? 'phase fails' : 'phases fail in a row'}`,
  );
  if (values.onLimit === 'pause') stops.push('a usage window closes — it pauses and asks');
  else if (values.onLimit === 'wait') carriesOn.push('at a usage window it waits for the reset');
  else carriesOn.push('at a usage window it switches to an account with headroom, else waits');
  if (values.autonomy === 'halt-on-everything') {
    stops.push('anything is unclear — it stops and asks');
    // A failed review is a stop under this mode (a needs-human halt on the
    // phase parks the run); under the other it is the ladder's errand.
    stops.push('a QA round fails — it parks the run on that phase, naming the report');
  } else {
    carriesOn.push('where something is unclear it keeps going where it safely can');
    carriesOn.push(
      'a QA fail is fixed by the ladder while independent phases run — its dependents stay held',
    );
  }
  if (values.autoRecover)
    carriesOn.push('a halt an agent can clear is retried by itself, at most twice per phase');
  else stops.push('any halt — nothing retries it without a person');
  return { stops, carriesOn };
}

/** The ceilings as arithmetic: what this launch can cost at most, where it can be said. */
export function ceilings(
  values: RunSetupValues,
  phaseCount: number | undefined,
): { perPhase: number | null; run: number | null; atMost: number | null; lines: string[] } {
  const perPhase = values.phaseBudgetUsd.trim() === '' ? null : Number(values.phaseBudgetUsd);
  const run = values.runBudgetUsd.trim() === '' ? null : Number(values.runBudgetUsd);
  const byPhases = perPhase != null && phaseCount ? perPhase * phaseCount : null;
  const atMost = run != null && byPhases != null ? Math.min(run, byPhases) : (run ?? byPhases);
  const lines: string[] = [];
  if (perPhase != null) {
    lines.push(
      phaseCount
        ? `${money(perPhase)} per phase × ${phaseCount} ${phaseCount === 1 ? 'phase' : 'phases'} = up to ${money(byPhases)}`
        : `${money(perPhase)} per phase`,
    );
  }
  if (run != null) lines.push(`${money(run)} for the whole run`);
  if (perPhase == null && run == null)
    lines.push('No ceiling — the run spends until the plan ends or a usage window closes.');
  else if (atMost != null) lines.push(`At most ${money(atMost)} before it halts and asks.`);
  return { perPhase, run, atMost, lines };
}
