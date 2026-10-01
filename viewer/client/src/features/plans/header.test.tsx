/**
 * The plan header (control-tower phase 23) — what it now says on every tab:
 *
 *   - when work on the plan began, to the minute, and over how long (#28);
 *   - the QA header card: the switch, the reason the engine gave, the roll-up
 *     of every verdict on file, and what those verdicts hold (#27);
 *   - plan health that reads "could not run" and is never red when the engine
 *     could not run the lint (#17's client half) — and the control, a lint
 *     that DID run and failed, still red;
 *   - the plan's status PAINTED with the plan vocabulary's badge.
 */

import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import type { PlanDetail } from '@/lib/api';
import { PlanHeader } from './header';

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConsoleState: () => ({ data: { allowWrites: true, scriptsDir: '/opt/pe/scripts' } }),
}));

type Over = { summary?: Record<string, unknown>; lint?: Record<string, unknown> | null };

const detail = (over: Over = {}) =>
  ({
    summary: {
      slug: 'alpha',
      title: 'Alpha',
      kind: 'plan',
      status: 'active',
      phases: 4,
      done: 1,
      ready: [2],
      inProgress: [],
      stuck: [],
      qaMode: 'on',
      qaModeReason: 'plan directive: QA gate: on',
      startedAt: '2026-09-22T06:40:19.000Z',
      spanMs: 3 * 86_400_000 + 4 * 3_600_000,
      ...over.summary,
    },
    plan: { sessionBudget: {} },
    phases: [],
    qa: [
      { phase: 1, result: 'fail' },
      { phase: 2, result: 'fail' },
      { phase: 3, result: 'pending' },
    ],
    qaHeld: { 1: [4] },
    lint: over.lint === undefined ? { ok: true, issues: [], summary: 'LINT OK' } : over.lint,
    git: {},
  }) as unknown as PlanDetail;

function mount(view: PlanDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PlanHeader detail={view} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('the plan header', () => {
  it('#28: says when work began, to the minute, and over how long', () => {
    mount(detail());
    const started = screen.getByTestId('plan-started');
    expect(started.textContent).toContain('2026-09-22 06:40Z');
    // The table register every console clock prints in (`lib/format.ts` `duration`).
    expect(started.textContent).toMatch(/ · over 76h$/);
    expect(started.querySelector('time')).toHaveAttribute('dateTime', '2026-09-22T06:40:19.000Z');
  });

  it('says nothing about a start a server never measured', () => {
    mount(detail({ summary: { startedAt: undefined, spanMs: undefined } }));
    expect(screen.queryByTestId('plan-started')).toBeNull();
  });

  it('#27: carries the QA header card — the switch, its reason, the roll-up and what it holds', () => {
    mount(detail());
    const card = screen.getByTestId('qa-header-card');
    expect(within(card).getByText('QA gate · on (plan directive: QA gate: on)')).toBeInTheDocument();
    expect(within(card).getByTestId('qa-rollup').textContent).toBe('2 failing, 1 pending');
    expect(card.textContent).toContain('holding P4 (by P1)');
    expect(within(card).getByRole('link', { name: 'QA by phase' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=qa',
    );
  });

  it('#17: a lint that could not run reads "could not run", and is never painted red', () => {
    mount(
      detail({
        lint: {
          ok: true,
          crashed: true,
          issues: [],
          summary: 'validation could not run: the engine died on SIGSEGV — run scripts/validate.sh yourself',
        },
      }),
    );
    const said = screen.getByTestId('lint-could-not-run');
    expect(said.textContent).toMatch(/^Plan health could not run — validation could not run/);
    expect(said.closest('[data-severity]')).toHaveAttribute('data-severity', 'info');
    expect(document.querySelector('[data-severity="error"]')).toBeNull();
  });

  it('the control: a lint that DID run and failed is still red', () => {
    mount(
      detail({
        lint: { ok: false, crashed: false, issues: ['F2 undefined dependency'], summary: 'LINT FAIL' },
      }),
    );
    expect(document.querySelector('[data-severity="error"]')?.textContent).toContain('LINT FAIL');
    expect(screen.queryByTestId('lint-could-not-run')).toBeNull();
  });

  it("paints the plan's status with the plan vocabulary's own badge", () => {
    mount(detail());
    expect(document.querySelector('[data-status="active"]')).toBeTruthy();
  });
});
