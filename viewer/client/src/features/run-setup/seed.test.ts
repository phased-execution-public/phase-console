/**
 * Where a launch opens, and where each value says it came from.
 *
 * The precedence is the contract: the run's record beats the browser's last
 * launch beats a Settings preference beats the shipped default — and each
 * rung is NAMED on the field, so the review can list it.
 */

import { describe, expect, it } from 'vitest';
import { automationPrefs, type RunState } from '@/lib/api';
import { seedFor } from './seed';

const prefsOf = (raw: Record<string, unknown>) => ({
  prefs: automationPrefs({ prefs: raw } as never),
  rawPrefs: raw,
});

describe('a fresh start', () => {
  it('opens on the shipped defaults, and says "from defaults"', () => {
    const [values, origins] = seedFor('start', {
      run: null,
      ...prefsOf({}),
      context: { slug: 'a' },
      defaultSkills: [],
    });
    expect(values.gitMode).toBe('default-branch');
    expect(origins.gitMode).toBe('defaults');
    expect(origins.model).toBe('defaults');
  });

  it('opens on a Settings preference where one was SET, and says "from Settings"', () => {
    const [values, origins] = seedFor('start', {
      run: null,
      ...prefsOf({ gitMode: 'new-branch', reviewEachPhaseByDefault: true }),
      context: { slug: 'a' },
      defaultSkills: [],
    });
    expect(values.gitMode).toBe('new-branch');
    expect(origins.gitMode).toBe('prefs');
    expect(origins.reviewEachPhase).toBe('prefs');
    // A key nobody set is still the shipped default, whatever `automationPrefs` filled in.
    expect(origins.autoRecover).toBe('defaults');
    expect(origins.isolation).toBe('defaults');
  });

  it('reads the old `openPrOnComplete` key as a Settings answer for settle', () => {
    const [values, origins] = seedFor('start', {
      run: null,
      ...prefsOf({ openPrOnComplete: false }),
      context: { slug: 'a' },
      defaultSkills: [],
    });
    expect(values.settle).toBe('keep');
    expect(origins.settle).toBe('prefs');
  });
});

describe('this browser’s last launch of the plan', () => {
  const memory = {
    at: '2026-09-05T10:00:00.000Z',
    values: { model: 'fable', runBudgetUsd: '60', onlyPhases: '3' },
  };

  it('outranks a preference and says "from your last launch"', () => {
    const [values, origins] = seedFor('start', {
      run: null,
      ...prefsOf({ gitMode: 'new-branch' }),
      context: { slug: 'a' },
      defaultSkills: [],
      memory,
    });
    expect(values.model).toBe('fable');
    expect(origins.model).toBe('last-launch');
    expect(values.runBudgetUsd).toBe('60');
    // A scope is never remembered, even if a stale entry carries one.
    expect(values.onlyPhases).toBe('');
    // …and a preference the memory did not touch still reads as Settings.
    expect(origins.gitMode).toBe('prefs');
  });

  it('never outranks the run being continued', () => {
    const run = { id: 'r1', slug: 'a', status: 'halted', model: 'sonnet', phases: {} } as unknown as RunState;
    const [values, origins] = seedFor('continue', {
      run,
      ...prefsOf({}),
      context: { slug: 'a', run },
      defaultSkills: [],
      memory,
    });
    expect(values.model).toBe('sonnet');
    expect(origins.model).toBe('run');
  });

  it('applies only to the fields the mode shows', () => {
    // A `phase` launch shows no budget, so a remembered budget stays out of it
    // (and therefore out of its payload — `buildRunPayload` reads only shown fields).
    const [values, origins] = seedFor('phase', {
      run: null,
      ...prefsOf({}),
      context: { slug: 'a', phase: 2 },
      defaultSkills: [],
      memory,
    });
    expect(values.model).toBe('fable');
    expect(origins.model).toBe('last-launch');
    expect(values.runBudgetUsd).toBe('');
    expect(origins.runBudgetUsd).toBe('defaults');
  });
});
