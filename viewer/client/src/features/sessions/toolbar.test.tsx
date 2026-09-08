/**
 * The controls Sessions did not have.
 *
 * Plans and Runs have shared one strip since 3.0; this page grouped by a
 * hard-coded kind order and offered nothing. What is asserted here is what the
 * strip has to promise on a page whose rows are processes:
 *
 *  - **a chip names its kind AND its count separately**, because the two are
 *    two elements and a computed name that runs them together ("Shells2")
 *    reads as a different word;
 *  - **a kind with nothing in it is not a chip.** A dead button that filters to
 *    an empty list is worse than no button;
 *  - **the cut is never silent** — the note says how many rows the filters are
 *    holding back;
 *  - **the flat list still says what each row IS**, since turning grouping off
 *    removes the heading that used to carry the kind.
 *
 * jsdom has no `matchMedia` breakpoints beyond what the setup stubs, so this
 * asserts the DESKTOP shape; the sheet is the same `components/toolbar.tsx`
 * both other lists already exercise.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { SessionList, sessionRows, type SessionRow } from './list';
import { NO_FILTERS } from './model';
import { Controls } from './toolbar';

const counts = { lane: 2, agent: 0, shell: 1, foreign: 3 } as const;

function mount(over: Partial<React.ComponentProps<typeof Controls>> = {}) {
  return render(
    <Controls
      sortId="activity"
      onSort={vi.fn()}
      filters={NO_FILTERS}
      onFilters={vi.fn()}
      grouped
      onGrouped={vi.fn()}
      counts={{ ...counts }}
      hidden={0}
      {...over}
    />,
  );
}

describe('the sessions toolbar', () => {
  it('searches by the three things that tell two sessions apart', () => {
    mount();
    const search = screen.getByRole('searchbox', { name: /name, directory or id/i });
    expect(search).toBeTruthy();
  });

  it('offers a chip per kind that has rows, and none for a kind that has none', () => {
    mount();
    expect(screen.getByRole('button', { name: /Autopilot lanes, 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Shells, 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Other sessions on this machine, 3/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Agent sessions/ })).toBeNull();
  });

  it('does not draw a chip row at all when there is only one kind to choose', () => {
    // One chip and an Everything beside it are the same filter twice.
    mount({ counts: { lane: 0, agent: 0, shell: 4, foreign: 0 } });
    expect(screen.queryByRole('button', { name: /Shells/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Everything' })).toBeNull();
  });

  it('marks the chosen kind pressed, and leaves Everything unpressed while narrowed', () => {
    mount({ filters: { ...NO_FILTERS, kind: 'shell' } });
    expect(screen.getByRole('button', { name: /Shells, 1/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the three orders and marks the chosen one', () => {
    mount({ sortId: 'created' });
    expect(screen.getByRole('button', { name: 'Started' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Kind' })).toBeTruthy();
  });

  it('never cuts the list silently', () => {
    mount({ hidden: 4 });
    expect(screen.getByText(/4 hidden by filters/)).toBeTruthy();
  });

  it('explains the order once the sections that used to explain it are off', () => {
    mount({ grouped: false, sortId: 'created' });
    expect(screen.getByText(/When each session began/)).toBeTruthy();
  });

  it('has no axe violations with every control on screen', async () => {
    // The rendered fragment, not `document`: jsdom's own page has no <title>
    // and no lang, and neither is this component's to fix.
    const { container } = mount({ hidden: 2, filters: { ...NO_FILTERS, kind: 'lane', query: 'repo' } });
    await expectNoAxeViolations(container);
  });
});

describe('the list the toolbar drives', () => {
  const rows: SessionRow[] = sessionRows({
    terminals: [
      {
        id: 's1',
        label: 'Terminal 1',
        cwd: '/repo',
        shell: '/bin/zsh',
        cols: 80,
        rows: 24,
        pid: 1,
        clients: 1,
        createdAt: Date.now() - 60_000,
      },
    ],
    lanes: [
      {
        key: 'run-1#3',
        slug: 'alpha',
        planTitle: 'Alpha',
        runId: 'run-1',
        phase: 3,
        status: 'running',
        runStatus: 'running',
        costUsd: 0,
        attempts: 1,
        frozen: false,
        enriched: false,
      } as never,
    ],
  });

  it('groups by kind by default — the shape the page has always had', () => {
    render(<SessionList rows={rows} />);
    expect(screen.getByRole('region', { name: 'Shells' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Autopilot lanes' })).toBeTruthy();
  });

  it('drops the sections when ungrouped, and moves the kind word onto the row', () => {
    render(<SessionList rows={rows} grouped={false} />);
    expect(screen.queryByRole('region', { name: 'Shells' })).toBeNull();
    const list = screen.getByRole('list', { name: 'Sessions' });
    // The heading is gone, so the icon carries the kind — for a pointer as a
    // hover and for a reader as a name.
    expect(within(list).getByRole('img', { name: 'Shells' })).toBeTruthy();
    expect(within(list).getByRole('img', { name: 'Autopilot lanes' })).toBeTruthy();
  });
});
