/**
 * The opening values of the form, and where each came from.
 *
 * Moved out of `run-setup.tsx` in Phase 8 so the review stage and the tests
 * can ask the same question the form asks — "what does this launch open on,
 * and why" — without rendering anything. The order of precedence is the same
 * everywhere and is the reason this is one function:
 *
 *   **the run's own record** beats **this browser's last launch of the plan**
 *   beats **a Settings ▸ Automation preference** beats **the shipped default**.
 *
 * A resume that re-derived from preferences would silently re-attach something
 * the operator had unticked; a fresh run that ignored preferences would make
 * Settings ▸ Automation decorative; and a memory that outranked a run would
 * turn a continue into a different run from the one being continued.
 */

import { type RunState, automationPrefs } from '@/lib/api';
import { DEFAULTS } from '@/features/runs/defaults';
import { runPriority } from '@shared/orchestration-model.js';
import { isolationMode, settleOf } from '@shared/worktree-model.js';
import type { Source } from './fields';
import type { LaunchMemory } from './launch-memory';
import { REMEMBERED_FIELDS } from './launch-memory';
import type { RunSetupContext, RunSetupMode } from './modes';
import { shows } from './modes';
import { EMPTY, formatAccounts, formatPhases, type RunSetupField, type RunSetupValues } from './schema';

/** Where each field's opening value came from, so provenance can say so. */
export type Origins = Partial<Record<RunSetupField, Source>>;

export type Prefs = ReturnType<typeof automationPrefs>;

export interface SeedInput {
  run: RunState | null;
  /** The folded preferences — every key answered, defaults filled in. */
  prefs: Prefs;
  /**
   * The preferences AS STORED — only the keys somebody set. This is what
   * tells "from Settings" apart from "from defaults": `prefs` above answers
   * every key, and cannot say whether the answer was chosen.
   */
  rawPrefs?: Record<string, unknown>;
  qaMode?: string;
  context: RunSetupContext;
  defaultSkills: string[];
  /** This browser's last launch of the plan, when there was one. Null is "never". */
  memory?: LaunchMemory | null;
}

/**
 * Which stored preference key answers each preference-seeded field. A field
 * whose key is present in the raw preferences opened "from Settings"; one
 * whose key is absent opened on the shipped default that `automationPrefs`
 * filled in.
 */
const PREF_SOURCE: Readonly<Partial<Record<RunSetupField, readonly string[]>>> = Object.freeze({
  gitMode: ['gitMode'],
  openPr: ['openPrOnComplete'],
  settle: ['settle', 'openPrOnComplete'],
  isolation: ['isolation'],
  reviewEachPhase: ['reviewEachPhaseByDefault'],
  reviewerPolicy: ['reviewerPolicy'],
  attachDefaultSkills: ['attachDefaultSkills'],
  mcpPolicy: ['mcpPolicy'],
  autoRecover: ['autoRecoverByDefault'],
});

export function seedFor(mode: RunSetupMode, input: SeedInput): [RunSetupValues, Origins] {
  const { run, prefs, context, defaultSkills } = input;
  const rawPrefs = input.rawPrefs ?? {};
  const origins: Origins = {};
  const mark = <K extends RunSetupField>(field: K, from: Source) => {
    origins[field] = from;
  };
  const values: RunSetupValues = { ...EMPTY };

  if (mode === 'defaults') {
    values.attachDefaultSkills = prefs.attachDefaultSkills;
    values.qa = prefs.qaByDefault;
    values.gitMode = prefs.gitMode;
    values.openPr = prefs.openPrOnComplete;
    // Through the fold, not from the newer key alone: a `config.json` written
    // before this setting existed carries only `openPrOnComplete`, and the
    // server hands it back beside a `settle` that is merely the shipped
    // default. Reading `prefs.settle` directly would show that operator a form
    // saying "open a pull request" over a preference that says the opposite.
    values.settle = settleOf({ settle: prefs.settle, openPr: prefs.openPrOnComplete });
    values.isolation = prefs.isolation;
    values.reviewEachPhase = prefs.reviewEachPhaseByDefault;
    values.reviewerPolicy = prefs.reviewerPolicy;
    values.autoRecover = prefs.autoRecoverByDefault;
    values.mcpPolicy = prefs.mcpPolicy;
    return [values, origins];
  }

  if (mode === 'qa' || mode === 'recovery') {
    // A review opens on what the PLAN asked for this phase, when it asked;
    // a recovery opens on nothing, because "the machine's default" is the
    // honest answer for a session whose job is to read and fix.
    values.model = mode === 'qa' ? (context.qaModel ?? '') : '';
    values.effort = mode === 'qa' ? (context.qaEffort ?? '') : '';
    if (mode === 'qa' && (context.qaModel || context.qaEffort)) {
      mark('model', 'plan');
      mark('effort', 'plan');
    }
    values.permissionProfile = 'guarded';
    // The activation box opens TICKED: somebody asking for a review on a plan
    // that gates nothing usually means it to start gating.
    values.qa = mode === 'qa' && Boolean(context.activate);
    values.skills = context.planSkills ?? [];
    if (context.planSkills?.length) mark('skills', 'plan');
    values.attachDefaultSkills = prefs.attachDefaultSkills && defaultSkills.length > 0;
    if (values.attachDefaultSkills && 'attachDefaultSkills' in rawPrefs) mark('attachDefaultSkills', 'prefs');
    return [values, origins];
  }

  if (mode === 'session' || mode === 'plan') {
    values.model = DEFAULTS.model;
    values.effort = DEFAULTS.effort;
    values.permissionProfile = 'guarded';
    values.permissionMode = '';
    // The wizard's ticket has no attach flag, so a ticked box means the names
    // ride inside `skills` — `buildLaunch` does the merge.
    values.attachDefaultSkills = prefs.attachDefaultSkills && defaultSkills.length > 0;
    if (values.attachDefaultSkills && 'attachDefaultSkills' in rawPrefs) mark('attachDefaultSkills', 'prefs');
    return [values, origins];
  }

  // start | continue | phase | live — the run answers for itself where it can.
  values.model = run?.model ?? DEFAULTS.model;
  values.effort = run?.effort ?? (run ? '' : DEFAULTS.effort);
  values.autonomy = run?.autonomy ?? DEFAULTS.autonomy;
  // Absent has always meant `guarded` on disk for an EXISTING run; a run that
  // does not exist yet opens on the client default.
  values.permissionProfile = run?.permissionProfile ?? (run ? 'guarded' : DEFAULTS.permissionProfile);
  values.accountId = run?.accountId ?? 'default';
  values.onLimit = run?.onLimit ?? 'switch';
  values.phaseBudgetUsd = run?.phaseBudgetUsd == null ? '' : String(run.phaseBudgetUsd);
  values.runBudgetUsd = run?.runBudgetUsd == null ? '' : String(run.runBudgetUsd);
  values.gitMode = run?.gitMode ?? (run ? 'default-branch' : prefs.gitMode);
  values.openPr = run?.openPr ?? (run ? true : prefs.openPrOnComplete);
  // The same fold, one source further along: an EXISTING run answers from its
  // own two fields (`settleOf` reads `openPr` when it predates `settle`), and
  // a run that does not exist yet answers from the preference the same way.
  values.settle = run
    ? settleOf(run as { settle?: unknown; openPr?: unknown })
    : settleOf({ settle: prefs.settle, openPr: prefs.openPrOnComplete });
  // Isolation seeds like the reviewer rather than like `openPr`: absent on an
  // existing run means QUEUE, not "fall back to the preference". A live run's
  // form must open on what the run IS — showing it as isolated because the
  // preference says so is how an operator saves a settings patch believing they
  // changed nothing and gets a 409 for the raise they did not know they made.
  values.isolation = run ? isolationMode(run.isolation) : prefs.isolation;
  // The class and the chain answer from the RUN when there is one, with no
  // preference behind either: a priority is a statement about this plan
  // against the others queued beside it, so a machine-wide default for it
  // would be a default about nothing. Absent on a run means `normal` and no
  // chain, which is what every run file written before this feature says.
  values.priority = runPriority(run?.priority);
  values.startAfter = run?.startAfter ?? '';
  // A run answers for itself; a fresh start takes the preference. Absent on
  // the run means OFF, not "fall back to the pref" — unlike `openPr`, whose
  // absent-under-new-branch state means true.
  values.reviewEachPhase = run ? Boolean(run.reviewEachPhase) : prefs.reviewEachPhaseByDefault;
  values.reviewerPolicy = run
    ? run.reviewerPolicy === 'may-hold'
      ? 'may-hold'
      : 'comment-only'
    : prefs.reviewerPolicy;
  // No preference for either: both spend, and an opt-in that spends is chosen
  // for a run in front of somebody. A run answers for itself; a fresh start is
  // off. (`off` and absent are one state on disk, which is why this reads the
  // word rather than a boolean.)
  values.ultracode = Boolean(run?.ultracode);
  values.ultraReview = run?.ultraReview ?? 'off';
  values.qa = false;
  // A run that EXISTS answers for itself, empty list included: `state.skills`
  // is deleted when empty, so an absent list on a real run means the operator
  // turned them all off — re-seeding the machine defaults over that would make
  // the box impossible to untick.
  values.skills = run ? (run.skills ?? []) : [];
  values.attachDefaultSkills = run ? false : prefs.attachDefaultSkills && defaultSkills.length > 0;
  values.mcpServers = run?.mcpServers ?? [];
  // An EXISTING run with no `mcpPolicy` is `continue` (absent means that on
  // disk, including on runs written before the key existed), so a resume must
  // not silently pick up a `require` preference the run never had.
  values.mcpPolicy = run?.mcpPolicy ?? (run ? 'continue' : prefs.mcpPolicy);
  values.autoRecover = run ? Boolean(run.autoRecover) : prefs.autoRecoverByDefault;
  values.maxParallel = run?.maxParallel ? String(run.maxParallel) : '';
  values.maxConsecutiveFailures = run?.maxConsecutiveFailures ? String(run.maxConsecutiveFailures) : '';
  // CLEARED for a continue, not seeded from the run — client-11.
  //
  // The dialog's own description promises "the scope is cleared — a continue
  // never silently inherits a single-phase run", and `modes.ts` repeats it in
  // a comment; the seed said the opposite. An operator who ran `only phase 3`,
  // watched it halt and pressed Continue expecting the rest of the plan got a
  // box pre-filled with `3` and a payload that carried it.
  //
  // Fixed by making the BEHAVIOUR match the promise rather than the promise
  // match the behaviour, because the two errors are not equal: a continue that
  // silently re-narrows leaves fourteen phases unrun and looks like a finished
  // plan, while a continue that widens runs work the operator was going to ask
  // for anyway — and the box is right there to narrow again.
  values.onlyPhases = mode === 'phase' || mode === 'continue' ? '' : formatPhases(run?.onlyPhases);
  values.phaseOptions = run?.phaseOptions ?? {};
  // The prelude's answers (phase 11): an EXISTING run answers for itself (a
  // resume keeps them; the door re-reads nothing), a fresh start opens on the
  // shipped words — continue after a restart, no relay — and an EMPTY account
  // list the Decisions stage fills from the plan's clause once the prelude
  // answers. A waiver is acknowledged per launch, never carried over.
  values.resumeOnRestart = run?.resumeOnRestart ?? true;
  values.relay = run?.relay ?? 'off';
  values.accounts = run ? formatAccounts(run.accounts) : '';
  values.acknowledgedWaivers = [];
  values.manifestOverride = '';

  for (const field of RUN_SEEDED) mark(field, run ? 'run' : 'defaults');

  if (!run) {
    // A preference-seeded field whose key somebody SET opened from Settings.
    for (const [field, keys] of Object.entries(PREF_SOURCE) as [RunSetupField, readonly string[]][]) {
      if (keys.some((key) => rawPrefs[key] !== undefined)) mark(field, 'prefs');
    }
    // Then this browser's last launch of the plan, over the preference and
    // under the run — only the remembered fields, only the ones this mode
    // shows, and each one says so.
    const memory = input.memory?.values;
    if (memory) {
      for (const field of REMEMBERED_FIELDS) {
        const value = memory[field];
        if (value === undefined || !shows(mode, field)) continue;
        Object.assign(values, { [field]: value });
        mark(field, 'last-launch');
      }
    }
  }
  return [values, origins];
}

/**
 * Fields whose opening value comes from the run when there is one.
 *
 * ⚠️ **This list is the PROVENANCE, and a field seeded from the run and left
 * out of it lies to the operator.** `src()` reads `origins[field] ?? 'defaults'`,
 * so an unlisted field renders *from defaults* under a value it actually took
 * off the run — and provenance exists precisely so somebody can tell a value
 * they are inheriting from one they are about to change. Four fields were
 * seeded at the bottom of `seedFor` and never marked here: `settle`,
 * `reviewEachPhase`, `reviewerPolicy` and `attachDefaultSkills`.
 *
 * The test for membership is the seed expression, not the field's importance:
 * if it reads `run ? … : …`, it belongs here. `qa` deliberately does NOT —
 * it is a hard `false` for every mode and takes nothing from either side, so
 * claiming it came from the run would be the same lie in the other direction.
 */
export const RUN_SEEDED = [
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
  'settle',
  'isolation',
  'priority',
  'startAfter',
  'reviewEachPhase',
  'reviewerPolicy',
  'ultracode',
  'ultraReview',
  'skills',
  'attachDefaultSkills',
  'mcpServers',
  'mcpPolicy',
  'autoRecover',
  'maxParallel',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
  'resumeOnRestart',
  'relay',
  'accounts',
] as const satisfies readonly RunSetupField[];

/**
 * What a fresh console launches with when nobody has set anything — the
 * shipped baseline every summary row is compared against. Computed through
 * the seed rather than written out, so it cannot drift from what a launch
 * actually opens on.
 */
export const BASELINE: Readonly<RunSetupValues> = Object.freeze({
  ...seedFor('start', {
    run: null,
    prefs: automationPrefs(undefined),
    rawPrefs: {},
    context: {},
    defaultSkills: [],
  })[0],
  // The account list a fresh console launches with once the prelude answers
  // for a plan naming none: the machine login, no minimum. The seed itself
  // leaves the field empty until the prelude fills it (`run-setup.tsx`), so the
  // shipped answer is stated here rather than read out of a fetch.
  accounts: 'default:0',
});
