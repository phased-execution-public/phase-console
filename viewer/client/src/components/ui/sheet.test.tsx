/**
 * The sheet's scrolling contract.
 *
 * The incident: the bell drawer could not be scrolled. `SheetContent` was
 * itself the scroller and dropped its children into a plain `<div>` of auto
 * height, so a panel inside asking for `h-full` resolved against no definite
 * height, grew past the viewport, and its own `overflow-y-auto` had nothing
 * left to scroll — while the outer scroller had been told the content fitted.
 * Two scrollers, neither working.
 *
 * What these hold: the sheet is a flex column that scrolls NOTHING, exactly one
 * box inside it scrolls, that box is the flex remainder (`min-h-0 flex-1`,
 * without which a flex item's minimum is its content and the sheet grows
 * instead), `bodyClassName` is what reaches that box's padding while `className`
 * still lands on the sheet, and both sides stay sized by `--app-height`.
 *
 * jsdom computes no styles, so these are assertions about the classes that
 * ship — the same shape `styles/touch.test.ts` uses for every other layout
 * promise in this client.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sheet, SheetContent } from './sheet';

const open = (props: Partial<Parameters<typeof SheetContent>[0]> = {}) =>
  render(
    <Sheet defaultOpen>
      <SheetContent title="Inbox" side="right" {...props}>
        <div className="overflow-y-auto">a panel that used to fight the sheet</div>
      </SheetContent>
    </Sheet>,
  );

const bodyOf = (dialog: HTMLElement) => dialog.lastElementChild as HTMLElement;

describe('SheetContent scrolls in exactly one place', () => {
  it('the sheet itself scrolls nothing', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Inbox' });
    expect(dialog.className).toContain('flex flex-col');
    expect(dialog.className).not.toContain('overflow-y-auto');
  });

  it('the body is the scroller, and it is the flex remainder', async () => {
    open();
    const body = bodyOf(await screen.findByRole('dialog', { name: 'Inbox' }));
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
    // Without `min-h-0` a flex item's minimum size is its content: the body
    // would grow the sheet past the viewport instead of overflowing inside it.
    expect(body.className).toContain('min-h-0');
    expect(body.className).toContain('flex-1');
  });

  it('the header does not shrink, so the body is what gives way', async () => {
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Inbox' });
    expect((dialog.firstElementChild as HTMLElement).className).toContain('shrink-0');
  });

  it('a bottom sheet keeps its handle as a header rather than a sticky layer', async () => {
    render(
      <Sheet defaultOpen>
        <SheetContent title="More" side="bottom">
          <p>tray</p>
        </SheetContent>
      </Sheet>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'More' });
    const handle = dialog.firstElementChild as HTMLElement;
    expect(handle.className).toContain('shrink-0');
    expect(handle.className).not.toContain('sticky');
    expect(bodyOf(dialog).className).toContain('overflow-y-auto');
  });

  it('an inner scroller still renders — no consumer had to change', async () => {
    open();
    expect(await screen.findByText('a panel that used to fight the sheet')).toBeInTheDocument();
  });
});

describe('which class reaches which box', () => {
  it('bodyClassName is what changes the padding', async () => {
    open({ bodyClassName: 'p-0' });
    const body = bodyOf(await screen.findByRole('dialog', { name: 'Inbox' }));
    expect(body.className).toContain('p-0');
    expect(body.className).not.toMatch(/\bp-4\b/);
  });

  it('className still lands on the sheet, where the width and the edge live', async () => {
    open({ className: 'max-w-2xl' });
    const dialog = await screen.findByRole('dialog', { name: 'Inbox' });
    expect(dialog.className).toContain('max-w-2xl');
    expect(bodyOf(dialog).className).not.toContain('max-w-2xl');
  });

  it('both sides are still sized by the visible viewport, never dvh', async () => {
    const { unmount } = open();
    expect((await screen.findByRole('dialog', { name: 'Inbox' })).className).toContain('--app-height');
    unmount();
    render(
      <Sheet defaultOpen>
        <SheetContent title="More" side="bottom">
          <p>tray</p>
        </SheetContent>
      </Sheet>,
    );
    const bottom = await screen.findByRole('dialog', { name: 'More' });
    expect(bottom.className).toContain('--app-height');
    expect(bottom.className).not.toMatch(/dvh/);
  });
});
