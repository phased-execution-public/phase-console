/**
 * The form, as the tiles and sections see it.
 *
 * `RunSetup` owns the values, the seed, the provenance, the validation and the
 * one submit; the quick view and the sections are arrangement. Rather than
 * thread thirty props through nine tiles and twelve sections, the form publishes
 * ONE object through context and every section asks for it. The object is
 * data plus the four verbs a control needs (`set`, `on`, `src`, `submit`) —
 * nothing here decides what a field means.
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import type { SETTING_EFFECT_LABELS } from '@shared/run-settings.js';
import type {
  AccountView,
  IsolationPreflight,
  McpServerView,
  PhaseView,
  PlanReviewer,
  SkillInfo,
} from '@/data/api';
import type { CategoryId } from './model/categories';
import type { RunSetupContext, RunSetupMode } from './model/modes';
import type { PresetId } from './model/presets';
import type { RunSetupField, RunSetupValues } from './model/schema';
import type { Origins, Source } from './model/seed';

/**
 * When a change to a field lands on a LIVE run (control-tower phase 24, #31):
 * `SETTING_EFFECTS`' word for it — and, while a lane is working on a field the
 * door refuses under a live lane, the refusal in the sheet's own words.
 */
export interface FieldEffect {
  word: keyof typeof SETTING_EFFECT_LABELS;
  refused?: string;
}

/** What both boolean idioms are given — a field's label, its value and where the value came from. */
interface BoolFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  source?: Source;
  effect?: FieldEffect | undefined;
  value: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

/** A launch's checkbox — the reason it is off rides its hover. */
export interface ToggleFieldProps extends BoolFieldProps {
  disabledReason?: string;
}

/** The defaults page's pressed button — its two words. */
export interface PressFieldProps extends BoolFieldProps {
  on?: string;
  off?: string;
}

export interface SetupForm {
  mode: RunSetupMode;
  context: RunSetupContext;
  values: RunSetupValues;
  seed: RunSetupValues;
  origins: Origins;
  errors: Record<string, string>;
  set: <K extends RunSetupField>(field: K, next: RunSetupValues[K]) => void;
  /** Does this mode show that field? */
  on: (field: RunSetupField) => boolean;
  /**
   * Is that field's control on screen RIGHT NOW — `on()` plus whatever sibling
   * value it depends on (`LIVE_WHEN` in `stages.ts`)?
   *
   * A section that gates a control on a value writes `f.live('settle')` rather
   * than `f.on('settle') && branch`, so the condition has one author. The
   * review asks the same question before listing the row, which is what stops
   * it describing a decision the launch will not carry.
   */
  live: (field: RunSetupField) => boolean;
  /** Where the field's current value came from — undefined on the defaults page. */
  src: (field: RunSetupField) => Source | undefined;
  /**
   * When a change to the field lands — on a live run's settings sheet only
   * (control-tower phase 24, #31); undefined on every other mode.
   */
  fx: (field: RunSetupField) => FieldEffect | undefined;
  /** The boolean idiom for this mode: a checkbox on a launch, a pressed button on the defaults page. */
  Bool: ((props: ToggleFieldProps) => ReactElement) | ((props: PressFieldProps) => ReactElement);

  /* ---- the vocabularies, prepared by the form (single-source keeps them there) ---- */
  models: readonly string[];
  modelOptions: readonly (readonly [string, string])[];
  effortOptions: readonly (readonly [string, string])[];
  permissionOptions: readonly (readonly [string, string])[];
  /** The one-line qualifier of a profile — the part after the dash in its label. */
  permissionQualifier: (choice: string) => string;
  /** The profile's short name — the part before the dash. */
  permissionName: (choice: string) => string;
  permissionHint: (choice: string) => string;
  accounts: AccountView[];
  accountName: (id: string) => string;
  skills: SkillInfo[];
  mcpServers: McpServerView[];
  defaultSkills: string[];
  planSkills: string[];
  planMcp: string[];
  planPhases: PhaseView[];
  /** Where the plan orders its own reviewer — what the review-doubled advisory reads. */
  planReviewers: PlanReviewer[];
  qaMode?: string;
  pushBroken?: boolean;
  allowWrites?: boolean;
  /**
   * `--allow-publish` on this console — what `Landing: pr|trunk` and
   * `Issues: file` will actually DO here (phase 15). `false` draws the hint
   * that names the flag; undefined (an older server) says nothing.
   */
  allowPublish?: boolean;
  skillsEnabled: boolean;
  canQaToggle: boolean;
  canAutoRecover: boolean;
  isolationPreflight: IsolationPreflight | undefined;
  concurrencyMax?: number;
  /**
   * This console's own rung caps (Settings ▸ the ladder card) — what an empty
   * "Recovery rungs" box falls back to, so its hint names the number.
   */
  ladderCaps?: { perRun: number; perPhase: number };

  /* ---- the submit ---- */
  blocked: boolean;
  blockedReason?: string;
  busy: boolean;
  valid: boolean;
  submitLabel: string;
  submit: () => void;
  footerNote?: ReactNode;
  /**
   * The quick view's one expanded tile, and the verb that opens one (null
   * folds it) — present only in the staged overlay; the tiles' Edit and the
   * review's Change links read them (control-tower phase 22).
   */
  openCategory?: CategoryId | null;
  goCategory?: (id: CategoryId | null) => void;
  /** The preset row: the choices this launch offers, the one on screen, and the verb that lays one over the seed. */
  presets?: readonly PresetId[];
  preset?: PresetId | null;
  choosePreset?: (id: PresetId) => void;
}

const SetupFormContext = createContext<SetupForm | null>(null);

export const SetupFormProvider = SetupFormContext.Provider;

export function useSetupForm(): SetupForm {
  const form = useContext(SetupFormContext);
  if (!form) throw new Error('useSetupForm() outside <RunSetup>');
  return form;
}
