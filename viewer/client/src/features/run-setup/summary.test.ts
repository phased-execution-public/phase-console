/**
 * The review as data — what it lists, what it says, and what it never says.
 *
 * No DOM: these are the functions the review stage and the desk's ticket
 * render, asserted on the values the payload is built from.
 */

import { describe, expect, it } from 'vitest';
import { automationPrefs } from '@/lib/api';
import { buildRunPayload } from './modes';
import type { RunSetupValues } from './schema';
import { EMPTY } from './schema';
import { BASELINE, seedFor } from './seed';
import {
  ceilings,
  changedPerStage,
  departureLine,
  notableRows,
  phraseOfPhases,
  stopsWhen,
  summaryRows,
  valueText,
} from './summary';

const names = {
  permission: (v: string) => ({ guarded: 'Guarded', trusted: 'Trusted', bypass: 'Bypass' })[v] ?? v,
  account: (id: string) => (id === 'default' ? 'machine login' : id),
};

const fresh = () =>
  seedFor('start', {
    run: null,
    prefs: automationPrefs(undefined),
    rawPrefs: {},
    context: { slug: 'alpha' },
    defaultSkills: [],
  });

describe('the baseline', () => {
  it('is what a fresh console launches with — opus, max, keep going, trusted, switch', () => {
    expect(BASELINE.model).toBe('opus');
    expect(BASELINE.effort).toBe('max');
    expect(BASELINE.autonomy).toBe('keep-going');
    expect(BASELINE.permissionProfile).toBe('trusted');
    expect(BASELINE.onLimit).toBe('switch');
    expect(BASELINE.gitMode).toBe('default-branch');
  });
});

describe('the rows', () => {
  it('lists nothing as notable for a fresh console with nothing set', () => {
    const [seed, origins] = fresh();
    const rows = summaryRows('start', seed, seed, origins, names);
    expect(rows.length).toBeGreaterThan(20);
    expect(notableRows(rows)).toEqual([]);
    expect(changedPerStage(rows)).toEqual({ decisions: 0, what: 0, how: 0, money: 0 });
  });

  it('lists a value the operator changed here, with its stage and its source', () => {
    const [seed, origins] = fresh();
    const values: RunSetupValues = { ...seed, model: 'sonnet', runBudgetUsd: '40' };
    const rows = summaryRows('start', values, seed, origins, names);
    const notable = notableRows(rows);
    expect(notable.map((r) => [r.field, r.stage, r.source, r.value])).toEqual([
      ['model', 'how', 'changed', 'sonnet'],
      ['runBudgetUsd', 'money', 'changed', '$40.00'],
    ]);
    expect(changedPerStage(rows)).toEqual({ decisions: 0, what: 0, how: 1, money: 1 });
  });

  it('lists a preference that changed the shipped default, and says it came from Settings', () => {
    const prefs = automationPrefs({ prefs: { gitMode: 'new-branch', settle: 'keep' } } as never);
    const [seed, origins] = seedFor('start', {
      run: null,
      prefs,
      rawPrefs: { gitMode: 'new-branch', settle: 'keep' },
      context: { slug: 'alpha' },
      defaultSkills: [],
    });
    const notable = notableRows(summaryRows('start', seed, seed, origins, names));
    expect(notable.map((r) => [r.field, r.source])).toEqual([
      ['gitMode', 'prefs'],
      ['settle', 'prefs'],
    ]);
  });

  it('lists a value changed BACK to the default — the decision is still a decision', () => {
    const prefs = automationPrefs({ prefs: { gitMode: 'new-branch' } } as never);
    const [seed, origins] = seedFor('start', {
      run: null,
      prefs,
      rawPrefs: { gitMode: 'new-branch' },
      context: { slug: 'alpha' },
      defaultSkills: [],
    });
    const values: RunSetupValues = { ...seed, gitMode: 'default-branch' };
    const notable = notableRows(summaryRows('start', values, seed, origins, names));
    expect(notable.map((r) => [r.field, r.source, r.baseline])).toEqual([['gitMode', 'changed', true]]);
  });

  it('never lists the two fields another control owns, nor an empty per-phase matrix', () => {
    const [seed, origins] = fresh();
    const fields = summaryRows('start', { ...seed, gitMode: 'new-branch' }, seed, origins, names).map(
      (r) => r.field,
    );
    expect(fields).not.toContain('openPr');
    expect(fields).not.toContain('permissionMode');
    expect(fields).not.toContain('phaseOptions');
    expect(fields).toContain('settle');
  });

  /* ---- QA round 1, H1: a row for a value the launch will not carry ---- */

  it('drops a value whose control the operator has since switched off', () => {
    // The sequence QA reproduced: choose a work branch, pick a settle strategy,
    // then go back to the current branch. `touched.settle` is never cleared —
    // deliberately, so switching back restores the choice — so the value still
    // differs from its seed and `sourceOf` still calls it "changed here". The
    // review used to list it, with a Change link into a stage where the control
    // is gone, for a key `buildRunPayload` does not send.
    const [seed, origins] = fresh();
    const values: RunSetupValues = { ...seed, gitMode: 'default-branch', settle: 'keep' };
    const rows = summaryRows('start', values, seed, origins, names);
    expect(rows.map((r) => r.field)).not.toContain('settle');
    expect(rows.map((r) => r.field)).not.toContain('isolation');
    expect('settle' in buildRunPayload('start', values, {})).toBe(false);
    // …and the decision comes back the moment the branch does, unchanged.
    const back: RunSetupValues = { ...values, gitMode: 'new-branch' };
    const again = summaryRows('start', back, seed, origins, names).find((r) => r.field === 'settle');
    expect(again?.value).toBe('Keep — leave the branch and its checkout exactly where they are');
    expect(again?.source).toBe('changed');
    expect(again?.live).toBe(true);
  });

  it('drops the hold policy when no reviewer is on, and keeps it when the CLOUD one is', () => {
    // The asymmetry `isLive` alone would get wrong: the control belongs to the
    // per-phase reviewer, but the payload writes the policy for the cloud
    // reviewer too. Listed either way it is carried; only the Change link goes.
    const [seed, origins] = fresh();
    const off: RunSetupValues = { ...seed, reviewEachPhase: false, reviewerPolicy: 'may-hold' };
    expect(summaryRows('start', off, seed, origins, names).map((r) => r.field)).not.toContain(
      'reviewerPolicy',
    );

    const cloud: RunSetupValues = { ...off, ultraReview: 'each-phase' };
    const row = summaryRows('start', cloud, seed, origins, names).find((r) => r.field === 'reviewerPolicy');
    expect(row, 'the run carries this policy — the review may not hide it').toBeTruthy();
    expect(row?.value).toBe('may hold dependent phases');
    // Carried, but not editable on any stage — so no Change link is offered.
    expect(row?.live).toBe(false);
    expect(buildRunPayload('start', cloud, {}).reviewerPolicy).toBe('may-hold');
  });

  it('marks an ordinary row live, so the Change link is the rule and not the exception', () => {
    const [seed, origins] = fresh();
    const rows = summaryRows('start', { ...seed, model: 'sonnet' }, seed, origins, names);
    expect(rows.find((r) => r.field === 'model')?.live).toBe(true);
    expect(rows.every((r) => typeof r.live === 'boolean')).toBe(true);
  });

  it('reads every value as a person would', () => {
    const v: RunSetupValues = {
      ...EMPTY,
      model: 'opus[1m]',
      effort: '',
      phaseBudgetUsd: '',
      runBudgetUsd: '12.5',
      maxParallel: '',
      onlyPhases: '3, 5-6',
      skills: ['a', 'b'],
      phaseOptions: { '3': { model: 'sonnet' } },
      isolation: 'worktree',
    };
    expect(valueText('model', v, names)).toBe('opus · 1M context');
    expect(valueText('effort', v, names)).toBe('this machine’s default');
    expect(valueText('phaseBudgetUsd', v, names)).toBe('no ceiling');
    expect(valueText('runBudgetUsd', v, names)).toBe('$12.50');
    expect(valueText('maxParallel', v, names)).toBe('the console’s ceiling');
    expect(valueText('onlyPhases', v, names)).toBe('P3, P5, P6');
    expect(valueText('skills', v, names)).toBe('a, b');
    expect(valueText('phaseOptions', v, names)).toBe('1 phase overridden');
    expect(valueText('isolation', v, names)).toBe('its own checkout');
    expect(valueText('permissionProfile', v, names)).toBe('Guarded');
  });
});

describe('the departure line', () => {
  const [seed] = fresh();

  it('says what a fresh start runs, from the ready set, on what, how', () => {
    expect(departureLine('start', seed, { slug: 'alpha' }, { slug: 'alpha', ready: [8, 23] }, names)).toBe(
      'Runs alpha from phases 8 and 23, on opus at max effort, trusted, on the current branch.',
    );
  });

  it('says a scoped run by its scope, and a phase launch by its phase', () => {
    expect(
      departureLine(
        'start',
        { ...seed, onlyPhases: '2, 4' },
        { slug: 'alpha' },
        { slug: 'alpha', ready: [8] },
        names,
      ),
    ).toBe('Runs phases 2 and 4 of alpha on opus at max effort, trusted, on the current branch.');
    expect(departureLine('phase', seed, { slug: 'alpha', phase: 3 }, { slug: 'alpha' }, names)).toBe(
      'Runs phase 3 of alpha on its own, on opus at max effort, trusted, on the current branch.',
    );
  });

  it('names the branch strategy and what happens to the branch', () => {
    const v: RunSetupValues = { ...seed, gitMode: 'new-branch', settle: 'pr', permissionProfile: 'guarded' };
    expect(departureLine('start', v, { slug: 'alpha' }, { slug: 'alpha', ready: [1] }, names)).toBe(
      'Runs alpha from phase 1, on opus at max effort, guarded, on a work branch (pe/alpha), then opens a pull request.',
    );
  });

  it('says a continue picks up its run, and a live patch applies from the next phase', () => {
    expect(
      departureLine(
        'continue',
        seed,
        { slug: 'alpha' },
        { slug: 'alpha', ready: [4], resumeRunId: 'r1' },
        names,
      ),
    ).toBe('Continues alpha (run r1) from phase 4, on opus at max effort, trusted, on the current branch.');
    expect(departureLine('live', seed, { slug: 'alpha' }, { slug: 'alpha' }, names)).toBe(
      'From the next phase, alpha runs on opus at max effort, trusted, on the current branch.',
    );
  });

  it('says when nothing is ready rather than inventing a phase', () => {
    expect(phraseOfPhases([])).toBe('nothing');
    expect(departureLine('start', seed, { slug: 'alpha' }, { slug: 'alpha', ready: [] }, names)).toMatch(
      /from nothing — no phase is ready/,
    );
  });
});

describe('where it stops', () => {
  it('says "no ceiling" out loud, and reads every stop condition off the values', () => {
    const [seed] = fresh();
    const { stops, carriesOn } = stopsWhen(seed);
    expect(carriesOn[0]).toMatch(/no spending ceiling/);
    expect(stops).toContain('phases fail in a row past the run’s own ceiling');
    expect(carriesOn).toContain('at a usage window it switches to an account with headroom, else waits');
    expect(carriesOn).toContain('where something is unclear it keeps going where it safely can');
    // A QA fail under "keep going" is the ladder's errand, not a stop.
    expect(carriesOn).toContain(
      'a QA fail is fixed by the ladder while independent phases run — its dependents stay held',
    );
  });

  it('turns the ceilings into arithmetic when the phase count is known', () => {
    const [seed] = fresh();
    const v: RunSetupValues = {
      ...seed,
      phaseBudgetUsd: '5',
      runBudgetUsd: '40',
      maxConsecutiveFailures: '2',
      onLimit: 'pause',
      autonomy: 'halt-on-everything',
      autoRecover: false,
    };
    expect(ceilings(v, 3)).toMatchObject({ perPhase: 5, run: 40, atMost: 15 });
    expect(ceilings(v, 3).lines).toEqual([
      '$5.00 per phase × 3 phases = up to $15.00',
      '$40.00 for the whole run',
      'At most $15.00 before it halts and asks.',
    ]);
    expect(ceilings(v, undefined).lines[0]).toBe('$5.00 per phase');
    const { stops } = stopsWhen(v);
    expect(stops).toEqual([
      'the run has spent $40.00',
      'one phase spends $5.00',
      '2 phases fail in a row',
      'a usage window closes — it pauses and asks',
      'anything is unclear — it stops and asks',
      'a QA round fails — it parks the run on that phase, naming the report',
      'any halt — nothing retries it without a person',
    ]);
  });

  it('says no ceiling when neither budget is set', () => {
    const [seed] = fresh();
    expect(ceilings(seed, 2).lines).toEqual([
      'No ceiling — the run spends until the plan ends or a usage window closes.',
    ]);
  });
});
