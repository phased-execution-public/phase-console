/**
 * The phase inspector — L2 and L3 for the plan surface.
 *
 * The properties this file exists to hold, in the order they would bite:
 *
 *   - **it shows the record, not a skeleton, before its own fetch lands.** The
 *     board's `PhaseView` already carries identity, state, lock and analysis;
 *     blanking a sheet that can answer most of the question, to wait for the
 *     rest, is a worse answer than showing what is known.
 *   - **the prose comes from the FETCH.** This is the whole reason the sheet
 *     asks for anything: the Route and Phases tabs deliberately fetch the board
 *     projection, which has no prose at all, so a sheet reading its host tab's
 *     record would render every prose row empty and say nothing about it. The
 *     failure is silent, which is why it is asserted from both sides.
 *   - **L3 exists and is folded.** `docs/design.md` §1 puts the raw record one
 *     rung below the inspector, behind a disclosure that NAMES it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { queryClientConfig } from '@/lib/queries';
import type { PhaseView, PlanDetail } from '@/lib/api';

const { plan, state, run } = vi.hoisted(() => ({ plan: vi.fn(), state: vi.fn(), run: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { ...actual.api, plan, state, run } };
});

/** What the BOARD projection carries: no prose, and that is the point. */
const BOARD_PHASE = {
  phase: 4,
  title: 'Shell and navigation',
  state: 'done',
  size: 'L',
  weight: 90_000,
  gated: false,
  row: { repos: 'phased-execution', exitCriteria: 'eight destinations' },
} as unknown as PhaseView;

/** The same phase with `?include=prose` — the fields only the fetch returns. */
const FULL_PHASE = {
  ...BOARD_PHASE,
  goal: 'Put the nav on the 4.0 system.',
  readFirst: 'The phase 3 handoff.',
  steps: 'Register the two destinations, then band the rail.',
  verification: 'npm run test:client',
} as unknown as PhaseView;

async function mount(phase: PhaseView = BOARD_PHASE) {
  const client = new QueryClient(queryClientConfig);
  const { PhaseInspector } = await import('./phase-inspector');
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PhaseInspector slug="demo" phase={phase} open onOpenChange={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mockResolvedValue({ allowWrites: false });
  run.mockResolvedValue({ run: null, history: [], eta: null });
  plan.mockResolvedValue({ summary: { slug: 'demo' }, phases: [FULL_PHASE] } as unknown as PlanDetail);
});

describe('the phase inspector', () => {
  it('inks the ONLY door to itself above the AA floor', async () => {
    // `contrast.test.ts` holds `--ink-faint` to the 3:1 LARGE-text floor only —
    // this word is 12px, measured 4.19:1 on `bg-surface` and 3.44:1 on
    // `--ground`. It shipped faint for two rounds because nothing pinned the
    // choice: reverting the class left every test green. design.md §3 reserves
    // faint for "true metadata", and an affordance is never metadata.
    const { InspectButton } = await import('./phase-inspector');
    render(<InspectButton onClick={() => {}} label="Inspect phase 4" />);
    const button = screen.getByRole('button', { name: 'Inspect phase 4' });
    expect(button.className).toContain('text-ink-muted');
    expect(button.className).not.toContain('text-ink-faint');
  });

  it('names the record it is about — the number is part of the name', async () => {
    await mount();
    // Two plans open in two tabs, and a sheet titled with a phase title alone
    // is unattributed in both.
    expect(await screen.findByText(/Phase 04 — Shell and navigation/)).toBeInTheDocument();
  });

  it('reads the prose out of its own fetch, which the host tab never asked for', async () => {
    await mount();
    // `BOARD_PHASE` has none of these. If the sheet read its prop, every prose
    // row would be dropped by `KeyValue` and the sheet would say nothing.
    expect(await screen.findByText('Put the nav on the 4.0 system.')).toBeInTheDocument();
    expect(screen.getByText('Register the two destinations, then band the rail.')).toBeInTheDocument();
    expect(screen.getByText('npm run test:client')).toBeInTheDocument();
  });

  it('asks for exactly the groups those fields live in', async () => {
    await mount();
    await screen.findByText('Put the nav on the 4.0 system.');
    const { INSPECTOR_INCLUDES } = await import('./phase-inspector');
    expect(plan).toHaveBeenCalledWith('demo', { include: INSPECTOR_INCLUDES });
    expect([...INSPECTOR_INCLUDES].sort()).toEqual(['handoffs', 'prose']);
  });

  it('shows what it already knows while the fetch is in flight', async () => {
    // A promise that never settles: the sheet must still be a sheet about a
    // phase, not an empty panel with a spinner in it.
    plan.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(screen.getByText(/Phase 04 — Shell and navigation/)).toBeInTheDocument();
    // The board's own facts are on screen with no request answered at all.
    // Exactly two: the scope is a chip in the identity row AND the Repos fact
    // below it, which is the arrangement rather than a duplicate. A bare
    // `getAllByText(...).length > 0` would have asserted nothing at all —
    // `getAllByText` throws on zero, so the comparison can never be false.
    expect(screen.getAllByText('phased-execution')).toHaveLength(2);
    expect(screen.getByText('eight destinations')).toBeInTheDocument();
  });

  it('lets the LIVE record win every field it has, and the fetch fill the rest', async () => {
    // The fetched payload is a different query key with its own lifetime, and
    // under `staleTime: Infinity` it is fetched once and never again. So the
    // prop — which the tab's own streaming query feeds — must win on state,
    // and the fetch must still supply the prose the board never carries.
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [{ ...FULL_PHASE, state: 'waiting', size: 'S' }],
    } as unknown as PlanDetail);
    await mount({ ...BOARD_PHASE, state: 'in-progress' } as unknown as PhaseView);

    expect(await screen.findByText('Put the nav on the 4.0 system.')).toBeInTheDocument();
    // The live word, not the one the sheet's own fetch happened to return.
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Waiting')).toBeNull();
    expect(screen.getByText(/^L · weight/)).toBeInTheDocument();
  });

  it('restores every sub-field the BOARD projection strips out of an object it keeps', async () => {
    // The defect this pins: `handoff` is present on the board record and lossy
    // (`HANDOFF_PROSE_FIELDS` — the board keeps the reference so `FlagsCell` can
    // draw its status chip, and strips only the paragraph). A flat spread with
    // the live record last threw away the very thing the sheet paid a request
    // for, and rendered Outstanding permanently blank.
    //
    // Derived from the constant, not hard-coded: adding a second sub-field to
    // that list turns this red until the merge handles it too.
    const { HANDOFF_PROSE_FIELDS } = await import('@shared/projection.js');
    expect(HANDOFF_PROSE_FIELDS.length).toBeGreaterThan(0);
    const fullHandoff = Object.fromEntries(
      HANDOFF_PROSE_FIELDS.map((f: string) => [f, `the ${f} paragraph`]),
    );
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [
        { ...FULL_PHASE, handoff: { file: 'h.md', status: 'complete', skillsUsed: [], ...fullHandoff } },
      ],
    } as unknown as PlanDetail);
    // What the board carries: the SAME reference, with those fields omitted.
    await mount({
      ...BOARD_PHASE,
      handoff: { file: 'h.md', status: 'complete', skillsUsed: [] },
    } as unknown as PhaseView);

    await screen.findByText('Put the nav on the 4.0 system.');
    for (const f of HANDOFF_PROSE_FIELDS) {
      expect(screen.getByText(`the ${f} paragraph`)).toBeInTheDocument();
    }
  });

  it('lets the live handoff win every key it carries, not just the object', async () => {
    // The other half of the sub-field merge, and it was unpinned: reversing
    // `merged()`'s inner spread left every test green. `handoff.status` moves
    // on the stream while the fetched copy is frozen by `staleTime: Infinity`,
    // so a sheet preferring the fetched one reports a stale status for as long
    // as it is open.
    plan.mockResolvedValue({
      summary: { slug: 'demo' },
      phases: [
        {
          ...FULL_PHASE,
          handoff: {
            file: 'h.md',
            status: 'in-progress',
            skillsUsed: [],
            outstanding: 'the outstanding paragraph',
          },
        },
      ],
    } as unknown as PlanDetail);
    await mount({
      ...BOARD_PHASE,
      handoff: { file: 'h.md', status: 'complete', skillsUsed: [] },
    } as unknown as PhaseView);

    // The paragraph comes from the fetch…
    expect(await screen.findByText('the outstanding paragraph')).toBeInTheDocument();
    // …and the status from the live record, in the same object.
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.queryByText('in-progress')).toBeNull();
  });

  it('keeps the raw record one rung down, and names it', async () => {
    await mount();
    await screen.findByText('Put the nav on the 4.0 system.');
    // Folded: L3 is a rung, not a wall of JSON on top of the facts.
    expect(screen.queryByText(/"phase": 4/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Raw record' });
    fireEvent.click(toggle);
    expect(screen.getByText(/"phase": 4/)).toBeInTheDocument();
    // The FETCHED record, not the prop — the raw view of a sheet showing prose
    // must be the thing the prose came from.
    expect(screen.getByText(/"steps"/)).toBeInTheDocument();
  });
});
