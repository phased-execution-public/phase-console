import type { ComponentPropsWithRef, HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tables — the primitives.
 *
 * This file is the markup and the two sticky class lists. The arithmetic that
 * decides what a table shows — the column cut, the tracks, the pinned rail,
 * `useTableFit` — and `DataTable` itself live in `components/data-table/`
 * since control-tower phase 18, out of the preloaded `@/components/ui` barrel.
 * The contract below is still ONE decision across the two places: this file's
 * wrapper and sticky rules, and `useTableFit`'s answer that drives them.
 *
 * ## The wrapper, and why it is conditional
 *
 * A table wide enough to need scrolling scrolls *inside its own box*, so the
 * page body never does. A phone that scrolls sideways as a whole loses the tab
 * bar off the edge and never gets it back — that is the single most common way
 * a responsive layout breaks here.
 *
 * But being a scroll container has a cost that went unpaid for three releases:
 * `position: sticky` binds to the nearest scrolling ancestor, so a header
 * inside an always-scrolling wrapper can only stick to a box that never scrolls
 * vertically. That is why `THead` was not sticky — the mechanism could not
 * work, not because a pinned header was unwanted. Measured on the 34-row run
 * phase table, the columns simply left the screen and did not come back.
 *
 * So the wrapper scrolls **only when it has to**. `useTableFit`
 * (`components/data-table/layout.ts`) measures the table against its box and
 * answers one of two modes:
 *
 *   - `fits`      — no scroll container at all, and `stickyHeadCell` on the
 *                   header cells binds to `<main>`, the shell's one scroller.
 *   - `overflows` — `overflow-x: auto` exactly as before, and the identity
 *                   column pins left instead (`stickyIdentityCell`), which
 *                   sticky CAN do inside an overflow-x wrapper.
 *
 * `DataTable` (`components/data-table/`) makes `fits` the normal case by
 * folding columns it cannot show rather than letting them fall off the edge
 * silently.
 *
 * Until the box has actually been measured neither answer is known, and the
 * honest one is `overflows`: a table rendered at every column inside a wrapper
 * that does not scroll is the one arrangement that can hide a column with no
 * way to reach it. `useTableFit` says so with `measured`.
 *
 * Never give the wrapper a max-height. `overflow-x` makes computed `overflow-y`
 * auto, so a height-capped wrapper becomes a second vertical scroller that
 * captures touch flicks meant for the page. Height always fits content here.
 *
 * ## Never cover a row with an overlay
 *
 * A row-covering `after:absolute after:inset-0` link leaves every other control
 * in the row dead to the pointer while it stays in the tab order. The ban, the
 * three tables that paid for it and the supported way (`rowHref`) are written
 * out in `components/data-table/data-table.tsx`, beside the code that obeys it.
 */

/** Cell padding rides the density tokens, so `data-density` reaches tables. */
const CELL_PAD = 'px-(--tile-pad-x) py-(--tile-pad-y)';

/**
 * A header cell pinned to the shell's scroller.
 *
 * Sticky goes on the `<th>`, never on `<thead>`: a table section is not a
 * containing block in every engine, and a sectionful of sticky is one layer
 * where this is one per cell. `--z-base` exists for exactly this
 * (`theme.css`, "reserved for sticky table headers").
 *
 * Only ever applied on the `fits` branch — see the note above. A sticky header
 * inside an overflow-x wrapper is still the thing that does not work.
 *
 * Two things make it read as a header once rows slide underneath it. It is
 * painted on `--ground` — the page's own colour, so the header is the RECESSED
 * band and a hovered row (`--surface-raised`) is the raised one; they were both
 * `--surface-raised` before, which meant the row under the pointer merged into
 * the header and the table appeared to have two header rows. And it carries its
 * own bottom rule as an inset shadow: `border-collapse` gives the `<thead>`
 * border to whichever adjacent cell wins the collapse, so a border there is not
 * a rule that can be relied on to be drawn.
 */
export const stickyHeadCell = 'sticky top-0 z-(--z-base) bg-ground shadow-[inset_0_-1px_0_0_var(--rule)]';

/**
 * The identity column, pinned left while the rest of the row scrolls past.
 *
 * It has to be OPAQUE — it is the one cell scrolled content passes beneath —
 * and it has to keep the row's own tint, including the hover one, or the pinned
 * cell announces a different row than the row it belongs to. `bg-inherit` alone
 * gave only the second: a run's live row is `bg-running/8`, so the pinned cell
 * was 92 % see-through and phase numbers were read through the Status column
 * sliding past them.
 *
 * So the cell paints both, in order, inside its own stacking context (`isolate`
 * — a negative-z child paints above the box's background and below its content,
 * and the whole group travels with the sticky cell, above the scrolled cells):
 *
 *   `::before`  the opaque base, `--surface`
 *   `::after`   the row's tint again — `bg-inherit` on a pseudo takes its
 *               ORIGINATING element's background, which is the row's
 *   content     the phase number, unclouded
 */
export const stickyIdentityCell = [
  'sticky start-0 isolate bg-inherit',
  'before:pointer-events-none before:absolute before:inset-0 before:-z-20 before:bg-surface before:content-[""]',
  'after:pointer-events-none after:absolute after:inset-0 after:-z-10 after:bg-inherit after:content-[""]',
].join(' ');

export function TableWrap({
  className,
  scrolls = true,
  ...props
}: ComponentPropsWithRef<'div'> & {
  /**
   * Whether this wrapper is a horizontal scroll container.
   *
   * `false` is what lets a sticky header reach `<main>`. Only pass it when the
   * table is known to fit — `useTableFit` is how that is known, and `measured`
   * is part of knowing.
   *
   * The default is the safe answer, because the alternative is not a table that
   * merely looks wrong. `<main>` carries `overflow-x-hidden` (`app/shell/
   * layout.tsx`) precisely so an over-wide table cannot scroll the page
   * sideways — which means an over-wide table in a wrapper that does not scroll
   * is CLIPPED, with no scrollbar anywhere to reach the clipped columns. The
   * two files are one decision: neither may be changed alone.
   */
  scrolls?: boolean;
}) {
  return (
    <div
      data-scrolls={scrolls ? '' : undefined}
      className={cn(
        'w-full max-w-full rounded-lg border border-rule',
        scrolls && 'overflow-x-auto overscroll-x-contain',
        className,
      )}
      {...props}
    />
  );
}

export function Table({
  className,
  fixed = false,
  ...props
}: ComponentPropsWithRef<'table'> & {
  /**
   * Lay out on the declared column widths instead of on the content.
   *
   * Auto layout sizes a column to its WIDEST cell across every row, which is
   * how the run phase table ended up giving Status five hundred pixels — one
   * queued phase carried a chip naming the plan it waits behind, and every
   * other row paid for it while Phase wrapped four-line titles in a hundred.
   * A table that has declared what its columns are worth should be laid out
   * on that, and cells that no longer fit should say so themselves.
   */
  fixed?: boolean;
}) {
  return (
    <table className={cn('w-full border-collapse text-sm', fixed && 'table-fixed', className)} {...props} />
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      /*
       * `[&_button]:uppercase` is not cosmetic. Tailwind's preflight resets
       * `text-transform: none` on `button`, so a header rendered as a sort
       * button silently opted out of the casing every other header has —
       * measured on the Plans table, the five sortable columns read "Plan ·
       * Done · Ready · Health · Activity" beside "TRACK · LEFT · REPOS · RUN".
       * The header row was announcing sortability in letterforms by accident.
       * Sort state is the arrow's job, and only the arrow's.
       *
       * `bg-ground`, not `bg-surface-raised`, and it must stay that way: the
       * row hover IS `bg-surface-raised`, so a header painted in it merged with
       * whichever row the pointer was on. The header is the recessed band and
       * the row under the pointer is the raised one — the same two tokens, the
       * other way round. `stickyHeadCell` repeats it per cell, because a cell
       * background paints over a section one under `border-collapse`.
       */
      className={cn(
        'bg-ground text-start text-2xs uppercase tracking-wide text-ink-muted [&_button]:uppercase',
        className,
      )}
      {...props}
    />
  );
}

/*
 * `TBody` and `TR` take a `ref` where the rest of the family does not, because
 * a windowed table has to address them: the virtualizer measures each row it
 * renders and needs the body's own position to know where the window sits
 * (`features/plans/route-tab.tsx`). In React 19 `ref` is an ordinary prop, so
 * this is a wider type and no `forwardRef`.
 */
export function TBody({ className, ...props }: ComponentPropsWithRef<'tbody'>) {
  return <tbody className={cn('divide-y divide-rule', className)} {...props} />;
}

export function TR({ className, ...props }: ComponentPropsWithRef<'tr'>) {
  return <tr className={cn('bg-surface hover:bg-surface-raised', className)} {...props} />;
}

export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn('whitespace-nowrap font-medium', CELL_PAD, className)} {...props} />;
}

export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  /*
   * `min-w-0` and `break-words` are the other half of a declared column width.
   * Under `table-fixed` the column is exactly as wide as it said it would be,
   * so a cell whose content refuses to wrap does not widen its column — it
   * escapes it, and the table is over the edge again with no scrollbar to say
   * so. Measured: one recovery-button row wanted 193px of a 120px column.
   */
  return <td className={cn('min-w-0 align-middle break-words', CELL_PAD, className)} {...props} />;
}
