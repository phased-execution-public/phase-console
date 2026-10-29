/**
 * The plan's own facts (7.0, quiet-console phase 10; ported from
 * `features/plans/header.test.tsx`) — what the 6.2 header said on every tab,
 * now in three parts, each where it is read:
 *
 *   - when work on the plan began, to the minute, and over how long (#28) —
 *     in "About this plan", one press away, or open with Everything on;
 *   - the QA line: the switch, the reason the engine gave, the roll-up of
 *     every verdict on file, and what those verdicts hold (#27);
 *   - plan health that reads "could not run" and is never red when the engine
 *     could not run the lint (#17's client half) — and the control, a lint
 *     that DID run and failed, still red.
 *
 * The plan's status mark moved to the glance; its case is in `glance.test.tsx`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, PlanDetail } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { PlanBanners, PlanFacts, QaLine, qaRollup } from './header';

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

let sent: string[] = [];

beforeEach(() => {
  sent = [];
  // Nothing here reads the server: the console's state is seeded below, and
  // any read that slips past it is recorded and answered empty.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      sent.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return () => vi.unstubAllGlobals();
});

function mount(node: React.ReactElement, state: Partial<ConsoleState> = {}) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), { allowWrites: true, scriptsDir: '/opt/pe/scripts', ...state });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/** "About this plan" — the one press between the page and the plan's facts. */
const openFacts = () => {
  const fold = screen.getByTestId('plan-facts');
  expect(fold).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(fold);
};

describe('the plan’s facts', () => {
  it('#28: says when work began, to the minute, and over how long — one press away', () => {
    mount(<PlanFacts detail={detail()} />);
    // Folded, the fact is not on the page: the fold unmounts what it holds.
    expect(screen.queryByTestId('plan-started')).toBeNull();
    openFacts();
    const started = screen.getByTestId('plan-started');
    expect(started.textContent).toContain('2026-09-22 06:40Z');
    // The table register every console clock prints in (`lib/format.ts` `duration`).
    expect(started.textContent).toMatch(/, over 76h$/);
    expect(started.querySelector('time')).toHaveAttribute('dateTime', '2026-09-22T06:40:19.000Z');
  });

  it('is open with no press when the page asks — Everything on', () => {
    mount(<PlanFacts detail={detail()} open />);
    expect(screen.getByTestId('plan-facts')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('plan-started')).toBeInTheDocument();
  });

  it('says nothing about a start a server never measured', () => {
    mount(<PlanFacts detail={detail({ summary: { startedAt: undefined, spanMs: undefined } })} />);
    openFacts();
    expect(screen.queryByTestId('plan-started')).toBeNull();
    expect(screen.queryByText('Started')).toBeNull();
  });

  it('carries an off gate as a fact, with the engine’s reason — the QA line is drawn only when QA runs', () => {
    mount(<PlanFacts detail={detail({ summary: { qaMode: 'off', qaModeReason: 'no QA gate line' } })} />);
    openFacts();
    const label = screen.getByText('QA gate');
    expect(label.nextElementSibling).toHaveTextContent('off (no QA gate line)');
  });
});

describe('the QA line', () => {
  it('#27: carries the switch, its reason, the roll-up and what it holds', () => {
    mount(<QaLine detail={detail()} />);
    const card = screen.getByTestId('qa-header-card');
    // The regime as a dot and its word — the engine's word, never the directive echoed.
    const regime = card.querySelector('[data-vocab="qa-mode"]');
    expect(regime).toHaveAttribute('data-status', 'on');
    expect(regime).toHaveTextContent('QA on');
    expect(within(card).getByText('plan directive: QA gate: on')).toBeInTheDocument();
    // The switch itself, with the current word pressed.
    const group = within(card).getByRole('group', { name: 'QA gate' });
    expect(within(group).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card).getByTestId('qa-rollup').textContent).toBe('2 failing, 1 pending');
    expect(card.textContent).toContain('holding P4 (by P1)');
    // The reading of every phase's record — its QA and its handoff, side by side.
    expect(within(card).getByRole('link', { name: 'Handoffs & QA' })).toHaveAttribute(
      'href',
      '#/plan/alpha/phases?view=handoffs',
    );
    expect(sent).toEqual([]);
  });

  it('says the switch is sealed, and the command by hand, on a console that cannot write', () => {
    mount(<QaLine detail={detail()} />, { allowWrites: false });
    const card = screen.getByTestId('qa-header-card');
    expect(within(card).getByRole('button', { name: 'Off' })).toBeDisabled();
    expect(card.textContent).toContain('bash /opt/pe/scripts/qa-mode.sh alpha <on|off>');
  });

  it('rolls the verdicts up worst first, and says plainly when none is on file', () => {
    expect(qaRollup(detail())).toEqual({ rollup: '2 failing, 1 pending', holding: 'holding P4 (by P1)' });
    expect(qaRollup({ qa: [], qaHeld: {} } as unknown as PlanDetail)).toEqual({
      rollup: 'no verdict recorded yet',
      holding: null,
    });
  });
});

describe('the plan’s banners', () => {
  it('#17: a lint that could not run reads "could not run", and is never painted red', () => {
    mount(
      <PlanBanners
        detail={detail({
          lint: {
            ok: true,
            crashed: true,
            issues: [],
            summary:
              'validation could not run: the engine died on SIGSEGV — run scripts/validate.sh yourself',
          },
        })}
      />,
    );
    const said = screen.getByTestId('lint-could-not-run');
    expect(said.textContent).toMatch(/^Plan health could not run: validation could not run/);
    expect(said.closest('[data-severity]')).toHaveAttribute('data-severity', 'info');
    expect(document.querySelector('[data-severity="error"]')).toBeNull();
  });

  it('the control: a lint that DID run and failed is still red', () => {
    mount(
      <PlanBanners
        detail={detail({
          lint: { ok: false, crashed: false, issues: ['F2 undefined dependency'], summary: 'LINT FAIL' },
        })}
      />,
    );
    const red = document.querySelector('[data-severity="error"]');
    expect(red?.textContent).toContain('LINT FAIL');
    expect(red?.textContent).toContain('F2 undefined dependency');
    expect(screen.queryByTestId('lint-could-not-run')).toBeNull();
  });

  it('says nothing at all for a healthy open plan', () => {
    const { container } = mount(<PlanBanners detail={detail()} />);
    expect(container.textContent).toBe('');
  });
});
