/**
 * The cells every phase table is built from.
 *
 * Worth their own suite because they are the fix for a class of bug rather
 * than one bug: four surfaces rendered the same phase and disagreed about it,
 * and the disagreements were invisible in review because each table hand-wrote
 * its own JSX. What is pinned here is the vocabulary — a live claim and a
 * lapsed one must never read alike, and a dependency must be rendered whether
 * or not the phase happens to be waiting.
 */

import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PhaseView } from '@/lib/api';
import { queryClientConfig } from '@/lib/queries';
import {
  DepsCell,
  FlagsCell,
  LockCell,
  LockChip,
  PhaseDetails,
  ScopeCell,
  SizeCell,
  TitleCell,
} from './phase-cells';

const phase = (over: Partial<PhaseView> = {}): PhaseView => ({
  phase: 4,
  title: 'Wire the relay',
  state: 'ready',
  size: 'M',
  weight: 3,
  gated: false,
  bullets: [],
  ...over,
});

const analysis = (over: Partial<NonNullable<PhaseView['analysis']>> = {}) => ({
  phase: 4,
  state: 'ready',
  size: 'M',
  weight: 3,
  dependsOn: [2, 3],
  dependents: [5],
  transitiveDependents: [5, 6, 7],
  unblocks: 1,
  onCriticalPath: false,
  ...over,
});

describe('LockChip', () => {
  it('a live claim names its owner in the chip, not behind a hover', async () => {
    // The owner used to live in a `title`. A claim you cannot attribute without
    // hovering is a claim you cannot act on — and on a phone there is no hover.
    render(<LockChip lock={{ owner: 'someone/else', expired: false, leaseUntil: Date.now() + 600_000 }} />);
    expect(screen.getByText(/held by someone\/else/)).toBeTruthy();
  });

  it('a lapsed claim reads differently from a live one', async () => {
    // The whole rail turns on this difference: live blocks, stale only warns.
    // If the two painted alike, the console would be teaching the wrong rule.
    render(<LockChip lock={{ owner: 'someone/else', expired: true }} />);
    expect(screen.getByText(/stale claim/)).toBeTruthy();
    expect(screen.queryByText(/held by/)).toBeNull();
  });

  it('renders nothing at all when nobody holds the phase', () => {
    const { container } = render(<LockChip />);
    expect(container.textContent).toBe('');
  });

  it('carries host, claim time and scope in its tooltip', () => {
    render(
      <LockChip
        lock={{
          owner: 'someone/else',
          expired: false,
          host: 'their-box',
          claimedAt: Date.now() - 3_600_000,
          scope: ['app', 'api'],
        }}
      />,
    );
    const title = screen.getByText(/held by/).getAttribute('title') ?? '';
    expect(title).toContain('their-box');
    expect(title).toContain('app, api');
  });

  it('the Lock CELL says nothing-holds-this out loud', () => {
    // A blank cell in a Lock column is ambiguous — "no claim" or "not loaded"?
    render(<LockCell />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('DepsCell', () => {
  it('shows what a phase needs even when it is not waiting', () => {
    // The Departures board used to render this only for `waiting` phases, so
    // the plan's shape was invisible on every row that was moving.
    render(<DepsCell slug="alpha" phase={phase({ state: 'done', analysis: analysis() })} />);
    expect(screen.getByText('P2')).toBeTruthy();
    expect(screen.getByText('P3')).toBeTruthy();
  });

  it('links each dependency to its phase, and can be told not to', () => {
    const { unmount } = render(<DepsCell slug="alpha" phase={phase({ analysis: analysis() })} />);
    expect(screen.getByText('P2').closest('a')?.getAttribute('href')).toContain('alpha');
    unmount();

    // Inside a card that is itself a link, an anchor would be invalid markup.
    render(<DepsCell slug="alpha" phase={phase({ analysis: analysis() })} linked={false} />);
    expect(screen.getByText('P2 · P3').closest('a')).toBeNull();
  });

  it('reports what the phase unblocks, and how much sits behind it', () => {
    render(<DepsCell slug="alpha" phase={phase({ analysis: analysis() })} />);
    expect(screen.getByText(/unblocks 1 · 3 downstream/)).toBeTruthy();
  });

  it('falls back to the plan graph when the engine analysis is absent', () => {
    render(
      <DepsCell
        slug="alpha"
        phase={phase({
          row: { phase: 4, title: 't', dependsOn: [1], parallelSafe: '', repos: 'app', exitCriteria: '' },
        })}
      />,
    );
    expect(screen.getByText('P1')).toBeTruthy();
  });

  it('a root phase with nothing behind it says so', () => {
    render(<DepsCell slug="alpha" phase={phase()} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('SizeCell and FlagsCell', () => {
  it('the size carries its weight in the tooltip and its estimate beneath', () => {
    render(
      <SizeCell phase={phase()} eta={{ phase: 4, weight: 3, estMs: 1, basis: 'plan', label: '~40m' }} />,
    );
    expect(screen.getByText('M').getAttribute('title')).toContain('weight');
    expect(screen.getByText('~40m')).toBeTruthy();
  });

  it('the gated chip names the category when the plan declares one', () => {
    render(<FlagsCell slug="alpha" phase={phase({ gated: true, gateKind: 'ai' })} />);
    expect(screen.getByText('gated·ai')).toBeTruthy();
  });

  it('the flag pile deliberately excludes the claim — that gets a column', () => {
    render(
      <FlagsCell
        slug="alpha"
        phase={phase({ gated: true, lock: { owner: 'someone/else', expired: false } })}
      />,
    );
    expect(screen.getByText('gated')).toBeTruthy();
    expect(screen.queryByText(/held by/)).toBeNull();
  });
});

describe('PhaseDetails', () => {
  it('carries the fields no row has room for', () => {
    render(
      <PhaseDetails
        slug="alpha"
        phase={phase({
          goal: 'Wire the relay so a write lands.',
          gates: 'P3 handoff merged',
          model: 'opus',
          effort: 'high',
          analysis: analysis({ onCriticalPath: true }),
        })}
      />,
    );

    expect(screen.getByText(/Wire the relay so a write lands/)).toBeTruthy();
    expect(screen.getByText('P3 handoff merged')).toBeTruthy();
    expect(screen.getByText('opus')).toBeTruthy();
    expect(screen.getByText('on the longest remaining chain')).toBeTruthy();
  });

  it('spells out the whole claim, including a scope nobody stated', () => {
    // An absent scope is not "no scope" — the engine treats it as colliding
    // with everything, which is the opposite of what a blank would suggest.
    render(
      <PhaseDetails
        slug="alpha"
        phase={phase({
          lock: {
            owner: 'someone/else',
            expired: false,
            host: 'their-box',
            leaseUntil: Date.now() + 600_000,
          },
        })}
      />,
    );

    expect(screen.getByText('someone/else')).toBeTruthy();
    expect(screen.getByText('their-box')).toBeTruthy();
    expect(screen.getByText(/collides with everything/)).toBeTruthy();
  });

  it('drops rows it has no value for rather than padding them with dashes', () => {
    render(<PhaseDetails slug="alpha" phase={phase()} />);
    expect(screen.queryByText('Gates')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    // Size is always known, so it is always there.
    expect(screen.getByText('Size')).toBeTruthy();
  });
});

/* ---------------- one phase changing costs one row ---------------- */

/**
 * The board's redraw cost is per-CHANGED-phase, not per-phase.
 *
 * Two halves, because neither is worth anything without the other and each one
 * alone is the sort of test that passes in both worlds:
 *
 *   - Every cell is a `memo` component. Structural, and deliberately so —
 *     jsdom can observe a component's DOM but not whether React re-entered its
 *     body, so "did this row re-render" is not a question the DOM can answer.
 *     Unwrap one and this fails.
 *   - The premise the memo rests on: a refetch that changes one phase leaves
 *     every other phase's object IDENTICAL. That is TanStack Query's
 *     `structuralSharing`, on by default and not turned off in
 *     `lib/queries.ts`. Turn it off and the memos above stop paying while
 *     everything still renders correctly, which is exactly the kind of silent
 *     regression worth a test.
 */
describe('the cells are memoised, and the props that feed them hold still', () => {
  const MEMO = Symbol.for('react.memo');

  it('every cell a board row mounts is a memo component', () => {
    const cells = { DepsCell, FlagsCell, LockCell, LockChip, ScopeCell, SizeCell, TitleCell };
    for (const [name, cell] of Object.entries(cells)) {
      expect(
        (cell as unknown as { $$typeof?: symbol }).$$typeof,
        `${name} is no longer memoised — one phase changing now redraws every row`,
      ).toBe(MEMO);
    }
  });

  it('a refetch that changes one phase keeps every other phase object identical', async () => {
    const client = new QueryClient(queryClientConfig);
    const key = ['plan', 'demo'];
    const before = [phase({ phase: 1 }), phase({ phase: 2 }), phase({ phase: 3 })];
    client.setQueryData(key, { phases: before });

    // The same JSON arriving again with ONE phase moved on — a fresh object
    // graph, exactly as `JSON.parse` hands it over.
    client.setQueryData(key, {
      phases: [{ ...before[0] }, { ...before[1], state: 'done' }, { ...before[2] }],
    });

    const after = client.getQueryData<{ phases: PhaseView[] }>(key)!.phases;
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    // The one that actually changed is a new object, so its row does re-render.
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].state).toBe('done');
  });
});
