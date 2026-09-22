/**
 * The three badges, and the one property they share: each renders NOTHING when
 * its fact is absent.
 *
 * That is not defensiveness. An older server does not send `proof` or
 * `liveness` at all, and the alternative to a blank cell is a badge asserting
 * something the console was never told — "evidenced" on a phase nobody
 * verified is exactly the claim this whole model exists to stop.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ContextChip, EvidenceLine, LivenessChip, RulingsChip } from './phase-row';
import type { EvidenceProof, LaneLiveness } from '@/lib/api';
import { STALL_SIGNAL_META } from '@shared/attention-model.js';

const proof = (over: Partial<EvidenceProof> = {}): EvidenceProof => ({
  board: 'done',
  handoff: 'complete',
  verification: 'green',
  qa: 'off',
  evidenced: true,
  why: ['board: done', 'verification: green'],
  ...over,
});

describe('<EvidenceLine>', () => {
  it('badges a done claim that nothing backs', () => {
    render(<EvidenceLine proof={proof({ evidenced: false, verification: 'none', handoff: 'absent' })} />);
    expect(screen.getByText('claimed only')).toBeInTheDocument();
  });

  it('badges a done claim that is backed', () => {
    render(<EvidenceLine proof={proof()} />);
    expect(screen.getByText('evidenced')).toBeInTheDocument();
  });

  it('says NOTHING about a phase that is not claiming to be done', () => {
    // A `ready` phase has not claimed anything, so "not evidenced" would be a
    // warning on every plan that has not started yet.
    const { container } = render(<EvidenceLine proof={proof({ board: 'ready', evidenced: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('spells the four facts out in the drawer rendering', () => {
    render(<EvidenceLine verbose proof={proof({ qa: 'fail', evidenced: false })} />);
    expect(screen.getByText('Claimed versus evidenced')).toBeInTheDocument();
    expect(screen.getByText('QA failed')).toBeInTheDocument();
    expect(screen.getByText('the §Verification commands ran and passed')).toBeInTheDocument();
    // `skipped` and `human` are NOT failures — a command whose lead is not
    // installed, and a check only a person can answer.
    render(<EvidenceLine verbose proof={proof({ verification: 'skipped' })} />);
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

describe('<LivenessChip>', () => {
  it('renders nothing without a lane — which is most rows', () => {
    const { container } = render(<LivenessChip liveness={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the stall and how long it has been one', () => {
    render(
      <LivenessChip
        liveness={lane({
          stall: {
            signal: 'silent',
            since: new Date(Date.now() - 11 * 60_000).toISOString(),
            detail: 'Bash open 11m',
          },
        })}
      />,
    );
    // Asserted against the shared vocabulary BY IDENTITY, not a literal. The
    // chip used to read a local word-book whose label for this signal was
    // 'Silent' while shared said 'Session silent'; a hardcoded literal here
    // would just be a fourth copy of the same drift.
    expect(screen.getByText(new RegExp(STALL_SIGNAL_META.silent.label))).toBeInTheDocument();
  });

  it('shows the open tool on a healthy lane, because that is usually the answer', () => {
    render(
      <LivenessChip
        liveness={lane({ openTool: { id: 't1', name: 'Bash', since: new Date().toISOString() } })}
      />,
    );
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });
});

/*
 * autopilot-token-drain phase 3: what a live lane's session costs in context.
 * The run that motivated it peaked at 957k with nothing on any surface saying so.
 */
describe('<ContextChip>', () => {
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
    const { container } = render(<ContextChip liveness={lane()} />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<ContextChip liveness={undefined} />);
    expect(none).toBeEmptyDOMElement();
  });

  it('shows the context now and at its peak, the rebuilds and the status checks', () => {
    render(<ContextChip liveness={lane({ tokens })} />);
    const chip = screen.getByText('412K ctx · peak 455K · 2 rebuilds · 17 polls');
    expect(chip.getAttribute('title')).toMatch(/of a 1\.0M window \(41 %\)/);
    expect(chip.getAttribute('title')).toMatch(/312 API calls/);
    expect(chip).not.toHaveAttribute('data-stage');
  });

  it('leaves out what has not happened: no peak above now, no rebuilds, no polls', () => {
    render(
      <ContextChip liveness={lane({ tokens: { ...tokens, peak: 412_300, rebuilds: 0, pollCalls: 0 } })} />,
    );
    expect(screen.getByText('412K ctx')).toBeInTheDocument();
  });

  it('marks a session past the wrap-up line, and one being checkpointed', () => {
    const { unmount } = render(
      <ContextChip
        liveness={lane({ tokens: { ...tokens, context: 612_000, peak: 612_000, stage: 'wrap-up' } })}
      />,
    );
    const told = screen.getByText(/^612K ctx/);
    expect(told).toHaveAttribute('data-stage', 'wrap-up');
    expect(told.getAttribute('title')).toMatch(/told to wrap up/);
    unmount();

    render(
      <ContextChip
        liveness={lane({ tokens: { ...tokens, context: 812_000, peak: 812_000, stage: 'checkpoint' } })}
      />,
    );
    const cut = screen.getByText(/^812K ctx/);
    expect(cut).toHaveAttribute('data-stage', 'checkpoint');
    expect(cut.getAttribute('title')).toMatch(/boards fresh/);
  });
});

describe('<RulingsChip>', () => {
  it('counts, and disappears at zero', () => {
    const { container } = render(<RulingsChip count={0} />);
    expect(container).toBeEmptyDOMElement();
    render(<RulingsChip count={1} />);
    expect(screen.getByText('1 ruling')).toBeInTheDocument();
    render(<RulingsChip count={3} />);
    expect(screen.getByText('3 rulings')).toBeInTheDocument();
  });
});
