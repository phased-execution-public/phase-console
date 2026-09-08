/**
 * Button, Card, Tabs, Table, Accordion — the structural surfaces. What
 * these tests hold: a Button defaults to `type="button"` (a form cannot
 * submit by accident) and `asChild` lends the classes to a real link; amber
 * (`action`) is a variant a caller must ask for; a Tile is a number made a
 * fact by its label, painted by a state token; Tabs are Radix's — real
 * `tablist`/`tab` roles with arrow-key roving focus; a Table scrolls inside
 * its own wrapper (the page body must never scroll sideways) and a sticky
 * header is paired with a wrapper that does NOT scroll — both directions,
 * because sticky inside an overflow-x box can only bind to a box that never
 * scrolls vertically; a `rowHref` row is a REAL link plus a row click that
 * stands down over the controls in other cells, never an overlay painted
 * across them; and an Accordion's whole header row is the trigger with
 * `aria-expanded` telling the truth.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouterProvider } from '@/app/router';
import { expectNoAxeViolations } from '@/test/axe';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion';
import { Button, ButtonGroup } from './button';
import { Card, CardBody, CardHeader, CardTitle, Tile } from './card';
import { DataTable, Table, TableWrap, TBody, TD, TH, THead, TR, stickyHeadCell, type Column } from './table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { ToggleGroup, ToggleItem } from './toggle-group';

describe('Button', () => {
  it('defaults to type="button" — never an accidental submit', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('variant="action" is the amber one', () => {
    render(<Button variant="action">Start phase</Button>);
    expect(screen.getByRole('button')).toHaveClass('text-action');
    const { container } = render(<Button>Plain</Button>);
    expect(container.querySelector('button')).not.toHaveClass('text-action');
  });

  it('asChild lends the classes to a real element', () => {
    render(
      <Button asChild variant="ghost">
        <a href="/runs">All runs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'All runs' });
    expect(link.tagName).toBe('A');
    expect(link.className).toContain('inline-flex');
    expect(link).not.toHaveAttribute('type');
  });

  it('ButtonGroup is a group', () => {
    render(
      <ButtonGroup aria-label="Density">
        <Button aria-pressed="true">Cozy</Button>
        <Button aria-pressed="false">Compact</Button>
      </ButtonGroup>,
    );
    expect(screen.getByRole('group', { name: 'Density' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ButtonGroup aria-label="Density">
        <Button aria-pressed="true">Cozy</Button>
        <Button aria-pressed="false">Compact</Button>
      </ButtonGroup>,
    );
    await expectNoAxeViolations(container);
  });
});

/**
 * A floor is a claim about the ANCESTORS too.
 *
 * The defect this holds shut, measured: `Button` declares
 * `[@media(hover:none)]:min-w-(--tap-min)`, so at 360 under a coarse pointer
 * Insights' `Cost` and `Phase` sort buttons are 44px each. Their `ButtonGroup`
 * was `inline-flex overflow-hidden` and shrinkable, and `theme.css`'s base
 * `* { min-width: 0 }` means shrinkable goes to nothing — inside a non-wrapping
 * `CardHeader` it shrank to **50px** around **88px** of children and hid the
 * second one: 5px of its 44px box drawn, its centre answering `<main>`. Worse
 * than the same control with no floor at all.
 *
 * Every probe said it passed, because a probe that asks "is the control in the
 * stack" is answered by the ANCESTOR that clipped it. So the pin is structural
 * rather than measured (jsdom computes no styles): the two segmented primitives
 * are asserted, on the element the app actually mounts, to hold no clip and to
 * refuse to shrink, and `CardHeader` — the container that did the squeezing —
 * is asserted to wrap. `styles/touch.test.ts` sweeps the rest of the tree for
 * the same shape.
 */
describe('a clipping box may not squash what it clips', () => {
  const CLIP = /\b(?:overflow-hidden|overflow-clip|overflow-x-hidden|truncate)\b/;

  it('ButtonGroup holds no clip and cannot shrink around its segments', () => {
    render(
      <ButtonGroup aria-label="Sort">
        <Button aria-pressed="true">Cost</Button>
        <Button aria-pressed="false">Phase</Button>
      </ButtonGroup>,
    );
    const group = screen.getByRole('group', { name: 'Sort' });
    expect(group.className, 'a clip here hides a segment instead of squeezing it').not.toMatch(CLIP);
    expect(group.className, 'a segmented control keeps the width its segments declare').toContain('shrink-0');
    // The radius the clip used to produce, now on the segments themselves.
    expect(group.className).toMatch(/\[&>button:first-child\]:rounded-l/);
    expect(group.className).toMatch(/\[&>button:last-child\]:rounded-r/);
  });

  it('ToggleGroup — the same primitive with Radix roving focus — says the same', () => {
    render(
      <ToggleGroup type="single" value="cards" aria-label="Layout">
        <ToggleItem value="cards">Cards</ToggleItem>
        <ToggleItem value="table">Table</ToggleItem>
      </ToggleGroup>,
    );
    // `type="single"` is a radiogroup, not a group — Radix's own semantics.
    const group = screen.getByRole('radiogroup', { name: 'Layout' });
    expect(group.className).not.toMatch(CLIP);
    expect(group.className).toContain('shrink-0');
    const [first] = screen.getAllByRole('radio');
    expect(first?.className).toMatch(/first:rounded-l/);
  });

  it('CardHeader wraps — a header that cannot fit on one line takes two', () => {
    const { container } = render(
      <CardHeader>
        <CardTitle>Per phase</CardTitle>
        <ButtonGroup aria-label="Sort">
          <Button>Cost</Button>
          <Button>Phase</Button>
        </ButtonGroup>
      </CardHeader>,
    );
    const header = container.firstElementChild as HTMLElement;
    expect(header.className, 'without a wrap the only give in the row is to squash a control').toContain(
      'flex-wrap',
    );
  });
});

describe('Card + Tile', () => {
  it('a card is its header, title and body', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Session budget</CardTitle>
        </CardHeader>
        <CardBody>
          <p>310K of 400K</p>
        </CardBody>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Session budget' })).toBeInTheDocument();
    expect(screen.getByText('310K of 400K')).toBeInTheDocument();
  });

  it('a Tile is a number made a fact by its label, painted by its state', () => {
    render(<Tile label="ready" value={3} state="state-queued" hint="next up" />);
    expect(screen.getByText('3')).toHaveClass('text-state');
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('next up')).toBeInTheDocument();
    expect(screen.getByText('3').parentElement).toHaveClass('state-queued');
  });

  it('an unpainted Tile stays ink', () => {
    render(<Tile label="phases" value={11} />);
    expect(screen.getByText('11')).toHaveClass('text-ink');
    expect(screen.getByText('11')).not.toHaveClass('text-state');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
        </CardHeader>
        <CardBody>
          <Tile label="done" value={6} state="state-done" />
        </CardBody>
      </Card>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Tabs', () => {
  const mount = () =>
    render(
      <Tabs defaultValue="board">
        <TabsList aria-label="Plan views">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="map">Map</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
        </TabsList>
        <TabsContent value="board">
          <p>the board</p>
        </TabsContent>
        <TabsContent value="map">
          <p>the map</p>
        </TabsContent>
        <TabsContent value="journal">
          <p>the journal</p>
        </TabsContent>
      </Tabs>,
    );

  it('renders a real tablist with tabs and shows the active panel', () => {
    mount();
    expect(screen.getByRole('tablist', { name: 'Plan views' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('the board')).toBeInTheDocument();
    expect(screen.queryByText('the map')).toBeNull();
  });

  it('arrow keys move focus along the tabs (roving tabindex)', async () => {
    mount();
    const board = screen.getByRole('tab', { name: 'Board' });
    act(() => board.focus());
    fireEvent.keyDown(board, { key: 'ArrowRight' });
    // Radix moves the roving focus on a timeout tick; flush it inside act.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('tab', { name: 'Map' })).toHaveFocus();
  });

  it('picking a tab switches the panel (Radix activates on mousedown)', () => {
    mount();
    const journal = screen.getByRole('tab', { name: 'Journal' });
    fireEvent.mouseDown(journal, { button: 0, ctrlKey: false });
    fireEvent.click(journal);
    expect(screen.getByText('the journal')).toBeInTheDocument();
    expect(screen.queryByText('the board')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

describe('Table', () => {
  const mount = () =>
    render(
      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Phase</TH>
              <TH>State</TH>
            </TR>
          </THead>
          <TBody>
            <TR>
              <TD>01</TD>
              <TD>done</TD>
            </TR>
            <TR>
              <TD>02</TD>
              <TD>ready</TD>
            </TR>
          </TBody>
        </Table>
      </TableWrap>,
    );

  it('the wrapper owns the sideways scroll, so the page never does', () => {
    const { container } = mount();
    expect(container.firstElementChild).toHaveClass('overflow-x-auto');
  });

  /*
   * This used to read `expect(thead.className).not.toMatch(/sticky/)` under the
   * title "the header is not sticky". It could never fail and never could have:
   * the class it looked for lives on the `<th>` (a table SECTION is not a
   * containing block in every engine), so it asserted the absence of a class
   * from an element that was never going to carry one — while the title claimed
   * a design decision that had already been reversed. The decision is the
   * PAIRING, so both halves are asserted here, in both directions.
   */
  const headerRow = (sticky: boolean, scrolls: boolean) =>
    render(
      <TableWrap scrolls={scrolls}>
        <Table>
          <THead>
            <TR>
              <TH className={sticky ? stickyHeadCell : undefined}>Phase</TH>
            </TR>
          </THead>
        </Table>
      </TableWrap>,
    );

  it('a sticky header goes only in a wrapper that does not scroll', () => {
    const { container } = headerRow(true, false);
    expect(container.firstElementChild).not.toHaveClass('overflow-x-auto');
    expect(screen.getByRole('columnheader', { name: 'Phase' }).className).toMatch(/sticky top-0/);
  });

  it('a wrapper that scrolls has no sticky header — there is nothing for it to bind to', () => {
    const { container } = headerRow(false, true);
    expect(container.firstElementChild).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('columnheader', { name: 'Phase' }).className).not.toMatch(/sticky/);
  });

  it('DataTable keeps the pair coupled while the box is still unmeasured', () => {
    // jsdom reports every width as 0, which is exactly the state before the
    // first measurement in a browser: not "it fits" but "not known yet". The
    // honest arrangement is the scrolling one, and a sticky header may not ride
    // along with it.
    const { container } = render(
      <DataTable
        label="Phases"
        columns={[{ id: 'phase', head: 'Phase', identity: true, priority: 1, cell: () => '01' }]}
        rows={[{ id: 'a' }]}
        getRowKey={(row) => row.id}
      />,
    );
    expect(container.querySelector('[data-scrolls]')).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Phase' }).className).not.toMatch(/sticky/);
  });

  it('column headers carry scope', () => {
    mount();
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col');
  });

  it('has no axe violations', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
  });
});

/*
 * The row that is a link.
 *
 * Three tables reached this by painting `after:absolute after:inset-0` over the
 * whole row from the identity cell. It made the row clickable and everything IN
 * the row unclickable — a sheet above every cell that is not itself positioned,
 * so a Retry button was dead to the pointer while staying in the tab order.
 * What these hold: the identity cell is a real anchor with the real href, a
 * click on the row navigates, a click on a control inside the row does not, and
 * nothing anywhere is an absolutely positioned overlay.
 */
describe('DataTable rowHref', () => {
  interface Job {
    id: string;
    phase: string;
  }
  const columns: Column<Job>[] = [
    { id: 'phase', head: 'Phase', identity: true, priority: 1, cell: (row) => row.phase },
    { id: 'act', head: 'Act', priority: 1, cell: () => <Button>Retry</Button> },
  ];
  const mount = (onNavigate: (path: string) => void) =>
    render(
      <MemoryRouterProvider initial="#/plans" onNavigate={onNavigate}>
        <DataTable
          label="Handoffs"
          columns={columns}
          rows={[{ id: '2', phase: '02' }]}
          getRowKey={(row) => row.id}
          rowHref={(row) => `#/plan/alpha/handoff/${row.id}`}
        />
      </MemoryRouterProvider>,
    );

  it('the identity cell holds the href, so the keyboard and the middle button work', () => {
    mount(() => {});
    expect(screen.getByRole('link', { name: '02' })).toHaveAttribute('href', '#/plan/alpha/handoff/2');
  });

  it('a click on the row goes there', () => {
    const onNavigate = vi.fn();
    mount(onNavigate);
    fireEvent.click(screen.getByRole('link', { name: '02' }).closest('tr') as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('#/plan/alpha/handoff/2');
  });

  it('a click on a control inside the row does not — the row stands down over it', () => {
    const onNavigate = vi.fn();
    mount(onNavigate);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('covers no cell with an overlay', () => {
    const { container } = mount(() => {});
    for (const node of container.querySelectorAll('td *')) {
      expect(node.className.toString()).not.toMatch(/after:absolute|after:inset-0/);
    }
  });

  it('has no axe violations', async () => {
    const { container } = mount(() => {});
    await expectNoAxeViolations(container);
  });
});

describe('DataTable empty', () => {
  it('says so inside the table, under the columns that are still named', () => {
    render(
      <DataTable
        label="Handoffs"
        columns={[{ id: 'phase', head: 'Phase', identity: true, priority: 1, cell: () => null }]}
        rows={[]}
        getRowKey={() => 'none'}
        empty="No handoff has been written yet."
      />,
    );
    // The frame stays: a table that swaps itself for a paragraph changes the
    // page's shape between "nothing yet" and "one row".
    expect(screen.getByRole('columnheader', { name: 'Phase' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'No handoff has been written yet.' })).toBeInTheDocument();
  });
});

describe('Accordion', () => {
  const mount = () =>
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="how">
          <AccordionTrigger>How was it tried?</AccordionTrigger>
          <AccordionContent>Twice, by the ladder.</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );

  it('the trigger opens its content and aria-expanded flips', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'How was it tried?' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Twice, by the ladder.')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Twice, by the ladder.')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('the chevron is decoration on the trigger, not a second control', () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'How was it tried?' });
    expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('has no axe violations, closed and open', async () => {
    const { container } = mount();
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: 'How was it tried?' }));
    await expectNoAxeViolations(container);
  });
});
