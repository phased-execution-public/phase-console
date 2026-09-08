import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type KeyValueItem = readonly [label: string, value: ReactNode] | null | undefined | false;

/**
 * Facts as a real `<dl>`.
 *
 * Rows whose value is missing are dropped rather than rendered empty — a fact
 * list padded with em-dashes reads as a form with holes in it, and the reason a
 * row is absent (this plan has no lock, no gate, no QA) is never interesting.
 * Passing `null` for a row is therefore the normal way to say "not applicable".
 *
 * ## One column on a phone, two above it
 *
 * The two-track grid is `minmax(0,auto)` for the label, which means the label
 * column is as wide as the longest LABEL — and on a 360px screen that left the
 * value column about 130px. A home-directory path then broke mid-token three
 * times over, which is not a wrapped path, it is a path nobody can read. Below
 * `sm` the label goes ABOVE its value and the value gets the whole width. Two
 * tracks are a table; one is a list, and a phone wants the list.
 */
export function KeyValue({
  items,
  className,
  clamp = false,
}: {
  items: KeyValueItem[];
  className?: string;
  /**
   * Cap each value at a few lines, with a control to see the rest.
   *
   * Off by default, because almost every fact here is a word, a sha or a date
   * and a disclosure over one line of text is furniture. It is for the lists
   * whose values come from a FILE and can therefore be any length: this plan's
   * §Session budget carries an 1,100-character `Branch:` paragraph, which made
   * the plan header 900px tall at 1440 and about 1,600px at 360 — pushing the
   * tab strip and every tab's content below the fold, on all five tabs and the
   * phase page. A header is a header at any length of value.
   */
  clamp?: boolean;
}) {
  const rows = items.filter(
    (item): item is readonly [string, ReactNode] => Array.isArray(item) && item[1] != null && item[1] !== '',
  );
  if (!rows.length) return null;

  return (
    <dl
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]',
        className,
      )}
    >
      {/* `col-span-full` is the PHONE span, and it has to stop at `sm`. A row
          spans the tracks its subgrid needs — one below `sm`, two above it —
          and `full` above `sm` is only harmless while the caller keeps the
          default two-track grid. `features/plans/header.tsx` does not: it
          overrides with `sm:grid-cols-[repeat(auto-fit,minmax(min(16rem,100%),auto))]`,
          `twMerge` keeps the caller's track list, and `full` then gave each
          fact the whole row — the plan header went from MODEL │ BUDGET side by
          side to seven facts stacked down 60% empty width at 1440. */}
      {rows.map(([label, value]) => (
        <div key={label} className="col-span-full grid grid-cols-subgrid items-baseline sm:col-span-2">
          <dt className="text-2xs uppercase tracking-wide text-ink-faint">{label}</dt>
          <dd className="m-0 min-w-0 text-ink-muted">
            {clamp ? <ClampedValue>{value}</ClampedValue> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A value that may be a paragraph, shown as four lines until asked otherwise.
 *
 * The overflow is MEASURED rather than guessed from the value's type or its
 * length: a fact's value is a `ReactNode`, so there is nothing to count, and a
 * character count would be wrong at every width anyway. `scrollHeight` against
 * `clientHeight` is the browser's own answer to "is this clamped".
 *
 * Measured only while it IS clamped. Once open the box is its full height, so
 * it would report no overflow, hide the control and leave the reader with no
 * way back — the classic shape of this bug.
 */
function ClampedValue({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  /*
   * The measurement is a named function called BY the effect, not a `setState`
   * written inside a depless one — the same shape `useTableFit` takes, and for
   * the same two reasons. The effect has to run after every commit, because
   * what it measures is the rendered box and a new value re-renders without
   * changing any dependency this could list; and the state write has to be a
   * no-op when nothing moved, or "runs after every render" becomes a loop.
   */
  const measure = useCallback((isOpen: boolean) => {
    if (isOpen) return;
    const el = ref.current;
    if (!el) return;
    const over = el.scrollHeight - el.clientHeight > 1;
    setOverflows((prev) => (prev === over ? prev : over));
  }, []);

  useLayoutEffect(() => measure(open));

  /*
   * And again whenever the box changes size, because a render is not the only
   * thing that changes the answer. `useTableFit` is driven by a
   * `ResizeObserver` for exactly this reason and the comment above claimed the
   * same shape without it: rotating a phone, or dragging a window from a width
   * where an 1,100-character `Branch:` paragraph fits to one where it does not,
   * left "Show all" absent with no way to the rest of the value until something
   * else happened to re-render the header.
   *
   * Re-armed on `open` so the observer is disconnected while the value is
   * expanded — `measure` is a no-op then, and an observer whose callback does
   * nothing is a callback that still runs on every frame of a drag.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el || open || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, open]);

  return (
    <>
      <span ref={ref} className={cn('block min-w-0 break-words', !open && 'line-clamp-4')}>
        {children}
      </span>
      {overflows && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="tap-line mt-0.5 text-2xs text-ink-faint underline underline-offset-2 hover:text-ink"
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  );
}
