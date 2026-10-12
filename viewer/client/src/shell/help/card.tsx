/**
 * One guide card — a native `<details>`, drawn on the kit's tokens: a hairline
 * and the radius, the surface tone, no shadow (surfaces differ by tone).
 *
 * Native rather than an accordion component: it brings keyboard activation,
 * the right semantics and find-in-page for no bytes at all.
 *
 * The body is ALWAYS mounted, never `{open && …}`. Three reasons, all learned:
 * the guide's own tests query the DOM for tables and code inside a section, so
 * conditional rendering would make them depend on collapse state; Cmd-F has to
 * find text in a card you have not opened yet; and the status-word decoration
 * then runs exactly once per card, at mount, with no re-entry to reason about.
 *
 * The summary holds the card's title as an `h3` — its accessible name. A title
 * can itself be a status word (`troubleshooting` has a card per resting state),
 * so it is drawn as the family draws one: its dot beside it, in its paint.
 */

import { ChevronRight, Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useNavigate } from '@/shell/router';
import { STATUS_WORD_DOT, StatusProse, wearStatusWord } from './prose';
import type { GuideCard } from './split';

export function HelpCard({
  card,
  href,
  stop,
  open,
  onToggle,
}: {
  card: GuideCard;
  /**
   * This card's permalink, built by the sheet from the route it was opened
   * OVER (`helpHref(section, card, route)`), so following it keeps the page
   * underneath — the whole premise of help as an overlay.
   */
  href: string;
  /** Its place on the section's line, for a section that is a sequence. */
  stop?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  // Headings are capitalised and the vocabularies are not: `Halted` is `halted`.
  const word = wearStatusWord(card.title) ?? wearStatusWord(card.title.toLowerCase());

  return (
    <details
      id={`card-${card.id}`}
      className="group/card scroll-mt-4 rounded border border-rule bg-surface"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-start gap-2 rounded px-3 py-2.5 group-open/card:rounded-b-none',
          'transition-colors duration-fast ease-transit hover:bg-surface-raised',
          '[@media(hover:none)]:min-h-(--tap-min)',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden
          className="mt-1 shrink-0 text-ink-faint transition-transform duration-fast ease-transit group-open/card:rotate-90"
        />
        {stop != null && (
          <span className="mt-0.5 shrink-0 text-meta text-ink-faint tabular-nums">{stop}</span>
        )}
        {card.marker && (
          <span className="mt-0.5 shrink-0 text-meta text-ink-faint tabular-nums">
            {card.marker.word} {card.marker.n}
          </span>
        )}
        <h3 className="min-w-0 flex-1 text-body font-semibold text-ink">
          {word ? (
            <span className={word.className} title={word.title}>
              <i aria-hidden className={STATUS_WORD_DOT} />
              {card.title}
            </span>
          ) : (
            card.title
          )}
        </h3>
      </summary>

      <div className="flex min-w-0 flex-col gap-2 border-t border-rule px-3 py-3">
        <StatusProse text={card.body} />
        {/*
          A permalink, not an in-page anchor: `#card-x` IS a route to a hash
          router. It lives in the card's body, not its `<summary>`: a link inside
          the summary is an interactive control inside another (axe's
          nested-interactive), and a tap on it toggled the card shut behind you.
        */}
        <a
          href={href}
          onClick={(e) => {
            // A modified click opens the link where the person asked for it.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            navigate(href);
          }}
          className="tap-row inline-flex w-fit items-center gap-1 rounded-sm text-meta text-ink-muted hover:text-ink"
        >
          <Link2 size={12} aria-hidden />
          Link to this card
        </a>
      </div>
    </details>
  );
}
