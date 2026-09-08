/**
 * Earlier runs of one plan — the section that had no test at all.
 *
 * What it holds: the run this page is ABOUT is dropped (it is the first entry
 * and is the rest of the page), a plan with only that one run renders nothing
 * rather than an empty card, every column is named, the id is short with the
 * whole one reachable, and money is set in the figures face so a column of it
 * can be compared down.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import type { RunState } from '@/lib/api';
import { RunHistory } from './history';

const run = (over: Partial<RunState>): RunState =>
  ({
    id: 'aaaaaaaabbbbbbbbcccccccc',
    slug: 'demo',
    root: '/repo',
    status: 'finished',
    autonomy: 'keep-going',
    model: 'opus',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T02:00:00Z',
    activePhase: null,
    child: null,
    waitUntil: null,
    halt: null,
    pause: null,
    freeze: null,
    phases: {},
    spentUsd: 4.5,
    ...over,
  }) as unknown as RunState;

const mount = (node: React.ReactElement) => render(<MemoryRouterProvider>{node}</MemoryRouterProvider>);

describe('<RunHistory>', () => {
  it('says nothing when this plan has only ever had the run in front of you', () => {
    const { container } = mount(<RunHistory history={[run({})]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('drops the run the page is about and lists the rest under named columns', () => {
    mount(
      <RunHistory
        history={[
          run({ id: 'current-run', status: 'running' }),
          run({ id: 'olderrunidgoeshere', status: 'halted', spentUsd: 12.5 }),
        ]}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Updated' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Spent' })).toBeInTheDocument();
    // The run this page is about is not listed a second time.
    expect(screen.queryByTitle(/current-run/)).toBeNull();
    expect(screen.getByText('halted')).toBeInTheDocument();
  });

  it('draws a short id and keeps the whole one one press away', () => {
    mount(<RunHistory history={[run({ id: 'current' }), run({ id: 'aaaaaaaabbbbbbbbcccccccc' })]} />);
    const press = screen.getByTitle('aaaaaaaabbbbbbbbcccccccc — press to copy');
    expect(press.tagName).toBe('BUTTON');
    expect(within(press).getByText('aaaaaaaabbbb')).toBeInTheDocument();
  });

  it('sets money in the figures face, like the run page does', () => {
    mount(<RunHistory history={[run({ id: 'current' }), run({ id: 'older', spentUsd: 12.5 })]} />);
    const cell = screen.getByText('$12.50');
    expect(cell.className).toContain('tabular-nums');
    expect(cell.closest('td')?.className).toContain('text-right');
  });

  it('has no axe violations', async () => {
    const { container } = mount(
      <RunHistory history={[run({ id: 'current' }), run({ id: 'older', status: 'halted' })]} />,
    );
    await expectNoAxeViolations(container);
  });
});
