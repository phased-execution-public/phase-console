/**
 * The toolbar grammar (design.md §1, principle 8; quiet-console phase 6, exit
 * criterion 3): search · filter · group · sort · view · ⋯ · Everything, in that
 * order, on a desk — and below 900 the search and ONE View button, whose sheet
 * holds the other six in the same order and the same words.
 *
 * The phone is `@/lib/media` answering differently, so the module is mocked
 * with a switch the cases flip.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { TOOLBAR_SLOTS, Toolbar, type ToolbarProps } from './toolbar';

const media = vi.hoisted(() => ({ phone: false }));
vi.mock('@/lib/media', () => ({
  usePhone: () => media.phone,
  useNarrow: () => media.phone,
  useTouch: () => media.phone,
  isPhone: () => media.phone,
}));

afterEach(() => {
  media.phone = false;
});

const slot = (word: string, extra: Partial<ToolbarProps['filter']> = {}) => ({
  panel: <p>{`The ${word.toLowerCase()} panel`}</p>,
  ...extra,
});

function everySlot(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    label: 'Runs',
    search: {
      value: '',
      onChange: () => {},
      placeholder: 'Search by plan',
      label: 'Search the runs by plan',
    },
    filter: slot('Filter', { active: 2 }),
    group: slot('Group', { value: 'State', active: 1 }),
    sort: slot('Sort', { value: 'Updated' }),
    view: slot('View', { label: 'Columns' }),
    more: [
      { id: 'export', label: 'Export the runs', onSelect: () => {} },
      { id: 'purge', label: 'Forget settled runs', onSelect: () => {}, disabled: 'Needs --allow-writes' },
    ],
    everything: { on: false, toggle: () => {} },
    ...over,
  };
}

const slotsIn = (root: ParentNode) =>
  [...root.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot'));

async function closeLayer(name: string) {
  const layer = screen.getByRole(name === 'menu' ? 'menu' : 'dialog');
  fireEvent.keyDown(layer, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole(name === 'menu' ? 'menu' : 'dialog')).toBeNull());
}

describe('on a desk', () => {
  it('draws the seven slots in the grammar’s order', () => {
    const { container } = render(<Toolbar {...everySlot()} />);
    expect(slotsIn(container)).toEqual([...TOOLBAR_SLOTS]);
    expect(TOOLBAR_SLOTS).toEqual(['search', 'filter', 'group', 'sort', 'view', 'more', 'everything']);
  });

  it('keeps the order whatever the page leaves out', () => {
    const { container } = render(<Toolbar {...everySlot({ filter: undefined, more: undefined })} />);
    expect(slotsIn(container)).toEqual(['search', 'group', 'sort', 'view', 'everything']);
  });

  it('names each slot in words — what is chosen, how many settings are in force', () => {
    render(<Toolbar {...everySlot()} />);
    expect(screen.getByRole('button', { name: 'Filter, 2 in use' })).toBeInTheDocument();
    // A chosen value says it all: no count repeats that one grouping is on.
    expect(screen.getByRole('button', { name: 'Group, State' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sort, Updated' })).toBeInTheDocument();
    // The page's own word for its view.
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
  });

  it('opens a slot’s panel under its button', async () => {
    render(<Toolbar {...everySlot()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Group/ }));
    const panel = await screen.findByRole('dialog', { name: 'Group' });
    expect(within(panel).getByText('The group panel')).toBeInTheDocument();
    await closeLayer('dialog');
  });

  it('draws a short slot straight on the bar when the page asks', () => {
    render(<Toolbar {...everySlot({ sort: { panel: <p>Orders</p>, inline: <span>Newest first</span> } })} />);
    expect(screen.getByText('Newest first')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
  });

  it('puts the page’s verbs behind ⋯, and says why one cannot be pressed', async () => {
    const onSelect = vi.fn();
    render(
      <Toolbar
        {...everySlot({
          more: [{ id: 'export', label: 'Export the runs', onSelect }, ...everySlot().more!.slice(1)],
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    const purge = within(menu).getByRole('menuitem', { name: /Forget settled runs/ });
    expect(purge).toHaveAttribute('data-disabled');
    expect(purge).toHaveTextContent('Needs --allow-writes');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export the runs' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('clears its search with one press', () => {
    const onChange = vi.fn();
    render(
      <Toolbar
        {...everySlot({
          search: { value: 'quiet', onChange, placeholder: 'Search', label: 'Search the runs' },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows the note under the bar', () => {
    render(<Toolbar {...everySlot({ note: <span>4 of 12 shown</span> })} />);
    expect(screen.getByText('4 of 12 shown')).toBeInTheDocument();
  });

  it('has no axe violation', async () => {
    const { container } = render(<Toolbar {...everySlot({ note: <span>4 of 12 shown</span> })} />);
    await expectNoAxeViolations(container);
  });
});

describe('below 900', () => {
  it('collapses into the search and ONE View button that counts what is in force', () => {
    media.phone = true;
    const { container } = render(<Toolbar {...everySlot({ everything: { on: true, toggle: () => {} } })} />);
    expect(slotsIn(container)).toEqual(['search', 'view-sheet']);
    // Filter 2, group 1, and Everything on.
    expect(screen.getByRole('button', { name: 'View, 4 in use' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Filter/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('holds the other six in one sheet, in the grammar’s order and words', async () => {
    media.phone = true;
    render(<Toolbar {...everySlot()} />);
    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    expect(sheet).toHaveAccessibleDescription('Runs: what to show, and how.');
    expect(slotsIn(sheet)).toEqual(['filter', 'group', 'sort', 'view', 'more', 'everything']);
    expect(
      within(sheet)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['View', 'Filter', 'Group', 'Sort', 'Columns', 'More actions']);
    expect(within(sheet).getByText('The filter panel')).toBeInTheDocument();
    expect(within(sheet).getByRole('switch', { name: 'Everything' })).toHaveAccessibleDescription(
      'Every column, fact and section, not only the essentials.',
    );
    expect(within(sheet).getByText('Needs --allow-writes')).toBeInTheDocument();
    await expectNoAxeViolations(sheet);
    await closeLayer('dialog');
  });

  it('closes the sheet before a verb runs, so what it opens is not covered', async () => {
    media.phone = true;
    const onSelect = vi.fn();
    render(<Toolbar {...everySlot({ more: [{ id: 'export', label: 'Export the runs', onSelect }] })} />);
    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    const sheet = await screen.findByRole('dialog', { name: 'View' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Export the runs' }));
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('draws no View button when there is nothing to fold', () => {
    media.phone = true;
    const { container } = render(<Toolbar label="Runs" search={everySlot().search!} />);
    expect(slotsIn(container)).toEqual(['search']);
  });
});
