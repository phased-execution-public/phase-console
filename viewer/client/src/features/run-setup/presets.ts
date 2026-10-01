/**
 * The preset row, in the form's own terms (control-tower phase 22).
 *
 * The table is `shared/launch-presets.js`; this is how the form lays one over
 * its seed. A chosen preset is a SEED layer, not a set of edits: its values
 * sit under the operator's own touches, and every key it moved reads *from
 * preset* until somebody changes it — so the review can still tell a posture
 * the operator picked from one they typed, and a value changed after the pick
 * still says *changed here*.
 */

import {
  BASELINE_PRESET,
  LAST_LAUNCH_PRESET,
  LAUNCH_PRESETS,
  PRESET_KEYS,
  PRESET_VALUES,
} from '@shared/launch-presets.js';
import type { Source } from './fields';
import type { LaunchMemory } from './launch-memory';
import { REMEMBERED_FIELDS } from './launch-memory';
import { MODES, shows, type RunSetupMode } from './modes';
import type { RunSetupField, RunSetupValues } from './schema';
import type { Origins } from './seed';

export type PresetId = (typeof LAUNCH_PRESETS)[number] | typeof LAST_LAUNCH_PRESET;

export { BASELINE_PRESET, LAST_LAUNCH_PRESET };

/** Presets are offered on a launch through the run door — a start, a continue, one phase. */
export function offersPresets(mode: RunSetupMode): boolean {
  return MODES[mode].door === 'runStart';
}

/** The choices a launch offers: the three, then the last launch when this browser has one. */
export function presetsFor(mode: RunSetupMode, memory: LaunchMemory | null): PresetId[] {
  if (!offersPresets(mode)) return [];
  return memory ? [...LAUNCH_PRESETS, LAST_LAUNCH_PRESET] : [...LAUNCH_PRESETS];
}

/**
 * What a choice moves in THIS mode — its declared keys, narrowed to the
 * fields the mode shows (a phase launch has no failure ceiling to set).
 */
export function presetValues(
  id: PresetId,
  mode: RunSetupMode,
  memory: LaunchMemory | null,
): Partial<RunSetupValues> {
  const out: Partial<RunSetupValues> = {};
  if (id === LAST_LAUNCH_PRESET) {
    for (const field of REMEMBERED_FIELDS) {
      const value = memory?.values[field];
      if (value !== undefined && shows(mode, field)) Object.assign(out, { [field]: value });
    }
    return out;
  }
  const table = PRESET_VALUES[id] as Readonly<Record<string, unknown>>;
  for (const key of PRESET_KEYS as readonly RunSetupField[]) {
    if (shows(mode, key)) Object.assign(out, { [key]: table[key] });
  }
  return out;
}

/** The seed with a choice laid over it, and origins that say where each moved value came from. */
export function withPreset(
  seed: RunSetupValues,
  origins: Origins,
  id: PresetId | null,
  mode: RunSetupMode,
  memory: LaunchMemory | null,
): [RunSetupValues, Origins] {
  if (!id) return [seed, origins];
  const partial = presetValues(id, mode, memory);
  const source: Source = id === LAST_LAUNCH_PRESET ? 'last-launch' : 'preset';
  const next: Origins = { ...origins };
  for (const field of Object.keys(partial) as RunSetupField[]) next[field] = source;
  return [{ ...seed, ...partial }, next];
}

/** Do the live values agree with a choice on every key it moves? */
export function presetAgrees(
  id: PresetId,
  values: RunSetupValues,
  mode: RunSetupMode,
  memory: LaunchMemory | null,
): boolean {
  const partial = presetValues(id, mode, memory);
  const keys = Object.keys(partial) as RunSetupField[];
  return keys.length > 0 && keys.every((key) => JSON.stringify(values[key]) === JSON.stringify(partial[key]));
}

/** The choice the live values agree with — the first, in the row's order; null is the operator's own mix. */
export function matchingPreset(
  values: RunSetupValues,
  mode: RunSetupMode,
  memory: LaunchMemory | null,
): PresetId | null {
  return presetsFor(mode, memory).find((id) => presetAgrees(id, values, mode, memory)) ?? null;
}
