/**
 * What a phase really runs at, and which of the four places said so
 * (autopilot-token-drain phase 5, H3).
 *
 * Run `deadaff9`'s plan asked `high` for phases 3, 4, 13 and 20, and every one
 * of them ran at `max`. No code turned the plan's word into `max`: the four
 * values arrived explicitly in the launch request, on top of a shipped default
 * (`max`) that sits ABOVE the plan's "hardest phase" value. So honouring the
 * plan is a downgrade, and an operator who reads "the plan asks high" as "this
 * one is harder than usual" is wrong in the direction that costs money.
 *
 * The precedence is right and stays — attempt, then this run's per-phase
 * choice, then the plan, then the run's default — and the default stays `max`
 * (operator decision, 2026-09-16). What changed is that it is resolved in ONE
 * function the launch form displays and the runner boards with, so the form
 * can no longer show one answer while the phase runs another.
 */
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planEffortOf, planModelOf, resolvePhaseChoice } from '../shared/run-settings.js';
import type { RunnerDeps } from '../server/runner/runner-core.ts';
import type { RunState } from '../server/runner/state.ts';

const { Runner } = await import('../server/runner/runner.ts');
const { newRun, phaseRecord } = await import('../server/runner/state.ts');
const { effortOf, modelAlias } = await import('../server/service-core.ts');

type Resolved = { model?: string; effort?: string; source: Record<string, string> };

/** What the runner would board `phase` as, with the plan saying `plan` about it. */
function boardedAs(state: RunState, phase: number, plan: { model?: string; effort?: string }): Resolved {
  const instance = new Runner({
    scriptsDir: '/nonexistent',
    phaseDefaults: (_slug: string, asked: number) => (asked === phase ? plan : undefined),
  } as RunnerDeps);
  const runner = instance as unknown as { state: RunState; optionsFor(phase: number): Resolved };
  runner.state = state;
  return runner.optionsFor(phase);
}

/* ---- the two cases the plan names ---- */

test('deadaff9: plan `high`, run default `max`, no per-phase choice — the phase runs `high`, source `plan`', () => {
  const state = newRun({ slug: 'demo', root: '/nonexistent' });
  assert.equal(state.effort, 'max', 'the shipped default stays max (operator decision)');

  const chosen = boardedAs(state, 3, { effort: 'high' });
  assert.equal(chosen.effort, 'high');
  assert.equal(chosen.source.effort, 'plan');
});

test('an explicit per-phase choice beats the plan — source `run`, even when it equals the default', () => {
  // deadaff9's own shape: `max` chosen by hand for a phase whose plan said `high`.
  const state = newRun({ slug: 'demo', root: '/nonexistent', phaseOptions: { 3: { effort: 'max' } } });

  const chosen = boardedAs(state, 3, { effort: 'high' });
  assert.equal(chosen.effort, 'max');
  assert.equal(chosen.source.effort, 'run', 'the operator’s choice, not the default it happens to equal');
});

/* ---- the one resolver both ends read ---- */

test('the shared resolver ranks attempt, run, plan, default — and names the one that answered', () => {
  assert.deepEqual(resolvePhaseChoice({ plan: 'high', fallback: 'max' }), { value: 'high', source: 'plan' });
  assert.deepEqual(resolvePhaseChoice({ run: 'max', plan: 'high', fallback: 'max' }), { value: 'max', source: 'run' });
  assert.deepEqual(
    resolvePhaseChoice({ retry: 'low', run: 'max', plan: 'high', fallback: 'max' }),
    { value: 'low', source: 'retry' },
  );
  assert.deepEqual(resolvePhaseChoice({ fallback: 'max' }), { value: 'max', source: 'default' });
  // Nothing anywhere — the machine's own default, which no source can claim.
  assert.deepEqual(resolvePhaseChoice({}), { value: undefined, source: undefined });
  // An empty string is "no choice here", exactly as the per-phase select stores it.
  assert.deepEqual(resolvePhaseChoice({ run: '', plan: 'high', fallback: '' }), { value: 'high', source: 'plan' });
});

test('the runner and the resolver agree on every combination of the four levels', () => {
  const levels = { retry: 'low', run: 'medium', plan: 'high', fallback: 'xhigh' } as const;
  for (let mask = 0; mask < 16; mask++) {
    const has = (bit: number) => Boolean(mask & (1 << bit));
    const expected = resolvePhaseChoice({
      ...(has(0) ? { retry: levels.retry } : {}),
      ...(has(1) ? { run: levels.run } : {}),
      ...(has(2) ? { plan: levels.plan } : {}),
      ...(has(3) ? { fallback: levels.fallback } : {}),
    });
    const state = newRun({
      slug: 'demo', root: '/nonexistent', effort: has(3) ? levels.fallback : '',
      ...(has(1) ? { phaseOptions: { 2: { effort: levels.run } } } : {}),
    });
    if (has(0)) phaseRecord(state, 2).retryOverride = { options: { effort: levels.retry } } as never;
    const chosen = boardedAs(state, 2, has(2) ? { effort: levels.plan } : {});
    assert.equal(chosen.effort, expected.value, `mask ${mask.toString(2)}`);
    assert.equal(chosen.source.effort, expected.source, `mask ${mask.toString(2)}`);
  }
});

/* ---- the plan's bullets, read once ---- */

test('a plan bullet is read the way the runner reads it — the whole model token, the window kept', () => {
  assert.equal(planModelOf('claude-opus-5[1m] — the reasoning is hard'), 'claude-opus-5[1m]');
  assert.equal(planModelOf('**Model:** Opus, because the reasoning is hard'), 'opus');
  assert.equal(planModelOf('whatever is cheapest'), undefined);
  assert.equal(planEffortOf('run this at HIGH effort'), 'high');
  assert.equal(planEffortOf(undefined), undefined);
});

test('the server reads plan bullets through the shared readers, not a copy', () => {
  assert.equal(modelAlias, planModelOf);
  assert.equal(effortOf, planEffortOf);
});
