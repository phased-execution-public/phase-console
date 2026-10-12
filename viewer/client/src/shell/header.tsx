import { lazy, Suspense } from 'react';
import { Bell, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { KbdChord } from '@/ui';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { useNavigate } from './router';
import { bellHref, paletteHref, type Route } from './routes';
import { NavBadge } from './brand';
import { Switcher } from './switcher';
import { spokenHead } from './route-frame';

/* The situation words load after first paint: they fold the runs, the queue
   and the inbox, none of which a first screen needs. */
const SituationSlot = lazy(() => import('./situation-line'));

/**
 * The header (7.0): the four things that are true on every page — where you
 * are, what the situation is, the way to anything, and what the console has
 * said. The page's title in words, the situation as figures that are links
 * (only the non-zero ones), search (⌘K) and the bell. Nothing else: no theme
 * toggle, no counts, no second meter — theme and density live in Settings ▸
 * Appearance and the palette, the meter on the rail.
 *
 * The same component serves both shapes. On a phone it carries the instance
 * switcher (there is no rail to carry it) and gives the situation words a row
 * of their own, with inline padding (#284); on a desk the switcher is the
 * rail's and the header is one row.
 */
export function Header({
  state,
  counts,
  route,
  phone,
}: {
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  phone: boolean;
}) {
  const navigate = useNavigate();
  const head = route.segments[0];
  const title = spokenHead(head);

  return (
    <header
      className={cn(
        'border-b border-rule bg-ground-deep px-safe',
        phone ? 'pt-safe' : 'flex h-(--header-height) items-center gap-3 px-4',
      )}
    >
      <div className={phone ? 'flex min-h-(--tap-min) items-center gap-1 px-2' : 'contents'}>
        {phone && <Switcher state={state} variant="header" />}

        {/* Where you are, in a word. The page's own `<h1>` is the real title;
            this is the chrome's, the word the rail lights and the tab bar marks. */}
        <span className="shrink-0 text-body font-semibold text-ink" data-testid="header-title">
          {title}
        </span>

        {!phone && (
          <div className="min-w-0 flex-1">
            <Suspense fallback={null}>
              <SituationSlot state={state} counts={counts} phone={false} />
            </Suspense>
          </div>
        )}

        <div className="ms-auto flex shrink-0 items-center gap-1">

          <PaletteButton phone={phone} route={route} onOpen={(href) => navigate(href)} />

          {/* The count sits BESIDE the bell: a row that widens with its number
              cannot overlap anything. */}
          <button
            type="button"
            onClick={() => navigate(bellHref(route))}
            aria-label={counts.unread ? `Announcements, ${counts.unread} unread` : 'Announcements'}
            className="flex min-h-(--tap-min) shrink-0 items-center gap-1.5 rounded px-2 text-ink-muted hover:text-ink"
          >
            <Bell size={18} aria-hidden />
            <NavBadge count={counts.unread} hot />
          </button>
        </div>
      </div>

      {phone && (
        <Suspense fallback={null}>
          <SituationSlot state={state} counts={counts} phone />
        </Suspense>
      )}
    </header>
  );
}

/**
 * The way to anything. A wide affordance on a desk, because a palette nobody
 * knows about is a palette nobody opens — the chord is printed on it. On a
 * phone it is a magnifier: there is no chord to print, and no width to spare.
 */
function PaletteButton({
  phone,
  route,
  onOpen,
}: {
  phone: boolean;
  route: Route;
  onOpen: (href: string) => void;
}) {
  const open = () => onOpen(paletteHref('', route));

  if (phone) {
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Search and commands"
        className="flex min-h-(--tap-min) shrink-0 items-center rounded px-2 text-ink-muted hover:text-ink"
      >
        <Search size={18} aria-hidden />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      title="Go anywhere, find anything, run a verb"
      className={
        'flex h-8 w-56 items-center gap-2 rounded border border-rule bg-surface px-2 ' +
        'text-body text-ink-faint transition-colors duration-fast ease-transit hover:border-rule-strong hover:text-ink-muted'
      }
    >
      <Search size={15} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-start">Search or jump to…</span>
      <KbdChord keys={['⌘', 'K']} />
    </button>
  );
}
