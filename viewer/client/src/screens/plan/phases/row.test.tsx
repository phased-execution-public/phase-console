/**
 * What a phase row says beyond its name (7.0, quiet-console phase 10; ported
 * from `features/runs/phase-row.test.tsx`) — and the one property the words
 * share: each renders NOTHING when its fact is absent.
 *
 * That is not defensiveness. An older server does not send `proof` or
 * `liveness` at all, and the alternative to a blank is a word asserting
 * something the console was never told — "evidenced" on a phase nobody
 * verified is exactly the claim this whole model exists to stop.
 *
 * 6.2 drew these as chips; 7.0 says them as words (`[data-status]` is the one
 * dot-and-word, the board's), so the selectors read text and titles.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STALL_SIGNAL_META } from '@shared/attention-model.js';
import type { EvidenceProof, LaneLiveness } from '@/data/api';
import {
  BranchWords,
  ContextWords,
  EvidenceWords,
  LandWords,
  LandingWords,
  LivenessWords,
  PhaseMark,
  RulingsCount,
  TaskWords,
} from './row';

const proof = (over: Partial<EvidenceProof> = {}): EvidenceProof => ({
  board: 'done',
  handoff: 'complete',
  verification: 'green',
  qa: 'off',
  evidenced: true,
  why: ['board: done', 'verification: green'],
  ...over,
});

describe('<EvidenceWords>', () => {
  it('says a done claim that nothing backs is only claimed', () => {
    render(<EvidenceWords proof={proof({ evidenced: false, verification: 'none', handoff: 'absent' })} />);
    const word = screen.getByText('claimed only');
    // Why, in the engine's own reasons, on the word itself.
    expect(word).toHaveAttribute('title', 'board: done. verification: green');
  });

  it('says a done claim that is backed is evidenced', () => {
    render(<EvidenceWords proof={proof()} />);
    expect(screen.getByText('evidenced')).toBeInTheDocument();
  });

  it('says NOTHING about a phase that is not claiming to be done', () => {
    // A `ready` phase has not claimed anything, so "not evidenced" would be a
    // warning on every plan that has not started yet.
    const { container } = render(<EvidenceWords proof={proof({ board: 'ready', evidenced: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says an in-progress claim nothing was observed behind is only claimed running — and only when measured', () => {
    render(<EvidenceWords proof={proof({ board: 'in-progress', evidenced: false, stale: true })} />);
    expect(screen.getByText('claimed running')).toBeInTheDocument();
    // `stale` absent is an older server: not measured, never "measured and empty".
    const { container } = render(<EvidenceWords proof={proof({ board: 'in-progress', evidenced: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('spells the four facts out in the drawer rendering', () => {
    render(<EvidenceWords verbose proof={proof({ qa: 'fail', evidenced: false })} />);
    expect(screen.getByRole('region', { name: 'Claimed versus evidenced' })).toBeInTheDocument();
    expect(screen.getByText('QA failed')).toBeInTheDocument();
    expect(screen.getByText('the §Verification commands ran and passed')).toBeInTheDocument();
    // `skipped` and `human` are NOT failures — a command whose lead is not
    // installed, and a check only a person can answer.
    render(<EvidenceWords verbose proof={proof({ verification: 'skipped' })} />);
    expect(screen.getByText(/lead is not installed here/)).toBeInTheDocument();
  });
});

const lane = (over: Partial<LaneLiveness> = {}): LaneLiveness => ({
  phase: 3,
  lastOutputAt: new Date().toISOString(),
  turnsSinceLastTool: 1,
  commitsSinceStart: 2,
  treeDirty: false,
  ...over,
});

describe('<LivenessWords>', () => {
  it('renders nothing without a lane — which is most rows', () => {
    const { container } = render(<LivenessWords liveness={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the stall and how long it has been one', () => {
    render(
      <LivenessWords
        liveness={lane({
          stall: {
            signal: 'silent',
            since: new Date(Date.now() - 11 * 60_000).toISOString(),
            detail: 'Bash open 11m',
          },
        })}
      />,
    );
    // Asserted against the shared vocabulary BY IDENTITY, not a literal: a
    // local word-book once said 'Silent' where shared said 'Session silent',
    // and a hardcoded literal here would be a fourth copy of the same drift.
    const stall = screen.getByTestId('lane-stall');
    expect(stall.textContent).toMatch(new RegExp(`^${STALL_SIGNAL_META.silent.label} since `));
    expect(stall).toHaveAttribute('title', expect.stringContaining('Bash open 11m'));
  });

  it('shows the open tool on a healthy lane, because that is usually the answer', () => {
    render(
      <LivenessWords
        liveness={lane({ openTool: { id: 't1', name: 'Bash', since: new Date().toISOString() } })}
      />,
    );
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByTestId('lane-liveness').textContent).toBe('Bash open');
  });

  it('counts a retry storm before it is a stall', () => {
    render(<LivenessWords liveness={lane({ retries: { count: 4, since: new Date().toISOString() } })} />);
    const storm = screen.getByText('4 retries');
    expect(storm.getAttribute('title')).toMatch(/4 API retries since the last productive event/);
  });
});

/*
 * autopilot-token-drain phase 3: what a live lane's session costs in context.
 * The run that motivated it peaked at 957k with nothing on any surface saying so.
 */
describe('<ContextWords>', () => {
  const tokens = {
    context: 412_300,
    peak: 455_000,
    calls: 312,
    rebuilds: 2,
    input: 900,
    cacheRead: 60_000_000,
    cacheWrite: 700_000,
    output: 90_000,
    pollCalls: 17,
    window: 1_000_000,
  };

  it('renders nothing before the session has made a call — or without a lane', () => {
    const { container } = render(<ContextWords liveness={lane()} />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<ContextWords liveness={undefined} />);
    expect(none).toBeEmptyDOMElement();
  });

  it('shows the context now and at its peak; the rebuilds and the status checks are in its title', () => {
    render(<ContextWords liveness={lane({ tokens })} />);
    const words = screen.getByText('412K context (41 %), peak 455K');
    const title = words.getAttribute('title') ?? '';
    expect(title).toMatch(/of a 1\.0M window/);
    expect(title).toMatch(/312 API calls/);
    expect(title).toMatch(/2 cache rebuilds/);
    expect(title).toMatch(/17 status checks/);
    expect(words).not.toHaveAttribute('data-stage');
  });

  it('leaves out what has not happened: no peak above now', () => {
    render(
      <ContextWords liveness={lane({ tokens: { ...tokens, peak: 412_300, rebuilds: 0, pollCalls: 0 } })} />,
    );
    expect(screen.getByText('412K context (41 %)')).toBeInTheDocument();
  });

  it('marks a session past the wrap-up line, and one being checkpointed', () => {
    const { unmount } = render(
      <ContextWords
        liveness={lane({ tokens: { ...tokens, context: 612_000, peak: 612_000, stage: 'wrap-up' } })}
      />,
    );
    const told = screen.getByText(/^612K context/);
    expect(told).toHaveAttribute('data-stage', 'wrap-up');
    expect(told.textContent).toContain('told to wrap up');
    expect(told.getAttribute('title')).toMatch(/told to wrap up/);
    unmount();

    render(
      <ContextWords
        liveness={lane({ tokens: { ...tokens, context: 812_000, peak: 812_000, stage: 'checkpoint' } })}
      />,
    );
    const cut = screen.getByText(/^812K context/);
    expect(cut).toHaveAttribute('data-stage', 'checkpoint');
    expect(cut.getAttribute('title')).toMatch(/boards fresh/);
  });
});

describe('the lane’s own words — what the session says, its branch, its landing', () => {
  it('each says nothing when its fact is absent: no list, no own checkout, the default Land:, no landing', () => {
    const { container } = render(
      <>
        <TaskWords tasks={[]} />
        <BranchWords branch={undefined} />
        <LandWords land={{ value: 'hold', source: 'default' }} />
        <LandingWords landing={undefined} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('the task words prefer the live frame to the list on the record, and count through the one summary', () => {
    const tasks = [
      { id: '1', content: 'Read', activeForm: 'reading the plan', status: 'completed' },
      { id: '2', content: 'Write', activeForm: 'writing the tests', status: 'in_progress' },
    ];
    const { unmount } = render(<TaskWords tasks={tasks} />);
    expect(screen.getByTestId('task-words').textContent).toBe('1 of 2 tasks, writing the tests');
    unmount();
    render(<TaskWords tasks={tasks} live={{ total: 2, done: 2, active: null }} />);
    expect(screen.getByTestId('task-words').textContent).toBe('2 of 2 tasks');
  });
});

describe('<RulingsCount>', () => {
  it('counts, and disappears at zero', () => {
    const { container } = render(<RulingsCount count={0} />);
    expect(container).toBeEmptyDOMElement();
    render(<RulingsCount count={1} />);
    expect(screen.getByText('1 ruling')).toBeInTheDocument();
    render(<RulingsCount count={3} />);
    expect(screen.getByText('3 rulings')).toBeInTheDocument();
  });
});

describe('<PhaseMark>', () => {
  it('is the board word as a dot and a word, and links to its session only while something is observed working it', () => {
    const { container, unmount } = render(<PhaseMark slug="demo" phase={4} state="in-progress" />);
    // In progress out of a markdown file is a claim, not an observation: no link, no breath.
    expect(container.querySelector('[data-status="in-progress"]')).toHaveTextContent('In progress');
    expect(screen.queryByRole('link')).toBeNull();
    unmount();

    render(<PhaseMark slug="demo" phase={4} state="in-progress" live={{ via: 'run' }} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '#/plan/demo/run?lane=p4');
  });
  it('draws the phase status as a badge — the headline of its row (#361)', () => {
    const { container } = render(<PhaseMark slug="demo" phase={4} state="stuck" />);
    const mark = container.querySelector<HTMLElement>('[data-status="stuck"]')!;
    expect(mark.dataset.chrome).toBe('badge');
    expect(mark.querySelector('svg[data-icon]')).not.toBeNull();
  });
});
