import { cn } from '@/lib/cn';

/**
 * The one section-navigation pattern (§Architecture 4): a page with sections
 * — Repo, Logs, Settings, a plan's tabs — draws them as REAL LINKS with the
 * section in the address, never as tabs held in component state. A section is
 * then a thing a person can copy, reload, send to a phone and arrive at; the
 * current one is `aria-current`, and the list is a labelled `<nav>` so a screen
 * reader hears where it is before it reads what is there.
 *
 * Horizontal and scrolling on a phone, a column at the start of the page where
 * the page asks for one (`vertical`). Type only: the current section is ink, the
 * rest muted, and a hairline marks the current one — no filled chip behind
 * text (design.md principle 4).
 *
 * The rule under the horizontal list is an inset shadow, as the kit's tabs
 * draw theirs (`ui/tabs.tsx`), never a border the links overlap: the list
 * scrolls, a scroller clips at its padding box, and a link pushed 1px into a
 * border lost its last row of pixels to the clip — a tap there landed on the
 * list (the e2e register's `touch-wins`, quiet-console phase 15).
 */
export interface Section {
  id: string;
  label: string;
  href: string;
  /** A count beside the name, when the section has one worth a glance. */
  count?: number;
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
  return (
    <nav aria-label={label} className={cn('min-w-0', className)}>
      <ul
        className={cn(
          'flex',
          vertical
            ? 'flex-col gap-0.5'
            : 'gap-1 overflow-x-auto overscroll-x-contain shadow-[inset_0_-1px_0_var(--rule)] [scrollbar-width:none]',
        )}
      >
        {sections.map((section) => {
          const active = section.id === current;
          return (
            <li key={section.id} className="shrink-0">
              <a
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 items-center gap-1.5 whitespace-nowrap text-body',
                  'transition-colors duration-fast ease-transit [@media(hover:none)]:min-h-(--tap-min)',
                  vertical ? 'rounded border-s-2 px-3' : 'border-b-2 px-2 pt-1 pb-1.5 first:ps-0',
                  active
                    ? 'border-ink font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {section.label}
                {section.count != null && section.count > 0 && (
                  <span className="text-meta tabular-nums text-ink-faint">{section.count}</span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
