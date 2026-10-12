import { useId } from 'react';
import { LifeBuoy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SectionHeading } from '@/ui';
import { Sheet, SheetContent } from '@/ui/sheet';
import type { ConsoleState } from '@/data/api';
import type { ShellCounts } from '@/data/console';
import { useNavigate } from './router';
import { destinationFor, helpHref, type Route } from './routes';
import { navBands, sheetItems } from './nav';
import { NavBadge } from './brand';
import { Limits } from './limits';

/**
 * Everything the four tabs do not show — so nothing is unreachable on a phone.
 *
 * Unlike the rail, this list PRINTS its band labels: a sheet that opens over
 * whatever page you were on has no spatial memory, and four unheaded entries
 * is the flat list the bands exist to avoid. Below the places: Help, the
 * account meter, and whether this console may write — as a word, never a
 * filled badge, and never amber: amber is a summons, and "writes on" is not one.
 */
export default function MoreSheet({
  open,
  onOpenChange,
  state,
  counts,
  route,
  head,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: ConsoleState | undefined;
  counts: ShellCounts;
  route: Route;
  head: string | undefined;
}) {
  const navigate = useNavigate();
  const current = destinationFor(head);
  const bandLabels = useId();

  const go = (target: string) => {
    navigate(target);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="More">
        <div className="flex flex-col gap-3">
          {navBands(sheetItems(state)).map((band) => (
            <div
              key={band.id}
              role="group"
              aria-labelledby={`${bandLabels}-${band.id}`}
              className="flex flex-col gap-1"
            >
              <SectionHeading as="h3" id={`${bandLabels}-${band.id}`} className="px-2">
                {band.label}
              </SectionHeading>
              {band.items.map((item) => {
                const count = item.badge ? counts[item.badge] : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={current === item.id ? 'page' : undefined}
                    onClick={() => go(item.id)}
                    className={cn(
                      'flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-start',
                      current === item.id ? 'bg-surface-raised' : 'hover:bg-surface-raised',
                    )}
                  >
                    <item.icon size={17} className="shrink-0 text-ink-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-body font-medium text-ink">{item.label}</span>
                        {count > 0 && <NavBadge count={count} hot={item.badge === 'needsYou'} />}
                      </span>
                      <span className="block truncate text-meta text-ink-faint">{item.note}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          <div className="flex flex-col gap-1">
            <SectionHeading as="h3" className="px-2">
              Over this page
            </SectionHeading>
            <button
              type="button"
              onClick={() => go(helpHref(undefined, undefined, route))}
              className="flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-start hover:bg-surface-raised"
            >
              <LifeBuoy size={17} className="shrink-0 text-ink-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-ink">Help</span>
                <span className="block truncate text-meta text-ink-faint">
                  The guide, over whatever page you are on
                </span>
              </span>
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-3">
          <Limits variant="row" />
          <div className="flex min-h-9 items-center justify-between gap-2 px-2 text-body">
            <span className="text-ink-muted">Writes</span>
            <span
              className="text-ink"
              title={
                state?.allowWrites
                  ? 'This console may scaffold plans and handoffs, record QA and take locks'
                  : 'Start with --allow-writes to enable scaffolding, QA records and locks'
              }
            >
              {state?.allowWrites ? 'on' : 'read-only'}
            </span>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
