/**
 * The form, as the stages see it.
 *
 * `RunSetup` owns the values, the seed, the provenance, the validation and the
 * one submit; the stages and sections are arrangement. Rather than thread
 * thirty props through four stages and twelve sections, the form publishes
 * ONE object through context and every section asks for it. The object is
 * data plus the four verbs a control needs (`set`, `on`, `src`, `submit`) —
 * nothing here decides what a field means.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { AccountView, IsolationPreflight, McpServerView, PhaseView, SkillInfo } from '@/lib/api';
import type { Source } from './fields';
import type { PressField, ToggleField } from './fields';
import type { RunSetupContext, RunSetupMode } from './modes';
import type { RunSetupField, RunSetupValues } from './schema';
import type { Origins } from './seed';
import type { StageId } from './stages';

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
  /** The boolean idiom for this mode: a checkbox on a launch, a pressed button on the defaults page. */
  Bool: typeof ToggleField | typeof PressField;

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
  qaMode?: string;
  pushBroken?: boolean;
  allowWrites?: boolean;
  skillsEnabled: boolean;
  canQaToggle: boolean;
  canAutoRecover: boolean;
  isolationPreflight: IsolationPreflight | undefined;
  concurrencyMax?: number;

  /* ---- the submit ---- */
  blocked: boolean;
  blockedReason?: string;
  busy: boolean;
  valid: boolean;
  submitLabel: string;
  submit: () => void;
  footerNote?: ReactNode;
  /** Go to a stage — present only in the staged overlay; the review's "Change" links read it. */
  goStage?: (stage: StageId) => void;
}

const SetupFormContext = createContext<SetupForm | null>(null);

export const SetupFormProvider = SetupFormContext.Provider;

export function useSetupForm(): SetupForm {
  const form = useContext(SetupFormContext);
  if (!form) throw new Error('useSetupForm() outside <RunSetup>');
  return form;
}
