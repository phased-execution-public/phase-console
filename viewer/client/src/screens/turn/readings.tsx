/**
 * The three new readings of Your turn (one-pool phase 14, #377) — the list,
 * the board and the timeline — and the filter chips (#366). The fourth, the
 * cards, is `groups.tsx`, 7.1's page as it was.
 *
 * ```
 * Approve 1 ────────────────────────────────────────────────────────────
 * ☐  NOW  Approval  Approve the push of pe/x                 x  Phase 4  To do  in 2 h
 * Nothing to do now, to decide or being checked.
 * ```
 *
 * Every reading draws an item as ONE line or one tile (design.md §1,
 * principle 2): what is asked, the short title, where it is from, the
 * person's status and its clock. Pressing it SELECTS it: the address names it
 * (`#/turn/<id>`) and its whole card opens in the panel — beside the list at
 * 1200 px and up, a sheet below, the card as its own page on a phone. ↑ and ↓
 * (or j and k) move the selection through the list; Enter opens the card.
 * The page decides nothing about an item: the server folded and grouped it,
 * and the card does every press.
 */

import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { TypeMark } from '@/cards/turn/type-mark';
import type { TurnItem } from '@/data/turn';
import { cn } from '@/lib/cn';
import type { Selection } from '@/shell/bell/selection';
import { RelativeTime, SectionHeading } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { TurnReadiness, TurnStatus } from '@/ui/status';
import {
  FACET_KEYS,
  FILTER_LABEL,
  boardOf,
  filtering,
  timelineOf,
  type FacetKey,
  type Facets,
  type Grouping,
  type TurnFilters,
  type TurnSection,
} from './page-model';

/** Is this item's readiness still the person's to read (To do or Redo)? The card's rule. */
function dueShown(item: TurnItem): boolean {
  return item.group !== 'checking' && item.group !== 'done' && item.readiness != null;
}

/** Where an item is from: its plan and phase, each its own fact — never a dotted string. */
function Where({ item }: { item: TurnItem }) {
  if (!item.slug) return null;
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2 text-meta text-ink-muted">
      <span className="truncate">{item.slug}</span>
      {item.phase != null && (
        <span className="shrink-0">{item.phase ? `Phase ${item.phase}` : 'The plan'}</span>
      )}
    </span>
  );
}

/** Its clock: a deadline (past it, in the failed hue), else how long it has waited. */
function Clock({ item, now }: { item: TurnItem; now: number }) {
  const deadline = item.timing?.deadline;
  const at = deadline ? Date.parse(deadline) : NaN;
  if (Number.isFinite(at)) {
    const over = at < now;
    return (
      <span
        className={cn('shrink-0 text-meta tabular-nums', over ? 'text-state state-failed' : 'text-ink-muted')}
      >
        {over ? 'Overdue ' : 'Due '}
        <RelativeTime at={deadline!} />
      </span>
    );
  }
  return (
    <span className="shrink-0 text-meta tabular-nums text-ink-muted">
      Waiting <RelativeTime at={item.since} />
    </span>
  );
}

/** The moves a list or a board shares: which item is selected, and how a press selects one. */
export interface Selecting {
  selected: string | null;
  onSelect: (item: TurnItem) => void;
}

/**
 * ↑/↓ and j/k move through `order`; Enter and Space open the focused one. The
 * focus follows the selection, so a keyboard reader always stands on the item
 * whose card the panel shows.
 */
function useListKeys(order: readonly TurnItem[], { selected, onSelect }: Selecting) {
  const root = useRef<HTMLDivElement | null>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [role="checkbox"]')) return;
      const step =
        event.key === 'ArrowDown' || event.key === 'j'
          ? 1
          : event.key === 'ArrowUp' || event.key === 'k'
            ? -1
            : 0;
      if (!step || !order.length) return;
      event.preventDefault();
      const at = order.findIndex((item) => item.item === selected);
      const next = order[Math.min(order.length - 1, Math.max(0, at < 0 ? 0 : at + step))]!;
      onSelect(next);
      root.current
        ?.querySelector<HTMLElement>(`[data-item="${CSS.escape(next.item)}"] [data-select]`)
        ?.focus();
    },
    [order, selected, onSelect],
  );
  return { root, onKeyDown };
}

/** One section's heading — its count, and the filters' remainder under it. */
function Heading({
  section,
  filters,
  aside,
}: {
  section: TurnSection;
  filters: TurnFilters;
  aside?: ReactNode;
}) {
  const hidden = section.total - section.count;
  return (
    <>
      <SectionHeading id={`turn-section-${section.id}`} count={section.count} aside={aside}>
        {section.label}
      </SectionHeading>
      {hidden > 0 && filtering(filters) && section.count === 0 && (
        <p className="text-meta text-ink-muted">{hidden} hidden by the filters.</p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The list — the default
 * ------------------------------------------------------------------ */

export function TurnList({
  sections,
  filters,
  empty,
  now,
  pick,
  selecting,
  after,
  asideOf,
}: {
  sections: readonly TurnSection[];
  filters: TurnFilters;
  /** The one line every empty group folds into. */
  empty: string | null;
  now: number;
  pick: Selection;
  selecting: Selecting;
  /** What a section draws after its rows — the cards' held presses, the done tab's history. */
  after?: (section: TurnSection) => ReactNode;
  /** A section's one control — *Approve*'s *Grant every low-risk ask*. */
  asideOf?: (section: TurnSection) => ReactNode;
}) {
  const order = sections.flatMap((section) => section.items);
  const { root, onKeyDown } = useListKeys(order, selecting);
  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      data-testid="turn-list"
      className="flex min-w-0 flex-col divide-y divide-rule"
    >
      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`turn-section-${section.id}`}
          data-testid="turn-section"
          data-section={section.id}
          className="flex min-w-0 flex-col gap-2 py-4 first:pt-0"
        >
          <Heading section={section} filters={filters} aside={asideOf?.(section)} />
          {section.items.length > 0 && (
            <ul className="flex list-none flex-col p-0" aria-label={section.label}>
              {section.items.map((item) => (
                <ListRow key={item.item} item={item} now={now} pick={pick} selecting={selecting} />
              ))}
            </ul>
          )}
          {after?.(section)}
        </section>
      ))}
      {empty && (
        <p data-testid="turn-empty-groups" className="py-4 text-body text-ink-muted">
          {empty}
        </p>
      )}
    </div>
  );
}

function ListRow({
  item,
  now,
  pick,
  selecting,
}: {
  item: TurnItem;
  now: number;
  pick: Selection;
  selecting: Selecting;
}) {
  const selected = selecting.selected === item.item;
  return (
    <li
      data-testid="turn-row"
      data-item={item.item}
      data-selected={selected ? '' : undefined}
      id={`turn-item-${item.item}`}
      className={cn(
        'group/row flex min-w-0 items-start gap-3 rounded border-s-2 px-2 py-2',
        selected ? 'border-action bg-surface' : 'border-transparent hover:bg-surface',
      )}
    >
      <Checkbox
        className="mt-1"
        checked={pick.has(item.item)}
        onCheckedChange={() => pick.toggle(item.item)}
        aria-label={`Pick “${item.title}”`}
        data-testid="turn-row-pick"
      />
      {/* `relative`: the row's one tap target hit-tests above the pick box's
          thumb-floor overlay, which overhangs its 16 px box into the row (#393). */}
      <button
        type="button"
        data-select=""
        aria-current={selected ? 'true' : undefined}
        onClick={() => selecting.onSelect(item)}
        className="relative flex min-w-0 flex-1 flex-col items-start gap-1 text-start"
      >
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {dueShown(item) && (
            <TurnReadiness
              readiness={item.readiness}
              when={item.readiness === 'not-yet' ? item.timing?.startWhen : undefined}
            />
          )}
          <TypeMark type={item.type} />
          <span
            data-testid="turn-row-title"
            className="min-w-0 flex-1 truncate text-body text-ink"
            title={item.title}
          >
            {item.title}
          </span>
        </span>
        <span className="flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <TurnStatus status={item.personStatus ?? 'todo'} />
          <Where item={item} />
          <Clock item={item} now={now} />
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

export function TurnBoard({
  sections,
  group,
  now,
  selecting,
}: {
  sections: readonly TurnSection[];
  group: Grouping;
  now: number;
  selecting: Selecting;
}) {
  const lanes = boardOf(sections, group);
  const order = lanes.flatMap((lane) => lane.columns.flatMap((column) => column.items));
  const { root, onKeyDown } = useListKeys(order, selecting);
  if (!order.length) {
    return (
      <p data-testid="turn-board-empty" className="text-body text-ink-muted">
        Nothing on the board.
      </p>
    );
  }
  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      data-testid="turn-board"
      data-group={group}
      className="flex min-w-0 flex-col gap-6"
    >
      {lanes.map((lane) => (
        <section
          key={lane.id}
          data-testid="turn-board-lane"
          data-lane={lane.id}
          aria-label={lane.label || 'Every item'}
          className="flex min-w-0 flex-col gap-2"
        >
          {lane.label && <h3 className="text-section text-ink">{lane.label}</h3>}
          <div className="grid min-w-0 auto-cols-[minmax(13rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1 lg:grid-flow-row lg:grid-cols-5 lg:overflow-visible">
            {lane.columns.map((column) => (
              <div
                key={column.id}
                data-testid="turn-board-column"
                data-column={column.id}
                className="flex min-w-0 flex-col gap-2 rounded bg-surface p-2"
              >
                <p className="flex items-baseline justify-between gap-2 text-meta font-medium text-ink">
                  {column.label}
                  <span className="tabular-nums text-ink-faint">{column.items.length}</span>
                </p>
                <ul className="flex list-none flex-col gap-2 p-0">
                  {column.items.map((item) => {
                    const selected = selecting.selected === item.item;
                    return (
                      <li key={item.item} data-item={item.item} data-testid="turn-tile">
                        <button
                          type="button"
                          data-select=""
                          aria-current={selected ? 'true' : undefined}
                          onClick={() => selecting.onSelect(item)}
                          className={cn(
                            'flex w-full min-w-0 flex-col items-start gap-1 rounded border bg-ground p-2 text-start',
                            selected ? 'border-action' : 'border-rule hover:border-rule-strong',
                          )}
                        >
                          <TypeMark type={item.type} />
                          <span className="line-clamp-2 text-body text-ink">{item.title}</span>
                          <Where item={item} />
                          <Clock item={item} now={now} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The timeline
 * ------------------------------------------------------------------ */

const at = (ms: number) => new Date(ms).toISOString();

export function TurnTimeline({
  sections,
  now,
  selecting,
}: {
  sections: readonly TurnSection[];
  now: number;
  selecting: Selecting;
}) {
  const items = sections.flatMap((section) => section.items);
  const line = timelineOf(items, now);
  const { root, onKeyDown } = useListKeys(items, selecting);
  if (!items.length) {
    return (
      <p data-testid="turn-timeline-empty" className="text-body text-ink-muted">
        Nothing to place on the timeline.
      </p>
    );
  }
  const nowAt = `${line.nowAt * 100}%`;
  return (
    <div ref={root} onKeyDown={onKeyDown} data-testid="turn-timeline" className="flex min-w-0 flex-col gap-2">
      <p className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 text-meta text-ink-muted">
        <span />
        <span className="flex justify-between gap-2">
          <span>{line.start < line.now ? <RelativeTime at={at(line.start)} /> : null}</span>
          <span>Now</span>
          <span>{line.end > line.now ? <RelativeTime at={at(line.end)} /> : null}</span>
        </span>
      </p>
      <ul className="flex list-none flex-col gap-1 p-0">
        {line.rows.map((row) => {
          const selected = selecting.selected === row.item.item;
          return (
            <li
              key={row.item.item}
              data-item={row.item.item}
              data-testid="turn-timeline-row"
              className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3"
            >
              <button
                type="button"
                data-select=""
                aria-current={selected ? 'true' : undefined}
                onClick={() => selecting.onSelect(row.item)}
                className={cn(
                  'min-w-0 truncate rounded px-1 py-1 text-start text-body',
                  selected ? 'bg-surface text-ink' : 'text-ink hover:bg-surface',
                )}
                title={row.item.title}
              >
                {row.item.title}
              </button>
              <span className="relative block h-5 min-w-0" aria-hidden>
                <span
                  className="absolute inset-y-0 w-px bg-rule-strong"
                  style={{ insetInlineStart: nowAt }}
                />
                <span
                  data-testid="turn-timeline-bar"
                  className={cn(
                    'absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full',
                    row.overdue
                      ? 'bg-state state-failed'
                      : row.deadline
                        ? 'bg-action'
                        : 'border border-dashed border-ink-faint',
                  )}
                  style={{
                    insetInlineStart: `${row.from * 100}%`,
                    width: `${Math.max(0.5, (row.to - row.from) * 100)}%`,
                  }}
                />
                {row.start != null && (
                  <span
                    className="absolute top-1/2 size-2 -translate-y-1/2 rounded-full border border-ink bg-ground"
                    style={{ insetInlineStart: `${row.start * 100}%` }}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-meta text-ink-muted">
        The rule marks now; a bar runs from when the item was raised to its deadline, or to now when none is
        set; a ring marks when it is due to start.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The filter chips (#366)
 * ------------------------------------------------------------------ */

/**
 * Every filter in sight on a desk: one row per facet, each choice a chip with
 * its count, pressed to narrow and pressed again to clear. The address stays
 * the one record of the choice; below 900 px the toolbar's Filter sheet holds
 * the same choices.
 */
export function FilterChips({
  facets,
  filters,
  hide,
  onChange,
}: {
  facets: Facets;
  filters: TurnFilters;
  /** A facet the page has already decided — the plan tab's plan. */
  hide?: readonly FacetKey[];
  onChange: (key: FacetKey, value: string) => void;
}) {
  const keys = FACET_KEYS.filter((key) => !hide?.includes(key) && (facets[key].length > 0 || filters[key]));
  if (!keys.length) return null;
  return (
    <div data-testid="turn-chips" className="hidden min-w-0 flex-col gap-1.5 md:flex" data-print="hide">
      {keys.map((key) => (
        <div
          key={key}
          role="group"
          aria-label={FILTER_LABEL[key]}
          className="flex min-w-0 flex-wrap items-center gap-1.5"
        >
          <span className="w-16 shrink-0 text-meta text-ink-muted">{FILTER_LABEL[key]}</span>
          {facets[key].map((facet) => {
            const on = filters[key] === facet.value;
            return (
              <button
                key={facet.value}
                type="button"
                data-testid={`turn-chip-${key}`}
                data-value={facet.value}
                aria-pressed={on}
                onClick={() => onChange(key, on ? '' : facet.value)}
                className={cn(
                  'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-meta',
                  '[@media(hover:none)]:min-h-(--tap-min)',
                  on
                    ? 'border-action bg-action text-ground'
                    : 'border-rule text-ink hover:border-rule-strong',
                )}
              >
                {facet.label}
                <span className={cn('tabular-nums', on ? 'text-ground' : 'text-ink-faint')}>
                  {facet.count}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
