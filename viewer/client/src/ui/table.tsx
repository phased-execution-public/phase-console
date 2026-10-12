import type { ComponentPropsWithRef, HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tables — the primitives. A table takes the width (design.md §1); its cells
 * pad on the density tokens; its header is a sentence-case row in muted ink,
 * never capitals. The grid that decides what a table shows (the column cut,
 * the fold, the pinned rail) is `ui/grid/`, built on these.
 *
 * ## The wrapper, and why it is conditional
 *
 * A table wide enough to need scrolling scrolls INSIDE ITS OWN BOX, so the
 * page body never does — a phone that scrolls sideways as a whole loses the
 * tab bar off the edge. But a scroll container binds `position: sticky` to
 * itself, so a header inside an always-scrolling wrapper can never stick to
 * `<main>`. So the wrapper scrolls only when it has to: `scrolls={false}` is
 * what lets a sticky header reach the shell's one scroller, and it is passed
 * only once the table is MEASURED to fit. The default is the safe answer,
 * because `<main>` clips sideways overflow and an over-wide table in a wrapper
 * that does not scroll is clipped with no scrollbar to reach the cut columns.
 *
 * Never give the wrapper a max-height: `overflow-x` makes computed
 * `overflow-y` auto, and a height-capped wrapper becomes a second vertical
 * scroller that eats the page's touch flick.
 */

/** Cell padding rides the density tokens, so `data-density` reaches tables. */
const CELL_PAD = 'px-(--tile-pad-x) py-(--tile-pad-y)';

/**
 * A header cell pinned to the shell's scroller (the `fits` branch only).
 * Sticky goes on the `<th>`, never on `<thead>`; it is painted on `--ground`,
 * the page's own colour, so a hovered row (`--surface-raised`) stays the
 * raised one; and it carries its own bottom rule as an inset shadow, because
 * `border-collapse` gives a `<thead>` border to whichever cell wins.
 */
export const stickyHeadCell = 'sticky top-0 z-(--z-base) bg-ground shadow-[inset_0_-1px_0_0_var(--rule)]';

/**
 * The identity column, pinned at the start while the rest of the row scrolls
 * past. Opaque (`::before`, the surface) under the row's own tint again
 * (`::after`, `bg-inherit`), inside its own stacking context, so the pinned
 * cell announces the row it belongs to and nothing shows through it.
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
  /** Whether this wrapper is a horizontal scroll container — see the file header. */
  scrolls?: boolean;
}) {
  return (
    <div
      data-scrolls={scrolls ? '' : undefined}
      className={cn('w-full max-w-full', scrolls && 'overflow-x-auto overscroll-x-contain', className)}
      {...props}
    />
  );
}

export function Table({
  className,
  fixed = false,
  ...props
}: ComponentPropsWithRef<'table'> & {
  /** Lay out on the declared column widths instead of on the content. */
  fixed?: boolean;
}) {
  // hand-rolled because: this IS the primitive — the markup the grid (`ui/grid/`) and every
  // explained table build on; it renders nothing of its own.
  return (
    <table className={cn('w-full border-collapse text-body', fixed && 'table-fixed', className)} {...props} />
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  // `[&_button]:normal-case` is not cosmetic: a header rendered as a sort
  // button must read exactly like the headers beside it. Sort state is the
  // arrow's job, and only the arrow's.
  return (
    <thead
      className={cn(
        'bg-ground text-start text-meta font-medium text-ink-muted [&_button]:normal-case',
        className,
      )}
      {...props}
    />
  );
}

/*
 * `TBody` and `TR` take a `ref` where the rest of the family does not, because
 * a windowed table has to address them: the virtualizer measures each row it
 * renders and needs the body's own position to know where the window sits.
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
  // `min-w-0` and `break-words` are the other half of a declared column width:
  // under `table-fixed` a cell whose content refuses to wrap escapes its
  // column rather than widening it.
  return <td className={cn('min-w-0 break-words align-middle', CELL_PAD, className)} {...props} />;
}
