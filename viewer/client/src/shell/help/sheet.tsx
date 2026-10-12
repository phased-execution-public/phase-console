/**
 * The help sheet — the guide, over whatever page you are on.
 *
 * An overlay, never a destination: `?help=<section>` on any route, with
 * `&card=` addressing one card inside it, so reading how a thing works never
 * costs leaving the thing. Every old `#/guide/…` URL redirects here with both
 * halves of its address intact, so the phone-setup instructions people were
 * told to open still open exactly what they always did.
 *
 * Explanations live in Help, reached from the page (design.md §1, principle
 * 10). So a `?help=` that names no section — the shell's help key, `#/guide`
 * — opens the PAGE's own: the Tower over Runs, Your turn over Your turn, and
 * for a page Getting around describes, that section at the page's card
 * (`sections.ts` `pageHelp`). The sections are the one section-navigation
 * pattern, real links with the section in the address; under them, what this
 * page reads and presses, folded, from the surface registry.
 *
 * The content model is the guide's own: sections are
 * `client/src/content/guide/*.md`, cut into cards at their headings by
 * `split.ts` and rendered through the same sanitizer every other surface uses.
 * `GUIDE_SECTIONS` stays the frozen vocabulary in `shared/route-meta.js`: a
 * section added to one and forgotten in the other is a test failure rather
 * than an empty tab.
 */

import { Suspense, lazy, useCallback } from 'react';
import { usePhone } from '@/lib/media';
import { useConsoleState } from '@/data/console';
import { Mono, Spinner } from '@/ui';
import { Sheet, SheetContent } from '@/ui/sheet';
import { useNavigate } from '@/shell/router';
import { OVERLAY_KEYS, closeOverlaysHref, helpHref, type Route } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { PageRoutes } from './route-strip';
import { HELP_SECTIONS, helpPlace } from './sections';

// Lazy: the section panel carries the guide's prose (~60 KB of `?raw`
// markdown), its splitter and `marked`. The sheet paints its frame and its
// section list first, and the body follows.
const HelpSectionPanel = lazy(() => import('./section').then((m) => ({ default: m.HelpSectionPanel })));

/**
 * Bring the current section's link into its own strip — the strip scrolls
 * sideways and the current section may sit past its edge. Moves that one
 * scroller and nothing else (never `scrollIntoView`, which moves every
 * ancestor); a link already in view stays where it is.
 */
function centreCurrent(strip: HTMLElement | null): void {
  const list = strip?.querySelector('ul');
  const link = list?.querySelector('[aria-current="page"]');
  if (!list || !link) return;
  const box = list.getBoundingClientRect();
  const rect = link.getBoundingClientRect();
  if (rect.left >= box.left && rect.right <= box.right) return;
  list.scrollLeft += rect.left - box.left - (box.width - rect.width) / 2;
}

export function HelpSheet({ route }: { route: Route }) {
  const navigate = useNavigate();
  const phone = usePhone();
  const asked = route.query[OVERLAY_KEYS.help];
  const open = asked != null;
  const { section, cardLabel } = helpPlace(route, asked || undefined);
  // A callback ref, so the strip is centred when it mounts — the dialog's
  // portal mounts after this component's own commit — and again when the
  // section changes (the strip is keyed by it).
  const strip = useCallback((node: HTMLDivElement | null) => centreCurrent(node), []);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) navigate(closeOverlaysHref(route));
      }}
    >
      <SheetContent
        side={phone ? 'bottom' : 'end'}
        title="Help"
        showTitle
        // Help is read before anything in it is pressed: open on its title,
        // not with a ring on the route strip's toggle (phase 26's note).
        focusTitle
        subheader={
          <div key={section.id} ref={strip}>
            <SectionNav
              label="Guide sections"
              current={section.id}
              sections={HELP_SECTIONS.map((s) => ({
                id: s.id,
                label: s.label,
                href: helpHref(s.id, undefined, route),
              }))}
            />
          </div>
        }
      >
        {open && (
          <div className="flex min-w-0 flex-col gap-4">
            <ConsolePosture />
            <PageRoutes route={route} />
            <Suspense
              fallback={
                <div className="grid place-items-center py-12">
                  <Spinner />
                </div>
              }
            >
              <HelpSectionPanel
                section={section}
                card={route.query.card}
                cardLabel={cardLabel}
                hrefFor={(cardId) => helpHref(section.id, cardId, route)}
              />
            </Suspense>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * What this console can actually do, said before the guide describes what a
 * console can do in general. Reading "start a run" on a console that cannot is
 * the fastest way to conclude the software is broken.
 */
export function ConsolePosture() {
  const { data: state } = useConsoleState();
  if (!state) return null;
  const on = state.autopilot === true && state.allowRun === true;
  const text =
    state.autopilot === false ? (
      'This console predates the autopilot. Restart it to pick up the run endpoints.'
    ) : state.allowRun ? (
      'Runs are enabled on this console.'
    ) : (
      <span>
        This console can show runs but not start them: it was started without <Mono value="--allow-run" />.
      </span>
    );

  return (
    <p className="flex items-center gap-2 text-body text-ink-muted">
      <i
        aria-hidden
        className={
          on
            ? 'state-done inline-block size-1.5 shrink-0 rounded-full bg-state'
            : 'inline-block size-1.5 shrink-0 rounded-full border border-ink-faint'
        }
      />
      {text}
    </p>
  );
}
