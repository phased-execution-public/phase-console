/**
 * The six primitives the duplication audit turned up — ConfirmButton,
 * PageError, CardSkeleton, SectionHeading, MonoId, ListRow.
 *
 * What these hold, one property per copy the audit found drifting:
 *
 *  - a ConfirmButton's confirm carries the BUTTON's own words, so an action
 *    keeps its name through the whole flow, and pressing the trigger commits
 *    nothing until the dialog is answered;
 *  - PageError prints the server's own words and never invents a reason, and
 *    offers a way out — the nine copies it replaces offered none;
 *  - CardSkeleton owns the box and nothing else: the `&& !data` predicate stays
 *    at the call site, so a card that already has an answer never flashes grey;
 *  - a SectionHeading's LEVEL is an outline decision and its SIZE is not, which
 *    is why they are two props on one component;
 *  - MonoId draws the short form and keeps the whole one reachable — the point
 *    of the primitive is that `id.slice(0, 8)` alone loses the rest;
 *  - a ListRow's header row wraps and its title truncates against a shrinkable
 *    parent. Those two are structural and have cost four surfaces (see
 *    `styles/touch.test.ts`), so they are asserted as source text — jsdom lays
 *    nothing out and cannot be asked.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '@/test/axe';
import { ConfirmButton } from './confirm-button';
import { ListRow } from './list-row';
import { MonoId } from './mono-id';
import { SectionHeading } from './section-heading';
import { CardSkeleton, PageError } from './states';

const here = dirname(fileURLToPath(import.meta.url));

describe('ConfirmButton', () => {
  it('commits nothing until the dialog is answered', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton title="Stop this phase?" onConfirm={onConfirm}>
        Stop
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms with the button’s own words — an action keeps its name', () => {
    render(
      <ConfirmButton title="Reopen this plan?" onConfirm={() => {}}>
        Reopen
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getAllByRole('button', { name: 'Reopen' })).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('takes an override for the confirm and for the other outcome', () => {
    render(
      <ConfirmButton
        title="Remove a shipped deny rule?"
        confirmLabel="Remove it"
        cancelLabel="Keep the wall"
        destructive
        onConfirm={() => {}}
      >
        Remove
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByRole('button', { name: 'Remove it' })).toBeTruthy();
    // Naming the other outcome is the whole reason a cancel label is a prop.
    expect(within(dialog).getByRole('button', { name: 'Keep the wall' })).toBeTruthy();
  });

  it('is disabled while busy, and says so where the finger already is', () => {
    render(
      <ConfirmButton title="Restart the console?" onConfirm={() => {}} busy busyLabel="Restarting…">
        Restart the console
      </ConfirmButton>,
    );
    const button = screen.getByRole('button', { name: 'Restarting…' });
    expect(button).toBeDisabled();
  });

  it('renders the dialog’s extra body and has no axe violations', async () => {
    render(
      <ConfirmButton
        title="Shut the console down?"
        description="Every session it holds stops with it."
        onConfirm={() => {}}
        details={<p>2 sessions, 1 run</p>}
      >
        Shut down
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Shut down' }));
    expect(screen.getByText('2 sessions, 1 run')).toBeTruthy();
    await expectNoAxeViolations(screen.getByRole('alertdialog'));
  });
});

describe('PageError', () => {
  it('prints the server’s own words, whatever shape the failure arrived in', () => {
    const { rerender } = render(<PageError error={new Error('the engine exited 2')} />);
    expect(screen.getByText('the engine exited 2')).toBeTruthy();
    rerender(<PageError error="the socket closed" />);
    expect(screen.getByText('the socket closed')).toBeTruthy();
  });

  it('admits it has no reason rather than inventing one', () => {
    render(<PageError error={new Error('')} />);
    expect(screen.getByText(/said nothing/)).toBeTruthy();
  });

  it('offers a way out, and only when there is one', () => {
    const retry = vi.fn();
    const { rerender } = render(<PageError error={new Error('gone')} retry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<PageError error={new Error('gone')} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('is announced, not just drawn', async () => {
    const { container } = render(<PageError error={new Error('the read failed')} retry={() => {}} />);
    expect(screen.getByRole('status')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe('CardSkeleton', () => {
  it('draws the box while loading and the children once it is not', () => {
    const { rerender, container } = render(
      <CardSkeleton loading>
        <p>the card</p>
      </CardSkeleton>,
    );
    expect(screen.queryByText('the card')).toBeNull();
    expect(container.querySelector('.h-64')).toBeTruthy();
    rerender(
      <CardSkeleton loading={false}>
        <p>the card</p>
      </CardSkeleton>,
    );
    expect(screen.getByText('the card')).toBeTruthy();
  });

  it('takes a height from the sizes cards come in', () => {
    const { container } = render(<CardSkeleton loading h="48" />);
    expect(container.querySelector('.h-48')).toBeTruthy();
  });

  it('is hidden from the accessibility tree — a placeholder is not content', () => {
    const { container } = render(<CardSkeleton loading />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden');
  });
});

describe('SectionHeading', () => {
  it('takes its level from the outline and its size from the design', () => {
    render(
      <>
        <SectionHeading>Running now</SectionHeading>
        <SectionHeading as="h3" size="title">
          Where the money goes
        </SectionHeading>
      </>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Running now' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Where the money goes' })).toBeTruthy();
  });

  it('unifies on the one eyebrow spelling', () => {
    render(<SectionHeading>Next up</SectionHeading>);
    const heading = screen.getByRole('heading', { name: 'Next up' });
    expect(heading.className).toContain('text-2xs');
    expect(heading.className).toContain('tracking-[0.14em]');
    expect(heading.className).toContain('uppercase');
    // The majority spelling: an eyebrow is a signpost, not a name.
    expect(heading.className).toContain('font-medium');
    expect(heading.className).not.toContain('font-display');
  });

  it('reads each size at the strength it wants, unless told otherwise', () => {
    render(
      <>
        <SectionHeading>band</SectionHeading>
        <SectionHeading size="title">title</SectionHeading>
        <SectionHeading tone="action">needs you</SectionHeading>
      </>,
    );
    expect(screen.getByRole('heading', { name: 'band' }).className).toContain('text-ink-faint');
    expect(screen.getByRole('heading', { name: 'title' }).className).toContain('text-ink');
    // Amber is rationed the way the button variants are — asked for, never default.
    expect(screen.getByRole('heading', { name: 'needs you' }).className).toContain('text-action');
  });
});

describe('MonoId', () => {
  it('draws the short form and keeps the whole one reachable', () => {
    render(<MonoId id="9f2c1b7ae4d05386" />);
    const code = screen.getByText('9f2c1b7a');
    expect(code).toHaveAttribute('title', '9f2c1b7ae4d05386');
  });

  it('leaves an id shorter than the cut alone', () => {
    render(<MonoId id="abc" />);
    expect(screen.getByText('abc')).toBeTruthy();
  });

  it('is pressable only when asked, and copies the WHOLE id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { rerender } = render(<MonoId id="9f2c1b7ae4d05386" copyable />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('9f2c1b7ae4d05386');
    rerender(<MonoId id="9f2c1b7ae4d05386" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('ListRow', () => {
  const row = (
    <ul>
      <ListRow
        lead={<span data-testid="lead">●</span>}
        title="cart-api"
        href="#/plan/cart-api"
        hint="Cart API endpoints"
        subtitle="phase 4 — the checkout call"
        aside={<span>running</span>}
        facts={<span>3/9 · 33%</span>}
        time="4 minutes ago"
        actions={<button type="button">Stop</button>}
      >
        <div data-testid="extra">a track</div>
      </ListRow>
    </ul>
  );

  it('puts every slot where the four lists it replaces put them', () => {
    render(row);
    const link = screen.getByRole('link', { name: 'cart-api' });
    expect(link).toHaveAttribute('href', '#/plan/cart-api');
    expect(link).toHaveAttribute('title', 'Cart API endpoints');
    expect(screen.getByTestId('lead')).toBeTruthy();
    expect(screen.getByText('phase 4 — the checkout call')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('3/9 · 33%')).toBeTruthy();
    expect(screen.getByText('4 minutes ago')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByTestId('extra')).toBeTruthy();
  });

  it('is a plain span when there is nowhere to go', () => {
    render(
      <ul>
        <ListRow title="cart-api" />
      </ul>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('cart-api')).toBeTruthy();
  });

  it('draws no facts row when it has no facts and no clock', () => {
    const { container } = render(
      <ul>
        <ListRow title="cart-api" subtitle="nothing else" />
      </ul>,
    );
    expect(container.querySelectorAll('.tabular-nums')).toHaveLength(0);
  });

  it('has no axe violations populated', async () => {
    const { container } = render(row);
    await expectNoAxeViolations(container);
  });

  /*
   * Source text, because jsdom computes nothing. The rule, stated once because
   * it has now cost four surfaces: a flex row whose CONTENT can grow — an
   * actions bar that gains a button when a lane goes live, a facts line that
   * gains an ETA phrase — must be allowed to shrink and to wrap. `shrink-0`
   * there makes it PUSH instead, and because the shell's one scroller computes
   * `overflow-x: auto`, the push becomes a horizontal scroll of the whole app.
   */
  it('keeps every growable row shrinkable and wrapping', () => {
    const source = readFileSync(join(here, 'list-row.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const row of [
      'flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1',
      'flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1',
      'flex min-w-0 flex-wrap gap-1.5',
    ]) {
      expect(source, `${row} must survive`).toContain(row);
      expect(source, `${row} must not become shrink-0`).not.toContain(row.replace('min-w-0', 'shrink-0'));
    }
    // The title truncates against a parent that may give way; `truncate` inside
    // one that may not truncates nothing.
    expect(source).toContain('min-w-0 flex-1');
    expect(source).toContain('block min-w-0 truncate');
  });
});
