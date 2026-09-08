/**
 * The launch memory — what is kept, what is deliberately not, and how it ages.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY, type RunSetupValues } from './schema';
import { BASELINE } from './seed';
import {
  LAUNCH_MEMORY_KEY,
  MAX_PLANS,
  REMEMBERED_FIELDS,
  forgetLaunch,
  recallLaunch,
  rememberLaunch,
} from './launch-memory';

const all = () => true;
const at = (iso: string) => () => new Date(iso);

beforeEach(() => localStorage.clear());

describe('what is remembered', () => {
  it('keeps only the remembered fields that differ from the shipped baseline', () => {
    const values: RunSetupValues = {
      ...BASELINE,
      model: 'fable',
      runBudgetUsd: '60',
      onlyPhases: '3',
      qa: true,
    };
    rememberLaunch('alpha', values, BASELINE, all, at('2026-09-05T10:00:00Z'));
    expect(recallLaunch('alpha')).toEqual({
      at: '2026-09-05T10:00:00.000Z',
      values: { model: 'fable', runBudgetUsd: '60' },
    });
  });

  it('never keeps a scope, an activation, or a per-phase matrix', () => {
    for (const field of [
      'onlyPhases',
      'startAfter',
      'qa',
      'phaseOptions',
      'openPr',
      'permissionMode',
      'prompt',
    ] as const) {
      expect(REMEMBERED_FIELDS).not.toContain(field);
    }
  });

  it('keeps only what the mode showed', () => {
    const values: RunSetupValues = { ...BASELINE, model: 'fable', runBudgetUsd: '60' };
    rememberLaunch('alpha', values, BASELINE, (field) => field !== 'runBudgetUsd');
    expect(recallLaunch('alpha')?.values).toEqual({ model: 'fable' });
  });

  it('forgets a plan launched entirely on the defaults', () => {
    rememberLaunch('alpha', { ...BASELINE, model: 'fable' }, BASELINE, all);
    expect(recallLaunch('alpha')).not.toBeNull();
    rememberLaunch('alpha', { ...BASELINE }, BASELINE, all);
    expect(recallLaunch('alpha')).toBeNull();
    expect(localStorage.getItem(LAUNCH_MEMORY_KEY)).toBe('{}');
  });

  it('answers null for a plan it has never seen, and after forgetting', () => {
    expect(recallLaunch('never')).toBeNull();
    expect(recallLaunch(undefined)).toBeNull();
    rememberLaunch('alpha', { ...BASELINE, model: 'fable' }, BASELINE, all);
    forgetLaunch('alpha');
    expect(recallLaunch('alpha')).toBeNull();
  });
});

describe('what survives a read', () => {
  it('drops a stored value whose shape this build does not know', () => {
    localStorage.setItem(
      LAUNCH_MEMORY_KEY,
      JSON.stringify({
        alpha: {
          at: 'x',
          values: { model: 42, skills: 'not-a-list', mcpServers: ['ok'], notAField: true, onlyPhases: '3' },
        },
      }),
    );
    expect(recallLaunch('alpha')?.values).toEqual({ mcpServers: ['ok'] });
  });

  it('survives garbage in the key', () => {
    localStorage.setItem(LAUNCH_MEMORY_KEY, '{not json');
    expect(recallLaunch('alpha')).toBeNull();
    rememberLaunch('alpha', { ...BASELINE, model: 'fable' }, BASELINE, all);
    expect(recallLaunch('alpha')?.values).toEqual({ model: 'fable' });
  });

  it('evicts the oldest plan past the cap', () => {
    for (let i = 0; i < MAX_PLANS + 3; i += 1) {
      rememberLaunch(
        `plan-${i}`,
        { ...BASELINE, model: 'fable' },
        BASELINE,
        all,
        at(`2026-09-05T10:${String(i).padStart(2, '0')}:00Z`),
      );
    }
    expect(recallLaunch('plan-0')).toBeNull();
    expect(recallLaunch('plan-2')).toBeNull();
    expect(recallLaunch('plan-3')).not.toBeNull();
    expect(recallLaunch(`plan-${MAX_PLANS + 2}`)).not.toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(LAUNCH_MEMORY_KEY)!) as object)).toHaveLength(
      MAX_PLANS,
    );
  });

  it('the shape it stores is the value shape, so a field renamed here is caught', () => {
    for (const field of REMEMBERED_FIELDS) expect(field in EMPTY, field).toBe(true);
  });
});
