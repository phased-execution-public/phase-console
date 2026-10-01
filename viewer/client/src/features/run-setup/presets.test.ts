/**
 * The preset row (control-tower phase 22): a preset is a PARTIAL value set
 * laid over the seed, it moves its declared keys and nothing else, Balanced
 * IS the baseline — and the Money tile's glance names the per-run rung cap a
 * preset may set (#14), so the number a spent cap's errand will name is
 * visible before the run can spend it.
 */

import { describe, expect, it } from 'vitest';
import { automationPrefs } from '@/lib/api';
import {
  BASELINE_PRESET,
  LAST_LAUNCH_PRESET,
  LAUNCH_PRESETS,
  PRESET_KEYS,
  PRESET_VALUES,
} from '@shared/launch-presets.js';
import { tileBadges } from './categories';
import { buildRunPayload, shows, type RunSetupMode } from './modes';
import { matchingPreset, presetsFor, presetValues, withPreset } from './presets';
import type { RunSetupField, RunSetupValues } from './schema';
import { BASELINE, seedFor } from './seed';
import { FIELD_LABELS } from './stages';

const RUN_DOOR_MODES: RunSetupMode[] = ['start', 'continue', 'phase'];

/** A seed that is NOT the baseline anywhere a preset could hide a leak. */
function busySeed(mode: RunSetupMode): RunSetupValues {
  const [seed] = seedFor(mode, {
    run: null,
    prefs: automationPrefs({ prefs: { gitMode: 'new-branch', mcpPolicy: 'require' } } as never),
    rawPrefs: { gitMode: 'new-branch', mcpPolicy: 'require' },
    context: { slug: 'alpha' },
    defaultSkills: [],
  });
  return {
    ...seed,
    model: 'sonnet',
    onlyPhases: '3, 4',
    runBudgetUsd: '40',
    permissionProfile: 'bypass',
    autonomy: 'halt-on-everything',
    maxConsecutiveFailures: '7',
    ladderPerRunRungs: '12',
  };
}

const MEMORY = {
  at: '2026-09-28T00:00:00.000Z',
  values: { model: 'haiku', permissionProfile: 'guarded' } as Partial<RunSetupValues>,
};

describe('the presets', () => {
  it('Balanced IS the baseline, key for key', () => {
    expect(BASELINE_PRESET).toBe('balanced');
    for (const key of PRESET_KEYS as readonly RunSetupField[]) {
      expect(PRESET_VALUES.balanced[key as keyof typeof PRESET_VALUES.balanced], key).toEqual(BASELINE[key]);
    }
    // And laying it over the baseline moves nothing at all.
    const [laid] = withPreset(BASELINE as RunSetupValues, {}, 'balanced', 'start', null);
    expect(laid).toEqual(BASELINE);
    expect(matchingPreset(BASELINE as RunSetupValues, 'start', null)).toBe('balanced');
  });

  it('all three declare the same keys, and every key is a field the form has', () => {
    for (const id of LAUNCH_PRESETS) {
      expect(Object.keys(PRESET_VALUES[id]).sort(), id).toEqual([...PRESET_KEYS].sort());
    }
    for (const key of PRESET_KEYS) expect(Object.keys(FIELD_LABELS), key).toContain(key);
    // Posture only: never a scope, a model, a branch or dollars.
    for (const never of ['onlyPhases', 'model', 'effort', 'gitMode', 'runBudgetUsd', 'phaseBudgetUsd']) {
      expect(PRESET_KEYS as readonly string[]).not.toContain(never);
    }
  });

  for (const mode of RUN_DOOR_MODES) {
    for (const id of [...LAUNCH_PRESETS, LAST_LAUNCH_PRESET] as const) {
      it(`${id} touches only its declared keys in ${mode}`, () => {
        const seed = busySeed(mode);
        const [laid, origins] = withPreset(seed, {}, id, mode, MEMORY);
        const declared = Object.keys(presetValues(id, mode, MEMORY));
        const moved = (Object.keys(seed) as RunSetupField[]).filter(
          (key) => JSON.stringify(laid[key]) !== JSON.stringify(seed[key]),
        );
        for (const key of moved) expect(declared, `${id} moved ${key}`).toContain(key);
        // Only fields this mode shows — a phase launch has no failure ceiling to set.
        for (const key of declared)
          expect(shows(mode, key as RunSetupField), `${id}: ${key} in ${mode}`).toBe(true);
        // Each moved key says where it came from; nothing else was re-marked.
        for (const key of Object.keys(origins)) expect(declared).toContain(key);
        for (const key of declared) {
          expect(origins[key as RunSetupField]).toBe(id === LAST_LAUNCH_PRESET ? 'last-launch' : 'preset');
        }
        expect(laid.onlyPhases).toBe(seed.onlyPhases);
        expect(laid.model).toBe(id === LAST_LAUNCH_PRESET ? 'haiku' : 'sonnet');
        expect(laid.gitMode).toBe(seed.gitMode);
        expect(laid.runBudgetUsd).toBe(seed.runBudgetUsd);
      });
    }
  }

  it('reads back as the preset whose every key the values agree with', () => {
    const [careful] = withPreset(BASELINE as RunSetupValues, {}, 'careful', 'start', null);
    expect(matchingPreset(careful, 'start', null)).toBe('careful');
    const [handsOff] = withPreset(BASELINE as RunSetupValues, {}, 'hands-off', 'start', null);
    expect(matchingPreset(handsOff, 'start', null)).toBe('hands-off');
    // One key off every preset is the operator's own mix.
    expect(
      matchingPreset({ ...handsOff, relay: 'off', maxConsecutiveFailures: '2' }, 'start', null),
    ).toBeNull();
  });

  it('offers Last launch only with a memory, and presets only through the run door', () => {
    expect(presetsFor('start', null)).toEqual(['careful', 'balanced', 'hands-off']);
    expect(presetsFor('start', MEMORY)).toEqual(['careful', 'balanced', 'hands-off', 'last-launch']);
    expect(presetsFor('live', null)).toEqual([]);
    expect(presetsFor('qa-fix', null)).toEqual([]);
  });
});

describe('the Money tile and the per-run rung cap (#14)', () => {
  const input = (values: RunSetupValues) => ({
    values,
    on: (field: RunSetupField) => shows('start', field),
    permission: (v: string) => v,
    account: (v: string) => v,
    ladderCaps: { perRun: 10, perPhase: 3 },
  });

  it("names the console's cap when the box is empty, and the run's own when it is set", () => {
    expect(tileBadges('money', input(BASELINE as RunSetupValues))).toContain('10 recovery rungs a run');
    expect(tileBadges('money', input({ ...(BASELINE as RunSetupValues), ladderPerRunRungs: '4' }))).toContain(
      '4 recovery rungs a run',
    );
  });

  it('shows the cap a preset set, and the payload carries it', () => {
    const [careful] = withPreset(BASELINE as RunSetupValues, {}, 'careful', 'start', null);
    expect(tileBadges('money', input(careful))).toContain('3 recovery rungs a run');
    expect(tileBadges('money', input(careful))).toContain('Stops after 1 failure');
    const payload = buildRunPayload('start', careful, { slug: 'alpha' });
    expect(payload).toMatchObject({
      ladderPerRunRungs: 3,
      maxConsecutiveFailures: 1,
      permissionProfile: 'guarded',
    });
    // Balanced sends what a fresh console sends: the empty box is an omission on a start.
    const [balanced] = withPreset(BASELINE as RunSetupValues, {}, 'balanced', 'start', null);
    expect('ladderPerRunRungs' in buildRunPayload('start', balanced, { slug: 'alpha' })).toBe(false);
  });
});
