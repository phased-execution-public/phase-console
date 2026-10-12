/**
 * One guide section, as cards — and, for a section that is a sequence, its
 * stops on the line.
 *
 * The panel owns which cards are open rather than each card owning itself, so
 * "expand all" is one state change and a `?card=` deep link can seed the set
 * before anything renders.
 *
 * The opening policy is the editorial decision worth stating, because it is easy
 * to get backwards: **collapse is a small-screen affordance, not a way of
 * hiding content.** Putting half a desktop page behind chevrons re-creates the
 * confusion the cards exist to cure — now you cannot even see what you do not
 * know to open. What cures confusion is chunking plus an index. What cures a
 * phone's scroll length is collapse. So:
 *
 *   desktop   every card open, except the bulky ones
 *   phone     the first card of the section open, the rest closed
 *   bulky     closed at both widths — a 27-line prompt is material you copy
 *   ?card=    forced open and scrolled to, at any width
 *
 * The phone rule counts cards, not groups. "The first card of each group" reads
 * better and is wrong: every guide file is flat today, so each group holds
 * exactly one card and the rule opens all of them — the wall the cards removed,
 * restored on the smallest screen.
 *
 * `?card=` is deliberately NOT added to `shared/route-meta.js`. That file is
 * frozen vocabulary shared with the server's notification deep links, and
 * freezing card ids would freeze the prose they are derived from. An unknown
 * `?card=` is ignored and the section renders normally.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { UiState } from '@shared/status-vocab.js';
import { scrollBehavior, usePhone } from '@/lib/media';
import { Button } from '@/ui';
import { Legend } from '@/ui/legend';
import { Station } from '@/ui/track/station';
import { Track } from '@/ui/track/track';
import { HELP_BODIES } from './bodies';
import { HelpCard } from './card';
import { StatusProse } from './prose';
import type { GuideSection } from './sections';
import { cardsOf, splitGuide, type GuideActor, type GuideCard, type GuideOutline } from './split';

/**
 * Bring one card to the top of the pane it lives in — and of nothing else.
 *
 * `scrollIntoView` is banned app-wide for exactly this case: it walks every
 * scrollable ancestor, so a card deep-linked inside the help sheet also scrolls
 * the page behind it, and on a phone it scrolls the shell out from under the tab
 * bar. Finding the nearest ancestor that actually scrolls and setting its
 * scroll position moves one container and leaves the rest of the app where it
 * was.
 *
 * The glide is a preference, not a constant. `theme.css`'s blanket
 * reduced-motion rule flattens CSS `scroll-behavior`, but this call passes
 * `behavior` explicitly and CSSOM-View says an explicit value WINS over the
 * computed property — so `scrollBehavior()` asks the media query.
 */
function reveal(id: string): void {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  let pane: HTMLElement | null = card.parentElement;
  while (pane && pane.scrollHeight <= pane.clientHeight) pane = pane.parentElement;
  if (!pane) return;
  const top = card.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  pane.scrollTo({ top, behavior: scrollBehavior() });
}

/** Which cards a fresh visit opens. */
function initialOpen(outline: GuideOutline, phone: boolean, wanted?: string): Set<string> {
  const all = cardsOf(outline);
  const open = new Set<string>();
  for (const [i, card] of all.entries()) {
    if (card.bulky) continue;
    if (!phone || i === 0) open.add(card.id);
  }
  // A deep link wins over both rules — including over `bulky`, because a link
  // to a card is a request to read that card.
  if (wanted) open.add(wanted);
  return open;
}

/** The card a label heads: titled exactly it, or it and then more (`Repo — what did the work do to the tree?`). */
function cardHeadedBy(cards: readonly GuideCard[], label: string | undefined): string | undefined {
  if (!label) return undefined;
  return cards.find((card) => card.title === label || card.title.startsWith(`${label} `))?.id;
}

export function HelpSectionPanel({
  section,
  card: wanted,
  cardLabel,
  hrefFor,
}: {
  section: GuideSection;
  /** `?card=` — the card the address names. */
  card?: string;
  /** For a page's own help: the label of the card about the page, opened when the address names none. */
  cardLabel?: string;
  /**
   * The permalink for one card, built by the caller — which is the only place
   * that knows the route the overlay was opened OVER.
   */
  hrefFor: (cardId: string) => string;
}) {
  const phone = usePhone();
  // The prose lives in `bodies.ts`, not on the section record: this component
  // is behind the sheet's `lazy()`, and the record is not — see `sections.ts`.
  const body = HELP_BODIES[section.id] ?? '';
  const outline = useMemo(() => splitGuide(body), [body]);
  const cards = useMemo(() => cardsOf(outline), [outline]);
  const known = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  // The address's card wins; a page's own help falls back to the card about the page.
  const target = wanted && known.has(wanted) ? wanted : cardHeadedBy(cards, cardLabel);

  const [open, setOpen] = useState(() => initialOpen(outline, phone, target));
  const seeded = useRef<string>('');

  // Re-seed when the section changes or the viewport crosses the shell
  // breakpoint. Keyed on both so that toggling a card does not get undone by a
  // re-render, which a bare `useEffect` on `outline` would do.
  const seed = `${section.id}:${phone}:${target ?? ''}`;
  useEffect(() => {
    if (seeded.current === seed) return;
    seeded.current = seed;
    setOpen(initialOpen(outline, phone, target));
  }, [seed, outline, phone, target]);

  // A deep-linked card is brought into view once it is open. `requestAnimation-
  // Frame` rather than a bare call: the card has just been told to open, and
  // scrolling to a zero-height `<details>` lands in the wrong place.
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => reveal(target));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const scrollTo = (id: string) => {
    setOpen((prev) => new Set(prev).add(id));
    requestAnimationFrame(() => reveal(id));
  };

  const allOpen = cards.every((c) => open.has(c.id));
  const route = section.kind === 'route';
  const banded = outline.groups.some((g) => g.banded);
  // A stop is numbered by its POSITION in the section, never from the prose: a
  // number two places must agree on stops agreeing the day the guide is split.
  const stops = useMemo(
    () => (route ? new Map(cards.map((card, i) => [card.id, i + 1])) : undefined),
    [route, cards],
  );
  const list = (of: readonly GuideCard[]) => (
    <CardList cards={of} hrefFor={hrefFor} stops={stops} open={open} setOpen={setOpen} />
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-body text-ink-muted">{section.lede}</p>

      {outline.intro && <StatusProse text={outline.intro} />}

      {route ? (
        <SectionStops cards={cards} activeId={target} onPick={scrollTo} />
      ) : (
        <SectionIndex cards={cards} onPick={scrollTo} />
      )}

      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(allOpen ? new Set() : new Set(cards.map((c) => c.id)))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>

      {banded
        ? outline.groups.map((group) => (
            <section key={group.id} className="flex min-w-0 flex-col gap-3">
              {group.banded && (
                <div className="flex flex-col gap-2">
                  <h2 className="text-section font-semibold text-ink">{group.title}</h2>
                  {group.intro && <StatusProse text={group.intro} />}
                </div>
              )}
              {list(group.cards)}
            </section>
          ))
        : list(cards)}
    </div>
  );
}

function CardList({
  cards,
  hrefFor,
  stops,
  open,
  setOpen,
}: {
  cards: readonly GuideCard[];
  /** One card's permalink — see `HelpSectionPanel`. */
  hrefFor: (cardId: string) => string;
  /** Each card's place on the line, in a section that is a sequence. */
  stops: ReadonlyMap<string, number> | undefined;
  open: Set<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
}) {
  return (
    <ol className="flex min-w-0 list-none flex-col gap-2">
      {cards.map((card) => (
        <li key={card.id} className="min-w-0">
          <HelpCard
            card={card}
            href={hrefFor(card.id)}
            stop={stops?.get(card.id)}
            open={open.has(card.id)}
            onToggle={(next) =>
              setOpen((prev) => {
                const copy = new Set(prev);
                if (next) copy.add(card.id);
                else copy.delete(card.id);
                return copy;
              })
            }
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * Who moves at a stop, as paint — the legend `concepts.md` declares: work the
 * machine does is a solid green station, work that waits for you wears the
 * summons, and a stop that says neither stays neutral.
 */
const ACTOR_PAINT: Readonly<Record<GuideActor | 'none', UiState>> = {
  machine: 'done',
  person: 'needs-you',
  none: 'queued',
};

const ACTOR_KEY: Readonly<Record<GuideActor, string>> = {
  machine: 'The machine does this',
  person: 'You do this',
};

/** A station as the key draws it: the line's own mark, at the line's size. */
function StopMark({ paint }: { paint: UiState }) {
  return (
    <Track aria-hidden className="shrink-0">
      <Station paint={paint} />
    </Track>
  );
}

/**
 * A sequence's stops, on the line (design.md §7) — the console's one graphic,
 * at the size of a guide: a station per card, numbered by position, each a
 * press that opens its card and brings it into view. Only sections whose
 * content is genuinely ordered get this (`kind: 'route'`): a line over the
 * Reference glossary would assert a sequence that is not there.
 *
 * The line scrolls inside itself when the stops outrun the sheet; the sheet
 * never does.
 */
function SectionStops({
  cards,
  activeId,
  onPick,
}: {
  cards: readonly GuideCard[];
  activeId?: string;
  onPick: (id: string) => void;
}) {
  if (cards.length < 2) return null;
  const actors = (Object.keys(ACTOR_KEY) as GuideActor[]).filter((actor) =>
    cards.some((card) => card.actor === actor),
  );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="min-w-0 overflow-x-auto overscroll-x-contain pb-1">
        <Track label="Stops in this section" className="w-max min-w-full">
          {cards.map((card, i) => (
            <Station
              key={card.id}
              paint={ACTOR_PAINT[card.actor ?? 'none']}
              // Every leg but the last takes the room the stops leave, so a
              // short line still runs the whole width.
              className={i < cards.length - 1 ? 'flex-[1_0_auto]' : undefined}
            >
              <Button
                variant="ghost"
                size="sm"
                aria-current={card.id === activeId ? 'step' : undefined}
                onClick={() => onPick(card.id)}
                className="h-auto max-w-40 justify-start gap-1.5 py-1 text-start whitespace-normal aria-[current=step]:text-ink"
              >
                <span className="tabular-nums text-ink-faint">{i + 1}</span>
                <span className="min-w-0">{card.title}</span>
              </Button>
            </Station>
          ))}
        </Track>
      </div>
      {actors.length > 0 && (
        <Legend
          entries={actors.map((actor) => ({
            key: actor,
            label: ACTOR_KEY[actor],
            mark: <StopMark paint={ACTOR_PAINT[actor]} />,
          }))}
        />
      )}
    </div>
  );
}

/**
 * A set's index — the same job the stops do, without asserting an order that
 * is not there. A glossary is not a journey.
 */
function SectionIndex({
  cards,
  onPick,
}: {
  cards: readonly { id: string; title: string }[];
  onPick: (id: string) => void;
}) {
  if (cards.length < 2) return null;
  return (
    <nav aria-label="In this section">
      <ul className="flex flex-wrap gap-x-1 gap-y-0.5">
        {cards.map((card) => (
          <li key={card.id} className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPick(card.id)}
              className="h-auto min-h-7 justify-start py-1 text-start whitespace-normal"
            >
              {card.title}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
