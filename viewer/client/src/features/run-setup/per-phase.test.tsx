/**
 * The per-phase matrix's auto-grant tri-state: `false` is a CHOICE that must be
 * stored (it overrules a plan or global true), and only "inherit" deletes —
 * the one field the shared `set()` helper (delete-on-false) cannot carry.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PerPhase } from './per-phase';
import type { PhaseView } from '@/lib/api';

const PHASES = [
  { phase: 3, title: 'the api', state: 'ready', size: 'S', weight: 1, gated: false },
] as PhaseView[];

function mount(overrides: Record<string, unknown>, onChange = vi.fn()) {
  render(
    <PerPhase
      planPhases={PHASES}
      overrides={overrides as never}
      runModel="opus"
      runEffort="high"
      models={['opus', 'sonnet']}
      skills={[]}
      disabled={false}
      onChange={onChange}
    />,
  );
  // Open the disclosure and the phase's More panel.
  fireEvent.click(screen.getByText('Per phase'));
  fireEvent.click(screen.getByRole('button', { name: /More for phase 3|add|set/ }));
  return onChange;
}

describe('the auto-grant tri-state', () => {
  it("a phase's auto-grant off is stored as false, not dropped", () => {
    const onChange = mount({});
    const select = screen.getByDisplayValue(/inherit \(the plan/);
    fireEvent.change(select, { target: { value: 'off' } });
    expect(onChange).toHaveBeenCalledWith({ '3': { autoApprove: false } });
  });

  it('on is stored as true beside the other overrides', () => {
    const onChange = mount({ '3': { model: 'sonnet' } });
    const select = screen.getByDisplayValue(/inherit \(the plan/);
    fireEvent.change(select, { target: { value: 'on' } });
    expect(onChange).toHaveBeenCalledWith({ '3': { model: 'sonnet', autoApprove: true } });
  });

  it('inherit removes the key, and an empty row disappears entirely', () => {
    const onChange = mount({ '3': { autoApprove: false } });
    const select = screen.getByDisplayValue(/ask me/);
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({});
  });
});

/**
 * What each phase will really run at, and which level said so — shown BEFORE the
 * launch (autopilot-token-drain phase 5). Run `deadaff9`'s plan asked `high` for
 * its hardest phases under a run default of `max`, and nothing on the form said
 * the plan's word sat BELOW the default.
 */
describe('what each phase runs as, and where that came from', () => {
  const phase = (n: number, extra: Partial<PhaseView> = {}) =>
    ({
      phase: n,
      title: `phase ${n}`,
      state: 'ready',
      size: 'M',
      weight: 1,
      gated: false,
      ...extra,
    }) as PhaseView;

  function show(
    planPhases: PhaseView[],
    overrides: Record<string, unknown> = {},
    run: { model?: string; effort?: string } = {},
  ) {
    render(
      <PerPhase
        planPhases={planPhases}
        overrides={overrides as never}
        runModel={run.model ?? 'opus'}
        runEffort={run.effort ?? 'max'}
        models={['opus', 'sonnet']}
        skills={[]}
        onChange={vi.fn()}
      />,
    );
  }

  /** The row's own "runs … · …" line for one field. */
  const runsAs = (n: number, field: 'model' | 'effort') =>
    screen.getByTestId(`runs-as-${field}-${n}`).textContent?.replace(/\s+/g, ' ').trim();

  it('shows every phase its resolved effort and the level that answered', () => {
    show([phase(3, { effort: 'high — the hardest phase' }), phase(4)]);
    expect(runsAs(3, 'effort')).toBe('runs high · plan');
    expect(runsAs(4, 'effort')).toBe('runs max · run default');
    expect(runsAs(4, 'model')).toBe('runs opus · run default');
  });

  it('a choice made here is shown as the answer, with its own source', () => {
    show([phase(3, { effort: 'high' })], { '3': { effort: 'max' } });
    expect(runsAs(3, 'effort')).toBe('runs max · set here');
  });

  it('shows the model token the runner boards with — the window kept', () => {
    show([phase(2, { model: '`claude-opus-5[1m]` for the long reads' })]);
    expect(runsAs(2, 'model')).toBe('runs claude-opus-5[1m] · plan');
  });

  it('warns when the plan asks a different effort from the run default, and says which way', () => {
    show([phase(3, { effort: 'high' }), phase(4, { effort: 'high' }), phase(5)]);
    const summary = screen.getByText('Per phase').closest('summary')!;
    expect(summary.textContent).toMatch(/plan and run differ on 2 phases/);
    const notes = screen.getByRole('list', { name: /where the plan and this run differ/i });
    expect(notes.textContent).toContain('Phase 3: the plan asks effort high, below the run default max');
    expect(notes.textContent).toContain('so phase 3 runs high');
    expect(notes.textContent).not.toContain('Phase 5');
  });

  it('warns when a choice made here replaces what the plan asked — instead of the default warning', () => {
    show([phase(3, { effort: 'high' })], { '3': { effort: 'max' } });
    const notes = screen.getByRole('list', { name: /where the plan and this run differ/i });
    expect(notes.textContent).toContain("Phase 3: effort max chosen here replaces the plan's high");
    expect(notes.textContent).not.toContain('below the run default');
  });

  it('says nothing when the plan and the run agree, or the phase is already done', () => {
    show([phase(3, { effort: 'max' }), phase(4, { effort: 'low', state: 'done' })]);
    expect(screen.queryByRole('list', { name: /where the plan and this run differ/i })).toBeNull();
    const summary = screen.getByText('Per phase').closest('summary')!;
    expect(summary.textContent).not.toMatch(/differ/);
  });

  it('never claims every phase inherits the run when the plan names an effort', () => {
    show([phase(3, { effort: 'max' })]);
    const summary = screen.getByText('Per phase').closest('summary')!;
    expect(summary.textContent).not.toMatch(/every phase inherits the run/);
    expect(summary.textContent).toMatch(/1 phase follows the plan's own model or effort/);
  });
});
