/**
 * The launch flow's stages, and which stage each field lives on.
 *
 * The form is one object (`schema.ts`) shown as four stages: WHAT runs (the
 * plan, the phases ready now, where the run picks up), HOW it runs (the model,
 * the guard rails, the branch, the tools), MONEY AND STOPS (the ceilings and
 * every condition that halts it), and the REVIEW (every choice, its source,
 * every warning, the one Launch). `STAGE_OF` is the map, and it is a table
 * rather than an inference because the review's "change" links, the stepper's
 * "2 changed" notes and the reachability test all read it — three readers,
 * one answer.
 *
 * ## Staged or flat
 *
 * A stage bar over five fields is furniture, so `LAUNCH_SURFACE` says which
 * modes are staged. The rule: a mode whose door is a RUN (`runStart`,
 * `runSettings`) is staged — it carries the whole field set — and a mode that
 * mints one session (a QA review, a recovery, the launcher, the plan wizard)
 * or edits preferences is flat. Staging is a property of the overlay: a
 * `RunSetup` rendered inline on a page (the Automation card, the launcher)
 * is always flat, whatever its mode.
 *
 * ## Adding a mode — the extension point Phase 9 uses
 *
 * Phase 9 adds a `qa-fix` mode (fix & re-QA with its own settings, issue
 * #11). A new mode needs exactly four things, each pinned by
 * `stages.test.ts`: its field set and door in `modes.ts` (`MODES`), a
 * `LAUNCH_SURFACE` entry saying staged or flat, a `HEADINGS` entry (the
 * overlay's title and description), and — only if it adds a FIELD — a
 * `STAGE_OF` row. Nothing else knows the list of modes: the stepper reads
 * `STAGES`, the stages read `STAGE_OF` through `fieldsOnStage`, and the
 * review reads `FIELD_LABELS`. A mode that names a field with no stage fails
 * the test rather than rendering a control nobody can reach.
 */

import type { RunSetupMode } from './modes';
import { MODES, shows } from './modes';
import type { RunSetupField, RunSetupValues } from './schema';

export type StageId = 'what' | 'how' | 'money' | 'review';

export interface Stage {
  id: StageId;
  /** The stage's name — the desk reads it, and the review links back to it. */
  label: string;
  /** What a quarter of a 360px bar can hold. */
  short: string;
  /** One sentence under the stage's heading, in the operator's words. */
  blurb: string;
}

export const STAGES: readonly Stage[] = Object.freeze([
  {
    id: 'what',
    label: 'What runs',
    short: 'What',
    blurb: 'The plan, the phases ready now, the sessions they batch into, and where the run picks up.',
  },
  {
    id: 'how',
    label: 'How it runs',
    short: 'How',
    blurb: 'The model, the guard rails, the branch it works on, and what every session is given.',
  },
  {
    id: 'money',
    label: 'Money and stops',
    short: 'Money',
    blurb: 'What it may spend, and every condition that stops it.',
  },
  {
    id: 'review',
    label: 'Review',
    short: 'Review',
    blurb: 'Every choice this run makes, where each came from, and what boarding will find.',
  },
]);

/** The stages that carry CONTROLS — the review carries none. */
export type ControlStage = Exclude<StageId, 'review'>;

/**
 * Which stage each field is edited on.
 *
 * Every member of `RunSetupValues` has a row, including the two that are not
 * run fields (`prompt`, `permissionMode`): a flat mode renders them, and the
 * flat layout is the stages' sections in order, so they still need a home.
 */
export const STAGE_OF: Readonly<Record<RunSetupField, ControlStage>> = Object.freeze({
  onlyPhases: 'what',
  startAfter: 'what',

  model: 'how',
  effort: 'how',
  phaseOptions: 'how',
  permissionProfile: 'how',
  permissionMode: 'how',
  accountId: 'how',
  gitMode: 'how',
  openPr: 'how',
  isolation: 'how',
  settle: 'how',
  attachDefaultSkills: 'how',
  skills: 'how',
  mcpServers: 'how',
  mcpPolicy: 'how',
  reviewEachPhase: 'how',
  reviewerPolicy: 'how',
  ultracode: 'how',
  ultraReview: 'how',
  qa: 'how',
  qaMaxRounds: 'how',
  // The strategy is a fact about HOW the fix session boards; the round budget is
  // money and a stop, which is the other stage's whole subject. They are one
  // feature and they still go where their question is asked.
  qaFixStrategy: 'how',
  qaRoundBudgetUsd: 'money',
  qaModel: 'how',
  qaEffort: 'how',
  prompt: 'how',

  phaseBudgetUsd: 'money',
  runBudgetUsd: 'money',
  maxParallel: 'money',
  maxConsecutiveFailures: 'money',
  priority: 'money',
  onLimit: 'money',
  autoRecover: 'money',
  autonomy: 'money',
});

/**
 * What each field is CALLED — the control's label, and therefore the review's
 * row label and the accessible name a test finds it by. One spelling, so the
 * summary's "Budget per phase" is the same words as the control it links to.
 */
export const FIELD_LABELS: Readonly<Record<RunSetupField, string>> = Object.freeze({
  model: 'Model',
  effort: 'Effort',
  autonomy: 'If something is unclear',
  permissionProfile: 'Permissions',
  permissionMode: 'Permission mode',
  accountId: 'Account',
  onLimit: 'On usage limit',
  phaseBudgetUsd: 'Budget per phase ($)',
  runBudgetUsd: 'Budget for the run ($)',
  gitMode: 'Branch',
  openPr: 'Open a PR when the plan completes',
  isolation: 'Give this run its own checkout',
  settle: 'When the plan completes',
  priority: 'Queue priority',
  startAfter: 'Start after (optional)',
  reviewEachPhase: 'Review each phase',
  reviewerPolicy: '…and let it hold dependent phases',
  ultracode: 'Ultracode',
  ultraReview: 'Cloud review',
  qa: 'QA gate',
  qaMaxRounds: 'Stop after N failed QA rounds',
  qaFixStrategy: 'How the fix session starts',
  qaRoundBudgetUsd: 'Budget per QA round',
  qaModel: 'QA model',
  qaEffort: 'QA effort',
  attachDefaultSkills: 'Attach default skills',
  skills: 'Skills',
  mcpServers: 'MCP servers',
  mcpPolicy: 'If an MCP server will not connect',
  autoRecover: 'Auto-recover halts',
  maxParallel: 'Max parallel',
  maxConsecutiveFailures: 'Stop after N failures',
  onlyPhases: 'Only these phases',
  phaseOptions: 'Per-phase overrides',
  prompt: 'First prompt',
});

/** Which modes get the stage bar. See the header. */
export const LAUNCH_SURFACE: Readonly<Record<RunSetupMode, 'staged' | 'flat'>> = Object.freeze({
  start: 'staged',
  continue: 'staged',
  phase: 'staged',
  live: 'staged',
  qa: 'flat',
  // Staged, unlike the flat `qa` review beside it: a recovery is a run-shaped
  // launch with its own settings, its own money and its own stop, and those are
  // exactly the four stages. It is `phase`'s shape, not `qa`'s.
  'qa-fix': 'staged',
  recovery: 'flat',
  session: 'flat',
  plan: 'flat',
  defaults: 'flat',
});

/**
 * The overlay's words per mode — the title and the sentence under it.
 *
 * `phase` and `recovery` name their subject, so those are functions of the
 * context; the rest are fixed. The launch dialog and the settings sheet used
 * to each carry their own copy of these; one table means one voice.
 */
export const HEADINGS: Readonly<
  Record<
    RunSetupMode,
    | { title: string; description: string }
    | ((ctx: { phase?: number }) => { title: string; description: string })
  >
> = Object.freeze({
  start: {
    title: 'Start a run',
    description: 'Fresh or half finished is the same button — the done-set decides where it begins.',
  },
  continue: {
    title: 'Continue this run',
    description:
      'Picks the run up where it stopped, with the settings below. The scope is cleared — a continue never silently inherits a single-phase run. Type phases in to narrow it again.',
  },
  live: {
    title: 'Run settings',
    description:
      'Applies from the next phase to board. The session running now was started with its model and budget fixed in its own command line.',
  },
  phase: (ctx) => ({
    title: `Run only phase ${ctx.phase ?? ''}`.trim(),
    description:
      'Run this phase on its own, then stop — the loop does not carry on into the rest of the plan.',
  }),
  qa: (ctx) => ({
    title: `QA phase ${ctx.phase ?? ''}`.trim(),
    description:
      'A fresh Claude session reviews this phase against its own exit criteria and records the verdict with qa-record.sh. It is never the session that built it.',
  }),
  'qa-fix': (ctx) => ({
    title: `Fix & re-QA phase ${ctx.phase ?? ''}`.trim(),
    description:
      'Runs the loop again: a fix session carrying the last report\u2019s findings verbatim, then a fresh-context review that records the next round \u2014 while rounds remain. A pass releases every dependent phase.',
  }),
  recovery: {
    title: 'Fix it with an agent',
    description: 'A new agent session reads the halt and does the unblocking work.',
  },
  session: {
    title: 'Start a session',
    description: 'An interactive Claude session in the browser terminal.',
  },
  plan: {
    title: 'Start authoring',
    description: 'A plan-authoring session, in plan mode until the plan is approved.',
  },
  defaults: { title: 'Automation defaults', description: 'What every new run opens on.' },
});

export function headingFor(
  mode: RunSetupMode,
  ctx: { phase?: number },
): { title: string; description: string } {
  const entry = HEADINGS[mode];
  return typeof entry === 'function' ? entry(ctx) : entry;
}

/** Is this mode's overlay staged? Inline renders are always flat. */
export function isStaged(mode: RunSetupMode, overlay: boolean): boolean {
  return overlay && LAUNCH_SURFACE[mode] === 'staged';
}

/** The fields a mode shows on one stage, in the mode's own field order. */
export function fieldsOnStage(mode: RunSetupMode, stage: ControlStage): RunSetupField[] {
  return (MODES[mode].fields as readonly RunSetupField[]).filter((field) => STAGE_OF[field] === stage);
}

/** The stage a field is edited on — `review` never, so the return type says so. */
export function stageOf(field: RunSetupField): ControlStage {
  return STAGE_OF[field];
}

/** The four stages — or none, for a flat mode. */
export function stagesFor(mode: RunSetupMode, overlay: boolean): readonly Stage[] {
  return isStaged(mode, overlay) ? STAGES : [];
}

/** Does this mode show anything at all on a stage? A stage with no controls still shows its facts. */
export function stageHasControls(mode: RunSetupMode, stage: ControlStage): boolean {
  return fieldsOnStage(mode, stage).some((field) => shows(mode, field));
}

/**
 * Fields whose control has a condition BEYOND `shows(mode, field)` — and that
 * condition, over the live values.
 *
 * **Why this is a table and not four inline `&&`s.** `shows()` is static: it
 * answers what a MODE offers. Three of these fields are offered by the mode and
 * still not on screen, because a sibling value decides — a run with no branch of
 * its own has nothing to settle and nothing to check out, and a reviewer that is
 * off has no hold policy. Until this table existed the condition was written
 * twice and read once: `sections.tsx` gated the CONTROL on it and
 * `buildRunPayload` gated the PAYLOAD on it, while `summaryRows()` knew neither
 * — so the review listed "When the plan completes … Keep … changed here", with
 * a Change link into a stage where the control was gone, for a value the launch
 * did not carry (QA round 1, H1). The row was the only place all three
 * disagreed, and it was the one place an operator reads before pressing Launch.
 *
 * **The membership rule, and it is narrow:** a field belongs here when its
 * control condition is ALSO its payload condition — i.e. when the condition
 * being false means the value is neither editable NOR sent. That equality is
 * asserted per field against `buildRunPayload` in `stages.test.ts`, so a row
 * added here on a hunch fails rather than silently hiding a value the run
 * carries. A field that is posted regardless is NOT a member however
 * conditional its control is (`mcpPolicy` is the one such case today, named and
 * asserted in the same test): dropping ITS row would be the opposite lie.
 *
 * @see isLive — the predicate every reader asks
 */
export const LIVE_WHEN: Readonly<Partial<Record<RunSetupField, (values: RunSetupValues) => boolean>>> =
  Object.freeze({
    // A run with no branch of its own has nothing to settle, nothing to open a
    // PR for, and nothing to check out — `buildRunPayload` omits all three
    // under `default-branch`, and `sections.tsx` renders none of them.
    settle: (values: RunSetupValues) => values.gitMode === 'new-branch',
    openPr: (values: RunSetupValues) => values.gitMode === 'new-branch',
    isolation: (values: RunSetupValues) => values.gitMode === 'new-branch',
    // A hold policy with no reviewer to hold anything. Note the payload has a
    // SECOND route to `reviewerPolicy` (the cloud reviewer, `ultraReview !==
    // 'off'`), which is why the predicate reads the toggle rather than the
    // payload — see the `ultraReview` case in `stages.test.ts`.
    reviewerPolicy: (values: RunSetupValues) => values.reviewEachPhase,
  });

/**
 * Is this field's control on screen right now?
 *
 * The one question `sections.tsx` (should I render it), `summaryRows()` (should
 * I list it) and the review's Change link (where would this go) all ask, so
 * they cannot answer it differently.
 */
export function isLive(mode: RunSetupMode, field: RunSetupField, values: RunSetupValues): boolean {
  if (!shows(mode, field)) return false;
  const when = LIVE_WHEN[field];
  return when ? when(values) : true;
}
