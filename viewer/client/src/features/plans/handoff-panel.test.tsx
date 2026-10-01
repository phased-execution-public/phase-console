/**
 * One handoff, as its own page — the baton, rendered whole. The handoffs LIST
 * folded into the phase table in control-tower phase 23 (its datums are walked
 * in `detail.datums.test.tsx`); this page stayed.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import type { PlanDetail } from '@/lib/api';
import { HandoffPanel } from './handoff-panel';

const { useHandoff } = vi.hoisted(() => ({ useHandoff: vi.fn() }));
vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useHandoff,
}));

const DETAIL = { summary: { slug: 'alpha' } } as unknown as PlanDetail;

describe('the handoff page', () => {
  it('renders the handoff whole, with its status painted and its place in the graph', () => {
    useHandoff.mockReturnValue({
      data: {
        phase: 7,
        title: 'The seventh',
        status: 'complete',
        completed: '2026-09-28',
        dependsOn: [5, 6],
        blocks: [8],
        skillsUsed: ['superpowers:test-driven-development'],
        body: '## What landed\n\nThe **baton**.',
        keyFiles: ['viewer/client/src/x.tsx'],
      },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    });
    render(
      <TooltipProvider>
        <HandoffPanel detail={DETAIL} phase="7" />
      </TooltipProvider>,
    );
    expect(screen.getByText('Phase 7 — The seventh')).toBeInTheDocument();
    expect(document.querySelector('[data-status="complete"]')).toBeTruthy();
    expect(screen.getByText('depends on P5, P6')).toBeInTheDocument();
    expect(screen.getByText('blocks P8')).toBeInTheDocument();
    expect(screen.getByText('baton').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'Phase' })).toHaveAttribute('href', '#/plan/alpha/phase/7');
    expect(screen.getByText('viewer/client/src/x.tsx')).toBeInTheDocument();
  });
});
