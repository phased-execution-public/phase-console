import { useId } from 'react';
import { LifeBuoy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Chip, SectionHeading, Sheet, SheetContent } from '@/components/ui';
import { LimitsWidget } from '@/components/limits-widget';
import { useNavigate } from '@/app/router';
import { destinationFor, helpHref, type Route } from '@/app/routes';
import type { ConsoleState } from '@/lib/api';
import type { ShellCounts } from '@/lib/queries';
import { navBands, sheetItems } from './nav';
import { NavBadge } from './brand';
import { ThemeSwitch } from './theme-switch';

/**
 * Everything the four tabs do not show — so nothing is unreachable on a phone.
 *
 * The 2.x rail put Guide, Settings and the theme switcher in a footer the phone
 * layout set to `display: none`; nothing announced it, the links simply were not
 * there. This sheet is the phone's route to the four destinations the bar does
 * not carry and to Help, and the gate on Sessions is applied to the TAB BAR
 * rather than here, so a console without either flag loses a tab and gains
 * nothing hidden.
 *
 * Unlike the rail, this list PRINTS its band labels. The rail can separate the
 * work from the record with a hairline because its order is in the muscle by the
 * second day; a sheet that opens over whatever page you were on has no such
 * memory, and four unheaded entries there is the flat list 4.0 grew bands to
 * avoid.
 */
export function MoreSheet({
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
  // One stable prefix per mounted sheet, so two sheets could never mint the
  // same `aria-labelledby` target.
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
            // `aria-labelledby` rather than a bare heading: the label is drawn,
            // so pointing the group at it names the group without saying the
            // word twice to a screen reader.
            <div
              key={band.id}
              role="group"
              aria-labelledby={`${bandLabels}-${band.id}`}
              className="flex flex-col gap-1"
            >
              <SectionHeading as="span" id={`${bandLabels}-${band.id}`} className="px-2">
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
                      'flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-left',
                      current === item.id ? 'bg-surface-raised' : 'hover:bg-surface-raised',
                    )}
                  >
                    <item.icon size={17} className="shrink-0 text-ink-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <strong className="truncate font-medium">{item.label}</strong>
                        {count > 0 && <NavBadge count={count} hot />}
                      </span>
                      <span className="block truncate text-2xs text-ink-faint">{item.note}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* Help is an overlay, not a destination — which is exactly what its
              own band says. It is the third thing a phone reaches for, and the
              sheet is the only place it can live. */}
          <div className="flex flex-col gap-1">
            <SectionHeading as="span" className="px-2">
              Over this page
            </SectionHeading>
            <button
              type="button"
              onClick={() => go(helpHref(undefined, undefined, route))}
              className="flex min-h-(--tap-min) items-center gap-3 rounded px-2 py-2 text-left hover:bg-surface-raised"
            >
              <LifeBuoy size={17} className="shrink-0 text-ink-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <strong className="block truncate font-medium">Help</strong>
                <span className="block truncate text-2xs text-ink-faint">
                  The guide, over whatever page you are on
                </span>
              </span>
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3 border-t border-rule pt-3">
          <LimitsWidget variant="sheet" />

          <div className="flex items-center justify-between gap-2">
            <SectionHeading as="span">Theme</SectionHeading>
            <ThemeSwitch />
          </div>

          <div className="flex items-center justify-between gap-2">
            <SectionHeading as="span">Writes</SectionHeading>
            {state?.allowWrites ? (
              <Chip tone="warn">enabled</Chip>
            ) : (
              <Chip title="Start with --allow-writes to enable scaffolding, QA records and locks">
                read-only
              </Chip>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
