/**
 * The run page's phase table below the shell breakpoint — the card list.
 *
 * Its own file because faking the phone means mocking `@/lib/media` for a whole
 * module (matchMedia answers are cached at module level; `app-phone.test.tsx`
 * and `ui/table-cards.test.tsx` exist for the same reason).
 *
 * What these hold: the cards are the same board, not a reduced one. At 390px
 * the twelve-column cut folded nine columns away and put every remedy behind a
 * disclosure triangle — so the properties pinned here are that the REMEDIES are
 * on the card, that the money and the phase's own link are on it, that the
 * group headings still collapse from the same preference, and that nothing
 * inside a card is a table (a table at 390px is what this replaced).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui';
import { expectNoAxeViolations } from '@/test/axe';
import { keys, queryClientConfig } from '@/lib/queries';
import { getPrefs, setPrefs } from '@/lib/prefs';
import type { PhaseView, RunState } from '@/lib/api';
import { PhaseTable } from './phase-table';

vi.mock('@/lib/media', () => ({
  usePhone: () => true,
  useNarrow: () => true,
  useTouch: () => true,
  isPhone: () => true,
}));

const phase = (over: Partial<PhaseView>): PhaseView =>
  ({
    phase: 1,
    title: 'A phase',
    state: 'ready',
    size: 'S',
    weight: 1,
    gated: false,
    ...over,
  }) as PhaseView;

const run = (over: Partial<RunState>): RunState =>
  ({
    id: 'r1',
    slug: 'demo',
    root: '/repo',
    status: 'parked',
    autonomy: 'keep-going',
    model: 'opus',
    createdAt: '',
    updatedAt: '',
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    spentUsd: 0,
    ...over,
  }) as unknown as RunState;

function mount(node: React.ReactElement) {
  const client = new QueryClient({
    ...queryClientConfig,
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.state(), {
    allowRun: true,
    allowAgent: true,
    allowWrites: false,
    autopilot: true,
    root: { ok: true, path: '/repo' },
  });
  client.setQueryData(keys.terminal(), {
    allowed: false,
    agentAllowed: true,
    available: 'yes',
    sessions: [],
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const board = (
  <PhaseTable
    slug="demo"
    run={run({
      phases: {
        1: { phase: 1, status: 'done', attempts: 1, costUsd: 1.25, turns: 6, durationMs: 90_000 },
        2: { phase: 2, status: 'failed', attempts: 2, costUsd: 3.5, note: 'did not verify' },
      },
    } as never)}
    planPhases={[
      phase({ phase: 1, state: 'done', title: 'Editor truth' }),
      phase({ phase: 2, state: 'ready', title: 'Ship it' }),
    ]}
    live={false}
    allowRun
  />
);

describe('the phase board on a phone', () => {
  it('draws cards, not a table', () => {
    setPrefs({ runPhasesCollapsed: [] });
    mount(board);
    expect(screen.queryByRole('table')).toBeNull();
    // One card per phase, each a real list item under its group's list.
    for (const title of ['Editor truth', 'Ship it']) {
      expect(screen.getByRole('link', { name: title }).closest('li')).toBeTruthy();
    }
  });

  it('carries the facts a phone is opened for: the state, the money and the way in', () => {
    setPrefs({ runPhasesCollapsed: [] });
    mount(board);
    const card = screen.getByRole('link', { name: 'Ship it' }).closest('li') as HTMLElement;
    expect(within(card).getByText('$3.50')).toBeInTheDocument();
    expect(within(card).getByText(/P02/)).toBeInTheDocument();
    // The runner's own last word, in full — a `title` attribute is not
    // reachable with a thumb.
    expect(within(card).getByText('did not verify')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ship it' })).toHaveAttribute(
      'href',
      expect.stringContaining('demo'),
    );
  });

  it('keeps the remedies ON the card — they are why the page is open', () => {
    setPrefs({ runPhasesCollapsed: [] });
    mount(board);
    const card = screen.getByRole('link', { name: 'Ship it' }).closest('li') as HTMLElement;
    expect(within(card).getByRole('button', { name: /Run only this/i })).toBeInTheDocument();
  });

  it('collapses a group from the same preference the desktop writes', () => {
    setPrefs({ runPhasesCollapsed: [] });
    mount(board);
    const heading = screen.getByRole('button', { name: /Done/ });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(heading);
    expect(getPrefs().runPhasesCollapsed).toContain('done');
    expect(screen.queryByRole('link', { name: 'Editor truth' })).toBeNull();
  });

  it('has no axe violations', async () => {
    setPrefs({ runPhasesCollapsed: [] });
    const { container } = mount(board);
    await expectNoAxeViolations(container);
  });
});
