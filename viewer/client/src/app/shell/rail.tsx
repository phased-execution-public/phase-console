import { cn } from '@/lib/cn';
import { Chip } from '@/components/ui';
import { useNavigate } from '@/app/router';
import { destinationFor, nowHref } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { navBands, visibleNav } from './nav';
import { NavBadge, RouteGlyph, Wordmark } from './brand';

/**
 * The desktop navigation: eight destinations and nothing else.
 *
 * Everything the 2.x rail carried below its list — the usage meters, the source
 * button, the theme group, a second block of "secondary" links — has moved to
 * the header, which is where a fact that is true on every page belongs. What is
 * left is a list you can read in one glance, which is the only thing a rail is
 * better at than a header.
 *
 * Eight is where a flat list stops being one glance, so 4.0 groups them into the
 * three bands `nav.ts` declares — the work, the record, the console — separated
 * by a hairline and no words. The rule is enough here because the order is
 * learned in a day and three headings in a 200px column is chrome; the More
 * sheet, which has no such spatial memory, prints the labels.
 *
 * Below `--bp-shell` the shell swaps this out for the tab bar entirely.
 */
export function Rail({
  state,
  counts,
  head,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
}) {
  const navigate = useNavigate();
  const current = destinationFor(head);
  const nav = visibleNav(state);

  return (
    <nav
      className="flex h-(--app-height) min-h-0 w-(--rail-width) flex-col gap-3 overflow-y-auto border-r border-rule bg-ground-deep px-3 py-4"
      aria-label="Main"
    >
      <a href={nowHref()} className="flex items-center gap-2 rounded px-1" aria-label="Phase Console — Now">
        <RouteGlyph />
        <Wordmark />
      </a>

      <div className="flex flex-col gap-2">
        {navBands(nav).map((band, index) => (
          <div
            key={band.id}
            // A group with a NAME. The band is drawn as a hairline and nothing
            // else, so without this the grouping is visual-only — the one
            // reading a screen reader could not get (WCAG 1.3.1). The More
            // sheet prints the same word; here it is only announced.
            role="group"
            aria-label={band.label}
            // The hairline between bands, never above the first one — a rule at
            // the top of a list separates it from the wordmark, which is not a
            // thing these bands mean.
            className={cn('flex flex-col gap-0.5', index > 0 && 'border-t border-rule pt-2')}
          >
            {band.items.map((item) => {
              const count = item.badge ? counts[item.badge] : 0;
              // Only the accent count is "hot". A live session or a plan census
              // is information; something waiting on a person is a call to
              // action, and if everything is amber then nothing is.
              const hot = item.badge === 'needsYou' || item.badge === 'approvals';
              const active = current === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                  className={cn(
                    'relative flex w-full items-center justify-between gap-2 rounded py-1.5 pr-2 pl-3 text-left text-sm',
                    'transition-colors duration-fast ease-transit',
                    active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
                  )}
                >
                  {/* The station mark. The rail is a line and the page you are
                      on is a stop on it — design.md §7, drawn small. NOT amber:
                      amber means a person is needed (§3), and being somewhere is
                      not a call to action. `aria-current` above is what actually
                      announces it; this is the sighted half. */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-sm',
                      'transition-colors duration-fast ease-transit',
                      active ? 'bg-ink' : 'bg-transparent',
                    )}
                  />
                  <span className="flex min-w-0 items-center gap-2">
                    <item.icon size={15} className="shrink-0" aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </span>
                  {count > 0 && <NavBadge count={count} hot={hot} />}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
          <Chip mono>{counts.plans} plans</Chip>
          <Chip mono>{counts.phases} phases</Chip>
        </div>
        {state?.allowWrites ? (
          <Chip tone="warn">writes enabled</Chip>
        ) : (
          <Chip title="Start with --allow-writes to enable scaffolding, QA records and locks">read-only</Chip>
        )}
      </div>
    </nav>
  );
}
