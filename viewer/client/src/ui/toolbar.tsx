import { ChevronDown, Ellipsis, Search, SlidersHorizontal, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { usePhone } from '@/lib/media';
import { Button } from './button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown';
import { everythingSaid, type Everything } from './everything';
import { fieldSurface } from './field';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Sheet, SheetClose, SheetContent, SheetTrigger } from './sheet';

/**
 * The one toolbar grammar (design.md §1, principle 8): search · filter · group ·
 * sort · view · ⋯ · Everything, in that order, on every list page — and below
 * 900 the same words inside ONE View sheet, so a phone learns nothing new.
 *
 * The toolbar owns the MECHANISM and nothing about any list: the order, the
 * search field that clears itself, a button and its popover per slot on a
 * desk, the sheet on a phone, the count of what is in force, the `⋯` menu and
 * the Everything switch. A page owns the VOCABULARY — which filters, which
 * groups, which orders, which verbs — and hands each slot as a panel, so the
 * desk's popover and the phone's sheet show one set of controls and can never
 * drift into two (the 6.x lists did: one control existed only in the sheet).
 *
 * The search stays on the bar at every width: typing to narrow is the act a
 * list is opened for, and a field and one button fit a 360 px phone. Every
 * other slot folds into the sheet below 900, in the grammar's order.
 */

/** The grammar's slots, in its order. */
export const TOOLBAR_SLOTS = ['search', 'filter', 'group', 'sort', 'view', 'more', 'everything'] as const;
export type ToolbarSlotId = (typeof TOOLBAR_SLOTS)[number];

/** The words each slot answers to, unless the page has a better one. */
const WORDS: Record<'filter' | 'group' | 'sort' | 'view', string> = {
  filter: 'Filter',
  group: 'Group',
  sort: 'Sort',
  view: 'View',
};

/**
 * One slot of the grammar.
 *
 * `panel` is the slot's controls: under the slot's button in a popover on a
 * desk, a section of the View sheet on a phone. `inline` is for a slot short
 * enough to sit on the desk's bar itself (two orders as a segmented control);
 * the phone still shows `panel`.
 */
export interface ToolbarSlot {
  /** The slot's word, when the page has a better one than the grammar's ("Columns" for a grid's view). */
  label?: string;
  /** What is chosen now, drawn after the word on a desk — "Group  State", "Sort  Updated". */
  value?: string;
  /** How many of the slot's settings are away from their default: on its button, and summed on the phone's. */
  active?: number;
  panel: ReactNode;
  inline?: ReactNode;
}

/** A verb of the `⋯` menu: the page's own acts, said as the verb. */
export interface ToolbarVerb {
  id: string;
  label: string;
  onSelect: () => void;
  /** Why it cannot be pressed now — a missing capability flag, said. Present = disabled. */
  disabled?: string;
  /** It destroys something: it paints in the failed hue, and still confirms where it lands. */
  destructive?: boolean;
}

export interface ToolbarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** The accessible name — longer than the placeholder, never absent. */
  label: string;
}

export interface ToolbarProps {
  /** What the toolbar sets, as its page names it ("Runs") — the phone's sheet says it. */
  label: string;
  search?: ToolbarSearchProps;
  filter?: ToolbarSlot;
  group?: ToolbarSlot;
  sort?: ToolbarSlot;
  view?: ToolbarSlot;
  /** The `⋯` menu. */
  more?: readonly ToolbarVerb[];
  /** The page's Everything switch (`useEverything`), the grammar's last word. */
  everything?: Everything;
  /** The line under the bar, at every width — how many rows a filter left, and how to clear it. */
  note?: ReactNode;
  className?: string;
}

export function Toolbar({
  label,
  search,
  filter,
  group,
  sort,
  view,
  more,
  everything,
  note,
  className,
}: ToolbarProps) {
  const phone = usePhone();
  const slots = { filter, group, sort, view };
  const verbs = more?.length ? more : undefined;

  const bar = phone ? (
    <div className="flex min-w-0 items-center gap-2">
      {search && <ToolbarSearch {...search} className="min-w-0 flex-1" />}
      <ViewSheet label={label} slots={slots} verbs={verbs} everything={everything} />
    </div>
  ) : (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {search && <ToolbarSearch {...search} className="w-56 max-w-full" />}
      {(['filter', 'group', 'sort', 'view'] as const).map((id) => {
        const slot = slots[id];
        return slot ? <SlotControl key={id} id={id} slot={slot} /> : null;
      })}
      {(verbs || everything) && (
        // The trailing pair keeps its place in the grammar's order and its
        // place at the bar's end; it wraps as one when the bar runs out.
        <div className="ms-auto flex min-w-0 items-center gap-2">
          {verbs && <MoreMenu verbs={verbs} />}
          {everything && <EverythingSwitch everything={everything} />}
        </div>
      )}
    </div>
  );

  return (
    <div data-toolbar="" className={cn('flex min-w-0 flex-col gap-2', className)}>
      {bar}
      {note != null && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
          {note}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The search field
 * ------------------------------------------------------------------ */

export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  label,
  className,
}: ToolbarSearchProps & { className?: string }) {
  return (
    <div data-slot="search" className={cn('relative flex min-w-0 items-center', className)}>
      <Search size={14} aria-hidden className="pointer-events-none absolute start-2.5 text-ink-faint" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        // `pe-8` leaves the clear button its own room; without it the text
        // runs under a control that then cannot be pressed.
        className={cn(
          fieldSurface,
          'w-full ps-8 pe-8 placeholder:text-ink-faint [&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear the search"
          className="tap-area absolute end-1 grid size-7 place-items-center rounded text-ink-faint hover:text-ink"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A slot on a desk: a button, and its panel in a popover
 * ------------------------------------------------------------------ */

/** How many settings a slot has in force, drawn after its word. */
function InForce({ count }: { count: number | undefined }) {
  if (!count) return null;
  return <span className="tnum font-normal text-ink-muted">{count}</span>;
}

/**
 * A slot button's name, in words: its word, then what is chosen or else how
 * many settings are in force — "Group, State", "Filter, 2 in use". Spelled out
 * because the drawn pieces sit side by side with a gap, not a space, and read
 * run together ("Filter2") as the button's text. A chosen value says it all: a
 * count beside "State" would only repeat that one grouping is on.
 */
const spoken = (word: string, value: string | undefined, active: number | undefined): string =>
  [word, value ?? (active ? `${active} in use` : undefined)].filter(Boolean).join(', ');

function SlotControl({ id, slot }: { id: 'filter' | 'group' | 'sort' | 'view'; slot: ToolbarSlot }) {
  const word = slot.label ?? WORDS[id];
  if (slot.inline != null) {
    return (
      <div data-slot={id} className="flex min-w-0 items-center">
        {slot.inline}
      </div>
    );
  }
  // A word, not a box (`ghost`): the bar is chrome, and the chrome is silent.
  // The word darkens to ink while the slot says something about the list.
  const speaking = Boolean(slot.value || slot.active);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-slot={id}
          variant="ghost"
          aria-label={spoken(word, slot.value, slot.active)}
          className={cn('data-[state=open]:bg-surface-raised', speaking && 'text-ink')}
        >
          {word}
          {slot.value ? (
            <span className="max-w-40 truncate font-normal text-ink-muted">{slot.value}</span>
          ) : (
            <InForce count={slot.active} />
          )}
          <ChevronDown size={12} aria-hidden className="text-ink-faint" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={word} className="w-72">
        {slot.panel}
      </PopoverContent>
    </Popover>
  );
}

function MoreMenu({ verbs }: { verbs: readonly ToolbarVerb[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-slot="more" variant="ghost" size="icon" aria-label="More actions">
          <Ellipsis size={16} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {verbs.map((verb) => (
          <DropdownMenuItem
            key={verb.id}
            disabled={verb.disabled !== undefined}
            destructive={verb.destructive}
            onSelect={verb.onSelect}
            className="flex-col items-start gap-0"
          >
            <span>{verb.label}</span>
            {verb.disabled !== undefined && <span className="text-meta text-ink-muted">{verb.disabled}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ *
 * Below 900: every slot in one View sheet, in the grammar's order
 * ------------------------------------------------------------------ */

function ViewSheet({
  label,
  slots,
  verbs,
  everything,
}: {
  label: string;
  slots: Record<'filter' | 'group' | 'sort' | 'view', ToolbarSlot | undefined>;
  verbs: readonly ToolbarVerb[] | undefined;
  everything: Everything | undefined;
}) {
  const ids = useId();
  const present = (['filter', 'group', 'sort', 'view'] as const).filter((id) => slots[id]);
  if (!present.length && !verbs && !everything) return null;
  const count = present.reduce((n, id) => n + (slots[id]?.active ?? 0), 0) + (everything?.on ? 1 : 0);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button data-slot="view-sheet" aria-label={spoken('View', undefined, count)} className="shrink-0">
          <SlidersHorizontal size={14} aria-hidden />
          View
          <InForce count={count} />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        title="View"
        showTitle
        description={`What to show in the ${label.toLowerCase()}, and how.`}
      >
        <div className="flex flex-col gap-5">
          {present.map((id) => {
            const slot = slots[id]!;
            const heading = `${ids}-${id}`;
            return (
              <section
                key={id}
                data-slot={id}
                aria-labelledby={heading}
                className="flex min-w-0 flex-col gap-2"
              >
                <h3 id={heading} className="text-section font-semibold text-ink">
                  {slot.label ?? WORDS[id]}
                </h3>
                {slot.panel}
              </section>
            );
          })}
          {verbs && (
            <section data-slot="more" aria-labelledby={`${ids}-more`} className="flex min-w-0 flex-col gap-2">
              <h3 id={`${ids}-more`} className="text-section font-semibold text-ink">
                More actions
              </h3>
              <div className="flex flex-col items-start gap-2">
                {verbs.map((verb) =>
                  verb.disabled !== undefined ? (
                    <div key={verb.id} className="flex flex-col gap-0.5">
                      <Button disabled variant={verb.destructive ? 'danger' : 'default'}>
                        {verb.label}
                      </Button>
                      <span className="text-meta text-ink-muted">{verb.disabled}</span>
                    </div>
                  ) : (
                    // The sheet closes first: a verb usually opens what it acts
                    // on, and a sheet left standing would cover it.
                    <SheetClose key={verb.id} asChild>
                      <Button variant={verb.destructive ? 'danger' : 'default'} onClick={verb.onSelect}>
                        {verb.label}
                      </Button>
                    </SheetClose>
                  ),
                )}
              </div>
            </section>
          )}
          {everything && <EverythingSwitch everything={everything} hint />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Everything — the grammar's last word
 * ------------------------------------------------------------------ */

/**
 * The switch for the third door. A real switch (`role="switch"`, its state in
 * `aria-checked`), in ink when it is on — choosing to see more is not a
 * summons, so never amber — and, once pressed, a polite sentence saying what
 * the page now shows: the page changed shape around the person, and the
 * switch's own state is not that news. The live region is drawn empty from the
 * start, because a region that appears with its words is not announced.
 */
export function EverythingSwitch({
  everything,
  hint = false,
  className,
}: {
  everything: Everything;
  /** Say under the switch what it does — the sheet does; the desk's bar has no room. */
  hint?: boolean;
  className?: string;
}) {
  const hintId = useId();
  const [said, setSaid] = useState('');
  return (
    <div data-slot="everything" className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={everything.on}
        {...(hint ? { 'aria-describedby': hintId } : {})}
        onClick={() => {
          setSaid(everythingSaid(!everything.on));
          everything.toggle();
        }}
        className={cn(
          'inline-flex h-8 items-center gap-2 self-start rounded px-1.5 text-body font-medium',
          'text-ink-muted hover:text-ink aria-checked:text-ink [@media(hover:none)]:min-h-(--tap-min)',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'inline-flex h-4 w-7 shrink-0 items-center rounded-full border p-px transition-colors duration-fast ease-transit',
            everything.on
              ? 'justify-end border-action bg-action'
              : 'justify-start border-rule-strong bg-ground',
          )}
        >
          <span className={cn('size-3 rounded-full', everything.on ? 'bg-ground' : 'bg-ink-faint')} />
        </span>
        Everything
      </button>
      {hint && (
        <p id={hintId} className="text-meta text-ink-muted">
          Every column, fact and section, not only the essentials.
        </p>
      )}
      <span role="status" className="sr-only">
        {said}
      </span>
    </div>
  );
}
