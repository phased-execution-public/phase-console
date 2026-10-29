import { useRef } from 'react';
import { Ellipsis } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useBottomBar } from '@/lib/viewport';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { useNavigate } from './router';
import { destinationFor } from './routes';
import { tabItems } from './nav';
import { NavBadge } from './brand';

/**
 * The tab bar (under 900): Runs · Your turn · Plans · Sessions (the Supervisor
 * in Pro) · More — `TAB_BAR` in `nav.ts` says why that order. A **grid row of the shell**, never `position: fixed`: a fixed
 * bar drifts under iOS's URL chrome and floats mid-page on a rubber-band
 * scroll; as the last row of an `--app-height` shell it is simply the bottom.
 * It registers its height as `--bottom-bars`, so toasts stack above it.
 */
export function TabBar({
  state,
  counts,
  head,
  moreOpen,
  onMore,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  head: string | undefined;
  moreOpen: boolean;
  onMore: () => void;
}) {
  const navigate = useNavigate();
  const current = destinationFor(head);
  const bar = useRef<HTMLElement>(null);
  useBottomBar(bar);

  return (
    <nav
      ref={bar}
      aria-label="Main"
      className="grid auto-cols-fr grid-flow-col border-t border-rule bg-ground-deep pb-safe px-safe"
    >
      {tabItems(state).map((item) => {
        // A head the bar draws (the Supervisor's page) is current on its own;
        // a destination is current for every head under it.
        const active = (current === item.id || head === item.id) && !moreOpen;
        const count = item.badge ? counts[item.badge] : 0;
        const hot = item.badge === 'needsYou';
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate(item.id)}
            className={cn(
              'relative flex min-h-(--tap-min) flex-col items-center justify-center gap-0.5 px-1 py-1.5',
              // Ink, never the summons hue: being on a page is not a call to action.
              active ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {active && (
              <span
                aria-hidden
                className="absolute top-0 start-1/2 h-0.5 w-6 -translate-x-1/2 rounded-sm bg-ink"
              />
            )}
            <span className="relative">
              <item.icon size={19} aria-hidden />
              {count > 0 && (
                // Capped at 9+ so it stays a circle rather than growing into
                // its neighbour, ringed in the bar's own ground, deaf to the
                // pointer, and anchored by its START edge inside the glyph.
                // Backed by that ground too: a quiet badge's fill is a
                // translucent rule, and the glyph's strokes read through it
                // ("ꝯ9+" on every phone page — quiet-console phase 27).
                <span className="pointer-events-none absolute -top-1.5 start-3.5 flex rounded-full bg-ground-deep">
                  <NavBadge count={count} hot={hot} cap={9} className="ring-2 ring-ground-deep" />
                </span>
              )}
            </span>
            <span className="text-meta leading-none">{item.label}</span>
            {count > 0 && <span className="sr-only">, {count}</span>}
          </button>
        );
      })}
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-current={moreOpen ? 'page' : undefined}
        onClick={onMore}
        className={cn(
          'relative flex min-h-(--tap-min) flex-col items-center justify-center gap-0.5 px-1 py-1.5',
          moreOpen ? 'text-ink' : 'text-ink-muted',
        )}
      >
        {moreOpen && (
          <span
            aria-hidden
            className="absolute top-0 start-1/2 h-0.5 w-6 -translate-x-1/2 rounded-sm bg-ink"
          />
        )}
        <Ellipsis size={19} aria-hidden />
        <span className="text-meta leading-none">More</span>
      </button>
    </nav>
  );
}
