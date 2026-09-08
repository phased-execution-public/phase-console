/**
 * The eight things this form can be, and exactly what each one sends.
 *
 * A mode is a FIELD SET plus a payload builder. That pairing is the whole
 * consolidation: four surfaces used to each decide privately which choices to
 * offer and how to spell them, so "Continue" on a plan page could not set a
 * budget while "Continue" on the run page could, and neither said so.
 *
 * ## Why the payloads are built here and not in the component
 *
 * Because they are the contract, and a contract you can only exercise by
 * rendering a dialog and clicking a button is a contract nobody re-checks.
 * `buildRunPayload` and `buildTicket` are pure: `run-setup.test.tsx` pins them
 * field by field, including the omissions, which is where the interesting bugs
 * live — a key that stops being sent degrades silently to the server's own
 * default, and the run looks healthy and is not the run that was asked for.
 *
 * ## The omission rules, stated once
 *
 * - **Always sent, exactly as shown**: `permissionProfile`, `mcpPolicy`,
 *   `autoRecover`, `gitMode`. A run written without them falls back to a
 *   preference, and a form that shows a value and sends nothing is lying.
 * - **Omitted when empty**: `mcpServers`, `onlyPhases`, `attachDefaultSkills`,
 *   `qa`. Absence is their meaning on disk, and a run file that never named
 *   servers must keep meaning what it meant.
 * - **Sent as `null` when blank**: the two budgets. `null` is "no ceiling",
 *   which is a choice; absence would mean "leave whatever was there".
 */

import type { PhaseOptions, RunState } from '@/lib/api';
import { RECOVERY_LABELS, type RecoveryClass } from '@/lib/recovery';
import { EMPTY, parsePhases, type PermissionChoice, type RunSetupField, type RunSetupValues } from './schema';
import { PERMISSION_MODES, PERMISSION_PROFILES, PROFILE_LABELS } from '@shared/run-settings.js';

export type RunSetupMode =
  'defaults' | 'plan' | 'start' | 'continue' | 'phase' | 'recovery' | 'qa' | 'qa-fix' | 'session' | 'live';

/** What a mode needs to know that is not a form value. */
export interface RunSetupContext {
  slug?: string;
  /** The phase a `phase`, `qa` or `recovery` launch is about. */
  phase?: number;
  /** The run being continued or reconfigured — the seed, and the resume target. */
  run?: RunState | null;
  runId?: string;
  recoveryClass?: string;
  /** Turn the plan's QA gate on as part of a `qa` launch (its qa-mode is `off`). */
  activate?: boolean;
  /** The plan's `**Model:**` / `**Effort:**` for this phase, when it names one. */
  qaModel?: string;
  qaEffort?: string;
  /** Skills the plan asks every session to invoke — a review opens on them. */
  planSkills?: string[];
  /**
   * `qa-fix` only: the verdict being answered and the report it wrote, so the
   * form can say what it is about rather than asking the operator to remember.
   */
  qaVerdict?: string;
  qaReport?: string;
  qaRounds?: number;
}

interface ModeSpec {
  /** The fields this mode shows — and therefore the fields it sends. */
  fields: readonly RunSetupField[];
  /** The button. */
  submit: string | ((context: RunSetupContext) => string);
  /** Which door it knocks on; `prefs` is Settings ▸ Automation. */
  door: 'runStart' | 'runSettings' | 'qaRecover' | 'ticket' | 'prefs' | 'launch';
  /** Sessions offer "Plan only"; runs never do. */
  sessionPermissions?: boolean;
}

/**
 * The full run field set — what a surface minting or reconfiguring a whole run
 * offers. `phase` deliberately shows less (below); a "run only this one" is a
 * narrow act, and burying it under a per-phase matrix and a failure ceiling is
 * how a one-phase launch turns into a re-read of the run's whole configuration.
 */
const RUN_FIELDS = [
  'model',
  'effort',
  'autonomy',
  'permissionProfile',
  'accountId',
  'onLimit',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'gitMode',
  'openPr',
  'isolation',
  'settle',
  'priority',
  'startAfter',
  'reviewEachPhase',
  'reviewerPolicy',
  'ultracode',
  'ultraReview',
  'qa',
  // QA's own three. They sit beside `qa` rather than beside `model`/`effort`
  // because they are one decision — how this run's work gets REVIEWED — and
  // splitting them across the form is how an operator sets a reviewer model on
  // a run whose QA gate is off.
  'qaMaxRounds',
  'qaModel',
  'qaEffort',
  'attachDefaultSkills',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'autoRecover',
  'maxParallel',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
] as const;

/**
 * A live run: everything above minus the fields a patch may never carry.
 *
 * `startAfter` joins `qa` and `accountId` here. A chain says where a run
 * BEGINS, and a run already mid-plan cannot un-begin — offering the control on
 * a live run would show a value the settings door does not read.
 */
const LIVE_FIELDS = RUN_FIELDS.filter(
  (field) => field !== 'qa' && field !== 'accountId' && field !== 'startAfter',
) as readonly RunSetupField[];

/** The dialog's narrow launch, unchanged: choices, not configuration. */
const PHASE_FIELDS = [
  'model',
  'effort',
  'accountId',
  'onLimit',
  'permissionProfile',
  'attachDefaultSkills',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'gitMode',
  'openPr',
  'isolation',
  'settle',
  'reviewEachPhase',
  'reviewerPolicy',
  'ultracode',
  'ultraReview',
  'qa',
  'autoRecover',
] as const;

/**
 * An agent ticket has no budget, no branch and no matrix — it is one session.
 *
 * Neither ultra tier is here, and each is absent for its own reason. `ultraReview`
 * needs a branch and a phase-finish to hang a cloud review on, and a ticket has
 * neither. `ultracode` is absent because these two tickets — a QA review and a
 * recovery — are exactly the bounded sessions the runner withholds the licence
 * from: asked for one artefact, given the budget for one. The plan wizard is
 * the ticket-shaped launch that DOES author work that fans out, and it offers
 * the box itself (`plan`, below).
 */
const TICKET_FIELDS = ['model', 'effort', 'accountId', 'attachDefaultSkills', 'skills'] as const;

export const MODES: Readonly<Record<RunSetupMode, ModeSpec>> = Object.freeze({
  defaults: {
    fields: [
      'attachDefaultSkills',
      'qa',
      'gitMode',
      'openPr',
      'isolation',
      'settle',
      'reviewEachPhase',
      'reviewerPolicy',
      'autoRecover',
      'mcpPolicy',
    ],
    submit: 'Save defaults',
    door: 'prefs',
  },
  start: { fields: RUN_FIELDS, submit: 'Start', door: 'runStart' },
  continue: { fields: RUN_FIELDS, submit: 'Continue', door: 'runStart' },
  phase: {
    fields: PHASE_FIELDS,
    submit: (context) => `Run phase ${context.phase}`,
    door: 'runStart',
  },
  recovery: {
    fields: TICKET_FIELDS,
    // The class names the button, as it always has: "Repair the plan with a
    // new agent" says what will happen; "Fix it with an agent" does not.
    submit: (context) => RECOVERY_LABELS[context.recoveryClass as RecoveryClass] ?? 'Fix it with an agent',
    door: 'ticket',
  },
  qa: {
    // `qa` here is the ACTIVATION checkbox — turn the plan's gate on as part of
    // this review — not the run-level gate toggle. Same value, same control,
    // different sentence; `buildTicket` sends it as `activate`.
    fields: [...TICKET_FIELDS, 'permissionProfile', 'qa'],
    submit: 'Start review',
    door: 'ticket',
  },
  /**
   * Fix & re-QA (issue #11) — a LOOP with settings of its own, not a review.
   *
   * Its field set is deliberately between `phase`'s and `qa`'s. It carries the
   * fix session's own model, effort, account, permissions, skills and MCP
   * servers (the fix does real work in the tree, so it needs all of them), the
   * reviewer's own tier beside them, and the two settings that exist only here
   * — how the fix session boards, and what ONE round may spend. It carries
   * nothing about the run's git strategy, its parallelism or its scope: a
   * recovery answers one verdict on one phase and must not quietly reconfigure
   * the plan it is recovering.
   */
  'qa-fix': {
    fields: [
      'model',
      'effort',
      'accountId',
      'onLimit',
      'permissionProfile',
      'attachDefaultSkills',
      'skills',
      'mcpServers',
      'mcpPolicy',
      'qaFixStrategy',
      'qaMaxRounds',
      'qaRoundBudgetUsd',
      'qaModel',
      'qaEffort',
    ],
    submit: (context) => `Fix & re-QA phase ${context.phase ?? ''}`.trim(),
    door: 'qaRecover',
  },
  /**
   * The plan wizard — and, since Phase 16, the plan-from-issues launch.
   *
   * Deliberately WITHOUT permissions: a plan-authoring session always starts in
   * plan mode, and the select this form used to offer was the one hole in that
   * rule — `auto`/`acceptEdits` here launched a session that could write a plan
   * nobody had approved. The server applies it (`buildAgentLaunch`,
   * `intent: 'plan'`); omitting the field IS the choice.
   *
   * `accountId` IS here, and it was not before. The ticket door has always read
   * it and resolved `auto` against the meters exactly as a run start does, so
   * the field's absence meant one thing only: a plan-authoring session ran on
   * the machine login whatever the operator would have chosen — silently, and
   * usually on the account that had just hit a wall. That is the same argument
   * `buildTicket` already makes for a QA review and a recovery, and it applies
   * here for the same reason.
   */
  plan: {
    fields: ['model', 'effort', 'accountId', 'attachDefaultSkills', 'skills', 'ultracode'],
    submit: 'Start authoring',
    door: 'launch',
  },
  session: {
    fields: ['model', 'effort', 'permissionProfile', 'accountId', 'prompt', 'skills'],
    submit: 'Start session',
    door: 'launch',
    sessionPermissions: true,
  },
  live: { fields: LIVE_FIELDS, submit: 'Apply from next phase', door: 'runSettings' },
});

/** Does this mode show that field? The single question every renderer asks. */
export function shows(mode: RunSetupMode, field: RunSetupField): boolean {
  return (MODES[mode].fields as readonly string[]).includes(field);
}

export function submitLabel(mode: RunSetupMode, context: RunSetupContext): string {
  const label = MODES[mode].submit;
  return typeof label === 'function' ? label(context) : label;
}

/** `''` is "no ceiling" and reaches the server as an explicit null. */
const dollars = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/** `''` is "this console's own default" and is left off the payload entirely. */
const whole = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

/**
 * What a run door is told.
 *
 * Reads only the fields the mode SHOWS, so a value seeded and never rendered
 * cannot leak into a payload — which is the failure the old four-surface split
 * kept producing in the other direction, by rendering a value and not sending
 * it.
 */
export function buildRunPayload(
  mode: RunSetupMode,
  values: RunSetupValues,
  context: RunSetupContext = {},
): Record<string, unknown> {
  const run = context.run ?? null;
  const on = (field: RunSetupField) => shows(mode, field);
  const payload: Record<string, unknown> = {};

  if (on('model')) payload.model = values.model;
  if (on('effort')) payload.effort = values.effort;

  // Sent only when it says something: `default` with no account on the run is
  // the absence the server already assumes, and `wait` likewise. Both stay
  // sticky once a run has answered them, which is why the run is consulted.
  if (on('accountId') && (values.accountId !== 'default' || run?.accountId)) {
    payload.accountId = values.accountId;
  }
  if (on('onLimit') && (values.onLimit !== 'wait' || run?.onLimit)) payload.onLimit = values.onLimit;

  // A narrow launch does not reopen the run's own posture: it inherits it, so
  // "run only phase 3" cannot quietly re-autonomy the rest of the plan.
  payload.autonomy = on('autonomy') ? values.autonomy : (run?.autonomy ?? EMPTY.autonomy);
  payload.phaseBudgetUsd = on('phaseBudgetUsd')
    ? dollars(values.phaseBudgetUsd)
    : (run?.phaseBudgetUsd ?? null);
  payload.runBudgetUsd = on('runBudgetUsd') ? dollars(values.runBudgetUsd) : (run?.runBudgetUsd ?? null);

  if (on('permissionProfile')) payload.permissionProfile = values.permissionProfile;
  if (on('skills')) payload.skills = values.skills;
  if (on('mcpServers') && values.mcpServers.length) payload.mcpServers = values.mcpServers;
  if (on('mcpPolicy')) payload.mcpPolicy = values.mcpPolicy;
  if (on('attachDefaultSkills') && values.attachDefaultSkills) payload.attachDefaultSkills = true;
  if (on('gitMode')) {
    payload.gitMode = values.gitMode;
    if (values.gitMode === 'new-branch' && on('openPr')) payload.openPr = values.openPr;
    // Same guard as `openPr`, and the same reason: isolation without a branch
    // of the run's own is a setting that reads as configured and does nothing.
    // Sending it anyway would put a `worktree` on a default-branch payload,
    // which `newRun` drops on the floor — a silent disagreement between what
    // the form shows and what the run records.
    if (values.gitMode === 'new-branch' && on('isolation')) payload.isolation = values.isolation;
    // And settle by the same guard, for the same reason: a strategy on a
    // default-branch payload is a setting that reads as configured and does
    // nothing, because there is no branch for it to act on.
    if (values.gitMode === 'new-branch' && on('settle')) payload.settle = values.settle;
  }
  // Written only when ON, like `qa` and for the same reason: a payload that
  // carries `reviewEachPhase: false` and one that omits it must not be two
  // different things to a server whose absent state IS off.
  if (on('reviewEachPhase') && values.reviewEachPhase) {
    payload.reviewEachPhase = true;
    if (on('reviewerPolicy') && values.reviewerPolicy === 'may-hold') payload.reviewerPolicy = 'may-hold';
  }
  // `ultracode` written only when ON, exactly like the reviewer above it.
  // `ultraReview` written WHENEVER shown, exactly like `priority` below it, and
  // for that field's reason: on a live run an absent field means "leave it
  // alone", so a form that omitted `off` could turn cloud reviews on and never
  // take them back. The server stores `off` as an omission either way.
  if (on('ultracode') && values.ultracode) payload.ultracode = true;
  if (on('ultraReview')) payload.ultraReview = values.ultraReview;
  // The cloud reviewer obeys the same hold policy as the session one, so a run
  // that chose `may-hold` for either has to say so even when only the cloud
  // tier is on — otherwise the policy is silently dropped with the reviewer
  // that happened to be off.
  if (
    on('ultraReview') &&
    on('reviewerPolicy') &&
    values.ultraReview !== 'off' &&
    values.reviewerPolicy === 'may-hold'
  ) {
    payload.reviewerPolicy = 'may-hold';
  }
  // The class and the chain are sent WHENEVER their control is shown, the way
  // `gitMode` is and unlike `reviewEachPhase`. The reason is the settings
  // door: on a live run, absent means "leave it alone", so a form that omitted
  // `normal` and `''` could raise a priority or set a chain and never take
  // either back. The server stores both as omissions (`applySettings`,
  // `newRun`), so a run at the defaults still reads exactly as one from before
  // these fields existed.
  if (on('priority')) payload.priority = values.priority;
  if (on('startAfter')) payload.startAfter = values.startAfter.trim();
  if (on('qa') && values.qa) payload.qa = true;
  // QA's own three. `''` is "say nothing", which lets the reviewer keep
  // inheriting the builder's model and effort and the round budget keep its
  // shipped default — the same rule `maxParallel` below uses, and the reason
  // the door reads an absent field as "you did not say" rather than as a value.
  if (on('qaMaxRounds')) {
    const n = whole(values.qaMaxRounds);
    if (n !== undefined) payload.qaMaxRounds = n;
  }
  if (on('qaModel') && values.qaModel) payload.qaModel = values.qaModel;
  if (on('qaEffort') && values.qaEffort) payload.qaEffort = values.qaEffort;
  // QA recovery's two. The strategy is sent only when it says something, like
  // every other `''`-is-silence field; the round budget follows the DOLLAR
  // rule instead — `''` is an explicit `null`, "no per-round stop", because a
  // budget that vanished when cleared could never be turned off.
  if (on('qaFixStrategy') && values.qaFixStrategy) payload.qaFixStrategy = values.qaFixStrategy;
  if (on('qaRoundBudgetUsd')) payload.qaRoundBudgetUsd = dollars(values.qaRoundBudgetUsd);
  // The phase this recovery is about. Every other run payload carries its scope
  // in `onlyPhases`; the QA door takes one phase, by name, because a recovery
  // that could name several would be a loop with no idea which report it is
  // answering.
  if (MODES[mode].door === 'qaRecover' && context.phase) payload.phase = context.phase;
  if (on('autoRecover')) payload.autoRecover = values.autoRecover;
  if (on('maxParallel')) {
    const n = whole(values.maxParallel);
    if (n !== undefined) payload.maxParallel = n;
  }
  if (on('maxConsecutiveFailures')) {
    const n = whole(values.maxConsecutiveFailures);
    if (n !== undefined) payload.maxConsecutiveFailures = n;
  }
  if (on('phaseOptions') && Object.keys(values.phaseOptions).length) {
    payload.phaseOptions = values.phaseOptions;
  }

  // Scope. A `phase` launch says it outright; every other mode sends whatever
  // the operator typed, and an empty box means the whole plan — which is why a
  // continue "never silently inherits a single-phase run".
  if (mode === 'phase' && context.phase != null) payload.onlyPhases = [context.phase];
  else if (on('onlyPhases')) {
    const phases = parsePhases(values.onlyPhases);
    if (phases) payload.onlyPhases = phases;
  }

  // Which run this picks up. `live` is a patch on a run that already exists,
  // so it never resumes anything.
  if (MODES[mode].door === 'runStart') {
    const resumable = resumeTarget(mode, run);
    if (resumable) payload.resumeRunId = resumable;
  }
  return payload;
}

/**
 * The run a launch picks up, if any.
 *
 * A `continue` resumes whatever it was given. A `phase` or a `start` resumes
 * only a run that has not finished — restarting a finished run would append to
 * a record that already closed.
 */
export function resumeTarget(mode: RunSetupMode, run: RunState | null): string | undefined {
  if (!run) return undefined;
  if (mode === 'continue') return run.id;
  if (mode === 'start' || mode === 'phase') return run.status !== 'finished' ? run.id : undefined;
  return undefined;
}

/**
 * What an agent ticket is told — a QA review or a recovery.
 *
 * `skills` here is the MERGED list: a ticket has no attach flag for the server
 * to union in, so the merge is the caller's. That asymmetry with the run doors
 * is deliberate and pinned by the tests either side of it.
 */
export function buildTicket(
  mode: 'qa' | 'recovery',
  values: RunSetupValues,
  context: RunSetupContext,
  defaultSkills: string[],
): Record<string, unknown> {
  const skills = mergedSkills(values, defaultSkills);
  const body: Record<string, unknown> = { intent: mode };
  if (mode === 'qa') {
    body.slug = context.slug;
    body.phase = context.phase;
    // Only where the plan's gate is actually off and the console may write —
    // `context.activate` carries that judgement, `values.qa` carries the tick.
    if (context.activate && values.qa) body.activate = true;
  } else {
    body.recoveryClass = context.recoveryClass;
    body.slug = context.slug;
    if (context.phase != null) body.phase = context.phase;
    if (context.runId) body.runId = context.runId;
  }
  // `''` from a select means "this machine's default", which is an omission
  // rather than a value the server should validate.
  if (values.model) body.model = values.model;
  if (values.effort) body.effort = values.effort;
  if (mode === 'qa') body.permissionProfile = values.permissionProfile;
  // `auto` travels: the ticket door resolves it against the meters the same way
  // a run start does. Stripping it here meant picking "auto" on a repair ran
  // the session on the machine login — silently, and usually on the account
  // that had just hit the wall.
  if (values.accountId !== 'default') body.accountId = values.accountId;
  if (skills.length) body.skills = skills;
  return body;
}

/**
 * What a session the caller owns is told — the launcher, and the plan wizard.
 *
 * The wizard's ticket has no `permissionMode` and its skills arrive MERGED,
 * because a plan ticket has no attach flag for the server to union in. Both
 * asymmetries were already true; they are stated here rather than in two forms.
 */
export function buildLaunch(
  values: RunSetupValues,
  mode: RunSetupMode = 'session',
  defaultSkills: string[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: values.model, effort: values.effort };
  if (mode === 'plan') {
    const skills = mergedSkills(values, defaultSkills);
    if (skills.length) body.skills = skills;
    // The wizard's own opt-in — a plan-authoring session is exactly the kind of
    // work that fans out, and exactly the kind nobody should pay for by default.
    if (values.ultracode) body.ultracode = true;
    // `auto` travels, and `default` is still an omission — the same rule, and
    // the same sentence, as `buildTicket`'s. `default` IS the machine login
    // said plainly, and the server should not have to validate a word for it.
    if (values.accountId !== 'default') body.accountId = values.accountId;
    return body;
  }
  body.permissionMode = values.permissionMode;
  if (values.accountId !== 'default') body.accountId = values.accountId;
  if (values.prompt.trim()) body.prompt = values.prompt.trim();
  if (values.skills.length) body.skills = values.skills;
  return body;
}

/** The Automation preferences this form owns — one patch, merged server-side. */
export function buildPrefs(values: RunSetupValues): Record<string, unknown> {
  return {
    attachDefaultSkills: values.attachDefaultSkills,
    qaByDefault: values.qa,
    gitMode: values.gitMode,
    openPrOnComplete: values.openPr,
    isolation: values.isolation,
    settle: values.settle,
    reviewEachPhaseByDefault: values.reviewEachPhase,
    reviewerPolicy: values.reviewerPolicy,
    autoRecoverByDefault: values.autoRecover,
    mcpPolicy: values.mcpPolicy,
  };
}

/** The machine's defaults plus what was ticked — order stable, no duplicates. */
export function mergedSkills(values: RunSetupValues, defaultSkills: string[]): string[] {
  return [...new Set([...(values.attachDefaultSkills ? defaultSkills : []), ...values.skills])];
}

/**
 * The permission choices a mode offers.
 *
 * One vocabulary, as the redesign promised — the same field, the same labels,
 * the same component. Sessions add "Plan only" and drop Bypass, because the
 * agent-ticket door refuses `bypassPermissions` outright; they also keep the
 * CLI's own two extra modes, which map onto no run profile and would otherwise
 * simply stop being reachable.
 */
export const PERMISSION_CHOICES: Readonly<Record<PermissionChoice | string, string>> = Object.freeze({
  ...PROFILE_LABELS,
  plan: 'Plan only (read-only) — until a plan is approved',
  auto: 'Auto — the CLI decides what needs asking',
  dontAsk: 'Don’t ask — refuse rather than prompt',
});

/** A run offers exactly the three profiles; membership from the owner. */
export const RUN_PERMISSIONS: readonly (typeof PERMISSION_PROFILES)[number][] = PERMISSION_PROFILES;
export const SESSION_PERMISSIONS = ['guarded', 'trusted', 'plan', 'auto', 'dontAsk'] as const;
/** QA reviews offer the two the QA door accepts, under the same words. */
export const QA_PERMISSIONS = ['guarded', 'bypass'] as const;

/**
 * The CLI `--permission-mode` a session choice spells.
 *
 * Guarded is the CLI's own default (ask first), which the runner's vocabulary
 * writes as an omission rather than a value; Trusted is `acceptEdits`, the
 * closest honest analogue for a session a person is watching. `auto`,
 * `dontAsk` and `plan` are already CLI modes and pass through unchanged.
 */
export function permissionModeFor(choice: string): string {
  if (choice === 'guarded') return '';
  if (choice === 'trusted') return 'acceptEdits';
  return choice;
}

/**
 * A PER-PHASE override speaks the CLI's vocabulary directly, not the run
 * profile's.
 *
 * `phaseOptions[N].permissionMode` is validated against the runner's
 * `PERMISSION_MODES` (`server/runner/spawn.ts`) and any other word is dropped
 * on the floor. The per-phase select used to write its RAW choice word, so
 * picking "Trusted — only the deny list stops it" on phase 7 stored `trusted`,
 * which is a run-PROFILE word: the server discarded it, the phase boarded
 * under the run's profile, and the form still said "changed here". `guarded`
 * did the same. Meanwhile `manual` — a real mode — was not offered at all.
 *
 * So the options ARE the modes. `guarded` is absent on purpose: its CLI
 * spelling is the empty string, which is exactly what the "inherit" option
 * above already means, and offering a second way to say inherit is how the
 * first one stops being trusted.
 */
/**
 * The modes this picker offers, in ITS order. Membership comes from
 * `shared/run-settings.js`'s `PERMISSION_MODES` — the same five the server
 * spawns with — so the picker cannot offer a mode the spawner rejects.
 */
const PICKER_RANK: Record<string, number> = {
  acceptEdits: 0,
  plan: 1,
  auto: 2,
  dontAsk: 3,
  manual: 4,
};
export const PHASE_PERMISSION_MODES: readonly (typeof PERMISSION_MODES)[number][] = Object.freeze(
  [...PERMISSION_MODES].sort((a, b) => (PICKER_RANK[a] ?? 99) - (PICKER_RANK[b] ?? 99)),
);

/** What each CLI mode is called on screen — the profile words, where they map. */
export const PERMISSION_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  acceptEdits: 'Trusted — only the deny list stops it',
  plan: 'Plan only (read-only) — until a plan is approved',
  auto: 'Auto — the CLI decides what needs asking',
  dontAsk: 'Don’t ask — refuse rather than prompt',
  manual: 'Manual — ask before every tool',
});

/** The inverse, for seeding the field from a session that already exists. */
export function permissionChoiceFor(mode: string | undefined): string {
  if (!mode || mode === 'manual' || mode === 'default') return 'guarded';
  if (mode === 'acceptEdits') return 'trusted';
  return mode;
}

export type { PhaseOptions };
