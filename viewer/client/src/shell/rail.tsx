import { LifeBuoy } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { useNavigate } from './router';
import { destinationFor, helpHref, type Route } from './routes';
import { navBands, visibleNav } from './nav';
import { NavBadge } from './brand';
import { Switcher } from './switcher';
import { Limits } from './limits';

/**
 * The rail (900 and up): the instance switcher at its top, seven places as a
 * glyph over a word, grouped into the three bands by a hairline and nothing
 * else, and at the bottom the things that are true on every page and press
 * rather than go — the panel toggle (Pro), Help, and the account meter.
 *
 * 80 px wide (`--rail-width`): the width of the longest word, so the page gets
 * the room a labelled rail spent and a rail that names its entries still needs
 * no hover to be read. The station mark — a short rule at the start edge of
 * the current place — is the line's own motif, drawn small; it is ink, never
 * the summons hue, because being somewhere is not a call to action.
 */
export function Rail({
  state,
  counts,
  route,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
}) {
  const navigate = useNavigate();
  const head = route.segments[0];
  const current = destinationFor(head);
  const nav = visibleNav(state);

  return (
    <nav
      className="flex h-(--app-height) min-h-0 w-(--rail-width) flex-col gap-3 overflow-y-auto border-e border-rule bg-ground-deep px-1.5 py-2"
      aria-label="Main"
    >
      <Switcher state={state} variant="rail" />

      <div className="flex flex-col gap-2">
        {navBands(nav).map((band, index) => (
          <div
            key={band.id}
            // A group with a NAME. The band is drawn as a hairline, so without
            // this the grouping is the one reading a screen reader could not
            // get (WCAG 1.3.1). The More sheet prints the same word.
            role="group"
            aria-label={band.label}
            className={cn('flex flex-col gap-0.5', index > 0 && 'border-t border-rule pt-2')}
          >
            {band.items.map((item) => {
              const count = item.badge ? counts[item.badge] : 0;
              // Only the summons is hot: a session working away is information.
              const hot = item.badge === 'needsYou';
              const active = current === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                  title={item.note}
                  className={cn(
                    'relative flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded px-1 py-1.5',
                    'transition-colors duration-fast ease-transit',
                    active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface hover:text-ink',
                  )}
                >
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
                      // Pinned to the glyph's corner, capped at 9+, ringed in the
                      // rail's ground and deaf to the pointer; anchored by its
                      // START edge so a wide "9+" grows away from the glyph.
                      // Backed by the rail's ground, so the glyph's strokes do
                      // not read through a quiet badge's translucent fill.
                      <span className="pointer-events-none absolute -top-2 start-3.5 flex rounded-full bg-ground-deep">
                        <NavBadge count={count} hot={hot} cap={9} className="ring-2 ring-ground-deep" />
                      </span>
                    )}
                  </span>
                  <span className="max-w-full truncate text-meta leading-none">{item.label}</span>
                  {/* The count, for the name: the badge is a decoration. */}
                  {count > 0 && <span className="sr-only">, {count}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-auto flex flex-col items-stretch gap-1 border-t border-rule pt-2">
        <button
          type="button"
          onClick={() => navigate(helpHref(undefined, undefined, route))}
          title="The guide, over whatever page you are on"
          className="flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded px-1 py-1.5 text-ink-muted transition-colors duration-fast ease-transit hover:bg-surface hover:text-ink"
        >
          <LifeBuoy size={18} aria-hidden />
          <span className="text-meta leading-none">Help</span>
        </button>
        <Limits variant="rail" />
      </div>
    </nav>
  );
}
