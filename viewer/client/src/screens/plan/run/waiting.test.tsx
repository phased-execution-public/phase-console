/**
 * The second queue (7.0, quiet-console phase 11; the cases of
 * `features/runs/waiting-pane.test.tsx`).
 *
 * The property worth pinning is honesty about the future: a phase whose
 * dependencies are unfinished must appear SOMEWHERE on the run's page, naming
 * exactly what it waits on — the page without it read as "the autopilot stops
 * after the current phases", which is not what the loop does. A phase that
 * already has a lane must never appear twice: the plan detail and the run are
 * separate snapshots that skew. And the reassurance that it starts by itself is
 * said only where it is true.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PlanDetail } from '@/data/api';
import { RunWaiting, waitingOf } from './waiting';

function detail(): PlanDetail {
  return {
    summary: { slug: 'demo' },
    phases: [
      { phase: 7, title: 'the api', state: 'in-progress', gated: false, bullets: [] },
      { phase: 9, title: 'the tests', state: 'ready', gated: false, bullets: [] },
      {
        phase: 10,
        title: 'the docs',
        state: 'waiting',
        gated: false,
        bullets: [],
        analysis: {
          phase: 10,
          state: 'waiting',
          size: 'M',
          weight: 1,
          dependsOn: [7, 9],
          dependents: [],
          transitiveDependents: [],
          unblocks: 0,
          onCriticalPath: false,
        },
      },
      {
        phase: 11,
        title: 'the release',
        state: 'waiting',
        gated: true,
        gates: 'phase 10 verified',
        bullets: [],
        analysis: {
          phase: 11,
          state: 'waiting',
          size: 'S',
          weight: 1,
          dependsOn: [10],
          dependents: [],
          transitiveDependents: [],
          unblocks: 0,
          onCriticalPath: false,
        },
      },
    ],
    eta: { plan: null, perPhase: [{ phase: 10, estMs: 30 * 60_000, label: '~30m' }] },
  } as unknown as PlanDetail;
}

/** The phase a test holds done, with a QA verdict on it. */
function withVerdict(d: PlanDetail, phase: number, result: string): PlanDetail {
  const dep = d.phases.find((p) => p.phase === phase) as { state: string; qa?: { result: string } };
  dep.state = 'done';
  dep.qa = { result };
  return d;
}

const line = (phase: number): HTMLElement =>
  screen.getAllByTestId('waiting-phase').find((li) => li.dataset.phase === String(phase))!;

describe('waitingOf', () => {
  it('lists waiting phases with each unmet dependency and its own state', () => {
    const rows = waitingOf(detail());
    expect(rows.map((row) => row.phase)).toEqual([10, 11]);
    // Done dependencies are not "waited on" — only the unmet ones are named.
    expect(rows[0]!.deps).toEqual([
      { phase: 7, state: 'in-progress' },
      { phase: 9, state: 'ready' },
    ]);
    expect(rows[0]!.estMs).toBe(30 * 60_000);
    expect(rows[1]!.gated).toBe(true);
  });

  it('never duplicates a phase that already has a lane', () => {
    const rows = waitingOf(detail(), new Set([10]));
    expect(rows.map((row) => row.phase)).toEqual([11]);
  });

  it('holds a done-but-QA-pending dependency as unmet, named as QA', () => {
    const rows = waitingOf(withVerdict(detail(), 7, 'pending'));
    expect(rows[0]!.deps).toContainEqual({ phase: 7, state: 'QA pending' });
  });
});

describe('RunWaiting', () => {
  it('says the phases start themselves — the claim the list exists to make', () => {
    render(<RunWaiting rows={waitingOf(detail())} />);
    expect(screen.getByText(/keeps going until the whole graph is done/)).toBeInTheDocument();
    expect(screen.getAllByText(/Starts by itself the moment these finish/)).toHaveLength(2);
    // Each dependency by its phase and its board word, drawn by the family.
    const p7 = within(line(10))
      .getAllByTestId('waiting-dep')
      .find((dep) => dep.dataset.phase === '7')!;
    expect(p7.textContent).toContain('P7');
    expect(p7.querySelector('[data-status="in-progress"]')?.textContent).toBe('In progress');
    expect(within(line(11)).getByTestId('waiting-gate').textContent).toMatch(/phase 10 verified/);
    expect(line(10).textContent).toContain('expected ~30 min of work');
    // A waiting phase reads as the board word, one way on every page.
    expect(line(10).querySelector('[data-status="waiting"]')).not.toBeNull();
  });

  it('renders nothing at all when nothing waits', () => {
    const { container } = render(<RunWaiting rows={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('says a person is needed when the handoff reports blocked', () => {
    const d = detail();
    (d.phases.find((p) => p.phase === 11) as { state: string }).state = 'stuck';
    render(<RunWaiting rows={waitingOf(d)} />);
    expect(within(line(11)).getByTestId('waiting-why').textContent).toMatch(/needs a person/);
    expect(line(11).querySelector('[data-status="stuck"]')).not.toBeNull();
  });
});

describe('a dependency held by its QA verdict is not "starts by itself"', () => {
  // The reassurance is true of a dependency that is still running and false of
  // one that has FINISHED and is held by its verdict: that phase is done,
  // nothing dispatches QA on its own, and the line was telling the operator
  // the opposite of the truth on the one plan that most needed reading.
  it('says a person is needed when a dependency is held by its verdict', () => {
    render(<RunWaiting rows={waitingOf(withVerdict(detail(), 7, 'fail'))} />);
    expect(screen.getAllByText(/nothing starts by itself/i).length).toBeGreaterThan(0);
    // The verdict is drawn as the QA word, never as a phase state.
    const held = within(line(10))
      .getAllByTestId('waiting-dep')
      .find((dep) => dep.dataset.phase === '7')!;
    expect(held.querySelector('[data-status="fail"]')?.textContent).toBe('QA fail');
  });

  it('keeps the reassurance for a dependency that is simply unfinished', () => {
    render(<RunWaiting rows={waitingOf(detail())} />);
    expect(screen.getAllByText(/the autopilot is not stuck/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing starts by itself/i)).toBeNull();
  });
});
