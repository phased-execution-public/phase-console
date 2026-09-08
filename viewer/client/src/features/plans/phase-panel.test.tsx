/**
 * Steering a phase from the PLAN, not just from the run page.
 *
 * The one rule this card exists to keep: the box is offered on an observed
 * fact (`PhaseView.live`) and never on the board word. `in-progress` is a line
 * grepped out of a handoff — it says a session once wrote that sentence, not
 * that anything is running now. A steer box over it takes an operator's
 * instruction and drops it, which is worse than not offering one.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseView } from '@/lib/api';
import { SteerCard } from './phase-panel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, runAsk: vi.fn(), runSteer: vi.fn() } };
});

const phase = (over: Partial<PhaseView> = {}): PhaseView =>
  ({
    phase: 21,
    title: 'Attach-and-steer',
    state: 'in-progress',
    size: 'M',
    gated: false,
    ...over,
  }) as unknown as PhaseView;

describe('SteerCard', () => {
  it('offers the box for a lane this console is driving', () => {
    render(<SteerCard slug="demo" view={phase({ live: { via: 'run', session: 's1', pid: 42 } })} allowRun />);

    expect(screen.getByTestId('phase-steer')).toBeInTheDocument();
    expect(screen.getByLabelText('What this message is')).toBeEnabled();
    // Addressed at THIS phase — the placeholder is the visible half of the
    // `phase` argument that `AskBox` now sends.
    expect(screen.getByPlaceholderText(/phase 21/)).toBeInTheDocument();
  });

  it('renders nothing at all when nothing is observed working the phase', () => {
    // The board still says `in-progress`. That is exactly the case: a handoff
    // sentence is not a running process.
    const { container } = render(<SteerCard slug="demo" view={phase({ state: 'in-progress' })} allowRun />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains itself instead of offering a box this console cannot serve', () => {
    render(<SteerCard slug="demo" view={phase({ live: { via: 'lock' } })} allowRun />);

    expect(screen.getByTestId('phase-steer')).toBeInTheDocument();
    // No input: `steerRun` resolves a live runner by slug and would 409.
    expect(screen.queryByLabelText('What this message is')).not.toBeInTheDocument();
    expect(screen.getByText(/not a lane this console is driving/)).toBeInTheDocument();
  });

  it('says a registry session belongs to Sessions, not to a lane', () => {
    render(<SteerCard slug="demo" view={phase({ live: { via: 'registry', session: 's9' } })} allowRun />);

    expect(screen.queryByLabelText('What this message is')).not.toBeInTheDocument();
    expect(screen.getByText(/Open it from Sessions/)).toBeInTheDocument();
  });

  it('disables the box, with the reason, on a read-only console', () => {
    render(<SteerCard slug="demo" view={phase({ live: { via: 'run', pid: 42 } })} allowRun={false} />);

    expect(screen.getByLabelText('What this message is')).toBeDisabled();
    expect(screen.getByPlaceholderText('Asking needs --allow-run')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The Quality card judges "held" by THIS phase's regime (2026-09-07)
 * ------------------------------------------------------------------ */

vi.mock('@/lib/queries', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConsoleState: () => ({ data: { allowWrites: true, allowRun: true, allowAgent: false } }),
  useSessions: () => ({ data: undefined }),
  useGateStatus: () => ({ data: undefined }),
  useSkills: () => ({ data: [] }),
}));

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PlanDetail } from '@/lib/api';
import { PhasePanel } from './phase-panel';

const held = (over: Partial<PhaseView> & { phase: number }): PhaseView =>
  ({
    title: `Phase ${over.phase}`,
    state: 'done',
    size: 'M',
    gated: false,
    qa: { result: 'fail', report: `reports/phase-0${over.phase}-qa.md` },
    ...over,
  }) as unknown as PhaseView;

const detail = {
  summary: { slug: 'alpha', title: 'Alpha', qaMode: 'on', phases: 3, ready: [], inProgress: [], stuck: [] },
  plan: { sessionBudget: { skills: [], mcpServers: [] } },
  phases: [
    // Its own `- **QA:** off` under a plan-wide `on`: the fail holds nothing.
    held({ phase: 2, qaMode: { mode: 'off', source: 'phase' } }),
    held({ phase: 3, qaMode: { mode: 'on', source: 'phase' } }),
  ],
  qa: [],
  handoffs: [],
  index: [],
  locks: [],
} as unknown as PlanDetail;

function mountPanel(phase: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PhasePanel detail={detail} phase={phase} />
    </QueryClientProvider>,
  );
}

describe('the Quality card', () => {
  it('does not show a phase that opted out as held, whatever the plan says', () => {
    mountPanel('2');
    expect(screen.queryByTestId('qa-recovery')).toBeNull();
    expect(screen.getByText('QA for this phase · off (phase directive)')).toBeInTheDocument();
  });

  it('shows the recovery verbs for a phase the gate actually holds', () => {
    mountPanel('3');
    expect(screen.getByTestId('qa-recovery')).toBeInTheDocument();
    expect(screen.getByText('QA for this phase · on (phase directive)')).toBeInTheDocument();
  });
});
