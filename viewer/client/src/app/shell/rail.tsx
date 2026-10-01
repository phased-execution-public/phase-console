import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui';
import { useNavigate } from '@/app/router';
import { destinationFor, runsHref } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { navBands, visibleNav } from './nav';
import { NavBadge, RouteGlyph } from './brand';

/**
 * The desktop navigation: seven destinations and nothing else — slim.
 *
 * Everything the 2.x rail carried below its list — the usage meters, the source
 * button, the theme group, a second block of "secondary" links — moved to the
 * header long ago, which is where a fact that is true on every page belongs.
 * 6.0 (control-tower phase 21) takes the rest of the width back: each
 * destination is its glyph over its NAME, a column the width of the longest
 * name, so the page gets the 160 px the old rail spent on horizontal labels and
 * a rail that names its entries still needs no hover to be read.
 *
 * The groups are the three bands `nav.ts` declares — the work, the record, the
 * console — separated by a hairline and no words; the More sheet, which has no
 * such spatial memory, prints the labels. The count rides the glyph's corner,
 * as on the phone's tab bar, and only the call to action is hot.
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
  // An item that is a SWITCH on a desk rather than a place: pressing it acts
  // here, and it reads as pressed rather than as the page you are on.
  const switches: Record<string, { pressed: boolean; press: () => void }> = {};

  return (
    <nav
      className="flex h-(--app-height) min-h-0 w-(--rail-width) flex-col gap-3 overflow-y-auto border-e border-rule bg-ground-deep px-1.5 py-3"
      aria-label="Main"
    >
      {/* The mark, and the way home. The wordmark itself moved to the phone's
          header and the `<title>`: at this width it would be the widest thing
          in the column, and the glyph already says whose console this is. */}
      <a
        href={runsHref()}
        className="grid min-h-10 place-items-center rounded"
        aria-label="Phase Console — Runs"
        title="Phase Console"
      >
        <RouteGlyph size={28} />
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
            // the top of a list separates it from the mark, which is not a
            // thing these bands mean.
            className={cn('flex flex-col gap-0.5', index > 0 && 'border-t border-rule pt-2')}
          >
            {band.items.map((item) => {
              const count = item.badge ? counts[item.badge] : 0;
              // Only the attention count is "hot". A live session or a plan
              // census is information; something waiting on a person is a call
              // to action, and if everything is loud then nothing is.
              const hot = item.badge === 'needsYou' || item.badge === 'approvals';
              const toggle = switches[item.id];
              const active = toggle ? toggle.pressed : current === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active && !toggle ? 'page' : undefined}
                  aria-pressed={toggle ? toggle.pressed : undefined}
                  onClick={() => (toggle ? toggle.press() : navigate(item.id))}
                  // The note is what the More sheet prints under the name; here
                  // it is the hover, for the desk that has one.
                  title={item.note}
                  className={cn(
                    'relative flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5',
                    'transition-colors duration-fast ease-transit',
                    active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
                  )}
                >
                  {/* The station mark. The rail is a line and the page you are
                      on is a stop on it — design.md §7, drawn small. NOT the
                      attention hue: being somewhere is not a call to action.
                      `aria-current` above is what actually announces it; this
                      is the sighted half. */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1/2 start-0 h-5 w-0.5 -translate-y-1/2 rounded-sm',
                      'transition-colors duration-fast ease-transit',
                      active ? 'bg-ink' : 'bg-transparent',
                    )}
                  />
                  <span className="relative">
                    <item.icon size={18} className="shrink-0" aria-hidden />
                    {count > 0 && (
                      // Pinned to the glyph's corner, as on the tab bar: capped
                      // at 9+ so it stays a badge, ringed in the rail's ground,
                      // deaf to the pointer — and anchored by its START edge
                      // 4 px inside the glyph, so a wide "9+" grows away from
                      // the glyph rather than over it (the e2e shot at 1280).
                      <span className="pointer-events-none absolute -top-2 start-3.5">
                        <NavBadge count={count} hot={hot} cap={9} className="ring-2 ring-ground-deep" />
                      </span>
                    )}
                  </span>
                  {/* A name longer than the column (Supervisor) takes the display
                      face — the same family on its condensed width axis — rather
                      than an ellipsis: a truncated destination is a guess. */}
                  <span
                    className={cn(
                      'max-w-full truncate text-2xs leading-none',
                      item.label.length > 9 && 'font-display',
                    )}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* The source's size and whether this console may write — facts about
          the console, stacked to the column's width. */}
      <div className="mt-auto flex flex-col items-center gap-2 text-center">
        <dl className="flex flex-col gap-1.5">
          <div>
            <dt className="text-2xs leading-none text-ink-muted">plans</dt>
            <dd className="font-mono text-xs tabular-nums text-ink-muted">{counts.plans}</dd>
          </div>
          <div>
            <dt className="text-2xs leading-none text-ink-muted">phases</dt>
            <dd className="font-mono text-xs tabular-nums text-ink-muted">{counts.phases}</dd>
          </div>
        </dl>
        {/* Neither is a summons, so neither is the attention hue (6.0's colour
            law): the word says which, and the hover says what it means. */}
        {state?.allowWrites ? (
          <Badge title="This console may scaffold plans and handoffs, record QA and take locks">
            writes on
          </Badge>
        ) : (
          <Badge title="Start with --allow-writes to enable scaffolding, QA records and locks">
            read-only
          </Badge>
        )}
      </div>
    </nav>
  );
}
