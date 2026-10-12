/**
 * One phase, as its own page (7.0, quiet-console phase 10; ported from
 * `features/plans/phase-panel.test.tsx`).
 *
 * Two rules came with the port:
 *
 *   - **the steer box is offered on an observed fact** (`PhaseView.live`) and
 *     never on the board word. `in-progress` is a line grepped out of a
 *     handoff; a box over it takes an operator's instruction and drops it.
 *   - **the Quality section judges "held" by THIS phase's regime** (2026-09-07):
 *     a phase carrying its own `QA: off` under a plan-wide `on` is held by
 *     nothing, whatever its verdict.
 *
 * And what 7.0 adds: one column of `h2` sections in the order a person reads a
 * phase, an `h1` that leads with the phase number, the boot prompt open only
 * where booting is the move, the QA brief beside it once a QA'd phase is done,
 * and every section absent when its fact is.
 *
 * The gate card, the QA launcher and the QA switch are other files' and are
 * stubbed here; the stub of the recovery verbs keeps the one rule this page
 * relies on — it draws only while `qaGateHolds` says the gate holds.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleState, PhaseView, PlanDetail } from '@/data/api';
import { keys, queryClientConfig } from '@/data/keys';
import { TooltipProvider } from '@/ui/tooltip';
import { handoffHref, planHref } from '@/shell/routes';
import { expectNoAxeViolations } from '@/test/axe';
import { PhasePanel, SteerCard, promptBanner } from './panel';

const { prompt, qaPrompt, review } = vi.hoisted(() => ({
  prompt: vi.fn(),
  qaPrompt: vi.fn(),
  review: vi.fn(),
}));

vi.mock('@/data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/api')>();
  return { ...actual, api: { ...actual.api, prompt, qaPrompt, review } };
});

vi.mock('./gate-card', () => ({
  PhaseGate: ({ slug, phase }: { slug: string; phase: number }) => (
    <div data-testid="phase-gate" data-slug={slug} data-phase={phase} />
  ),
}));

vi.mock('./qa-launcher', async () => {
  const { qaGateHolds } = await import('@shared/plan-vocab.js');
  return {
    QaButton: ({ label = 'QA this phase' }: { label?: string }) => <button type="button">{label}</button>,
    QaEnableButton: () => null,
    QaRecoveryActions: ({ qaMode, qa }: { qaMode?: string; qa?: { result: string } }) =>
      qaGateHolds(qaMode, qa?.result) ? <div data-testid="qa-recovery" /> : null,
    QaVerdict: ({ qa }: { qa?: { result: string } }) =>
      qa ? <span data-testid="qa-verdict">{`QA ${qa.result}`}</span> : null,
    QaRounds: () => null,
  };
});

vi.mock('./qa-mode', () => ({
  QaModeControl: ({
    phase,
    mode,
    phaseMode,
  }: {
    phase?: number;
    mode?: string;
    phaseMode?: { mode: string; source: string };
  }) => (
    <p data-testid={`qa-mode-phase-${phase}`}>
      {phaseMode
        ? `QA for this phase: ${phaseMode.mode} (${phaseMode.source} directive)`
        : `QA for this phase: inherits ${mode}`}
    </p>
  ),
}));

vi.mock('@/cards/recovery-actions', () => ({
  RecoveryActions: ({
    target,
    ctx,
  }: {
    target: { slug: string; phase?: number };
    ctx: { boardState?: string };
  }) => <div data-testid="recovery" data-phase={target.phase} data-board={ctx.boardState} />,
}));

const STATE = { allowWrites: true, allowRun: true, allowAgent: false } as ConsoleState;

/* ------------------------------------------------------------------ *
 * The steer card
 * ------------------------------------------------------------------ */

const running = (over: Partial<PhaseView> = {}): PhaseView =>
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
    render(
      <SteerCard slug="demo" view={running({ live: { via: 'run', session: 's1', pid: 42 } })} allowRun />,
    );

    expect(screen.getByTestId('phase-steer')).toBeInTheDocument();
    expect(screen.getByLabelText('What this message is')).toBeEnabled();
    // Addressed at THIS phase — the placeholder is the visible half of the
    // `phase` argument the box sends.
    expect(screen.getByPlaceholderText(/phase 21/)).toBeInTheDocument();
  });

  it('renders nothing at all when nothing is observed working the phase', () => {
    // The board still says `in-progress`. That is exactly the case: a handoff
    // sentence is not a running process.
    const { container } = render(<SteerCard slug="demo" view={running({ state: 'in-progress' })} allowRun />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains itself instead of offering a box this console cannot serve', () => {
    render(<SteerCard slug="demo" view={running({ live: { via: 'lock' } })} allowRun />);

    expect(screen.getByTestId('phase-steer')).toBeInTheDocument();
    // No input: a steer resolves a live runner by slug and would 409.
    expect(screen.queryByLabelText('What this message is')).not.toBeInTheDocument();
    expect(screen.getByText(/not a lane this console is driving/)).toBeInTheDocument();
  });

  it('says a registry session belongs to Sessions, not to a lane', () => {
    render(<SteerCard slug="demo" view={running({ live: { via: 'registry', session: 's9' } })} allowRun />);

    expect(screen.queryByLabelText('What this message is')).not.toBeInTheDocument();
    expect(screen.getByText(/Open it from Sessions/)).toBeInTheDocument();
  });

  it('disables the box, with the reason, on a read-only console', () => {
    render(<SteerCard slug="demo" view={running({ live: { via: 'run', pid: 42 } })} allowRun={false} />);

    expect(screen.getByLabelText('What this message is')).toBeDisabled();
    expect(screen.getByPlaceholderText('Asking needs --allow-run')).toBeInTheDocument();
  });

  it('is a section named for what it says, with the witness in words', () => {
    render(<SteerCard slug="demo" view={running({ live: { via: 'lock' } })} allowRun />);
    expect(screen.getByRole('region', { name: 'This phase is running' })).toHaveTextContent(
      'Seen through a phase lock.',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

const held = (over: Partial<PhaseView> & { phase: number }): PhaseView =>
  ({
    title: `Phase ${over.phase}`,
    state: 'done',
    size: 'M',
    gated: false,
    qa: { result: 'fail', report: `reports/phase-0${over.phase}-qa.md` },
    ...over,
  }) as unknown as PhaseView;

const HOUR = 3_600_000;

/** A phase with every fact the page draws — each section has something to say. */
const RICH = {
  phase: 4,
  title: 'The rich one',
  state: 'stuck',
  size: 'L',
  weight: 120_000,
  gated: true,
  gateKind: 'human',
  gates: '1. Sign in',
  goal: 'Make the **thing**',
  readFirst: 'the spec',
  steps: '1. do it',
  exitCriteria: 'it works',
  verification: '`npm test`',
  handoffMustRecord: 'what changed',
  model: 'claude-opus-4',
  effort: 'high',
  mcpServers: ['fs'],
  analysis: {
    phase: 4,
    state: 'stuck',
    size: 'L',
    weight: 120_000,
    dependsOn: [3],
    dependents: [5],
    transitiveDependents: [5, 6],
    unblocks: 1,
    onCriticalPath: true,
  },
  row: {
    phase: 4,
    title: 'The rich one',
    dependsOn: [3],
    parallelSafe: '—',
    repos: 'viewer',
    exitCriteria: 'green',
  },
  live: { via: 'lock' },
  reviewHold: [3],
  review: { verdict: 'requested-changes', at: '2026-10-01T00:00:00Z', by: 'me' },
  lock: {
    owner: 'me@host/opus-p4',
    expired: false,
    leaseUntil: Date.now() + 3 * HOUR,
    host: 'mac',
    claimedAt: Date.now() - 600_000,
    scope: ['viewer'],
  },
  handoff: {
    file: 'phase-04.md',
    status: 'blocked',
    title: 'The rich one',
    outstanding: 'The gate never cleared.',
    skillsUsed: ['tdd'],
    prompts: 2,
  },
  qa: { result: 'fail', report: 'reports/phase-04-qa.md' },
  qaMode: { mode: 'on', source: 'plan' },
} as unknown as PhaseView;

const plan = (phases: PhaseView[], qaMode = 'on'): PlanDetail =>
  ({
    summary: {
      slug: 'alpha',
      title: 'Alpha',
      qaMode,
      phases: phases.length,
      ready: [],
      inProgress: [],
      stuck: [],
    },
    plan: { sessionBudget: { skills: [], mcpServers: [] } },
    phases,
    qa: [],
    handoffs: [],
    index: [],
    locks: [],
  }) as unknown as PlanDetail;

const detail = plan([
  // Its own `- **QA:** off` under a plan-wide `on`: the fail holds nothing.
  held({ phase: 2, qaMode: { mode: 'off', source: 'phase' } }),
  held({ phase: 3, qaMode: { mode: 'on', source: 'phase' } }),
  RICH,
  held({ phase: 5, state: 'ready', qa: undefined }),
]);

function mountPanel(phase: string, on: PlanDetail = detail, state: ConsoleState = STATE) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { ...queryClientConfig.defaultOptions?.queries, retry: false } },
  });
  client.setQueryData(keys.state(), state);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PhasePanel detail={on} phase={phase} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  prompt.mockReset().mockResolvedValue('BOOT PROMPT TEXT');
  qaPrompt.mockReset().mockResolvedValue('QA BRIEF TEXT');
  review.mockReset();
});

describe('the Quality section', () => {
  it('does not show a phase that opted out as held, whatever the plan says', () => {
    mountPanel('2');
    expect(screen.queryByTestId('qa-recovery')).toBeNull();
    expect(screen.getByText('QA for this phase: off (phase directive)')).toBeInTheDocument();
  });

  it('shows the recovery verbs for a phase the gate actually holds', () => {
    mountPanel('3');
    expect(screen.getByTestId('qa-recovery')).toBeInTheDocument();
    expect(screen.getByText('QA for this phase: on (phase directive)')).toBeInTheDocument();
  });

  it('says where the last verdict is recorded', () => {
    mountPanel('3');
    const quality = screen.getByTestId('phase-quality');
    expect(within(quality).getByText('reports/phase-03-qa.md').tagName).toBe('CODE');
    expect(within(quality).getByRole('button', { name: 'QA this phase' })).toBeInTheDocument();
  });

  it('is absent for a phase nobody can have started', () => {
    mountPanel('6', plan([held({ phase: 6, state: 'waiting', qa: undefined })]));
    expect(screen.queryByTestId('phase-quality')).toBeNull();
  });
});

describe('the page', () => {
  it('leads with the phase: its number muted before the title, its mark, its facts in words', () => {
    mountPanel('4');
    const title = screen.getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Phase 4 The rich one');
    expect(within(title).getByText('Phase 4')).toHaveClass('text-ink-muted');
    const header = title.closest('header')!;
    expect(header.querySelector('[data-vocab="board"][data-status="stuck"]')).toBeTruthy();
    for (const fact of [
      'gated (human)',
      'L, weight 120K',
      'effort high',
      'on the critical path',
      'review changes requested',
    ])
      expect(within(header).getByText(fact)).toBeInTheDocument();
    expect(within(header).getByText('claude-opus-4').tagName).toBe('CODE');
    expect(within(header).getByTestId('qa-verdict')).toHaveTextContent('QA fail');
    // Separate facts are separate words — no middle-dot meta string.
    expect(header.textContent).not.toContain('·');
  });

  it('draws its sections in the order a person reads a phase', () => {
    mountPanel('4');
    const sections = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual([
      'Goal',
      'This phase is running',
      'Why it is blocked',
      'The phase as written',
      'Prompts',
      'Review',
      'Quality',
      'Handoff',
      'Dependencies',
      'Claim',
    ]);
    // The gate and the review's hold sit between the goal and the steer card…
    const goal = screen.getByRole('heading', { level: 2, name: 'Goal' });
    const gate = screen.getByTestId('phase-gate');
    const hold = screen.getByTestId('review-hold');
    const steer = screen.getByTestId('phase-steer');
    const after = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(goal, gate) && after(gate, hold) && after(hold, steer)).toBe(true);
    // …and the writes come last.
    const claim = screen.getByRole('heading', { level: 2, name: 'Claim' });
    expect(after(claim, screen.getByTestId('write-menu'))).toBe(true);
  });

  it('asks the gate card for a gated phase only — an ungated one never shells out for a gate', () => {
    mountPanel('4');
    expect(screen.getByTestId('phase-gate')).toHaveAttribute('data-phase', '4');
    expect(screen.getByTestId('phase-gate')).toHaveAttribute('data-slug', 'alpha');
  });

  it('draws no section whose fact is absent', () => {
    mountPanel('3');
    expect(screen.queryByTestId('phase-gate')).toBeNull();
    expect(screen.queryByTestId('review-hold')).toBeNull();
    expect(screen.queryByTestId('phase-steer')).toBeNull();
    expect(screen.queryByTestId('phase-stuck')).toBeNull();
    expect(screen.queryByTestId('phase-handoff')).toBeNull();
    expect(screen.queryByTestId('phase-claim')).toBeNull();
    // A phase with no `### Phase N` section says so rather than drawing blanks.
    expect(screen.getByText(/has a graph row but no/)).toBeInTheDocument();
  });

  it('says a missing phase in one line, with the way back to every phase', () => {
    mountPanel('9');
    expect(screen.getByText(/The plan has no phase 9/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See every phase' })).toHaveAttribute(
      'href',
      planHref('alpha', 'phases'),
    );
  });

  it('quotes a stuck phase’s handoff and hands its way forward the stuck board', () => {
    const long = 'x'.repeat(950);
    mountPanel('4', plan([{ ...RICH, handoff: { ...RICH.handoff!, outstanding: long } } as PhaseView]));
    const stuck = screen.getByTestId('phase-stuck');
    expect(stuck).toHaveTextContent(`${'x'.repeat(900)}…`);
    expect(within(stuck).getByTestId('recovery')).toHaveAttribute('data-board', 'stuck');
    expect(within(stuck).getByTestId('recovery')).toHaveAttribute('data-phase', '4');
  });

  it('draws the handoff’s status as a dot and a word, and links to the page that holds it', async () => {
    mountPanel('4');
    const handoff = screen.getByTestId('phase-handoff');
    expect(handoff.querySelector('[data-vocab="handoff"][data-status="blocked"]')).toBeTruthy();
    expect(within(handoff).getByRole('link', { name: 'Read the handoff' })).toHaveAttribute(
      'href',
      handoffHref('alpha', 4),
    );
    expect(within(handoff).getByText('2 boot prompts')).toBeInTheDocument();
    expect(await within(handoff).findByText('The gate never cleared.')).toBeInTheDocument();
  });

  it('leaves out an Outstanding that says none', () => {
    mountPanel(
      '4',
      plan([{ ...RICH, state: 'done', handoff: { ...RICH.handoff!, outstanding: 'None' } } as PhaseView]),
    );
    expect(within(screen.getByTestId('phase-handoff')).queryByText('Outstanding')).toBeNull();
  });

  it('puts the phase in its graph: each edge a link, a dependency with its board word', () => {
    mountPanel('4', plan([held({ phase: 3, state: 'done' }), RICH]));
    const deps = screen.getByTestId('phase-dependencies');
    expect(within(deps).getByRole('link', { name: 'P3' })).toHaveAttribute('href', '#/plan/alpha/phase/3');
    expect(deps.querySelector('[data-vocab="board"][data-status="done"]')).toBeTruthy();
    expect(within(deps).getByRole('link', { name: 'P5' })).toHaveAttribute('href', '#/plan/alpha/phase/5');
    expect(within(deps).getByText('2 phases, 1 still open')).toBeInTheDocument();
    expect(within(deps).getByText('viewer').tagName).toBe('CODE');
    // The graph's "no parallel-safe phase" placeholder is a blank, not a fact.
    expect(within(deps).queryByText('Parallel-safe with')).toBeNull();
  });

  it('says a root phase is one, rather than leaving a blank', () => {
    mountPanel('2');
    expect(
      within(screen.getByTestId('phase-dependencies')).getByText('nothing, it is a root phase'),
    ).toBeInTheDocument();
  });

  it('names who holds the claim and how long the lease has left', () => {
    mountPanel('4');
    const claim = screen.getByTestId('phase-claim');
    expect(within(claim).getByText('me@host/opus-p4').tagName).toBe('CODE');
    expect(within(claim).getByText('3h left')).toBeInTheDocument();
  });

  it('says a lapsed claim is free to take over', () => {
    mountPanel('4', plan([{ ...RICH, lock: { ...RICH.lock!, expired: true } } as PhaseView]));
    expect(
      within(screen.getByTestId('phase-claim')).getByText('lapsed, another session may take it over'),
    ).toBeInTheDocument();
  });

  it('on a read-only console, says what turning writes on would give', () => {
    mountPanel('4', detail, { ...STATE, allowWrites: false } as ConsoleState);
    expect(screen.getByText(/Writes are off/)).toBeInTheDocument();
    expect(screen.queryByTestId('write-menu')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mountPanel('4');
    // The markdown blocks are written in after the first paint — scan the page they make.
    await within(screen.getByTestId('phase-handoff')).findByText('The gate never cleared.');
    await expectNoAxeViolations(container);
  });
});

describe('the prompts', () => {
  it('opens the boot prompt by default where booting is the move', async () => {
    mountPanel('5');
    expect(await screen.findByText('BOOT PROMPT TEXT')).toBeInTheDocument();
    expect(prompt).toHaveBeenCalledWith('alpha', 5);
    expect(screen.getByRole('button', { name: 'Hide the prompt' })).toBeInTheDocument();
  });

  it('keeps it folded — and unasked — anywhere else, with the caution above the fold', () => {
    mountPanel('3');
    expect(prompt).not.toHaveBeenCalled();
    const boot = screen.getByTestId('prompt-boot-3');
    expect(within(boot).getByRole('button', { name: 'Show the prompt' })).toBeInTheDocument();
    expect(boot).toHaveTextContent(/This phase is done/);
  });

  it('offers the QA brief once a phase QA judges is done — asked only when opened', async () => {
    mountPanel('3');
    const brief = screen.getByTestId('prompt-qa-3');
    expect(brief).toHaveTextContent('QA brief for phase 3');
    expect(qaPrompt).not.toHaveBeenCalled();
    fireEvent.click(within(brief).getByRole('button', { name: 'Show the brief' }));
    expect(await within(brief).findByText('QA BRIEF TEXT')).toBeInTheDocument();
    await waitFor(() => expect(qaPrompt).toHaveBeenCalledWith('alpha', 3));
  });

  it('offers no QA brief where QA is off for the phase', () => {
    mountPanel('2');
    expect(screen.queryByTestId('prompt-qa-2')).toBeNull();
  });
});

describe('promptBanner', () => {
  it('says nothing for a ready phase', () => {
    expect(promptBanner({ state: 'ready' })).toBeUndefined();
  });

  it('names the gate before the board word — a gated phase can read ready', () => {
    expect(promptBanner({ state: 'ready', gated: true, gateKind: 'human' })).toMatchObject({
      severity: 'warn',
      text: expect.stringMatching(/gated/),
    });
    // An ai gate is cleared BY booting, so booting is the way through.
    expect(promptBanner({ state: 'ready', gated: true, gateKind: 'ai' })).toMatchObject({
      severity: 'info',
      text: expect.stringMatching(/booting is the way through/),
    });
    // A done phase's gate is history.
    expect(promptBanner({ state: 'done', gated: true })?.text).toMatch(/This phase is done/);
  });

  it('names the wall each other state would meet', () => {
    expect(promptBanner({ state: 'in-progress' })).toMatchObject({
      severity: 'warn',
      text: expect.stringMatching(/already on this phase/),
    });
    expect(promptBanner({ state: 'done' })?.severity).toBe('info');
    expect(promptBanner({ state: 'stuck' })?.text).toMatch(/blocked/);
    expect(promptBanner({ state: 'blocked' })?.text).toMatch(/blocked/);
    expect(promptBanner({ state: 'waiting' })?.text).toMatch(/dependencies are not met/i);
  });
});
