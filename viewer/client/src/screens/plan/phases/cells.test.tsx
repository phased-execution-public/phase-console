/**
 * The cells every phase table is built from (7.0, quiet-console phase 10;
 * ported from `features/plans/phase-cells.test.tsx`).
 *
 * Worth their own suite because they are the fix for a class of bug rather
 * than one bug: four surfaces rendered the same phase and disagreed about it,
 * and the disagreements were invisible in review because each table
 * hand-wrote its own JSX. What is pinned here is the vocabulary — a live claim
 * and a lapsed one must never read alike, and a dependency must be rendered
 * whether or not the phase happens to be waiting.
 *
 * 6.2's chips are words in 7.0. The flag pile (`FlagsCell`) and the title cell
 * are gone from this file: the gate is the grid's Gate column and the State
 * cell's overlay word, the title the grid's identity — `table.test.tsx` holds
 * both.
 */

import { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PhaseView } from '@/data/api';
import { queryClientConfig } from '@/data/keys';
import { DepsCell, LockCell, LockWords, PhaseDetails, ScopeCell, ScopeWords, SizeCell } from './cells';
import { PhaseMark } from './row';

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

/** Ten minutes and a margin, so the countdown reads `10m left` however long the render takes. */
const TEN_MINUTES = 600_000 + 20_000;

const claimOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-lock]');

describe('LockWords', () => {
  it('a live claim names its owner in the words, not behind a hover — and what is left of its lease', () => {
    // The owner used to live in a `title`. A claim you cannot attribute without
    // hovering is a claim you cannot act on — and on a phone there is no hover.
    const { container } = render(
      <LockWords lock={{ owner: 'someone/else', expired: false, leaseUntil: Date.now() + TEN_MINUTES }} />,
    );
    const claim = claimOf(container)!;
    expect(claim).toHaveAttribute('data-lock', 'live');
    expect(claim.textContent).toBe('held by someone/else, 10m left');
  });

  it('a lapsed claim reads differently from a live one', () => {
    // The whole rail turns on this difference: live blocks, stale only warns.
    // If the two read alike, the console would be teaching the wrong rule.
    const { container } = render(<LockWords lock={{ owner: 'someone/else', expired: true }} />);
    expect(claimOf(container)).toHaveAttribute('data-lock', 'stale');
    expect(screen.getByText(/stale claim/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/held/);
  });

  it('renders nothing at all when nobody holds the phase', () => {
    const { container } = render(<LockWords />);
    expect(container.textContent).toBe('');
  });

  it('carries host, claim time and scope in its title', () => {
    const { container } = render(
      <LockWords
        lock={{
          owner: 'someone/else',
          expired: false,
          host: 'their-box',
          claimedAt: Date.now() - 3_600_000,
          scope: ['app', 'api'],
        }}
      />,
    );
    const title = claimOf(container)!.getAttribute('title') ?? '';
    expect(title).toContain('someone/else on their-box');
    expect(title).toContain('claimed 1 hour ago');
    expect(title).toContain('app, api');
  });

  it('compact, the owner leaves the words and stays in the title — the grid’s Claim column', () => {
    const { container } = render(
      <LockWords
        compact
        lock={{ owner: 'someone/else', expired: false, leaseUntil: Date.now() + TEN_MINUTES }}
      />,
    );
    expect(claimOf(container)!.textContent).toBe('held, 10m left');
    expect(claimOf(container)!.getAttribute('title')).toContain('someone/else');
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
    expect(screen.getByText('P2').closest('a')?.getAttribute('href')).toBe('#/plan/alpha/phase/2');
    unmount();

    // Inside a card that is itself a link, an anchor would be invalid markup.
    render(<DepsCell slug="alpha" phase={phase({ analysis: analysis() })} linked={false} />);
    expect(screen.getByText('P2, P3').closest('a')).toBeNull();
  });

  it('reports what the phase unblocks, and how much sits behind it', () => {
    render(<DepsCell slug="alpha" phase={phase({ analysis: analysis() })} />);
    expect(screen.getByText(/unblocks 1, 3 downstream/)).toBeTruthy();
  });

  it('draws a long list up to its bound, and counts the rest with their names in its title', () => {
    render(
      <DepsCell slug="alpha" phase={phase({ analysis: analysis({ dependsOn: [1, 2, 3, 5, 8] }) })} max={3} />,
    );
    expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual(['P1', 'P2', 'P3']);
    expect(screen.getByText('2 more')).toHaveAttribute('title', 'Also needs P5, P8');
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

describe('SizeCell', () => {
  it('the size carries its weight in the title and its estimate beneath', () => {
    render(
      <SizeCell
        phase={phase()}
        eta={{ phase: 4, weight: 3, estMs: 1, basis: 'plan', clock: 'working', label: '~40m' }}
      />,
    );
    expect(screen.getByText('M').getAttribute('title')).toContain('weight');
    expect(screen.getByText('~40m')).toHaveAttribute('title', 'An estimate (plan), not a measurement.');
  });
});

describe('ScopeWords and ScopeCell', () => {
  it('a blank Repos cell reads `all` — the honest reading of "this might touch anything"', () => {
    render(
      <ScopeCell
        phase={phase({
          row: { phase: 4, title: 't', dependsOn: [], parallelSafe: '', repos: '', exitCriteria: '' },
        })}
      />,
    );
    expect(screen.getByText('all')).toBeInTheDocument();
  });

  it('draws two tokens and counts the rest, the whole list and any collision in its title', () => {
    const { container } = render(<ScopeWords tokens={['web', 'api', 'docs']} conflicts={['beta P2']} />);
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.queryByText('docs')).toBeNull();
    expect(screen.getByText('1 more')).toBeInTheDocument();
    expect(screen.getByText('collides with beta P2')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      'title',
      'web, api, docs\n\nwould collide with: beta P2',
    );
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
            leaseUntil: Date.now() + TEN_MINUTES,
          },
        })}
      />,
    );

    expect(screen.getByText('someone/else')).toBeTruthy();
    expect(screen.getByText('their-box')).toBeTruthy();
    expect(screen.getByText('10m left')).toBeTruthy();
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
 *     `data/keys.ts`. Turn it off and the memos above stop paying while
 *     everything still renders correctly, which is exactly the kind of silent
 *     regression worth a test.
 */
describe('the cells are memoised, and the props that feed them hold still', () => {
  const MEMO = Symbol.for('react.memo');

  it('every cell a board row mounts is a memo component', () => {
    const cells = { DepsCell, LockCell, LockWords, PhaseMark, ScopeCell, ScopeWords, SizeCell };
    for (const [name, cell] of Object.entries(cells)) {
      expect(
        (cell as unknown as { $$typeof?: symbol }).$$typeof,
        `${name} is no longer memoised — one phase changing now redraws every row`,
      ).toBe(MEMO);
    }
  });

  it('a refetch that changes one phase keeps every other phase object identical', () => {
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
    expect(after[1]!.state).toBe('done');
  });
});
