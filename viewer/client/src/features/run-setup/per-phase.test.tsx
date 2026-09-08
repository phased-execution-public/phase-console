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
