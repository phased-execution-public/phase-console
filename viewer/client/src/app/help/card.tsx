/**
 * One guide card — a `<details>` wearing a Card's clothes.
 *
 * Native rather than an accordion component, for the reason the rest of this
 * codebase already uses `<details>` in five places: it brings keyboard
 * activation, the right semantics and find-in-page for no bytes at all, against
 * a 300 KB gzipped entry budget that a new dependency would eat into.
 *
 * The body is ALWAYS mounted, never `{open && …}`. Three reasons, all learned:
 * the guide's own tests query the DOM for tables and code inside a section, so
 * conditional rendering would make them depend on collapse state; Cmd-F has to
 * find text in a card you have not opened yet; and the status-word decoration
 * then runs exactly once per card, at mount, with no re-entry to reason about.
 *
 * A card's title can itself be a status word — `troubleshooting` has a card per
 * resting state — so it goes through the same `wearStatusWord` the prose
 * does. That is why `halted` in a heading is painted like `halted` in a table.
 */

import { ChevronRight, Link2 } from 'lucide-react';
import { cardClass } from '@/components/ui';
import { cn } from '@/lib/cn';
import { navigate } from '@/app/router';
import { StatusProse, wearStatusWord } from './prose';
import type { GuideCard as Card } from './split';

export function GuideCard({
  card,
  href,
  open,
  onToggle,
}: {
  card: Card;
  /**
   * This card's permalink, built by the sheet from the route it was opened
   * OVER (`helpHref(section, card, route)`).
   *
   * It used to be spelled `#/guide/<section>?card=<id>` here — the 2.x
   * DESTINATION, retired in 3.0 and now only a redirect. The help sheet's whole
   * premise is that it is an overlay: "the 2.x guide was a destination, which
   * meant reading how a thing works cost leaving the thing." Following the old
   * address re-based the overlay onto Now and threw away the page underneath —
   * from a link whose entire purpose is to bring someone back to where they
   * were.
   */
  href: string;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const worn = wearStatusWord(card.title);

  return (
    <details
      id={`card-${card.id}`}
      className={cn(cardClass, 'group/card scroll-mt-4 overflow-hidden')}
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          // The card's own radius, named rather than inherited: the card clips to
          // its rounded corners, and a summary square at its corners lost them to
          // the card (the touch tour counted it, control-tower phase 31).
          'flex cursor-pointer list-none items-start gap-2 rounded-lg px-4 py-3 group-open/card:rounded-b-none',
          'transition-colors duration-fast ease-transit hover:bg-surface-raised',
          '[@media(hover:none)]:min-h-(--tap-min)',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          size={15}
          aria-hidden
          className="mt-1 shrink-0 text-ink-faint transition-transform duration-fast ease-transit group-open/card:rotate-90"
        />

        {card.marker && (
          <span className="mt-0.5 shrink-0 font-mono text-2xs tracking-wide text-ink-faint uppercase">
            {card.marker.word} {card.marker.n}
          </span>
        )}

        <h3 className={cn('min-w-0 flex-1 font-display text-lg leading-snug', worn && 'font-mono')}>
          {worn ? (
            <span className={worn.className} title={worn.title}>
              {card.title}
            </span>
          ) : (
            card.title
          )}
        </h3>
      </summary>

      <div className="border-t border-rule px-4 py-3">
        <StatusProse text={card.body} />
        {/*
          A permalink, not an in-page anchor: `#card-x` IS a route to a hash
          router, which is the bug the tabbed guide was built to fix. It lives in
          the card's body, not its `<summary>`: a link inside the summary is an
          interactive control inside another (axe's nested-interactive), and a
          tap on it had to be stopped dead or it toggled the card shut behind you.
        */}
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            navigate(href);
          }}
          className="tap-area mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-ink-muted hover:text-ink"
        >
          <Link2 size={12} aria-hidden />
          Link to this card
        </a>
      </div>
    </details>
  );
}
