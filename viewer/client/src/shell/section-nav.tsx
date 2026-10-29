import type { LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { cn } from '@/lib/cn';

/**
 * The one section-navigation pattern (§Architecture 4): a page with sections
 * — Repo, Logs, Settings, a plan's views and readings — draws them as REAL
 * LINKS with the section in the address, never as tabs held in component
 * state. A section is then a thing a person can copy, reload, send to a phone
 * and arrive at; the current one is `aria-current`, and the list is a labelled
 * `<nav>` so a screen reader hears where it is before it reads what is there.
 *
 * Horizontal, it is a BAY (2026-10-20, Tower strips): a recessed track whose
 * current section is a raised tile that slides to the section chosen, each
 * section an optional glyph, its name and a count in a pill — the count in a
 * state's hue when it counts a state (`paint`: a reading whose QA failed
 * counts its fails in red), so the colour is a state class's and never a page's.
 * On a phone the track scrolls sideways and keeps the current tile in view by
 * its own `scrollLeft` (never `scrollIntoView`, which drags the page). The
 * tile is measured from the current link and placed from the track's start
 * edge, so it mirrors under `dir="rtl"`; it rides in the scroller, so it
 * scrolls with the links, and it moves only while motion is welcome.
 *
 * Vertical (`vertical`), it is a column at the start of the page whose
 * current section sits on a tile with an ink edge.
 */
export interface Section {
  id: string;
  label: string;
  href: string;
  /** A count beside the name, when the section has one worth a glance. */
  count?: number;
  /** The state the count is about — the worst thing it holds — when it is one. */
  paint?: UiState;
  /** What the count counts, said in words for a screen reader: "2 QA fails". */
  countLabel?: string;
  /** A glyph before the name. */
  icon?: LucideIcon;
}

/** Where the current section's tile stands: its offset from the track's start, in the track's content, and its width. */
type Tile = { x: number; width: number; rtl: boolean };

function useTile(current: string | undefined, enabled: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const [tile, setTile] = useState<Tile | null>(null);
  useLayoutEffect(() => {
    const node = track.current;
    if (!enabled || !node) return;
    const measure = () => {
      const link = node.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!link) {
        setTile(null);
        return;
      }
      const rtl = getComputedStyle(node).direction === 'rtl';
      const outer = node.getBoundingClientRect();
      const inner = link.getBoundingClientRect();
      // In the scroller's content, from its start edge: a scrolled track moves
      // the links, never the tile's coordinates.
      const x = rtl ? outer.right - inner.right - node.scrollLeft : inner.left - outer.left + node.scrollLeft;
      setTile((was) =>
        was && was.x === x && was.width === inner.width && was.rtl === rtl
          ? was
          : { x, width: inner.width, rtl },
      );
      // Keep the current section in view on a narrow track.
      const left = link.offsetLeft;
      const right = left + link.offsetWidth;
      if (left < node.scrollLeft) node.scrollLeft = left;
      else if (right > node.scrollLeft + node.clientWidth) node.scrollLeft = right - node.clientWidth;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    for (const link of node.querySelectorAll('a')) watch.observe(link);
    return () => watch.disconnect();
  }, [current, enabled]);
  return { track, tile };
}

export function SectionNav({
  sections,
  current,
  label,
  vertical = false,
  className,
}: {
  sections: readonly Section[];
  current: string | undefined;
  /** What the list is: "Settings sections", "Repo sections". */
  label: string;
  vertical?: boolean;
  className?: string;
}) {
  const { track, tile } = useTile(current, !vertical);
  const list = (
    <ul className={cn('flex', vertical ? 'flex-col gap-0.5' : 'relative gap-0.5')}>
      {sections.map((section) => {
        const active = section.id === current;
        const Icon = section.icon;
        const paint = section.paint;
        return (
          <li key={section.id} className="shrink-0">
            <a
              href={section.href}
              aria-current={active ? 'page' : undefined}
              data-section={section.id}
              className={cn(
                'flex min-h-9 items-center gap-1.5 whitespace-nowrap text-body',
                'transition-colors duration-fast ease-transit [@media(hover:none)]:min-h-(--tap-min)',
                vertical
                  ? cn(
                      'rounded-md border-s-2 px-3',
                      active
                        ? 'border-ink bg-ground-deep font-medium text-ink'
                        : 'border-transparent text-ink-muted hover:text-ink',
                    )
                  : cn('rounded-md px-3', active ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink'),
              )}
            >
              {Icon && (
                <Icon
                  size={15}
                  aria-hidden
                  className={cn('shrink-0', active ? 'text-ink' : 'text-ink-faint')}
                />
              )}
              {section.label}
              {section.count != null && section.count > 0 && (
                <span
                  data-count={section.count}
                  className={cn(
                    'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-meta leading-[1.4] font-semibold tabular-nums',
                    paint ? `state-${paint} bg-state-tint text-state` : 'bg-ground-deep text-ink-muted',
                    active && !paint && 'bg-surface-raised text-ink',
                  )}
                >
                  {section.countLabel ? (
                    <>
                      <span aria-hidden>{section.count}</span>
                      <span className="sr-only">, {section.countLabel}</span>
                    </>
                  ) : (
                    section.count
                  )}
                </span>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
  if (vertical) {
    return (
      <nav aria-label={label} className={cn('min-w-0', className)}>
        {list}
      </nav>
    );
  }
  return (
    <nav aria-label={label} className={cn('min-w-0', className)}>
      <div
        ref={track}
        data-bay=""
        className={cn(
          'relative inline-flex max-w-full overflow-x-auto overscroll-x-contain rounded-lg bg-ground-deep p-1',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        )}
      >
        {tile && (
          <span
            aria-hidden
            data-bay-tile=""
            className="pointer-events-none absolute inset-y-1 start-0 rounded-md border border-rule-strong bg-surface transition-[transform,width] duration-medium ease-transit"
            style={{ width: tile.width, transform: `translateX(${tile.rtl ? -tile.x : tile.x}px)` }}
          />
        )}
        {list}
      </div>
    </nav>
  );
}
