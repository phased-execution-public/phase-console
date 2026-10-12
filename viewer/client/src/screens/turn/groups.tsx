/**
 * The six sections of Your turn (7.0, quiet-console phase 8): *Do now* ·
 * *Needs one detail from you* · *Coming up* · *Being checked* · *Done* ·
 * *Handled by the AI*, in that order, each a heading with its count and at
 * most one control, a hairline between them (design.md §1, principle 7), and
 * in each one card per item — a card because an item is acted on as a unit.
 *
 * An empty section stays as one line saying so: the order is the thing a
 * glance learns, and a section that vanished when empty would move every one
 * below it. *Done* and the handled log are folded with their counts, because
 * what is over is the record, not the work; Everything unfolds them and opens
 * every folded card. An item held on the page after a press (#270) is drawn
 * where it stood, saying what was pressed.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { HumanStepRecord } from '@/data/human-steps';
import type { TurnItem } from '@/data/turn';
import { SectionHeading } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { SettlingRow, type Settling } from './grants';
import { HandledList } from './handled';
import { EarlierSteps } from './history';
import { EMPTY_WORDS, filtering, type TurnSection, type SectionId, type TurnFilters } from './page-model';

export interface TurnSectionsProps {
  sections: readonly TurnSection[];
  filters: TurnFilters;
  /** Everything on: *Done* and the handled log unfolded, every card open. */
  everything: boolean;
  /** The ledger's older settled steps — *Done*'s history. */
  earlier: readonly HumanStepRecord[];
  /** How many the AI handled since the person last looked — the fold's own words. */
  handledSince: number;
  /** The items held on the page until the server's `turn` event (#270). */
  settling: readonly Settling[];
  /** The section `#/turn/<id>` names an item in — its fold opens. */
  focusedSection: SectionId | null;
  /** A section's one control — *Do now*'s *Grant every low-risk ask*. */
  asideOf?: (section: TurnSection) => ReactNode;
  /** The item, drawn by the page: the card with its parts, its moves and its inspect. */
  renderItem: (item: TurnItem, folded: boolean) => ReactNode;
}

/** One section: its heading with the count and its one control, then its rows — or its one empty sentence. */
function SectionBlock({
  section,
  filters,
  aside,
  children,
}: {
  section: TurnSection;
  filters: TurnFilters;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const hidden = section.total - section.count;
  const headingId = `turn-section-${section.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="turn-section"
      data-section={section.id}
      className="flex min-w-0 flex-col gap-3 py-5 first:pt-0 last:pb-0"
    >
      <SectionHeading id={headingId} count={section.count} aside={aside}>
        {section.label}
      </SectionHeading>
      {children}
      {hidden > 0 && filtering(filters) && (
        <p className="text-meta text-ink-muted">{hidden} more hidden by the filters.</p>
      )}
    </section>
  );
}

function Items({ children }: { children: ReactNode }) {
  return <ul className="flex list-none flex-col gap-3 p-0">{children}</ul>;
}

export function TurnSections({
  sections,
  filters,
  everything,
  earlier,
  handledSince,
  settling,
  focusedSection,
  asideOf,
  renderItem,
}: TurnSectionsProps) {
  const [doneOpen, setDoneOpen] = useState(everything || focusedSection === 'done');
  const [handledOpen, setHandledOpen] = useState(everything);
  // Everything turned on unfolds both; turned off, it leaves them as the person set them.
  useEffect(() => {
    if (everything) {
      setDoneOpen(true);
      setHandledOpen(true);
    }
  }, [everything]);
  useEffect(() => {
    if (focusedSection === 'done') setDoneOpen(true);
  }, [focusedSection]);

  const heldIn = (id: SectionId) => settling.filter((one) => one.item.group === id);

  return (
    <div className="flex min-w-0 flex-col divide-y divide-rule" data-testid="turn-sections">
      {sections.map((section) => {
        if (section.id === 'handled') {
          return (
            <SectionBlock key={section.id} section={section} filters={filters} aside={asideOf?.(section)}>
              {section.handled?.length ? (
                <Disclosure
                  label={`What the AI handled${handledSince ? `, ${handledSince} since you last looked` : ''}`}
                  openLabel="Fold the handled log"
                  count={section.count}
                  open={handledOpen}
                  onOpenChange={setHandledOpen}
                  bodyClassName="pt-2"
                >
                  <HandledList rows={section.handled} />
                </Disclosure>
              ) : (
                <p className="text-body text-ink-muted">{EMPTY_WORDS.handled}</p>
              )}
            </SectionBlock>
          );
        }
        const held = heldIn(section.id);
        if (section.id === 'done') {
          return (
            <SectionBlock key={section.id} section={section} filters={filters} aside={asideOf?.(section)}>
              {section.items.length || earlier.length ? (
                <Disclosure
                  label="What was settled"
                  openLabel="Fold what was settled"
                  count={section.count + earlier.length}
                  open={doneOpen}
                  onOpenChange={setDoneOpen}
                  bodyClassName="flex flex-col gap-3 pt-2"
                >
                  {section.items.length > 0 && (
                    <Items>
                      {section.items.map((item) => (
                        <li key={item.item} className="min-w-0">
                          {renderItem(item, !everything)}
                        </li>
                      ))}
                    </Items>
                  )}
                  <EarlierSteps steps={earlier} />
                </Disclosure>
              ) : (
                <p className="text-body text-ink-muted">{EMPTY_WORDS.done}</p>
              )}
            </SectionBlock>
          );
        }
        return (
          <SectionBlock key={section.id} section={section} filters={filters} aside={asideOf?.(section)}>
            {section.items.length || held.length ? (
              <Items>
                {section.items.map((item) => (
                  <li key={item.item} className="min-w-0">
                    {renderItem(item, section.id === 'upcoming' && !everything)}
                  </li>
                ))}
                {held.map((one) => (
                  <li key={`held:${one.item.item}`} className="min-w-0">
                    <SettlingRow settling={one} />
                  </li>
                ))}
              </Items>
            ) : (
              <p className="text-body text-ink-muted">{EMPTY_WORDS[section.id]}</p>
            )}
          </SectionBlock>
        );
      })}
    </div>
  );
}
